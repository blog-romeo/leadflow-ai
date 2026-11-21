-- ════════════════════════════════════════════════════════════════════════════
-- Eseguito dopo le suite di billing (ordine alfabetico "zy"): crea un abbonamento di test che altererebbe
-- le verifiche di fatturato a livello di piattaforma di rls_tests_billing.sql.
-- Test Prompt 8: motore multi-agent.
-- Isolamento tra organizzazioni, nessuna scrittura diretta, approvazioni e annullamento solo con
-- il ruolo corretto, memoria aziendale versionata e cancellabile, vincoli FACT/INFERENCE/UNKNOWN,
-- crediti AI della Strategy Agent legati ai job, registri append-only, metriche del Growth Analyst.
-- Abbonamenti simulati come dal webhook verificato (dati di test, nessuna transazione).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set A  '00000000-0000-0000-0000-0000000aa801'
\set M  '00000000-0000-0000-0000-0000000aa802'
\set B  '00000000-0000-0000-0000-0000000aa803'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000aa801"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000aa802"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000aa803"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'A', 'anna@agenti-a.test', '{"full_name":"Anna Admin"}', now()),
  (:'M', 'marco@agenti-a.test', '{"full_name":"Marco Membro"}', now()),
  (:'B', 'bruno@agenti-b.test', '{}', now());
\o
:as_a
select id as org_a from public.create_organization('Agenti A Srl', null, 'IT') \gset
:as_b
select id as org_b from public.create_organization('Agenti B Srl', null, 'IT') \gset
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_a', :'M', 'member');

-- ── 1. Dati scritti dal server (service role) ──────────────────────────────
:as_service
insert into public.ai_workflows (organization_id, template, objective, params, idempotency_key, budget_credits, created_by)
values (:'org_a', 'prospecting', 'Trova hotel a Roma', '{"sector":"hotel"}', 'wf-test-0001', 40, :'A') returning id as wf \gset
insert into public.ai_workflow_steps (organization_id, workflow_id, position, agent_key, action, requires_approval, status)
values (:'org_a', :'wf', 1, 'discovery', 'discover', false, 'completed') returning id as s1 \gset
insert into public.ai_workflow_steps (organization_id, workflow_id, position, agent_key, action, depends_on, requires_approval, status)
values (:'org_a', :'wf', 2, 'orchestrator', 'crm.save_leads', '{1}', true, 'waiting_approval') returning id as s2 \gset
insert into public.ai_agent_runs (organization_id, workflow_id, step_id, agent_key, status, created_by)
values (:'org_a', :'wf', :'s1', 'discovery', 'succeeded', :'A') returning id as run1 \gset
insert into public.ai_agent_tool_calls (organization_id, run_id, workflow_id, agent_key, tool, outcome, args_summary)
values (:'org_a', :'run1', :'wf', 'discovery', 'provider.search', 'succeeded', '{"provider":"osm_overpass"}');
insert into public.ai_research_evidence (organization_id, workflow_id, run_id, subject_type, subject_id, category, kind, statement, evidence, source_type, source_url)
values (:'org_a', :'wf', :'run1', 'candidate', gen_random_uuid(), 'profile', 'fact', 'Hotel con sito web', 'website: https://hotel.example', 'provider', 'https://www.openstreetmap.org/node/1');
insert into public.ai_agent_costs (organization_id, workflow_id, run_id, agent_key, kind, model, tokens_input, tokens_output, credits, cost_usd)
values (:'org_a', :'wf', :'run1', 'research', 'ai_tokens', 'test-model', 1000, 500, 1, 0.004);
insert into public.ai_agent_approvals (organization_id, workflow_id, step_id, action, summary)
values (:'org_a', :'wf', :'s2', 'crm.save_leads', '{"count":10}') returning id as ap1 \gset
update public.ai_workflows set status = 'waiting_approval' where id = :'wf';

-- ── 2. Isolamento: l'altra organizzazione e anon non vedono nulla ───────────
:as_b
select public.__expect((select count(*) = 0 from public.ai_workflows), 'isolamento: ai_workflows');
select public.__expect((select count(*) = 0 from public.ai_workflow_steps), 'isolamento: ai_workflow_steps');
select public.__expect((select count(*) = 0 from public.ai_agent_runs), 'isolamento: ai_agent_runs');
select public.__expect((select count(*) = 0 from public.ai_agent_tool_calls), 'isolamento: ai_agent_tool_calls');
select public.__expect((select count(*) = 0 from public.ai_agent_approvals), 'isolamento: ai_agent_approvals');
select public.__expect((select count(*) = 0 from public.ai_research_evidence), 'isolamento: ai_research_evidence');
select public.__expect((select count(*) = 0 from public.ai_agent_costs), 'isolamento: ai_agent_costs');
select public.__expect_error(format($$select public.ai_agent_spend(%L, now() - interval '1 day')$$, :'org_a'), array['42501'], 'spesa agenti di un''altra organizzazione non leggibile');
select public.__expect_error(format($$select public.ai_growth_metrics(%L, now() - interval '30 days', now())$$, :'org_a'), array['42501'], 'metriche di un''altra organizzazione non leggibili');
:as_m
select public.__expect((select count(*) = 1 from public.ai_workflows where id = :'wf'), 'un membro vede i workflow della propria organizzazione');
select public.__expect((select count(*) = 1 from public.ai_research_evidence), 'un membro vede le evidenze della propria organizzazione');
:as_anon
select public.__expect_error($$select count(*) from public.ai_workflows$$, array['42501'], 'anon non legge i workflow');
select public.__expect_error($$select count(*) from public.ai_company_memory$$, array['42501'], 'anon non legge la memoria');

-- ── 3. Nessuna scrittura diretta dagli utenti ──────────────────────────────
:as_a
select public.__expect_error(format($$insert into public.ai_workflows (organization_id, template, idempotency_key, budget_credits) values (%L, 'growth_report', 'direct-insert-1', 1)$$, :'org_a'), array['42501'], 'nessun inserimento diretto di workflow');
select public.__expect_error(format($$update public.ai_workflows set budget_credits = 5000 where id = %L$$, :'wf'), array['42501'], 'nessuna modifica diretta del budget');
select public.__expect_error(format($$update public.ai_agent_approvals set status = 'approved' where id = %L$$, :'ap1'), array['42501'], 'nessuna approvazione senza RPC');
select public.__expect_error(format($$insert into public.ai_research_evidence (organization_id, subject_type, subject_id, category, kind, statement, source_type) values (%L, 'lead', gen_random_uuid(), 'fit', 'inference', 'x', 'ai')$$, :'org_a'), array['42501'], 'nessuna evidenza scritta dagli utenti');
select public.__expect_error(format($$insert into public.ai_company_memory (organization_id, category, entry_key, version, content, source, expires_at) values (%L, 'services', 'k', 1, '{}', 'user', now() + interval '1 day')$$, :'org_a'), array['42501'], 'memoria solo tramite RPC');
select public.__expect_error(format($$delete from public.ai_agent_costs where organization_id = %L$$, :'org_a'), array['42501'], 'registro costi non cancellabile');

-- ── 4. Vincoli FACT / INFERENCE / UNKNOWN e stati finali ───────────────────
:as_service
select public.__expect_error(format($$insert into public.ai_research_evidence (organization_id, subject_type, subject_id, category, kind, statement, source_type) values (%L, 'lead', gen_random_uuid(), 'profile', 'fact', 'Senza fonte', 'ai')$$, :'org_a'), array['23514'], 'un FACT senza fonte verificabile è rifiutato');
select public.__expect_error(format($$insert into public.ai_research_evidence (organization_id, subject_type, subject_id, category, kind, statement, evidence, source_type) values (%L, 'lead', gen_random_uuid(), 'profile', 'fact', 'Senza estratto', '  ', 'website')$$, :'org_a'), array['23514'], 'un FACT senza estratto è rifiutato');
select public.__expect_error(format($$insert into public.ai_research_evidence (organization_id, subject_type, subject_id, category, kind, statement, source_type) values (%L, 'lead', gen_random_uuid(), 'missing', 'unknown', 'Fatturato', 'website')$$, :'org_a'), array['23514'], 'un UNKNOWN non ha fonte');
select public.__expect_error(format($$insert into public.ai_research_evidence (organization_id, subject_type, subject_id, category, kind, statement, source_type) values (%L, 'lead', gen_random_uuid(), 'fit', 'inference', 'Deduzione', 'website')$$, :'org_a'), array['23514'], 'un''INFERENCE è sempre attribuita all''AI');
select public.__expect_error(format($$update public.ai_agent_tool_calls set outcome = 'failed' where organization_id = %L$$, :'org_a'), array['42501'], 'registro tool call append-only');
select public.__expect_error(format($$update public.ai_workflows set budget_credits = 99 where id = %L$$, :'wf'), array['P0001'], 'budget del workflow immutabile anche per il server');
insert into public.ai_workflows (organization_id, template, idempotency_key, budget_credits, created_by, status)
values (:'org_a', 'growth_report', 'wf-test-done1', 0, :'A', 'completed') returning id as wf_done \gset
select public.__expect_error(format($$update public.ai_workflows set status = 'running' where id = %L$$, :'wf_done'), array['P0001'], 'un workflow concluso non si riattiva');
select public.__expect_error(format($$insert into public.ai_workflows (organization_id, template, idempotency_key, budget_credits) values (%L, 'growth_report', 'wf-test-done1', 0)$$, :'org_a'), array['23505'], 'idempotenza: stessa chiave nella stessa organizzazione');
insert into public.ai_workflows (organization_id, template, idempotency_key, budget_credits) values (:'org_b', 'growth_report', 'wf-test-done1', 0);
select public.__expect(true, 'la stessa chiave è libera in un''altra organizzazione');
select public.__expect_error(format($$insert into public.ai_workflow_steps (organization_id, workflow_id, position, agent_key, action) values (%L, %L, 9, 'discovery', 'discover')$$, :'org_b', :'wf'), array['23503'], 'un passo non può puntare al workflow di un''altra organizzazione');
:as_postgres
select public.__expect((select count(*) >= 2 from public.audit_logs where entity_id = :'wf' and action in ('ai_workflow.created', 'ai_workflow.status')), 'audit di creazione e cambio stato del workflow');

-- ── 5. Approvazioni: solo amministratori della stessa organizzazione ───────
:as_m
select public.__expect_error(format($$select public.ai_agent_decide_approval(%L, 'approve')$$, :'ap1'), array['42501'], 'un membro non approva operazioni ad alto impatto');
:as_b
select public.__expect_error(format($$select public.ai_agent_decide_approval(%L, 'approve')$$, :'ap1'), array['P0002'], 'un''altra organizzazione non vede l''approvazione');
:as_service
select public.__expect_error(format($$select public.ai_agent_decide_approval(%L, 'approve')$$, :'ap1'), array['42501'], 'il server (agenti) non può approvarsi da solo');
:as_a
select public.__expect_error(format($$select public.ai_agent_decide_approval(%L, 'forse')$$, :'ap1'), array['22023'], 'decisione non valida');
select public.ai_agent_decide_approval(:'ap1', 'approve', 'ok, procedi') \g /dev/null
select public.__expect((select status = 'approved' and decided_by = :'A' from public.ai_agent_approvals where id = :'ap1'), 'approvazione registrata con l''autore');
select public.__expect((select status = 'pending' and input ? 'approval_id' from public.ai_workflow_steps where id = :'s2'), 'il passo approvato torna eseguibile');
select public.__expect((select status = 'pending' from public.ai_workflows where id = :'wf'), 'il workflow è pronto per riprendere');
select public.__expect_error(format($$select public.ai_agent_decide_approval(%L, 'reject')$$, :'ap1'), array['P0001'], 'una decisione non si ripete');
:as_postgres
select public.__expect((select count(*) = 1 from public.audit_logs where action = 'ai_approval.approved' and entity_id = :'ap1'), 'audit della decisione');

-- Approvazione scaduta.
:as_service
update public.ai_workflows set status = 'waiting_approval' where id = :'wf';
update public.ai_workflow_steps set status = 'waiting_approval' where id = :'s2';
insert into public.ai_agent_approvals (organization_id, workflow_id, step_id, action, requested_at, expires_at)
values (:'org_a', :'wf', :'s2', 'crm.save_leads', now() - interval '4 days', now() - interval '1 day') returning id as ap_old \gset
:as_a
select public.__expect_error(format($$select public.ai_agent_decide_approval(%L, 'approve')$$, :'ap_old'), array['P0001'], 'approvazione scaduta non utilizzabile');

-- ── 6. Interruzione ─────────────────────────────────────────────────────────
:as_b
select public.__expect_error(format($$select public.ai_workflow_request_cancel(%L)$$, :'wf'), array['P0002'], 'un''altra organizzazione non interrompe il workflow');
:as_m
select public.__expect_error(format($$select public.ai_workflow_request_cancel(%L)$$, :'wf'), array['42501'], 'un membro non interrompe il workflow di un altro utente');
:as_a
select public.__expect((public.ai_workflow_request_cancel(:'wf') ->> 'status') = 'cancelled', 'workflow in attesa annullato subito');
select public.__expect((select status = 'cancelled' and error_code = 'cancelled_by_user' from public.ai_workflows where id = :'wf'), 'stato annullato');
select public.__expect((select bool_and(status in ('cancelled', 'completed')) from public.ai_workflow_steps where workflow_id = :'wf'), 'passi non eseguiti annullati');
select public.__expect((select count(*) = 0 from public.ai_agent_approvals where workflow_id = :'wf' and status = 'pending'), 'nessuna approvazione rimasta in attesa');
:as_service
insert into public.ai_workflows (organization_id, template, idempotency_key, budget_credits, created_by, status)
values (:'org_a', 'growth_report', 'wf-test-run01', 0, :'M', 'running') returning id as wf_run \gset
:as_m
select public.__expect((public.ai_workflow_request_cancel(:'wf_run') ->> 'cancel_requested')::boolean, 'chi ha avviato il workflow può interromperlo');
select public.__expect((select status = 'running' and cancel_requested_at is not null from public.ai_workflows where id = :'wf_run'), 'in esecuzione: richiesta registrata, il motore si ferma al punto di controllo');

-- ── 7. Configurazione degli agenti ─────────────────────────────────────────
:as_m
select public.__expect_error(format($$select public.ai_agent_configure(%L, 'research', '{"enabled": false}')$$, :'org_a'), array['42501'], 'un membro non configura gli agenti');
:as_service
select public.__expect_error(format($$select public.ai_agent_configure(%L, 'research', '{"enabled": false}')$$, :'org_a'), array['42501'], 'gli agenti (server) non modificano la propria configurazione');
:as_a
select public.__expect_error(format($$select public.ai_agent_configure(%L, 'payments', '{}')$$, :'org_a'), array['22023'], 'agente sconosciuto');
select public.__expect_error(format($$select public.ai_agent_configure(%L, 'research', '{"role": "organization_admin"}')$$, :'org_a'), array['22023'], 'solo i campi previsti sono modificabili');
select public.__expect_error(format($$select public.ai_agent_configure(%L, 'research', '{"config": {"api_key": "x"}}')$$, :'org_a'), array['22023'], 'nessuna chiave di configurazione arbitraria');
select public.__expect((public.ai_agent_configure(:'org_a', 'research', '{"model_tier": "economy", "max_credits_per_run": 20, "config": {"cache_days": 14}}')).model_tier = 'economy', 'configurazione salvata');
select public.__expect((select count(*) = 1 from public.ai_agents where organization_id = :'org_a' and agent_key = 'research' and (config ->> 'cache_days')::int = 14), 'configurazione leggibile dai membri');
:as_b
select public.__expect((select count(*) = 0 from public.ai_agents), 'configurazione isolata per organizzazione');

-- ── 8. Memoria aziendale ───────────────────────────────────────────────────
:as_m
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'services', 'catalogo', '{"items":["Siti web"]}')$$, :'org_a'), array['42501'], 'un membro non modifica la memoria commerciale');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'approved_strategies', 'lead-m', '{}')$$, :'org_a'), array['42501'], 'un membro non approva strategie');
select public.__expect((public.ai_memory_upsert(:'org_a', 'user_feedback', 'strategia-hotel', '{"note":"Troppo formale"}') ->> 'version')::int = 1, 'un membro lascia un feedback');
:as_a
select public.__expect((public.ai_memory_upsert(:'org_a', 'services', 'catalogo', '{"items":["Siti web"]}') ->> 'version')::int = 1, 'memoria: versione 1');
select public.__expect((public.ai_memory_upsert(:'org_a', 'services', 'catalogo', '{"items":["Siti web","SEO"]}', 30) ->> 'version')::int = 2, 'memoria: versione 2');
select public.__expect((select count(*) = 1 from public.ai_company_memory where category = 'services' and status = 'active' and version = 2), 'una sola versione attiva');
select public.__expect((select count(*) = 1 from public.ai_company_memory where category = 'services' and status = 'superseded' and version = 1), 'versione precedente conservata');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'campaign_results', 'x', '{}')$$, :'org_a'), array['22023'], 'i risultati delle campagne sono scritti solo dal server');
select public.__expect((public.ai_memory_upsert(:'org_a', 'approved_strategies', 'lead-z', '{"approved":true}') ->> 'version')::int = 1, 'un amministratore approva esplicitamente una strategia salvandola');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'services', 'x', '{}', 5000)$$, :'org_a'), array['22023'], 'conservazione massima 3 anni');
select public.__expect_error(format($$select public.ai_memory_upsert(%L, 'services', 'x', '{}')$$, :'org_b'), array['42501'], 'nessuna scrittura nella memoria di un''altra organizzazione');
select public.__expect_error(format($$select public.ai_memory_record(%L, 'approved_strategies', 'x', '{}', %L)$$, :'org_a', :'A'), array['42501'], 'scrittura "approvata" riservata al server');
select public.__expect_error($$select public.ai_memory_purge_expired()$$, array['42501'], 'rimozione della memoria scaduta riservata al server');
:as_b
select public.__expect((select count(*) = 0 from public.ai_company_memory), 'memoria isolata per organizzazione');
:as_service
select public.__expect_error(format($$select public.ai_memory_record(%L, 'approved_strategies', 'lead-x', '{"s":1}', %L, null)$$, :'org_a', :'A'), array['P0001'], 'strategia in memoria solo con approvazione');
select public.__expect_error(format($$select public.ai_memory_record(%L, 'services', 'k', '{}', %L, %L)$$, :'org_a', :'A', :'ap1'), array['22023'], 'il server non riscrive il profilo commerciale');
select public.__expect((public.ai_memory_record(:'org_a', 'approved_strategies', 'lead-x', '{"s":1}', :'A', :'ap1') ->> 'version')::int = 1, 'strategia approvata registrata in memoria');
select public.__expect_error(format($$select public.ai_memory_record(%L, 'approved_strategies', 'lead-y', '{"s":1}', %L, %L)$$, :'org_b', :'B', :'ap1'), array['P0001'], 'un''approvazione di un''altra organizzazione non vale');
-- Memoria scaduta: invisibile agli utenti, rimossa solo dalla funzione del server.
:as_postgres
update public.ai_company_memory set expires_at = now() - interval '1 minute' where category = 'user_feedback';
:as_m
select public.__expect((select count(*) = 0 from public.ai_company_memory where category = 'user_feedback'), 'memoria scaduta non più leggibile');
:as_m
select public.__expect_error(format($$select public.ai_memory_delete(%L, 'services', 'catalogo')$$, :'org_a'), array['42501'], 'un membro non cancella la memoria');
:as_a
select public.__expect(public.ai_memory_delete(:'org_a', 'services', 'catalogo') = 2, 'cancellazione di tutte le versioni di una voce');
select public.__expect((select count(*) = 0 from public.ai_company_memory where category = 'services'), 'voce cancellata');
:as_postgres
select public.__expect((select count(*) = 1 from public.audit_logs where action = 'ai_memory.deleted' and (metadata ->> 'versions_deleted')::int = 2
  and metadata::text not like '%SEO%'), 'audit della cancellazione senza contenuto');
:as_service
select public.__expect(public.ai_memory_purge_expired() = 1, 'rimozione fisica della memoria scaduta (solo server, non pianificata)');

-- ── 9. Crediti: la Strategy Agent passa dai trigger di billing ──────────────
:as_postgres
select private.billing_set_enforcement(true) \g /dev/null
:as_service
\o /dev/null
insert into public.lead_sources (organization_id, name, type, legal_basis) values (:'org_a', 'Test agenti', 'manual', 'legitimate_interest') returning id as src_a \gset
\o
insert into public.leads (organization_id, source_id, company_name, industry) values (:'org_a', :'src_a', 'Hotel Aurora', 'hotel') returning id as lead_a \gset
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, lead_id, status, created_by) values (%L, 'sales_agent', 'sales_strategy', %L, 'queued', %L)$$, :'org_a', :'lead_a', :'A'),
  array['P0001'], 'senza abbonamento la Strategy Agent non crea job AI');
select public.billing_link_customer(:'org_a', 'cus_TESTagentsA', false) \g /dev/null
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_a', 'stripe_subscription_id', 'sub_TESTagentsA', 'stripe_customer_id', 'cus_TESTagentsA',
  'stripe_price_id', 'price_TESTbusiness', 'plan_code', 'business', 'status', 'active', 'unit_amount_cents', 34900,
  'currency', 'eur', 'billing_interval', 'month', 'interval_count', 1,
  'current_period_start', date_trunc('day', now()), 'current_period_end', date_trunc('day', now()) + interval '30 days',
  'started_at', now(), 'stripe_synced_at', now(), 'event_type', 'checkout.session.completed')) \g /dev/null
insert into public.ai_jobs (organization_id, type, task, lead_id, status, created_by) values (:'org_a', 'sales_agent', 'sales_strategy', :'lead_a', 'queued', :'A') returning id as job_s \gset
select public.__expect((select quantity = 2 and status = 'reserved' and operation = 'agent_sales_strategy' from public.usage_ledger where ai_job_id = :'job_s'), 'strategia: 2 crediti prenotati');
update public.ai_jobs set status = 'failed' where id = :'job_s';
select public.__expect((select status = 'released' from public.usage_ledger where ai_job_id = :'job_s'), 'strategia fallita: crediti rimborsati');
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, status) values (%L, 'sales_agent', 'invented_task', 'queued')$$, :'org_a'), array['23514'], 'compiti AI non previsti rifiutati');
:as_postgres
select private.billing_set_enforcement(false) \g /dev/null

-- ── 10. Metriche Growth Analyst e spesa ────────────────────────────────────
:as_a
select public.ai_growth_metrics(:'org_a', now() - interval '30 days', now() + interval '1 minute') as gm \gset
select public.__expect((:'gm'::jsonb ->> 'leads_acquired')::int = 1, 'metriche: lead acquisiti nel periodo');
select public.__expect(jsonb_typeof(:'gm'::jsonb -> 'by_sector') = 'array' and (:'gm'::jsonb ->> 'responses') is not null, 'metriche per settore e risposte');
select public.__expect_error(format($$select public.ai_growth_metrics(%L, now(), now() - interval '1 day')$$, :'org_a'), array['22023'], 'periodo non valido');
select public.__expect((public.ai_agent_spend(:'org_a', now() - interval '1 day') ->> 'credits')::int = 1, 'spesa degli agenti nel periodo');
:as_service
select public.__expect((public.ai_growth_metrics(:'org_a', now() - interval '30 days', now() + interval '1 minute') ->> 'leads_acquired')::int = 1, 'metriche disponibili al server');

\echo 'Tutti i test Motore multi-agent sono passati.'
