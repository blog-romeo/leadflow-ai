-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 6: onboarding guidato, richieste demo, ticket di supporto, funnel,
-- errori applicativi e monitoraggio. Include una simulazione SQL del percorso cliente
-- (registrazione → onboarding → checkout → abbonamento → prima ricerca → primo lead → prima analisi).
-- I dati Stripe sono valori di test passati come farebbe il webhook verificato: nessuna transazione reale.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set S  '00000000-0000-0000-0000-0000000dd601'
\set A  '00000000-0000-0000-0000-0000000dd602'
\set M  '00000000-0000-0000-0000-0000000dd603'
\set B  '00000000-0000-0000-0000-0000000dd604'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_s 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000dd601"}'';'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000dd602"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000dd603"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000dd604"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data) values
  (:'S', 'staff@leadflow-launch.it', '{}'), (:'A', 'alice@azienda-a.it', '{"full_name":"Alice Rossi"}'),
  (:'M', 'mario@azienda-a.it', '{}'), (:'B', 'bruno@azienda-b.it', '{}');
\o
select private.set_platform_role('staff@leadflow-launch.it', 'super_admin', 'Staff di assistenza, nomina interna') \g /dev/null

-- ── 1. Registrazione: evento signup_completed generato dal database, una sola volta ──
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'signup_completed' and user_id = :'A'), 'registrazione tracciata (signup_completed)');
select public.__expect((select count(*) = 0 from public.funnel_events where event = 'signup_completed' and properties ? 'email'), 'nessuna email negli eventi del funnel');

-- ── 2. Onboarding guidato, ripristinabile ──────────────────────────────────
:as_a
select public.__expect((public.onboarding_state() ->> 'step')::int = 2, 'onboarding: si riparte dal passo azienda');
select public.__expect((public.onboarding_state() ->> 'organization_id') is null, 'onboarding: nessuna organizzazione ancora');
select id as org_a from public.create_organization('Azienda A Srl', null, 'IT') \gset
select public.__expect_error(format($$select public.onboarding_save_company(%L, 'Software', 'javascript:alert(1)', '10-49')$$, :'org_a'), array['22023'], 'sito web non valido rifiutato');
select public.__expect_error(format($$select public.onboarding_save_company(%L, 'Software', 'azienda-a.it', 'enorme')$$, :'org_a'), array['22023'], 'dimensione non valida rifiutata');
select public.onboarding_save_company(:'org_a', 'Software gestionale', 'azienda-a.it', '10-49') \g /dev/null
select public.__expect((select (company ->> 'website') = 'https://azienda-a.it' and step = 3 from public.onboarding_progress where user_id = :'A'), 'dati azienda salvati, passo 3');
select public.__expect((select sector = 'Software gestionale' and website = 'https://azienda-a.it' from public.sales_profiles where organization_id = :'org_a'), 'settore e sito copiati nel profilo commerciale');
select public.onboarding_save_commercial(:'org_a', 'Gestionali per PMI', 'Aziende manifatturiere 10-50 dipendenti', 'Lombardia, Veneto', 'Nuovi clienti B2B') \g /dev/null
select public.__expect((select services_description = 'Gestionali per PMI' and target_regions = array['Lombardia', 'Veneto'] from public.organization_profiles where organization_id = :'org_a'),
  'profilo commerciale → profilo Lead Finder');
select public.__expect((select offer_description = 'Gestionali per PMI' from public.sales_profiles where organization_id = :'org_a'), 'profilo commerciale → profilo Sales Agent');
select public.__expect((public.onboarding_state() ->> 'step')::int = 4, 'ripresa: lo stato salvato riporta al passo 4');
select public.__expect_error($$select public.onboarding_advance('choose_plan', 'platinum')$$, array['22023'], 'piano inesistente rifiutato');
select public.onboarding_advance('choose_plan', 'business') \g /dev/null
-- Il redirect di successo non basta: senza abbonamento attivo il pagamento non risulta confermato.
select public.__expect_error($$select public.onboarding_advance('payment_confirmed')$$, array['P0001'], 'pagamento non confermato senza webhook');
select public.__expect((select count(*) = 0 from public.funnel_events), 'il cliente non legge il funnel');
:as_postgres
select public.__expect((select count(*) = 0 from public.funnel_events where event = 'subscription_activated' and organization_id = :'org_a'), 'nessuna attivazione simulata');
:as_a
-- Un utente non può scrivere direttamente lo stato dell'onboarding.
select public.__expect_error($$update public.onboarding_progress set step = 6, completed_at = now() where user_id = auth.uid()$$, array['42501'], 'onboarding non modificabile via REST');
select public.__expect_error(format($$insert into public.funnel_events (event, dedup_key, organization_id) values ('subscription_activated', 'x', %L)$$, :'org_a'), array['42501'], 'eventi del funnel non falsificabili');

:as_b
select public.__expect_error(format($$select public.onboarding_save_company(%L, 'X', null, null)$$, :'org_a'), array['42501'], 'un altro utente non modifica l''onboarding di A');
select public.__expect_error(format($$select public.onboarding_checklist(%L)$$, :'org_a'), array['42501'], 'checklist di altre organizzazioni negata');
select public.__expect((select count(*) = 0 from public.onboarding_progress), 'onboarding di altri utenti non visibile');
select id as org_b from public.create_organization('Azienda B Srl', null, 'IT') \gset

-- ── 3. Checkout e attivazione via webhook (dati di test) ───────────────────
:as_postgres
insert into public.billing_audit_logs (organization_id, actor_type, actor_id, action, metadata)
values (:'org_a', 'user', :'A', 'checkout.started', '{"plan":"business","mode":"test"}'),
       (:'org_a', 'user', :'A', 'checkout.started', '{"plan":"business","mode":"test"}');
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'checkout_started' and organization_id = :'org_a'), 'checkout_started deduplicato');
:as_service
select public.billing_link_customer(:'org_a', 'cus_TESTlaunchA1', false) \g /dev/null
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_a', 'stripe_subscription_id', 'sub_TESTlaunchA1', 'stripe_customer_id', 'cus_TESTlaunchA1',
  'stripe_price_id', 'price_TESTbusiness', 'plan_code', 'business', 'status', 'active', 'unit_amount_cents', 34900,
  'currency', 'eur', 'billing_interval', 'month', 'interval_count', 1,
  'current_period_start', date_trunc('day', now()), 'current_period_end', date_trunc('day', now()) + interval '30 days',
  'started_at', now(), 'stripe_synced_at', now(), 'event_type', 'checkout.session.completed')) \g /dev/null
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'subscription_activated' and organization_id = :'org_a'), 'subscription_activated dal webhook');
:as_a
select public.onboarding_advance('payment_confirmed') \g /dev/null
select public.__expect((select step = 6 and not payment_deferred from public.onboarding_progress where user_id = :'A'), 'pagamento confermato dopo il webhook');
select public.onboarding_advance('tour_done') \g /dev/null
select public.onboarding_advance('complete') \g /dev/null
select public.onboarding_advance('complete') \g /dev/null
:as_postgres
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'onboarding_completed' and user_id = :'A'), 'onboarding_completed una sola volta');
:as_a
select public.__expect((public.onboarding_checklist(:'org_a') ->> 'has_access')::boolean and not (public.onboarding_checklist(:'org_a') ->> 'first_search')::boolean, 'checklist: accesso sì, ricerca no');

-- B rimanda il pagamento: nessun abbonamento viene creato.
:as_b
select public.onboarding_advance('choose_plan', 'starter') \g /dev/null
select public.onboarding_advance('defer_payment') \g /dev/null
select public.__expect((select payment_deferred from public.onboarding_progress where user_id = :'B'), 'pagamento rimandato registrato');
select public.__expect(not (public.onboarding_checklist(:'org_b') ->> 'has_access')::boolean, 'pagamento rimandato: nessun accesso ai moduli a pagamento');

-- ── 4. Attivazione: prima ricerca, primo lead, prima analisi AI (deduplicati) ──
:as_postgres
insert into public.lead_searches (organization_id, provider, params, created_by) values
  (:'org_a', 'osm_overpass', '{"sector":"manifattura","location":"Brescia"}', :'A'),
  (:'org_a', 'osm_overpass', '{"sector":"manifattura","location":"Verona"}', :'A');
insert into public.lead_sources (organization_id, name, type, legal_basis) values (:'org_a', 'Ricerca', 'manual', 'legitimate_interest') returning id as src_a \gset
insert into public.leads (organization_id, source_id, company_name, created_by) values (:'org_a', :'src_a', 'Officina Uno', :'A'), (:'org_a', :'src_a', 'Officina Due', :'A');
insert into public.ai_jobs (organization_id, type, task, created_by) values (:'org_a', 'business_analysis', 'business_analysis', :'A') returning id as job_a \gset
update public.ai_jobs set status = 'running' where id = :'job_a';
update public.ai_jobs set status = 'succeeded', tokens_input = 100, tokens_output = 50, cost_usd = 0.001 where id = :'job_a';
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'first_lead_search' and organization_id = :'org_a'), 'first_lead_search una sola volta');
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'first_lead_saved' and organization_id = :'org_a'), 'first_lead_saved una sola volta');
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'first_ai_analysis' and organization_id = :'org_a'), 'first_ai_analysis registrato');
:as_a
select public.__expect((public.onboarding_checklist(:'org_a') ->> 'first_ai_analysis')::boolean, 'checklist: prima analisi completata');

-- ── 5. Eventi pubblici (consenso gestito dal server) ───────────────────────
:as_anon
select public.__expect_error($$select public.track_public_event('landing_visit', '0123456789abcdef0123456789abcdef', '/')$$, array['42501'], 'anon non scrive eventi direttamente');
select public.__expect_error($$select * from public.funnel_events$$, array['42501'], 'anon non legge il funnel');
:as_service
select public.__expect(public.track_public_event('landing_visit', '0123456789abcdef0123456789abcdef', '/'), 'visita registrata');
select public.__expect(not public.track_public_event('landing_visit', '0123456789abcdef0123456789abcdef', '/'), 'visita duplicata nello stesso giorno ignorata');
select public.__expect(public.track_public_event('pricing_viewed', '0123456789abcdef0123456789abcdef', '/prezzi?email=mario@example.com'), 'pricing_viewed registrato');
select public.__expect_error($$select public.track_public_event('subscription_activated', '0123456789abcdef0123456789abcdef')$$, array['22023'], 'eventi interni non inviabili dal sito');
select public.__expect_error($$select public.track_public_event('landing_visit', 'mario.rossi@example.com')$$, array['22023'], 'id anonimo non può contenere dati personali');
select public.__expect((select (properties ->> 'page') is null from public.funnel_events where event = 'pricing_viewed' and anonymous_id = '0123456789abcdef0123456789abcdef'),
  'percorso non valido scartato');

-- ── 6. Limiti di frequenza pubblici ────────────────────────────────────────
select public.__expect((select bool_and(public.public_rate_limit(repeat('a', 64), 'demo', 3, 60)) from generate_series(1, 3)), 'entro il limite');
select public.__expect(not public.public_rate_limit(repeat('a', 64), 'demo', 3, 60), 'oltre il limite: bloccato');
select public.__expect(public.public_rate_limit(repeat('b', 64), 'demo', 3, 60), 'altra chiave non influenzata');
select public.__expect_error($$select public.public_rate_limit('192.168.1.1', 'demo', 3, 60)$$, array['23514'], 'IP in chiaro non memorizzabile');

-- ── 7. Richieste demo: solo il server scrive, solo lo staff legge ─────────
:as_anon
select public.__expect_error($$insert into public.demo_requests (name, company, email, sector, message, contact_preference, consent_at) values ('Spam', 'Spam', 'a@b.it', 'x', 'messaggio di prova', 'email', now())$$,
  array['42501'], 'anon non scrive richieste demo direttamente');
:as_service
insert into public.demo_requests (name, company, email, sector, employees, message, contact_preference, consent_at)
values ('Laura Bianchi', 'Bianchi Srl', 'laura@bianchi-srl.it', 'Logistica', '10-49', 'Vorremmo vedere il Lead Finder.', 'email', now())
returning id as demo1 \gset
select public.__expect_error($$insert into public.demo_requests (name, company, email, sector, message, contact_preference, consent_at) values ('Test', 'Test Srl', 'test@test.it', 'IT', 'messaggio di prova', 'phone', now())$$,
  array['23514'], 'preferenza telefono senza numero rifiutata');
select public.__expect_error($$insert into public.demo_requests (name, company, email, sector, message, contact_preference, consent_at) values ('<script>', 'Test Srl', 'test@test.it', 'IT', 'messaggio di prova', 'email', now())$$,
  array['23514'], 'markup nel nome rifiutato');
select public.__expect((select count(*) = 1 from public.funnel_events where event = 'demo_requested' and dedup_key = 'demo_requested:' || :'demo1'), 'demo_requested tracciato');
:as_a
select public.__expect((select count(*) = 0 from public.demo_requests), 'i clienti non vedono le richieste demo');
select public.__expect_error($$select public.sa_demo_requests(null)$$, array['42501'], 'elenco demo riservato allo staff');
:as_s
select public.__expect(jsonb_array_length(public.sa_demo_requests('new')) = 1, 'staff: richiesta demo visibile');
select public.sa_update_demo_request(:'demo1', 'contacted', 'Chiamata fissata per giovedì') \g /dev/null
select public.__expect((select status = 'contacted' and handled_by = :'S' from public.demo_requests where id = :'demo1'), 'stato demo aggiornato dallo staff');
select public.__expect((select count(*) = 1 from public.admin_audit_logs where action = 'demo_request.updated'), 'aggiornamento demo in audit');

-- ── 8. Ticket di supporto: isolamento, stato, cronologia, notifiche ───────
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_a', :'M', 'member');
:as_m
select public.support_create_ticket(:'org_a', 'Import CSV non funziona', 'lead_finder', 'normal', 'Il file da 2 MB restituisce un errore.') as t_m \gset
select public.__expect((select count(*) = 1 from public.support_tickets), 'il membro vede il proprio ticket');
:as_a
select public.support_create_ticket(:'org_a', 'Domanda sulla fattura', 'billing', 'high', 'Serve la fattura con il codice destinatario.') as t_a \gset
select public.__expect((select count(*) = 2 from public.support_tickets where organization_id = :'org_a'), 'l''admin vede tutti i ticket dell''organizzazione');
:as_m
select public.__expect((select count(*) = 1 from public.support_tickets), 'il membro non vede i ticket dei colleghi');
select public.__expect((select count(*) = 0 from public.support_ticket_messages where ticket_id = :'t_a'), 'il membro non legge i messaggi altrui');
:as_b
select public.__expect((select count(*) = 0 from public.support_tickets where organization_id = :'org_a'), 'un''altra azienda non vede i ticket');
select public.__expect_error(format($$select public.support_reply(%L, 'intrusione')$$, :'t_a'), array['P0002'], 'un''altra azienda non risponde ai ticket');
select public.__expect_error(format($$select public.support_create_ticket(%L, 'Ticket', 'other', 'normal', 'corpo')$$, :'org_a'), array['42501'], 'ticket su organizzazione altrui negato');
select public.__expect_error(format($$update public.support_tickets set status = 'resolved' where id = %L$$, :'t_a'), array['42501'], 'stato non modificabile via REST');
:as_a
select public.__expect_error(format($$select public.support_set_status(%L, 'resolved')$$, :'t_a'), array['42501'], 'il cliente non segna "risolto"');
:as_s
select public.__expect(jsonb_array_length(public.sa_support_tickets(null)) = 2, 'staff: tutti i ticket');
select public.support_reply(:'t_a', 'Gentile cliente, la fattura è disponibile nel portale di fatturazione.') \g /dev/null
select public.__expect((select status = 'waiting_customer' and customer_unread from public.support_tickets where id = :'t_a'), 'risposta staff: in attesa del cliente');
select public.support_set_status(:'t_a', 'resolved') \g /dev/null
:as_a
select public.__expect((select count(*) = 1 from public.notifications where user_id = :'A' and link = '/app/support?ticket=' || :'t_a'), 'notifica in-app della risposta');
select public.__expect((select count(*) = 2 from public.support_ticket_messages where ticket_id = :'t_a'), 'cronologia completa del ticket');
select public.__expect((select count(*) = 1 from public.support_ticket_messages where ticket_id = :'t_a' and author_role = 'staff'), 'messaggio staff riconoscibile');
select public.support_mark_read(:'t_a') \g /dev/null
select public.__expect((select not customer_unread and status = 'resolved' from public.support_tickets where id = :'t_a'), 'letto dal cliente');
select public.support_set_status(:'t_a', 'closed') \g /dev/null
select public.__expect_error(format($$select public.support_reply(%L, 'ancora una cosa')$$, :'t_a'), array['P0001'], 'ticket chiuso: il cliente riapre prima di rispondere');
select public.support_set_status(:'t_a', 'open') \g /dev/null
select public.support_reply(:'t_a', 'Ancora una domanda sulla fattura.') \g /dev/null
select public.__expect((select status = 'waiting_staff' and staff_unread from public.support_tickets where id = :'t_a'), 'riapertura: in attesa dello staff');

-- ── 9. Errori applicativi e monitoraggio ──────────────────────────────────
:as_a
select public.__expect_error($$select public.record_app_error('client', 'x', 'y', '/', null, 'abcdef0123456789')$$, array['42501'], 'i clienti non scrivono errori direttamente');
select public.__expect((select count(*) = 0 from public.app_errors), 'i clienti non leggono gli errori');
select public.__expect_error($$select public.sa_system_status()$$, array['42501'], 'stato del sistema riservato al super admin');
:as_service
select public.record_app_error('function', 'internal_error', 'TypeError at handler', '/api/leads', 'abc123', 'abcdef0123456789') from generate_series(1, 25) \g /dev/null
select public.__expect((select count(*) = 1 and sum(occurrences) = 25 from public.app_errors where fingerprint = 'abcdef0123456789'), 'errori aggregati per impronta');
select public.__expect_error($$select public.record_app_error('function', 'x', 'y', '/', null, 'non-hex!')$$, array['23514'], 'impronta non valida rifiutata');
:as_postgres
insert into public.stripe_webhook_events (event_id, event_type, livemode, status, last_error) values ('evt_TESTlaunchfail', 'invoice.paid', false, 'failed', 'org_not_found');
:as_service
select public.__expect((select count(*) >= 2 from jsonb_array_elements(public.monitoring_evaluate() -> 'new_alerts')), 'avvisi critici generati (webhook falliti, errori API)');
select public.__expect(jsonb_array_length(public.monitoring_evaluate() -> 'new_alerts') = 0, 'avvisi deduplicati nella giornata');
select public.monitoring_mark_notified(array['webhook_failed'], null) \g /dev/null
select public.__expect((select notified_at is not null from public.monitoring_alerts where kind = 'webhook_failed'), 'avviso segnato come notificato');
:as_s
select public.__expect((public.sa_system_status() -> 'webhooks' ->> 'failed_24h')::int = 1, 'stato sistema: webhook falliti');
select public.__expect((public.sa_system_status() -> 'errors' ->> 'function_24h')::int = 25, 'stato sistema: errori API');
select public.__expect(jsonb_array_length(public.sa_system_status() -> 'alerts') >= 2, 'stato sistema: avvisi elencati');
:as_postgres
delete from public.stripe_webhook_events where event_id = 'evt_TESTlaunchfail';

-- ── 9b. Assistente: job AI senza crediti commerciali, soggetto a pausa e tetti di spesa ──
:as_service
insert into public.ai_jobs (organization_id, type, status, created_by, input) values (:'org_b', 'support_assistant', 'running', :'B', '{"locale":"it"}') returning id as job_assist \gset
update public.ai_jobs set status = 'succeeded', tokens_input = 900, tokens_output = 120, cost_usd = 0.0005 where id = :'job_assist';
select public.__expect((select ai_credits_used = 0 and ai_credits_reserved = 0 from public.usage_quotas where organization_id = :'org_b') is not false, 'assistente: nessun credito commerciale consumato');
:as_postgres
select public.__expect((select count(*) = 0 from public.funnel_events where event = 'first_ai_analysis' and organization_id = :'org_b'), 'l''assistente non conta come prima analisi AI');
update public.platform_settings set value = value || '{"ai_paused": true}' where key = 'operations';
:as_service
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, status, created_by) values (%L, 'support_assistant', 'running', %L)$$, :'org_b', :'B'),
  array['P0001'], 'pausa AI: anche l''assistente AI si ferma (risponde con la documentazione)');
:as_postgres
update public.platform_settings set value = value - 'ai_paused' where key = 'operations';

-- ── 10. Metriche di crescita ──────────────────────────────────────────────
:as_a
select public.__expect_error($$select public.sa_growth(null, null)$$, array['42501'], 'metriche di crescita riservate');
:as_s
select public.sa_growth(now() - interval '1 day', now() + interval '1 minute') as g \gset
select public.__expect((:'g'::jsonb ->> 'signups')::int >= 3, 'registrazioni contate');
select public.__expect((:'g'::jsonb ->> 'cohort_paid')::int >= 1, 'clienti paganti della coorte');
select public.__expect((:'g'::jsonb ->> 'cohort_activated')::int >= 1, 'organizzazioni attivate (prima ricerca)');
select public.__expect((:'g'::jsonb ->> 'onboarding_completed')::int >= 1, 'onboarding completati');
select public.__expect((:'g'::jsonb ->> 'visitors_consented')::int >= 1, 'visitatori con consenso');
select public.__expect((:'g'::jsonb ->> 'mrr') is not null, 'MRR presente');
select public.__expect_error($$select public.sa_growth(now(), now() - interval '1 day')$$, array['22023'], 'intervallo non valido');

:as_postgres
\echo 'Tutti i test Launch & Growth sono passati.'
