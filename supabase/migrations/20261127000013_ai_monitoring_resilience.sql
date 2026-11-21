-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 9: osservabilità del motore multi-agent, qualità degli output,
-- prevenzione delle esecuzioni concorrenti. Migrazione ADDITIVA (nessuna tabella o dato rimosso).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Prevenzione esecuzioni concorrenti ──────────────────────────────────
-- Limite di workflow in esecuzione (pending/running) per organizzazione: evita esecuzioni parallele che
-- moltiplicano chiamate e crediti. I workflow in attesa di approvazione non contano (sono fermi).
-- Il replay con la stessa idempotency_key non viene bloccato: l'INSERT fallirà sul vincolo unico e il
-- server restituirà il workflow esistente.
create or replace function private.ai_max_active_workflows()
returns integer language sql immutable set search_path = '' as $$ select 2 $$;

create or replace function private.ai_workflows_concurrency_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_active integer;
begin
  -- Serializza gli avvii della stessa organizzazione (nessuna corsa tra due INSERT simultanei).
  perform pg_advisory_xact_lock(hashtextextended('ai_workflows:' || new.organization_id::text, 0));
  if exists (select 1 from public.ai_workflows where organization_id = new.organization_id and idempotency_key = new.idempotency_key) then
    return new;
  end if;
  select count(*) into v_active from public.ai_workflows
   where organization_id = new.organization_id and status in ('pending', 'running');
  if v_active >= private.ai_max_active_workflows() then
    raise exception 'too_many_active_workflows' using errcode = 'P0001', detail = jsonb_build_object('limit', private.ai_max_active_workflows())::text;
  end if;
  return new;
end $$;

create trigger ai_workflows_concurrency_guard before insert on public.ai_workflows
  for each row execute function private.ai_workflows_concurrency_guard();

revoke all on function private.ai_workflows_concurrency_guard() from public, anon, authenticated;

-- ─── 2. Osservabilità per il Super Admin (/super-admin/ai-monitoring) ───────
-- Solo aggregati: conteggi, durate, token, crediti, costi, codici di errore. Nessun obiettivo scritto
-- dall'utente, nessun output, nessun nome di azienda o lead (dati commerciali riservati dei clienti).
-- Le metriche di qualità leggono gli envelope (envelope_version) salvati in ai_agent_runs.output.
create or replace function public.sa_ai_monitoring(
  p_from timestamptz,
  p_to timestamptz,
  p_org uuid default null,
  p_agent text default null,
  p_status text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to timestamptz := coalesce(p_to, now());
begin
  perform private.require_super_admin();
  if v_to <= v_from or v_to - v_from > interval '366 days' then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
  if p_agent is not null and not (p_agent = any (private.ai_agent_keys())) then
    raise exception 'invalid_agent' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('pending', 'running', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  return (
    with wf as (
      select w.* from public.ai_workflows w
       where w.created_at >= v_from and w.created_at < v_to
         and (p_org is null or w.organization_id = p_org)
         and (p_status is null or w.status = p_status)
    ), runs as (
      select r.*, extract(epoch from (r.completed_at - r.started_at)) * 1000 as ms
        from public.ai_agent_runs r
       where r.started_at >= v_from and r.started_at < v_to
         and (p_org is null or r.organization_id = p_org)
         and (p_agent is null or r.agent_key = p_agent)
         and (p_status is null or exists (select 1 from wf where wf.id = r.workflow_id))
    ), env as (
      select r.agent_key, r.output from runs r where r.output ? 'envelope_version' and r.status <> 'running' and coalesce(r.error_code, '') <> 'yielded'
    ), costs as (
      select c.* from public.ai_agent_costs c
       where c.created_at >= v_from and c.created_at < v_to
         and (p_org is null or c.organization_id = p_org)
         and (p_agent is null or c.agent_key = p_agent)
    )
    select jsonb_build_object(
      'period', jsonb_build_object('from', v_from, 'to', v_to),
      'filters', jsonb_build_object('organization_id', p_org, 'agent', p_agent, 'status', p_status),
      'workflows', jsonb_build_object(
        'total', (select count(*) from wf),
        'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from wf group by status) s), '{}'::jsonb),
        'by_template', coalesce((select jsonb_object_agg(template, n) from (select template, count(*) n from wf group by template) s), '{}'::jsonb),
        'active_now', (select count(*) from public.ai_workflows w where w.status in ('pending', 'running') and (p_org is null or w.organization_id = p_org)),
        'waiting_approval_now', (select count(*) from public.ai_workflows w where w.status = 'waiting_approval' and (p_org is null or w.organization_id = p_org)),
        'avg_duration_ms', (select round(avg(extract(epoch from (completed_at - started_at)) * 1000)) from wf where completed_at is not null and started_at is not null),
        -- Tempo di avvio: dalla creazione all'inizio dell'esecuzione (dispatch della background function).
        'avg_start_latency_ms', (select round(avg(extract(epoch from (started_at - created_at)) * 1000)) from wf where started_at is not null),
        'credits_used', (select coalesce(sum(credits_used), 0) from wf),
        'cost_usd', (select round(coalesce(sum(cost_usd), 0), 6) from wf),
        'cost_per_completed_workflow_usd', (select round(avg(cost_usd), 6) from wf where status = 'completed')
      ),
      'agents', coalesce((select jsonb_agg(a order by a->>'agent_key') from (
        select jsonb_build_object(
          'agent_key', agent_key,
          'runs', count(*),
          'running_now', count(*) filter (where status = 'running'),
          'succeeded', count(*) filter (where status = 'succeeded'),
          'partial', count(*) filter (where status = 'partial'),
          'failed', count(*) filter (where status in ('failed', 'timed_out')),
          'error_rate', round((count(*) filter (where status in ('failed', 'timed_out')))::numeric / nullif(count(*) filter (where status <> 'running' and coalesce(error_code, '') <> 'yielded'), 0), 4),
          'avg_ms', round(avg(ms) filter (where completed_at is not null)),
          'p95_ms', round((percentile_cont(0.95) within group (order by ms::float8) filter (where completed_at is not null))::numeric),
          'tokens_input', coalesce(sum(tokens_input), 0),
          'tokens_output', coalesce(sum(tokens_output), 0),
          'credits', coalesce(sum(credits_used), 0),
          'cost_usd', round(coalesce(sum(cost_usd), 0), 6),
          'unpriced_runs', count(*) filter (where cost_usd is null and (tokens_input + tokens_output) > 0)
        ) a from runs group by agent_key) x), '[]'::jsonb),
      'quality', coalesce((select jsonb_agg(q order by q->>'agent_key') from (
        select jsonb_build_object(
          'agent_key', agent_key,
          'envelopes', count(*),
          'valid_output_rate', round((count(*) filter (where (output->>'output_valid')::boolean))::numeric / nullif(count(*), 0), 4),
          'evidence_required', count(*) filter (where (output->'evidence'->>'required')::boolean),
          'evidence_coverage', round(sum((output->'evidence'->>'items_with_evidence')::numeric) filter (where (output->'evidence'->>'required')::boolean)
                               / nullif(sum((output->'evidence'->>'items_total')::numeric) filter (where (output->'evidence'->>'required')::boolean), 0), 4),
          'facts', coalesce(sum((output->'evidence'->>'facts')::numeric), 0),
          'inferences', coalesce(sum((output->'evidence'->>'inferences')::numeric), 0),
          'unknowns', coalesce(sum((output->'evidence'->>'unknowns')::numeric), 0),
          'item_failure_rate', round(sum((output->'items'->>'failed')::numeric) / nullif(sum((output->'items'->>'total')::numeric), 0), 4),
          'model_fallbacks', count(*) filter (where (output->'routing'->>'fallback')::boolean)
        ) q from env group by agent_key) y), '[]'::jsonb),
      -- Avvisi "fatto non verificato" del postcheck della strategia (informazioni non supportate).
      'unsupported_claims', (select count(*) from runs r, jsonb_array_elements(coalesce(r.output->'output'->'strategies', '[]'::jsonb)) s,
                              jsonb_array_elements(coalesce(s->'warnings', '[]'::jsonb)) w
                              where r.agent_key = 'strategy' and w->>'code' = 'unverified_fact'),
      'errors', coalesce((select jsonb_agg(e order by (e->>'count')::int desc) from (
        select jsonb_build_object('code', error_code, 'agent_key', agent_key, 'count', count(*)) e
          from runs where error_code is not null and error_code <> 'yielded'
         group by error_code, agent_key order by count(*) desc limit 20) z), '[]'::jsonb),
      'costs', jsonb_build_object(
        'ai_calls', (select count(*) from costs where kind = 'ai_tokens'),
        'provider_calls', (select count(*) from costs where kind = 'provider_call'),
        'cache_hits', (select count(*) from costs where cache_hit),
        'tokens_input', (select coalesce(sum(tokens_input), 0) from costs),
        'tokens_output', (select coalesce(sum(tokens_output), 0) from costs),
        'credits', (select coalesce(sum(credits), 0) from costs),
        'cost_usd', (select round(coalesce(sum(cost_usd), 0), 6) from costs),
        'unpriced_calls', (select count(*) from costs where cost_usd is null)
      ),
      'daily', coalesce((select jsonb_agg(d order by d->>'day') from (
        select jsonb_build_object('day', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), 'workflows', count(*),
               'completed', count(*) filter (where status = 'completed'), 'failed', count(*) filter (where status = 'failed'),
               'credits', coalesce(sum(credits_used), 0)) d
          from wf group by date_trunc('day', created_at)) dd), '[]'::jsonb),
      -- Per organizzazione: solo identificativo, nome e conteggi (nessun contenuto commerciale).
      'organizations', coalesce((select jsonb_agg(o order by (o->>'workflows')::int desc) from (
        select jsonb_build_object('organization_id', w.organization_id, 'name', org.name, 'workflows', count(*),
               'failed', count(*) filter (where w.status = 'failed'), 'credits', coalesce(sum(w.credits_used), 0),
               'cost_usd', round(coalesce(sum(w.cost_usd), 0), 6)) o
          from wf w join public.organizations org on org.id = w.organization_id
         group by w.organization_id, org.name order by count(*) desc limit 50) oo), '[]'::jsonb)
    )
  );
end $$;

revoke all on function public.sa_ai_monitoring(timestamptz, timestamptz, uuid, text, text) from public, anon;
grant execute on function public.sa_ai_monitoring(timestamptz, timestamptz, uuid, text, text) to authenticated, service_role;
