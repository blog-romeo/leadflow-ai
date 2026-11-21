-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 12: memoria con minimizzazione, feedback validato e isolato, versioni di configurazione
-- con gate di benchmark e rollback. Dati di test, nessun cliente reale.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set A '00000000-0000-0000-0000-0000000ad201'
\set M '00000000-0000-0000-0000-0000000ad202'
\set B '00000000-0000-0000-0000-0000000ad203'
\set S '00000000-0000-0000-0000-0000000ad204'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ad201"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ad202"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ad203"}'';'
\set as_s 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ad204"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'A', 'ada@training-a.test', '{}', now()), (:'M', 'mia@training-a.test', '{}', now()),
  (:'B', 'bob@training-b.test', '{}', now()), (:'S', 'sam@leadflow-training.test', '{}', now());
select private.set_platform_role('sam@leadflow-training.test', 'super_admin', 'Test training Prompt 12');
\o
:as_a
select id as org_a from public.create_organization('Training A Srl', null, 'IT') \gset
:as_b
select id as org_b from public.create_organization('Training B Srl', null, 'IT') \gset
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_a', :'M', 'member');

-- ── 1. Memoria: nuove categorie e minimizzazione ───────────────────────────
:as_a
select public.__expect((public.ai_memory_upsert(:'org_a', 'target_sectors', 'primary', '{"sectors":["hotel","b&b"]}') ->> 'version')::int = 1, 'memoria: categoria target_sectors');
select public.__expect((public.ai_memory_upsert(:'org_a', 'target_sectors', 'primary', '{"sectors":["hotel"],"updated":"2026-11-21","ref":"00000000-0000-4000-8000-000000000001"}') ->> 'version')::int = 2, 'memoria: correzione = nuova versione (date e UUID ammessi)');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'commercial_profile', 'contatti', '{"referente":"mario.rossi@cliente.test"}')$$, :'org_a'), array['22023'], 'memoria: email rifiutata (minimizzazione)');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'commercial_profile', 'contatti', '{"tel":"+39 06 1234 5678"}')$$, :'org_a'), array['22023'], 'memoria: telefono rifiutato (minimizzazione)');
select public.__expect((select count(*) = 1 from public.ai_company_memory where organization_id = :'org_a' and category = 'target_sectors' and status = 'active'), 'memoria: una sola versione attiva');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'approved_feedback', 'fb:x', '{"x":1}')$$, :'org_a'), array['22023'], 'memoria: esempi approvati solo dalla validazione dei feedback');

-- ── 2. Feedback: isolato, validato dall'amministratore ─────────────────────
:as_m
select public.ai_feedback_submit(:'org_a', 'scoring', 'candidate', gen_random_uuid(), -1, '{"expected_priority":"medium"}', 'COMMENTO-RISERVATO-A') as fb \gset
select public.__expect_error(format($$select public.ai_feedback_review(%L, 'validate', true)$$, :'fb'), array['42501'], 'feedback: un membro non valida');
select public.__expect_error($$insert into public.ai_feedback (organization_id, agent_key, subject_type, subject_id, rating) values (gen_random_uuid(), 'scoring', 'lead', gen_random_uuid(), 1)$$, array['42501'], 'feedback: nessun inserimento diretto');
:as_b
select public.__expect((select count(*) = 0 from public.ai_feedback), 'feedback: un''altra organizzazione non lo vede');
select public.__expect_error(format($$select public.ai_feedback_submit(%L, 'scoring', 'lead', gen_random_uuid(), 1)$$, :'org_a'), array['42501'], 'feedback: non si scrive per un''altra organizzazione');
select public.__expect_error(format($$select public.ai_feedback_review(%L, 'validate', true)$$, :'fb'), array['42501'], 'feedback: un''altra organizzazione non valida');
:as_a
select public.__expect((public.ai_feedback_review(:'fb', 'validate', true) ->> 'status') = 'validated', 'feedback: validato dall''amministratore');
select public.__expect_error(format($$select public.ai_feedback_review(%L, 'reject')$$, :'fb'), array['P0001'], 'feedback: decisione non ripetibile');
select public.__expect((select count(*) = 1 from public.ai_company_memory where organization_id = :'org_a' and category = 'approved_feedback'), 'feedback: esempio nella memoria della SOLA organizzazione');
:as_b
select public.__expect((select count(*) = 0 from public.ai_company_memory where category = 'approved_feedback'), 'feedback: memoria di B senza esempi di A');

-- ── 3. Versioni di configurazione: gate e rollback ─────────────────────────
:as_a
select public.__expect_error($$select public.sa_ai_config_propose('quality_reviewer', 'quality_reviewer.blocking_codes', 'rules', '1.1.0', '{"blocking_codes":[]}', 'x')$$, array['42501'], 'configurazioni: un utente normale non propone');
select public.__expect((select count(*) = 0 from public.ai_agent_config_versions), 'configurazioni: non visibili agli utenti');
select public.__expect_error($$select public.sa_ai_training_overview()$$, array['42501'], 'dashboard training: negata agli utenti');
:as_s
select public.__expect_error($$select public.sa_ai_config_propose('strategy', 'strategy.model', 'fine_tuned_model', '1.0.0', '{"model_id":"ft:x"}', 'test')$$, array['22023'], 'fine-tuning: solo registrazione con approvazione dei costi');
select public.sa_ai_config_propose('quality_reviewer', 'quality_reviewer.blocking_codes', 'rules', '1.1.0', '{"blocking_codes":["duplicate_ids","contradiction","unsourced_fact"]}', 'Blocca anche i FACT senza fonte') as v2 \gset
select public.__expect_error(format($$select public.sa_ai_config_activate(%L, gen_random_uuid(), 'senza benchmark valido')$$, :'v2'), array['P0001'], 'attivazione: negata senza benchmark');
:as_service
insert into public.ai_benchmark_runs (benchmark_version, data_kind, candidate_version_id, report, gate_passed) values ('1.0.0', 'synthetic', :'v2', '{}', false) returning id as bfail \gset
insert into public.ai_benchmark_runs (benchmark_version, data_kind, candidate_version_id, report, gate_passed) values ('1.0.0', 'synthetic', :'v2', '{"comparisons":[]}', true) returning id as bok \gset
:as_s
select public.__expect_error(format($$select public.sa_ai_config_activate(%L, %L, 'gate non superato nel benchmark')$$, :'v2', :'bfail'), array['P0001'], 'attivazione: negata con gate non superato');
select public.__expect_error(format($$select public.sa_ai_config_activate(%L, %L, 'breve')$$, :'v2', :'bok'), array['22023'], 'attivazione: motivazione obbligatoria');
select public.__expect((public.sa_ai_config_activate(:'v2', :'bok', 'Benchmark superato sul test set sintetico') ->> 'status') = 'active', 'attivazione: con benchmark superato');
select public.__expect((select count(*) = 1 from public.ai_agent_config_versions where config_key = 'quality_reviewer.blocking_codes' and status = 'active'), 'configurazioni: una sola versione attiva');
:as_service
select public.__expect((public.ai_active_config('quality_reviewer.blocking_codes') -> 'blocking_codes') ? 'unsourced_fact', 'motore: legge la configurazione attiva');
:as_s
select public.__expect((public.sa_ai_config_rollback('quality_reviewer.blocking_codes', 'Rollback di prova del Prompt 12') ->> 'version') = '1.0.0', 'rollback immediato alla versione precedente');
:as_service
select public.__expect(not ((public.ai_active_config('quality_reviewer.blocking_codes') -> 'blocking_codes') ? 'unsourced_fact'), 'rollback: configurazione precedente di nuovo attiva');
:as_s
select public.sa_ai_training_overview() as ov \gset
select public.__expect(jsonb_array_length(:'ov'::jsonb -> 'versions') >= 2 and jsonb_array_length(:'ov'::jsonb -> 'benchmarks') = 2, 'dashboard training: versioni e benchmark');
select public.__expect(position('COMMENTO-RISERVATO-A' in :'ov') = 0, 'dashboard training: nessun contenuto dei feedback dei clienti');
select public.__expect((select count(*) >= 3 from public.admin_audit_logs where action like 'ai_config.%'), 'configurazioni: azioni registrate in audit');
:as_a
select public.__expect_error($$select public.ai_active_config('quality_reviewer.blocking_codes')$$, array['42501'], 'motore: configurazione attiva non leggibile dagli utenti');
\echo 'Test framework di training e feedback (Prompt 12) completati.'
