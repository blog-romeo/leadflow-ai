-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 12: framework di valutazione, versioni di configurazione degli agenti,
-- feedback umano validato, memoria aziendale ampliata con minimizzazione dei dati.
-- Migrazione ADDITIVA (nessun dato rimosso; un vincolo CHECK ampliato; nuove tabelle e funzioni).
--
-- Principi:
--  • nessun aggiornamento automatico di pesi o prompt: una configurazione diventa attiva solo con
--    l'approvazione di un Super Admin legata a un benchmark superato (gate), con rollback immediato;
--  • il feedback di un'organizzazione resta nell'organizzazione (memoria isolata): le configurazioni di
--    piattaforma si valutano solo su dataset sintetici o autorizzati, mai sui dati dei clienti;
--  • nessun fine-tuning avviato dal sistema: un modello fine-tuned può solo essere REGISTRATO a mano,
--    con riferimento all'approvazione dei costi.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Memoria aziendale: categorie e minimizzazione ───────────────────────
alter table public.ai_company_memory drop constraint ai_company_memory_category_check;
alter table public.ai_company_memory add constraint ai_company_memory_category_check check (category in ('commercial_profile', 'products',
  'services', 'ideal_customer', 'communication_preferences', 'approved_strategies', 'campaign_results', 'user_feedback',
  -- Prompt 12
  'target_sectors', 'approved_feedback'));

-- Minimizzazione: la memoria descrive l'azienda cliente e le sue preferenze, non persone. Email e numeri di
-- telefono non vengono memorizzati (si trovano già, con base giuridica, nel CRM).
create or replace function private.ai_memory_minimize()
returns trigger language plpgsql set search_path = '' as $$
declare v text := new.content::text;
begin
  if v ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then raise exception 'memory_contains_personal_data' using errcode = '22023', detail = 'email'; end if;
  -- Numeri di telefono: sequenze di 9–15 cifre (con spazi, punti o trattini). UUID e date non rientrano.
  if exists (select 1 from regexp_matches(v, '\+?[0-9][0-9 .-]{7,}[0-9]', 'g') m
              where length(regexp_replace(m[1], '[^0-9]', '', 'g')) between 9 and 15 and m[1] !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') then
    raise exception 'memory_contains_personal_data' using errcode = '22023', detail = 'phone';
  end if;
  return new;
end $$;
create trigger ai_company_memory_minimize before insert on public.ai_company_memory
  for each row execute function private.ai_memory_minimize();
revoke all on function private.ai_memory_minimize() from public, anon, authenticated;

-- ─── 2. Feedback umano sugli output degli agenti (per organizzazione) ────────
create table public.ai_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid,
  run_id uuid,
  agent_key text not null check (agent_key = any (private.ai_agent_keys())),
  -- Elemento valutato: lead o candidato (riferimento, nessun contenuto copiato).
  subject_type text not null check (subject_type in ('lead', 'candidate', 'workflow')),
  subject_id uuid not null,
  rating smallint not null check (rating in (-1, 0, 1)),
  -- Correzione strutturata proposta dall'utente (es. priorità corretta, servizio corretto).
  correction jsonb not null default '{}'::jsonb check (private.ai_jsonb_small(correction, 4096)),
  comment text check (comment is null or char_length(comment) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'validated', 'rejected')),
  -- Consenso dell'amministratore a usarlo come esempio NELLA SOLA organizzazione (memoria few-shot isolata).
  use_as_org_example boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  foreign key (organization_id, workflow_id) references public.ai_workflows (organization_id, id) on delete cascade
);
create index ai_feedback_org_status_idx on public.ai_feedback (organization_id, status, created_at desc);
alter table public.ai_feedback enable row level security;
revoke all on public.ai_feedback from anon;
revoke insert, update, delete, truncate, references, trigger on public.ai_feedback from authenticated;
create policy ai_feedback_select on public.ai_feedback for select to authenticated using (private.is_org_member(organization_id));

create or replace function public.ai_feedback_submit(p_org uuid, p_agent text, p_subject_type text, p_subject uuid, p_rating integer,
  p_correction jsonb default '{}'::jsonb, p_comment text default null, p_workflow uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_workflow is not null and not exists (select 1 from public.ai_workflows where id = p_workflow and organization_id = p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if (select count(*) from public.ai_feedback where organization_id = p_org and created_by = auth.uid() and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.ai_feedback (organization_id, workflow_id, agent_key, subject_type, subject_id, rating, correction, comment, created_by)
  values (p_org, p_workflow, p_agent, p_subject_type, p_subject, p_rating, coalesce(p_correction, '{}'::jsonb), nullif(btrim(p_comment), ''), auth.uid())
  returning id into v_id;
  perform private.write_audit(p_org, 'ai_feedback.submitted', 'ai_feedback', v_id::text, jsonb_build_object('agent', p_agent, 'rating', p_rating));
  return v_id;
end $$;

-- Validazione (amministratore): un feedback validato con consenso diventa un esempio nella memoria
-- dell'organizzazione (categoria approved_feedback, con scadenza). Mai condiviso con altre organizzazioni.
create or replace function public.ai_feedback_review(p_feedback uuid, p_decision text, p_use_as_example boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.ai_feedback;
  v_version int;
begin
  select * into f from public.ai_feedback where id = p_feedback for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if auth.uid() is null or not private.is_org_admin(f.organization_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if f.status <> 'pending' then raise exception 'feedback_not_pending' using errcode = 'P0001'; end if;
  if p_decision not in ('validate', 'reject') then raise exception 'invalid_decision' using errcode = '22023'; end if;
  update public.ai_feedback set status = case when p_decision = 'validate' then 'validated' else 'rejected' end,
         use_as_org_example = (p_decision = 'validate' and coalesce(p_use_as_example, false)), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_feedback;
  if p_decision = 'validate' and coalesce(p_use_as_example, false) then
    select coalesce(max(version), 0) + 1 into v_version from public.ai_company_memory
     where organization_id = f.organization_id and category = 'approved_feedback' and entry_key = 'fb:' || f.id::text;
    insert into public.ai_company_memory (organization_id, category, entry_key, version, content, status, source, expires_at, created_by)
    values (f.organization_id, 'approved_feedback', 'fb:' || f.id::text, v_version,
            jsonb_build_object('agent', f.agent_key, 'rating', f.rating, 'correction', f.correction, 'comment', f.comment),
            'active', 'user', now() + interval '365 days', auth.uid());
  end if;
  perform private.write_audit(f.organization_id, 'ai_feedback.reviewed', 'ai_feedback', f.id::text,
    jsonb_build_object('decision', p_decision, 'as_example', coalesce(p_use_as_example, false)));
  return jsonb_build_object('id', f.id, 'status', case when p_decision = 'validate' then 'validated' else 'rejected' end);
end $$;

-- ─── 3. Versioni di configurazione degli agenti (piattaforma) ────────────────
alter table public.admin_audit_logs drop constraint admin_audit_logs_target_type_check;
alter table public.admin_audit_logs add constraint admin_audit_logs_target_type_check check (target_type is null or target_type in ('organization',
  'reseller', 'domain', 'invitation', 'settings', 'feature_flag', 'plan', 'user', 'console', 'ai_config_version'));

-- kind: prompt (A. ottimizzazione dei prompt) · retrieval (B. memoria e recupero) · few_shot (C. esempi) ·
--       fine_tuned_model (D. fine-tuning reale: SOLO registrazione manuale, mai avviato dal sistema) ·
--       rules (regole deterministiche, es. Quality Reviewer, sinonimi dei settori, pesi di default).
-- La valutazione (E) è in ai_benchmark_runs.
create table public.ai_agent_config_versions (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null check (agent_key = any (private.ai_agent_keys()) or agent_key = 'quality_reviewer'),
  config_key text not null check (config_key ~ '^[a-z][a-z0-9_.]{2,60}$'),
  kind text not null check (kind in ('prompt', 'retrieval', 'few_shot', 'fine_tuned_model', 'rules')),
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  config jsonb not null check (private.ai_jsonb_small(config, 32768)),
  status text not null default 'candidate' check (status in ('candidate', 'active', 'retired', 'rejected')),
  parent_id uuid references public.ai_agent_config_versions (id),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  activated_by uuid references auth.users (id) on delete set null,
  activated_at timestamptz,
  activation_benchmark_id uuid,
  unique (config_key, version),
  check (kind <> 'fine_tuned_model' or (config ? 'model_id' and config ? 'cost_approval_reference'))
);
create unique index ai_agent_config_versions_one_active on public.ai_agent_config_versions (config_key) where status = 'active';

create table public.ai_benchmark_runs (
  id uuid primary key default gen_random_uuid(),
  benchmark_version text not null,
  data_kind text not null check (data_kind in ('synthetic', 'authorized_real')),
  candidate_version_id uuid references public.ai_agent_config_versions (id),
  report jsonb not null check (private.ai_jsonb_small(report, 262144)),
  gate_passed boolean not null,
  executed_by uuid references auth.users (id) on delete set null,
  executed_at timestamptz not null default now()
);
create index ai_benchmark_runs_time_idx on public.ai_benchmark_runs (executed_at desc);

alter table public.ai_agent_config_versions enable row level security;
alter table public.ai_benchmark_runs enable row level security;
revoke all on public.ai_agent_config_versions, public.ai_benchmark_runs from anon;
revoke insert, update, delete, truncate, references, trigger on public.ai_agent_config_versions, public.ai_benchmark_runs from authenticated;
create policy ai_agent_config_versions_select on public.ai_agent_config_versions for select to authenticated using (private.is_super_admin());
create policy ai_benchmark_runs_select on public.ai_benchmark_runs for select to authenticated using (private.is_super_admin());

-- Configurazione di partenza (attiva): blocchi del Quality Reviewer (codici che fermano un passo).
insert into public.ai_agent_config_versions (agent_key, config_key, kind, version, config, status, notes, activated_at)
values ('quality_reviewer', 'quality_reviewer.blocking_codes', 'rules', '1.0.0',
        '{"blocking_codes": ["duplicate_ids", "contradiction"]}', 'active', 'Configurazione iniziale del Prompt 12', now());

create or replace function public.sa_ai_config_propose(p_agent text, p_config_key text, p_kind text, p_version text, p_config jsonb, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_parent uuid;
begin
  perform private.require_super_admin();
  if p_kind = 'fine_tuned_model' and not (p_config ? 'model_id' and p_config ? 'cost_approval_reference') then
    raise exception 'fine_tuning_requires_registration_and_cost_approval' using errcode = '22023';
  end if;
  select id into v_parent from public.ai_agent_config_versions where config_key = p_config_key and status = 'active';
  insert into public.ai_agent_config_versions (agent_key, config_key, kind, version, config, status, parent_id, notes, created_by)
  values (p_agent, p_config_key, p_kind, p_version, p_config, 'candidate', v_parent, p_notes, auth.uid()) returning id into v_id;
  perform private.admin_audit('super_admin', 'ai_config.proposed', 'ai_config_version', v_id::text, p_notes, jsonb_build_object('config_key', p_config_key, 'version', p_version, 'kind', p_kind));
  return v_id;
end $$;

-- Attivazione SOLO con un benchmark recente superato che riguarda questa versione candidata.
create or replace function public.sa_ai_config_activate(p_version uuid, p_benchmark uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.ai_agent_config_versions; b public.ai_benchmark_runs;
begin
  perform private.require_super_admin();
  if p_reason is null or char_length(btrim(p_reason)) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v from public.ai_agent_config_versions where id = p_version for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v.status <> 'candidate' then raise exception 'version_not_candidate' using errcode = 'P0001'; end if;
  select * into b from public.ai_benchmark_runs where id = p_benchmark;
  if not found or b.candidate_version_id is distinct from v.id or not b.gate_passed or b.executed_at < now() - interval '30 days' then
    raise exception 'benchmark_gate_not_passed' using errcode = 'P0001';
  end if;
  update public.ai_agent_config_versions set status = 'retired' where config_key = v.config_key and status = 'active';
  update public.ai_agent_config_versions set status = 'active', activated_by = auth.uid(), activated_at = now(), activation_benchmark_id = b.id where id = v.id;
  perform private.admin_audit('super_admin', 'ai_config.activated', 'ai_config_version', v.id::text, p_reason, jsonb_build_object('config_key', v.config_key, 'version', v.version, 'benchmark', b.id));
  return jsonb_build_object('id', v.id, 'status', 'active');
end $$;

-- Rollback immediato: torna alla versione attivata in precedenza (nessun benchmark richiesto).
create or replace function public.sa_ai_config_rollback(p_config_key text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cur public.ai_agent_config_versions; prev public.ai_agent_config_versions;
begin
  perform private.require_super_admin();
  if p_reason is null or char_length(btrim(p_reason)) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into cur from public.ai_agent_config_versions where config_key = p_config_key and status = 'active' for update;
  if not found then raise exception 'no_active_version' using errcode = 'P0002'; end if;
  select * into prev from public.ai_agent_config_versions where config_key = p_config_key and status = 'retired' and activated_at is not null
   order by activated_at desc limit 1 for update;
  if not found then raise exception 'no_previous_version' using errcode = 'P0001'; end if;
  update public.ai_agent_config_versions set status = 'retired' where id = cur.id;
  update public.ai_agent_config_versions set status = 'active', activated_by = auth.uid(), activated_at = now() where id = prev.id;
  perform private.admin_audit('super_admin', 'ai_config.rolled_back', 'ai_config_version', prev.id::text, p_reason, jsonb_build_object('config_key', p_config_key, 'from', cur.version, 'to', prev.version));
  return jsonb_build_object('active', prev.id, 'version', prev.version);
end $$;

create or replace function public.sa_ai_config_reject(p_version uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  update public.ai_agent_config_versions set status = 'rejected' where id = p_version and status = 'candidate';
  if not found then raise exception 'version_not_candidate' using errcode = 'P0001'; end if;
  perform private.admin_audit('super_admin', 'ai_config.rejected', 'ai_config_version', p_version::text, p_reason, '{}'::jsonb);
end $$;

-- Panoramica per /super-admin/ai-training: versioni, benchmark, feedback SOLO aggregati (nessun contenuto).
create or replace function public.sa_ai_training_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  return jsonb_build_object(
    'versions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'agent_key', agent_key, 'config_key', config_key, 'kind', kind, 'version', version,
        'status', status, 'config', config, 'notes', notes, 'created_at', created_at, 'activated_at', activated_at, 'activation_benchmark_id', activation_benchmark_id)
        order by config_key, created_at desc) from public.ai_agent_config_versions), '[]'::jsonb),
    'benchmarks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'benchmark_version', benchmark_version, 'data_kind', data_kind,
        'candidate_version_id', candidate_version_id, 'gate_passed', gate_passed, 'executed_at', executed_at,
        'comparisons', report -> 'comparisons', 'suites', report -> 'suites', 'contamination', report -> 'contamination') order by executed_at desc)
        from (select * from public.ai_benchmark_runs order by executed_at desc limit 20) b), '[]'::jsonb),
    'feedback', jsonb_build_object(
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.ai_feedback group by status) s), '{}'::jsonb),
      'by_agent', coalesce((select jsonb_object_agg(agent_key, jsonb_build_object('total', n, 'negative', neg)) from (
          select agent_key, count(*) n, count(*) filter (where rating < 0) neg from public.ai_feedback group by agent_key) s), '{}'::jsonb),
      'organizations_with_feedback', (select count(distinct organization_id) from public.ai_feedback),
      'note', 'feedback content stays in each organization and is never used for platform configurations'),
    'errors_30d', coalesce((select jsonb_object_agg(error_code, n) from (select error_code, count(*) n from public.ai_agent_runs
        where started_at > now() - interval '30 days' and error_code is not null and error_code <> 'yielded' group by error_code order by 2 desc limit 15) e), '{}'::jsonb),
    'costs_30d', (select jsonb_build_object('credits', coalesce(sum(credits), 0), 'cost_usd', round(coalesce(sum(cost_usd), 0), 6), 'unpriced_calls', count(*) filter (where cost_usd is null))
        from public.ai_agent_costs where created_at > now() - interval '30 days')
  );
end $$;

-- Configurazione attiva letta dal server (motore): service role.
create or replace function public.ai_active_config(p_config_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select config from public.ai_agent_config_versions where config_key = p_config_key and status = 'active';
$$;

revoke all on function public.ai_feedback_submit(uuid, text, text, uuid, integer, jsonb, text, uuid), public.ai_feedback_review(uuid, text, boolean),
  public.sa_ai_config_propose(text, text, text, text, jsonb, text), public.sa_ai_config_activate(uuid, uuid, text),
  public.sa_ai_config_rollback(text, text), public.sa_ai_config_reject(uuid, text), public.sa_ai_training_overview(), public.ai_active_config(text) from public, anon;
grant execute on function public.ai_feedback_submit(uuid, text, text, uuid, integer, jsonb, text, uuid), public.ai_feedback_review(uuid, text, boolean),
  public.sa_ai_config_propose(text, text, text, text, jsonb, text), public.sa_ai_config_activate(uuid, uuid, text),
  public.sa_ai_config_rollback(text, text), public.sa_ai_config_reject(uuid, text), public.sa_ai_training_overview() to authenticated, service_role;
revoke all on function public.ai_active_config(text) from authenticated;
grant execute on function public.ai_active_config(text) to service_role;

-- ─── 4. "approved_feedback" solo dalla validazione dei feedback ─────────────
-- Stessa funzione del Prompt 8 con un controllo in più: la categoria degli esempi approvati non si scrive a mano.
create or replace function public.ai_memory_upsert(p_org uuid, p_category text, p_entry_key text, p_content jsonb, p_retention_days integer default 365)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_version int;
  v_id uuid;
begin
  if auth.uid() is null or not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_category <> 'user_feedback' and not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_category in ('campaign_results', 'approved_feedback') then
    raise exception 'category_server_only' using errcode = '22023';
  end if;
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
