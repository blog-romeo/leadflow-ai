-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 10: verifiche reali delle connessioni e avvisi del motore multi-agent.
-- Migrazione ADDITIVA: una tabella nuova, un vincolo CHECK ampliato, due funzioni nuove.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Esiti delle verifiche di connessione (piattaforma, nessun segreto) ────
-- "Configurato" ≠ "connesso": la console mostra un provider come verificato SOLO se esiste un esito
-- 'verified' recente scritto dal server dopo una chiamata reale di sola lettura.
create table public.integration_checks (
  id bigint generated always as identity primary key,
  key text not null check (key in ('openai_standard', 'openai_economy', 'openai_advanced', 'overpass')),
  status text not null check (status in ('verified', 'failed', 'not_configured')),
  code text not null check (code ~ '^[a-z0-9_]{2,40}$'),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 600000),
  checked_at timestamptz not null default now()
);
create index integration_checks_key_time_idx on public.integration_checks (key, checked_at desc);

alter table public.integration_checks enable row level security;
revoke all on public.integration_checks from anon;
revoke insert, update, delete, truncate, references, trigger on public.integration_checks from authenticated;
-- Lettura per gli utenti autenticati: solo stato, codice, latenza e data (informazioni di piattaforma).
create policy integration_checks_select on public.integration_checks for select to authenticated using (true);

-- Ultimo esito per provider.
create or replace function public.integration_checks_latest()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'status', status, 'code', code, 'latency_ms', latency_ms, 'checked_at', checked_at) order by key), '[]'::jsonb)
    from (select distinct on (key) key, status, code, latency_ms, checked_at from public.integration_checks order by key, checked_at desc) t;
$$;
revoke all on function public.integration_checks_latest() from public, anon;
grant execute on function public.integration_checks_latest() to authenticated, service_role;

-- ─── 2. Avvisi del motore multi-agent ───────────────────────────────────────
alter table public.monitoring_alerts drop constraint monitoring_alerts_kind_check;
alter table public.monitoring_alerts add constraint monitoring_alerts_kind_check check (kind in ('function_errors', 'client_errors', 'webhook_failed',
  'webhook_stuck', 'ai_jobs_stuck', 'ai_jobs_failing', 'automation_failing', 'ai_cost', 'integration_missing',
  -- Prompt 10
  'ai_workflows_failing', 'ai_workflows_stuck', 'integration_check_failed'));

-- Valutata dalla function pianificata monitoring-tick dopo monitoring_evaluate (stessa deduplica giornaliera).
-- Messaggi solo con conteggi: nessun nome di organizzazione o contenuto commerciale.
create or replace function public.ai_monitoring_evaluate()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  v_new jsonb := '[]'::jsonb;
  v_failed int;
  v_finished int;
  v_stuck int;
  v_bad text;
  a record;
begin
  select count(*) filter (where status = 'failed'), count(*) into v_failed, v_finished
    from public.ai_workflows where completed_at >= now() - interval '24 hours' and status in ('completed', 'partial', 'failed', 'cancelled');
  -- In esecuzione con lease scaduto da oltre 30 minuti: la ripresa automatica (ai-workflows-tick) non è avvenuta.
  select count(*) into v_stuck from public.ai_workflows
   where status in ('pending', 'running') and coalesce(locked_until, updated_at) < now() - interval '30 minutes';
  select string_agg(key, ', ' order by key) into v_bad from (
    select distinct on (key) key, status from public.integration_checks where checked_at >= now() - interval '24 hours' order by key, checked_at desc) t
   where status = 'failed';
  for a in
    select * from (values
      ('ai_workflows_failing', 'warning', 'Workflow AI falliti nelle ultime 24 ore: ' || v_failed || ' su ' || v_finished, v_failed >= 3 and v_failed::numeric > v_finished * 0.3),
      ('ai_workflows_stuck', 'warning', 'Workflow AI fermi (lease scaduto da oltre 30 minuti): ' || v_stuck, v_stuck > 0),
      ('integration_check_failed', 'critical', 'Verifica di connessione fallita: ' || coalesce(v_bad, ''), v_bad is not null)
    ) as t(kind, severity, message, firing)
    where firing
  loop
    insert into public.monitoring_alerts (kind, severity, message, details, dedup_key)
    values (a.kind, a.severity, left(a.message, 300), jsonb_build_object('failed_24h', v_failed, 'finished_24h', v_finished, 'stuck', v_stuck), a.kind || ':' || v_day)
    on conflict (dedup_key) do nothing;
    if found then v_new := v_new || jsonb_build_array(jsonb_build_object('kind', a.kind, 'severity', a.severity, 'message', left(a.message, 300))); end if;
  end loop;
  return jsonb_build_object('new_alerts', v_new);
end $$;
revoke all on function public.ai_monitoring_evaluate() from public, anon, authenticated;
grant execute on function public.ai_monitoring_evaluate() to service_role;
