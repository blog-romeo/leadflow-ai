-- ════════════════════════════════════════════════════════════════════════════
-- Test Demand Hunter (0018): isolamento multi-tenant, RLS, nessuna scrittura dai client,
-- token di conferma monouso legati all'utente, limiti API per organizzazione, deduplicazione,
-- feedback. Solo dati simulati (.test, URL "esempio-simulato"), nessun cliente reale.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set A '00000000-0000-0000-0000-0000000d4801'
\set AM '00000000-0000-0000-0000-0000000d4802'
\set B '00000000-0000-0000-0000-0000000d4803'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000d4801"}'';'
\set as_am 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000d4802"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000d4803"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'A', 'anna@dh-alfa.test', '{}', now()), (:'AM', 'marco@dh-alfa.test', '{}', now()), (:'B', 'bea@dh-beta.test', '{}', now());
\o
:as_a
select id as org_a from public.create_organization('DH Alfa Srl', null, 'IT') \gset
:as_b
select id as org_b from public.create_organization('DH Beta Srl', null, 'IT') \gset
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_a', :'AM', 'member');

-- ── 1. Dati scritti dal server (service role) ─────────────────────────────
:as_service
insert into public.demand_hunter_jobs (organization_id, kind, status, confirmation_id, mode, reserved_calls, created_by)
values (:'org_a', 'hunt', 'running', gen_random_uuid(), 'simulated', 10, :'A') returning id as job_a \gset
insert into public.demand_hunter_sessions (organization_id, job_id, goal, seed, budget, mode, created_by)
values (:'org_a', :'job_a', 'clienti', 'Laravel', 10, 'simulated', :'A') returning id as ses_a \gset
insert into public.demand_hunter_combinations (organization_id, session_id, query, verb, object, origin, status, results, leads)
values (:'org_a', :'ses_a', 'site:facebook.com/groups "cerco" "Laravel"', 'cerco', 'Laravel', 'seed', 'provata', 3, 1);
insert into public.demand_hunter_leads (organization_id, session_id, url, url_hash, text_hash, text, goal, score, stage, demand, lead_class, simulated)
values (:'org_a', :'ses_a', 'https://www.facebook.com/groups/esempio-simulato/posts/1', repeat('a', 64), repeat('b', 64),
        'Stiamo cercando uno sviluppatore Laravel, budget 4000 euro', 'clienti', 96, 'high_intent', 'yes', 'cliente', true)
returning id as lead_a \gset
insert into public.demand_hunter_intent_classifications (organization_id, lead_id, author_role, intent_types, lead_score, evidence)
values (:'org_a', :'lead_a', 'buyer', '{service_demand}', 96, '[{"signal":"budget","match":"budget"}]');
insert into public.demand_hunter_feedback (organization_id, lead_id, verdict, user_id) values (:'org_a', :'lead_a', 'giusto', :'A');
insert into public.demand_hunter_concepts (organization_id, goal, label, norm, parent_norm, rel) values (:'org_a', 'clienti', 'siem per pmi', 'siem per pmi', 'siem', 'variante');
insert into public.demand_hunter_learning_stats (organization_id, goal, dimension, key, searches, leads) values (:'org_a', 'clienti', 'verbs', 'cerco', 1, 1);
select public.__expect(true, 'service role: scrive tutte le tabelle Demand Hunter');

-- ── 2. Lettura: solo i membri della propria organizzazione ────────────────
:as_a
select public.__expect((select count(*) = 1 from public.demand_hunter_leads), 'admin A: vede il lead della propria org');
select public.__expect((select count(*) = 1 from public.demand_hunter_intent_classifications), 'admin A: vede la classificazione con le prove');
:as_am
select public.__expect((select count(*) = 1 from public.demand_hunter_sessions) and (select count(*) = 1 from public.demand_hunter_feedback),
  'membro A: vede sessioni e feedback della propria org');
:as_b
select public.__expect((select count(*) = 0 from public.demand_hunter_jobs), 'isolamento: B non vede i job di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_sessions), 'isolamento: B non vede le sessioni di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_combinations), 'isolamento: B non vede le combinazioni di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_leads), 'isolamento: B non vede i lead di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_intent_classifications), 'isolamento: B non vede le classificazioni di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_feedback), 'isolamento: B non vede i feedback di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_concepts), 'isolamento: B non vede i concetti di A');
select public.__expect((select count(*) = 0 from public.demand_hunter_learning_stats), 'isolamento: B non vede le statistiche di A');
:as_anon
select public.__expect_error($$select count(*) from public.demand_hunter_leads$$, array['42501'], 'anonimo: nessun accesso ai lead');

-- ── 3. Nessuna scrittura diretta dai client (passa tutto dal server) ──────
:as_a
select public.__expect_error(format($$insert into public.demand_hunter_leads (organization_id, url, url_hash, text_hash, text, goal, score) values (%L, 'https://x.test/1', %L, %L, 't', 'clienti', 1)$$, :'org_a', repeat('c', 64), repeat('d', 64)),
  array['42501'], 'admin A: non inserisce lead direttamente');
select public.__expect_error(format($$update public.demand_hunter_leads set score = 1 where id = %L$$, :'lead_a'), array['42501'], 'admin A: non modifica i punteggi');
select public.__expect_error(format($$delete from public.demand_hunter_feedback where lead_id = %L$$, :'lead_a'), array['42501'], 'admin A: non cancella i feedback direttamente');
select public.__expect_error(format($$insert into public.demand_hunter_api_usage (organization_id, kind, quantity, mode) values (%L, 'release', -100, 'live')$$, :'org_a'),
  array['42501'], 'admin A: non si «restituisce» chiamate API');
select public.__expect_error(format($$insert into public.demand_hunter_limits (organization_id, monthly_paid_calls) values (%L, 100000)$$, :'org_a'),
  array['42501'], 'admin A: non alza i propri limiti');
select public.__expect_error($$select count(*) from public.demand_hunter_confirmations$$, array['42501'], 'token di conferma: non leggibili dai client');
select public.__expect_error(format($$select public.demand_hunter_reserve(%L, %L, null, 1, 'live')$$, :'org_a', :'A'), array['42501'], 'RPC prenotazione: vietata ai client');
select public.__expect_error(format($$select public.demand_hunter_consume_confirmation(%L, %L, %L, 'hunt', 'x')$$, :'org_a', :'A', repeat('e', 64)), array['42501'], 'RPC conferma: vietata ai client');
:as_anon
select public.__expect_error(format($$select public.demand_hunter_usage_summary(%L)$$, :'org_a'), array['42501'], 'RPC consumo: vietata agli anonimi');

-- ── 4. Token di conferma monouso, legati a utente, org e azione ───────────
:as_service
insert into public.demand_hunter_confirmations (organization_id, user_id, action, action_key, paid_calls, token_hash, expires_at)
values (:'org_a', :'A', 'hunt', 'hunt:clienti:laravel:10', 10, repeat('1', 64), now() + interval '10 minutes');
insert into public.demand_hunter_confirmations (organization_id, user_id, action, action_key, paid_calls, token_hash, expires_at, created_at)
values (:'org_a', :'A', 'hunt', 'hunt:clienti:laravel:10', 10, repeat('2', 64), now() - interval '1 minute', now() - interval '20 minutes');
select public.__expect(not (public.demand_hunter_consume_confirmation(:'org_a', :'AM', repeat('1', 64), 'hunt', 'hunt:clienti:laravel:10') ->> 'ok')::boolean,
  'conferma: un altro utente della stessa org non può usarla');
select public.__expect(not (public.demand_hunter_consume_confirmation(:'org_b', :'A', repeat('1', 64), 'hunt', 'hunt:clienti:laravel:10') ->> 'ok')::boolean,
  'conferma: non vale per un''altra organizzazione');
select public.__expect(not (public.demand_hunter_consume_confirmation(:'org_a', :'A', repeat('1', 64), 'hunt', 'hunt:clienti:laravel:50') ->> 'ok')::boolean,
  'conferma: non vale per un budget diverso');
select public.__expect((public.demand_hunter_consume_confirmation(:'org_a', :'A', repeat('1', 64), 'hunt', 'hunt:clienti:laravel:10') ->> 'ok')::boolean,
  'conferma: valida per utente, org, azione e budget giusti');
select public.__expect(not (public.demand_hunter_consume_confirmation(:'org_a', :'A', repeat('1', 64), 'hunt', 'hunt:clienti:laravel:10') ->> 'ok')::boolean,
  'conferma: monouso (la seconda richiesta identica è rifiutata)');
select public.__expect(not (public.demand_hunter_consume_confirmation(:'org_a', :'A', repeat('2', 64), 'hunt', 'hunt:clienti:laravel:10') ->> 'ok')::boolean,
  'conferma: scaduta, rifiutata');
select public.__expect_error(format($$insert into public.demand_hunter_jobs (organization_id, kind, confirmation_id) select organization_id, kind, confirmation_id from public.demand_hunter_jobs where id = %L$$, :'job_a'),
  array['23505'], 'job: una conferma avvia al massimo un job');

-- ── 5. Limiti API per organizzazione ──────────────────────────────────────
select public.__expect((public.demand_hunter_usage_summary(:'org_b') ->> 'monthly_paid_calls')::int = 200, 'limiti: valore predefinito 200 chiamate/mese');
select public.__expect((public.demand_hunter_reserve(:'org_b', :'B', null, 51, 'simulated') ->> 'reason') = 'budget_per_hunt', 'limiti: budget per caccia oltre il massimo rifiutato');
:as_postgres
insert into public.demand_hunter_limits (organization_id, monthly_paid_calls, max_budget_per_hunt) values (:'org_b', 30, 20);
:as_service
insert into public.demand_hunter_jobs (organization_id, kind, confirmation_id, reserved_calls, created_by, mode)
values (:'org_b', 'hunt', gen_random_uuid(), 20, :'B', 'live') returning id as job_b \gset
select public.__expect((public.demand_hunter_reserve(:'org_b', :'B', :'job_b', 20, 'live') ->> 'allowed')::boolean, 'limiti: prenotazione entro il mese accettata');
select public.__expect((public.demand_hunter_reserve(:'org_b', :'B', null, 15, 'live') ->> 'reason') = 'monthly_limit', 'limiti: oltre il limite mensile rifiutata');
select public.__expect((public.demand_hunter_reserve(:'org_b', :'B', null, 15, 'simulated') ->> 'allowed')::boolean, 'limiti: le chiamate simulate non consumano il limite mensile');
select public.__expect((public.demand_hunter_usage_summary(:'org_b') ->> 'used')::int = 20, 'consumo: conta solo le chiamate live');
select public.__expect((public.demand_hunter_usage_summary(:'org_a') ->> 'used')::int = 0, 'limiti: il consumo di B non pesa su A');
select public.__expect((public.demand_hunter_settle(:'org_b', :'job_b', 7) ->> 'released')::int = 13, 'chiusura: restituite le 13 chiamate non usate');
select public.__expect((public.demand_hunter_settle(:'org_b', :'job_b', 0) ->> 'released')::int = 0, 'chiusura: idempotente (nessun doppio rimborso)');
select public.__expect((public.demand_hunter_usage_summary(:'org_b') ->> 'used')::int = 7, 'consumo: 7 chiamate effettive nel mese');
select public.__expect_error(format($$select public.demand_hunter_settle(%L, %L, 0)$$, :'org_a', :'job_b'), array['P0002'], 'chiusura: un job di B non si chiude dall''org A');
:as_postgres
update public.demand_hunter_limits set enabled = false where organization_id = :'org_b';
:as_service
select public.__expect((public.demand_hunter_reserve(:'org_b', :'B', null, 1, 'simulated') ->> 'reason') = 'disabled', 'limiti: modulo disattivato per l''organizzazione');

-- ── 6. Deduplicazione e integrità ─────────────────────────────────────────
select public.__expect_error(format($$insert into public.demand_hunter_leads (organization_id, url, url_hash, text_hash, text, goal, score) values (%L, 'https://www.facebook.com/groups/esempio-simulato/posts/1', %L, %L, 'altro', 'clienti', 50)$$, :'org_a', repeat('a', 64), repeat('f', 64)),
  array['23505'], 'dedup: stesso URL nella stessa org rifiutato');
select public.__expect_error(format($$insert into public.demand_hunter_leads (organization_id, url, url_hash, text_hash, text, goal, score) values (%L, 'https://www.facebook.com/groups/esempio-simulato/posts/2', %L, %L, 'stesso testo', 'clienti', 50)$$, :'org_a', repeat('9', 64), repeat('b', 64)),
  array['23505'], 'dedup: stesso testo sotto un altro URL rifiutato');
insert into public.demand_hunter_leads (organization_id, url, url_hash, text_hash, text, goal, score)
values (:'org_b', 'https://www.facebook.com/groups/esempio-simulato/posts/1', repeat('a', 64), repeat('b', 64), 'stesso post, altra org', 'clienti', 50);
select public.__expect(true, 'dedup: per organizzazione (lo stesso post può essere un lead di B)');
select public.__expect_error(format($$insert into public.demand_hunter_leads (organization_id, session_id, url, url_hash, text_hash, text, goal, score) values (%L, %L, 'https://x.test/3', %L, %L, 't', 'clienti', 1)$$, :'org_b', :'ses_a', repeat('7', 64), repeat('8', 64)),
  array['23503'], 'integrità: un lead di B non può puntare a una sessione di A');
select public.__expect_error(format($$insert into public.demand_hunter_feedback (organization_id, lead_id, verdict) values (%L, %L, 'giusto')$$, :'org_b', :'lead_a'),
  array['23503'], 'integrità: B non dà feedback a un lead di A');
select public.__expect_error(format($$update public.demand_hunter_leads set organization_id = %L where id = %L$$, :'org_b', :'lead_a'), array['42501'], 'integrità: organization_id immutabile');
select public.__expect_error(format($$update public.demand_hunter_leads set status = 'transferred' where id = %L$$, :'lead_a'), array['23514'], 'CRM: «trasferito» richiede il lead del CRM');

-- ── 7. Feedback: uno per lead, solo Giusto/Sbagliato ───────────────────────
select public.__expect_error(format($$insert into public.demand_hunter_feedback (organization_id, lead_id, verdict) values (%L, %L, 'forse')$$, :'org_a', :'lead_a'), array['23514'], 'feedback: solo giusto o sbagliato');
insert into public.demand_hunter_feedback (organization_id, lead_id, verdict, user_id) values (:'org_a', :'lead_a', 'sbagliato', :'AM')
on conflict (organization_id, lead_id) do update set verdict = excluded.verdict, user_id = excluded.user_id;
select public.__expect((select verdict = 'sbagliato' and user_id = :'AM' from public.demand_hunter_feedback where lead_id = :'lead_a'), 'feedback: l''ultimo giudizio sostituisce il precedente');

-- ── 8. Nuovo provider per il CRM ──────────────────────────────────────────
select public.__expect('demand_hunter' = any (enum_range(null::public.lead_provider)::text[]), 'CRM: provider demand_hunter disponibile');

:as_postgres
\echo 'Test Demand Hunter (0018) completati.'
