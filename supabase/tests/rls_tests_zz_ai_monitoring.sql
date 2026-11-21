-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 9: prevenzione delle esecuzioni concorrenti, osservabilità del Super Admin,
-- metriche di qualità dagli envelope, nessun dato commerciale esposto. Dati di test (nessun cliente reale).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set A  '00000000-0000-0000-0000-0000000ab901'
\set B  '00000000-0000-0000-0000-0000000ab902'
\set S  '00000000-0000-0000-0000-0000000ab903'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ab901"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ab902"}'';'
\set as_s 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ab903"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'A', 'alba@monitor-a.test', '{}', now()),
  (:'B', 'bice@monitor-b.test', '{}', now()),
  (:'S', 'sara@leadflow-ops.test', '{}', now());
select private.set_platform_role('sara@leadflow-ops.test', 'super_admin', 'Test osservabilità Prompt 9');
\o
:as_a
select id as org_a from public.create_organization('Monitor A Srl', null, 'IT') \gset
:as_b
select id as org_b from public.create_organization('Monitor B Srl', null, 'IT') \gset

-- ── 1. Esecuzioni concorrenti ──────────────────────────────────────────────
:as_service
insert into public.ai_workflows (organization_id, template, objective, params, idempotency_key, budget_credits, created_by)
values (:'org_a', 'prospecting', 'OBIETTIVO-RISERVATO-CLIENTE', '{}', 'p9-conc-0001', 50, :'A') returning id as w1 \gset
insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits, created_by)
values (:'org_a', 'growth_report', '{}', 'p9-conc-0002', 0, :'A') returning id as w2 \gset
select public.__expect_error(format($$insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits) values (%L, 'growth_report', '{}', 'p9-conc-0003', 0)$$, :'org_a'),
  array['P0001'], 'concorrenza: terzo workflow attivo della stessa organizzazione rifiutato');
select public.__expect_error(format($$insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits) values (%L, 'growth_report', '{}', 'p9-conc-0001', 0)$$, :'org_a'),
  array['23505'], 'concorrenza: il replay con la stessa chiave arriva al vincolo di idempotenza (nessun nuovo workflow)');
insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits)
values (:'org_b', 'growth_report', '{}', 'p9-conc-b001', 0) returning id as wb \gset
select public.__expect(true, 'concorrenza: il limite di un''organizzazione non blocca le altre');
update public.ai_workflows set status = 'waiting_approval' where id = :'w2';
insert into public.ai_workflows (organization_id, template, params, idempotency_key, budget_credits)
values (:'org_a', 'growth_report', '{}', 'p9-conc-0004', 0) returning id as w3 \gset
select public.__expect(true, 'concorrenza: un workflow in attesa di approvazione non occupa uno slot di esecuzione');
update public.ai_workflows set status = 'completed', completed_at = now(), started_at = now() - interval '90 seconds' where id = :'w3';

-- ── 2. Dati di esecuzione con envelope (Prompt 9) ──────────────────────────
insert into public.ai_workflow_steps (organization_id, workflow_id, position, agent_key, action, requires_approval, status)
values (:'org_a', :'w1', 1, 'research', 'research', false, 'completed') returning id as st1 \gset
insert into public.ai_workflow_steps (organization_id, workflow_id, position, agent_key, action, depends_on, requires_approval, status)
values (:'org_a', :'w1', 2, 'strategy', 'strategy', '{1}', false, 'failed') returning id as st2 \gset
insert into public.ai_agent_runs (organization_id, workflow_id, step_id, agent_key, status, tokens_input, tokens_output, credits_used, cost_usd, started_at, completed_at, output)
values (:'org_a', :'w1', :'st1', 'research', 'succeeded', 3000, 900, 3, 0.002, now() - interval '20 seconds', now() - interval '8 seconds',
  jsonb_build_object('envelope_version', 1, 'output_valid', true,
    'evidence', jsonb_build_object('required', true, 'facts', 5, 'inferences', 3, 'unknowns', 2, 'items_with_evidence', 3, 'items_total', 4),
    'items', jsonb_build_object('total', 4, 'failed', 1), 'routing', jsonb_build_object('model', 'm-eco', 'tier', 'economy', 'fallback', false),
    'output', jsonb_build_object('results', jsonb_build_object('x', 'analyzed'), 'company', 'NOME-AZIENDA-RISERVATO')));
insert into public.ai_agent_runs (organization_id, workflow_id, step_id, agent_key, status, error_code, started_at, completed_at, output)
values (:'org_a', :'w1', :'st2', 'strategy', 'failed', 'invalid_agent_output', now() - interval '6 seconds', now() - interval '5 seconds',
  jsonb_build_object('envelope_version', 1, 'output_valid', false,
    'evidence', jsonb_build_object('required', false, 'facts', 0, 'inferences', 0, 'unknowns', 0, 'items_with_evidence', 0, 'items_total', 0),
    'items', jsonb_build_object('total', 2, 'failed', 2), 'routing', jsonb_build_object('model', 'm-std', 'tier', 'standard', 'fallback', true), 'output', null));
insert into public.ai_agent_runs (organization_id, workflow_id, step_id, agent_key, attempt, status, started_at, completed_at, output)
values (:'org_a', :'w1', :'st2', 'strategy', 2, 'succeeded', now() - interval '4 seconds', now() - interval '1 second',
  jsonb_build_object('envelope_version', 1, 'output_valid', true,
    'evidence', jsonb_build_object('required', true, 'facts', 1, 'inferences', 1, 'unknowns', 0, 'items_with_evidence', 1, 'items_total', 2),
    'items', jsonb_build_object('total', 2, 'failed', 0), 'routing', null,
    'output', jsonb_build_object('strategies', jsonb_build_array(
      jsonb_build_object('lead_id', gen_random_uuid(), 'warnings', jsonb_build_array(jsonb_build_object('code', 'unverified_fact', 'detail', 'x'))),
      jsonb_build_object('lead_id', gen_random_uuid(), 'warnings', '[]'::jsonb)))));
insert into public.ai_agent_costs (organization_id, workflow_id, agent_key, kind, model, tokens_input, tokens_output, credits, cost_usd)
values (:'org_a', :'w1', 'research', 'ai_tokens', 'm-eco', 3000, 900, 3, 0.002),
       (:'org_a', :'w1', 'discovery', 'provider_call', null, 0, 0, 0, null);
insert into public.ai_agent_runs (organization_id, workflow_id, agent_key, status, started_at, completed_at)
values (:'org_b', :'wb', 'growth_analyst', 'succeeded', now() - interval '3 seconds', now());

-- ── 3. Accesso: solo il Super Admin ────────────────────────────────────────
:as_a
select public.__expect_error($$select public.sa_ai_monitoring(now() - interval '1 day', now())$$, array['42501'], 'monitoraggio AI: amministratore di organizzazione negato');
:as_anon
select public.__expect_error($$select public.sa_ai_monitoring(now() - interval '1 day', now())$$, array['42501'], 'monitoraggio AI: anon negato');
:as_s
select public.sa_ai_monitoring(now() - interval '1 day', now() + interval '1 minute') as m \gset
select public.__expect((:'m'::jsonb -> 'workflows' ->> 'total')::int >= 4, 'monitoraggio AI: workflow conteggiati');
select public.__expect((:'m'::jsonb -> 'workflows' -> 'by_status' ->> 'pending')::int >= 2, 'monitoraggio AI: workflow per stato');
select public.__expect(position('OBIETTIVO-RISERVATO-CLIENTE' in :'m') = 0, 'monitoraggio AI: nessun obiettivo scritto dal cliente');
select public.__expect(position('NOME-AZIENDA-RISERVATO' in :'m') = 0, 'monitoraggio AI: nessun output commerciale esposto');

select public.sa_ai_monitoring(now() - interval '1 day', now() + interval '1 minute', :'org_a') as ma \gset
select public.__expect((:'ma'::jsonb -> 'workflows' ->> 'total')::int = 3, 'monitoraggio AI: filtro per organizzazione');
select public.__expect((select (a ->> 'failed')::int = 1 and (a ->> 'runs')::int = 2 and (a ->> 'error_rate')::numeric = 0.5
                          from jsonb_array_elements(:'ma'::jsonb -> 'agents') a where a ->> 'agent_key' = 'strategy'), 'monitoraggio AI: tasso di errore per agente');
select public.__expect((select (q ->> 'valid_output_rate')::numeric = 0.5 and (q ->> 'model_fallbacks')::int = 1
                          from jsonb_array_elements(:'ma'::jsonb -> 'quality') q where q ->> 'agent_key' = 'strategy'), 'qualità: percentuale di output JSON validi e fallback dei modelli');
select public.__expect((select (q ->> 'evidence_coverage')::numeric = 0.75 and (q ->> 'item_failure_rate')::numeric = 0.25
                          from jsonb_array_elements(:'ma'::jsonb -> 'quality') q where q ->> 'agent_key' = 'research'), 'qualità: copertura delle evidenze e errori per elemento');
select public.__expect((:'ma'::jsonb ->> 'unsupported_claims')::int = 1, 'qualità: informazioni non supportate segnalate dal postcheck');
select public.__expect((:'ma'::jsonb -> 'costs' ->> 'unpriced_calls')::int = 1 and (:'ma'::jsonb -> 'costs' ->> 'cost_usd')::numeric = 0.002, 'costi: chiamate senza prezzo non stimate (NULL), nessun prezzo inventato');
select public.__expect((select (a ->> 'avg_ms')::numeric between 11000 and 13000 from jsonb_array_elements(:'ma'::jsonb -> 'agents') a where a ->> 'agent_key' = 'research'), 'monitoraggio AI: durata media delle esecuzioni');
select public.__expect((:'ma'::jsonb -> 'workflows' ->> 'avg_duration_ms')::numeric between 89000 and 91000, 'monitoraggio AI: durata media dei workflow');
select public.__expect(jsonb_array_length(:'ma'::jsonb -> 'organizations') = 1, 'monitoraggio AI: per organizzazione solo l''organizzazione filtrata');

select public.sa_ai_monitoring(now() - interval '1 day', now() + interval '1 minute', null, 'growth_analyst') as mg \gset
select public.__expect(jsonb_array_length(:'mg'::jsonb -> 'agents') = 1, 'monitoraggio AI: filtro per agente');
select public.sa_ai_monitoring(now() - interval '1 day', now() + interval '1 minute', null, null, 'completed') as mc \gset
select public.__expect((:'mc'::jsonb -> 'workflows' ->> 'total')::int >= 1 and (:'mc'::jsonb -> 'workflows' -> 'by_status' ->> 'pending') is null, 'monitoraggio AI: filtro per stato');
select public.__expect_error($$select public.sa_ai_monitoring(now() - interval '1 day', now(), null, 'agente_inventato')$$, array['22023'], 'monitoraggio AI: agente non valido rifiutato');
select public.__expect_error($$select public.sa_ai_monitoring(now(), now() - interval '1 day')$$, array['22023'], 'monitoraggio AI: periodo non valido rifiutato');
select public.__expect_error($$select public.sa_ai_monitoring(now() - interval '400 days', now())$$, array['22023'], 'monitoraggio AI: periodo massimo 366 giorni');

-- ── 4. Il trigger di concorrenza non è eseguibile direttamente ─────────────
:as_postgres
select public.__expect(not has_function_privilege('authenticated', 'private.ai_workflows_concurrency_guard()', 'execute'), 'trigger di concorrenza non eseguibile dagli utenti');
\echo 'Test monitoraggio AI e concorrenza (Prompt 9) completati.'
