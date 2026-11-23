-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Accesso di test interno (piano internal_test).
--
-- RICOSTRUZIONE delle migrazioni 0017 + 0018 applicate a mano nel SQL Editor di Supabase il 2026-11-23.
-- I file originali non erano nel repository e non sono registrati nello storico delle migrazioni del
-- progetto (né salvati come snippet). Il contenuto qui sotto è estratto dallo schema REALE del
-- database (pg_get_functiondef, vincoli, indici, trigger, permessi, riga del piano): è il risultato
-- effettivo delle due migrazioni, non il loro testo originale. Tutti gli oggetti risultano creati
-- nella stessa transazione, quindi la divisione originale tra 0017 e 0018 non è ricostruibile:
-- se il proprietario conserva i file originali, possono sostituire questo file.
--
-- Verificato: applicato dopo 0001–0016 su un PostgreSQL locale, produce le stesse impronte (md5)
-- di funzioni, policy, trigger, indici, vincoli e permessi del database di produzione.
-- Idempotente: rieseguirlo sul database di produzione non cambia nulla.
--
-- Modello: concessione per UTENTE (email), con scadenza, gestita SOLO dall'operatore (postgres, SQL
-- Editor). Nessun abbonamento creato, nessuna interazione con Stripe. L'accesso vale per le
-- organizzazioni di cui l'utente è organization_admin (o per una sola, se indicata). La sospensione
-- amministrativa prevale sempre. Il piano commerciale resta intatto e torna in vigore alla revoca.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Piano interno: non vendibile, prezzo zero, nessun Price Stripe, tutti i moduli.
insert into public.billing_plans (code, name, description, price_cents, monthly_leads, monthly_ai_credits, max_users, features, is_active, sort_order)
values ('internal_test', 'Test interno (gratuito)', 'Accesso di test completo per account autorizzati dall''operatore. Non vendibile, nessun addebito.',
        0, 50000, 50000, 100, private.billing_known_features(), false, 99)
on conflict (code) do nothing;

-- 2. Concessioni di test (schema private: non esposto dalle API, nessun accesso dei client).
create table if not exists private.test_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 300),
  check (expires_at > granted_at)
);
create index if not exists test_access_grants_user_idx on private.test_access_grants (user_id) where revoked_at is null;
alter table private.test_access_grants enable row level security;
revoke all on private.test_access_grants from public, anon, authenticated, service_role;

-- 3. Entitlement commerciale (identico al precedente private.org_entitlements, rinominato).
create or replace function private.org_entitlements_commercial(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
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
end $function$;

-- 4. Concessione attiva che copre l'organizzazione: l'utente deve esserne organization_admin.
create or replace function private.org_test_access(p_org uuid)
returns private.test_access_grants language sql stable security definer set search_path = '' as $function$
  select g.* from private.test_access_grants g
    join public.organizations o on o.id = p_org and o.deleted_at is null
    join public.organization_members m on m.organization_id = o.id and m.user_id = g.user_id and m.role = 'organization_admin'
   where g.revoked_at is null and g.expires_at > now()
     and (g.organization_id = o.id or (g.organization_id is null and o.created_by = g.user_id))
   order by g.expires_at desc
   limit 1;
$function$;

-- 5. Entitlement effettivo = commerciale + sovrapposizione di test (usato da feature_check e da tutti i controlli).
create or replace function private.org_entitlements(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  e jsonb := private.org_entitlements_commercial(p_org);
  g private.test_access_grants;
  p public.billing_plans;
  v_start timestamptz;
  v_end timestamptz;
begin
  -- La sospensione amministrativa prevale sempre sull'accesso di test.
  if coalesce((e ->> 'suspended')::boolean, false) then return e; end if;
  g := private.org_test_access(p_org);
  if g.id is null then return e; end if;
  select * into p from public.billing_plans where code = 'internal_test';
  if p.code is null then return e; end if;
  -- Se esiste già un periodo (es. abbonamento Stripe) lo si riusa: le righe di usage_quotas restano coerenti.
  v_start := coalesce((e ->> 'period_start')::timestamptz, date_trunc('month', now() at time zone 'UTC') at time zone 'UTC');
  v_end := coalesce((e ->> 'period_end')::timestamptz, v_start + interval '1 month');
  return e || jsonb_build_object(
    'has_access', true,
    'subscription_id', g.id,
    'source', 'test',
    'status', 'active',
    'plan_code', p.code,
    'features', to_jsonb(p.features),
    'max_users', p.max_users,
    'monthly_leads', p.monthly_leads,
    'monthly_ai_credits', p.monthly_ai_credits,
    'period_start', v_start,
    'period_end', v_end,
    'test_access', jsonb_build_object('expires_at', g.expires_at, 'commercial_plan_code', e ->> 'plan_code',
                                      'commercial_has_access', coalesce((e ->> 'has_access')::boolean, false))
  );
end $function$;

-- 6. Operazioni dell'operatore (solo postgres / SQL Editor).
create or replace function private.test_access_grant(p_email text, p_reason text, p_days integer default 60, p_org uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user uuid;
  v_id uuid;
  o record;
  v_orgs jsonb := '[]'::jsonb;
begin
  if p_days is null or p_days not between 1 and 365 then raise exception 'invalid_days' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  if p_org is not null and not exists (select 1 from public.organization_members where organization_id = p_org and user_id = v_user and role = 'organization_admin') then
    raise exception 'user_not_org_admin' using errcode = '22023';
  end if;
  -- Una sola concessione attiva per (utente, ambito): la precedente viene sostituita.
  update private.test_access_grants set revoked_at = now(), revoked_reason = 'replaced'
   where user_id = v_user and revoked_at is null and organization_id is not distinct from p_org;
  insert into private.test_access_grants (user_id, organization_id, reason, expires_at)
  values (v_user, p_org, btrim(p_reason), now() + make_interval(days => p_days)) returning id into v_id;
  for o in
    select m.organization_id as id, g.name from public.organization_members m join public.organizations g on g.id = m.organization_id
     where m.user_id = v_user and g.deleted_at is null
  loop
    if (private.org_test_access(o.id)).id is not null then
      perform private.lock_quota_period(o.id);
      perform private.billing_sync_technical_quotas(o.id);
      perform private.billing_audit(o.id, 'operator', null, 'test_access.granted', jsonb_build_object('grant_id', v_id, 'days', p_days));
      v_orgs := v_orgs || jsonb_build_object('id', o.id, 'name', o.name);
    end if;
  end loop;
  insert into public.admin_audit_logs (actor_role, action, target_type, target_id, reason, metadata)
  values ('operator', 'test_access.granted', 'user', v_user::text, btrim(p_reason),
          jsonb_build_object('grant_id', v_id, 'days', p_days, 'organization_id', p_org, 'organizations', v_orgs));
  return jsonb_build_object('grant_id', v_id, 'expires_at', now() + make_interval(days => p_days), 'organizations', v_orgs);
end $function$;

create or replace function private.test_access_revoke(p_email text, p_reason text default 'test_completed'::text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user uuid;
  v_orgs uuid[];
  v_org uuid;
  n int;
begin
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  select coalesce(array_agg(m.organization_id), '{}') into v_orgs from public.organization_members m
   where m.user_id = v_user and (private.org_test_access(m.organization_id)).id is not null;
  update private.test_access_grants set revoked_at = now(), revoked_reason = left(p_reason, 300)
   where user_id = v_user and revoked_at is null;
  get diagnostics n = row_count;
  foreach v_org in array v_orgs loop
    perform private.lock_quota_period(v_org);
    perform private.billing_pause_disallowed(v_org);
    perform private.billing_audit(v_org, 'operator', null, 'test_access.revoked', '{}'::jsonb);
  end loop;
  insert into public.admin_audit_logs (actor_role, action, target_type, target_id, reason, metadata)
  values ('operator', 'test_access.revoked', 'user', v_user::text, left(coalesce(p_reason, 'test_completed'), 300),
          jsonb_build_object('grants_revoked', n, 'organizations', to_jsonb(v_orgs)));
  return jsonb_build_object('grants_revoked', n, 'organizations', to_jsonb(v_orgs));
end $function$;

create or replace function private.test_access_revoke_all(p_reason text default 'commercial_launch'::text)
returns integer language plpgsql security definer set search_path = '' as $function$
declare r record; n int := 0;
begin
  for r in select distinct u.email from private.test_access_grants g join auth.users u on u.id = g.user_id where g.revoked_at is null loop
    perform private.test_access_revoke(r.email, p_reason);
    n := n + 1;
  end loop;
  return n;
end $function$;

create or replace function private.test_access_status()
returns table(email text, organization_id uuid, reason text, granted_at timestamptz, expires_at timestamptz, active boolean, covered_organizations jsonb)
language sql stable security definer set search_path = '' as $function$
  select u.email::text, g.organization_id, g.reason, g.granted_at, g.expires_at,
         (g.revoked_at is null and g.expires_at > now()),
         coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name))
                     from public.organization_members m join public.organizations o on o.id = m.organization_id
                    where m.user_id = g.user_id and (private.org_test_access(o.id)).id = g.id), '[]'::jsonb)
    from private.test_access_grants g join auth.users u on u.id = g.user_id
   where g.revoked_at is null
   order by g.granted_at desc;
$function$;

-- 7. Lettura per le Netlify Functions (solo service_role): l'organizzazione è in accesso di test?
create or replace function public.billing_test_access(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select (private.org_test_access(p_org)).id is not null;
$function$;

-- 8. Un nuovo admin aggiunto a un'organizzazione coperta allinea subito le quote tecniche.
create or replace function private.members_test_access_sync()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.role = 'organization_admin'
     and exists (select 1 from private.test_access_grants where user_id = new.user_id and revoked_at is null and expires_at > now()) then
    perform private.billing_sync_technical_quotas(new.organization_id);
  end if;
  return new;
end $function$;
drop trigger if exists organization_members_test_access_sync on public.organization_members;
create trigger organization_members_test_access_sync after insert on public.organization_members
  for each row execute function private.members_test_access_sync();

-- 9. Permessi: tutto riservato all'operatore, tranne la lettura booleana per service_role.
revoke all on function private.org_entitlements_commercial(uuid), private.org_test_access(uuid), private.org_entitlements(uuid),
  private.test_access_grant(text, text, integer, uuid), private.test_access_revoke(text, text), private.test_access_revoke_all(text),
  private.test_access_status(), private.members_test_access_sync(), public.billing_test_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.billing_test_access(uuid) to service_role;
