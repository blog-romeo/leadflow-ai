-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 10: esiti delle verifiche di connessione e avvisi del motore multi-agent.
-- Dati di test, nessun cliente reale.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set U '00000000-0000-0000-0000-0000000ac101'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_u 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ac101"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (:'U', 'ugo@checks.test', '{}', now());
\o
:as_u
select id as org_u from public.create_organization('Checks Test Srl', null, 'IT') \gset

-- ── 1. Scrittura solo dal server ───────────────────────────────────────────
select public.__expect_error($$insert into public.integration_checks (key, status, code) values ('overpass', 'verified', 'ok')$$, array['42501'], 'verifiche: un utente non può dichiarare un provider verificato');
:as_anon
select public.__expect_error($$select count(*) from public.integration_checks$$, array['42501'], 'verifiche: anon non legge');
select public.__expect_error($$select public.integration_checks_latest()$$, array['42501'], 'verifiche: anon non esegue integration_checks_latest');
:as_service
insert into public.integration_checks (key, status, code, latency_ms, checked_at) values
  ('overpass', 'verified', 'ok', 320, now() - interval '2 hours'),
  ('overpass', 'failed', 'unavailable', 8000, now() - interval '10 minutes'),
  ('openai_standard', 'not_configured', 'provider_not_configured', null, now() - interval '5 minutes');
select public.__expect_error($$insert into public.integration_checks (key, status, code) values ('stripe', 'verified', 'ok')$$, array['23514'], 'verifiche: solo provider previsti');
select public.__expect_error($$insert into public.integration_checks (key, status, code) values ('overpass', 'verified', 'sk-proj-abc def')$$, array['23514'], 'verifiche: il codice non può contenere testo libero');

-- ── 2. Lettura: ultimo esito per provider ──────────────────────────────────
:as_u
select public.integration_checks_latest() as latest \gset
select public.__expect((select x ->> 'status' = 'failed' from jsonb_array_elements(:'latest'::jsonb) x where x ->> 'key' = 'overpass'), 'verifiche: vale l''esito più recente (non un vecchio "verificato")');
select public.__expect(jsonb_array_length(:'latest'::jsonb) = 2, 'verifiche: un esito per provider');

-- ── 3. Avvisi ─────────────────────────────────────────────────────────────
:as_u
select public.__expect_error($$select public.ai_monitoring_evaluate()$$, array['42501'], 'avvisi AI: non eseguibili dagli utenti');
:as_service
insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits, status, completed_at)
select :'org_u', 'growth_report', '{}', 'p10-fail-' || g, 0, 'failed', now() - interval '1 hour' from generate_series(1, 3) g;
insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits, status, completed_at)
values (:'org_u', 'growth_report', '{}', 'p10-ok-0001', 0, 'completed', now() - interval '1 hour');
insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits, status, locked_until)
values (:'org_u', 'growth_report', '{}', 'p10-stuck-01', 0, 'running', now() - interval '45 minutes');
select public.ai_monitoring_evaluate() as ev \gset
select public.__expect((select count(*) = 3 from jsonb_array_elements(:'ev'::jsonb -> 'new_alerts')), 'avvisi AI: workflow falliti, workflow fermi, verifica fallita');
select public.__expect(position('Checks Test' in :'ev') = 0, 'avvisi AI: nessun nome di organizzazione nei messaggi');
select public.__expect(jsonb_array_length(public.ai_monitoring_evaluate() -> 'new_alerts') = 0, 'avvisi AI: deduplicati nella giornata');
select public.__expect((select count(*) = 3 from public.monitoring_alerts where kind in ('ai_workflows_failing', 'ai_workflows_stuck', 'integration_check_failed')), 'avvisi AI: registrati in monitoring_alerts');
\echo 'Test verifiche di connessione e avvisi AI (Prompt 10) completati.'
