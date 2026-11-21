-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Fase 5 (Prompt 4): Stripe Billing & SaaS Monetization Engine
--
-- • billing_plans           piani commerciali (prezzo mostrato, limiti, funzionalità)
-- • ai_credit_costs         costo in crediti di ogni operazione AI (configurabile)
-- • billing_settings        impostazioni globali (enforcement, token per credito, TTL prenotazioni)
-- • stripe_customers        1 Stripe Customer per organizzazione
-- • organization_subscriptions  abbonamenti (copia dello stato letto da Stripe)
-- • billing_invoices        fatture/ricevute Stripe sincronizzate dai webhook
-- • stripe_webhook_events   idempotenza e tracciamento degli eventi Stripe
-- • usage_quotas            contatori per periodo di fatturazione (crediti AI, nuovi lead)
-- • usage_ledger            registro consumi: prenotazioni, conferme, rimborsi, lead contati
-- • billing_audit_logs      audit append-only di tutte le modifiche di billing
--
-- Principi:
-- • Stripe è la fonte autorevole dello stato di pagamento: le tabelle di abbonamento sono
--   scritte SOLO dalla service role (Netlify Functions) con dati appena letti da Stripe.
-- • Nessun client può modificare piano, crediti o contatori (niente INSERT/UPDATE/DELETE).
-- • Crediti: prenotazione atomica → conferma a operazione riuscita → rimborso in caso di errore.
--   Mai saldi negativi (vincoli CHECK + lock di riga).
-- • L'addebito dei crediti AI è legato ai job in public.ai_jobs tramite trigger: nessun percorso
--   server può creare un job AI senza aver prenotato i crediti.
--
-- Non elimina tabelle o dati. La tabella legacy public.subscriptions resta invariata.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Funzionalità riconosciute ─────────────────────────────────────────────
create or replace function private.billing_known_features()
returns text[] language sql immutable set search_path = '' as $$
  select array['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'export',
               'automations', 'advanced_analytics', 'crm_advanced', 'priority_support']::text[];
$$;

create or replace function private.billing_valid_features(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and p <@ private.billing_known_features();
$$;

-- ─── Piani ─────────────────────────────────────────────────────────────────
create table public.billing_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text check (description is null or char_length(description) <= 500),
  -- Prezzo mostrato nell'app, IVA esclusa. L'importo addebitato è quello del Price Stripe.
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'eur' check (currency ~ '^[a-z]{3}$'),
  billing_interval text not null default 'month' check (billing_interval = 'month'),
  -- Facoltativo: se NULL il server usa la variabile d'ambiente STRIPE_PRICE_<CODE>.
  stripe_price_id text unique check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]{6,}$'),
  monthly_leads integer not null check (monthly_leads >= 0),
  monthly_ai_credits integer not null check (monthly_ai_credits >= 0),
  max_users integer not null check (max_users between 1 and 1000),
  features text[] not null default '{}' check (private.billing_valid_features(features)),
  is_active boolean not null default true,
  sort_order smallint not null default 0,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger billing_plans_updated_at before update on public.billing_plans
  for each row execute function public.set_updated_at();

insert into public.billing_plans (code, name, description, price_cents, monthly_leads, monthly_ai_credits, max_users, features, sort_order) values
  ('starter', 'Starter', 'Lead Finder e CRM essenziale per un singolo utente.', 14900, 250, 500, 1,
    array['lead_finder', 'ai_analyzer', 'export'], 10),
  ('business', 'Business', 'Lead Finder, AI Sales Agent, Campaign Manager e CRM avanzato per team.', 34900, 1000, 2500, 5,
    array['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'export'], 20),
  ('enterprise', 'Enterprise', 'Tutti i moduli, analytics avanzate, automazioni e supporto prioritario.', 79900, 5000, 10000, 20,
    array['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'campaign_manager', 'crm_advanced', 'export',
          'automations', 'advanced_analytics', 'priority_support'], 30);

-- ─── Costi in crediti delle operazioni AI ──────────────────────────────────
-- DEFINIZIONE DI CREDITO AI: 1 credito = un'operazione AI unitaria completata con successo,
-- con un budget massimo di billing_settings.tokens_per_credit token (input + output) per credito.
-- Un'operazione costa `credits` crediti; se consuma più di credits × tokens_per_credit token,
-- la differenza viene addebitata in crediti aggiuntivi (entro il saldo disponibile).
-- Le operazioni fallite non consumano crediti. I valori iniziali sono PROVVISORI e vanno
-- validati rispetto ai costi reali del modello (vedi Revenue Analytics → costo API stimato).
create table public.ai_credit_costs (
  operation text primary key check (operation ~ '^[a-z][a-z0-9_]{2,40}$'),
  ai_task text unique check (ai_task is null or ai_task in
    ('business_analysis', 'intelligence', 'messages', 'proposal', 'follow_up_suggestion', 'copilot', 'campaign_content', 'inbound_analysis')),
  credits integer not null check (credits between 0 and 100),
  feature text not null check (feature = any (private.billing_known_features())),
  description text not null check (char_length(description) <= 300),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger ai_credit_costs_updated_at before update on public.ai_credit_costs
  for each row execute function public.set_updated_at();

insert into public.ai_credit_costs (operation, ai_task, credits, feature, description) values
  ('lead_analysis', 'business_analysis', 1, 'ai_analyzer', 'Analisi AI di un lead (sito web + profilo commerciale)'),
  ('email_generation', 'messages', 1, 'ai_sales_agent', 'Generazione messaggi commerciali per un lead'),
  ('proposal', 'proposal', 3, 'ai_sales_agent', 'Proposta commerciale completa'),
  ('deep_analysis', 'intelligence', 5, 'ai_sales_agent', 'Analisi approfondita (sales intelligence) di un lead'),
  ('follow_up_suggestion', 'follow_up_suggestion', 1, 'ai_sales_agent', 'Suggerimento di follow-up'),
  ('copilot_message', 'copilot', 1, 'ai_sales_agent', 'Risposta del Sales Copilot'),
  ('campaign_content', 'campaign_content', 2, 'campaign_manager', 'Tre varianti AI di uno step di campagna'),
  ('inbound_analysis', 'inbound_analysis', 1, 'campaign_manager', 'Analisi AI di una risposta ricevuta');

-- ─── Impostazioni globali (singola riga) ───────────────────────────────────
create table public.billing_settings (
  id boolean primary key default true check (id),
  -- Se false i limiti di piano non vengono applicati (rollout graduale, test di moduli non di billing).
  enforcement_enabled boolean not null default true,
  tokens_per_credit integer not null default 6000 check (tokens_per_credit between 500 and 200000),
  reservation_ttl_minutes integer not null default 60 check (reservation_ttl_minutes between 5 and 1440),
  -- Durante i tentativi di incasso di Stripe (past_due) l'accesso resta attivo.
  past_due_grace boolean not null default true,
  -- Costo stimato per richiesta dei provider di dati, in USD (es. {"google_places": 0.032}).
  provider_cost_usd jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_cost_usd) = 'object'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (true);
create trigger billing_settings_updated_at before update on public.billing_settings
  for each row execute function public.set_updated_at();

-- ─── Stripe Customer ───────────────────────────────────────────────────────
create table public.stripe_customers (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,}$'),
  livemode boolean not null default false,
  created_at timestamptz not null default now()
);

-- ─── Abbonamenti ───────────────────────────────────────────────────────────
create table public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- 'manual': piano concesso dall'operatore via SQL (pilot, uso interno). Mai dall'utente.
  source text not null default 'stripe' check (source in ('stripe', 'manual')),
  stripe_subscription_id text unique check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,}$'),
  stripe_customer_id text check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,}$'),
  stripe_price_id text,
  plan_code text references public.billing_plans (code) on update cascade,
  status public.subscription_status not null,
  unit_amount_cents integer check (unit_amount_cents is null or unit_amount_cents >= 0),
  currency text check (currency is null or currency ~ '^[a-z]{3}$'),
  billing_interval text check (billing_interval is null or billing_interval in ('day', 'week', 'month', 'year')),
  interval_count integer check (interval_count is null or interval_count >= 1),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  canceled_at timestamptz,
  ended_at timestamptz,
  started_at timestamptz,
  trial_end timestamptz,
  livemode boolean not null default false,
  -- Momento in cui lo stato è stato letto da Stripe: protegge dagli eventi fuori ordine.
  stripe_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'stripe') = (stripe_subscription_id is not null)),
  check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);
create index organization_subscriptions_org_idx on public.organization_subscriptions (organization_id, created_at desc);
create trigger organization_subscriptions_updated_at before update on public.organization_subscriptions
  for each row execute function public.set_updated_at();
create trigger organization_subscriptions_org_immutable before update on public.organization_subscriptions
  for each row execute function public.prevent_org_change();

-- ─── Fatture / ricevute Stripe ─────────────────────────────────────────────
create table public.billing_invoices (
  stripe_invoice_id text primary key check (stripe_invoice_id ~ '^in_[A-Za-z0-9]{6,}$'),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  stripe_subscription_id text,
  number text,
  status text not null check (status in ('draft', 'open', 'paid', 'uncollectible', 'void')),
  billing_reason text,
  currency text not null check (currency ~ '^[a-z]{3}$'),
  subtotal_cents bigint not null default 0,
  total_cents bigint not null default 0,
  total_excluding_tax_cents bigint,
  amount_due_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  amount_remaining_cents bigint not null default 0,
  attempt_count integer not null default 0,
  period_start timestamptz,
  period_end timestamptz,
  hosted_invoice_url text check (hosted_invoice_url is null or hosted_invoice_url ~ '^https://'),
  invoice_pdf text check (invoice_pdf is null or invoice_pdf ~ '^https://'),
  paid_at timestamptz,
  next_payment_attempt timestamptz,
  livemode boolean not null default false,
  stripe_created_at timestamptz,
  stripe_synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_invoices_org_idx on public.billing_invoices (organization_id, stripe_created_at desc);
create index billing_invoices_paid_idx on public.billing_invoices (paid_at) where status = 'paid';

-- ─── Eventi webhook (idempotenza) ──────────────────────────────────────────
-- Non conserva il payload: solo identificativi, tipo e stato di elaborazione.
create table public.stripe_webhook_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]{6,}$'),
  event_type text not null check (char_length(event_type) between 3 and 100),
  livemode boolean not null,
  stripe_created_at timestamptz,
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed', 'ignored')),
  attempts integer not null default 1 check (attempts >= 1),
  locked_until timestamptz,
  object_id text check (object_id is null or char_length(object_id) <= 100),
  organization_id uuid references public.organizations (id) on delete set null,
  last_error text check (last_error is null or char_length(last_error) <= 200),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index stripe_webhook_events_status_idx on public.stripe_webhook_events (status, received_at desc);

-- ─── Quote per periodo di fatturazione ─────────────────────────────────────
create table public.usage_quotas (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  plan_code text references public.billing_plans (code) on update cascade,
  ai_credits_limit integer not null default 0 check (ai_credits_limit >= 0),
  ai_credits_used integer not null default 0 check (ai_credits_used >= 0),
  ai_credits_reserved integer not null default 0 check (ai_credits_reserved >= 0),
  leads_limit integer not null default 0 check (leads_limit >= 0),
  leads_used integer not null default 0 check (leads_used >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, period_start),
  check (period_end > period_start)
);
create trigger usage_quotas_updated_at before update on public.usage_quotas
  for each row execute function public.set_updated_at();

-- ─── Registro consumi ──────────────────────────────────────────────────────
create table public.usage_ledger (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  period_start timestamptz,
  kind text not null check (kind in ('ai_credits', 'leads', 'provider_call')),
  operation text not null check (char_length(operation) between 2 and 60),
  status text not null check (status in ('reserved', 'committed', 'released', 'counted', 'recorded')),
  quantity integer not null check (quantity >= 0),
  idempotency_key text not null check (char_length(idempotency_key) between 4 and 200),
  ai_job_id uuid,
  user_id uuid references auth.users (id) on delete set null,
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (organization_id, idempotency_key)
);
create index usage_ledger_org_time_idx on public.usage_ledger (organization_id, created_at desc);
create index usage_ledger_reserved_idx on public.usage_ledger (organization_id, created_at) where status = 'reserved';

-- ─── Audit di billing (append-only) ────────────────────────────────────────
create table public.billing_audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete set null,
  actor_type text not null check (actor_type in ('user', 'stripe', 'system', 'operator')),
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (char_length(action) between 3 and 80),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index billing_audit_logs_org_idx on public.billing_audit_logs (organization_id, created_at desc);

create or replace function private.billing_audit_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Consentito solo l'azzeramento dei riferimenti (ON DELETE SET NULL).
  if tg_op = 'UPDATE' and (new.id, new.actor_type, new.action, new.metadata, new.created_at)
                         is not distinct from (old.id, old.actor_type, old.action, old.metadata, old.created_at) then
    return new;
  end if;
  raise exception 'billing_audit_logs is append-only' using errcode = '42501';
end $$;
create trigger billing_audit_logs_immutable before update or delete on public.billing_audit_logs
  for each row execute function private.billing_audit_immutable();

create or replace function private.billing_audit(p_org uuid, p_actor_type text, p_actor uuid, p_action text, p_metadata jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.billing_audit_logs (organization_id, actor_type, actor_id, action, metadata)
  values (p_org, p_actor_type, p_actor, p_action, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Entitlement: piano corrente, accesso e funzionalità
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.billing_settings_row()
returns public.billing_settings language sql stable security definer set search_path = '' as $$
  select * from public.billing_settings where id;
$$;

create or replace function private.subscription_status_grants_access(p_status public.subscription_status)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_status in ('active', 'trialing')
      or (p_status = 'past_due' and coalesce((select past_due_grace from public.billing_settings where id), true));
$$;

-- Abbonamento "corrente": prima quelli che danno accesso, poi il più recente.
create or replace function private.current_subscription(p_org uuid)
returns public.organization_subscriptions language sql stable security definer set search_path = '' as $$
  select s.* from public.organization_subscriptions s
   where s.organization_id = p_org
   order by (s.status in ('active', 'trialing', 'past_due')) desc,
            s.current_period_end desc nulls last, s.created_at desc
   limit 1;
$$;

create or replace function private.org_entitlements(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.organization_subscriptions;
  p public.billing_plans;
  v_enforced boolean := coalesce((select enforcement_enabled from public.billing_settings where id), true);
  v_access boolean;
  v_start timestamptz;
  v_end timestamptz;
begin
  s := private.current_subscription(p_org);
  if s.id is not null and s.plan_code is not null then
    select * into p from public.billing_plans where code = s.plan_code;
  end if;
  v_access := s.id is not null and p.code is not null and private.subscription_status_grants_access(s.status);
  if s.id is not null then
    if s.source = 'manual' or s.current_period_start is null or s.current_period_end is null
       or now() >= s.current_period_end then
      -- Piani manuali (o periodo non ancora noto): mese di calendario UTC.
      v_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
      v_end := v_start + interval '1 month';
    else
      v_start := s.current_period_start;
      v_end := s.current_period_end;
    end if;
  end if;
  return jsonb_build_object(
    'enforced', v_enforced,
    'has_access', v_access,
    'subscription_id', s.id,
    'source', s.source,
    'status', s.status,
    'plan_code', p.code,
    'features', case when v_access then to_jsonb(p.features) else '[]'::jsonb end,
    'max_users', case when v_access then p.max_users else 1 end,
    'monthly_leads', case when v_access then p.monthly_leads else 0 end,
    'monthly_ai_credits', case when v_access then p.monthly_ai_credits else 0 end,
    'period_start', v_start,
    'period_end', v_end
  );
end $$;

-- Esito strutturato: allowed + reason ('billing_not_enforced', 'ok', 'no_subscription',
-- 'subscription_inactive', 'feature_not_in_plan', 'unknown_feature').
create or replace function private.feature_check(p_org uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e jsonb;
begin
  if not (p_feature = any (private.billing_known_features())) then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_feature');
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

-- canUseFeature lato database: membri dell'org (RLS-like) e service role.
create or replace function public.billing_can_use_feature(p_org uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.feature_check(p_org, p_feature);
end $$;

-- Solleva un errore leggibile dalle functions: messaggio "billing_<reason>".
create or replace function private.require_feature(p_org uuid, p_feature text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb := private.feature_check(p_org, p_feature);
begin
  if not (r ->> 'allowed')::boolean then
    raise exception 'billing_%', r ->> 'reason' using errcode = 'P0001', detail = r::text;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Periodo corrente e contatori
-- ════════════════════════════════════════════════════════════════════════════
-- Restituisce (e blocca FOR UPDATE) la riga quote del periodo corrente, aggiornando i limiti
-- al piano attuale (upgrade/downgrade nel periodo: i consumi restano, cambia il limite).
create or replace function private.lock_quota_period(p_org uuid)
returns public.usage_quotas language plpgsql security definer set search_path = '' as $$
declare
  e jsonb := private.org_entitlements(p_org);
  q public.usage_quotas;
begin
  if e ->> 'period_start' is null then
    return null;
  end if;
  insert into public.usage_quotas (organization_id, period_start, period_end, plan_code, ai_credits_limit, leads_limit)
  values (p_org, (e ->> 'period_start')::timestamptz, (e ->> 'period_end')::timestamptz, e ->> 'plan_code',
          (e ->> 'monthly_ai_credits')::int, (e ->> 'monthly_leads')::int)
  on conflict (organization_id, period_start) do update
     set period_end = excluded.period_end,
         plan_code = excluded.plan_code,
         ai_credits_limit = excluded.ai_credits_limit,
         leads_limit = excluded.leads_limit
   where (usage_quotas.period_end, usage_quotas.plan_code, usage_quotas.ai_credits_limit, usage_quotas.leads_limit)
         is distinct from (excluded.period_end, excluded.plan_code, excluded.ai_credits_limit, excluded.leads_limit);
  select * into q from public.usage_quotas
   where organization_id = p_org and period_start = (e ->> 'period_start')::timestamptz
   for update;
  return q;
end $$;

-- Rimborsa le prenotazioni scadute (job mai terminati) dell'organizzazione.
create or replace function private.release_stale_reservations(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_ttl int := coalesce((select reservation_ttl_minutes from public.billing_settings where id), 60);
  r record;
  n int := 0;
begin
  for r in
    select id, period_start, quantity from public.usage_ledger
     where organization_id = p_org and kind = 'ai_credits' and status = 'reserved'
       and created_at < now() - make_interval(mins => v_ttl)
     for update skip locked
  loop
    update public.usage_ledger set status = 'released', settled_at = now(),
           metadata = metadata || jsonb_build_object('release_reason', 'reservation_expired')
     where id = r.id;
    update public.usage_quotas set ai_credits_reserved = greatest(ai_credits_reserved - r.quantity, 0)
     where organization_id = p_org and period_start = r.period_start;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Motore crediti AI
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_reserve_credits(
  p_org uuid, p_user uuid, p_operation text, p_idempotency_key text,
  p_ai_job uuid default null, p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.ai_credit_costs;
  f jsonb;
  q public.usage_quotas;
  l public.usage_ledger;
  v_remaining int;
begin
  select * into c from public.ai_credit_costs where operation = p_operation;
  if c.operation is null then raise exception 'unknown_operation' using errcode = '22023'; end if;
  if not coalesce((select enforcement_enabled from public.billing_settings where id), true) then
    return jsonb_build_object('allowed', true, 'enforced', false, 'credits', c.credits);
  end if;

  f := private.feature_check(p_org, c.feature);
  if not (f ->> 'allowed')::boolean then
    return jsonb_build_object('allowed', false, 'enforced', true, 'reason', f ->> 'reason', 'feature', c.feature);
  end if;

  -- Il lock della riga quote serializza prenotazioni concorrenti della stessa organizzazione.
  q := private.lock_quota_period(p_org);
  perform private.release_stale_reservations(p_org);
  select * into q from public.usage_quotas where organization_id = q.organization_id and period_start = q.period_start;

  -- Idempotenza: la stessa chiave restituisce sempre lo stesso esito.
  select * into l from public.usage_ledger where organization_id = p_org and idempotency_key = p_idempotency_key;
  if l.id is not null then
    return jsonb_build_object('allowed', l.status in ('reserved', 'committed'), 'enforced', true, 'idempotent', true,
      'status', l.status, 'credits', l.quantity, 'reason', case when l.status = 'released' then 'already_released' end);
  end if;

  v_remaining := q.ai_credits_limit - q.ai_credits_used - q.ai_credits_reserved;
  if c.credits > v_remaining then
    return jsonb_build_object('allowed', false, 'enforced', true, 'reason', 'insufficient_credits',
      'credits', c.credits, 'remaining', greatest(v_remaining, 0), 'limit', q.ai_credits_limit);
  end if;

  insert into public.usage_ledger (organization_id, period_start, kind, operation, status, quantity, idempotency_key, ai_job_id, user_id, metadata)
  values (p_org, q.period_start, 'ai_credits', p_operation, 'reserved', c.credits, p_idempotency_key, p_ai_job, p_user, coalesce(p_metadata, '{}'::jsonb));
  update public.usage_quotas set ai_credits_reserved = ai_credits_reserved + c.credits
   where organization_id = p_org and period_start = q.period_start;

  return jsonb_build_object('allowed', true, 'enforced', true, 'credits', c.credits,
    'remaining', v_remaining - c.credits, 'limit', q.ai_credits_limit, 'period_start', q.period_start);
end $$;

-- Conferma il consumo a operazione riuscita. p_tokens (facoltativo) applica il budget token per credito.
create or replace function public.billing_commit_credits(p_org uuid, p_idempotency_key text, p_tokens bigint default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l public.usage_ledger;
  q public.usage_quotas;
  v_tpc int := coalesce((select tokens_per_credit from public.billing_settings where id), 6000);
  v_needed int;
  v_extra int := 0;
  v_charged_extra int := 0;
  v_available int;
begin
  select * into l from public.usage_ledger
   where organization_id = p_org and idempotency_key = p_idempotency_key and kind = 'ai_credits' for update;
  if l.id is null then
    return jsonb_build_object('committed', false, 'reason', 'reservation_not_found');
  end if;
  if l.status = 'committed' then
    return jsonb_build_object('committed', true, 'idempotent', true, 'credits', l.quantity);
  end if;
  if l.status <> 'reserved' then
    -- Prenotazione già rimborsata (scaduta o errore): nessun addebito a posteriori.
    return jsonb_build_object('committed', false, 'reason', 'reservation_' || l.status);
  end if;

  select * into q from public.usage_quotas where organization_id = p_org and period_start = l.period_start for update;
  if p_tokens is not null and p_tokens > 0 then
    v_needed := ceil(p_tokens::numeric / v_tpc)::int;
    v_extra := greatest(v_needed - l.quantity, 0);
    v_available := q.ai_credits_limit - q.ai_credits_used - q.ai_credits_reserved;
    v_charged_extra := least(v_extra, greatest(v_available, 0));
  end if;

  update public.usage_quotas
     set ai_credits_used = ai_credits_used + l.quantity + v_charged_extra,
         ai_credits_reserved = greatest(ai_credits_reserved - l.quantity, 0)
   where organization_id = p_org and period_start = l.period_start;
  update public.usage_ledger
     set status = 'committed', settled_at = now(), quantity = l.quantity + v_charged_extra,
         metadata = metadata || jsonb_strip_nulls(jsonb_build_object('tokens', p_tokens, 'reserved_credits', l.quantity,
                    'extra_credits', nullif(v_charged_extra, 0), 'extra_uncharged', nullif(v_extra - v_charged_extra, 0)))
   where id = l.id;
  return jsonb_build_object('committed', true, 'credits', l.quantity + v_charged_extra, 'extra_credits', v_charged_extra);
end $$;

create or replace function public.billing_release_credits(p_org uuid, p_idempotency_key text, p_reason text default 'operation_failed')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l public.usage_ledger;
begin
  select * into l from public.usage_ledger
   where organization_id = p_org and idempotency_key = p_idempotency_key and kind = 'ai_credits' for update;
  if l.id is null then return jsonb_build_object('released', false, 'reason', 'reservation_not_found'); end if;
  if l.status = 'released' then return jsonb_build_object('released', true, 'idempotent', true); end if;
  if l.status <> 'reserved' then return jsonb_build_object('released', false, 'reason', 'already_' || l.status); end if;
  perform 1 from public.usage_quotas where organization_id = p_org and period_start = l.period_start for update;
  update public.usage_quotas set ai_credits_reserved = greatest(ai_credits_reserved - l.quantity, 0)
   where organization_id = p_org and period_start = l.period_start;
  update public.usage_ledger
     set status = 'released', settled_at = now(),
         metadata = metadata || jsonb_build_object('release_reason', left(coalesce(p_reason, 'operation_failed'), 60))
   where id = l.id;
  return jsonb_build_object('released', true, 'credits', l.quantity);
end $$;

-- ─── Collegamento con i job AI: nessun job senza prenotazione ──────────────
create or replace function private.ai_jobs_billing_reserve()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_op text;
  r jsonb;
begin
  if new.task is null then return new; end if;
  select operation into v_op from public.ai_credit_costs where ai_task = new.task;
  if v_op is null then return new; end if;
  r := public.billing_reserve_credits(new.organization_id, new.created_by, v_op, 'ai_job:' || new.id::text, new.id,
         jsonb_build_object('task', new.task));
  if not (r ->> 'allowed')::boolean then
    raise exception 'billing_%', r ->> 'reason' using errcode = 'P0001', detail = r::text;
  end if;
  return new;
end $$;
create trigger ai_jobs_billing_reserve before insert on public.ai_jobs
  for each row execute function private.ai_jobs_billing_reserve();

create or replace function private.ai_jobs_billing_settle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = old.status then return new; end if;
  if new.status = 'succeeded' then
    perform public.billing_commit_credits(new.organization_id, 'ai_job:' || new.id::text,
      coalesce(new.tokens_input, 0)::bigint + coalesce(new.tokens_output, 0)::bigint);
  elsif new.status in ('failed', 'cancelled') then
    perform public.billing_release_credits(new.organization_id, 'ai_job:' || new.id::text, 'job_' || new.status::text);
  end if;
  return new;
end $$;
create trigger ai_jobs_billing_settle after update of status on public.ai_jobs
  for each row execute function private.ai_jobs_billing_settle();

-- ════════════════════════════════════════════════════════════════════════════
-- Quote nuovi lead (deduplicate per riferimento stabile)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_lead_quota(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f jsonb;
  q public.usage_quotas;
begin
  if not coalesce((select enforcement_enabled from public.billing_settings where id), true) then
    return jsonb_build_object('allowed', true, 'enforced', false);
  end if;
  f := private.feature_check(p_org, 'lead_finder');
  if not (f ->> 'allowed')::boolean then
    return jsonb_build_object('allowed', false, 'enforced', true, 'reason', f ->> 'reason', 'remaining', 0);
  end if;
  q := private.lock_quota_period(p_org);
  return jsonb_build_object('allowed', q.leads_used < q.leads_limit, 'enforced', true,
    'reason', case when q.leads_used >= q.leads_limit then 'lead_quota_exceeded' end,
    'used', q.leads_used, 'limit', q.leads_limit, 'remaining', greatest(q.leads_limit - q.leads_used, 0),
    'period_end', q.period_end);
end $$;

-- Conta i nuovi lead acquisiti. Ogni riferimento (es. candidate id) è contato UNA sola volta
-- per organizzazione; quelli oltre quota sono restituiti in over_quota_refs.
create or replace function public.billing_count_new_leads(p_org uuid, p_user uuid, p_refs text[], p_metadata jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q public.usage_quotas;
  v_ref text;
  v_counted int := 0;
  v_already int := 0;
  v_over text[] := '{}';
begin
  if not coalesce((select enforcement_enabled from public.billing_settings where id), true) then
    return jsonb_build_object('enforced', false, 'counted', 0, 'already_counted', 0, 'over_quota_refs', '[]'::jsonb);
  end if;
  if coalesce(array_length(p_refs, 1), 0) > 5000 then raise exception 'too_many_refs' using errcode = '22023'; end if;
  q := private.lock_quota_period(p_org);
  if q.organization_id is null then
    return jsonb_build_object('enforced', true, 'counted', 0, 'already_counted', 0,
      'over_quota_refs', to_jsonb(coalesce(p_refs, '{}')), 'reason', 'no_subscription');
  end if;
  for v_ref in select distinct x from unnest(coalesce(p_refs, '{}')) as x where x is not null and char_length(x) between 1 and 180 loop
    if exists (select 1 from public.usage_ledger where organization_id = p_org and idempotency_key = 'lead:' || v_ref) then
      v_already := v_already + 1;
    elsif q.leads_used + v_counted < q.leads_limit then
      insert into public.usage_ledger (organization_id, period_start, kind, operation, status, quantity, idempotency_key, user_id, metadata)
      values (p_org, q.period_start, 'leads', 'new_lead', 'counted', 1, 'lead:' || v_ref, p_user, coalesce(p_metadata, '{}'::jsonb));
      v_counted := v_counted + 1;
    else
      v_over := v_over || v_ref;
    end if;
  end loop;
  if v_counted > 0 then
    update public.usage_quotas set leads_used = leads_used + v_counted
     where organization_id = p_org and period_start = q.period_start;
  end if;
  return jsonb_build_object('enforced', true, 'counted', v_counted, 'already_counted', v_already,
    'over_quota_refs', to_jsonb(v_over), 'used', q.leads_used + v_counted, 'limit', q.leads_limit,
    'remaining', greatest(q.leads_limit - q.leads_used - v_counted, 0));
end $$;

-- Costi dei provider di dati (stimati): una riga per chiamata, idempotente.
create or replace function public.billing_record_provider_call(p_org uuid, p_user uuid, p_provider text, p_idempotency_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cost numeric := nullif((select provider_cost_usd ->> p_provider from public.billing_settings where id), '')::numeric;
begin
  insert into public.usage_ledger (organization_id, kind, operation, status, quantity, idempotency_key, user_id, cost_usd)
  values (p_org, 'provider_call', left(p_provider, 60), 'recorded', 1, p_idempotency_key, p_user, v_cost)
  on conflict (organization_id, idempotency_key) do nothing;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Limite utenti e funzionalità controllate dal database
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.members_billing_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  v_count int;
begin
  if not coalesce((select enforcement_enabled from public.billing_settings where id), true) then return new; end if;
  e := private.org_entitlements(new.organization_id);
  perform pg_advisory_xact_lock(hashtextextended('members:' || new.organization_id::text, 0));
  select count(*) into v_count from public.organization_members where organization_id = new.organization_id;
  if v_count >= (e ->> 'max_users')::int then
    raise exception 'billing_user_limit_reached' using errcode = 'P0001',
      detail = jsonb_build_object('limit', (e ->> 'max_users')::int, 'plan_code', e ->> 'plan_code')::text;
  end if;
  return new;
end $$;
create trigger organization_members_billing_limit before insert on public.organization_members
  for each row execute function private.members_billing_limit();

create or replace function private.campaigns_billing_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('scheduled', 'running') and old.status is distinct from new.status then
    perform private.require_feature(new.organization_id, 'campaign_manager');
  end if;
  return new;
end $$;
create trigger campaigns_zbilling_guard before update of status on public.campaigns
  for each row execute function private.campaigns_billing_guard();

create or replace function private.workflows_billing_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'running' and (tg_op = 'INSERT' or old.status is distinct from 'running') then
    perform private.require_feature(new.organization_id, 'automations');
  end if;
  return new;
end $$;
create trigger automation_workflows_zbilling_guard before insert or update on public.automation_workflows
  for each row execute function private.workflows_billing_guard();

-- Quando l'accesso o una funzionalità vengono meno, si fermano gli invii in corso.
create or replace function private.billing_pause_disallowed(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_campaigns int := 0;
  v_workflows int := 0;
begin
  if not coalesce((select enforcement_enabled from public.billing_settings where id), true) then
    return jsonb_build_object('campaigns', 0, 'workflows', 0);
  end if;
  if not (private.feature_check(p_org, 'campaign_manager') ->> 'allowed')::boolean then
    perform set_config('leadflow.campaign_transition', 'on', true);
    update public.campaigns set status = 'paused', paused_reason = 'billing_inactive'
     where organization_id = p_org and status in ('scheduled', 'running');
    get diagnostics v_campaigns = row_count;
    perform set_config('leadflow.campaign_transition', '', true);
  end if;
  if not (private.feature_check(p_org, 'automations') ->> 'allowed')::boolean then
    update public.automation_workflows set status = 'paused' where organization_id = p_org and status = 'running';
    get diagnostics v_workflows = row_count;
  end if;
  return jsonb_build_object('campaigns', v_campaigns, 'workflows', v_workflows);
end $$;

-- Allinea i limiti tecnici esistenti (organization_quotas, mese di calendario) al piano.
create or replace function private.billing_sync_technical_quotas(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  e jsonb := private.org_entitlements(p_org);
begin
  if not (e ->> 'has_access')::boolean then return; end if;
  update public.organization_quotas
     set plan = e ->> 'plan_code',
         monthly_results = greatest(monthly_results, (e ->> 'monthly_leads')::int),
         monthly_ai_analyses = greatest(monthly_ai_analyses, (e ->> 'monthly_ai_credits')::int),
         monthly_ai_generations = greatest(monthly_ai_generations, (e ->> 'monthly_ai_credits')::int),
         monthly_ai_tokens = greatest(monthly_ai_tokens, (e ->> 'monthly_ai_credits')::bigint * 8000)
   where organization_id = p_org;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Stripe: clienti, abbonamenti, fatture, webhook (solo service role)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_link_customer(p_org uuid, p_customer text, p_livemode boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_existing text;
begin
  insert into public.stripe_customers (organization_id, stripe_customer_id, livemode)
  values (p_org, p_customer, coalesce(p_livemode, false))
  on conflict (organization_id) do nothing;
  select stripe_customer_id into v_existing from public.stripe_customers where organization_id = p_org;
  if v_existing = p_customer then
    perform private.billing_audit(p_org, 'system', null, 'stripe.customer_linked', jsonb_build_object('customer', p_customer));
  end if;
  return v_existing;
end $$;

create or replace function public.billing_claim_webhook_event(p_event_id text, p_type text, p_livemode boolean, p_created timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  e public.stripe_webhook_events;
begin
  insert into public.stripe_webhook_events (event_id, event_type, livemode, stripe_created_at, status, locked_until)
  values (p_event_id, p_type, p_livemode, p_created, 'processing', now() + interval '2 minutes')
  on conflict (event_id) do nothing;
  if found then return 'claimed'; end if;

  select * into e from public.stripe_webhook_events where event_id = p_event_id for update;
  if e.status in ('processed', 'ignored') then return 'duplicate'; end if;
  if e.status = 'processing' and e.locked_until > now() then return 'in_progress'; end if;
  -- Elaborazione precedente fallita o interrotta: nuovo tentativo sicuro (le scritture sono idempotenti).
  update public.stripe_webhook_events
     set status = 'processing', attempts = attempts + 1, locked_until = now() + interval '2 minutes', last_error = null
   where event_id = p_event_id;
  return 'claimed';
end $$;

create or replace function public.billing_finish_webhook_event(p_event_id text, p_status text, p_error text default null,
  p_org uuid default null, p_object_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('processed', 'failed', 'ignored') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.stripe_webhook_events
     set status = p_status, last_error = left(p_error, 200), locked_until = null,
         organization_id = coalesce(p_org, organization_id), object_id = coalesce(left(p_object_id, 100), object_id),
         processed_at = case when p_status <> 'failed' then now() end
   where event_id = p_event_id;
end $$;

-- Applica lo stato di un abbonamento appena letto da Stripe. Gli aggiornamenti con
-- stripe_synced_at più vecchio di quello salvato vengono ignorati (eventi fuori ordine).
create or replace function public.billing_apply_subscription(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid;
  v_sub text := p ->> 'stripe_subscription_id';
  v_customer text := p ->> 'stripe_customer_id';
  v_synced timestamptz := coalesce((p ->> 'stripe_synced_at')::timestamptz, now());
  v_old public.organization_subscriptions;
  cur public.organization_subscriptions;
  v_plan text := nullif(p ->> 'plan_code', '');
  v_paused jsonb;
begin
  if v_org is null or v_sub is null or v_customer is null then raise exception 'invalid_subscription_payload' using errcode = '22023'; end if;
  -- Il customer deve essere quello creato da LeadFlow per questa organizzazione.
  if not exists (select 1 from public.stripe_customers where organization_id = v_org and stripe_customer_id = v_customer) then
    raise exception 'customer_org_mismatch' using errcode = '42501';
  end if;
  if v_plan is not null and not exists (select 1 from public.billing_plans where code = v_plan) then
    raise exception 'unknown_plan' using errcode = '22023';
  end if;

  select * into v_old from public.organization_subscriptions where stripe_subscription_id = v_sub for update;
  if v_old.id is not null and v_old.organization_id <> v_org then
    raise exception 'subscription_org_mismatch' using errcode = '42501';
  end if;
  if v_old.id is not null and v_old.stripe_synced_at > v_synced then
    return jsonb_build_object('applied', false, 'reason', 'stale_state');
  end if;

  insert into public.organization_subscriptions as s (
    organization_id, source, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_code, status,
    unit_amount_cents, currency, billing_interval, interval_count, current_period_start, current_period_end,
    cancel_at_period_end, cancel_at, canceled_at, ended_at, started_at, trial_end, livemode, stripe_synced_at)
  values (
    v_org, 'stripe', v_sub, v_customer, p ->> 'stripe_price_id', v_plan, (p ->> 'status')::public.subscription_status,
    (p ->> 'unit_amount_cents')::int, p ->> 'currency', p ->> 'billing_interval', (p ->> 'interval_count')::int,
    (p ->> 'current_period_start')::timestamptz, (p ->> 'current_period_end')::timestamptz,
    coalesce((p ->> 'cancel_at_period_end')::boolean, false), (p ->> 'cancel_at')::timestamptz,
    (p ->> 'canceled_at')::timestamptz, (p ->> 'ended_at')::timestamptz, (p ->> 'started_at')::timestamptz,
    (p ->> 'trial_end')::timestamptz, coalesce((p ->> 'livemode')::boolean, false), v_synced)
  on conflict (stripe_subscription_id) do update set
    stripe_price_id = excluded.stripe_price_id, plan_code = excluded.plan_code, status = excluded.status,
    unit_amount_cents = excluded.unit_amount_cents, currency = excluded.currency,
    billing_interval = excluded.billing_interval, interval_count = excluded.interval_count,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end, cancel_at = excluded.cancel_at,
    canceled_at = excluded.canceled_at, ended_at = excluded.ended_at, started_at = excluded.started_at,
    trial_end = excluded.trial_end, livemode = excluded.livemode, stripe_synced_at = excluded.stripe_synced_at
  returning * into cur;

  if v_old.id is null or (v_old.status, v_old.plan_code, v_old.cancel_at_period_end, v_old.current_period_end)
       is distinct from (cur.status, cur.plan_code, cur.cancel_at_period_end, cur.current_period_end) then
    perform private.billing_audit(v_org, 'stripe', null, case when v_old.id is null then 'subscription.created' else 'subscription.updated' end,
      jsonb_strip_nulls(jsonb_build_object('subscription', v_sub, 'status', cur.status, 'previous_status', v_old.status,
        'plan', cur.plan_code, 'previous_plan', v_old.plan_code, 'cancel_at_period_end', cur.cancel_at_period_end,
        'period_end', cur.current_period_end, 'event', p ->> 'event_type')));
  end if;
  -- Più abbonamenti attivi per la stessa org (es. due checkout paralleli): segnalazione all'operatore.
  if cur.status in ('active', 'trialing', 'past_due') and exists (
       select 1 from public.organization_subscriptions o
        where o.organization_id = v_org and o.id <> cur.id and o.status in ('active', 'trialing', 'past_due')) then
    perform private.billing_audit(v_org, 'system', null, 'subscription.multiple_active', jsonb_build_object('subscription', v_sub));
  end if;

  perform private.lock_quota_period(v_org);
  perform private.billing_sync_technical_quotas(v_org);
  v_paused := private.billing_pause_disallowed(v_org);
  return jsonb_build_object('applied', true, 'previous_status', v_old.status, 'previous_plan', v_old.plan_code,
    'status', cur.status, 'plan', cur.plan_code, 'paused', v_paused);
end $$;

create or replace function public.billing_upsert_invoice(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid;
  v_customer text := p ->> 'stripe_customer_id';
  v_synced timestamptz := coalesce((p ->> 'stripe_synced_at')::timestamptz, now());
  v_old public.billing_invoices;
begin
  if not exists (select 1 from public.stripe_customers where organization_id = v_org and stripe_customer_id = v_customer) then
    raise exception 'customer_org_mismatch' using errcode = '42501';
  end if;
  select * into v_old from public.billing_invoices where stripe_invoice_id = p ->> 'stripe_invoice_id' for update;
  if v_old.stripe_invoice_id is not null and v_old.organization_id <> v_org then
    raise exception 'invoice_org_mismatch' using errcode = '42501';
  end if;
  if v_old.stripe_invoice_id is not null and v_old.stripe_synced_at > v_synced then
    return jsonb_build_object('applied', false, 'reason', 'stale_state');
  end if;
  insert into public.billing_invoices as i (
    stripe_invoice_id, organization_id, stripe_subscription_id, number, status, billing_reason, currency,
    subtotal_cents, total_cents, total_excluding_tax_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents,
    attempt_count, period_start, period_end, hosted_invoice_url, invoice_pdf, paid_at, next_payment_attempt,
    livemode, stripe_created_at, stripe_synced_at)
  values (
    p ->> 'stripe_invoice_id', v_org, p ->> 'stripe_subscription_id', p ->> 'number', p ->> 'status', p ->> 'billing_reason',
    p ->> 'currency', coalesce((p ->> 'subtotal_cents')::bigint, 0), coalesce((p ->> 'total_cents')::bigint, 0),
    (p ->> 'total_excluding_tax_cents')::bigint, coalesce((p ->> 'amount_due_cents')::bigint, 0),
    coalesce((p ->> 'amount_paid_cents')::bigint, 0), coalesce((p ->> 'amount_remaining_cents')::bigint, 0),
    coalesce((p ->> 'attempt_count')::int, 0), (p ->> 'period_start')::timestamptz, (p ->> 'period_end')::timestamptz,
    p ->> 'hosted_invoice_url', p ->> 'invoice_pdf', (p ->> 'paid_at')::timestamptz, (p ->> 'next_payment_attempt')::timestamptz,
    coalesce((p ->> 'livemode')::boolean, false), (p ->> 'stripe_created_at')::timestamptz, v_synced)
  on conflict (stripe_invoice_id) do update set
    stripe_subscription_id = excluded.stripe_subscription_id, number = excluded.number, status = excluded.status,
    billing_reason = excluded.billing_reason, currency = excluded.currency, subtotal_cents = excluded.subtotal_cents,
    total_cents = excluded.total_cents, total_excluding_tax_cents = excluded.total_excluding_tax_cents,
    amount_due_cents = excluded.amount_due_cents, amount_paid_cents = excluded.amount_paid_cents,
    amount_remaining_cents = excluded.amount_remaining_cents, attempt_count = excluded.attempt_count,
    period_start = excluded.period_start, period_end = excluded.period_end,
    hosted_invoice_url = excluded.hosted_invoice_url, invoice_pdf = excluded.invoice_pdf, paid_at = excluded.paid_at,
    next_payment_attempt = excluded.next_payment_attempt, livemode = excluded.livemode,
    stripe_created_at = excluded.stripe_created_at, stripe_synced_at = excluded.stripe_synced_at, updated_at = now();
  if v_old.stripe_invoice_id is null or v_old.status is distinct from p ->> 'status' then
    perform private.billing_audit(v_org, 'stripe', null, 'invoice.' || (p ->> 'status'),
      jsonb_strip_nulls(jsonb_build_object('invoice', p ->> 'stripe_invoice_id', 'amount_paid_cents', (p ->> 'amount_paid_cents')::bigint,
        'attempt_count', (p ->> 'attempt_count')::int, 'event', p ->> 'event_type')));
  end if;
  if p ->> 'event_type' = 'invoice.payment_failed' then
    perform private.billing_audit(v_org, 'stripe', null, 'invoice.payment_failed',
      jsonb_strip_nulls(jsonb_build_object('invoice', p ->> 'stripe_invoice_id', 'attempt_count', (p ->> 'attempt_count')::int,
        'event_id', p ->> 'event_id', 'next_payment_attempt', p ->> 'next_payment_attempt')));
  end if;
  return jsonb_build_object('applied', true);
end $$;

-- Piano concesso manualmente dall'operatore (pilot, uso interno). Eseguibile SOLO da postgres
-- (SQL Editor): né gli utenti né le Netlify Functions possono concedersi un piano.
create or replace function private.billing_grant_manual_plan(p_org uuid, p_plan text, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.billing_plans where code = p_plan) then raise exception 'unknown_plan' using errcode = '22023'; end if;
  update public.organization_subscriptions set status = 'canceled', ended_at = now()
   where organization_id = p_org and source = 'manual' and status <> 'canceled';
  insert into public.organization_subscriptions (organization_id, source, plan_code, status, started_at)
  values (p_org, 'manual', p_plan, 'active', now()) returning id into v_id;
  perform private.billing_audit(p_org, 'operator', null, 'subscription.manual_granted',
    jsonb_strip_nulls(jsonb_build_object('plan', p_plan, 'note', left(p_note, 200))));
  perform private.lock_quota_period(p_org);
  perform private.billing_sync_technical_quotas(p_org);
  return v_id;
end $$;

create or replace function private.billing_revoke_manual_plan(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.organization_subscriptions set status = 'canceled', ended_at = now()
   where organization_id = p_org and source = 'manual' and status <> 'canceled';
  perform private.billing_audit(p_org, 'operator', null, 'subscription.manual_revoked', '{}'::jsonb);
  perform private.billing_pause_disallowed(p_org);
end $$;

create or replace function private.billing_set_enforcement(p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.billing_settings set enforcement_enabled = p_enabled where id;
  perform private.billing_audit(null, 'operator', null, 'settings.enforcement', jsonb_build_object('enabled', p_enabled));
end $$;

-- Audit delle azioni di billing richieste da un utente (checkout, portale, cambio piano).
create or replace function public.billing_write_audit(p_org uuid, p_actor uuid, p_action text, p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_action !~ '^(checkout|portal|plan_change|cancellation|webhook)\.[a-z_]{2,40}$' then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  perform private.billing_audit(p_org, case when p_actor is null then 'system' else 'user' end, p_actor, p_action, p_metadata);
end $$;
revoke all on function public.billing_write_audit(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.billing_write_audit(uuid, uuid, text, jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- Lettura per l'interfaccia
-- ════════════════════════════════════════════════════════════════════════════
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

-- ─── Revenue Analytics (solo super admin; solo aggregati, nessun dato dei tenant) ───
-- MRR contrattuale: abbonamenti Stripe attivi/past_due (prezzo del piano, IVA esclusa,
-- normalizzato al mese). Incassi: fatture pagate, al netto delle imposte.
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
    select * from public.billing_invoices where livemode = v_live and status = 'paid' and paid_at >= v_from
  ),
  usage as (
    select l.organization_id,
           sum(l.quantity) filter (where l.kind = 'ai_credits' and l.status = 'committed') as credits,
           sum(l.cost_usd) filter (where l.kind = 'provider_call') as provider_cost_usd
      from public.usage_ledger l where l.created_at >= v_from group by l.organization_id
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
    'open_invoices', (select count(*) from public.billing_invoices where livemode = v_live and status = 'open' and amount_remaining_cents > 0),
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

-- ─── Configurazione amministrativa (super admin) ───────────────────────────
create or replace function public.admin_update_billing_plan(p_code text, p_patch jsonb)
returns public.billing_plans language plpgsql security definer set search_path = '' as $$
declare
  v_old public.billing_plans;
  cur public.billing_plans;
begin
  if not private.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) k
             where k not in ('name', 'description', 'price_cents', 'stripe_price_id', 'monthly_leads', 'monthly_ai_credits',
                             'max_users', 'features', 'is_active', 'sort_order')) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  select * into v_old from public.billing_plans where code = p_code for update;
  if v_old.code is null then raise exception 'unknown_plan' using errcode = 'P0002'; end if;
  update public.billing_plans set
    name = coalesce(p_patch ->> 'name', name),
    description = case when p_patch ? 'description' then p_patch ->> 'description' else description end,
    price_cents = coalesce((p_patch ->> 'price_cents')::int, price_cents),
    stripe_price_id = case when p_patch ? 'stripe_price_id' then nullif(p_patch ->> 'stripe_price_id', '') else stripe_price_id end,
    monthly_leads = coalesce((p_patch ->> 'monthly_leads')::int, monthly_leads),
    monthly_ai_credits = coalesce((p_patch ->> 'monthly_ai_credits')::int, monthly_ai_credits),
    max_users = coalesce((p_patch ->> 'max_users')::int, max_users),
    features = coalesce((select array_agg(x) from jsonb_array_elements_text(p_patch -> 'features') x), features),
    is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
    sort_order = coalesce((p_patch ->> 'sort_order')::smallint, sort_order),
    updated_by = auth.uid()
  where code = p_code returning * into cur;
  perform private.billing_audit(null, 'user', auth.uid(), 'plan.updated',
    jsonb_build_object('plan', p_code, 'before', to_jsonb(v_old) - 'updated_at' - 'created_at' - 'updated_by',
                       'after', to_jsonb(cur) - 'updated_at' - 'created_at' - 'updated_by'));
  return cur;
end $$;

create or replace function public.admin_update_credit_cost(p_operation text, p_credits integer)
returns public.ai_credit_costs language plpgsql security definer set search_path = '' as $$
declare
  v_old public.ai_credit_costs;
  cur public.ai_credit_costs;
begin
  if not private.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_old from public.ai_credit_costs where operation = p_operation for update;
  if v_old.operation is null then raise exception 'unknown_operation' using errcode = 'P0002'; end if;
  update public.ai_credit_costs set credits = p_credits, updated_by = auth.uid() where operation = p_operation returning * into cur;
  perform private.billing_audit(null, 'user', auth.uid(), 'credit_cost.updated',
    jsonb_build_object('operation', p_operation, 'before', v_old.credits, 'after', p_credits));
  return cur;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Privilegi e RLS
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.billing_plans, public.ai_credit_costs, public.billing_settings, public.stripe_customers,
  public.organization_subscriptions, public.billing_invoices, public.stripe_webhook_events, public.usage_quotas,
  public.usage_ledger, public.billing_audit_logs from anon;
revoke insert, update, delete, truncate, references, trigger on public.billing_plans, public.ai_credit_costs,
  public.billing_settings, public.stripe_customers, public.organization_subscriptions, public.billing_invoices,
  public.stripe_webhook_events, public.usage_quotas, public.usage_ledger, public.billing_audit_logs from authenticated;
revoke truncate on public.billing_audit_logs, public.usage_ledger, public.stripe_webhook_events from service_role;

alter table public.billing_plans enable row level security;
alter table public.ai_credit_costs enable row level security;
alter table public.billing_settings enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.usage_quotas enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.billing_audit_logs enable row level security;

create policy billing_plans_select on public.billing_plans for select to authenticated
  using (is_active or private.is_super_admin());
create policy ai_credit_costs_select on public.ai_credit_costs for select to authenticated using (true);
create policy billing_settings_select on public.billing_settings for select to authenticated using (private.is_super_admin());
create policy stripe_customers_select on public.stripe_customers for select to authenticated
  using (private.is_org_admin(organization_id) or private.is_super_admin());
create policy organization_subscriptions_select on public.organization_subscriptions for select to authenticated
  using (private.is_org_member(organization_id) or private.is_super_admin());
create policy billing_invoices_select on public.billing_invoices for select to authenticated
  using (private.is_org_admin(organization_id) or private.is_super_admin());
create policy stripe_webhook_events_select on public.stripe_webhook_events for select to authenticated
  using (private.is_super_admin());
create policy usage_quotas_select on public.usage_quotas for select to authenticated
  using (private.is_org_member(organization_id) or private.is_super_admin());
create policy usage_ledger_select on public.usage_ledger for select to authenticated
  using (private.is_org_admin(organization_id) or private.is_super_admin());
create policy billing_audit_logs_select on public.billing_audit_logs for select to authenticated
  using ((organization_id is not null and private.is_org_admin(organization_id)) or private.is_super_admin());

-- Funzioni: le scritture solo service role; le letture con controllo di appartenenza interno.
revoke all on function public.billing_reserve_credits(uuid, uuid, text, text, uuid, jsonb), public.billing_commit_credits(uuid, text, bigint),
  public.billing_release_credits(uuid, text, text), public.billing_lead_quota(uuid), public.billing_count_new_leads(uuid, uuid, text[], jsonb),
  public.billing_record_provider_call(uuid, uuid, text, text), public.billing_link_customer(uuid, text, boolean),
  public.billing_claim_webhook_event(text, text, boolean, timestamptz), public.billing_finish_webhook_event(text, text, text, uuid, text),
  public.billing_apply_subscription(jsonb), public.billing_upsert_invoice(jsonb)
  from public, anon, authenticated;
grant execute on function public.billing_reserve_credits(uuid, uuid, text, text, uuid, jsonb), public.billing_commit_credits(uuid, text, bigint),
  public.billing_release_credits(uuid, text, text), public.billing_lead_quota(uuid), public.billing_count_new_leads(uuid, uuid, text[], jsonb),
  public.billing_record_provider_call(uuid, uuid, text, text), public.billing_link_customer(uuid, text, boolean),
  public.billing_claim_webhook_event(text, text, boolean, timestamptz), public.billing_finish_webhook_event(text, text, text, uuid, text),
  public.billing_apply_subscription(jsonb), public.billing_upsert_invoice(jsonb)
  to service_role;

revoke all on function public.billing_can_use_feature(uuid, text), public.billing_status(uuid), public.billing_admin_revenue(integer),
  public.admin_update_billing_plan(text, jsonb), public.admin_update_credit_cost(text, integer) from public, anon;
grant execute on function public.billing_can_use_feature(uuid, text), public.billing_status(uuid), public.billing_admin_revenue(integer),
  public.admin_update_billing_plan(text, jsonb), public.admin_update_credit_cost(text, integer) to authenticated, service_role;

-- Le funzioni private restano non esposte (schema private non incluso nell'API).
revoke all on function private.billing_grant_manual_plan(uuid, text, text), private.billing_revoke_manual_plan(uuid),
  private.billing_set_enforcement(boolean) from public, anon, authenticated, service_role;

revoke all on function private.billing_audit(uuid, text, uuid, text, jsonb), private.billing_settings_row(),
  private.subscription_status_grants_access(public.subscription_status), private.current_subscription(uuid),
  private.org_entitlements(uuid), private.feature_check(uuid, text), private.require_feature(uuid, text),
  private.lock_quota_period(uuid), private.release_stale_reservations(uuid), private.billing_pause_disallowed(uuid),
  private.billing_sync_technical_quotas(uuid), private.ai_jobs_billing_reserve(), private.ai_jobs_billing_settle(),
  private.members_billing_limit(), private.campaigns_billing_guard(), private.workflows_billing_guard(),
  private.billing_audit_immutable()
  from public, anon, authenticated;
