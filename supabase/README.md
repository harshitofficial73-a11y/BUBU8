# BUBU.Market · Supabase backend

Run these files in order in the Supabase SQL editor (or `supabase db push`):

    migrations/0001_schema.sql     tables, enums, indexes
    migrations/0002_rls.sql        row level security, one policy set per table
    migrations/0003_functions.sql  shared triggers, buy-lead matching, views
    migrations/0004_supplier_application.sql
    migrations/0005_live_commercial.sql
    seed_full.sql                  test accounts and realistic development records

Then `supabase-adapter.js` is the only frontend file that changes: it returns the exact
shapes the screens already render, so no markup or render logic moves.

## What the schema owns

**Identity** — `accounts` holds one row per business; `account_users` holds the staff
logins beneath it, each with its own permissions. `account_registration` is separate
so an admin can verify URSB, TIN, licence,
VAT and NIN independently, each with its own state and an `overall_state` that gates the
verified badge.

**Catalogue** — `products` with `product_specs` and `media`. Listing status is
`draft | published | archived`; only published rows are world readable.

**Demand** — a buyer's `requirements` row is the same object a supplier sees as a buy
lead. `my_buy_leads()` returns only the leads matching the caller's saved categories,
districts, radius and minimum value, computed with `district_km()` from real district
centroids. Revealing a buyer's number goes through `reveal_contact()`, which spends one
`lead_credits` unit atomically and refuses when the balance is zero — the masked phone
never leaves the server unpaid.

**Plans and money** — `plans`, `plan_purchases` and `subscriptions` are the only active
payment workflow. Marketplace payments happen directly between buyer and supplier.
The browser creates a pending plan purchase; a trusted payment webhook activates it.
Legacy order/payment tables remain only so existing development data can be migrated.

## Row level security

Nothing is readable without a policy. `current_account_id()` resolves the caller's
business from either `accounts.auth_user_id` or `account_users.auth_user_id`, so staff
logins inherit their employer's scope. The rules that matter:

- A supplier cannot read another supplier's leads, conversations or documents.
- Requirements are visible to suppliers only while `open` and only in their categories.
- Quotes are visible to the quoting supplier and the requirement's buyer, nobody else.
- Plan purchases are visible only to their account and admin.
- Messages are scoped through the conversation's two participants.
- Only admin may update verification `applications`.

## Uganda specifics the backend owns

- Phone auth on `+2567XXXXXXXX`; rate-limit OTP to 3 per 15 minutes per number, and
  reply identically whether or not the number is registered.
- Verify URSB and URA TIN against the registries before setting `overall_state` to
  `verified`; store the check result and timestamp on `applications`.
- `licence_expires_on` drives the "Renew by" warning the UI already shows.
- Call recordings on `messages.recording_path` are kept 90 days under the Data
  Protection and Privacy Act, 2019, then purged by a scheduled job.
- Never accept a MoMo PIN. Plan purchases record only the prompt and provider callback.

## Storage

One bucket, `media`, with folders `products/`, `company/`, `documents/`. Registration
documents must be private (signed URLs only); product photos may be public.

## Environment

    window.BUBU_SUPABASE_URL = 'https://<project>.supabase.co';
    window.BUBU_SUPABASE_ANON_KEY = '<anon key>';

Service-role keys never reach the browser. Anything needing one belongs in an Edge
Function: subscription payment webhooks, registry lookups and the recording purge.
