-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 13: beta gratuita (piano manuale a costo zero) e cancellazione di account e
-- organizzazione (REL-47). Dati di test (.test), nessun cliente reale.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set A '00000000-0000-0000-0000-0000000be201'
\set M '00000000-0000-0000-0000-0000000be202'
\set C '00000000-0000-0000-0000-0000000be203'
\set S '00000000-0000-0000-0000-0000000be204'
\set D '00000000-0000-0000-0000-0000000be205'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000be201"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000be202"}'';'
\set as_c 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000be203"}'';'
\set as_s 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000be204"}'';'
\set as_d 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000be205"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'A', 'ada@beta-a.test', '{}', now()), (:'M', 'mia@beta-a.test', '{}', now()), (:'C', 'carlo@beta-c.test', '{}', now()),
  (:'S', 'sam@leadflow-beta.test', '{}', now()), (:'D', 'dora@beta-d.test', '{}', now());
select private.set_platform_role('sam@leadflow-beta.test', 'super_admin', 'Test beta Prompt 13');
\o

-- ── 1. Beta gratuita ───────────────────────────────────────────────────────
select public.__expect((select not free_beta_enabled from public.billing_settings where id), 'beta: disattivata per default');
select public.__expect((select not is_active and price_cents = 0 and monthly_ai_credits = 200 from public.billing_plans where code = 'beta'), 'beta: piano a costo zero, non in vendita, con tetto di crediti');
:as_a
select id as org_a from public.create_organization('Beta A Srl', null, 'IT') \gset
select public.__expect((select count(*) = 0 from public.organization_subscriptions where organization_id = :'org_a'), 'beta spenta: nessun piano concesso alla nuova organizzazione');
select public.__expect_error($$select public.sa_set_free_beta(true, true, 'Tentativo non autorizzato')$$, array['42501'], 'beta: solo il super admin la attiva');
:as_anon
select public.__expect_error($$select public.sa_set_free_beta(true, true, 'Tentativo anonimo xx')$$, array['42501'], 'beta: anonimo rifiutato');
:as_s
select public.__expect_error($$select public.sa_set_free_beta(true, true, 'corta')$$, array['22023'], 'beta: motivazione obbligatoria');
select public.__expect((public.sa_set_free_beta(true, true, 'Apertura beta gratuita di prova') ->> 'granted')::int >= 1, 'beta: attivata con concessione alle organizzazioni esistenti');
select public.__expect((public.sa_set_free_beta(true, true, 'Seconda esecuzione idempotente') ->> 'granted')::int = 0, 'beta: nessuna doppia concessione');
select public.__expect((select count(*) >= 2 from public.admin_audit_logs where action = 'billing.free_beta_set'), 'beta: attivazione registrata in audit');
:as_postgres
select public.__expect((select count(*) = 1 from public.organization_subscriptions where organization_id = :'org_a' and plan_code = 'beta' and source = 'manual' and status = 'active'), 'beta: piano manuale attivo, nessuno Stripe');
select public.__expect((private.org_entitlements(:'org_a') ->> 'has_access')::boolean, 'beta: l''organizzazione ha accesso senza pagare');
:as_c
select id as org_c from public.create_organization('Beta C Srl', null, 'IT') \gset
:as_postgres
select public.__expect((select count(*) = 1 from public.organization_subscriptions where organization_id = :'org_c' and plan_code = 'beta'), 'beta: concessa automaticamente alle nuove organizzazioni');
insert into public.organization_members (organization_id, user_id, role) values (:'org_c', :'M', 'member');
:as_c
select public.__expect_error($$select public.onboarding_advance('choose_plan', 'beta')$$, array['22023', 'P0001'], 'beta: non selezionabile come piano in vendita');

-- ── 2. Cancellazione dell'organizzazione ───────────────────────────────────
:as_m
select public.__expect_error(format($$select public.organization_request_deletion(%L, 'Beta C Srl')$$, :'org_c'), array['42501'], 'org: un membro non può cancellarla');
:as_a
select public.__expect_error(format($$select public.organization_request_deletion(%L, 'Beta C Srl')$$, :'org_c'), array['42501'], 'org: un''altra organizzazione non può cancellarla');
:as_c
select public.__expect_error(format($$select public.organization_request_deletion(%L, 'Nome sbagliato')$$, :'org_c'), array['22023'], 'org: conferma con il nome obbligatoria');
:as_postgres
insert into public.organization_subscriptions (organization_id, source, stripe_subscription_id, plan_code, status, started_at)
values (:'org_c', 'stripe', 'sub_TESTBETA01', 'starter', 'active', now());
:as_c
select public.__expect_error(format($$select public.organization_request_deletion(%L, 'beta c srl')$$, :'org_c'), array['P0001'], 'org: bloccata con abbonamento a pagamento attivo');
:as_postgres
update public.organization_subscriptions set status = 'canceled', ended_at = now() where stripe_subscription_id = 'sub_TESTBETA01';
:as_c
select public.__expect((public.organization_request_deletion(:'org_c', '  beta c srl ') ->> 'purge_after') is not null, 'org: disattivata con data di eliminazione definitiva');
select public.__expect(not private.is_org_member(:'org_c'), 'org: l''amministratore perde subito l''accesso');
select public.__expect((select count(*) = 0 from public.organizations where id = :'org_c'), 'org: non più visibile');
:as_m
select public.__expect(not private.is_org_member(:'org_c'), 'org: anche i membri perdono l''accesso');
:as_postgres
select public.__expect((select count(*) = 0 from public.organization_subscriptions where organization_id = :'org_c' and source = 'manual' and status = 'active'), 'org: piano beta chiuso');
select public.__expect((select count(*) = 1 from public.audit_logs where organization_id = :'org_c' and action = 'organization.deletion_requested'), 'org: richiesta registrata in audit');

-- ── 3. Cancellazione dell'account ──────────────────────────────────────────
:as_d
select id as org_d from public.create_organization('Beta D Srl', null, 'IT') \gset
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_d', :'M', 'member'), (:'org_a', :'M', 'member');
:as_d
select public.__expect((select (o ->> 'other_members')::int = 1 and (o ->> 'other_admins')::int = 0 from jsonb_array_elements(public.account_deletion_preflight() -> 'organizations') o limit 1), 'account: anteprima con membri e amministratori');
select public.__expect_error($$select public.account_delete_self('dora@beta-d.test')$$, array['P0001'], 'account: unico amministratore con altri membri → nominare un altro amministratore');
select public.__expect_error($$select public.account_delete_self('altra@email.test')$$, array['22023'], 'account: conferma con l''email obbligatoria');
:as_m
select public.__expect((public.account_delete_self('MIA@beta-a.test') ->> 'organizations_deactivated')::int = 0, 'account: membro semplice cancellato senza toccare le organizzazioni');
:as_postgres
select public.__expect((select count(*) = 0 from public.organization_members where user_id = :'M'), 'account: rimosso da tutte le organizzazioni');
select public.__expect((select deleted_at is null from public.organizations where id = :'org_a'), 'account: le organizzazioni degli altri restano attive');
delete from auth.users where id = :'M';
select public.__expect((select count(*) = 0 from public.profiles where id = :'M'), 'account: utente Auth eliminabile, profilo eliminato');
:as_a
select public.__expect((public.account_delete_self('ada@beta-a.test') ->> 'organizations_deactivated')::int = 1, 'account: unico membro → organizzazione disattivata');
:as_postgres
select public.__expect((select deleted_at is not null from public.organizations where id = :'org_a'), 'account: organizzazione dell''unico membro disattivata');
delete from auth.users where id = :'A';
select public.__expect((select count(*) = 0 from auth.users where id = :'A'), 'account: eliminazione Auth non bloccata dalla regola dell''ultimo amministratore');
:as_s
select public.__expect_error($$select public.account_delete_self('sam@leadflow-beta.test')$$, array['P0001'], 'account: un super admin non si cancella da solo');
:as_anon
select public.__expect_error($$select public.account_delete_self('x@y.test')$$, array['42501'], 'account: anonimo rifiutato');

-- ── 4. Regola dell'ultimo amministratore ancora valida sulle organizzazioni attive ──
:as_postgres
select public.__expect_error(format($$delete from public.organization_members where organization_id = %L and user_id = %L$$, :'org_d', :'D'), array['P0001'], 'ultimo amministratore: protetto sulle organizzazioni attive');

-- ── 5. Eliminazione definitiva dopo 30 giorni ──────────────────────────────
update public.organizations set deleted_at = now() - interval '31 days' where id in (:'org_a', :'org_c');
insert into public.billing_invoices (stripe_invoice_id, organization_id, status, currency) values ('in_TESTBETA01', :'org_c', 'paid', 'eur');
:as_a
select public.__expect_error($$select public.run_retention_purge()$$, array['42501'], 'purge: non eseguibile dagli utenti');
:as_service
select public.run_retention_purge() as purge \gset
:as_postgres
select public.__expect((:'purge'::jsonb -> 'organizations' ->> 'purged')::int >= 1, 'purge: organizzazioni scadute eliminate');
select public.__expect((select count(*) = 0 from public.organizations where id = :'org_a'), 'purge: dati dell''organizzazione eliminati definitivamente');
select public.__expect((select count(*) = 1 from public.organizations where id = :'org_c') and (:'purge'::jsonb -> 'organizations' ->> 'kept_fiscal')::int >= 1, 'purge: organizzazione con fatture conservata (obblighi fiscali)');
select public.__expect((select count(*) = 1 from public.organizations where id = :'org_d' and deleted_at is null), 'purge: organizzazioni attive intatte');

-- Ripristino: beta spenta per i test successivi.
:as_s
select public.sa_set_free_beta(false, false, 'Fine test beta Prompt 13') \gset
\echo 'Test beta gratuita e cancellazione account (Prompt 13) completati.'
