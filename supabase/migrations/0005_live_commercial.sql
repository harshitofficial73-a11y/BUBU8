-- BUBU.Market live commercial workflow.
-- Marketplace discovery, RFQs, quotes, verification and chat are database-backed.
-- BUBU collects money only for subscription plans; marketplace order payments and escrow are legacy.

create table if not exists plans (
  code text primary key, name text not null, description text,
  price bigint not null check (price >= 0), billing_days integer not null default 30 check (billing_days > 0),
  tier membership_tier not null, lead_credits integer not null default 0,
  features jsonb not null default '[]'::jsonb, active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists plan_purchases (
  id uuid primary key default uuid_generate_v4(), account_id uuid not null references accounts on delete cascade,
  plan_code text not null references plans(code), amount bigint not null, method payment_method not null,
  payer_phone text, provider_ref text, state payment_state not null default 'prompt_sent',
  starts_on date, ends_on date, raw_callback jsonb, created_at timestamptz not null default now(), settled_at timestamptz
);
create index if not exists plan_purchases_account_created on plan_purchases(account_id, created_at desc);
alter table plans enable row level security;
alter table plan_purchases enable row level security;
drop policy if exists plans_read on plans;
create policy plans_read on plans for select using (active or is_admin());
drop policy if exists plan_purchases_own on plan_purchases;
create policy plan_purchases_own on plan_purchases for select using (account_id=current_account_id() or is_admin());

insert into plans(code,name,description,price,billing_days,tier,lead_credits,features) values
('free','Free','Create a profile and publish a starter catalogue',0,3650,'free',0,
 '["Company profile","Up to 5 products","Receive enquiries"]'),
('star-monthly','Star Supplier','More catalogue reach and verified lead tools',99000,30,'star_supplier',25,
 '["Unlimited products","25 contact reveals","Priority search placement","Catalogue analytics"]'),
('leader-monthly','Industry Leader','Full commercial visibility and team tools',249000,30,'industry_leader',100,
 '["Everything in Star","100 contact reveals","Team access","Priority verification","Advanced analytics"]')
on conflict(code) do update set name=excluded.name,description=excluded.description,price=excluded.price,
billing_days=excluded.billing_days,tier=excluded.tier,lead_credits=excluded.lead_credits,features=excluded.features,active=true;

create or replace function create_buyer_profile(
  p_company text,p_phone text,p_email text,p_district_id text,p_buyer_type text default null,
  p_full_name text default null,p_category_ids text[] default '{}'
) returns accounts language plpgsql security definer set search_path=public as $$
declare v_account accounts; v_category text;
begin
  if auth.uid() is null then raise exception 'sign in before creating a profile'; end if;
  if coalesce(trim(p_company),'')='' or coalesce(trim(p_phone),'')='' then raise exception 'name and phone are required'; end if;
  insert into accounts(auth_user_id,role,company,trade_name,initials,phone,email,district_id,nature_of_business)
  values(auth.uid(),'buyer',trim(p_company),trim(p_company),upper(left(trim(p_company),2)),trim(p_phone),
    nullif(trim(p_email),''),nullif(trim(p_district_id),''),nullif(trim(p_buyer_type),''))
  on conflict(auth_user_id) do update set company=excluded.company,trade_name=excluded.trade_name,
    phone=excluded.phone,email=excluded.email,district_id=excluded.district_id,
    nature_of_business=excluded.nature_of_business,updated_at=now() returning * into v_account;
  insert into account_users(account_id,auth_user_id,full_name,role_title)
  values(v_account.id,auth.uid(),coalesce(nullif(trim(p_full_name),''),trim(p_company)),coalesce(p_buyer_type,'Buyer'))
  on conflict do nothing;
  delete from account_categories where account_id=v_account.id;
  foreach v_category in array coalesce(p_category_ids,'{}') loop
    insert into account_categories(account_id,category_id) values(v_account.id,v_category) on conflict do nothing;
  end loop;
  return v_account;
end $$;
grant execute on function create_buyer_profile(text,text,text,text,text,text,text[]) to authenticated;

create or replace function start_plan_purchase(p_plan_code text,p_method payment_method,p_phone text)
returns plan_purchases language plpgsql security definer set search_path=public as $$
declare v_plan plans; v_purchase plan_purchases; v_account uuid:=current_account_id();
begin
  if v_account is null then raise exception 'sign in before purchasing a plan'; end if;
  select * into v_plan from plans where code=p_plan_code and active;
  if not found then raise exception 'plan is not available'; end if;
  if v_plan.price=0 then raise exception 'the free plan does not require payment'; end if;
  insert into plan_purchases(account_id,plan_code,amount,method,payer_phone)
  values(v_account,v_plan.code,v_plan.price,p_method,nullif(trim(p_phone),'')) returning * into v_purchase;
  return v_purchase;
end $$;
grant execute on function start_plan_purchase(text,payment_method,text) to authenticated;

create or replace function activate_plan_purchase(p_purchase uuid,p_provider_ref text)
returns subscriptions language plpgsql security definer set search_path=public as $$
declare v_purchase plan_purchases; v_plan plans; v_sub subscriptions;
begin
  if not is_admin() and auth.role()<>'service_role' then raise exception 'trusted payment service only'; end if;
  update plan_purchases set state='success',provider_ref=p_provider_ref,settled_at=now(),starts_on=current_date
  where id=p_purchase and state='prompt_sent' returning * into v_purchase;
  if not found then raise exception 'purchase is not pending'; end if;
  select * into v_plan from plans where code=v_purchase.plan_code;
  update plan_purchases set ends_on=current_date+v_plan.billing_days where id=p_purchase;
  insert into subscriptions(account_id,tier,price,lead_credits,starts_on,ends_on)
  values(v_purchase.account_id,v_plan.tier,v_plan.price,v_plan.lead_credits,current_date,current_date+v_plan.billing_days)
  returning * into v_sub;
  update accounts set tier=v_plan.tier where id=v_purchase.account_id;
  if v_plan.lead_credits>0 then insert into lead_credits(account_id,granted,expires_on)
    values(v_purchase.account_id,v_plan.lead_credits,current_date+v_plan.billing_days); end if;
  return v_sub;
end $$;

create or replace function message_after_insert() returns trigger language plpgsql security definer as $$
begin update conversations set last_message_at=new.sent_at where id=new.conversation_id; return new; end $$;
drop trigger if exists messages_touch_conversation on messages;
create trigger messages_touch_conversation after insert on messages for each row execute function message_after_insert();

create unique index if not exists conversations_one_general_thread
on conversations(supplier_id,buyer_id) where requirement_id is null;

-- Storage: public catalogue/company images; documents remain visible only to their owner and admins.
drop policy if exists media_public_images on storage.objects;
create policy media_public_images on storage.objects for select using (
  bucket_id='media' and (storage.foldername(name))[1] in ('products','company')
);
drop policy if exists media_owner_read on storage.objects;
create policy media_owner_read on storage.objects for select using (
  bucket_id='media' and ((storage.foldername(name))[2]=current_account_id()::text or is_admin())
);
drop policy if exists media_owner_insert on storage.objects;
create policy media_owner_insert on storage.objects for insert to authenticated with check (
  bucket_id='media' and (storage.foldername(name))[1] in ('products','company','documents')
  and (storage.foldername(name))[2]=current_account_id()::text
);
drop policy if exists media_owner_update on storage.objects;
create policy media_owner_update on storage.objects for update to authenticated using (
  bucket_id='media' and ((storage.foldername(name))[2]=current_account_id()::text or is_admin())
) with check (bucket_id='media');
drop policy if exists media_owner_delete on storage.objects;
create policy media_owner_delete on storage.objects for delete to authenticated using (
  bucket_id='media' and ((storage.foldername(name))[2]=current_account_id()::text or is_admin())
);

-- Disable old marketplace money functions for browser sessions while preserving historical rows.
revoke execute on function fund_order(uuid,payment_method,text) from anon,authenticated;
revoke execute on function release_escrow(uuid) from anon,authenticated;
