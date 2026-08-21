# BUBU.Market live backend contract

The browser uses Supabase Auth, Postgres, Realtime and Storage through
`supabase-adapter.js`. Marketplace data is database-owned; no seeded constants are
used by the live adapter.

## Authentication

- Password and delivered email/SMS OTP use Supabase Auth.
- `079757` is a staging-only universal code controlled by
  `BUBU_ALLOW_UNIVERSAL_OTP`. Disable that flag for a public production launch.
- Buyer registration calls `create_buyer_profile(...)` after Auth succeeds.
- Supplier registration calls `submit_supplier_application(...)` and remains pending
  until an admin approves it.

## Marketplace workflow

1. Verified suppliers publish products and specifications.
2. Buyers search the catalogue, message a supplier, or post a requirement.
3. Matching suppliers receive the requirement and save/send quotes.
4. Buyers and suppliers continue the negotiation in a Realtime conversation.
5. Payment for goods is arranged directly between buyer and supplier. BUBU does not
   collect, hold, release or refund marketplace money.

## Resources

- `accounts`, `account_registration`, `account_users`, `account_categories`
- `products`, `product_specs`, `media`, `documents`
- `requirements`, `quotes`, `quote_attachments`, `lead_preferences`, `lead_credits`
- `conversations`, `messages`
- `applications`, `audit_log`, `notification_prefs`
- `plans`, `plan_purchases`, `subscriptions`

## Subscription payments

`start_plan_purchase(plan_code, method, phone)` creates a pending payment request.
A trusted provider webhook, running with service-role credentials, confirms settlement
and calls `activate_plan_purchase(purchase_id, provider_reference)`. That function
activates the subscription, updates the account tier and grants lead credits.

The browser must never mark its own plan purchase successful. Provider secrets and
service-role credentials belong only in a Supabase Edge Function.

## Files and privacy

- Public catalogue/company images live under `media/products/` and `media/company/`.
- Verification files live under `media/documents/` and remain private.
- RLS limits documents, conversations, messages and applications to their parties or
  operations admins.
- Product images are public; all upload/update/delete operations are scoped to the
  authenticated account folder.

## Production integrations still requiring credentials

- SMS/email provider configuration in Supabase Auth
- Subscription payment collection and webhook verification
- URSB/URA registry verification
- Notification delivery (email, SMS and WhatsApp)
- Scheduled retention jobs for call recordings and private documents

