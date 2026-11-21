-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 8: Autonomous Multi-Agent Intelligence Engine (migrazione 0012).
--
-- Tabelle: ai_agents, ai_workflows, ai_workflow_steps, ai_agent_runs, ai_agent_tool_calls,
--          ai_agent_approvals, ai_company_memory, ai_research_evidence, ai_agent_costs.
--
-- Principi:
-- • Migrazione ADDITIVA: nessuna tabella o colonna esistente viene eliminata. Si allargano solo i
--   vincoli CHECK dei compiti AI (nuovo compito "sales_strategy") e si aggiunge un costo in crediti.
-- • Gli utenti LEGGONO tramite RLS (solo la propria organizzazione). Nessuna scrittura diretta:
--   workflow, passi, esecuzioni, tool call, evidenze e costi sono scritti solo dal server (service role)
--   dopo i controlli di autorizzazione; approvazioni, annullamento, memoria e configurazione passano da
--   RPC SECURITY DEFINER che verificano ruolo e organizzazione.
-- • Gli agenti (service role, senza auth.uid()) NON possono configurare agenti, decidere approvazioni né
--   cancellare memoria: queste RPC richiedono un utente autenticato con il ruolo adeguato.
-- • I crediti AI restano legati a public.ai_jobs (trigger di billing esistenti): ogni chiamata AI di un
--   agente crea un job e quindi prenota/consuma crediti del piano e rispetta i tetti di spesa USD.
-- • Una evidenza di tipo FACT richiede per vincolo una fonte verificabile e un estratto.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Compito AI della Strategy Agent e relativo costo in crediti ───────────
alter table public.ai_jobs drop constraint ai_jobs_task_check;
alter table public.ai_jobs add constraint ai_jobs_task_check check (task is null or task in
  ('business_analysis', 'intelligence', 'messages', 'proposal', 'follow_up_suggestion', 'copilot', 'campaign_content',
   'inbound_analysis', 'sales_strategy'));

alter table public.ai_credit_costs drop constraint ai_credit_costs_ai_task_check;
alter table public.ai_credit_costs add constraint ai_credit_costs_ai_task_check check (ai_task is null or ai_task in
  ('business_analysis', 'intelligence', 'messages', 'proposal', 'follow_up_suggestion', 'copilot', 'campaign_content',
   'inbound_analysis', 'sales_strategy'));

-- Valore PROVVISORIO, modificabile dal super admin (admin_update_credit_cost), come gli altri costi.
insert into public.ai_credit_costs (operation, ai_task, credits, feature, description) values
  ('agent_sales_strategy', 'sales_strategy', 2, 'ai_sales_agent', 'Strategia commerciale AI per un lead (AI Sales Strategy Agent)')
on conflict (operation) do nothing;

-- ─── Agenti riconosciuti ───────────────────────────────────────────────────
create or replace function private.ai_agent_keys()
returns text[] language sql immutable set search_path = '' as $$
  select array['orchestrator', 'discovery', 'research', 'scoring', 'strategy', 'follow_up', 'growth_analyst']::text[];
$$;

create or replace function private.ai_jsonb_small(p jsonb, p_max integer)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object' and pg_column_size(p) <= p_max;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. ai_agents: configurazione per organizzazione (assenza di riga = valori predefiniti)
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_agents (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_key text not null check (agent_key = any (private.ai_agent_keys())),
  enabled boolean not null default true,
  model_tier text not null default 'standard' check (model_tier in ('economy', 'standard', 'advanced')),
  -- Per "orchestrator" è il budget mensile complessivo degli agenti dell'organizzazione (crediti).
  monthly_credit_budget integer check (monthly_credit_budget is null or monthly_credit_budget between 0 and 1000000),
  max_credits_per_run integer check (max_credits_per_run is null or max_credits_per_run between 0 and 10000),
  config jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(config, 4096)),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, agent_key)
);
create trigger ai_agents_updated_at before update on public.ai_agents
  for each row execute function public.set_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. ai_workflows
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  template text not null check (template in ('prospecting', 'follow_up_review', 'growth_report')),
  objective text check (objective is null or char_length(objective) <= 1000),
  params jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(params, 16384)),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  budget_credits integer not null check (budget_credits between 0 and 5000),
  credits_used integer not null default 0 check (credits_used >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  max_runtime_seconds integer not null default 1800 check (max_runtime_seconds between 60 and 7200),
  deadline_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by uuid references auth.users (id) on delete set null,
  lock_token uuid,
  locked_until timestamptz,
  resume_count integer not null default 0 check (resume_count >= 0),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{2,80}$'),
  report jsonb check (report is null or private.ai_jsonb_small(report, 65536)),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, idempotency_key)
);
create index ai_workflows_org_created_idx on public.ai_workflows (organization_id, created_at desc);
create index ai_workflows_resumable_idx on public.ai_workflows (status, locked_until) where status in ('pending', 'running');
create trigger ai_workflows_updated_at before update on public.ai_workflows
  for each row execute function public.set_updated_at();
create trigger ai_workflows_org_immutable before update on public.ai_workflows
  for each row execute function public.prevent_org_change();

-- Gli stati finali sono definitivi: un workflow concluso non può essere riattivato.
create or replace function private.ai_workflows_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status in ('completed', 'partial', 'failed', 'cancelled') and new.status is distinct from old.status then
    raise exception 'workflow_finalized' using errcode = 'P0001';
  end if;
  if new.template is distinct from old.template or new.budget_credits is distinct from old.budget_credits
     or new.idempotency_key is distinct from old.idempotency_key or new.created_by is distinct from old.created_by then
    raise exception 'workflow_immutable_field' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger ai_workflows_guard before update on public.ai_workflows
  for each row execute function private.ai_workflows_guard();

-- Audit di creazione e cambi di stato (senza parametri né contenuti).
create or replace function private.ai_workflows_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
    values (new.organization_id, coalesce(auth.uid(), new.created_by), 'ai_workflow.created', 'ai_workflow', new.id::text,
            jsonb_build_object('template', new.template, 'budget_credits', new.budget_credits));
  elsif new.status is distinct from old.status then
    insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
    values (new.organization_id, auth.uid(), 'ai_workflow.status', 'ai_workflow', new.id::text,
            jsonb_strip_nulls(jsonb_build_object('from', old.status, 'to', new.status, 'error_code', new.error_code,
              'credits_used', new.credits_used)));
  end if;
  return new;
end $$;
create trigger ai_workflows_audit after insert or update on public.ai_workflows
  for each row execute function private.ai_workflows_audit();

-- ════════════════════════════════════════════════════════════════════════════
-- 3. ai_workflow_steps
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_workflow_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid not null,
  position smallint not null check (position between 1 and 20),
  agent_key text not null check (agent_key = any (private.ai_agent_keys())),
  action text not null check (action ~ '^[a-z][a-z_.]{2,60}$'),
  depends_on smallint[] not null default '{}' check (cardinality(depends_on) <= 20),
  requires_approval boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting_approval', 'completed', 'skipped', 'failed', 'cancelled')),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 2 check (max_attempts between 1 and 5),
  timeout_seconds integer not null default 600 check (timeout_seconds between 10 and 3600),
  input jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(input, 16384)),
  output jsonb check (output is null or private.ai_jsonb_small(output, 262144)),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{2,80}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (workflow_id, position),
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade
);
create index ai_workflow_steps_wf_idx on public.ai_workflow_steps (workflow_id, position);
create trigger ai_workflow_steps_updated_at before update on public.ai_workflow_steps
  for each row execute function public.set_updated_at();
create trigger ai_workflow_steps_org_immutable before update on public.ai_workflow_steps
  for each row execute function public.prevent_org_change();

-- ════════════════════════════════════════════════════════════════════════════
-- 4. ai_agent_runs (un'esecuzione = un tentativo di un passo, o un'operazione isolata)
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid,
  step_id uuid,
  agent_key text not null check (agent_key = any (private.ai_agent_keys())),
  attempt smallint not null default 1 check (attempt between 1 and 10),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed', 'cancelled', 'timed_out')),
  input_summary jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(input_summary, 8192)),
  output jsonb check (output is null or private.ai_jsonb_small(output, 262144)),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{2,80}$'),
  items_total integer not null default 0 check (items_total >= 0),
  items_failed integer not null default 0 check (items_failed >= 0),
  credits_used integer not null default 0 check (credits_used >= 0),
  tokens_input integer not null default 0 check (tokens_input >= 0),
  tokens_output integer not null default 0 check (tokens_output >= 0),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  model text check (model is null or char_length(model) <= 120),
  created_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade,
  foreign key (organization_id, step_id) references public.ai_workflow_steps (organization_id, id) on delete cascade
);
-- Idempotenza: un solo run per tentativo di passo.
create unique index ai_agent_runs_step_attempt_uidx on public.ai_agent_runs (step_id, attempt) where step_id is not null;
create index ai_agent_runs_org_time_idx on public.ai_agent_runs (organization_id, started_at desc);
create index ai_agent_runs_org_agent_idx on public.ai_agent_runs (organization_id, agent_key, started_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. ai_agent_tool_calls (registro append-only delle chiamate ai tool, anche quelle negate)
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_agent_tool_calls (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  run_id uuid,
  workflow_id uuid,
  agent_key text not null check (agent_key = any (private.ai_agent_keys())),
  tool text not null check (tool ~ '^[a-z][a-z_.]{2,60}$'),
  outcome text not null check (outcome in ('succeeded', 'failed', 'denied')),
  denied_reason text check (denied_reason is null or denied_reason ~ '^[a-z0-9_]{2,80}$'),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{2,80}$'),
  args_summary jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(args_summary, 4096)),
  result_summary jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(result_summary, 4096)),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  foreign key (organization_id, run_id) references public.ai_agent_runs (organization_id, id) on delete cascade,
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade
);
create index ai_agent_tool_calls_run_idx on public.ai_agent_tool_calls (run_id, id);
create index ai_agent_tool_calls_org_time_idx on public.ai_agent_tool_calls (organization_id, created_at desc);

create or replace function private.ai_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'append_only' using errcode = '42501';
end $$;
create trigger ai_agent_tool_calls_append_only before update on public.ai_agent_tool_calls
  for each row execute function private.ai_append_only();

-- ════════════════════════════════════════════════════════════════════════════
-- 6. ai_agent_approvals
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_agent_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid not null,
  step_id uuid not null,
  action text not null check (action ~ '^[a-z][a-z_.]{2,60}$'),
  summary jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(summary, 16384)),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '72 hours',
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  unique (organization_id, id),
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade,
  foreign key (organization_id, step_id) references public.ai_workflow_steps (organization_id, id) on delete cascade,
  check (expires_at > requested_at)
);
create unique index ai_agent_approvals_one_pending_uidx on public.ai_agent_approvals (step_id) where status = 'pending';
create index ai_agent_approvals_org_status_idx on public.ai_agent_approvals (organization_id, status, requested_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. ai_company_memory (versionata, con scadenza, isolata per organizzazione)
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_company_memory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  category text not null check (category in ('commercial_profile', 'products', 'services', 'ideal_customer',
    'communication_preferences', 'approved_strategies', 'campaign_results', 'user_feedback')),
  entry_key text not null check (entry_key ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
  version integer not null check (version >= 1),
  content jsonb not null check (private.ai_jsonb_small(content, 16384)),
  status text not null default 'active' check (status in ('active', 'superseded')),
  source text not null check (source in ('user', 'agent_approved', 'system')),
  expires_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, category, entry_key, version)
);
create unique index ai_company_memory_active_uidx on public.ai_company_memory (organization_id, category, entry_key) where status = 'active';
create index ai_company_memory_org_idx on public.ai_company_memory (organization_id, category, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 8. ai_research_evidence (FACT / INFERENCE / UNKNOWN)
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_research_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid,
  run_id uuid,
  subject_type text not null check (subject_type in ('candidate', 'lead')),
  subject_id uuid not null,
  category text not null check (category in ('profile', 'sector', 'products_services', 'digital_presence', 'signal',
    'opportunity', 'fit', 'missing')),
  kind text not null check (kind in ('fact', 'inference', 'unknown')),
  statement text not null check (char_length(btrim(statement)) between 1 and 1000),
  evidence text check (evidence is null or char_length(evidence) <= 1000),
  source_type text not null check (source_type in ('provider', 'website', 'crm', 'ai', 'none')),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  observed_at timestamptz,
  rationale text check (rationale is null or char_length(rationale) <= 1000),
  created_at timestamptz not null default now(),
  -- Un FACT ha sempre una fonte verificabile e un estratto; un UNKNOWN non ha fonte; un'INFERENCE è dell'AI.
  check (kind <> 'fact' or (source_type in ('provider', 'website', 'crm') and coalesce(btrim(evidence), '') <> '')),
  check (kind <> 'unknown' or source_type = 'none'),
  check (kind <> 'inference' or source_type = 'ai'),
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references public.ai_agent_runs (organization_id, id) on delete set null (run_id)
);
create index ai_research_evidence_subject_idx on public.ai_research_evidence (organization_id, subject_type, subject_id, created_at desc);
create index ai_research_evidence_wf_idx on public.ai_research_evidence (workflow_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 9. ai_agent_costs (registro append-only dei consumi degli agenti)
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_agent_costs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid,
  run_id uuid,
  agent_key text not null check (agent_key = any (private.ai_agent_keys())),
  kind text not null check (kind in ('ai_tokens', 'provider_call')),
  ai_job_id uuid,
  model text check (model is null or char_length(model) <= 120),
  tokens_input integer not null default 0 check (tokens_input >= 0),
  tokens_output integer not null default 0 check (tokens_output >= 0),
  credits integer not null default 0 check (credits >= 0),
  -- NULL = prezzo del modello/provider non configurato (nessun prezzo inventato).
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  cache_hit boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade,
  -- cascade (non "set null"): il registro è append-only e non ammette UPDATE.
  foreign key (organization_id, run_id) references public.ai_agent_runs (organization_id, id) on delete cascade
);
create index ai_agent_costs_org_time_idx on public.ai_agent_costs (organization_id, created_at desc);
create trigger ai_agent_costs_append_only before update on public.ai_agent_costs
  for each row execute function private.ai_append_only();

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Privilegi e RLS: lettura per i membri della stessa organizzazione, nessuna scrittura diretta
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.ai_agents, public.ai_workflows, public.ai_workflow_steps, public.ai_agent_runs,
  public.ai_agent_tool_calls, public.ai_agent_approvals, public.ai_company_memory, public.ai_research_evidence,
  public.ai_agent_costs from anon, authenticated;
grant select on public.ai_agents, public.ai_workflows, public.ai_workflow_steps, public.ai_agent_runs,
  public.ai_agent_tool_calls, public.ai_agent_approvals, public.ai_company_memory, public.ai_research_evidence,
  public.ai_agent_costs to authenticated;
-- Il ruolo service role non cancella righe dei registri: il registro resta consultabile per l'audit.
revoke update, delete, truncate on public.ai_agent_tool_calls, public.ai_agent_costs from service_role;

alter table public.ai_agents enable row level security;
alter table public.ai_workflows enable row level security;
alter table public.ai_workflow_steps enable row level security;
alter table public.ai_agent_runs enable row level security;
alter table public.ai_agent_tool_calls enable row level security;
alter table public.ai_agent_approvals enable row level security;
alter table public.ai_company_memory enable row level security;
alter table public.ai_research_evidence enable row level security;
alter table public.ai_agent_costs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ai_agents', 'ai_workflows', 'ai_workflow_steps', 'ai_agent_runs', 'ai_agent_tool_calls',
                           'ai_agent_approvals', 'ai_research_evidence', 'ai_agent_costs']
  loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (private.is_org_member(organization_id))', t);
  end loop;
end $$;
-- La memoria scaduta non è più leggibile né utilizzabile (la rimozione fisica è manuale, vedi sotto).
create policy ai_company_memory_select on public.ai_company_memory for select to authenticated
  using (private.is_org_member(organization_id) and expires_at > now());

-- ════════════════════════════════════════════════════════════════════════════
-- 11. RPC per gli utenti (verificano ruolo e organizzazione)
-- ════════════════════════════════════════════════════════════════════════════

-- Configurazione di un agente: solo amministratori dell'organizzazione, mai il server da solo.
create or replace function public.ai_agent_configure(p_org uuid, p_agent text, p_patch jsonb)
returns public.ai_agents language plpgsql security definer set search_path = '' as $$
declare
  r public.ai_agents;
  k text;
  v_cfg jsonb;
begin
  if auth.uid() is null or not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not (p_agent = any (private.ai_agent_keys())) then raise exception 'unknown_agent' using errcode = '22023'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid_patch' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled', 'model_tier', 'monthly_credit_budget', 'max_credits_per_run', 'config') then
      raise exception 'invalid_field' using errcode = '22023', detail = k;
    end if;
  end loop;
  -- Chiavi di configurazione ammesse (intervalli verificati anche lato server).
  v_cfg := coalesce(p_patch -> 'config', '{}'::jsonb);
  if jsonb_typeof(v_cfg) <> 'object' then raise exception 'invalid_config' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(v_cfg) loop
    if k not in ('history_weight', 'min_history_sample', 'cache_days', 'stale_days', 'opportunity_stale_days', 'max_tasks') then
      raise exception 'invalid_config_key' using errcode = '22023', detail = k;
    end if;
    if jsonb_typeof(v_cfg -> k) <> 'number' or (v_cfg ->> k)::numeric < 0 or (v_cfg ->> k)::numeric > 365 then
      raise exception 'invalid_config_value' using errcode = '22023', detail = k;
    end if;
  end loop;

  insert into public.ai_agents (organization_id, agent_key, updated_by) values (p_org, p_agent, auth.uid())
  on conflict (organization_id, agent_key) do nothing;
  update public.ai_agents set
    enabled = coalesce((p_patch ->> 'enabled')::boolean, enabled),
    model_tier = coalesce(p_patch ->> 'model_tier', model_tier),
    monthly_credit_budget = case when p_patch ? 'monthly_credit_budget' then (p_patch ->> 'monthly_credit_budget')::int else monthly_credit_budget end,
    max_credits_per_run = case when p_patch ? 'max_credits_per_run' then (p_patch ->> 'max_credits_per_run')::int else max_credits_per_run end,
    config = case when p_patch ? 'config' then config || v_cfg else config end,
    updated_by = auth.uid()
  where organization_id = p_org and agent_key = p_agent
  returning * into r;
  perform private.write_audit(p_org, 'ai_agent.configured', 'ai_agent', p_agent, jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
  return r;
end $$;

-- Decisione su un'operazione ad alto impatto: solo amministratori, solo approvazioni in attesa e non scadute.
create or replace function public.ai_agent_decide_approval(p_approval uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.ai_agent_approvals;
  w public.ai_workflows;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'reject') then raise exception 'invalid_decision' using errcode = '22023'; end if;
  select * into a from public.ai_agent_approvals where id = p_approval for update;
  -- Stessa risposta per approvazione inesistente o di un'altra organizzazione.
  if a.id is null or not private.is_org_member(a.organization_id) then raise exception 'approval_not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(a.organization_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if a.status <> 'pending' then raise exception 'approval_not_pending' using errcode = 'P0001'; end if;
  select * into w from public.ai_workflows where id = a.workflow_id for update;
  if a.expires_at <= now() then
    update public.ai_agent_approvals set status = 'expired' where id = a.id;
    raise exception 'approval_expired' using errcode = 'P0001';
  end if;
  if w.status <> 'waiting_approval' or w.cancel_requested_at is not null then
    raise exception 'workflow_not_waiting' using errcode = 'P0001';
  end if;

  update public.ai_agent_approvals
     set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = left(nullif(btrim(p_note), ''), 500)
   where id = a.id;
  if p_decision = 'approve' then
    update public.ai_workflow_steps set status = 'pending',
           input = input || jsonb_build_object('approval_id', a.id, 'approved_by', auth.uid())
     where id = a.step_id;
  else
    update public.ai_workflow_steps set status = 'skipped', error_code = 'approval_rejected', completed_at = now()
     where id = a.step_id;
  end if;
  -- Il motore riprende il workflow (stato "pending" = pronto per essere ripreso).
  update public.ai_workflows set status = 'pending', locked_until = null, lock_token = null where id = w.id;
  perform private.write_audit(a.organization_id, 'ai_approval.' || case when p_decision = 'approve' then 'approved' else 'rejected' end,
    'ai_agent_approval', a.id::text, jsonb_build_object('workflow_id', a.workflow_id, 'action', a.action));
  return jsonb_build_object('workflow_id', w.id, 'approval_id', a.id, 'decision', p_decision);
end $$;

-- Interruzione: chi ha avviato il workflow o un amministratore.
create or replace function public.ai_workflow_request_cancel(p_workflow uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w public.ai_workflows;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into w from public.ai_workflows where id = p_workflow for update;
  if w.id is null or not private.is_org_member(w.organization_id) then raise exception 'workflow_not_found' using errcode = 'P0002'; end if;
  if w.created_by is distinct from auth.uid() and not private.is_org_admin(w.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if w.status in ('completed', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object('workflow_id', w.id, 'status', w.status, 'changed', false);
  end if;
  if w.status in ('pending', 'waiting_approval') then
    -- Nessuna esecuzione in corso: annullamento immediato.
    update public.ai_agent_approvals set status = 'cancelled' where workflow_id = w.id and status = 'pending';
    update public.ai_workflow_steps set status = 'cancelled', completed_at = now()
     where workflow_id = w.id and status in ('pending', 'waiting_approval');
    update public.ai_workflows set status = 'cancelled', cancel_requested_at = now(), cancel_requested_by = auth.uid(),
           error_code = 'cancelled_by_user', completed_at = now(), lock_token = null, locked_until = null
     where id = w.id;
    return jsonb_build_object('workflow_id', w.id, 'status', 'cancelled', 'changed', true);
  end if;
  -- In esecuzione: il motore si ferma al primo punto di controllo (prima della prossima operazione).
  update public.ai_workflows set cancel_requested_at = coalesce(cancel_requested_at, now()), cancel_requested_by = auth.uid()
   where id = w.id;
  perform private.write_audit(w.organization_id, 'ai_workflow.cancel_requested', 'ai_workflow', w.id::text, '{}'::jsonb);
  return jsonb_build_object('workflow_id', w.id, 'status', 'running', 'changed', true, 'cancel_requested', true);
end $$;

-- Memoria aziendale: nuova versione (le versioni precedenti restano consultabili come "superseded").
create or replace function public.ai_memory_upsert(p_org uuid, p_category text, p_entry_key text, p_content jsonb, p_retention_days integer default 365)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_version int;
  v_id uuid;
begin
  if auth.uid() is null or not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- I membri possono lasciare solo feedback; il resto della memoria è gestito dagli amministratori.
  if p_category <> 'user_feedback' and not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_category = 'campaign_results' then
    -- I risultati delle campagne sono misurati e scritti solo dal server.
    raise exception 'category_server_only' using errcode = '22023';
  end if;
  -- "approved_strategies": il salvataggio da parte di un amministratore È l'approvazione esplicita
  -- della strategia (gli agenti non scrivono mai in questa categoria da soli).
  if p_retention_days is null or p_retention_days < 1 or p_retention_days > 1095 then
    raise exception 'invalid_retention' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = p_org for update;
  select coalesce(max(version), 0) + 1 into v_version from public.ai_company_memory
   where organization_id = p_org and category = p_category and entry_key = p_entry_key;
  update public.ai_company_memory set status = 'superseded'
   where organization_id = p_org and category = p_category and entry_key = p_entry_key and status = 'active';
  insert into public.ai_company_memory (organization_id, category, entry_key, version, content, status, source, expires_at, created_by)
  values (p_org, p_category, p_entry_key, v_version, p_content, 'active', 'user', now() + make_interval(days => p_retention_days), auth.uid())
  returning id into v_id;
  perform private.write_audit(p_org, 'ai_memory.upserted', 'ai_company_memory', v_id::text,
    jsonb_build_object('category', p_category, 'entry_key', p_entry_key, 'version', v_version));
  return jsonb_build_object('id', v_id, 'version', v_version);
end $$;

-- Cancellazione di una voce (tutte le versioni): solo amministratori. L'audit non conserva il contenuto.
create or replace function public.ai_memory_delete(p_org uuid, p_category text, p_entry_key text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if auth.uid() is null or not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.ai_company_memory where organization_id = p_org and category = p_category and entry_key = p_entry_key;
  get diagnostics n = row_count;
  perform private.write_audit(p_org, 'ai_memory.deleted', 'ai_company_memory', p_category || ':' || p_entry_key,
    jsonb_build_object('versions_deleted', n));
  return n;
end $$;

-- Scrittura da parte del server (solo dopo un'approvazione esplicita o da risultati misurati).
create or replace function public.ai_memory_record(p_org uuid, p_category text, p_entry_key text, p_content jsonb,
  p_actor uuid, p_approval uuid default null, p_retention_days integer default 365)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_version int;
  v_id uuid;
begin
  if p_category not in ('approved_strategies', 'campaign_results') then raise exception 'category_not_allowed' using errcode = '22023'; end if;
  if p_category = 'approved_strategies' and not exists (
       select 1 from public.ai_agent_approvals where id = p_approval and organization_id = p_org and status = 'approved') then
    raise exception 'approval_required' using errcode = 'P0001';
  end if;
  perform 1 from public.organizations where id = p_org for update;
  select coalesce(max(version), 0) + 1 into v_version from public.ai_company_memory
   where organization_id = p_org and category = p_category and entry_key = p_entry_key;
  update public.ai_company_memory set status = 'superseded'
   where organization_id = p_org and category = p_category and entry_key = p_entry_key and status = 'active';
  insert into public.ai_company_memory (organization_id, category, entry_key, version, content, status, source, expires_at, created_by)
  values (p_org, p_category, p_entry_key, v_version, p_content, 'active', 'agent_approved',
          now() + make_interval(days => greatest(1, least(coalesce(p_retention_days, 365), 1095))), p_actor)
  returning id into v_id;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org, p_actor, 'ai_memory.recorded', 'ai_company_memory', v_id::text,
          jsonb_strip_nulls(jsonb_build_object('category', p_category, 'entry_key', p_entry_key, 'version', v_version, 'approval_id', p_approval)));
  return jsonb_build_object('id', v_id, 'version', v_version);
end $$;

-- Rimozione fisica della memoria scaduta: SOLO service role e NON pianificata (decisione del titolare,
-- come per la conservazione dei dati del Prompt 7). La memoria scaduta è già esclusa da letture e agenti.
create or replace function public.ai_memory_purge_expired()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  delete from public.ai_company_memory where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Spesa degli agenti nel periodo (crediti e USD stimati), per il budget mensile e la console.
create or replace function public.ai_agent_spend(p_org uuid, p_from timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'credits', (select coalesce(sum(credits), 0) from public.ai_agent_costs where organization_id = p_org and created_at >= p_from),
    'cost_usd', (select round(coalesce(sum(cost_usd), 0), 6) from public.ai_agent_costs where organization_id = p_org and created_at >= p_from),
    'cost_unpriced_calls', (select count(*) from public.ai_agent_costs where organization_id = p_org and created_at >= p_from
                              and cost_usd is null and kind = 'ai_tokens' and not cache_hit),
    'by_agent', coalesce((select jsonb_object_agg(agent_key, jsonb_build_object('credits', c, 'cost_usd', u)) from (
        select agent_key, sum(credits) c, round(coalesce(sum(cost_usd), 0), 6) u from public.ai_agent_costs
         where organization_id = p_org and created_at >= p_from group by agent_key) s), '{}'::jsonb)
  );
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Metriche per il Growth Analyst (solo dati della propria organizzazione)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.ai_growth_metrics(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ai_cost numeric;
  v_ai_unpriced int;
  v_provider_cost numeric;
  v_provider_unpriced int;
  v_leads int;
begin
  if auth.uid() is not null and not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
  select count(*) into v_leads from public.leads where organization_id = p_org and deleted_at is null and created_at >= p_from and created_at < p_to;
  select coalesce(sum(cost_usd), 0), count(*) filter (where cost_usd is null and coalesce(tokens_input, 0) + coalesce(tokens_output, 0) > 0)
    into v_ai_cost, v_ai_unpriced
    from public.ai_jobs where organization_id = p_org and status = 'succeeded' and created_at >= p_from and created_at < p_to;
  select coalesce(sum(cost_usd), 0), count(*) filter (where cost_usd is null)
    into v_provider_cost, v_provider_unpriced
    from public.usage_ledger where organization_id = p_org and kind = 'provider_call' and created_at >= p_from and created_at < p_to;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'leads_acquired', v_leads,
    'leads_qualified', (select count(*) from public.leads where organization_id = p_org and deleted_at is null
        and created_at >= p_from and created_at < p_to
        and status in ('qualified', 'to_contact', 'contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation', 'won')),
    'leads_contactable', (select count(*) from public.leads where organization_id = p_org and deleted_at is null
        and created_at >= p_from and created_at < p_to and contact_status = 'active' and status <> 'not_contactable'),
    'leads_contacted', (select count(*) from public.leads where organization_id = p_org and deleted_at is null
        and created_at >= p_from and created_at < p_to
        and status in ('contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation', 'won', 'lost')),
    'responses', (select count(distinct coalesce(lead_id::text, from_email)) from public.inbound_messages
        where organization_id = p_org and received_at >= p_from and received_at < p_to),
    'appointments', (select count(*) from public.appointments where organization_id = p_org and status <> 'cancelled'
        and created_at >= p_from and created_at < p_to),
    'opportunities', (select count(*) from public.sales_opportunities where organization_id = p_org and created_at >= p_from and created_at < p_to),
    'customers_won', (select count(*) from public.sales_opportunities where organization_id = p_org and status = 'won'
        and closed_at >= p_from and closed_at < p_to),
    'revenue_attributed', coalesce((select jsonb_object_agg(currency, total) from (
        select currency, round(sum(coalesce(value_amount, 0)), 2) total from public.sales_opportunities
         where organization_id = p_org and status = 'won' and closed_at >= p_from and closed_at < p_to group by currency) r), '{}'::jsonb),
    'won_without_value', (select count(*) from public.sales_opportunities where organization_id = p_org and status = 'won'
        and closed_at >= p_from and closed_at < p_to and value_amount is null),
    'ai_cost_usd', round(v_ai_cost, 6),
    'ai_cost_unpriced_jobs', v_ai_unpriced,
    'provider_cost_usd', round(v_provider_cost, 6),
    'provider_cost_unpriced_calls', v_provider_unpriced,
    'cost_per_lead_usd', case when v_leads > 0 and v_ai_unpriced = 0 and v_provider_unpriced = 0
                              then round((v_ai_cost + v_provider_cost) / v_leads, 4) end,
    'by_sector', coalesce((select jsonb_agg(s order by s.leads desc) from (
        select coalesce(nullif(lower(btrim(l.industry)), ''), 'n/d') as sector,
               count(*) as leads,
               count(*) filter (where l.status in ('contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation', 'won', 'lost')) as contacted,
               count(*) filter (where exists (select 1 from public.appointments a where a.organization_id = p_org and a.lead_id = l.id and a.status <> 'cancelled')) as with_appointment,
               count(*) filter (where l.status = 'won') as won
          from public.leads l
         where l.organization_id = p_org and l.deleted_at is null and l.created_at >= p_from and l.created_at < p_to
         group by 1 order by 2 desc limit 25) s), '[]'::jsonb)
  );
end $$;

-- ─── Esecuzione delle funzioni ─────────────────────────────────────────────
revoke all on function public.ai_agent_configure(uuid, text, jsonb), public.ai_agent_decide_approval(uuid, text, text),
  public.ai_workflow_request_cancel(uuid), public.ai_memory_upsert(uuid, text, text, jsonb, integer),
  public.ai_memory_delete(uuid, text, text), public.ai_memory_record(uuid, text, text, jsonb, uuid, uuid, integer),
  public.ai_memory_purge_expired(), public.ai_agent_spend(uuid, timestamptz), public.ai_growth_metrics(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.ai_agent_configure(uuid, text, jsonb), public.ai_agent_decide_approval(uuid, text, text),
  public.ai_workflow_request_cancel(uuid), public.ai_memory_upsert(uuid, text, text, jsonb, integer),
  public.ai_memory_delete(uuid, text, text), public.ai_agent_spend(uuid, timestamptz), public.ai_growth_metrics(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
revoke all on function public.ai_memory_record(uuid, text, text, jsonb, uuid, uuid, integer), public.ai_memory_purge_expired() from authenticated;
grant execute on function public.ai_memory_record(uuid, text, text, jsonb, uuid, uuid, integer), public.ai_memory_purge_expired() to service_role;

revoke all on function private.ai_workflows_guard(), private.ai_workflows_audit(), private.ai_append_only() from public, anon, authenticated;
grant execute on function private.ai_agent_keys(), private.ai_jsonb_small(jsonb, integer) to authenticated, service_role;
