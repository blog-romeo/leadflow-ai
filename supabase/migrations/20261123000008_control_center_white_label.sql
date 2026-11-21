-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 5: Super Admin, White Label & SaaS Control Center
--
-- Nuove tabelle: platform_settings, feature_flags, feature_flag_overrides, admin_audit_logs,
-- admin_notes, request_rate_limits, provider_cost_events, reseller_plans, resellers,
-- reseller_members, reseller_organizations, reseller_invitations, reseller_subscriptions,
-- reseller_branding, custom_domains.
-- Modifiche: organizations (sospensione amministrativa, tetto di spesa AI), billing_invoices
-- (fatture dei rivenditori), funzioni di entitlement (sospensione, feature flag, clienti
-- gestiti da rivenditori), registrazione dei costi provider.
--
-- Ruoli: super_admin (profiles.platform_role, assegnabile solo da SQL come postgres),
-- reseller_admin / reseller_member (reseller_members.role), organization_admin /
-- organization_member (organization_members.role: 'organization_admin' | 'member').
--
-- Principi: ogni RPC verifica il ruolo al suo interno (anche se l'endpoint lo ha già fatto),
-- ogni azione amministrativa è scritta in admin_audit_logs (append-only), nessun dato
-- commerciale dei tenant (lead, campagne, messaggi) è esposto a super admin o rivenditori.
-- Non elimina dati: le righe di usage_ledger 'provider_call' vengono copiate, non spostate.
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Protezione del ruolo super_admin
-- ════════════════════════════════════════════════════════════════════════════
-- Nessun ruolo API (anon, authenticated, service_role) può creare o modificare un super admin:
-- né dalla registrazione pubblica (metadati ignorati), né via REST, né dalle Netlify Functions.
create or replace function private.protect_platform_role()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    if tg_op = 'INSERT' and new.platform_role <> 'user' then
      raise exception 'platform_role can only be assigned by the platform operator' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.platform_role is distinct from old.platform_role then
      raise exception 'platform_role can only be assigned by the platform operator' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_protect_platform_role before insert or update on public.profiles
  for each row execute function private.protect_platform_role();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Audit amministrativo, note interne, rate limit
-- ════════════════════════════════════════════════════════════════════════════
create table public.admin_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  actor_role text not null check (actor_role in ('super_admin', 'reseller_admin', 'reseller_member', 'operator', 'system')),
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$' and char_length(action) <= 80),
  target_type text check (target_type is null or target_type in ('organization', 'reseller', 'domain', 'invitation', 'settings', 'feature_flag', 'plan', 'user', 'console')),
  target_id text check (target_id is null or char_length(target_id) <= 100),
  reason text check (reason is null or char_length(reason) <= 1000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index admin_audit_logs_time_idx on public.admin_audit_logs (created_at desc);
create index admin_audit_logs_target_idx on public.admin_audit_logs (target_type, target_id, created_at desc);
create index admin_audit_logs_actor_idx on public.admin_audit_logs (actor_id, created_at desc);

create or replace function private.admin_audit_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Consentito solo l'azzeramento di actor_id (ON DELETE SET NULL dell'utente).
  if tg_op = 'UPDATE' and (new.id, new.actor_role, new.action, new.target_type, new.target_id, new.reason, new.metadata, new.created_at)
                         is not distinct from (old.id, old.actor_role, old.action, old.target_type, old.target_id, old.reason, old.metadata, old.created_at) then
    return new;
  end if;
  raise exception 'admin_audit_logs is append-only' using errcode = '42501';
end $$;
create trigger admin_audit_logs_immutable before update or delete on public.admin_audit_logs
  for each row execute function private.admin_audit_immutable();

create or replace function private.admin_audit(p_role text, p_action text, p_target_type text, p_target_id text,
  p_reason text default null, p_metadata jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.admin_audit_logs (actor_id, actor_role, action, target_type, target_id, reason, metadata)
  values (auth.uid(), p_role, p_action, p_target_type, p_target_id, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_metadata, '{}'::jsonb));
$$;

create table public.admin_notes (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('organization', 'reseller')),
  target_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  author_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index admin_notes_target_idx on public.admin_notes (target_type, target_id, created_at desc) where deleted_at is null;

-- Finestra fissa di un minuto per utente e bucket (azioni amministrative e dei rivenditori).
create table public.request_rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null check (char_length(bucket) between 2 and 60),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (user_id, bucket, window_start)
);

create or replace function private.rate_limit(p_bucket text, p_max integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_hits int;
begin
  if auth.uid() is null then return; end if;
  insert into public.request_rate_limits as r (user_id, bucket, window_start, hits)
  values (auth.uid(), p_bucket, date_trunc('minute', now()), 1)
  on conflict (user_id, bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if v_hits > p_max then
    raise exception 'rate_limited' using errcode = 'P0001', detail = jsonb_build_object('retry_after', 60)::text;
  end if;
end $$;

create or replace function private.require_super_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Impostazioni di piattaforma e feature flag
-- ════════════════════════════════════════════════════════════════════════════
create table public.platform_settings (
  key text primary key check (key in ('cost_controls', 'operations', 'white_label')),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger platform_settings_updated_at before update on public.platform_settings
  for each row execute function public.set_updated_at();
insert into public.platform_settings (key, value) values
  -- Budget e soglie di costo AI (USD). null = nessun limite configurato.
  ('cost_controls', '{"monthly_ai_budget_usd": null, "alert_threshold_pct": 80, "hard_stop_at_budget": false, "default_org_monthly_ai_cap_usd": null}'),
  -- Sospensione di operazioni costose a livello di piattaforma.
  ('operations', '{"ai_paused": false, "providers_paused": []}'),
  -- Destinazione CNAME dei domini personalizzati (es. "leadflow.netlify.app"); null = non configurata.
  ('white_label', '{"cname_target": null}');

create table public.feature_flags (
  key text primary key check (key in ('lead_finder', 'ai_analyzer', 'sales_agent', 'campaign_manager', 'advanced_analytics',
                                      'custom_branding', 'custom_domain', 'reseller_portal')),
  description text not null check (char_length(description) <= 300),
  scope text not null check (scope in ('organization', 'reseller')),
  enabled boolean not null default true,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger feature_flags_updated_at before update on public.feature_flags
  for each row execute function public.set_updated_at();
insert into public.feature_flags (key, description, scope) values
  ('lead_finder', 'Ricerca di nuovi lead sulle fonti autorizzate', 'organization'),
  ('ai_analyzer', 'Analisi AI dei lead', 'organization'),
  ('sales_agent', 'AI Sales Agent e Copilot', 'organization'),
  ('campaign_manager', 'Campagne, canali email e risposte', 'organization'),
  ('advanced_analytics', 'Analytics avanzate', 'organization'),
  ('custom_branding', 'Branding White Label dei rivenditori', 'reseller'),
  ('custom_domain', 'Domini personalizzati dei rivenditori', 'reseller'),
  ('reseller_portal', 'Portale rivenditori', 'reseller');

-- Override per singola organizzazione o rivenditore (es. disattivare una funzione a un cliente).
create table public.feature_flag_overrides (
  id uuid primary key default gen_random_uuid(),
  flag_key text not null references public.feature_flags (key) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  reseller_id uuid,
  enabled boolean not null,
  reason text check (reason is null or char_length(reason) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((organization_id is null) <> (reseller_id is null))
);
create unique index feature_flag_overrides_org_uidx on public.feature_flag_overrides (flag_key, organization_id) where organization_id is not null;
create unique index feature_flag_overrides_reseller_uidx on public.feature_flag_overrides (flag_key, reseller_id) where reseller_id is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Rivenditori (White Label)
-- ════════════════════════════════════════════════════════════════════════════
create table public.reseller_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  setup_fee_cents integer not null default 0 check (setup_fee_cents >= 0),
  monthly_price_cents integer not null check (monthly_price_cents >= 0),
  currency text not null default 'eur' check (currency ~ '^[a-z]{3}$'),
  max_organizations integer not null check (max_organizations between 0 and 10000),
  max_custom_domains integer not null default 0 check (max_custom_domains between 0 and 50),
  allowed_client_plans text[] not null default '{}',
  features text[] not null default '{}' check (features <@ array['custom_branding', 'custom_domain', 'reseller_portal']::text[]),
  stripe_monthly_price_id text unique check (stripe_monthly_price_id is null or stripe_monthly_price_id ~ '^price_[A-Za-z0-9]{6,}$'),
  stripe_setup_price_id text unique check (stripe_setup_price_id is null or stripe_setup_price_id ~ '^price_[A-Za-z0-9]{6,}$'),
  is_active boolean not null default true,
  sort_order smallint not null default 0,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.reseller_plans (code, name, setup_fee_cents, monthly_price_cents, max_organizations, max_custom_domains, allowed_client_plans, features, sort_order) values
  ('agency', 'Agency', 299000, 39900, 25, 1, array['starter', 'business'], array['custom_branding', 'custom_domain', 'reseller_portal'], 10),
  ('premium', 'Premium', 599000, 79900, 100, 10, array['starter', 'business', 'enterprise'], array['custom_branding', 'custom_domain', 'reseller_portal'], 20);

create table public.resellers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  status text not null default 'active' check (status in ('active', 'suspended')),
  plan_code text not null references public.reseller_plans (code) on update cascade,
  max_organizations_override integer check (max_organizations_override is null or max_organizations_override between 0 and 10000),
  max_custom_domains_override integer check (max_custom_domains_override is null or max_custom_domains_override between 0 and 50),
  -- Prezzo wholesale mensile per cliente, per piano cliente (centesimi, IVA esclusa): {"starter": 7900, ...}.
  wholesale_prices jsonb not null default '{}'::jsonb check (jsonb_typeof(wholesale_prices) = 'object'),
  contact_email text check (contact_email is null or contact_email ~* '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$'),
  stripe_customer_id text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,}$'),
  stripe_customer_livemode boolean,
  suspended_at timestamptz,
  suspended_reason text check (suspended_reason is null or char_length(suspended_reason) <= 1000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create trigger resellers_updated_at before update on public.resellers for each row execute function public.set_updated_at();
alter table public.feature_flag_overrides add constraint feature_flag_overrides_reseller_fk
  foreign key (reseller_id) references public.resellers (id) on delete cascade;

create or replace function private.valid_wholesale(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(bool_and(k in ('starter', 'business', 'enterprise') and jsonb_typeof(v) = 'number'
                           and (v #>> '{}')::numeric between 0 and 10000000 and (v #>> '{}')::numeric = floor((v #>> '{}')::numeric)), true)
    from jsonb_each(p) as e(k, v);
$$;
alter table public.resellers add constraint resellers_wholesale_valid check (private.valid_wholesale(wholesale_prices));

create table public.reseller_members (
  reseller_id uuid not null references public.resellers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('reseller_admin', 'reseller_member')),
  created_at timestamptz not null default now(),
  primary key (reseller_id, user_id)
);
create index reseller_members_user_idx on public.reseller_members (user_id);

-- Un'organizzazione appartiene al massimo a un rivenditore (PK su organization_id).
create table public.reseller_organizations (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  reseller_id uuid not null references public.resellers (id) on delete restrict,
  client_plan_code text not null references public.billing_plans (code) on update cascade,
  status text not null default 'active' check (status in ('active', 'detached')),
  linked_by uuid references auth.users (id) on delete set null,
  linked_at timestamptz not null default now(),
  detached_at timestamptz
);
create index reseller_organizations_reseller_idx on public.reseller_organizations (reseller_id, status);

create table public.reseller_invitations (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.resellers (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$'),
  organization_name text not null check (char_length(btrim(organization_name)) between 2 and 120),
  client_plan_code text not null references public.billing_plans (code) on update cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index reseller_invitations_reseller_idx on public.reseller_invitations (reseller_id, status, created_at desc);
create unique index reseller_invitations_pending_email_uidx on public.reseller_invitations (reseller_id, email) where status = 'pending';

create table public.reseller_subscriptions (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.resellers (id) on delete cascade,
  -- 'stripe': abbonamento pagato con Stripe Checkout. 'external': contratto fatturato fuori da Stripe,
  -- registrato dal super admin con motivazione (non simula uno stato di pagamento Stripe).
  source text not null check (source in ('stripe', 'external')),
  stripe_subscription_id text unique check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,}$'),
  stripe_customer_id text,
  stripe_price_id text,
  plan_code text references public.reseller_plans (code) on update cascade,
  status public.subscription_status not null,
  unit_amount_cents integer check (unit_amount_cents is null or unit_amount_cents >= 0),
  currency text check (currency is null or currency ~ '^[a-z]{3}$'),
  billing_interval text check (billing_interval is null or billing_interval in ('day', 'week', 'month', 'year')),
  interval_count integer,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ended_at timestamptz,
  started_at timestamptz,
  livemode boolean not null default false,
  note text check (note is null or char_length(note) <= 500),
  stripe_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'stripe') = (stripe_subscription_id is not null))
);
create index reseller_subscriptions_reseller_idx on public.reseller_subscriptions (reseller_id, created_at desc);
create trigger reseller_subscriptions_updated_at before update on public.reseller_subscriptions for each row execute function public.set_updated_at();

create table public.reseller_branding (
  reseller_id uuid primary key references public.resellers (id) on delete cascade,
  platform_name text check (platform_name is null or (char_length(btrim(platform_name)) between 2 and 60 and platform_name !~ '[<>]')),
  -- Percorsi nel bucket Storage "branding" (scritti solo dal server dopo la validazione del file).
  logo_path text check (logo_path is null or logo_path ~ '^[0-9a-f-]{36}/(logo|login_logo|favicon)-[0-9a-f]{12}\.(png|jpg|webp|ico)$'),
  login_logo_path text check (login_logo_path is null or login_logo_path ~ '^[0-9a-f-]{36}/(logo|login_logo|favicon)-[0-9a-f]{12}\.(png|jpg|webp|ico)$'),
  favicon_path text check (favicon_path is null or favicon_path ~ '^[0-9a-f-]{36}/(logo|login_logo|favicon)-[0-9a-f]{12}\.(png|jpg|webp|ico)$'),
  primary_color text check (primary_color is null or primary_color ~ '^#[0-9a-fA-F]{6}$'),
  secondary_color text check (secondary_color is null or secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  welcome_title text check (welcome_title is null or (char_length(welcome_title) <= 120 and welcome_title !~ '[<>]')),
  welcome_text text check (welcome_text is null or (char_length(welcome_text) <= 600 and welcome_text !~ '[<>]')),
  support_email text check (support_email is null or support_email ~* '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$'),
  privacy_url text check (privacy_url is null or (privacy_url ~ '^https://[^\s<>"]+$' and char_length(privacy_url) <= 500)),
  terms_url text check (terms_url is null or (terms_url ~ '^https://[^\s<>"]+$' and char_length(terms_url) <= 500)),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.custom_domains (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.resellers (id) on delete cascade,
  hostname text not null check (hostname = lower(hostname) and char_length(hostname) <= 253
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$'),
  -- pending_verification → verified (record TXT trovato) → active (CNAME + alias configurato + HTTPS raggiungibile)
  status text not null default 'pending_verification' check (status in ('pending_verification', 'verified', 'active', 'failed', 'removed')),
  verification_token text not null check (verification_token ~ '^[0-9a-f]{32}$'),
  dns_status text not null default 'unknown' check (dns_status in ('unknown', 'missing', 'misconfigured', 'ok')),
  https_status text not null default 'unknown' check (https_status in ('unknown', 'pending', 'active', 'error')),
  -- Il provisioning sull'hosting (alias Netlify) è un passaggio MANUALE del super admin: non automatizzato.
  provisioning text not null default 'manual_pending' check (provisioning in ('manual_pending', 'manual_done')),
  verified_at timestamptz,
  activated_at timestamptz,
  last_checked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index custom_domains_hostname_uidx on public.custom_domains (hostname) where deleted_at is null;
create index custom_domains_reseller_idx on public.custom_domains (reseller_id) where deleted_at is null;
create trigger custom_domains_updated_at before update on public.custom_domains for each row execute function public.set_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Organizzazioni: sospensione amministrativa e tetto di spesa AI
-- ════════════════════════════════════════════════════════════════════════════
alter table public.organizations
  add column admin_status text not null default 'active' check (admin_status in ('active', 'suspended')),
  add column suspended_at timestamptz,
  add column suspended_reason text check (suspended_reason is null or char_length(suspended_reason) <= 1000),
  add column suspended_by uuid references auth.users (id) on delete set null,
  -- Tetto mensile di costo AI stimato (USD) per l'organizzazione; null = valore predefinito di piattaforma.
  add column ai_monthly_cap_usd numeric(12, 2) check (ai_monthly_cap_usd is null or ai_monthly_cap_usd >= 0);
-- I nuovi campi non sono tra le colonne aggiornabili dai client (grant di colonna invariati).

-- Fatture dei rivenditori nella stessa tabella delle fatture (nessuna duplicazione).
alter table public.billing_invoices alter column organization_id drop not null;
alter table public.billing_invoices add column reseller_id uuid references public.resellers (id) on delete cascade;
alter table public.billing_invoices add constraint billing_invoices_owner_check check ((organization_id is null) <> (reseller_id is null));
create index billing_invoices_reseller_idx on public.billing_invoices (reseller_id, stripe_created_at desc) where reseller_id is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Costi dei provider dati (tabella dedicata; i dati storici restano in usage_ledger)
-- ════════════════════════════════════════════════════════════════════════════
create table public.provider_cost_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  provider text not null check (char_length(provider) between 2 and 60),
  operation text not null default 'search' check (char_length(operation) between 2 and 60),
  requests integer not null default 1 check (requests >= 0),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  idempotency_key text not null check (char_length(idempotency_key) between 4 and 200),
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
create index provider_cost_events_time_idx on public.provider_cost_events (created_at desc);
create index provider_cost_events_org_idx on public.provider_cost_events (organization_id, created_at desc);

insert into public.provider_cost_events (organization_id, user_id, provider, requests, cost_usd, idempotency_key, created_at)
select organization_id, user_id, operation, quantity, cost_usd, idempotency_key, created_at
  from public.usage_ledger where kind = 'provider_call'
on conflict (organization_id, idempotency_key) do nothing;

-- Sostituisce la registrazione della Fase 4: stesso nome e firma, ora su provider_cost_events.
-- Blocca la chiamata se il provider è sospeso dal super admin (operazioni costose).
create or replace function public.billing_record_provider_call(p_org uuid, p_user uuid, p_provider text, p_idempotency_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cost numeric := nullif((select provider_cost_usd ->> p_provider from public.billing_settings where id), '')::numeric;
begin
  if coalesce((select value -> 'providers_paused' from public.platform_settings where key = 'operations'), '[]'::jsonb) ? p_provider then
    raise exception 'platform_provider_paused' using errcode = 'P0001', detail = jsonb_build_object('provider', p_provider)::text;
  end if;
  insert into public.provider_cost_events (organization_id, user_id, provider, requests, cost_usd, idempotency_key)
  values (p_org, p_user, left(p_provider, 60), 1, v_cost, p_idempotency_key)
  on conflict (organization_id, idempotency_key) do nothing;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Helper di autorizzazione per i rivenditori
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.is_reseller_member(p_reseller uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reseller_members m join public.resellers r on r.id = m.reseller_id
                  where m.reseller_id = p_reseller and m.user_id = (select auth.uid()) and r.deleted_at is null);
$$;
create or replace function private.is_reseller_admin(p_reseller uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reseller_members m join public.resellers r on r.id = m.reseller_id
                  where m.reseller_id = p_reseller and m.user_id = (select auth.uid()) and m.role = 'reseller_admin' and r.deleted_at is null);
$$;
create or replace function private.is_reseller_member_of_org(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reseller_organizations ro
                   join public.reseller_members m on m.reseller_id = ro.reseller_id and m.user_id = (select auth.uid())
                  where ro.organization_id = p_org and ro.status = 'active');
$$;
grant execute on function private.is_reseller_member(uuid), private.is_reseller_admin(uuid), private.is_reseller_member_of_org(uuid)
  to authenticated, service_role;

-- Abbonamento corrente del rivenditore e accesso.
create or replace function private.reseller_current_subscription(p_reseller uuid)
returns public.reseller_subscriptions language sql stable security definer set search_path = '' as $$
  select s.* from public.reseller_subscriptions s where s.reseller_id = p_reseller
   order by (s.status in ('active', 'trialing', 'past_due')) desc, s.current_period_end desc nulls last, s.created_at desc limit 1;
$$;

create or replace function private.reseller_access(p_reseller uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r public.resellers;
  s public.reseller_subscriptions;
  p public.reseller_plans;
  v_access boolean;
begin
  select * into r from public.resellers where id = p_reseller and deleted_at is null;
  if r.id is null then return jsonb_build_object('has_access', false, 'reason', 'not_found'); end if;
  select * into p from public.reseller_plans where code = r.plan_code;
  s := private.reseller_current_subscription(p_reseller);
  v_access := r.status = 'active' and s.id is not null and private.subscription_status_grants_access(s.status);
  return jsonb_build_object(
    'has_access', v_access,
    'reason', case when r.status <> 'active' then 'reseller_suspended' when s.id is null then 'no_subscription'
                   when not private.subscription_status_grants_access(s.status) then 'subscription_inactive' else 'ok' end,
    'status', r.status,
    'plan_code', r.plan_code,
    'subscription_status', s.status,
    'subscription_source', s.source,
    'max_organizations', coalesce(r.max_organizations_override, p.max_organizations),
    'max_custom_domains', coalesce(r.max_custom_domains_override, p.max_custom_domains),
    'allowed_client_plans', to_jsonb(p.allowed_client_plans),
    'features', to_jsonb(p.features));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Feature flag (non sostituiscono i controlli di abbonamento: si sommano)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.flag_enabled(p_flag text, p_org uuid default null, p_reseller uuid default null)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
  v_reseller uuid := p_reseller;
begin
  if p_org is not null then
    select enabled into v from public.feature_flag_overrides where flag_key = p_flag and organization_id = p_org;
    if v is not null then return v; end if;
    if v_reseller is null then
      select reseller_id into v_reseller from public.reseller_organizations where organization_id = p_org and status = 'active';
    end if;
  end if;
  if v_reseller is not null then
    select enabled into v from public.feature_flag_overrides where flag_key = p_flag and reseller_id = v_reseller;
    if v is not null then return v; end if;
  end if;
  return coalesce((select enabled from public.feature_flags where key = p_flag), true);
end $$;

-- Funzionalità commerciale → feature flag (le altre non hanno un flag dedicato).
create or replace function private.feature_flag_for(p_feature text)
returns text language sql immutable set search_path = '' as $$
  select case p_feature when 'lead_finder' then 'lead_finder' when 'ai_analyzer' then 'ai_analyzer'
    when 'ai_sales_agent' then 'sales_agent' when 'campaign_manager' then 'campaign_manager'
    when 'advanced_analytics' then 'advanced_analytics' when 'automations' then 'campaign_manager' end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Entitlement esteso: sospensione, clienti dei rivenditori
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.org_entitlements(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.organization_subscriptions;
  p public.billing_plans;
  ro public.reseller_organizations;
  ra jsonb;
  v_enforced boolean := coalesce((select enforcement_enabled from public.billing_settings where id), true);
  v_suspended boolean := coalesce((select admin_status = 'suspended' from public.organizations where id = p_org), false);
  v_access boolean;
  v_source text;
  v_status text;
  v_sub_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_reseller uuid;
begin
  s := private.current_subscription(p_org);
  if s.id is not null and s.plan_code is not null then
    select * into p from public.billing_plans where code = s.plan_code;
  end if;
  v_access := s.id is not null and p.code is not null and private.subscription_status_grants_access(s.status);
  v_source := s.source;
  v_status := s.status::text;
  v_sub_id := s.id;

  -- Cliente gestito da un rivenditore: il piano è assegnato dal rivenditore e vale finché
  -- il rivenditore è attivo e il suo abbonamento White Label dà accesso. Un abbonamento
  -- Stripe proprio e attivo dell'organizzazione ha la precedenza.
  if not v_access then
    select * into ro from public.reseller_organizations where organization_id = p_org and status = 'active';
    if ro.organization_id is not null then
      ra := private.reseller_access(ro.reseller_id);
      select * into p from public.billing_plans where code = ro.client_plan_code;
      v_access := (ra ->> 'has_access')::boolean and ra -> 'allowed_client_plans' ? ro.client_plan_code;
      v_source := 'reseller';
      v_status := coalesce(ra ->> 'subscription_status', 'canceled');
      v_sub_id := ro.reseller_id;
      v_reseller := ro.reseller_id;
    end if;
  end if;

  if v_suspended then v_access := false; end if;

  if v_sub_id is not null then
    if v_source in ('manual', 'reseller') or s.current_period_start is null or s.current_period_end is null
       or now() >= s.current_period_end or v_source = 'reseller' then
      v_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
      v_end := v_start + interval '1 month';
    else
      v_start := s.current_period_start;
      v_end := s.current_period_end;
    end if;
  end if;
  return jsonb_build_object(
    'enforced', v_enforced,
    'has_access', coalesce(v_access, false),
    'suspended', v_suspended,
    'subscription_id', v_sub_id,
    'source', v_source,
    'status', v_status,
    'reseller_id', v_reseller,
    'plan_code', p.code,
    'features', case when v_access then to_jsonb(p.features) else '[]'::jsonb end,
    'max_users', case when v_access then p.max_users else 1 end,
    'monthly_leads', case when v_access then p.monthly_leads else 0 end,
    'monthly_ai_credits', case when v_access then p.monthly_ai_credits else 0 end,
    'period_start', v_start,
    'period_end', v_end
  );
end $$;

create or replace function private.feature_check(p_org uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e jsonb;
  v_flag text;
begin
  if not (p_feature = any (private.billing_known_features())) then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_feature');
  end if;
  -- Sospensione amministrativa e feature flag valgono anche con l'enforcement dei piani disattivato.
  if coalesce((select admin_status = 'suspended' from public.organizations where id = p_org), false) then
    return jsonb_build_object('allowed', false, 'reason', 'organization_suspended');
  end if;
  v_flag := private.feature_flag_for(p_feature);
  if v_flag is not null and not private.flag_enabled(v_flag, p_org) then
    return jsonb_build_object('allowed', false, 'reason', 'feature_disabled', 'flag', v_flag);
  end if;
  e := private.org_entitlements(p_org);
  if not (e ->> 'enforced')::boolean then
    return jsonb_build_object('allowed', true, 'reason', 'billing_not_enforced', 'plan_code', e ->> 'plan_code');
  end if;
  if e ->> 'subscription_id' is null or e ->> 'plan_code' is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_subscription');
  end if;
  if not (e ->> 'has_access')::boolean then
    return jsonb_build_object('allowed', false, 'reason', 'subscription_inactive', 'status', e ->> 'status', 'plan_code', e ->> 'plan_code');
  end if;
  if not (e -> 'features') ? p_feature then
    return jsonb_build_object('allowed', false, 'reason', 'feature_not_in_plan', 'plan_code', e ->> 'plan_code');
  end if;
  return jsonb_build_object('allowed', true, 'reason', 'ok', 'plan_code', e ->> 'plan_code');
end $$;

-- canUseFeature: leggibile anche dal super admin e dai rivenditori che gestiscono l'organizzazione.
create or replace function public.billing_can_use_feature(p_org uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_org_member(p_org) and not private.is_super_admin()
     and not private.is_reseller_member_of_org(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.feature_check(p_org, p_feature);
end $$;

-- billing_status: aggiunge stato di sospensione e rivenditore (solo il nome) per l'interfaccia.
create or replace function public.billing_status(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  s public.organization_subscriptions;
  q public.usage_quotas;
  v_admin boolean;
begin
  if auth.uid() is not null and not private.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_admin := auth.uid() is null or private.is_org_admin(p_org);
  e := private.org_entitlements(p_org);
  s := private.current_subscription(p_org);
  if e ->> 'period_start' is not null then
    select * into q from public.usage_quotas where organization_id = p_org and period_start = (e ->> 'period_start')::timestamptz;
  end if;
  return jsonb_build_object(
    'entitlements', e,
    'subscription', case when s.id is null then null else jsonb_build_object(
      'source', s.source, 'status', s.status, 'plan_code', s.plan_code,
      'unit_amount_cents', s.unit_amount_cents, 'currency', s.currency, 'billing_interval', s.billing_interval,
      'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
      'cancel_at_period_end', s.cancel_at_period_end, 'cancel_at', s.cancel_at, 'canceled_at', s.canceled_at,
      'livemode', s.livemode, 'synced_at', s.stripe_synced_at) end,
    'managed_by', case when e ->> 'source' = 'reseller' then jsonb_build_object(
      'reseller_name', (select coalesce(b.platform_name, r.name) from public.resellers r
                          left join public.reseller_branding b on b.reseller_id = r.id where r.id = (e ->> 'reseller_id')::uuid),
      'support_email', (select b.support_email from public.reseller_branding b where b.reseller_id = (e ->> 'reseller_id')::uuid)) end,
    'usage', jsonb_build_object(
      'period_start', e ->> 'period_start', 'period_end', e ->> 'period_end',
      'ai_credits', jsonb_build_object('limit', coalesce(q.ai_credits_limit, (e ->> 'monthly_ai_credits')::int),
         'used', coalesce(q.ai_credits_used, 0), 'reserved', coalesce(q.ai_credits_reserved, 0),
         'available', greatest(coalesce(q.ai_credits_limit, (e ->> 'monthly_ai_credits')::int) - coalesce(q.ai_credits_used, 0) - coalesce(q.ai_credits_reserved, 0), 0)),
      'leads', jsonb_build_object('limit', coalesce(q.leads_limit, (e ->> 'monthly_leads')::int), 'used', coalesce(q.leads_used, 0),
         'remaining', greatest(coalesce(q.leads_limit, (e ->> 'monthly_leads')::int) - coalesce(q.leads_used, 0), 0)),
      'users', jsonb_build_object('limit', (e ->> 'max_users')::int,
         'used', (select count(*) from public.organization_members where organization_id = p_org))),
    'has_customer', exists (select 1 from public.stripe_customers where organization_id = p_org),
    'is_admin', v_admin
  );
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Controllo dei costi AI: sospensione globale e tetti di spesa
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.ai_cost_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ops jsonb := (select value from public.platform_settings where key = 'operations');
  cc jsonb := (select value from public.platform_settings where key = 'cost_controls');
  v_month timestamptz := date_trunc('month', now());
  v_cap numeric;
  v_org_cost numeric;
  v_platform_cost numeric;
begin
  if coalesce((ops ->> 'ai_paused')::boolean, false) then
    raise exception 'platform_ai_paused' using errcode = 'P0001';
  end if;
  v_cap := coalesce((select ai_monthly_cap_usd from public.organizations where id = new.organization_id),
                    nullif(cc ->> 'default_org_monthly_ai_cap_usd', '')::numeric);
  if v_cap is not null then
    select coalesce(sum(cost_usd), 0) into v_org_cost from public.ai_jobs
     where organization_id = new.organization_id and created_at >= v_month;
    if v_org_cost >= v_cap then
      raise exception 'platform_org_ai_cap_reached' using errcode = 'P0001',
        detail = jsonb_build_object('cap_usd', v_cap, 'spent_usd', round(v_org_cost, 2))::text;
    end if;
  end if;
  if coalesce((cc ->> 'hard_stop_at_budget')::boolean, false) and nullif(cc ->> 'monthly_ai_budget_usd', '') is not null then
    select coalesce(sum(cost_usd), 0) into v_platform_cost from public.ai_jobs where created_at >= v_month;
    if v_platform_cost >= (cc ->> 'monthly_ai_budget_usd')::numeric then
      raise exception 'platform_ai_budget_reached' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger ai_jobs_cost_guard before insert on public.ai_jobs
  for each row execute function private.ai_cost_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Super admin: console
-- ════════════════════════════════════════════════════════════════════════════
-- Accesso alla console registrato (deduplicato: una riga per utente e sezione ogni 5 minuti).
create or replace function public.sa_log_access(p_section text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  if p_section !~ '^[a-z_]{2,40}$' then raise exception 'invalid_section' using errcode = '22023'; end if;
  if not exists (select 1 from public.admin_audit_logs where actor_id = auth.uid() and action = 'console.access'
                  and target_id = p_section and created_at > now() - interval '5 minutes') then
    perform private.admin_audit('super_admin', 'console.access', 'console', p_section);
  end if;
end $$;

create or replace function public.sa_overview(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 1), 366);
  v_from timestamptz := now() - make_interval(days => v_days);
  rev jsonb;
begin
  perform private.require_super_admin();
  rev := public.billing_admin_revenue(v_days);
  return rev || jsonb_build_object(
    'organizations_total', (select count(*) from public.organizations where deleted_at is null),
    'organizations_suspended', (select count(*) from public.organizations where deleted_at is null and admin_status = 'suspended'),
    'new_organizations', (select count(*) from public.organizations where created_at >= v_from),
    'new_users', (select count(*) from public.profiles where created_at >= v_from),
    'paying_customers', (select count(distinct organization_id) from public.organization_subscriptions
                          where source = 'stripe' and status in ('active', 'trialing', 'past_due') and livemode = coalesce((rev ->> 'livemode')::boolean, false)),
    'reseller_managed_organizations', (select count(*) from public.reseller_organizations where status = 'active'),
    'resellers_active', (select count(*) from public.resellers r where r.deleted_at is null and r.status = 'active'
                          and (private.reseller_access(r.id) ->> 'has_access')::boolean),
    'resellers_total', (select count(*) from public.resellers where deleted_at is null),
    'white_labels_active', (select count(*) from public.resellers r join public.reseller_branding b on b.reseller_id = r.id
                             where r.deleted_at is null and r.status = 'active' and b.platform_name is not null
                               and (private.reseller_access(r.id) ->> 'has_access')::boolean),
    'custom_domains_active', (select count(*) from public.custom_domains where deleted_at is null and status = 'active'),
    'reseller_mrr_cents', coalesce((select round(sum(case s.billing_interval when 'year' then s.unit_amount_cents::numeric / 12 else s.unit_amount_cents end))
                                      from public.reseller_subscriptions s where s.source = 'stripe' and s.status in ('active', 'past_due')
                                       and s.livemode = coalesce((rev ->> 'livemode')::boolean, false)), 0),
    'reseller_wholesale_monthly_cents', coalesce((select sum(coalesce((r.wholesale_prices ->> ro.client_plan_code)::bigint, 0))
                                                    from public.reseller_organizations ro join public.resellers r on r.id = ro.reseller_id
                                                   where ro.status = 'active' and r.deleted_at is null), 0),
    'reseller_net_collected_cents', coalesce((select sum(case when total_cents > 0 then round(amount_paid_cents::numeric * coalesce(total_excluding_tax_cents, total_cents) / total_cents) else 0 end)
                                                from public.billing_invoices where reseller_id is not null and status = 'paid' and paid_at >= v_from), 0),
    'operations', (select value from public.platform_settings where key = 'operations'),
    'cost_controls', (select value from public.platform_settings where key = 'cost_controls')
  );
end $$;

-- billing_admin_revenue (Fase 4) legge i costi provider anche dalla nuova tabella.
create or replace function private.provider_cost_by_org(p_from timestamptz)
returns table (organization_id uuid, cost_usd numeric, requests bigint) language sql stable security definer set search_path = '' as $$
  select organization_id, sum(cost_usd), sum(requests) from (
    select organization_id, cost_usd, requests::bigint from public.provider_cost_events where created_at >= p_from
    union all
    -- Righe storiche non copiate (difesa: la copia iniziale le include già).
    select l.organization_id, l.cost_usd, l.quantity::bigint from public.usage_ledger l
     where l.kind = 'provider_call' and l.created_at >= p_from
       and not exists (select 1 from public.provider_cost_events e where e.organization_id = l.organization_id and e.idempotency_key = l.idempotency_key)
  ) t group by organization_id;
$$;

-- Revenue della Fase 4 aggiornata: costi provider dalla nuova tabella, fatture dei rivenditori escluse
-- dai ricavi delle organizzazioni (sono riportate a parte in sa_overview).
create or replace function public.billing_admin_revenue(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz;
  v_days int := least(greatest(coalesce(p_days, 30), 1), 366);
  v_live boolean;
  r jsonb;
begin
  if not private.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_from := now() - make_interval(days => v_days);
  -- Le metriche considerano la modalità (test/live) dell'ultimo abbonamento sincronizzato.
  select livemode into v_live from public.organization_subscriptions where source = 'stripe' order by stripe_synced_at desc limit 1;
  v_live := coalesce(v_live, false);

  with subs as (
    select s.*,
           case s.billing_interval
             when 'month' then s.unit_amount_cents::numeric / coalesce(s.interval_count, 1)
             when 'year' then s.unit_amount_cents::numeric / (12 * coalesce(s.interval_count, 1))
             when 'week' then s.unit_amount_cents::numeric * 52 / 12 / coalesce(s.interval_count, 1)
             when 'day' then s.unit_amount_cents::numeric * 365 / 12 / coalesce(s.interval_count, 1)
           end as monthly_cents
      from public.organization_subscriptions s
     where s.source = 'stripe' and s.livemode = v_live
  ),
  inv as (
    select * from public.billing_invoices where organization_id is not null and livemode = v_live and status = 'paid' and paid_at >= v_from
  ),
  usage as (
    select coalesce(c.organization_id, pc.organization_id) as organization_id, c.credits, pc.cost_usd as provider_cost_usd
      from (select l.organization_id, sum(l.quantity) filter (where l.kind = 'ai_credits' and l.status = 'committed') as credits
              from public.usage_ledger l where l.created_at >= v_from group by l.organization_id) c
      full join private.provider_cost_by_org(v_from) pc on pc.organization_id = c.organization_id
  ),
  ai as (
    select organization_id, sum(cost_usd) as ai_cost_usd, sum(coalesce(tokens_input, 0) + coalesce(tokens_output, 0)) as tokens,
           count(*) filter (where cost_usd is null and status = 'succeeded') as jobs_without_cost
      from public.ai_jobs where created_at >= v_from and status = 'succeeded' group by organization_id
  ),
  per_org as (
    select o.id, o.name,
           (select plan_code from private.current_subscription(o.id)) as plan_code,
           coalesce(u.credits, 0) as credits, coalesce(a.tokens, 0) as tokens,
           round(coalesce(a.ai_cost_usd, 0), 4) as ai_cost_usd, coalesce(a.jobs_without_cost, 0) as jobs_without_cost,
           round(coalesce(u.provider_cost_usd, 0), 4) as provider_cost_usd,
           coalesce((select sum(case when total_cents > 0 then round(amount_paid_cents::numeric * coalesce(total_excluding_tax_cents, total_cents) / total_cents) else 0 end)
                       from inv where inv.organization_id = o.id), 0) as net_collected_cents
      from public.organizations o
      left join usage u on u.organization_id = o.id
      left join ai a on a.organization_id = o.id
     where u.organization_id is not null or a.organization_id is not null
        or exists (select 1 from subs where subs.organization_id = o.id)
  )
  select jsonb_build_object(
    'livemode', v_live,
    'window_days', v_days,
    'currency', coalesce((select currency from subs where currency is not null limit 1), 'eur'),
    'mrr_cents', coalesce((select round(sum(monthly_cents)) from subs where status in ('active', 'past_due')), 0),
    'mrr_at_risk_cents', coalesce((select round(sum(monthly_cents)) from subs where status = 'past_due'), 0),
    'active_subscriptions', (select count(*) from subs where status in ('active', 'trialing', 'past_due')),
    'trialing_subscriptions', (select count(*) from subs where status = 'trialing'),
    'past_due_subscriptions', (select count(*) from subs where status = 'past_due'),
    'new_subscriptions', (select count(*) from subs where coalesce(started_at, created_at) >= v_from),
    'cancellations', (select count(*) from subs where ended_at >= v_from or (status = 'canceled' and canceled_at >= v_from)),
    'scheduled_cancellations', (select count(*) from subs where cancel_at_period_end and status in ('active', 'trialing', 'past_due')),
    'active_at_window_start', (select count(*) from subs where coalesce(started_at, created_at) < v_from
                                and (ended_at is null or ended_at >= v_from) and status not in ('incomplete', 'incomplete_expired')),
    'failed_payments', (select count(*) from public.billing_audit_logs where action = 'invoice.payment_failed' and created_at >= v_from),
    'open_invoices', (select count(*) from public.billing_invoices where organization_id is not null and livemode = v_live and status = 'open' and amount_remaining_cents > 0),
    'gross_collected_cents', coalesce((select sum(amount_paid_cents) from inv), 0),
    'net_collected_cents', coalesce((select sum(case when total_cents > 0 then round(amount_paid_cents::numeric * coalesce(total_excluding_tax_cents, total_cents) / total_cents) else 0 end) from inv), 0),
    'ai_cost_usd', coalesce((select round(sum(ai_cost_usd), 4) from per_org), 0),
    'provider_cost_usd', coalesce((select round(sum(provider_cost_usd), 4) from per_org), 0),
    'jobs_without_cost', coalesce((select sum(jobs_without_cost) from per_org), 0),
    'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan_code', plan_code, 'count', n, 'mrr_cents', mrr) order by plan_code)
                  from (select plan_code, count(*) as n, round(sum(monthly_cents)) as mrr from subs
                         where status in ('active', 'past_due') group by plan_code) t), '[]'::jsonb),
    'organizations', coalesce((select jsonb_agg(to_jsonb(per_org) order by credits desc) from per_org), '[]'::jsonb)
  ) into r;
  return r;
end $$;

create or replace function public.sa_organizations(p_search text default null, p_status text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  r jsonb;
begin
  perform private.require_super_admin();
  if p_status is not null and p_status not in ('active', 'suspended') then raise exception 'invalid_status' using errcode = '22023'; end if;
  with base as (
    select o.* from public.organizations o
     where o.deleted_at is null
       and (v_q is null or o.name ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
            or o.slug ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' or o.vat_number = upper(v_q))
       and (p_status is null or o.admin_status = p_status)
  ), page as (
    select b.*, private.org_entitlements(b.id) as e from base b order by b.created_at desc limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'slug', p.slug, 'country', p.country, 'created_at', p.created_at,
      'admin_status', p.admin_status, 'suspended_reason', p.suspended_reason,
      'plan_code', p.e ->> 'plan_code', 'subscription_status', p.e ->> 'status', 'source', p.e ->> 'source',
      'has_access', (p.e ->> 'has_access')::boolean,
      'users', (select count(*) from public.organization_members m where m.organization_id = p.id),
      'credits_used', coalesce((select q.ai_credits_used from public.usage_quotas q where q.organization_id = p.id and q.period_start = (p.e ->> 'period_start')::timestamptz), 0),
      'leads_acquired', coalesce((select q.leads_used from public.usage_quotas q where q.organization_id = p.id and q.period_start = (p.e ->> 'period_start')::timestamptz), 0),
      'reseller', (select r.name from public.reseller_organizations ro join public.resellers r on r.id = ro.reseller_id
                    where ro.organization_id = p.id and ro.status = 'active')
    ) order by p.created_at desc), '[]'::jsonb)
  ) into r from page p;
  return r;
end $$;

create or replace function public.sa_organization_detail(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  o public.organizations;
begin
  perform private.require_super_admin();
  select * into o from public.organizations where id = p_org;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'country', o.country, 'vat_number', o.vat_number,
       'created_at', o.created_at, 'admin_status', o.admin_status, 'suspended_at', o.suspended_at, 'suspended_reason', o.suspended_reason,
       'ai_monthly_cap_usd', o.ai_monthly_cap_usd),
    'entitlements', private.org_entitlements(p_org),
    'users', (select count(*) from public.organization_members where organization_id = p_org),
    'ai_cost_month_usd', (select round(coalesce(sum(cost_usd), 0), 4) from public.ai_jobs where organization_id = p_org and created_at >= date_trunc('month', now())),
    'usage_periods', coalesce((select jsonb_agg(jsonb_build_object('period_start', period_start, 'period_end', period_end, 'plan_code', plan_code,
                         'ai_credits_used', ai_credits_used, 'ai_credits_limit', ai_credits_limit, 'leads_used', leads_used, 'leads_limit', leads_limit)
                         order by period_start desc) from (select * from public.usage_quotas where organization_id = p_org order by period_start desc limit 6) q), '[]'::jsonb),
    -- Storico: solo eventi di billing e amministrativi (nessun dato commerciale del tenant).
    'events', coalesce((select jsonb_agg(ev order by (ev ->> 'at') desc) from (
        select jsonb_build_object('at', created_at, 'source', 'billing', 'action', action, 'metadata', metadata - 'note') as ev
          from public.billing_audit_logs where organization_id = p_org
        union all
        select jsonb_build_object('at', created_at, 'source', 'admin', 'action', action, 'reason', reason, 'metadata', metadata)
          from public.admin_audit_logs where target_type = 'organization' and target_id = p_org::text and action <> 'console.access'
        order by 1 desc limit 100) t), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at,
                         'author', (select coalesce(full_name, email) from public.profiles where id = n.author_id)) order by n.created_at desc)
                       from public.admin_notes n where n.target_type = 'organization' and n.target_id = p_org and n.deleted_at is null), '[]'::jsonb),
    'reseller', (select jsonb_build_object('id', r.id, 'name', r.name, 'client_plan_code', ro.client_plan_code)
                   from public.reseller_organizations ro join public.resellers r on r.id = ro.reseller_id where ro.organization_id = p_org and ro.status = 'active'),
    'flag_overrides', coalesce((select jsonb_agg(jsonb_build_object('flag', flag_key, 'enabled', enabled, 'reason', reason))
                                  from public.feature_flag_overrides where organization_id = p_org), '[]'::jsonb)
  );
end $$;

-- Pausa immediata di invii e automazioni (sospensioni).
create or replace function private.pause_org_operations(p_org uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_campaigns int;
  v_workflows int;
begin
  perform set_config('leadflow.campaign_transition', 'on', true);
  update public.campaigns set status = 'paused', paused_reason = p_reason where organization_id = p_org and status in ('scheduled', 'running');
  get diagnostics v_campaigns = row_count;
  perform set_config('leadflow.campaign_transition', '', true);
  update public.automation_workflows set status = 'paused' where organization_id = p_org and status = 'running';
  get diagnostics v_workflows = row_count;
  return jsonb_build_object('campaigns', v_campaigns, 'workflows', v_workflows);
end $$;

create or replace function public.sa_set_organization_status(p_org uuid, p_action text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.organizations;
  v_paused jsonb := '{}'::jsonb;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into o from public.organizations where id = p_org for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_action = 'suspend' then
    if o.admin_status = 'suspended' then raise exception 'already_suspended' using errcode = 'P0001'; end if;
    update public.organizations set admin_status = 'suspended', suspended_at = now(), suspended_reason = btrim(p_reason), suspended_by = auth.uid() where id = p_org;
    v_paused := private.pause_org_operations(p_org, 'admin_suspended');
  elsif p_action = 'reactivate' then
    if o.admin_status <> 'suspended' then raise exception 'not_suspended' using errcode = 'P0001'; end if;
    -- Le campagne restano in pausa: le riattiva l'organizzazione, dopo verifica.
    update public.organizations set admin_status = 'active', suspended_at = null, suspended_reason = null, suspended_by = null where id = p_org;
  else
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  perform private.admin_audit('super_admin', 'organization.' || case when p_action = 'suspend' then 'suspended' else 'reactivated' end,
    'organization', p_org::text, p_reason, jsonb_build_object('paused', v_paused));
  return jsonb_build_object('admin_status', case when p_action = 'suspend' then 'suspended' else 'active' end, 'paused', v_paused);
end $$;

create or replace function public.sa_add_note(p_target_type text, p_target_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if p_target_type = 'organization' and not exists (select 1 from public.organizations where id = p_target_id) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_target_type = 'reseller' and not exists (select 1 from public.resellers where id = p_target_id) then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.admin_notes (target_type, target_id, body, author_id) values (p_target_type, p_target_id, btrim(p_body), auth.uid()) returning id into v_id;
  perform private.admin_audit('super_admin', 'note.created', p_target_type, p_target_id::text, null, jsonb_build_object('note_id', v_id));
  return v_id;
end $$;

create or replace function public.sa_delete_note(p_note uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n public.admin_notes;
begin
  perform private.require_super_admin();
  update public.admin_notes set deleted_at = now() where id = p_note and deleted_at is null returning * into n;
  if n.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.admin_audit('super_admin', 'note.deleted', n.target_type, n.target_id::text, null, jsonb_build_object('note_id', p_note));
end $$;

create or replace function public.sa_set_org_ai_cap(p_org uuid, p_cap_usd numeric, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.organizations set ai_monthly_cap_usd = p_cap_usd where id = p_org;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.admin_audit('super_admin', 'organization.ai_cap_set', 'organization', p_org::text, p_reason, jsonb_build_object('cap_usd', p_cap_usd));
end $$;

-- ─── Utilizzo e costi ───────────────────────────────────────────────────────
-- Token (unità di consumo dei modelli, con costo stimato) e crediti (unità commerciale venduta
-- nei piani) sono riportati separatamente e non vengono mai convertiti l'uno nell'altro.
create or replace function public.sa_usage(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to timestamptz := coalesce(p_to, now());
  cc jsonb := (select value from public.platform_settings where key = 'cost_controls');
  v_month_cost numeric;
  r jsonb;
begin
  perform private.require_super_admin();
  if v_to <= v_from or v_to - v_from > interval '366 days' then raise exception 'invalid_range' using errcode = '22023'; end if;
  select coalesce(sum(cost_usd), 0) into v_month_cost from public.ai_jobs where created_at >= date_trunc('month', now());

  with jobs as (
    select * from public.ai_jobs where created_at >= v_from and created_at < v_to
  ), prov as (
    select * from public.provider_cost_events where created_at >= v_from and created_at < v_to
  ), led as (
    select * from public.usage_ledger where created_at >= v_from and created_at < v_to and kind in ('ai_credits', 'leads')
  ), org_cost as (
    select o.id, o.name, o.ai_monthly_cap_usd,
           (private.org_entitlements(o.id) ->> 'plan_code') as plan_code,
           coalesce((select sum(coalesce(tokens_input, 0) + coalesce(tokens_output, 0)) from jobs j where j.organization_id = o.id), 0) as tokens,
           coalesce((select sum(cost_usd) from jobs j where j.organization_id = o.id), 0) as ai_cost_usd,
           coalesce((select count(*) from jobs j where j.organization_id = o.id and j.status = 'failed'), 0) as failed_jobs,
           coalesce((select sum(cost_usd) from prov p where p.organization_id = o.id), 0) as provider_cost_usd,
           coalesce((select sum(quantity) from led l where l.organization_id = o.id and l.kind = 'ai_credits' and l.status = 'committed'), 0) as credits,
           coalesce((select sum(quantity) from led l where l.organization_id = o.id and l.kind = 'leads'), 0) as leads,
           coalesce((select sum(case when total_cents > 0 then round(amount_paid_cents::numeric * coalesce(total_excluding_tax_cents, total_cents) / total_cents) else 0 end)
                       from public.billing_invoices i where i.organization_id = o.id and i.status = 'paid' and i.paid_at >= v_from and i.paid_at < v_to), 0) as net_collected_cents,
           (select coalesce(sum(cost_usd), 0) from public.ai_jobs j2 where j2.organization_id = o.id and j2.created_at >= date_trunc('month', now())) as month_ai_cost_usd
      from public.organizations o
     where exists (select 1 from jobs j where j.organization_id = o.id) or exists (select 1 from prov p where p.organization_id = o.id)
        or exists (select 1 from led l where l.organization_id = o.id)
        or exists (select 1 from public.billing_invoices i where i.organization_id = o.id and i.status = 'paid' and i.paid_at >= v_from and i.paid_at < v_to)
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'tokens', jsonb_build_object(
      'input', coalesce((select sum(tokens_input) from jobs), 0),
      'output', coalesce((select sum(tokens_output) from jobs), 0)),
    'ai_requests', jsonb_build_object(
      'total', (select count(*) from jobs),
      'succeeded', (select count(*) from jobs where status = 'succeeded'),
      'failed', (select count(*) from jobs where status = 'failed'),
      'without_cost', (select count(*) from jobs where status = 'succeeded' and cost_usd is null)),
    'ai_cost_usd', coalesce((select round(sum(cost_usd), 4) from jobs), 0),
    'by_model', coalesce((select jsonb_agg(jsonb_build_object('model', coalesce(model, 'n/d'), 'requests', n, 'failed', f, 'tokens_input', ti, 'tokens_output', tout,
                           'cost_usd', round(c, 4), 'without_cost', nc) order by c desc nulls last)
                     from (select model, count(*) n, count(*) filter (where status = 'failed') f, coalesce(sum(tokens_input), 0) ti, coalesce(sum(tokens_output), 0) tout,
                                  coalesce(sum(cost_usd), 0) c, count(*) filter (where status = 'succeeded' and cost_usd is null) nc
                             from jobs group by model) m), '[]'::jsonb),
    'by_task', coalesce((select jsonb_agg(jsonb_build_object('task', coalesce(task, 'n/d'), 'requests', n, 'failed', f) order by n desc)
                     from (select task, count(*) n, count(*) filter (where status = 'failed') f from jobs group by task) t), '[]'::jsonb),
    'providers', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'requests', n, 'cost_usd', round(c, 4), 'without_cost', nc) order by n desc)
                     from (select provider, sum(requests) n, coalesce(sum(cost_usd), 0) c, count(*) filter (where cost_usd is null) nc from prov group by provider) p), '[]'::jsonb),
    'provider_cost_usd', coalesce((select round(sum(cost_usd), 4) from prov), 0),
    'credits_used', coalesce((select sum(quantity) from led where kind = 'ai_credits' and status = 'committed'), 0),
    'leads_acquired', coalesce((select sum(quantity) from led where kind = 'leads'), 0),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'tokens', tk, 'ai_cost_usd', round(ac, 4), 'provider_cost_usd', round(pc, 4), 'requests', rq, 'failed', fl) order by d)
                     from (select gs::date as d,
                                  coalesce((select sum(coalesce(tokens_input, 0) + coalesce(tokens_output, 0)) from jobs where created_at::date = gs::date), 0) tk,
                                  coalesce((select sum(cost_usd) from jobs where created_at::date = gs::date), 0) ac,
                                  coalesce((select sum(cost_usd) from prov where created_at::date = gs::date), 0) pc,
                                  (select count(*) from jobs where created_at::date = gs::date) rq,
                                  (select count(*) from jobs where created_at::date = gs::date and status = 'failed') fl
                             from generate_series(date_trunc('day', v_from), date_trunc('day', v_to - interval '1 second'), interval '1 day') gs) dd), '[]'::jsonb),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'plan_code', plan_code, 'tokens', tokens,
                           'ai_cost_usd', round(ai_cost_usd, 4), 'provider_cost_usd', round(provider_cost_usd, 4), 'failed_jobs', failed_jobs,
                           'credits', credits, 'leads', leads, 'net_collected_cents', net_collected_cents,
                           'month_ai_cost_usd', round(month_ai_cost_usd, 4),
                           'cap_usd', coalesce(ai_monthly_cap_usd, nullif(cc ->> 'default_org_monthly_ai_cap_usd', '')::numeric)) order by ai_cost_usd + provider_cost_usd desc)
                     from org_cost), '[]'::jsonb),
    -- Margine per piano nella finestra: incassi netti (EUR) e costi stimati (USD) affiancati, non convertiti.
    'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan_code', coalesce(plan_code, 'none'), 'organizations', n, 'net_collected_cents', rev,
                           'ai_cost_usd', round(ai, 4), 'provider_cost_usd', round(pr, 4), 'credits', cr) order by rev desc)
                     from (select plan_code, count(*) n, sum(net_collected_cents) rev, sum(ai_cost_usd) ai, sum(provider_cost_usd) pr, sum(credits) cr
                             from org_cost group by plan_code) bp), '[]'::jsonb),
    'alerts', (
      select coalesce(jsonb_agg(a), '[]'::jsonb) from (
        select jsonb_build_object('type', 'platform_budget', 'level', case when v_month_cost >= (cc ->> 'monthly_ai_budget_usd')::numeric then 'critical' else 'warning' end,
                                  'spent_usd', round(v_month_cost, 2), 'budget_usd', (cc ->> 'monthly_ai_budget_usd')::numeric) as a
         where nullif(cc ->> 'monthly_ai_budget_usd', '') is not null
           and v_month_cost >= (cc ->> 'monthly_ai_budget_usd')::numeric * coalesce((cc ->> 'alert_threshold_pct')::numeric, 80) / 100
        union all
        select jsonb_build_object('type', 'org_cap', 'level', case when oc.month_ai_cost_usd >= oc.cap then 'critical' else 'warning' end,
                                  'organization_id', oc.id, 'organization', oc.name, 'spent_usd', round(oc.month_ai_cost_usd, 2), 'cap_usd', oc.cap)
          from (select o.id, o.name, o.month_ai_cost_usd, coalesce(o.ai_monthly_cap_usd, nullif(cc ->> 'default_org_monthly_ai_cap_usd', '')::numeric) cap from org_cost o) oc
         where oc.cap is not null and oc.month_ai_cost_usd >= oc.cap * coalesce((cc ->> 'alert_threshold_pct')::numeric, 80) / 100
        union all
        select jsonb_build_object('type', 'failure_rate', 'level', 'warning', 'failed', (select count(*) from jobs where status = 'failed'), 'total', (select count(*) from jobs))
         where (select count(*) from jobs) >= 20 and (select count(*) from jobs where status = 'failed')::numeric / (select count(*) from jobs) > 0.2
        union all
        select jsonb_build_object('type', 'missing_prices', 'level', 'info', 'jobs', (select count(*) from jobs where status = 'succeeded' and cost_usd is null))
         where exists (select 1 from jobs where status = 'succeeded' and cost_usd is null)
      ) x),
    'month_ai_cost_usd', round(v_month_cost, 4),
    'cost_controls', cc,
    'operations', (select value from public.platform_settings where key = 'operations')
  ) into r;
  return r;
end $$;

-- ─── Impostazioni, sospensione operazioni costose, feature flag ─────────────
create or replace function public.sa_update_setting(p_key text, p_value jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select value into v_old from public.platform_settings where key = p_key for update;
  if v_old is null then raise exception 'unknown_setting' using errcode = '22023'; end if;
  if jsonb_typeof(p_value) <> 'object' then raise exception 'invalid_value' using errcode = '22023'; end if;
  v_new := v_old || p_value;
  -- Validazione per chiave: solo i campi previsti, con tipi e intervalli corretti.
  if exists (select 1 from jsonb_object_keys(v_new) k where k not in (select jsonb_object_keys(v_old))) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  if p_key = 'cost_controls' then
    if (jsonb_typeof(v_new -> 'monthly_ai_budget_usd') not in ('null', 'number')) or (jsonb_typeof(v_new -> 'default_org_monthly_ai_cap_usd') not in ('null', 'number'))
       or jsonb_typeof(v_new -> 'alert_threshold_pct') <> 'number' or jsonb_typeof(v_new -> 'hard_stop_at_budget') <> 'boolean'
       or (v_new ->> 'alert_threshold_pct')::numeric not between 1 and 100
       or coalesce((v_new ->> 'monthly_ai_budget_usd')::numeric, 0) < 0 or coalesce((v_new ->> 'default_org_monthly_ai_cap_usd')::numeric, 0) < 0 then
      raise exception 'invalid_value' using errcode = '22023';
    end if;
  elsif p_key = 'operations' then
    if jsonb_typeof(v_new -> 'ai_paused') <> 'boolean' or jsonb_typeof(v_new -> 'providers_paused') <> 'array'
       or exists (select 1 from jsonb_array_elements(v_new -> 'providers_paused') x where jsonb_typeof(x) <> 'string' or x #>> '{}' not in ('osm_overpass', 'google_places')) then
      raise exception 'invalid_value' using errcode = '22023';
    end if;
  elsif p_key = 'white_label' then
    if jsonb_typeof(v_new -> 'cname_target') not in ('null', 'string')
       or (v_new ->> 'cname_target' is not null and v_new ->> 'cname_target' !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') then
      raise exception 'invalid_value' using errcode = '22023';
    end if;
  end if;
  update public.platform_settings set value = v_new, updated_by = auth.uid() where key = p_key;
  perform private.admin_audit('super_admin', 'settings.updated', 'settings', p_key, p_reason, jsonb_build_object('before', v_old, 'after', v_new));
  return v_new;
end $$;

create or replace function public.sa_set_feature_flag(p_key text, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.feature_flags set enabled = p_enabled, updated_by = auth.uid() where key = p_key;
  if not found then raise exception 'unknown_flag' using errcode = '22023'; end if;
  perform private.admin_audit('super_admin', 'feature_flag.updated', 'feature_flag', p_key, p_reason, jsonb_build_object('enabled', p_enabled));
end $$;

-- p_enabled null = rimuove l'override.
create or replace function public.sa_set_flag_override(p_key text, p_target_type text, p_target uuid, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  if not exists (select 1 from public.feature_flags where key = p_key) then raise exception 'unknown_flag' using errcode = '22023'; end if;
  if p_target_type = 'organization' then
    delete from public.feature_flag_overrides where flag_key = p_key and organization_id = p_target;
    if p_enabled is not null then
      insert into public.feature_flag_overrides (flag_key, organization_id, enabled, reason, created_by) values (p_key, p_target, p_enabled, p_reason, auth.uid());
    end if;
  elsif p_target_type = 'reseller' then
    delete from public.feature_flag_overrides where flag_key = p_key and reseller_id = p_target;
    if p_enabled is not null then
      insert into public.feature_flag_overrides (flag_key, reseller_id, enabled, reason, created_by) values (p_key, p_target, p_enabled, p_reason, auth.uid());
    end if;
  else
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  perform private.admin_audit('super_admin', 'feature_flag.override', p_target_type, p_target::text, p_reason, jsonb_build_object('flag', p_key, 'enabled', p_enabled));
end $$;

-- ─── Rivenditori (super admin) ──────────────────────────────────────────────
create or replace function public.sa_create_reseller(p_name text, p_slug text, p_plan text, p_admin_email text,
  p_contact_email text default null, p_wholesale jsonb default '{}'::jsonb, p_max_orgs integer default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_admin uuid;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  select id into v_admin from auth.users where lower(email) = lower(btrim(p_admin_email));
  if v_admin is null then raise exception 'admin_user_not_found' using errcode = 'P0002'; end if;
  insert into public.resellers (name, slug, plan_code, contact_email, wholesale_prices, max_organizations_override, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), p_plan, nullif(lower(btrim(coalesce(p_contact_email, ''))), ''), coalesce(p_wholesale, '{}'::jsonb), p_max_orgs, auth.uid())
  returning id into v_id;
  insert into public.reseller_members (reseller_id, user_id, role) values (v_id, v_admin, 'reseller_admin');
  insert into public.reseller_branding (reseller_id) values (v_id);
  perform private.admin_audit('super_admin', 'reseller.created', 'reseller', v_id::text, null,
    jsonb_build_object('name', p_name, 'plan', p_plan, 'admin_user', v_admin, 'wholesale', p_wholesale, 'max_organizations', p_max_orgs));
  return v_id;
end $$;

create or replace function public.sa_update_reseller(p_reseller uuid, p_patch jsonb, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_old public.resellers;
  v_new public.resellers;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) k
             where k not in ('name', 'plan_code', 'contact_email', 'wholesale_prices', 'max_organizations_override', 'max_custom_domains_override')) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  select * into v_old from public.resellers where id = p_reseller and deleted_at is null for update;
  if v_old.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.resellers set
    name = coalesce(btrim(p_patch ->> 'name'), name),
    plan_code = coalesce(p_patch ->> 'plan_code', plan_code),
    contact_email = case when p_patch ? 'contact_email' then nullif(lower(btrim(coalesce(p_patch ->> 'contact_email', ''))), '') else contact_email end,
    wholesale_prices = coalesce(p_patch -> 'wholesale_prices', wholesale_prices),
    max_organizations_override = case when p_patch ? 'max_organizations_override' then (p_patch ->> 'max_organizations_override')::int else max_organizations_override end,
    max_custom_domains_override = case when p_patch ? 'max_custom_domains_override' then (p_patch ->> 'max_custom_domains_override')::int else max_custom_domains_override end
  where id = p_reseller returning * into v_new;
  perform private.admin_audit('super_admin', 'reseller.updated', 'reseller', p_reseller::text, p_reason,
    jsonb_build_object('before', to_jsonb(v_old) - 'updated_at' - 'stripe_customer_id', 'after', to_jsonb(v_new) - 'updated_at' - 'stripe_customer_id'));
end $$;

create or replace function public.sa_set_reseller_status(p_reseller uuid, p_action text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  ro record;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_action = 'suspend' then
    update public.resellers set status = 'suspended', suspended_at = now(), suspended_reason = btrim(p_reason)
     where id = p_reseller and deleted_at is null and status = 'active';
    if not found then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    -- I clienti gestiti perdono l'accesso ai moduli: invii e automazioni in pausa.
    for ro in select organization_id from public.reseller_organizations where reseller_id = p_reseller and status = 'active' loop
      perform private.pause_org_operations(ro.organization_id, 'reseller_suspended');
    end loop;
  elsif p_action = 'reactivate' then
    update public.resellers set status = 'active', suspended_at = null, suspended_reason = null
     where id = p_reseller and deleted_at is null and status = 'suspended';
    if not found then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  else
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  perform private.admin_audit('super_admin', 'reseller.' || case when p_action = 'suspend' then 'suspended' else 'reactivated' end,
    'reseller', p_reseller::text, p_reason);
end $$;

create or replace function public.sa_set_reseller_member(p_reseller uuid, p_email text, p_role text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  if not exists (select 1 from public.resellers where id = p_reseller and deleted_at is null) then raise exception 'not_found' using errcode = 'P0002'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  if p_role is null then
    if (select role from public.reseller_members where reseller_id = p_reseller and user_id = v_user) = 'reseller_admin'
       and (select count(*) from public.reseller_members where reseller_id = p_reseller and role = 'reseller_admin') <= 1 then
      raise exception 'last_reseller_admin' using errcode = 'P0001';
    end if;
    delete from public.reseller_members where reseller_id = p_reseller and user_id = v_user;
  elsif p_role in ('reseller_admin', 'reseller_member') then
    insert into public.reseller_members (reseller_id, user_id, role) values (p_reseller, v_user, p_role)
    on conflict (reseller_id, user_id) do update set role = excluded.role;
  else
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  perform private.admin_audit('super_admin', 'reseller.member_set', 'reseller', p_reseller::text, p_reason, jsonb_build_object('user', v_user, 'role', p_role));
end $$;

-- Contratto White Label fatturato fuori da Stripe (registrato e motivato). Non tocca Stripe.
create or replace function public.sa_set_reseller_external_billing(p_reseller uuid, p_active boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.resellers;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into r from public.resellers where id = p_reseller and deleted_at is null;
  if r.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.reseller_subscriptions set status = 'canceled', ended_at = now()
   where reseller_id = p_reseller and source = 'external' and status <> 'canceled';
  if p_active then
    insert into public.reseller_subscriptions (reseller_id, source, plan_code, status, started_at, note)
    values (p_reseller, 'external', r.plan_code, 'active', now(), left(btrim(p_reason), 500));
  end if;
  perform private.admin_audit('super_admin', 'reseller.external_billing', 'reseller', p_reseller::text, p_reason, jsonb_build_object('active', p_active, 'plan', r.plan_code));
end $$;

create or replace function public.sa_resellers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'slug', r.slug, 'status', r.status, 'plan_code', r.plan_code, 'contact_email', r.contact_email,
    'suspended_reason', r.suspended_reason, 'created_at', r.created_at, 'wholesale_prices', r.wholesale_prices,
    'max_organizations_override', r.max_organizations_override, 'max_custom_domains_override', r.max_custom_domains_override,
    'access', private.reseller_access(r.id),
    'subscription', (select jsonb_build_object('source', s.source, 'status', s.status, 'current_period_end', s.current_period_end,
                       'cancel_at_period_end', s.cancel_at_period_end, 'livemode', s.livemode) from private.reseller_current_subscription(r.id) s where s.id is not null),
    'organizations_active', (select count(*) from public.reseller_organizations ro where ro.reseller_id = r.id and ro.status = 'active'),
    'invitations_pending', (select count(*) from public.reseller_invitations i where i.reseller_id = r.id and i.status = 'pending' and i.expires_at > now()),
    'domains_active', (select count(*) from public.custom_domains d where d.reseller_id = r.id and d.deleted_at is null and d.status = 'active'),
    'domains_total', (select count(*) from public.custom_domains d where d.reseller_id = r.id and d.deleted_at is null),
    'wholesale_monthly_cents', (select coalesce(sum(coalesce((r.wholesale_prices ->> ro.client_plan_code)::bigint, 0)), 0)
                                  from public.reseller_organizations ro where ro.reseller_id = r.id and ro.status = 'active'),
    'credits_used_month', (select coalesce(sum(l.quantity), 0) from public.usage_ledger l join public.reseller_organizations ro on ro.organization_id = l.organization_id
                            where ro.reseller_id = r.id and ro.status = 'active' and l.kind = 'ai_credits' and l.status = 'committed' and l.created_at >= date_trunc('month', now())),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('email', p.email, 'role', m.role)), '[]'::jsonb)
                  from public.reseller_members m join public.profiles p on p.id = m.user_id where m.reseller_id = r.id),
    'organizations', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'client_plan_code', ro.client_plan_code, 'admin_status', o.admin_status) order by o.name), '[]'::jsonb)
                        from public.reseller_organizations ro join public.organizations o on o.id = ro.organization_id where ro.reseller_id = r.id and ro.status = 'active')
  ) order by r.created_at desc) from public.resellers r where r.deleted_at is null), '[]'::jsonb);
end $$;

create or replace function public.sa_domains()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'hostname', d.hostname, 'reseller', r.name, 'reseller_id', r.id, 'status', d.status,
    'dns_status', d.dns_status, 'https_status', d.https_status, 'provisioning', d.provisioning, 'verified_at', d.verified_at,
    'last_checked_at', d.last_checked_at, 'last_error', d.last_error) order by d.created_at desc)
    from public.custom_domains d join public.resellers r on r.id = d.reseller_id where d.deleted_at is null), '[]'::jsonb);
end $$;

-- Il super admin conferma di aver aggiunto (o rimosso) l'alias sull'hosting. Nessun provisioning automatico.
create or replace function public.sa_mark_domain_provisioned(p_domain uuid, p_done boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  d public.custom_domains;
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into d from public.custom_domains where id = p_domain and deleted_at is null for update;
  if d.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_done and d.status not in ('verified', 'active') then raise exception 'domain_not_verified' using errcode = 'P0001'; end if;
  update public.custom_domains
     set provisioning = case when p_done then 'manual_done' else 'manual_pending' end,
         status = case when not p_done and status = 'active' then 'verified' else status end,
         https_status = case when p_done then 'pending' else 'unknown' end
   where id = p_domain;
  perform private.admin_audit('super_admin', 'domain.provisioning', 'domain', p_domain::text, p_reason, jsonb_build_object('hostname', d.hostname, 'done', p_done));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Portale rivenditori
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.require_reseller(p_reseller uuid, p_admin boolean default false)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_admin and not private.is_reseller_admin(p_reseller) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not p_admin and not private.is_reseller_member(p_reseller) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.flag_enabled('reseller_portal', null, p_reseller) then raise exception 'feature_disabled' using errcode = 'P0001'; end if;
end $$;

-- Operazioni che creano o modificano risorse: il rivenditore deve essere attivo con abbonamento valido.
create or replace function private.require_reseller_active(p_reseller uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a jsonb := private.reseller_access(p_reseller);
begin
  if not (a ->> 'has_access')::boolean then
    raise exception 'reseller_%', a ->> 'reason' using errcode = 'P0001';
  end if;
  return a;
end $$;

create or replace function public.reseller_my_resellers()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'role', m.role, 'status', r.status) order by r.name), '[]'::jsonb)
    from public.reseller_members m join public.resellers r on r.id = m.reseller_id
   where m.user_id = (select auth.uid()) and r.deleted_at is null;
$$;

create or replace function public.reseller_dashboard(p_reseller uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r public.resellers;
  a jsonb;
  v_admin boolean := private.is_reseller_admin(p_reseller);
begin
  perform private.require_reseller(p_reseller);
  select * into r from public.resellers where id = p_reseller;
  a := private.reseller_access(p_reseller);
  return jsonb_build_object(
    'reseller', jsonb_build_object('id', r.id, 'name', r.name, 'slug', r.slug, 'status', r.status, 'suspended_reason', r.suspended_reason, 'plan_code', r.plan_code),
    'role', case when v_admin then 'reseller_admin' else 'reseller_member' end,
    'access', a,
    'plan', (select to_jsonb(p) - 'stripe_monthly_price_id' - 'stripe_setup_price_id' - 'updated_by' from public.reseller_plans p where p.code = r.plan_code),
    'subscription', (select jsonb_build_object('source', s.source, 'status', s.status, 'current_period_end', s.current_period_end,
                       'cancel_at_period_end', s.cancel_at_period_end, 'unit_amount_cents', s.unit_amount_cents, 'livemode', s.livemode)
                       from private.reseller_current_subscription(p_reseller) s where s.id is not null),
    'has_billing_account', r.stripe_customer_id is not null,
    'wholesale_prices', r.wholesale_prices,
    -- Clienti: solo metadati e consumi aggregati, nessun dato commerciale (lead, campagne, messaggi).
    'clients', coalesce((select jsonb_agg(jsonb_build_object(
        'organization_id', o.id, 'name', o.name, 'client_plan_code', ro.client_plan_code, 'admin_status', o.admin_status,
        'linked_at', ro.linked_at, 'users', (select count(*) from public.organization_members m where m.organization_id = o.id),
        'credits_used', coalesce(q.ai_credits_used, 0), 'credits_limit', coalesce(q.ai_credits_limit, bp.monthly_ai_credits),
        'credits_available', greatest(coalesce(q.ai_credits_limit, bp.monthly_ai_credits) - coalesce(q.ai_credits_used, 0) - coalesce(q.ai_credits_reserved, 0), 0),
        'leads_used', coalesce(q.leads_used, 0), 'leads_limit', coalesce(q.leads_limit, bp.monthly_leads),
        'wholesale_cents', coalesce((r.wholesale_prices ->> ro.client_plan_code)::bigint, 0)) order by o.name)
      from public.reseller_organizations ro
      join public.organizations o on o.id = ro.organization_id
      join public.billing_plans bp on bp.code = ro.client_plan_code
      left join public.usage_quotas q on q.organization_id = o.id and q.period_start = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
     where ro.reseller_id = p_reseller and ro.status = 'active'), '[]'::jsonb),
    'invitations', case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'organization_name', i.organization_name,
        'client_plan_code', i.client_plan_code, 'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
        'expires_at', i.expires_at, 'created_at', i.created_at) order by i.created_at desc)
      from (select * from public.reseller_invitations where reseller_id = p_reseller order by created_at desc limit 50) i), '[]'::jsonb) else '[]'::jsonb end,
    'branding', (select to_jsonb(b) - 'updated_by' - 'reseller_id' from public.reseller_branding b where b.reseller_id = p_reseller),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'hostname', d.hostname, 'status', d.status, 'dns_status', d.dns_status,
        'https_status', d.https_status, 'provisioning', d.provisioning, 'verification_token', case when v_admin then d.verification_token end,
        'verified_at', d.verified_at, 'last_checked_at', d.last_checked_at, 'last_error', d.last_error) order by d.created_at)
      from public.custom_domains d where d.reseller_id = p_reseller and d.deleted_at is null), '[]'::jsonb),
    'cname_target', (select value ->> 'cname_target' from public.platform_settings where key = 'white_label'),
    'flags', jsonb_build_object('custom_branding', private.flag_enabled('custom_branding', null, p_reseller),
                                'custom_domain', private.flag_enabled('custom_domain', null, p_reseller))
  );
end $$;

-- Invito di un nuovo cliente: entro i limiti del piano White Label. Restituisce il token UNA volta.
create or replace function public.reseller_create_invitation(p_reseller uuid, p_email text, p_org_name text, p_client_plan text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_used int;
  v_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_mutation', 20);
  a := private.require_reseller_active(p_reseller);
  if not (a -> 'allowed_client_plans') ? p_client_plan then raise exception 'plan_not_allowed' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('reseller_clients:' || p_reseller::text, 0));
  select (select count(*) from public.reseller_organizations where reseller_id = p_reseller and status = 'active')
       + (select count(*) from public.reseller_invitations where reseller_id = p_reseller and status = 'pending' and expires_at > now())
    into v_used;
  if v_used >= (a ->> 'max_organizations')::int then
    raise exception 'reseller_client_limit_reached' using errcode = 'P0001', detail = jsonb_build_object('limit', (a ->> 'max_organizations')::int)::text;
  end if;
  -- Un invito scaduto per la stessa email viene sostituito.
  update public.reseller_invitations set status = 'revoked' where reseller_id = p_reseller and email = v_email and status = 'pending' and expires_at <= now();
  insert into public.reseller_invitations (reseller_id, email, organization_name, client_plan_code, token_hash, expires_at, created_by)
  values (p_reseller, v_email, btrim(p_org_name), p_client_plan, encode(extensions.digest(v_token, 'sha256'), 'hex'), now() + interval '14 days', auth.uid())
  returning id into v_id;
  perform private.admin_audit('reseller_admin', 'invitation.created', 'invitation', v_id::text, null,
    jsonb_build_object('reseller', p_reseller, 'email_domain', split_part(v_email, '@', 2), 'plan', p_client_plan));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', now() + interval '14 days');
end $$;

create or replace function public.reseller_revoke_invitation(p_reseller uuid, p_invitation uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_mutation', 20);
  update public.reseller_invitations set status = 'revoked' where id = p_invitation and reseller_id = p_reseller and status = 'pending';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.admin_audit('reseller_admin', 'invitation.revoked', 'invitation', p_invitation::text, null, jsonb_build_object('reseller', p_reseller));
end $$;

create or replace function public.reseller_set_client_plan(p_reseller uuid, p_org uuid, p_client_plan text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
  v_old text;
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_mutation', 20);
  a := private.require_reseller_active(p_reseller);
  if not (a -> 'allowed_client_plans') ? p_client_plan then raise exception 'plan_not_allowed' using errcode = 'P0001'; end if;
  select client_plan_code into v_old from public.reseller_organizations where organization_id = p_org and reseller_id = p_reseller and status = 'active' for update;
  if v_old is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.reseller_organizations set client_plan_code = p_client_plan where organization_id = p_org;
  perform private.lock_quota_period(p_org);
  perform private.billing_sync_technical_quotas(p_org);
  perform private.billing_pause_disallowed(p_org);
  perform private.admin_audit('reseller_admin', 'client.plan_changed', 'organization', p_org::text, null,
    jsonb_build_object('reseller', p_reseller, 'from', v_old, 'to', p_client_plan));
end $$;

-- Anteprima per l'utente invitato (solo se l'email coincide con quella dell'account).
create or replace function public.invitation_preview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  i public.reseller_invitations;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into i from public.reseller_invitations where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if i.id is null or i.email <> lower((select email from auth.users where id = auth.uid())) then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('organization_name', i.organization_name, 'client_plan_code', i.client_plan_code,
    'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end, 'expires_at', i.expires_at,
    'reseller_name', (select coalesce(b.platform_name, r.name) from public.resellers r left join public.reseller_branding b on b.reseller_id = r.id where r.id = i.reseller_id));
end $$;

create or replace function public.accept_reseller_invitation(p_token text, p_vat_number text default null, p_country text default 'IT')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.reseller_invitations;
  a jsonb;
  v_org public.organizations;
  v_active int;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform private.rate_limit('invitation_accept', 10);
  select * into i from public.reseller_invitations where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if i.id is null or i.email <> lower((select email from auth.users where id = auth.uid())) then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;
  if i.status <> 'pending' then raise exception 'invitation_not_pending' using errcode = 'P0001'; end if;
  if i.expires_at <= now() then raise exception 'invitation_expired' using errcode = 'P0001'; end if;
  a := private.reseller_access(i.reseller_id);
  if not (a ->> 'has_access')::boolean then raise exception 'reseller_unavailable' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('reseller_clients:' || i.reseller_id::text, 0));
  select count(*) into v_active from public.reseller_organizations where reseller_id = i.reseller_id and status = 'active';
  -- L'invito era già conteggiato nel limite; si ricontrolla nel caso il limite sia stato ridotto.
  if v_active >= (a ->> 'max_organizations')::int then raise exception 'reseller_client_limit_reached' using errcode = 'P0001'; end if;
  v_org := public.create_organization(i.organization_name, p_vat_number, p_country);
  insert into public.reseller_organizations (organization_id, reseller_id, client_plan_code, linked_by)
  values (v_org.id, i.reseller_id, i.client_plan_code, auth.uid());
  update public.reseller_invitations set status = 'accepted', accepted_at = now(), accepted_by = auth.uid(), organization_id = v_org.id where id = i.id;
  perform private.lock_quota_period(v_org.id);
  perform private.billing_sync_technical_quotas(v_org.id);
  perform private.admin_audit('system', 'invitation.accepted', 'organization', v_org.id::text, null, jsonb_build_object('reseller', i.reseller_id, 'invitation', i.id));
  return v_org.id;
end $$;

-- ─── Branding ───────────────────────────────────────────────────────────────
create or replace function public.reseller_update_branding(p_reseller uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
  b public.reseller_branding;
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_mutation', 20);
  a := private.require_reseller_active(p_reseller);
  if not (a -> 'features') ? 'custom_branding' or not private.flag_enabled('custom_branding', null, p_reseller) then
    raise exception 'feature_not_in_plan' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) k
             where k not in ('platform_name', 'primary_color', 'secondary_color', 'theme', 'welcome_title', 'welcome_text', 'support_email', 'privacy_url', 'terms_url')) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  insert into public.reseller_branding (reseller_id) values (p_reseller) on conflict do nothing;
  update public.reseller_branding set
    platform_name = case when p_patch ? 'platform_name' then nullif(btrim(coalesce(p_patch ->> 'platform_name', '')), '') else platform_name end,
    primary_color = case when p_patch ? 'primary_color' then nullif(lower(coalesce(p_patch ->> 'primary_color', '')), '') else primary_color end,
    secondary_color = case when p_patch ? 'secondary_color' then nullif(lower(coalesce(p_patch ->> 'secondary_color', '')), '') else secondary_color end,
    theme = coalesce(p_patch ->> 'theme', theme),
    welcome_title = case when p_patch ? 'welcome_title' then nullif(btrim(coalesce(p_patch ->> 'welcome_title', '')), '') else welcome_title end,
    welcome_text = case when p_patch ? 'welcome_text' then nullif(btrim(coalesce(p_patch ->> 'welcome_text', '')), '') else welcome_text end,
    support_email = case when p_patch ? 'support_email' then nullif(lower(btrim(coalesce(p_patch ->> 'support_email', ''))), '') else support_email end,
    privacy_url = case when p_patch ? 'privacy_url' then nullif(btrim(coalesce(p_patch ->> 'privacy_url', '')), '') else privacy_url end,
    terms_url = case when p_patch ? 'terms_url' then nullif(btrim(coalesce(p_patch ->> 'terms_url', '')), '') else terms_url end,
    updated_by = auth.uid(), updated_at = now()
  where reseller_id = p_reseller returning * into b;
  perform private.admin_audit('reseller_admin', 'branding.updated', 'reseller', p_reseller::text, null, jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));
  return to_jsonb(b) - 'updated_by';
end $$;

-- Percorso di un'immagine già validata e caricata dal server (service role).
create or replace function public.reseller_set_branding_asset(p_reseller uuid, p_kind text, p_path text, p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_kind not in ('logo', 'login_logo', 'favicon') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  if p_path is not null and p_path !~ ('^' || p_reseller::text || '/' || p_kind || '-[0-9a-f]{12}\.(png|jpg|webp|ico)$') then
    raise exception 'invalid_path' using errcode = '22023';
  end if;
  insert into public.reseller_branding (reseller_id) values (p_reseller) on conflict do nothing;
  update public.reseller_branding set
    logo_path = case when p_kind = 'logo' then p_path else logo_path end,
    login_logo_path = case when p_kind = 'login_logo' then p_path else login_logo_path end,
    favicon_path = case when p_kind = 'favicon' then p_path else favicon_path end,
    updated_by = p_actor, updated_at = now()
  where reseller_id = p_reseller;
  insert into public.admin_audit_logs (actor_id, actor_role, action, target_type, target_id, metadata)
  values (p_actor, 'reseller_admin', 'branding.asset_updated', 'reseller', p_reseller::text, jsonb_build_object('kind', p_kind, 'removed', p_path is null));
end $$;

-- Verifica server-side prima di un upload (chiamata dall'endpoint con il JWT dell'utente).
create or replace function public.reseller_can_upload_branding(p_reseller uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_upload', 10);
  a := private.require_reseller_active(p_reseller);
  if not (a -> 'features') ? 'custom_branding' or not private.flag_enabled('custom_branding', null, p_reseller) then
    raise exception 'feature_not_in_plan' using errcode = 'P0001';
  end if;
  return true;
end $$;

-- ─── Domini personalizzati ──────────────────────────────────────────────────
create or replace function public.reseller_add_domain(p_reseller uuid, p_hostname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
  v_host text := lower(rtrim(btrim(coalesce(p_hostname, '')), '.'));
  v_id uuid;
  v_token text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_mutation', 20);
  a := private.require_reseller_active(p_reseller);
  if not (a -> 'features') ? 'custom_domain' or not private.flag_enabled('custom_domain', null, p_reseller) then
    raise exception 'feature_not_in_plan' using errcode = 'P0001';
  end if;
  -- Domini della piattaforma e di hosting condiviso non registrabili.
  if v_host ~ '(^|\.)(netlify\.app|netlify\.com|supabase\.co|stripe\.com|localhost|local|internal|example|test|invalid)$' then
    raise exception 'domain_not_allowed' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reseller_domains:' || p_reseller::text, 0));
  if (select count(*) from public.custom_domains where reseller_id = p_reseller and deleted_at is null) >= (a ->> 'max_custom_domains')::int then
    raise exception 'reseller_domain_limit_reached' using errcode = 'P0001', detail = jsonb_build_object('limit', (a ->> 'max_custom_domains')::int)::text;
  end if;
  if exists (select 1 from public.custom_domains where hostname = v_host and deleted_at is null) then
    raise exception 'domain_taken' using errcode = 'P0001';
  end if;
  insert into public.custom_domains (reseller_id, hostname, verification_token, created_by)
  values (p_reseller, v_host, v_token, auth.uid()) returning id into v_id;
  perform private.admin_audit('reseller_admin', 'domain.added', 'domain', v_id::text, null, jsonb_build_object('reseller', p_reseller, 'hostname', v_host));
  return jsonb_build_object('id', v_id, 'hostname', v_host, 'verification_token', v_token,
    'txt_name', '_leadflow-challenge.' || v_host, 'txt_value', 'leadflow-verify=' || v_token);
end $$;

create or replace function public.reseller_remove_domain(p_reseller uuid, p_domain uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  d public.custom_domains;
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_mutation', 20);
  update public.custom_domains set status = 'removed', deleted_at = now()
   where id = p_domain and reseller_id = p_reseller and deleted_at is null returning * into d;
  if d.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.admin_audit('reseller_admin', 'domain.removed', 'domain', p_domain::text, null,
    jsonb_build_object('reseller', p_reseller, 'hostname', d.hostname, 'provisioning', d.provisioning));
end $$;

-- Dominio da verificare (con controllo d'accesso e limite di frequenza: 1 verifica ogni 30 s).
create or replace function public.reseller_domain_for_check(p_reseller uuid, p_domain uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.custom_domains;
begin
  perform private.require_reseller(p_reseller, true);
  perform private.rate_limit('reseller_domain_check', 10);
  select * into d from public.custom_domains where id = p_domain and reseller_id = p_reseller and deleted_at is null for update;
  if d.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if d.last_checked_at > now() - interval '30 seconds' then
    raise exception 'rate_limited' using errcode = 'P0001', detail = jsonb_build_object('retry_after', 30)::text;
  end if;
  update public.custom_domains set last_checked_at = now() where id = p_domain;
  return jsonb_build_object('id', d.id, 'hostname', d.hostname, 'verification_token', d.verification_token, 'provisioning', d.provisioning,
    'status', d.status, 'cname_target', (select value ->> 'cname_target' from public.platform_settings where key = 'white_label'));
end $$;

-- Esito dei controlli DNS/HTTPS eseguiti dal server (service role). Lo stato avanza solo con prove reali.
create or replace function public.domain_record_check(p_domain uuid, p_txt_ok boolean, p_dns_status text, p_https_status text, p_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.custom_domains;
  v_status text;
begin
  select * into d from public.custom_domains where id = p_domain and deleted_at is null for update;
  if d.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_status := case
    when d.status in ('verified', 'active') or p_txt_ok then
      case when p_dns_status = 'ok' and d.provisioning = 'manual_done' and p_https_status = 'active' then 'active' else 'verified' end
    else 'pending_verification' end;
  update public.custom_domains set
    status = v_status,
    verified_at = case when v_status in ('verified', 'active') and verified_at is null then now() else verified_at end,
    activated_at = case when v_status = 'active' and activated_at is null then now() else activated_at end,
    dns_status = p_dns_status, https_status = p_https_status, last_checked_at = now(), last_error = left(p_error, 200)
  where id = p_domain;
  if v_status is distinct from d.status then
    insert into public.admin_audit_logs (actor_role, action, target_type, target_id, metadata)
    values ('system', 'domain.status_changed', 'domain', p_domain::text, jsonb_build_object('hostname', d.hostname, 'from', d.status, 'to', v_status));
  end if;
  return jsonb_build_object('status', v_status, 'dns_status', p_dns_status, 'https_status', p_https_status);
end $$;

-- Risoluzione del tenant dall'hostname della richiesta (lato server). Solo domini ATTIVI di
-- rivenditori attivi: un dominio non verificato o non configurato non applica alcun branding.
create or replace function public.tenant_by_hostname(p_hostname text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_host text := lower(rtrim(btrim(coalesce(p_hostname, '')), '.'));
  d public.custom_domains;
  b public.reseller_branding;
begin
  select * into d from public.custom_domains where hostname = v_host and deleted_at is null and status = 'active';
  if d.id is null then return null; end if;
  if not (private.reseller_access(d.reseller_id) ->> 'has_access')::boolean
     or not private.flag_enabled('custom_domain', null, d.reseller_id) then
    return null;
  end if;
  select * into b from public.reseller_branding where reseller_id = d.reseller_id;
  return jsonb_build_object('reseller_id', d.reseller_id, 'hostname', d.hostname,
    'branding', case when private.flag_enabled('custom_branding', null, d.reseller_id) then to_jsonb(b) - 'updated_by' - 'updated_at' - 'reseller_id' end);
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 13. Stripe: abbonamenti White Label (stesso webhook, customer del rivenditore)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_link_reseller_customer(p_reseller uuid, p_customer text, p_livemode boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v text;
begin
  update public.resellers set stripe_customer_id = p_customer, stripe_customer_livemode = p_livemode
   where id = p_reseller and stripe_customer_id is null;
  select stripe_customer_id into v from public.resellers where id = p_reseller;
  return v;
end $$;

create or replace function public.billing_apply_reseller_subscription(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reseller uuid := (p ->> 'reseller_id')::uuid;
  v_sub text := p ->> 'stripe_subscription_id';
  v_synced timestamptz := coalesce((p ->> 'stripe_synced_at')::timestamptz, now());
  v_old public.reseller_subscriptions;
  cur public.reseller_subscriptions;
  v_plan text := nullif(p ->> 'plan_code', '');
  ro record;
begin
  if not exists (select 1 from public.resellers where id = v_reseller and stripe_customer_id = p ->> 'stripe_customer_id') then
    raise exception 'customer_reseller_mismatch' using errcode = '42501';
  end if;
  if v_plan is not null and not exists (select 1 from public.reseller_plans where code = v_plan) then raise exception 'unknown_plan' using errcode = '22023'; end if;
  select * into v_old from public.reseller_subscriptions where stripe_subscription_id = v_sub for update;
  if v_old.id is not null and v_old.reseller_id <> v_reseller then raise exception 'subscription_reseller_mismatch' using errcode = '42501'; end if;
  if v_old.id is not null and v_old.stripe_synced_at > v_synced then return jsonb_build_object('applied', false, 'reason', 'stale_state'); end if;
  insert into public.reseller_subscriptions as s (reseller_id, source, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_code, status,
    unit_amount_cents, currency, billing_interval, interval_count, current_period_start, current_period_end, cancel_at_period_end,
    canceled_at, ended_at, started_at, livemode, stripe_synced_at)
  values (v_reseller, 'stripe', v_sub, p ->> 'stripe_customer_id', p ->> 'stripe_price_id', v_plan, (p ->> 'status')::public.subscription_status,
    (p ->> 'unit_amount_cents')::int, p ->> 'currency', p ->> 'billing_interval', (p ->> 'interval_count')::int,
    (p ->> 'current_period_start')::timestamptz, (p ->> 'current_period_end')::timestamptz, coalesce((p ->> 'cancel_at_period_end')::boolean, false),
    (p ->> 'canceled_at')::timestamptz, (p ->> 'ended_at')::timestamptz, (p ->> 'started_at')::timestamptz, coalesce((p ->> 'livemode')::boolean, false), v_synced)
  on conflict (stripe_subscription_id) do update set
    stripe_price_id = excluded.stripe_price_id, plan_code = excluded.plan_code, status = excluded.status,
    unit_amount_cents = excluded.unit_amount_cents, currency = excluded.currency, billing_interval = excluded.billing_interval,
    interval_count = excluded.interval_count, current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end, canceled_at = excluded.canceled_at, ended_at = excluded.ended_at,
    started_at = excluded.started_at, livemode = excluded.livemode, stripe_synced_at = excluded.stripe_synced_at
  returning * into cur;
  -- Il piano White Label del rivenditore segue quello pagato su Stripe.
  if v_plan is not null and cur.status in ('active', 'trialing', 'past_due') then
    update public.resellers set plan_code = v_plan where id = v_reseller and plan_code <> v_plan;
  end if;
  if v_old.id is null or (v_old.status, v_old.plan_code, v_old.cancel_at_period_end) is distinct from (cur.status, cur.plan_code, cur.cancel_at_period_end) then
    insert into public.admin_audit_logs (actor_role, action, target_type, target_id, metadata)
    values ('system', 'reseller.subscription_synced', 'reseller', v_reseller::text,
      jsonb_strip_nulls(jsonb_build_object('subscription', v_sub, 'status', cur.status, 'previous_status', v_old.status, 'plan', cur.plan_code, 'event', p ->> 'event_type')));
  end if;
  -- Abbonamento terminato: i clienti gestiti perdono l'accesso; invii e automazioni in pausa.
  if not (private.reseller_access(v_reseller) ->> 'has_access')::boolean then
    for ro in select organization_id from public.reseller_organizations where reseller_id = v_reseller and status = 'active' loop
      perform private.billing_pause_disallowed(ro.organization_id);
    end loop;
  end if;
  return jsonb_build_object('applied', true, 'status', cur.status, 'plan', cur.plan_code);
end $$;

create or replace function public.billing_upsert_reseller_invoice(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reseller uuid := (p ->> 'reseller_id')::uuid;
  v_synced timestamptz := coalesce((p ->> 'stripe_synced_at')::timestamptz, now());
  v_old public.billing_invoices;
begin
  if not exists (select 1 from public.resellers where id = v_reseller and stripe_customer_id = p ->> 'stripe_customer_id') then
    raise exception 'customer_reseller_mismatch' using errcode = '42501';
  end if;
  select * into v_old from public.billing_invoices where stripe_invoice_id = p ->> 'stripe_invoice_id' for update;
  if v_old.stripe_invoice_id is not null and v_old.reseller_id is distinct from v_reseller then raise exception 'invoice_owner_mismatch' using errcode = '42501'; end if;
  if v_old.stripe_invoice_id is not null and v_old.stripe_synced_at > v_synced then return jsonb_build_object('applied', false, 'reason', 'stale_state'); end if;
  insert into public.billing_invoices (stripe_invoice_id, reseller_id, stripe_subscription_id, number, status, billing_reason, currency,
    subtotal_cents, total_cents, total_excluding_tax_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents, attempt_count,
    period_start, period_end, hosted_invoice_url, invoice_pdf, paid_at, next_payment_attempt, livemode, stripe_created_at, stripe_synced_at)
  values (p ->> 'stripe_invoice_id', v_reseller, p ->> 'stripe_subscription_id', p ->> 'number', p ->> 'status', p ->> 'billing_reason', p ->> 'currency',
    coalesce((p ->> 'subtotal_cents')::bigint, 0), coalesce((p ->> 'total_cents')::bigint, 0), (p ->> 'total_excluding_tax_cents')::bigint,
    coalesce((p ->> 'amount_due_cents')::bigint, 0), coalesce((p ->> 'amount_paid_cents')::bigint, 0), coalesce((p ->> 'amount_remaining_cents')::bigint, 0),
    coalesce((p ->> 'attempt_count')::int, 0), (p ->> 'period_start')::timestamptz, (p ->> 'period_end')::timestamptz,
    p ->> 'hosted_invoice_url', p ->> 'invoice_pdf', (p ->> 'paid_at')::timestamptz, (p ->> 'next_payment_attempt')::timestamptz,
    coalesce((p ->> 'livemode')::boolean, false), (p ->> 'stripe_created_at')::timestamptz, v_synced)
  on conflict (stripe_invoice_id) do update set
    status = excluded.status, number = excluded.number, total_cents = excluded.total_cents, subtotal_cents = excluded.subtotal_cents,
    total_excluding_tax_cents = excluded.total_excluding_tax_cents, amount_due_cents = excluded.amount_due_cents,
    amount_paid_cents = excluded.amount_paid_cents, amount_remaining_cents = excluded.amount_remaining_cents, attempt_count = excluded.attempt_count,
    hosted_invoice_url = excluded.hosted_invoice_url, invoice_pdf = excluded.invoice_pdf, paid_at = excluded.paid_at,
    next_payment_attempt = excluded.next_payment_attempt, stripe_synced_at = excluded.stripe_synced_at, updated_at = now();
  if p ->> 'event_type' = 'invoice.payment_failed' then
    insert into public.admin_audit_logs (actor_role, action, target_type, target_id, metadata)
    values ('system', 'reseller.payment_failed', 'reseller', v_reseller::text, jsonb_build_object('invoice', p ->> 'stripe_invoice_id', 'attempt_count', (p ->> 'attempt_count')::int));
  end if;
  return jsonb_build_object('applied', true);
end $$;

-- Il rivenditore ha mai avuto un abbonamento Stripe? (la quota di attivazione si paga una volta)
create or replace function public.reseller_billing_context(p_reseller uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_reseller(p_reseller, true);
  return jsonb_build_object(
    'reseller', (select jsonb_build_object('id', id, 'name', name, 'plan_code', plan_code, 'status', status, 'stripe_customer_id', stripe_customer_id,
                   'stripe_customer_livemode', stripe_customer_livemode) from public.resellers where id = p_reseller and deleted_at is null),
    'had_stripe_subscription', exists (select 1 from public.reseller_subscriptions where reseller_id = p_reseller and source = 'stripe'),
    'current', (select jsonb_build_object('source', s.source, 'status', s.status, 'stripe_subscription_id', s.stripe_subscription_id)
                  from private.reseller_current_subscription(p_reseller) s where s.id is not null));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 14. Super admin assegnato solo dall'operatore (SQL Editor, ruolo postgres)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.set_platform_role(p_email text, p_role public.platform_role, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  update public.profiles set platform_role = p_role where id = v_user;
  insert into public.admin_audit_logs (actor_role, action, target_type, target_id, reason, metadata)
  values ('operator', 'platform_role.changed', 'user', v_user::text, p_reason, jsonb_build_object('role', p_role));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 15. Privilegi e RLS
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.admin_audit_logs, public.admin_notes, public.request_rate_limits, public.platform_settings, public.feature_flags,
  public.feature_flag_overrides, public.reseller_plans, public.resellers, public.reseller_members, public.reseller_organizations,
  public.reseller_invitations, public.reseller_subscriptions, public.reseller_branding, public.custom_domains, public.provider_cost_events from anon;
revoke insert, update, delete, truncate, references, trigger on public.admin_audit_logs, public.admin_notes, public.request_rate_limits,
  public.platform_settings, public.feature_flags, public.feature_flag_overrides, public.reseller_plans, public.resellers, public.reseller_members,
  public.reseller_organizations, public.reseller_invitations, public.reseller_subscriptions, public.reseller_branding, public.custom_domains,
  public.provider_cost_events from authenticated;
revoke truncate on public.admin_audit_logs from service_role;

alter table public.admin_audit_logs enable row level security;
alter table public.admin_notes enable row level security;
alter table public.request_rate_limits enable row level security;
alter table public.platform_settings enable row level security;
alter table public.feature_flags enable row level security;
alter table public.feature_flag_overrides enable row level security;
alter table public.reseller_plans enable row level security;
alter table public.resellers enable row level security;
alter table public.reseller_members enable row level security;
alter table public.reseller_organizations enable row level security;
alter table public.reseller_invitations enable row level security;
alter table public.reseller_subscriptions enable row level security;
alter table public.reseller_branding enable row level security;
alter table public.custom_domains enable row level security;
alter table public.provider_cost_events enable row level security;

create policy admin_audit_logs_select on public.admin_audit_logs for select to authenticated using (private.is_super_admin());
create policy admin_notes_select on public.admin_notes for select to authenticated using (private.is_super_admin());
create policy platform_settings_select on public.platform_settings for select to authenticated using (private.is_super_admin());
create policy feature_flags_select on public.feature_flags for select to authenticated using (private.is_super_admin());
create policy feature_flag_overrides_select on public.feature_flag_overrides for select to authenticated using (private.is_super_admin());
create policy provider_cost_events_select on public.provider_cost_events for select to authenticated using (private.is_super_admin());
create policy reseller_plans_select on public.reseller_plans for select to authenticated using (is_active or private.is_super_admin());
create policy resellers_select on public.resellers for select to authenticated using (private.is_super_admin() or private.is_reseller_member(id));
create policy reseller_members_select on public.reseller_members for select to authenticated
  using (private.is_super_admin() or user_id = (select auth.uid()) or private.is_reseller_member(reseller_id));
create policy reseller_organizations_select on public.reseller_organizations for select to authenticated
  using (private.is_super_admin() or private.is_reseller_member(reseller_id) or private.is_org_member(organization_id));
create policy reseller_invitations_select on public.reseller_invitations for select to authenticated
  using (private.is_super_admin() or private.is_reseller_admin(reseller_id));
create policy reseller_subscriptions_select on public.reseller_subscriptions for select to authenticated
  using (private.is_super_admin() or private.is_reseller_admin(reseller_id));
create policy reseller_branding_select on public.reseller_branding for select to authenticated
  using (private.is_super_admin() or private.is_reseller_member(reseller_id));
create policy custom_domains_select on public.custom_domains for select to authenticated
  using (private.is_super_admin() or private.is_reseller_member(reseller_id));
-- I rivenditori vedono le anagrafiche delle organizzazioni che gestiscono (non i loro dati commerciali).
create policy organizations_select_reseller on public.organizations for select to authenticated
  using (private.is_reseller_member_of_org(id));
-- Le fatture dei rivenditori sono visibili ai loro admin.
create policy billing_invoices_select_reseller on public.billing_invoices for select to authenticated
  using (reseller_id is not null and private.is_reseller_admin(reseller_id));

-- Funzioni chiamabili dagli utenti autenticati (ognuna verifica il ruolo al proprio interno).
revoke all on function public.sa_log_access(text), public.sa_overview(integer), public.sa_organizations(text, text, integer, integer),
  public.sa_organization_detail(uuid), public.sa_set_organization_status(uuid, text, text), public.sa_add_note(text, uuid, text),
  public.sa_delete_note(uuid), public.sa_set_org_ai_cap(uuid, numeric, text), public.sa_usage(timestamptz, timestamptz),
  public.sa_update_setting(text, jsonb, text), public.sa_set_feature_flag(text, boolean, text), public.sa_set_flag_override(text, text, uuid, boolean, text),
  public.sa_create_reseller(text, text, text, text, text, jsonb, integer), public.sa_update_reseller(uuid, jsonb, text),
  public.sa_set_reseller_status(uuid, text, text), public.sa_set_reseller_member(uuid, text, text, text),
  public.sa_set_reseller_external_billing(uuid, boolean, text), public.sa_resellers(), public.sa_domains(),
  public.sa_mark_domain_provisioned(uuid, boolean, text), public.reseller_my_resellers(), public.reseller_dashboard(uuid),
  public.reseller_create_invitation(uuid, text, text, text), public.reseller_revoke_invitation(uuid, uuid), public.reseller_set_client_plan(uuid, uuid, text),
  public.invitation_preview(text), public.accept_reseller_invitation(text, text, text), public.reseller_update_branding(uuid, jsonb),
  public.reseller_can_upload_branding(uuid), public.reseller_add_domain(uuid, text), public.reseller_remove_domain(uuid, uuid),
  public.reseller_domain_for_check(uuid, uuid), public.reseller_billing_context(uuid)
  from public, anon;
grant execute on function public.sa_log_access(text), public.sa_overview(integer), public.sa_organizations(text, text, integer, integer),
  public.sa_organization_detail(uuid), public.sa_set_organization_status(uuid, text, text), public.sa_add_note(text, uuid, text),
  public.sa_delete_note(uuid), public.sa_set_org_ai_cap(uuid, numeric, text), public.sa_usage(timestamptz, timestamptz),
  public.sa_update_setting(text, jsonb, text), public.sa_set_feature_flag(text, boolean, text), public.sa_set_flag_override(text, text, uuid, boolean, text),
  public.sa_create_reseller(text, text, text, text, text, jsonb, integer), public.sa_update_reseller(uuid, jsonb, text),
  public.sa_set_reseller_status(uuid, text, text), public.sa_set_reseller_member(uuid, text, text, text),
  public.sa_set_reseller_external_billing(uuid, boolean, text), public.sa_resellers(), public.sa_domains(),
  public.sa_mark_domain_provisioned(uuid, boolean, text), public.reseller_my_resellers(), public.reseller_dashboard(uuid),
  public.reseller_create_invitation(uuid, text, text, text), public.reseller_revoke_invitation(uuid, uuid), public.reseller_set_client_plan(uuid, uuid, text),
  public.invitation_preview(text), public.accept_reseller_invitation(text, text, text), public.reseller_update_branding(uuid, jsonb),
  public.reseller_can_upload_branding(uuid), public.reseller_add_domain(uuid, text), public.reseller_remove_domain(uuid, uuid),
  public.reseller_domain_for_check(uuid, uuid), public.reseller_billing_context(uuid)
  to authenticated;

-- Solo service role (Netlify Functions, dopo i controlli).
revoke all on function public.reseller_set_branding_asset(uuid, text, text, uuid), public.domain_record_check(uuid, boolean, text, text, text),
  public.tenant_by_hostname(text), public.billing_link_reseller_customer(uuid, text, boolean), public.billing_apply_reseller_subscription(jsonb),
  public.billing_upsert_reseller_invoice(jsonb) from public, anon, authenticated;
grant execute on function public.reseller_set_branding_asset(uuid, text, text, uuid), public.domain_record_check(uuid, boolean, text, text, text),
  public.tenant_by_hostname(text), public.billing_link_reseller_customer(uuid, text, boolean), public.billing_apply_reseller_subscription(jsonb),
  public.billing_upsert_reseller_invoice(jsonb), public.reseller_billing_context(uuid) to service_role;

revoke all on function private.protect_platform_role(), private.admin_audit_immutable(), private.admin_audit(text, text, text, text, text, jsonb), private.rate_limit(text, integer),
  private.require_super_admin(), private.reseller_current_subscription(uuid), private.reseller_access(uuid), private.flag_enabled(text, uuid, uuid),
  private.pause_org_operations(uuid, text), private.ai_cost_guard(), private.require_reseller(uuid, boolean), private.require_reseller_active(uuid),
  private.provider_cost_by_org(timestamptz), private.set_platform_role(text, public.platform_role, text)
  from public, anon, authenticated;
revoke all on function private.set_platform_role(text, public.platform_role, text) from service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 16. Storage per loghi e favicon (solo su Supabase: lo schema storage non esiste nei test locali)
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    -- Bucket pubblico in lettura; nessuna policy di scrittura: carica solo il server (service role)
    -- dopo la validazione di tipo, dimensioni e contenuto. SVG esclusi (rischio XSS).
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('branding', 'branding', true, 524288, array['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
