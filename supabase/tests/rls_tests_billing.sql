-- ════════════════════════════════════════════════════════════════════════════
-- Test Billing (Prompt 4): piani, entitlement, crediti AI (prenotazione/conferma/
-- rimborso/idempotenza/saldo mai negativo), quote lead deduplicate, webhook
-- idempotenti, eventi fuori ordine, upgrade/downgrade/rinnovo/cancellazione,
-- limiti utenti, funzionalità controllate dal DB, RLS cross-tenant, super admin.
-- Le chiamate "service" simulano le Netlify Functions (service role): i dati Stripe
-- sono valori di test, non transazioni reali.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set P '00000000-0000-0000-0000-0000000bb001'
\set Q '00000000-0000-0000-0000-0000000bb002'
\set R '00000000-0000-0000-0000-0000000bb003'
\set S '00000000-0000-0000-0000-0000000bb004'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_p 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000bb001"}'';'
\set as_q 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000bb002"}'';'
\set as_r 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000bb003"}'';'
\set as_s 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000bb004"}'';'

:as_postgres
select private.billing_set_enforcement(true) \g /dev/null
\o /dev/null
insert into auth.users (id, email) values (:'P', 'paola@pi.test'), (:'Q', 'quinto@qu.test'), (:'R', 'rita@pi.test'), (:'S', 'sergio@leadflow.test');
\o
update public.profiles set platform_role = 'super_admin' where id = :'S';
:as_p
\o /dev/null
select public.create_organization('Pi Servizi Srl', null, 'IT');
\o
:as_q
\o /dev/null
select public.create_organization('Qu Digital Srl', null, 'IT');
\o
:as_postgres
select id as org_p from public.organizations where created_by = :'P' \gset
select id as org_q from public.organizations where created_by = :'Q' \gset

-- ── 1. Nessun abbonamento ───────────────────────────────────────────────────
:as_p
select public.__expect((public.billing_can_use_feature(:'org_p', 'lead_finder') ->> 'reason') = 'no_subscription',
  'senza abbonamento il Lead Finder non è disponibile');
select public.__expect((public.billing_status(:'org_p') -> 'entitlements' ->> 'has_access')::boolean = false,
  'billing_status: nessun accesso senza piano');
:as_service
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'business_analysis', 'business_analysis', %L)$$, :'org_p', :'P'),
  array['P0001'], 'nessun job AI senza abbonamento (trigger di prenotazione)');
:as_postgres
select public.__expect_error(format($$insert into public.organization_members (organization_id, user_id, role) values (%L, %L, 'member')$$, :'org_p', :'R'),
  array['P0001'], 'senza piano non si aggiungono utenti oltre il primo');

-- ── 2. I client non modificano piano, crediti o contatori ───────────────────
:as_p
select public.__expect_error(format($$insert into public.organization_subscriptions (organization_id, source, plan_code, status) values (%L, 'manual', 'enterprise', 'active')$$, :'org_p'),
  array['42501'], 'un utente non si assegna un piano');
select public.__expect_error(format($$insert into public.usage_quotas (organization_id, period_start, period_end, ai_credits_limit) values (%L, now(), now() + interval '1 month', 999999)$$, :'org_p'),
  array['42501'], 'un utente non crea quote');
select public.__expect_error($$update public.billing_plans set monthly_ai_credits = 999999 where code = 'starter'$$,
  array['42501'], 'un utente non modifica i limiti di un piano');
select public.__expect_error(format($$select public.billing_reserve_credits(%L, %L, 'lead_analysis', 'x-key-1')$$, :'org_p', :'P'),
  array['42501'], 'un utente non chiama il motore crediti');
select public.__expect_error(format($$select public.billing_apply_subscription('{"organization_id":"%s"}'::jsonb)$$, :'org_p'),
  array['42501'], 'un utente non applica abbonamenti');
select public.__expect_error(format($$select private.billing_grant_manual_plan(%L, 'enterprise')$$, :'org_p'),
  array['42501'], 'un utente non si concede piani manuali');
select public.__expect_error(format($$select private.billing_pause_disallowed(%L)$$, :'org_q'),
  array['42501'], 'un utente non invoca funzioni interne di billing');
select public.__expect_error($$select public.admin_update_billing_plan('starter', '{"price_cents": 1}')$$,
  array['42501'], 'solo il super admin modifica i piani');
:as_service
select public.__expect_error(format($$select private.billing_grant_manual_plan(%L, 'enterprise')$$, :'org_p'),
  array['42501'], 'nemmeno la service role concede piani manuali');

-- ── 3. Checkout completato: customer + abbonamento Starter ──────────────────
:as_service
select public.__expect(public.billing_link_customer(:'org_p', 'cus_TESTpi0001', false) = 'cus_TESTpi0001', 'customer collegato all''organizzazione');
select public.__expect(public.billing_link_customer(:'org_p', 'cus_TESTpiDUPL', false) = 'cus_TESTpi0001', 'un secondo customer non sostituisce il primo');
select public.billing_link_customer(:'org_q', 'cus_TESTqu0001', false) \g /dev/null
select public.__expect_error(format($$select public.billing_apply_subscription(jsonb_build_object('organization_id', %L, 'stripe_subscription_id', 'sub_TESTqu0001', 'stripe_customer_id', 'cus_TESTpi0001', 'status', 'active', 'plan_code', 'enterprise'))$$, :'org_q'),
  array['42501'], 'un abbonamento con il customer di un''altra org viene rifiutato');

select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'stripe_price_id', 'price_TESTstarter', 'plan_code', 'starter', 'status', 'active', 'unit_amount_cents', 14900,
  'currency', 'eur', 'billing_interval', 'month', 'interval_count', 1,
  'current_period_start', date_trunc('day', now()) - interval '3 days', 'current_period_end', date_trunc('day', now()) + interval '27 days',
  'started_at', now() - interval '3 days', 'stripe_synced_at', now() - interval '10 minutes', 'event_type', 'checkout.session.completed')) \g /dev/null
:as_p
select public.__expect((public.billing_can_use_feature(:'org_p', 'lead_finder') ->> 'allowed')::boolean, 'Starter: Lead Finder disponibile');
select public.__expect((public.billing_can_use_feature(:'org_p', 'ai_sales_agent') ->> 'reason') = 'feature_not_in_plan', 'Starter: AI Sales Agent non incluso');
select public.__expect((public.billing_can_use_feature(:'org_p', 'automations') ->> 'reason') = 'feature_not_in_plan', 'Starter: Automazioni non incluse');
select public.__expect((public.billing_status(:'org_p') -> 'usage' -> 'ai_credits' ->> 'limit')::int = 500, 'Starter: 500 crediti AI');
select public.__expect((public.billing_status(:'org_p') -> 'usage' -> 'leads' ->> 'limit')::int = 250, 'Starter: 250 nuovi lead');
select public.__expect((select count(*) = 1 from public.billing_audit_logs where organization_id = :'org_p' and action = 'subscription.created'), 'audit: abbonamento creato');
:as_q
select public.__expect((public.billing_can_use_feature(:'org_q', 'lead_finder') ->> 'reason') = 'no_subscription', 'Qu resta senza piano');

-- ── 4. Crediti: prenotazione, conferma, rimborso, idempotenza ───────────────
:as_service
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'sales_agent', 'messages', %L)$$, :'org_p', :'P'),
  array['P0001'], 'Starter: generazione email (AI Sales Agent) bloccata dal database');
insert into public.ai_jobs (organization_id, type, task, created_by) values (:'org_p', 'business_analysis', 'business_analysis', :'P') returning id as job1 \gset
select public.__expect((select ai_credits_reserved = 1 and ai_credits_used = 0 from public.usage_quotas where organization_id = :'org_p'), 'job creato: 1 credito prenotato');
update public.ai_jobs set status = 'running' where id = :'job1';
update public.ai_jobs set status = 'succeeded', tokens_input = 2500, tokens_output = 900 where id = :'job1';
select public.__expect((select ai_credits_reserved = 0 and ai_credits_used = 1 from public.usage_quotas where organization_id = :'org_p'), 'job riuscito: credito confermato');
update public.ai_jobs set status = 'succeeded' where id = :'job1';
select public.__expect((select ai_credits_used = 1 from public.usage_quotas where organization_id = :'org_p'), 'conferma idempotente');

insert into public.ai_jobs (organization_id, type, task, created_by) values (:'org_p', 'business_analysis', 'business_analysis', :'P') returning id as job2 \gset
update public.ai_jobs set status = 'failed', error = 'ai_timeout' where id = :'job2';
select public.__expect((select ai_credits_reserved = 0 and ai_credits_used = 1 from public.usage_quotas where organization_id = :'org_p'), 'job fallito: credito rimborsato');
select public.__expect((select status = 'released' from public.usage_ledger where idempotency_key = 'ai_job:' || :'job2'), 'registro: prenotazione rilasciata');
update public.ai_jobs set status = 'succeeded' where id = :'job2';
select public.__expect((select ai_credits_used = 1 from public.usage_quotas where organization_id = :'org_p'), 'nessun addebito dopo il rimborso');

select public.__expect((public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'manual:op-1') ->> 'allowed')::boolean, 'prenotazione diretta');
select public.__expect((public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'manual:op-1') ->> 'idempotent')::boolean, 'stessa chiave: esito idempotente');
select public.__expect((select ai_credits_reserved = 1 from public.usage_quotas where organization_id = :'org_p'), 'la chiave ripetuta non prenota due volte');
-- Budget token: 1 credito copre 6000 token; 15000 token → 3 crediti (2 extra).
select public.__expect((public.billing_commit_credits(:'org_p', 'manual:op-1', 15000) ->> 'extra_credits')::int = 2, 'token oltre il budget: crediti aggiuntivi');
select public.__expect((select ai_credits_used = 4 and ai_credits_reserved = 0 from public.usage_quotas where organization_id = :'org_p'), 'contatori dopo l''extra');

-- ── 5. Limite crediti e saldo mai negativo ──────────────────────────────────
:as_postgres
update public.usage_quotas set ai_credits_used = 498 where organization_id = :'org_p';
:as_service
select public.__expect((public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'limit:a') ->> 'allowed')::boolean, 'penultimo credito disponibile');
select public.__expect((public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'limit:b') ->> 'allowed')::boolean, 'ultimo credito disponibile');
select public.__expect((public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'limit:c') ->> 'reason') = 'insufficient_credits', 'crediti esauriti: prenotazione rifiutata');
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'business_analysis', 'business_analysis', %L)$$, :'org_p', :'P'),
  array['P0001'], 'crediti esauriti: nessun nuovo job AI');
-- L'extra token non può portare il saldo sotto zero.
select public.__expect((public.billing_commit_credits(:'org_p', 'limit:a', 60000) ->> 'extra_credits')::int = 0, 'extra non addebitabile oltre il saldo');
select public.__expect((select (metadata ->> 'extra_uncharged')::int = 9 from public.usage_ledger where idempotency_key = 'limit:a'), 'extra non addebitato registrato');
select public.billing_commit_credits(:'org_p', 'limit:b') \g /dev/null
select public.__expect((select ai_credits_used = 500 and ai_credits_used <= ai_credits_limit from public.usage_quotas where organization_id = :'org_p'), 'consumo pari al limite, mai oltre');
:as_postgres
select public.__expect_error(format($$update public.usage_quotas set ai_credits_reserved = -1 where organization_id = %L$$, :'org_p'),
  array['23514'], 'vincolo: prenotazioni mai negative');
select public.__expect_error(format($$update public.usage_quotas set ai_credits_used = -5 where organization_id = %L$$, :'org_p'),
  array['23514'], 'vincolo: consumi mai negativi');
update public.usage_quotas set ai_credits_used = 10 where organization_id = :'org_p';

-- Prenotazioni scadute (job mai terminati) rimborsate automaticamente.
:as_service
select public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'stale:1') \g /dev/null
:as_postgres
update public.usage_ledger set created_at = now() - interval '2 hours' where idempotency_key = 'stale:1';
:as_service
select public.billing_reserve_credits(:'org_p', :'P', 'lead_analysis', 'stale:2') \g /dev/null
select public.__expect((select status = 'released' and metadata ->> 'release_reason' = 'reservation_expired' from public.usage_ledger where idempotency_key = 'stale:1'),
  'prenotazione scaduta rimborsata');
select public.__expect((select ai_credits_reserved = 1 from public.usage_quotas where organization_id = :'org_p'), 'resta solo la prenotazione attiva');
select public.billing_release_credits(:'org_p', 'stale:2') \g /dev/null

-- ── 6. Quote lead deduplicate e ricerche parziali ───────────────────────────
select public.__expect((public.billing_count_new_leads(:'org_p', :'P', array['cand-1', 'cand-2', 'cand-3']) ->> 'counted')::int = 3, '3 nuovi lead contati');
select public.__expect((r ->> 'counted')::int = 1 and (r ->> 'already_counted')::int = 1, 'lead già visto non ricontato (né duplicati nel batch)')
  from (select public.billing_count_new_leads(:'org_p', :'P', array['cand-2', 'cand-4', 'cand-4']) as r) t;
select public.__expect((select leads_used = 4 from public.usage_quotas where organization_id = :'org_p'), 'contatore lead = 4');
:as_postgres
update public.usage_quotas set leads_used = 249 where organization_id = :'org_p';
:as_service
select public.__expect((r ->> 'counted')::int = 1 and r -> 'over_quota_refs' = '["cand-y"]'::jsonb, 'ricerca parziale: oltre quota restituito')
  from (select public.billing_count_new_leads(:'org_p', :'P', array['cand-x', 'cand-y']) as r) t;
select public.__expect((public.billing_lead_quota(:'org_p') ->> 'reason') = 'lead_quota_exceeded', 'quota lead esaurita');
select public.__expect((select leads_used = leads_limit from public.usage_quotas where organization_id = :'org_p'), 'lead mai oltre il limite');

-- ── 7. Webhook: idempotenza e retry ─────────────────────────────────────────
select public.__expect(public.billing_claim_webhook_event('evt_TEST000001', 'invoice.paid', false, now()) = 'claimed', 'evento nuovo: preso in carico');
select public.__expect(public.billing_claim_webhook_event('evt_TEST000001', 'invoice.paid', false, now()) = 'in_progress', 'evento in elaborazione: non duplicato');
select public.billing_finish_webhook_event('evt_TEST000001', 'processed', null, :'org_p', 'in_TEST000001') \g /dev/null
select public.__expect(public.billing_claim_webhook_event('evt_TEST000001', 'invoice.paid', false, now()) = 'duplicate', 'evento già elaborato: duplicato');
select public.__expect(public.billing_claim_webhook_event('evt_TEST000002', 'customer.subscription.updated', false, now()) = 'claimed', 'secondo evento');
select public.billing_finish_webhook_event('evt_TEST000002', 'failed', 'stripe_unavailable') \g /dev/null
select public.__expect(public.billing_claim_webhook_event('evt_TEST000002', 'customer.subscription.updated', false, now()) = 'claimed', 'evento fallito: retry consentito');
select public.__expect((select attempts = 2 from public.stripe_webhook_events where event_id = 'evt_TEST000002'), 'tentativi contati');
select public.billing_finish_webhook_event('evt_TEST000002', 'processed') \g /dev/null

-- ── 8. Eventi fuori ordine ──────────────────────────────────────────────────
select public.__expect((public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'plan_code', 'starter', 'status', 'incomplete', 'stripe_synced_at', now() - interval '1 hour')) ->> 'reason') = 'stale_state',
  'stato letto prima di quello salvato: ignorato');
select public.__expect((select status = 'active' from public.organization_subscriptions where stripe_subscription_id = 'sub_TESTpi0001'), 'lo stato attivo resta valido');

-- ── 9. Upgrade, limite utenti, downgrade ────────────────────────────────────
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'stripe_price_id', 'price_TESTenterprise', 'plan_code', 'enterprise', 'status', 'active', 'unit_amount_cents', 79900,
  'currency', 'eur', 'billing_interval', 'month', 'interval_count', 1,
  'current_period_start', date_trunc('day', now()) - interval '3 days', 'current_period_end', date_trunc('day', now()) + interval '27 days',
  'started_at', now() - interval '3 days', 'stripe_synced_at', now() - interval '5 minutes')) \g /dev/null
select public.__expect((select ai_credits_limit = 10000 and ai_credits_used = 10 and leads_limit = 5000 and leads_used = 250
  from public.usage_quotas where organization_id = :'org_p'), 'upgrade: nuovi limiti nello stesso periodo, consumi mantenuti');
select public.__expect((select plan = 'enterprise' and monthly_results >= 5000 from public.organization_quotas where organization_id = :'org_p'), 'limiti tecnici allineati al piano');
:as_postgres
insert into public.organization_members (organization_id, user_id, role) values (:'org_p', :'R', 'member');
:as_p
insert into public.automation_workflows (organization_id, name, trigger, actions)
values (:'org_p', 'Notifica qualificati', 'lead_qualified', '[{"type":"notify"}]');
select id as wf from public.automation_workflows where organization_id = :'org_p' \gset
update public.automation_workflows set status = 'running' where id = :'wf';
select public.__expect((select status = 'running' from public.automation_workflows where id = :'wf'), 'Enterprise: workflow attivabile');

:as_service
select public.__expect((public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'stripe_price_id', 'price_TESTbusiness', 'plan_code', 'business', 'status', 'active', 'unit_amount_cents', 34900,
  'currency', 'eur', 'billing_interval', 'month', 'interval_count', 1,
  'current_period_start', date_trunc('day', now()) - interval '3 days', 'current_period_end', date_trunc('day', now()) + interval '27 days',
  'started_at', now() - interval '3 days', 'stripe_synced_at', now() - interval '4 minutes')) -> 'paused' ->> 'workflows')::int = 1,
  'downgrade a Business: workflow sospeso automaticamente');
select public.__expect((select status = 'paused' from public.automation_workflows where id = :'wf'), 'workflow in pausa dopo il downgrade');
:as_p
select public.__expect_error(format($$update public.automation_workflows set status = 'running' where id = %L$$, :'wf'),
  array['P0001'], 'Business: le automazioni non si riattivano');
:as_service
insert into public.ai_jobs (organization_id, type, task, created_by) values (:'org_p', 'sales_agent', 'proposal', :'P') returning id as job3 \gset
select public.__expect((select quantity = 3 and operation = 'proposal' from public.usage_ledger where idempotency_key = 'ai_job:' || :'job3'), 'Business: proposta = 3 crediti');
update public.ai_jobs set status = 'cancelled' where id = :'job3';

-- ── 10. RLS cross-tenant ────────────────────────────────────────────────────
:as_service
select public.billing_upsert_invoice(jsonb_build_object(
  'stripe_invoice_id', 'in_TESTpi0001', 'organization_id', :'org_p', 'stripe_customer_id', 'cus_TESTpi0001',
  'stripe_subscription_id', 'sub_TESTpi0001', 'status', 'paid', 'currency', 'eur', 'subtotal_cents', 14900,
  'total_cents', 18178, 'total_excluding_tax_cents', 14900, 'amount_due_cents', 18178, 'amount_paid_cents', 18178,
  'paid_at', now() - interval '3 days', 'stripe_synced_at', now(), 'event_type', 'invoice.paid')) \g /dev/null
select public.__expect_error(format($$select public.billing_upsert_invoice(jsonb_build_object('stripe_invoice_id', 'in_TESTxx0001', 'organization_id', %L, 'stripe_customer_id', 'cus_TESTpi0001', 'status', 'paid', 'currency', 'eur'))$$, :'org_q'),
  array['42501'], 'fattura con customer di un''altra org rifiutata');
:as_q
select public.__expect((select count(*) = 0 from public.organization_subscriptions where organization_id = :'org_p'), 'Qu non vede gli abbonamenti di Pi');
select public.__expect((select count(*) = 0 from public.usage_quotas where organization_id = :'org_p'), 'Qu non vede le quote di Pi');
select public.__expect((select count(*) = 0 from public.usage_ledger where organization_id = :'org_p'), 'Qu non vede i consumi di Pi');
select public.__expect((select count(*) = 0 from public.billing_invoices where organization_id = :'org_p'), 'Qu non vede le fatture di Pi');
select public.__expect((select count(*) = 0 from public.stripe_customers where organization_id = :'org_p'), 'Qu non vede il customer di Pi');
select public.__expect((select count(*) = 0 from public.billing_audit_logs where organization_id = :'org_p'), 'Qu non vede l''audit di Pi');
select public.__expect((select count(*) = 0 from public.stripe_webhook_events), 'gli eventi webhook non sono visibili ai tenant');
select public.__expect_error(format($$select public.billing_status(%L)$$, :'org_p'), array['42501'], 'Qu non legge lo stato di billing di Pi');
select public.__expect_error(format($$select public.billing_can_use_feature(%L, 'export')$$, :'org_p'), array['42501'], 'Qu non interroga le funzionalità di Pi');
select public.__expect_error($$select public.billing_admin_revenue(30)$$, array['42501'], 'un admin di org non vede le revenue di piattaforma');
:as_r
select public.__expect((select count(*) = 1 from public.organization_subscriptions where organization_id = :'org_p'), 'un membro vede il piano della propria org');
select public.__expect((select count(*) = 0 from public.billing_invoices where organization_id = :'org_p'), 'un membro non vede le fatture');
select public.__expect((select count(*) = 0 from public.usage_ledger where organization_id = :'org_p'), 'un membro non vede il registro consumi');
select public.__expect((public.billing_status(:'org_p') ->> 'is_admin')::boolean = false, 'billing_status indica il ruolo membro');
:as_p
select public.__expect((select count(*) = 1 from public.billing_invoices where organization_id = :'org_p'), 'l''admin vede le proprie fatture');

-- ── 11. Super admin: revenue e configurazione ───────────────────────────────
:as_s
select public.__expect((r ->> 'mrr_cents')::bigint = 34900 and (r ->> 'net_collected_cents')::bigint = 14900
                               and (r ->> 'gross_collected_cents')::bigint = 18178 and (r ->> 'active_subscriptions')::int = 1, 'revenue: MRR contrattuale e incassi netti senza IVA')
  from (select public.billing_admin_revenue(30) as r) t;
select public.__expect((select count(*) = 0 from public.leads where organization_id = :'org_p'), 'il super admin resta senza accesso ai lead dei tenant');
select public.admin_update_billing_plan('starter', '{"price_cents": 15900, "monthly_ai_credits": 600}') \g /dev/null
select public.__expect((select price_cents = 15900 and monthly_ai_credits = 600 from public.billing_plans where code = 'starter'), 'super admin: prezzo e limiti modificati');
select public.__expect((select count(*) = 1 from public.billing_audit_logs where action = 'plan.updated'), 'modifica del piano in audit');
select public.__expect_error($$select public.admin_update_billing_plan('starter', '{"features": ["teleport"]}')$$, array['23514'], 'funzionalità sconosciute rifiutate');
select public.__expect_error($$select public.admin_update_billing_plan('starter', '{"code": "free"}')$$, array['22023'], 'campi non modificabili rifiutati');
select public.admin_update_credit_cost('proposal', 4) \g /dev/null
select public.__expect((select credits = 4 from public.ai_credit_costs where operation = 'proposal'), 'costo in crediti configurabile');
select public.admin_update_credit_cost('proposal', 3) \g /dev/null
select public.admin_update_billing_plan('starter', '{"price_cents": 14900, "monthly_ai_credits": 500}') \g /dev/null

-- ── 12. Pagamento fallito, rinnovo, cancellazione ───────────────────────────
:as_service
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'plan_code', 'business', 'status', 'past_due', 'unit_amount_cents', 34900, 'currency', 'eur', 'billing_interval', 'month',
  'current_period_start', date_trunc('day', now()) - interval '3 days', 'current_period_end', date_trunc('day', now()) + interval '27 days',
  'stripe_synced_at', now() - interval '3 minutes')) \g /dev/null
select public.billing_upsert_invoice(jsonb_build_object(
  'stripe_invoice_id', 'in_TESTpi0002', 'organization_id', :'org_p', 'stripe_customer_id', 'cus_TESTpi0001', 'status', 'open',
  'currency', 'eur', 'total_cents', 42578, 'amount_due_cents', 42578, 'amount_remaining_cents', 42578, 'attempt_count', 1,
  'event_type', 'invoice.payment_failed', 'stripe_synced_at', now())) \g /dev/null
select public.__expect(private_ok, 'past_due: accesso mantenuto durante i tentativi di Stripe')
  from (select (public.billing_can_use_feature(:'org_p', 'ai_sales_agent') ->> 'allowed')::boolean as private_ok) t;
select public.__expect((select count(*) = 1 from public.billing_audit_logs where organization_id = :'org_p' and action = 'invoice.payment_failed'), 'pagamento fallito in audit');
-- Rinnovo: nuovo periodo → nuovi contatori a zero.
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'plan_code', 'business', 'status', 'active', 'unit_amount_cents', 34900, 'currency', 'eur', 'billing_interval', 'month',
  'current_period_start', date_trunc('day', now()) - interval '1 hour', 'current_period_end', date_trunc('day', now()) + interval '30 days',
  'stripe_synced_at', now() - interval '2 minutes')) \g /dev/null
select public.__expect((select ai_credits_used = 0 and leads_used = 0 and ai_credits_limit = 2500
  from public.usage_quotas where organization_id = :'org_p' and period_start = date_trunc('day', now()) - interval '1 hour'), 'rinnovo: nuovo periodo con contatori azzerati');
select public.__expect((select count(*) = 2 from public.usage_quotas where organization_id = :'org_p'), 'lo storico del periodo precedente resta');
-- Cancellazione a fine periodo, poi definitiva.
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'plan_code', 'business', 'status', 'active', 'cancel_at_period_end', true, 'unit_amount_cents', 34900, 'currency', 'eur',
  'billing_interval', 'month', 'current_period_start', date_trunc('day', now()) - interval '1 hour',
  'current_period_end', date_trunc('day', now()) + interval '30 days', 'stripe_synced_at', now() - interval '1 minute')) \g /dev/null
select public.__expect((public.billing_can_use_feature(:'org_p', 'ai_sales_agent') ->> 'allowed')::boolean, 'cancellazione programmata: accesso fino a fine periodo');
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_p', 'stripe_subscription_id', 'sub_TESTpi0001', 'stripe_customer_id', 'cus_TESTpi0001',
  'plan_code', 'business', 'status', 'canceled', 'unit_amount_cents', 34900, 'currency', 'eur', 'billing_interval', 'month',
  'ended_at', now(), 'canceled_at', now(), 'stripe_synced_at', now())) \g /dev/null
select public.__expect((public.billing_can_use_feature(:'org_p', 'lead_finder') ->> 'reason') = 'subscription_inactive', 'abbonamento cancellato: nessun accesso');
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'business_analysis', 'business_analysis', %L)$$, :'org_p', :'P'),
  array['P0001'], 'abbonamento cancellato: nessun job AI');
:as_s
select public.__expect((r ->> 'cancellations')::int = 1 and (r ->> 'mrr_cents')::bigint = 0, 'revenue: cancellazione conteggiata, MRR azzerato')
  from (select public.billing_admin_revenue(30) as r) t;

-- ── 13. Audit append-only ───────────────────────────────────────────────────
:as_postgres
select public.__expect_error($$update public.billing_audit_logs set action = 'tampered'$$, array['42501'], 'audit di billing non modificabile');
select public.__expect_error($$delete from public.billing_audit_logs$$, array['42501'], 'audit di billing non cancellabile');

-- Ripristina lo stato atteso dagli altri file di test.
select private.billing_set_enforcement(false) \g /dev/null
\echo 'Tutti i test Billing sono passati.'
