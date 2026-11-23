-- ════════════════════════════════════════════════════════════════════════════
-- Test accesso di test interno (0017: private.test_access_grants + piano internal_test):
-- accesso gratuito autorizzato, blocco degli utenti non autorizzati, isolamento tra organizzazioni,
-- ruoli, profilo aziendale, automazioni, revoca. Dati di test (.test), nessun cliente reale.
-- Enforcement dei piani ATTIVO in questo file.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set T '00000000-0000-0000-0000-0000000e5701'
\set TM '00000000-0000-0000-0000-0000000e5702'
\set X '00000000-0000-0000-0000-0000000e5703'
\set P '00000000-0000-0000-0000-0000000e5705'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_t 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000e5701"}'';'
\set as_tm 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000e5702"}'';'
\set as_x 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000e5703"}'';'
\set as_p 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000e5705"}'';'

:as_postgres
\o /dev/null
select private.billing_set_enforcement(true);
update public.billing_settings set free_beta_enabled = false where id;
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'T', 'tina@qa-internal.test', '{}', now()), (:'TM', 'tom@qa-internal.test', '{}', now()),
  (:'X', 'xena@other-co.test', '{}', now()), (:'P', 'paola@paying-co.test', '{}', now());
\o
select features::text as starter_before from public.billing_plans where code = 'starter' \gset

-- ── 1. Piano ───────────────────────────────────────────────────────────────
select public.__expect((select not is_active and price_cents = 0 and stripe_price_id is null from public.billing_plans where code = 'internal_test'), 'internal_test: non in vendita, prezzo zero, nessun Price Stripe');
select public.__expect((select features @> private.billing_known_features() from public.billing_plans where code = 'internal_test'), 'internal_test: include tutti i moduli');

:as_t
select id as org_t from public.create_organization('QA Interna Srl', null, 'IT') \gset
:as_x
select id as org_x from public.create_organization('Altra Azienda Srl', null, 'IT') \gset
:as_p
select id as org_p from public.create_organization('Cliente Pagante Srl', null, 'IT') \gset
:as_postgres
insert into public.organization_subscriptions (organization_id, source, stripe_subscription_id, plan_code, status, started_at)
values (:'org_p', 'stripe', 'sub_QAINTERNAL1', 'starter', 'active', now());
select count(*) as subs_before from public.organization_subscriptions \gset
select (select row_to_json(s)::text from public.organization_subscriptions s where organization_id = :'org_p') as paying_before \gset

-- ── 2. Prima della concessione: nessun accesso (errore osservato in Automazioni) ─────
select public.__expect(private.feature_check(:'org_t', 'automations') ->> 'reason' = 'no_subscription', 'prima: automazioni bloccate con no_subscription');

-- ── 3. Solo l'operatore (postgres) può concedere l'accesso ─────────────────
:as_t
select public.__expect_error($$select private.test_access_grant('tina@qa-internal.test', 'Mi concedo il test', 30, null)$$, array['42501'], 'concessione: un admin di org non può autoconcederla');
select public.__expect_error($$select count(*) from private.test_access_grants$$, array['42501'], 'concessioni: tabella non leggibile dai client');
:as_anon
select public.__expect_error($$select private.test_access_grant('tina@qa-internal.test', 'Tentativo anonimo xx', 30, null)$$, array['42501'], 'concessione: anonimo rifiutato');
:as_service
select public.__expect_error($$select private.test_access_grant('tina@qa-internal.test', 'Tentativo da server', 30, null)$$, array['42501'], 'concessione: nemmeno service_role (Netlify Functions)');
:as_postgres
select public.__expect_error($$select private.test_access_grant('tina@qa-internal.test', 'corta', 30, null)$$, array['22023'], 'concessione: motivazione obbligatoria');
select public.__expect_error($$select private.test_access_grant('tina@qa-internal.test', 'Durata non valida xx', 400, null)$$, array['22023'], 'concessione: durata massima 365 giorni');
select public.__expect_error(format($$select private.test_access_grant('tom@qa-internal.test', 'Tom non è admin di T', 30, %L)$$, :'org_t'), array['22023'], 'concessione: l''utente deve essere organization_admin dell''org indicata');
select public.__expect(jsonb_array_length(private.test_access_grant('tina@qa-internal.test', 'Account QA autorizzato', 30, :'org_t') -> 'organizations') = 1, 'concessione: riuscita per una sola organizzazione');
select public.__expect((select count(*) = 1 from private.test_access_status() where email = 'tina@qa-internal.test' and active), 'stato: concessione attiva visibile all''operatore');
select public.__expect((select count(*) >= 1 from public.admin_audit_logs where action = 'test_access.granted'), 'concessione: registrata in audit');

-- ── 4. Accesso completo solo all'organizzazione autorizzata ────────────────
select public.__expect((select bool_and((private.feature_check(:'org_t', f) ->> 'allowed')::boolean) from unnest(private.billing_known_features()) f), 'autorizzata: tutte le funzionalità consentite');
select public.__expect(private.org_entitlements(:'org_t') ->> 'source' = 'test' and private.org_entitlements(:'org_t') ->> 'plan_code' = 'internal_test', 'autorizzata: piano riconosciuto come internal_test');
select public.__expect((select (private.org_entitlements(:'org_t') ->> 'monthly_ai_credits')::int = monthly_ai_credits from public.billing_plans where code = 'internal_test'), 'limiti: crediti AI mensili presi dal piano (configurabili)');
select public.__expect(not (private.feature_check(:'org_x', 'automations') ->> 'allowed')::boolean, 'non autorizzata: automazioni bloccate');
select public.__expect(not (private.feature_check(:'org_x', 'ai_sales_agent') ->> 'allowed')::boolean, 'non autorizzata: AI Sales Agent bloccato');
select public.__expect((private.feature_check(:'org_p', 'ai_sales_agent') ->> 'reason') = 'feature_not_in_plan', 'cliente pagante: resta sul proprio piano commerciale');
select public.__expect((select count(*) from public.organization_subscriptions) = :subs_before, 'nessun abbonamento creato');
select public.__expect((select row_to_json(s)::text from public.organization_subscriptions s where organization_id = :'org_p') = :'paying_before', 'abbonamento Stripe esistente invariato');
select public.__expect((select features::text from public.billing_plans where code = 'starter') = :'starter_before', 'piani commerciali invariati');
:as_service
select public.__expect(public.billing_test_access(:'org_t') and not public.billing_test_access(:'org_x'), 'service_role: lettura booleana dello stato di test');
:as_t
select public.__expect_error(format($$select public.billing_test_access(%L)$$, :'org_t'), array['42501'], 'billing_test_access: non esposta ai client');
select public.__expect((public.billing_status(:'org_t') -> 'entitlements' ->> 'has_access')::boolean, 'billing_status: l''admin vede l''accesso attivo');

-- Il piano consente più utenti: si può aggiungere un membro.
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_t', :'TM', 'member');

-- ── 5. Automazioni ─────────────────────────────────────────────────────────
:as_t
insert into public.automation_workflows (organization_id, name, trigger, actions)
values (:'org_t', 'QA promemoria', 'lead_qualified', '[{"type":"create_reminder","days":1}]');
select id as wf_t from public.automation_workflows where name = 'QA promemoria' \gset
update public.automation_workflows set status = 'running' where id = :'wf_t';
select public.__expect((select status = 'running' and approved_by = :'T' from public.automation_workflows where id = :'wf_t'), 'automazioni: attivabili dall''admin dell''org autorizzata');
select public.__expect_error(format($$insert into public.automation_workflows (organization_id, name, trigger, actions) values (%L, 'Invio diretto', 'lead_qualified', '[{"type":"send_email"}]')$$, :'org_t'),
  array['23514'], 'automazioni: nessuna azione di invio diretto');
:as_tm
select public.__expect_error(format($$update public.automation_workflows set status = 'paused' where id = %L; update public.automation_workflows set status = 'running' where id = %L$$, :'wf_t', :'wf_t'),
  array['42501'], 'automazioni: un membro non può attivarle');
:as_x
insert into public.automation_workflows (organization_id, name, trigger, actions)
values (:'org_x', 'X promemoria', 'lead_qualified', '[{"type":"create_reminder","days":1}]');
select id as wf_x from public.automation_workflows where name = 'X promemoria' \gset
select public.__expect_error(format($$update public.automation_workflows set status = 'running' where id = %L$$, :'wf_x'), array['P0001'], 'automazioni: org non autorizzata bloccata');
select public.__expect((select count(*) = 0 from public.automation_workflows where id = :'wf_t'), 'isolamento: l''altra org non vede i workflow');

-- ── 6. Profilo aziendale e permessi ────────────────────────────────────────
:as_t
update public.organizations set name = 'QA Interna S.r.l.', data_retention_days = 365 where id = :'org_t';
select public.__expect((select name = 'QA Interna S.r.l.' from public.organizations where id = :'org_t'), 'profilo: l''admin salva i dati dell''azienda');
update public.organization_profiles set target_sectors = '{hotel}', weight_sector = 30, weight_geography = 20, weight_icp = 25, weight_signals = 15, weight_completeness = 10, updated_by = :'T' where organization_id = :'org_t';
select public.__expect((select target_sectors = '{hotel}' from public.organization_profiles where organization_id = :'org_t'), 'scoring: l''admin salva settori e pesi');
select public.__expect_error(format($$update public.organization_profiles set ideal_customer = 'x' where organization_id = %L$$, :'org_t'), array['42501'],
  'scoring: ideal_customer non scrivibile (causa del "Non hai i permessi")');
update public.sales_profiles set commercial_name = 'QA Interna', ideal_customer = 'Hotel indipendenti', updated_by = :'T' where organization_id = :'org_t';
select public.__expect((select ideal_customer = 'Hotel indipendenti' from public.organization_profiles where organization_id = :'org_t'), 'profilo commerciale: cliente ideale sincronizzato nello scoring');
:as_tm
update public.organizations set name = 'Membro' where id = :'org_t';
select public.__expect((select name = 'QA Interna S.r.l.' from public.organizations where id = :'org_t'), 'profilo: un membro non lo modifica');
:as_x
update public.organizations set name = 'Hijack' where id = :'org_t';
select public.__expect((select count(*) = 0 from public.organizations where id = :'org_t'), 'isolamento: l''altra org non legge l''organizzazione');
:as_postgres
select public.__expect((select name = 'QA Interna S.r.l.' from public.organizations where id = :'org_t'), 'isolamento: l''altra org non modifica l''organizzazione');

-- ── 7. Sospensione e revoca ────────────────────────────────────────────────
update public.organizations set admin_status = 'suspended' where id = :'org_t';
select public.__expect(not (private.feature_check(:'org_t', 'lead_finder') ->> 'allowed')::boolean, 'sospensione: prevale sull''accesso di test');
update public.organizations set admin_status = 'active' where id = :'org_t';
select public.__expect((private.test_access_revoke('tina@qa-internal.test', 'Fine periodo di test QA') ->> 'grants_revoked')::int = 1, 'revoca: riuscita');
select public.__expect(not (private.feature_check(:'org_t', 'automations') ->> 'allowed')::boolean, 'revoca: accesso rimosso');
select public.__expect((select status = 'paused' from public.automation_workflows where id = :'wf_t'), 'revoca: automazioni in esecuzione sospese');
select public.__expect((select count(*) from public.organization_subscriptions) = :subs_before, 'revoca: nessun abbonamento creato o modificato');

\o /dev/null
select private.billing_set_enforcement(false);
\o
