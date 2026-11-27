-- ════════════════════════════════════════════════════════════════════════════
-- Lead AI Generate 2.0 — Migrazione 0018: Demand Hunter (integrazione BuyerML «La caccia»)
--
-- SOLO ADDITIVA: nuove tabelle, nuove funzioni, un nuovo valore dell'enum lead_provider.
-- Nessuna tabella, colonna, policy o funzione esistente viene modificata o rimossa.
-- NON applicare al database di produzione senza averla prima provata su un branch/staging Supabase.
--
-- Tabelle (tutte con organization_id, RLS attiva, lettura solo ai membri dell'organizzazione,
-- scrittura solo dal server — Netlify Functions con service role DOPO i controlli di accesso):
--   demand_hunter_limits                 limiti API per organizzazione (chiamate SerpApi/mese, budget per caccia)
--   demand_hunter_jobs                   job persistenti (caccia, espansione di un'area) e stato del servizio Python
--   demand_hunter_sessions               sessioni di ricerca (una per caccia)
--   demand_hunter_combinations           combinazioni verbo + oggetto provate o in coda
--   demand_hunter_leads                  lead individuati, deduplicati per organizzazione (URL e testo)
--   demand_hunter_intent_classifications classificazione dell'intenzione con le prove testuali (demand.py)
--   demand_hunter_feedback               giudizio Giusto/Sbagliato degli utenti
--   demand_hunter_concepts               concetti e mercati scoperti (areas.py)
--   demand_hunter_learning_stats         statistiche di apprendimento (learning.py)
--   demand_hunter_api_usage              consumo delle API (prenotazioni e rilasci, registro append-only)
--   demand_hunter_confirmations          token di conferma monouso (solo hash; nessun accesso dei client)
-- ════════════════════════════════════════════════════════════════════════════

-- I lead trasferiti nel CRM indicano la loro provenienza. (ADD VALUE non è usato in questa transazione.)
alter type public.lead_provider add value if not exists 'demand_hunter';

-- ─── Limiti per organizzazione ─────────────────────────────────────────────
-- Senza riga valgono i valori predefiniti di private.demand_hunter_limits_for().
create table if not exists public.demand_hunter_limits (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  enabled boolean not null default true,
  monthly_paid_calls integer not null default 200 check (monthly_paid_calls between 0 and 100000),
  max_budget_per_hunt integer not null default 50 check (max_budget_per_hunt between 1 and 500),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ─── Job persistenti ───────────────────────────────────────────────────────
create table if not exists public.demand_hunter_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('hunt', 'expand')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'stopped', 'failed', 'interrupted')),
  -- La conferma consumata per avviarlo: una conferma = al massimo un job (protezione da richieste duplicate).
  confirmation_id uuid not null,
  service_job_id text check (service_job_id is null or service_job_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  mode text not null default 'simulated' check (mode in ('simulated', 'live')),
  params jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  reserved_calls integer not null default 0 check (reserved_calls >= 0),
  spent_searches integer not null default 0 check (spent_searches >= 0),
  spent_autocomplete integer not null default 0 check (spent_autocomplete >= 0),
  usage_settled boolean not null default false,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  synced_at timestamptz,
  unique (organization_id, id),
  unique (confirmation_id)
);
create index if not exists demand_hunter_jobs_org_created_idx on public.demand_hunter_jobs (organization_id, created_at desc);
create index if not exists demand_hunter_jobs_active_idx on public.demand_hunter_jobs (status) where status in ('queued', 'running');

-- ─── Sessioni di ricerca ───────────────────────────────────────────────────
create table if not exists public.demand_hunter_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  job_id uuid not null,
  goal text not null check (goal in ('clienti', 'lavoro')),
  seed text not null check (char_length(btrim(seed)) between 1 and 120),
  budget integer not null check (budget between 1 and 500),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'stopped', 'failed', 'interrupted')),
  mode text not null default 'simulated' check (mode in ('simulated', 'live')),
  combos_total integer not null default 0 check (combos_total >= 0),
  leads_found integer not null default 0 check (leads_found >= 0),
  events jsonb not null default '[]'::jsonb,
  verbs jsonb not null default '[]'::jsonb,
  objects jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (organization_id, id),
  unique (job_id),
  foreign key (organization_id, job_id) references public.demand_hunter_jobs (organization_id, id) on delete cascade
);
create index if not exists demand_hunter_sessions_org_created_idx on public.demand_hunter_sessions (organization_id, created_at desc);

-- ─── Combinazioni di ricerca ───────────────────────────────────────────────
create table if not exists public.demand_hunter_combinations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id uuid not null,
  query text not null check (char_length(query) between 1 and 400),
  verb text not null check (char_length(verb) <= 80),
  object text not null check (char_length(object) <= 200),
  origin text check (origin is null or char_length(origin) <= 40),
  status text not null check (status in ('da provare', 'provata', 'già fatta', 'abbandonata')),
  results integer not null default 0 check (results >= 0),
  leads integer not null default 0 check (leads >= 0),
  priority numeric(8, 3) not null default 0,
  updated_at timestamptz not null default now(),
  unique (session_id, query),
  foreign key (organization_id, session_id) references public.demand_hunter_sessions (organization_id, id) on delete cascade
);
create index if not exists demand_hunter_combinations_org_idx on public.demand_hunter_combinations (organization_id, session_id);

-- ─── Lead individuati ──────────────────────────────────────────────────────
-- Deduplicati per organizzazione: lo stesso URL o lo stesso testo (normalizzato) è un solo lead,
-- anche se trovato da cacce diverse. Il testo è l'estratto pubblico mostrato da Google.
create table if not exists public.demand_hunter_leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id uuid,
  url text not null check (url ~* '^https?://' and char_length(url) <= 2000),
  url_hash text not null check (url_hash ~ '^[0-9a-f]{64}$'),
  text_hash text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  text text not null check (char_length(text) between 1 and 5000),
  goal text not null check (goal in ('clienti', 'lavoro')),
  score smallint not null check (score between 0 and 100),
  stage text check (stage is null or char_length(stage) <= 40),
  demand text check (demand is null or demand in ('yes', 'weak', 'no')),
  lead_class text check (lead_class is null or char_length(lead_class) <= 20),
  taxonomy_node text check (taxonomy_node is null or char_length(taxonomy_node) <= 80),
  technology text[] not null default '{}',
  query text check (query is null or char_length(query) <= 400),
  verb text,
  object text,
  status text not null default 'new' check (status in ('new', 'transferred', 'dismissed')),
  crm_lead_id uuid,
  simulated boolean not null default false,
  found_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, url_hash),
  foreign key (organization_id, session_id) references public.demand_hunter_sessions (organization_id, id) on delete set null (session_id),
  foreign key (organization_id, crm_lead_id) references public.leads (organization_id, id) on delete set null (crm_lead_id),
  constraint demand_hunter_leads_transferred_has_crm check (status <> 'transferred' or crm_lead_id is not null)
);
create unique index if not exists demand_hunter_leads_org_text_uidx on public.demand_hunter_leads (organization_id, goal, text_hash);
create index if not exists demand_hunter_leads_org_score_idx on public.demand_hunter_leads (organization_id, score desc, found_at desc);
create index if not exists demand_hunter_leads_session_idx on public.demand_hunter_leads (organization_id, session_id);

-- ─── Classificazione delle intenzioni (con prove testuali) ─────────────────
create table if not exists public.demand_hunter_intent_classifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  reader text not null default 'rules' check (reader in ('rules', 'claude', 'model')),
  author_role text check (author_role is null or author_role in ('buyer', 'seller', 'job_seeker', 'learner', 'neutral')),
  intent_types text[] not null default '{}',
  stage text,
  lead_score smallint check (lead_score is null or lead_score between 0 and 100),
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  urgency text,
  budget_declared boolean,
  specificity text,
  taxonomy_path text[] not null default '{}',
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  created_at timestamptz not null default now(),
  unique (lead_id, reader),
  foreign key (organization_id, lead_id) references public.demand_hunter_leads (organization_id, id) on delete cascade
);
create index if not exists demand_hunter_intent_org_idx on public.demand_hunter_intent_classifications (organization_id);

-- ─── Feedback degli utenti (Giusto / Sbagliato) ────────────────────────────
create table if not exists public.demand_hunter_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  verdict text not null check (verdict in ('giusto', 'sbagliato')),
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, lead_id),
  foreign key (organization_id, lead_id) references public.demand_hunter_leads (organization_id, id) on delete cascade
);

-- ─── Concetti e mercati scoperti ───────────────────────────────────────────
create table if not exists public.demand_hunter_concepts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  goal text not null check (goal in ('clienti', 'lavoro')),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  norm text not null check (char_length(norm) between 1 and 200),
  parent_norm text not null check (char_length(parent_norm) <= 200),
  rel text not null check (rel in ('variante', 'correlato')),
  source text not null default 'autocomplete' check (source in ('autocomplete')),
  job_id uuid,
  discovered_at timestamptz not null default now(),
  unique (organization_id, goal, norm),
  foreign key (organization_id, job_id) references public.demand_hunter_jobs (organization_id, id) on delete set null (job_id)
);

-- ─── Statistiche di apprendimento ──────────────────────────────────────────
create table if not exists public.demand_hunter_learning_stats (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  goal text not null check (goal in ('clienti', 'lavoro')),
  dimension text not null check (dimension in ('verbs', 'objects', 'patterns', 'verb_patterns')),
  key text not null check (char_length(key) between 1 and 300),
  searches integer not null default 0 check (searches >= 0),
  posts integer not null default 0 check (posts >= 0),
  leads integer not null default 0 check (leads >= 0),
  confirmed integer not null default 0 check (confirmed >= 0),
  wrong integer not null default 0 check (wrong >= 0),
  rate numeric(8, 3) not null default 0,
  score numeric(8, 3) not null default 0,
  updated_at timestamptz not null default now(),
  unique (organization_id, goal, dimension, key)
);

-- ─── Consumo delle API (registro append-only) ──────────────────────────────
-- reserve: +budget confermato all'avvio; release: −chiamate non usate alla fine del job.
-- Consumo del mese = somma delle quantità in modalità live (le simulate sono registrate ma non costano). Nessun aggiornamento, nessuna cancellazione da parte dei client.
create table if not exists public.demand_hunter_api_usage (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  job_id uuid,
  provider text not null default 'serpapi' check (provider in ('serpapi')),
  kind text not null check (kind in ('reserve', 'release')),
  quantity integer not null check (quantity <> 0 and quantity between -500 and 500),
  mode text not null check (mode in ('simulated', 'live')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, job_id) references public.demand_hunter_jobs (organization_id, id) on delete set null (job_id)
);
create index if not exists demand_hunter_api_usage_org_time_idx on public.demand_hunter_api_usage (organization_id, created_at desc);
create unique index if not exists demand_hunter_api_usage_job_kind_uidx on public.demand_hunter_api_usage (job_id, kind) where job_id is not null;

-- ─── Token di conferma monouso ─────────────────────────────────────────────
-- Il token in chiaro esiste solo nella risposta della stima; qui c'è il suo SHA-256.
-- Legato a utente, organizzazione e azione esatta (obiettivo + seme/area + budget); scade dopo 10 minuti.
create table if not exists public.demand_hunter_confirmations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null check (action in ('hunt', 'expand')),
  action_key text not null check (char_length(action_key) between 3 and 400),
  paid_calls integer not null check (paid_calls between 1 and 500),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index if not exists demand_hunter_confirmations_open_idx on public.demand_hunter_confirmations (organization_id, user_id)
  where consumed_at is null;

-- ─── Trigger: updated_at e organizzazione immutabile ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['demand_hunter_jobs', 'demand_hunter_sessions', 'demand_hunter_combinations', 'demand_hunter_leads',
                           'demand_hunter_intent_classifications', 'demand_hunter_feedback', 'demand_hunter_concepts',
                           'demand_hunter_learning_stats', 'demand_hunter_confirmations']
  loop
    execute format('drop trigger if exists %1$s_org_immutable on public.%1$I', t);
    execute format('create trigger %1$s_org_immutable before update on public.%1$I for each row execute function public.prevent_org_change()', t);
  end loop;
  foreach t in array array['demand_hunter_combinations', 'demand_hunter_leads', 'demand_hunter_feedback',
                           'demand_hunter_learning_stats', 'demand_hunter_limits']
  loop
    execute format('drop trigger if exists %1$s_updated_at on public.%1$I', t);
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- RLS: lettura ai membri dell'organizzazione; nessuna scrittura dai client.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['demand_hunter_limits', 'demand_hunter_jobs', 'demand_hunter_sessions', 'demand_hunter_combinations',
                           'demand_hunter_leads', 'demand_hunter_intent_classifications', 'demand_hunter_feedback',
                           'demand_hunter_concepts', 'demand_hunter_learning_stats', 'demand_hunter_api_usage',
                           'demand_hunter_confirmations']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array array['demand_hunter_limits', 'demand_hunter_jobs', 'demand_hunter_sessions', 'demand_hunter_combinations',
                           'demand_hunter_leads', 'demand_hunter_intent_classifications', 'demand_hunter_feedback',
                           'demand_hunter_concepts', 'demand_hunter_learning_stats', 'demand_hunter_api_usage']
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (private.is_org_member(organization_id))', t);
  end loop;
end $$;
-- demand_hunter_confirmations: nessuna policy, nessun grant ai client (solo service role).

-- ════════════════════════════════════════════════════════════════════════════
-- RPC server-only (service role), invocate dalle Netlify Functions DOPO i controlli di accesso.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function private.demand_hunter_limits_for(p_org uuid)
returns table (enabled boolean, monthly_paid_calls integer, max_budget_per_hunt integer)
language sql stable security definer set search_path = '' as $$
  select coalesce(l.enabled, true), coalesce(l.monthly_paid_calls, 200), coalesce(l.max_budget_per_hunt, 50)
    from (select 1) one
    left join public.demand_hunter_limits l on l.organization_id = p_org;
$$;

-- Consumo e limiti del mese (anche per l'interfaccia, tramite il server).
create or replace function public.demand_hunter_usage_summary(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lim record;
  v_used bigint;
begin
  select * into v_lim from private.demand_hunter_limits_for(p_org);
  select coalesce(sum(quantity), 0) into v_used from public.demand_hunter_api_usage
   where organization_id = p_org and mode = 'live' and created_at >= date_trunc('month', now());
  return jsonb_build_object('enabled', v_lim.enabled, 'monthly_paid_calls', v_lim.monthly_paid_calls,
    'max_budget_per_hunt', v_lim.max_budget_per_hunt, 'used', v_used,
    'remaining', greatest(v_lim.monthly_paid_calls - v_used, 0));
end $$;

-- Consuma un token di conferma: una sola volta, solo per lo stesso utente, organizzazione e azione, entro la scadenza.
create or replace function public.demand_hunter_consume_confirmation(
  p_org uuid, p_user uuid, p_token_hash text, p_action text, p_action_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.demand_hunter_confirmations;
begin
  update public.demand_hunter_confirmations
     set consumed_at = now()
   where token_hash = p_token_hash
     and organization_id = p_org
     and user_id = p_user
     and action = p_action
     and action_key = p_action_key
     and consumed_at is null
     and expires_at > now()
  returning * into v_row;
  if v_row.id is null then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'confirmation_id', v_row.id, 'paid_calls', v_row.paid_calls);
end $$;

-- Prenota il budget confermato sul limite mensile dell'organizzazione (serializzato per organizzazione).
create or replace function public.demand_hunter_reserve(
  p_org uuid, p_user uuid, p_job uuid, p_calls integer, p_mode text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lim record;
  v_used bigint;
begin
  if p_calls < 1 or p_calls > 500 then raise exception 'invalid quantity' using errcode = '22023'; end if;
  select * into v_lim from private.demand_hunter_limits_for(p_org);
  if not v_lim.enabled then
    return jsonb_build_object('allowed', false, 'reason', 'disabled');
  end if;
  if p_calls > v_lim.max_budget_per_hunt then
    return jsonb_build_object('allowed', false, 'reason', 'budget_per_hunt', 'limit', v_lim.max_budget_per_hunt);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':demand_hunter_usage', 0));
  select coalesce(sum(quantity), 0) into v_used from public.demand_hunter_api_usage
   where organization_id = p_org and mode = 'live' and created_at >= date_trunc('month', now());
  -- Le chiamate simulate non costano: registrate, ma fuori dal limite mensile (resta il massimo per caccia).
  if p_mode = 'live' and v_used + p_calls > v_lim.monthly_paid_calls then
    return jsonb_build_object('allowed', false, 'reason', 'monthly_limit', 'used', v_used, 'limit', v_lim.monthly_paid_calls,
      'remaining', greatest(v_lim.monthly_paid_calls - v_used, 0));
  end if;
  insert into public.demand_hunter_api_usage (organization_id, user_id, job_id, kind, quantity, mode)
  values (p_org, p_user, p_job, 'reserve', p_calls, p_mode);
  return jsonb_build_object('allowed', true, 'used', v_used + p_calls, 'limit', v_lim.monthly_paid_calls,
    'remaining', v_lim.monthly_paid_calls - v_used - p_calls);
end $$;

-- Chiude il conto di un job: rilascia le chiamate prenotate e non usate. Idempotente (una sola riga 'release').
create or replace function public.demand_hunter_settle(p_org uuid, p_job uuid, p_spent integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.demand_hunter_jobs;
  v_unused integer;
begin
  select * into v_job from public.demand_hunter_jobs where id = p_job and organization_id = p_org for update;
  if v_job.id is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  if v_job.usage_settled then return jsonb_build_object('settled', true, 'released', 0); end if;
  v_unused := greatest(v_job.reserved_calls - greatest(p_spent, 0), 0);
  if v_unused > 0 then
    insert into public.demand_hunter_api_usage (organization_id, user_id, job_id, kind, quantity, mode)
    values (p_org, v_job.created_by, p_job, 'release', -v_unused, v_job.mode)
    on conflict do nothing;
  end if;
  update public.demand_hunter_jobs set usage_settled = true where id = p_job;
  return jsonb_build_object('settled', true, 'released', v_unused);
end $$;

-- Pulizia: token scaduti da più di un giorno (nessun dato personale, solo hash).
create or replace function public.demand_hunter_purge_confirmations()
returns integer language sql security definer set search_path = '' as $$
  with d as (delete from public.demand_hunter_confirmations where expires_at < now() - interval '1 day' returning 1)
  select count(*)::int from d;
$$;

revoke all on function private.demand_hunter_limits_for(uuid) from public, anon, authenticated;
revoke all on function public.demand_hunter_usage_summary(uuid) from public, anon, authenticated;
revoke all on function public.demand_hunter_consume_confirmation(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.demand_hunter_reserve(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.demand_hunter_settle(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.demand_hunter_purge_confirmations() from public, anon, authenticated;
grant execute on function private.demand_hunter_limits_for(uuid) to service_role;
grant execute on function public.demand_hunter_usage_summary(uuid) to service_role;
grant execute on function public.demand_hunter_consume_confirmation(uuid, uuid, text, text, text) to service_role;
grant execute on function public.demand_hunter_reserve(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.demand_hunter_settle(uuid, uuid, integer) to service_role;
grant execute on function public.demand_hunter_purge_confirmations() to service_role;
