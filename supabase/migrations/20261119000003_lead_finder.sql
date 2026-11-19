-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Migrazione 0003: AI Lead Finder
--
-- • organization_profiles: cliente ideale e pesi di scoring configurabili
-- • organization_quotas:   limiti mensili e rate limit per organizzazione
-- • lead_searches:         ricerche eseguite (stato e avanzamento reali)
-- • lead_candidates:       risultati dei provider, deduplicati per (org, provider, id esterno)
-- • leads:                 nuovi campi di provenienza, dedup e qualificazione
-- • RPC server-only per quote e rate limit; riepilogo consumi per i membri
--
-- La licenza del provider è applicata anche dal database: se una fonte non
-- consente la memorizzazione (es. Google Places), il candidato può contenere
-- solo l'identificativo esterno.
-- ════════════════════════════════════════════════════════════════════════════

create type public.lead_provider as enum ('osm_overpass', 'google_places', 'csv_import');
create type public.lead_priority as enum ('high', 'medium', 'low');
create type public.candidate_status as enum ('new', 'saved', 'excluded');
create type public.search_status as enum ('running', 'completed', 'failed');
create type public.score_basis as enum ('rules', 'ai');

-- Codici paese ISO 3166-1 alpha-2 in un array.
create or replace function private.all_iso2(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(bool_and(c ~ '^[A-Z]{2}$'), true) from unnest(p) as c;
$$;

-- ─── Profilo commerciale dell'organizzazione (cliente ideale + pesi) ───────
create table public.organization_profiles (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  services_description text check (services_description is null or char_length(services_description) <= 4000),
  ideal_customer text check (ideal_customer is null or char_length(ideal_customer) <= 4000),
  target_sectors text[] not null default '{}' check (cardinality(target_sectors) <= 30),
  target_regions text[] not null default '{}' check (cardinality(target_regions) <= 50),
  target_countries text[] not null default '{}' check (cardinality(target_countries) <= 30 and private.all_iso2(target_countries)),
  weight_sector smallint not null default 30 check (weight_sector between 0 and 100),
  weight_geography smallint not null default 20 check (weight_geography between 0 and 100),
  weight_icp smallint not null default 25 check (weight_icp between 0 and 100),
  weight_signals smallint not null default 15 check (weight_signals between 0 and 100),
  weight_completeness smallint not null default 10 check (weight_completeness between 0 and 100),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint organization_profiles_weights_sum check (
    weight_sector + weight_geography + weight_icp + weight_signals + weight_completeness = 100
  )
);
create trigger organization_profiles_updated_at before update on public.organization_profiles
  for each row execute function public.set_updated_at();

-- ─── Quote per organizzazione (modificabili solo lato server / SQL) ───────
create table public.organization_quotas (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  plan text not null default 'mvp',
  monthly_searches integer not null default 50 check (monthly_searches >= 0),
  monthly_results integer not null default 1000 check (monthly_results >= 0),
  monthly_ai_analyses integer not null default 100 check (monthly_ai_analyses >= 0),
  requests_per_minute integer not null default 20 check (requests_per_minute between 1 and 600),
  updated_at timestamptz not null default now()
);
create trigger organization_quotas_updated_at before update on public.organization_quotas
  for each row execute function public.set_updated_at();

-- Profilo e quote creati insieme all'organizzazione (e per quelle esistenti).
create or replace function private.init_organization_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_profiles (organization_id) values (new.id) on conflict do nothing;
  insert into public.organization_quotas (organization_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger organizations_init_settings after insert on public.organizations
  for each row execute function private.init_organization_settings();

insert into public.organization_profiles (organization_id) select id from public.organizations on conflict do nothing;
insert into public.organization_quotas (organization_id) select id from public.organizations on conflict do nothing;

-- ─── Fonti: provider di origine ────────────────────────────────────────────
alter table public.lead_sources
  add column provider public.lead_provider,
  add column license_note text check (license_note is null or char_length(license_note) <= 1000);
-- Una sola fonte "API" per provider e organizzazione (le importazioni CSV restano distinte).
create unique index lead_sources_org_provider_api_uidx on public.lead_sources (organization_id, provider)
  where provider is not null and type = 'api';

-- ─── Ricerche ──────────────────────────────────────────────────────────────
create table public.lead_searches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider public.lead_provider not null,
  params jsonb not null default '{}'::jsonb,
  status public.search_status not null default 'running',
  stage text not null default 'querying_provider'
    check (stage in ('querying_provider', 'normalizing', 'deduplicating', 'scoring', 'saving', 'done', 'failed')),
  results_count integer not null default 0 check (results_count >= 0),
  new_count integer not null default 0 check (new_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  excluded_count integer not null default 0 check (excluded_count >= 0),
  error_code text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, id)
);
create index lead_searches_org_created_idx on public.lead_searches (organization_id, created_at desc);

-- ─── Candidati ─────────────────────────────────────────────────────────────
create table public.lead_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider public.lead_provider not null,
  external_id text not null check (char_length(external_id) between 1 and 300),
  search_id uuid,
  -- Fonte del candidato quando già nota (importazioni CSV con base giuridica dichiarata).
  source_id uuid,
  company_name text check (company_name is null or char_length(company_name) <= 300),
  sector text check (sector is null or char_length(sector) <= 200),
  category_tags text[] not null default '{}',
  address text,
  city text,
  region text,
  postal_code text,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  website text check (website is null or website ~* '^https?://'),
  phone text,
  source_url text check (source_url is null or source_url ~* '^https?://'),
  attribution text,
  -- Diritti concessi dalla licenza del provider al momento dell'acquisizione.
  can_store_content boolean not null,
  can_export boolean not null,
  can_save_to_crm boolean not null,
  dedup_key text,
  status public.candidate_status not null default 'new',
  excluded_reason text check (excluded_reason is null or char_length(excluded_reason) <= 500),
  excluded_at timestamptz,
  excluded_by uuid references auth.users (id) on delete set null,
  lead_id uuid,
  score smallint check (score is null or score between 0 and 100),
  priority public.lead_priority,
  score_basis public.score_basis,
  score_breakdown jsonb,
  analysis jsonb,
  last_analyzed_at timestamptz,
  acquired_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id),
  unique (organization_id, id),
  foreign key (organization_id, search_id) references public.lead_searches (organization_id, id) on delete set null (search_id),
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete set null (source_id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id),
  -- Se la licenza non consente la memorizzazione, si conserva solo l'identificativo esterno.
  constraint lead_candidates_license_storage check (
    can_store_content or (
      company_name is null and sector is null and address is null and city is null and region is null
      and postal_code is null and website is null and phone is null and cardinality(category_tags) = 0
      and score is null and score_breakdown is null
    )
  ),
  constraint lead_candidates_saved_requires_crm check (status <> 'saved' or can_save_to_crm)
);
create index lead_candidates_org_search_idx on public.lead_candidates (organization_id, search_id);
create index lead_candidates_org_status_score_idx on public.lead_candidates (organization_id, status, score desc nulls last);
create index lead_candidates_org_dedup_idx on public.lead_candidates (organization_id, dedup_key) where dedup_key is not null;
create trigger lead_candidates_updated_at before update on public.lead_candidates
  for each row execute function public.set_updated_at();
create trigger lead_candidates_org_immutable before update on public.lead_candidates
  for each row execute function public.prevent_org_change();

-- ─── Leads: provenienza, dedup, qualificazione ─────────────────────────────
alter table public.leads
  add column provider public.lead_provider,
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 300),
  add column dedup_key text,
  add column region text,
  add column acquired_at timestamptz,
  add column last_analyzed_at timestamptz,
  add column priority public.lead_priority,
  add column score_basis public.score_basis,
  add column score_breakdown jsonb,
  add column score_explanation text check (score_explanation is null or char_length(score_explanation) <= 4000),
  add constraint leads_provider_external_pair check ((provider is null) = (external_id is null));

-- Nessun doppione per fonte e nessun doppione della stessa azienda (dominio o nome+città).
create unique index leads_org_provider_external_uidx on public.leads (organization_id, provider, external_id)
  where external_id is not null;
create unique index leads_org_dedup_uidx on public.leads (organization_id, dedup_key)
  where dedup_key is not null and deleted_at is null;

-- ─── ai_jobs: collegamento al candidato analizzato ─────────────────────────
alter table public.ai_jobs add column candidate_id uuid;
alter table public.ai_jobs add constraint ai_jobs_org_id_unique unique (organization_id, id);
alter table public.ai_jobs add constraint ai_jobs_candidate_fk
  foreign key (organization_id, candidate_id) references public.lead_candidates (organization_id, id) on delete set null (candidate_id);
create index ai_jobs_org_candidate_idx on public.ai_jobs (organization_id, candidate_id, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- Quote e rate limit (solo service role, invocate dalle Netlify Functions
-- DOPO i controlli di autorizzazione)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.consume_usage(
  p_org uuid, p_user uuid, p_event text, p_quantity integer, p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer;
  v_used bigint;
  v_month timestamptz := date_trunc('month', now());
begin
  if p_quantity < 0 then raise exception 'invalid quantity' using errcode = '22023'; end if;
  select case p_event
           when 'lead_search' then q.monthly_searches
           when 'lead_result' then q.monthly_results
           when 'ai_analysis' then q.monthly_ai_analyses
         end
    into v_limit
    from public.organization_quotas q where q.organization_id = p_org;
  if v_limit is null then raise exception 'unknown quota for event %', p_event using errcode = '22023'; end if;

  -- Serializza i consumi della stessa org/evento: niente superamenti per richieste concorrenti.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_event, 0));
  select coalesce(sum(quantity), 0) into v_used from public.usage_events
   where organization_id = p_org and event_type = p_event and created_at >= v_month;

  if v_used + p_quantity > v_limit then
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'remaining', greatest(v_limit - v_used, 0));
  end if;
  if p_quantity > 0 then
    insert into public.usage_events (organization_id, user_id, event_type, quantity, metadata)
    values (p_org, p_user, p_event, p_quantity, coalesce(p_metadata, '{}'::jsonb));
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used + p_quantity, 'limit', v_limit, 'remaining', v_limit - v_used - p_quantity);
end $$;

create or replace function public.check_rate_limit(p_org uuid, p_user uuid, p_bucket text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_max integer;
  v_count bigint;
  v_oldest timestamptz;
  v_event text := 'rate:' || p_bucket;
begin
  select requests_per_minute into v_max from public.organization_quotas where organization_id = p_org;
  v_max := coalesce(v_max, 20);
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || v_event, 0));
  select count(*), min(created_at) into v_count, v_oldest from public.usage_events
   where user_id = p_user and event_type = v_event and created_at > now() - interval '60 seconds';
  if v_count >= v_max then
    return jsonb_build_object('allowed', false,
      'retry_after', greatest(1, ceil(extract(epoch from (v_oldest + interval '60 seconds' - now()))))::int);
  end if;
  insert into public.usage_events (organization_id, user_id, event_type, quantity) values (p_org, p_user, v_event, 1);
  return jsonb_build_object('allowed', true);
end $$;

revoke all on function public.consume_usage(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.check_rate_limit(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_usage(uuid, uuid, text, integer, jsonb) to service_role;
grant execute on function public.check_rate_limit(uuid, uuid, text) to service_role;

-- Riepilogo consumi del mese per i membri dell'organizzazione (crediti utilizzati).
create or replace function public.usage_summary(p_org uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q public.organization_quotas;
  v_month timestamptz := date_trunc('month', now());
begin
  if not private.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into q from public.organization_quotas where organization_id = p_org;
  return jsonb_build_object(
    'period_start', v_month,
    'plan', q.plan,
    'searches', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'lead_search' and created_at >= v_month), 'limit', q.monthly_searches),
    'results', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'lead_result' and created_at >= v_month), 'limit', q.monthly_results),
    'ai_analyses', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'ai_analysis' and created_at >= v_month), 'limit', q.monthly_ai_analyses)
  );
end $$;
revoke all on function public.usage_summary(uuid) from public, anon;
grant execute on function public.usage_summary(uuid) to authenticated;

-- Retention estesa: candidati mai salvati e contatori del rate limit.
create or replace function private.purge_expired_data()
returns table (purged_soft_deleted bigint, purged_retention bigint)
language plpgsql security definer set search_path = '' as $$
declare
  a bigint; b bigint;
begin
  delete from public.leads where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics a = row_count;
  delete from public.leads l
   using public.organizations o
   where o.id = l.organization_id
     and coalesce(l.last_activity_at, l.updated_at) < now() - make_interval(days => o.data_retention_days);
  get diagnostics b = row_count;
  delete from public.lead_candidates where status = 'new' and last_seen_at < now() - interval '90 days';
  delete from public.usage_events where event_type like 'rate:%' and created_at < now() - interval '1 day';
  return query select a, b;
end $$;
revoke all on function private.purge_expired_data() from public, authenticated;
grant execute on function private.purge_expired_data() to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- Privilegi e RLS
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.organization_profiles, public.organization_quotas, public.lead_searches, public.lead_candidates from anon;
revoke truncate, references, trigger on public.organization_profiles, public.organization_quotas,
  public.lead_searches, public.lead_candidates from authenticated;

-- Scritture solo lato server (Netlify Functions con service role dopo i controlli).
revoke insert, update, delete on public.lead_searches, public.lead_candidates, public.organization_quotas from authenticated;

-- Profilo: l'admin aggiorna i campi descrittivi e i pesi; nessuna cancellazione.
revoke insert, update, delete on public.organization_profiles from authenticated;
grant update (services_description, ideal_customer, target_sectors, target_regions, target_countries,
  weight_sector, weight_geography, weight_icp, weight_signals, weight_completeness, updated_by)
  on public.organization_profiles to authenticated;

-- Le nuove colonne di qualificazione dei lead sono scritte dal server.
revoke update on public.leads from authenticated;
grant update (company_name, website, vat_number, industry, city, country, contact_name, contact_role, email, phone,
  status, contact_status, suppressed_at, owner_id, notes, last_activity_at, deleted_at, organization_id, region)
  on public.leads to authenticated;

alter table public.organization_profiles enable row level security;
alter table public.organization_quotas enable row level security;
alter table public.lead_searches enable row level security;
alter table public.lead_candidates enable row level security;

create policy organization_profiles_select on public.organization_profiles for select to authenticated
  using (private.is_org_member(organization_id));
create policy organization_profiles_update on public.organization_profiles for update to authenticated
  using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));

create policy organization_quotas_select on public.organization_quotas for select to authenticated
  using (private.is_org_member(organization_id) or private.is_super_admin());

create policy lead_searches_select on public.lead_searches for select to authenticated
  using (private.is_org_member(organization_id));

create policy lead_candidates_select on public.lead_candidates for select to authenticated
  using (private.is_org_member(organization_id));
