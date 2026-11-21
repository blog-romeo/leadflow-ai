-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 5: Super Admin, White Label e Control Center.
-- Accesso super admin (autorizzato/negato), protezione da escalation, rivenditori,
-- inviti, isolamento organizzazioni e rivenditori, branding, limiti, domini non verificati,
-- sospensioni, feature flag, controllo costi, audit, abbonamenti White Label (Stripe test).
-- I dati Stripe sono valori di test passati come farebbe il webhook: nessuna transazione reale.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set S  '00000000-0000-0000-0000-0000000cc501'
\set RA '00000000-0000-0000-0000-0000000cc502'
\set RM '00000000-0000-0000-0000-0000000cc503'
\set RB '00000000-0000-0000-0000-0000000cc504'
\set C1 '00000000-0000-0000-0000-0000000cc505'
\set X  '00000000-0000-0000-0000-0000000cc506'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_s  'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000cc501"}'';'
\set as_ra 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000cc502"}'';'
\set as_rm 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000cc503"}'';'
\set as_rb 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000cc504"}'';'
\set as_c1 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000cc505"}'';'
\set as_x  'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000cc506"}'';'

:as_postgres
select private.billing_set_enforcement(true) \g /dev/null
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data) values
  (:'S', 'sofia@leadflow.test', '{}'), (:'RA', 'anna@agenzia-a.test', '{}'), (:'RM', 'marco@agenzia-a.test', '{}'),
  (:'RB', 'bea@agenzia-b.test', '{}'), (:'C1', 'carla@cliente-uno.test', '{}'),
  -- Tentativo di autoassegnazione del ruolo dalla registrazione pubblica (metadati ignorati).
  (:'X', 'xavier@altro.test', '{"platform_role":"super_admin","role":"super_admin"}');
\o
select public.__expect((select platform_role = 'user' from public.profiles where id = :'X'), 'registrazione: i metadati non assegnano super_admin');
select private.set_platform_role('sofia@leadflow.test', 'super_admin', 'Operatrice di piattaforma, nomina interna') \g /dev/null
select public.__expect((select count(*) = 1 from public.admin_audit_logs where action = 'platform_role.changed'), 'nomina super admin registrata in audit');

-- ── 1–2. Accesso super admin autorizzato e negato; protezione da escalation ──
:as_x
select public.__expect_error($$select public.sa_overview(30)$$, array['42501'], 'utente normale: console super admin negata');
select public.__expect_error($$select public.sa_organizations(null, null, 25, 0)$$, array['42501'], 'utente normale: elenco aziende negato');
select public.__expect_error($$select public.sa_usage(now() - interval '7 days', now())$$, array['42501'], 'utente normale: utilizzo e costi negati');
select public.__expect_error($$select public.sa_resellers()$$, array['42501'], 'utente normale: rivenditori negati');
select public.__expect_error($$update public.profiles set platform_role = 'super_admin' where id = auth.uid()$$, array['42501'], 'nessuna autopromozione via REST');
select public.__expect_error($$select private.set_platform_role('xavier@altro.test', 'super_admin', 'tentativo di escalation')$$, array['42501'], 'funzione di nomina non invocabile dagli utenti');
select public.__expect((select count(*) = 0 from public.admin_audit_logs), 'utente normale: audit amministrativo non leggibile');
:as_service
select public.__expect_error(format($$update public.profiles set platform_role = 'super_admin' where id = %L$$, :'X'), array['42501'], 'nemmeno la service role assegna super_admin');
:as_s
select public.__expect((public.sa_overview(30) ->> 'organizations_total') is not null, 'super admin: overview disponibile');
select public.sa_log_access('overview') \g /dev/null
select public.sa_log_access('overview') \g /dev/null
select public.__expect((select count(*) = 1 from public.admin_audit_logs where action = 'console.access' and actor_id = :'S'), 'accesso alla console registrato (deduplicato)');

-- ── 3. Creazione rivenditori ────────────────────────────────────────────────
select public.sa_create_reseller('Agenzia Alfa', 'agenzia-alfa', 'agency', 'anna@agenzia-a.test', 'info@agenzia-a.test',
  '{"starter": 7900, "business": 18900}', null) as reseller_a \gset
select public.sa_create_reseller('Agenzia Beta', 'agenzia-beta', 'premium', 'bea@agenzia-b.test', null, '{}', null) as reseller_b \gset
select public.__expect_error($$select public.sa_create_reseller('Ghost', 'ghost', 'agency', 'nessuno@nessuno.test')$$, array['P0002'], 'admin rivenditore deve essere un utente registrato');
select public.__expect_error($$select public.sa_create_reseller('Dup', 'agenzia-alfa', 'agency', 'anna@agenzia-a.test')$$, array['23505'], 'slug rivenditore univoco');
select public.__expect_error(format($$select public.sa_update_reseller(%L, '{"wholesale_prices": {"starter": -1}}', 'prezzo wholesale errato')$$, :'reseller_a'), array['23514'], 'prezzi wholesale validati');
select public.sa_set_reseller_member(:'reseller_a', 'marco@agenzia-a.test', 'reseller_member', 'Collaboratore commerciale Alfa') \g /dev/null
select public.__expect((select count(*) = 2 from public.reseller_members where reseller_id = :'reseller_a'), 'membri del rivenditore Alfa');
select public.__expect_error(format($$select public.sa_set_reseller_member(%L, 'anna@agenzia-a.test', null, 'rimozione ultimo admin')$$, :'reseller_a'), array['P0001'], 'l''ultimo reseller_admin non si rimuove');
select public.__expect_error(format($$select public.sa_set_reseller_status(%L, 'suspend', 'breve')$$, :'reseller_a'), array['22023'], 'sospensione senza motivazione rifiutata');

-- Senza abbonamento White Label il rivenditore non può invitare clienti.
:as_ra
select public.__expect((public.reseller_dashboard(:'reseller_a') -> 'access' ->> 'reason') = 'no_subscription', 'rivenditore senza abbonamento');
select public.__expect_error(format($$select public.reseller_create_invitation(%L, 'carla@cliente-uno.test', 'Cliente Uno Srl', 'starter')$$, :'reseller_a'),
  array['P0001'], 'senza abbonamento nessun invito');
:as_s
select public.sa_set_reseller_external_billing(:'reseller_a', true, 'Contratto Agency firmato, fatturazione bonifico') \g /dev/null

-- ── 4. Invito cliente e accettazione ────────────────────────────────────────
:as_rm
select public.__expect_error(format($$select public.reseller_create_invitation(%L, 'carla@cliente-uno.test', 'Cliente Uno Srl', 'starter')$$, :'reseller_a'),
  array['42501'], 'un reseller_member non crea inviti');
:as_ra
select public.__expect_error(format($$select public.reseller_create_invitation(%L, 'carla@cliente-uno.test', 'Cliente Uno Srl', 'enterprise')$$, :'reseller_a'),
  array['P0001'], 'Agency: piano Enterprise non assegnabile ai clienti');
select public.reseller_create_invitation(:'reseller_a', 'Carla@Cliente-Uno.test', 'Cliente Uno Srl', 'business') ->> 'token' as invite_token \gset
select public.__expect((select count(*) = 1 and bool_and(token_hash <> :'invite_token') from public.reseller_invitations where reseller_id = :'reseller_a'), 'il token è salvato solo come hash');
:as_x
select public.__expect_error(format($$select public.accept_reseller_invitation(%L)$$, :'invite_token'), array['P0002'], 'invito non accettabile da un''altra email');
select public.__expect_error($$select public.accept_reseller_invitation('token-inventato')$$, array['P0002'], 'token inventato rifiutato');
:as_c1
select public.__expect((public.invitation_preview(:'invite_token') ->> 'organization_name') = 'Cliente Uno Srl', 'anteprima invito per il destinatario');
select public.accept_reseller_invitation(:'invite_token', null, 'IT') as org_c1 \gset
select public.__expect_error(format($$select public.accept_reseller_invitation(%L)$$, :'invite_token'), array['P0001'], 'invito già usato');
select public.__expect((public.billing_can_use_feature(:'org_c1', 'ai_sales_agent') ->> 'allowed')::boolean, 'cliente del rivenditore: piano Business attivo');
select public.__expect((public.billing_status(:'org_c1') -> 'managed_by' ->> 'reseller_name') = 'Agenzia Alfa', 'il cliente vede chi gestisce il suo piano');
select public.__expect((public.billing_status(:'org_c1') -> 'usage' -> 'ai_credits' ->> 'limit')::int = 2500, 'crediti del piano assegnato dal rivenditore');

-- ── 5. Isolamento organizzazioni ────────────────────────────────────────────
:as_c1
insert into public.lead_sources (organization_id, name, type, legal_basis) values (:'org_c1', 'Fiera', 'manual', 'legitimate_interest') returning id as src_c1 \gset
insert into public.leads (organization_id, source_id, company_name) values (:'org_c1', :'src_c1', 'Lead Riservato Spa');
:as_ra
select public.__expect((select count(*) = 1 from public.organizations where id = :'org_c1'), 'il rivenditore vede l''anagrafica del proprio cliente');
select public.__expect((select count(*) = 0 from public.leads where organization_id = :'org_c1'), 'il rivenditore NON vede i lead del cliente');
select public.__expect((select count(*) = 0 from public.lead_sources where organization_id = :'org_c1'), 'il rivenditore NON vede le fonti del cliente');
select public.__expect((jsonb_array_length(public.reseller_dashboard(:'reseller_a') -> 'clients')) = 1, 'dashboard: un cliente gestito');
update public.organizations set name = 'Hack' where id = :'org_c1';
select public.__expect((select name = 'Cliente Uno Srl' from public.organizations where id = :'org_c1'), 'il rivenditore non modifica il cliente (RLS: 0 righe)');
:as_x
select public.__expect((select count(*) = 0 from public.organizations where id = :'org_c1'), 'un altro utente non vede l''organizzazione');
select public.__expect((select count(*) = 0 from public.reseller_organizations), 'un altro utente non vede i collegamenti');
:as_s
select public.__expect((select count(*) = 0 from public.leads where organization_id = :'org_c1'), 'il super admin non vede i lead dei tenant');
select public.__expect((public.sa_organizations('cliente uno', null, 25, 0) -> 'rows' -> 0 ->> 'reseller') = 'Agenzia Alfa', 'ricerca aziende con rivenditore');

-- ── 6. Isolamento rivenditori ───────────────────────────────────────────────
:as_s
select public.sa_set_reseller_external_billing(:'reseller_b', true, 'Contratto Premium, fatturazione bonifico') \g /dev/null
:as_rb
select public.__expect_error(format($$select public.reseller_dashboard(%L)$$, :'reseller_a'), array['42501'], 'Beta non apre la dashboard di Alfa');
select public.__expect_error(format($$select public.reseller_create_invitation(%L, 'z@z.test', 'Zeta Srl', 'starter')$$, :'reseller_a'), array['42501'], 'Beta non invita per conto di Alfa');
select public.__expect_error(format($$select public.reseller_set_client_plan(%L, %L, 'starter')$$, :'reseller_a', :'org_c1'), array['42501'], 'Beta non cambia piani dei clienti di Alfa');
select public.__expect_error(format($$select public.reseller_set_client_plan(%L, %L, 'starter')$$, :'reseller_b', :'org_c1'), array['P0002'], 'Beta non gestisce clienti non suoi');
select public.__expect((select count(*) = 0 from public.organizations where id = :'org_c1'), 'Beta non vede i clienti di Alfa');
select public.__expect((select count(*) = 0 from public.resellers where id = :'reseller_a'), 'Beta non vede il rivenditore Alfa');
select public.__expect((select count(*) = 0 from public.reseller_invitations where reseller_id = :'reseller_a'), 'Beta non vede gli inviti di Alfa');
select public.__expect((select count(*) = 0 from public.reseller_branding where reseller_id = :'reseller_a'), 'Beta non vede il branding di Alfa');
:as_rm
select public.__expect((select count(*) = 0 from public.reseller_invitations), 'un reseller_member non vede gli inviti (email dei clienti)');
select public.__expect((public.reseller_dashboard(:'reseller_a') -> 'invitations') = '[]'::jsonb, 'dashboard del member senza inviti');

-- ── 7. Branding ─────────────────────────────────────────────────────────────
:as_ra
select public.reseller_update_branding(:'reseller_a', '{"platform_name": "Alfa Sales Cloud", "primary_color": "#1D4ED8", "theme": "dark",
  "welcome_title": "Benvenuto in Alfa", "support_email": "Help@Agenzia-A.test", "privacy_url": "https://agenzia-a.test/privacy"}') \g /dev/null
select public.__expect((select platform_name = 'Alfa Sales Cloud' and primary_color = '#1d4ed8' and support_email = 'help@agenzia-a.test'
  from public.reseller_branding where reseller_id = :'reseller_a'), 'branding aggiornato e normalizzato');
select public.__expect_error(format($$select public.reseller_update_branding(%L, '{"privacy_url": "javascript:alert(1)"}')$$, :'reseller_a'), array['23514'], 'XSS: URL non https rifiutato');
select public.__expect_error(format($$select public.reseller_update_branding(%L, '{"welcome_text": "<script>alert(1)</script>"}')$$, :'reseller_a'), array['23514'], 'XSS: markup nei testi rifiutato');
select public.__expect_error(format($$select public.reseller_update_branding(%L, '{"primary_color": "red; background:url(x)"}')$$, :'reseller_a'), array['23514'], 'colore non esadecimale rifiutato');
select public.__expect_error(format($$select public.reseller_update_branding(%L, '{"logo_path": "../../etc/passwd"}')$$, :'reseller_a'), array['22023'], 'percorsi immagine non impostabili dal client');
:as_rm
select public.__expect_error(format($$select public.reseller_update_branding(%L, '{"platform_name": "Altro"}')$$, :'reseller_a'), array['42501'], 'un reseller_member non modifica il branding');
:as_ra
select public.__expect_error(format($$select public.reseller_set_branding_asset(%L, 'logo', %L, %L)$$, :'reseller_a', :'reseller_a' || '/logo-0123456789ab.png', :'RA'),
  array['42501'], 'asset del branding scrivibili solo dal server');
:as_service
select public.reseller_set_branding_asset(:'reseller_a', 'logo', :'reseller_a' || '/logo-0123456789ab.png', :'RA') \g /dev/null
select public.__expect_error(format($$select public.reseller_set_branding_asset(%L, 'logo', %L, %L)$$, :'reseller_a', :'reseller_b' || '/logo-0123456789ab.png', :'RA'),
  array['22023'], 'un asset non può puntare alla cartella di un altro rivenditore');

-- ── 8. Controllo limiti ─────────────────────────────────────────────────────
:as_s
select public.sa_update_reseller(:'reseller_a', '{"max_organizations_override": 2}', 'Limite contrattuale ridotto a 2') \g /dev/null
:as_ra
select public.reseller_create_invitation(:'reseller_a', 'due@cliente-due.test', 'Cliente Due Srl', 'starter') \g /dev/null
select public.__expect_error(format($$select public.reseller_create_invitation(%L, 'tre@cliente-tre.test', 'Cliente Tre Srl', 'starter')$$, :'reseller_a'),
  array['P0001'], 'limite clienti: 1 attivo + 1 invito pendente = 2');
select public.reseller_add_domain(:'reseller_a', 'App.Agenzia-Alfa.it.') ->> 'hostname' as domain_host \gset
select public.__expect(:'domain_host' = 'app.agenzia-alfa.it', 'hostname normalizzato');
select public.__expect_error(format($$select public.reseller_add_domain(%L, 'crm.agenzia-alfa.it')$$, :'reseller_a'), array['P0001'], 'Agency: un solo dominio personalizzato');
:as_rb
select public.__expect_error(format($$select public.reseller_add_domain(%L, 'app.agenzia-alfa.it')$$, :'reseller_b'), array['P0001'], 'dominio già registrato da un altro rivenditore');
select public.__expect_error(format($$select public.reseller_add_domain(%L, 'pirata.netlify.app')$$, :'reseller_b'), array['P0001'], 'domini della piattaforma non registrabili');
select public.__expect_error(format($$select public.reseller_add_domain(%L, 'http://evil.test/x')$$, :'reseller_b'), array['23514'], 'hostname non valido rifiutato');

-- ── 9. Dominio non verificato ───────────────────────────────────────────────
:as_postgres
select id as dom_a from public.custom_domains where hostname = 'app.agenzia-alfa.it' \gset
:as_service
select public.__expect(public.tenant_by_hostname('app.agenzia-alfa.it') is null, 'dominio non verificato: nessun tenant risolto');
select public.domain_record_check(:'dom_a', false, 'missing', 'unknown', 'txt_not_found') \g /dev/null
select public.__expect((select status = 'pending_verification' from public.custom_domains where id = :'dom_a'), 'senza record TXT resta da verificare');
select public.domain_record_check(:'dom_a', true, 'ok', 'unknown', null) \g /dev/null
select public.__expect((select status = 'verified' and verified_at is not null from public.custom_domains where id = :'dom_a'), 'TXT trovato: proprietà verificata');
select public.__expect(public.tenant_by_hostname('app.agenzia-alfa.it') is null, 'verificato ma non attivo (alias/HTTPS): nessun tenant');
select public.domain_record_check(:'dom_a', true, 'ok', 'active', null) \g /dev/null
select public.__expect((select status = 'verified' from public.custom_domains where id = :'dom_a'), 'senza provisioning confermato non diventa attivo');
:as_ra
select public.__expect_error(format($$select public.sa_mark_domain_provisioned(%L, true, 'alias aggiunto')$$, :'dom_a'), array['42501'], 'il rivenditore non conferma il provisioning');
:as_s
select public.sa_mark_domain_provisioned(:'dom_a', true, 'Alias aggiunto su Netlify manualmente') \g /dev/null
:as_service
select public.domain_record_check(:'dom_a', true, 'ok', 'active', null) \g /dev/null
select public.__expect((select status = 'active' from public.custom_domains where id = :'dom_a'), 'TXT + CNAME + alias + HTTPS: dominio attivo');
select public.__expect((public.tenant_by_hostname('APP.agenzia-alfa.it.') -> 'branding' ->> 'platform_name') = 'Alfa Sales Cloud', 'tenant risolto dall''hostname con branding');
select public.__expect(public.tenant_by_hostname('altro.agenzia-alfa.it') is null, 'hostname sconosciuto: nessun tenant');
:as_x
select public.__expect_error($$select public.tenant_by_hostname('app.agenzia-alfa.it')$$, array['42501'], 'risoluzione tenant solo lato server');

-- ── 10. Sospensioni ─────────────────────────────────────────────────────────
:as_s
select public.__expect_error(format($$select public.sa_set_organization_status(%L, 'suspend', 'no')$$, :'org_c1'), array['22023'], 'sospensione senza motivazione rifiutata');
select public.sa_set_organization_status(:'org_c1', 'suspend', 'Uso non conforme ai termini, verifica in corso') \g /dev/null
:as_c1
select public.__expect((public.billing_can_use_feature(:'org_c1', 'lead_finder') ->> 'reason') = 'organization_suspended', 'organizzazione sospesa: moduli bloccati');
select public.__expect((select count(*) = 1 from public.leads where organization_id = :'org_c1'), 'organizzazione sospesa: i dati restano leggibili');
:as_service
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'business_analysis', 'business_analysis', %L)$$, :'org_c1', :'C1'),
  array['P0001'], 'organizzazione sospesa: nessun job AI');
:as_s
select public.sa_set_organization_status(:'org_c1', 'reactivate', 'Verifica conclusa, nessuna violazione') \g /dev/null
select public.__expect((public.billing_can_use_feature(:'org_c1', 'lead_finder') ->> 'allowed')::boolean, 'riattivazione: moduli di nuovo disponibili');
select public.sa_add_note('organization', :'org_c1', 'Cliente seguito da Agenzia Alfa, referente Carla') \g /dev/null
select public.__expect((jsonb_array_length(public.sa_organization_detail(:'org_c1') -> 'notes')) = 1, 'nota interna salvata');
select public.__expect((select count(*) >= 2 from jsonb_array_elements(public.sa_organization_detail(:'org_c1') -> 'events') e where e ->> 'source' = 'admin'), 'storico eventi con sospensione e riattivazione');
-- Sospensione del rivenditore: i clienti gestiti perdono l'accesso.
select public.sa_set_reseller_status(:'reseller_a', 'suspend', 'Mancato pagamento del canone di novembre') \g /dev/null
:as_c1
select public.__expect((public.billing_can_use_feature(:'org_c1', 'lead_finder') ->> 'reason') = 'subscription_inactive', 'rivenditore sospeso: clienti senza accesso');
:as_ra
select public.__expect_error(format($$select public.reseller_create_invitation(%L, 'q@q.test', 'Qu Srl', 'starter')$$, :'reseller_a'), array['P0001'], 'rivenditore sospeso: nessun invito');
select public.__expect((public.reseller_dashboard(:'reseller_a') -> 'reseller' ->> 'status') = 'suspended', 'rivenditore sospeso: dashboard in sola lettura');
:as_s
select public.sa_set_reseller_status(:'reseller_a', 'reactivate', 'Pagamento ricevuto, riattivazione') \g /dev/null

-- ── Feature flag e controllo costi ──────────────────────────────────────────
select public.sa_set_feature_flag('lead_finder', false, 'Manutenzione del provider Overpass') \g /dev/null
:as_c1
select public.__expect((public.billing_can_use_feature(:'org_c1', 'lead_finder') ->> 'reason') = 'feature_disabled', 'flag globale disattivato');
:as_s
select public.sa_set_flag_override('lead_finder', 'organization', :'org_c1', true, 'Cliente pilota, accesso garantito') \g /dev/null
:as_c1
select public.__expect((public.billing_can_use_feature(:'org_c1', 'lead_finder') ->> 'allowed')::boolean, 'override per organizzazione');
:as_s
select public.sa_set_feature_flag('lead_finder', true, 'Manutenzione conclusa, riattivato') \g /dev/null
select public.sa_set_flag_override('lead_finder', 'organization', :'org_c1', null, 'Override non più necessario') \g /dev/null
-- Il flag attivo non sostituisce l'abbonamento: un'organizzazione senza piano resta bloccata.
:as_x
\o /dev/null
select public.create_organization('Xavier Srl', null, 'IT');
\o
select id as org_x from public.organizations where created_by = :'X' \gset
select public.__expect((public.billing_can_use_feature(:'org_x', 'lead_finder') ->> 'reason') = 'no_subscription', 'flag attivo ma nessun abbonamento: bloccato');
:as_s
select public.__expect_error($$select public.sa_update_setting('operations', '{"ai_paused": "si"}', 'valore non valido')$$, array['22023'], 'impostazioni validate');
select public.__expect_error($$select public.sa_update_setting('operations', '{"rm_rf": true}', 'campo sconosciuto')$$, array['22023'], 'campi sconosciuti rifiutati');
select public.sa_update_setting('operations', '{"ai_paused": true, "providers_paused": ["google_places"]}', 'Picco di costi, pausa precauzionale') \g /dev/null
:as_service
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'business_analysis', 'business_analysis', %L)$$, :'org_c1', :'C1'),
  array['P0001'], 'operazioni AI sospese dal super admin');
select public.__expect_error(format($$select public.billing_record_provider_call(%L, %L, 'google_places', 'prov:1')$$, :'org_c1', :'C1'), array['P0001'], 'provider sospeso: nessuna chiamata');
select public.billing_record_provider_call(:'org_c1', :'C1', 'osm_overpass', 'prov:2') \g /dev/null
select public.__expect((select count(*) = 1 from public.provider_cost_events where organization_id = :'org_c1'), 'costo provider registrato in provider_cost_events');
:as_s
select public.sa_update_setting('operations', '{"ai_paused": false, "providers_paused": []}', 'Fine della pausa precauzionale') \g /dev/null
select public.sa_set_org_ai_cap(:'org_c1', 0.50, 'Tetto di prova per il cliente') \g /dev/null
:as_postgres
insert into public.ai_jobs (organization_id, type, task, created_by, status, cost_usd) select :'org_c1', 'business_analysis', 'business_analysis', :'C1', 'queued', null;
update public.ai_jobs set status = 'succeeded', cost_usd = 0.75, model = 'modello-test', tokens_input = 1000, tokens_output = 500
 where organization_id = :'org_c1' and status = 'queued';
:as_service
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type, task, created_by) values (%L, 'business_analysis', 'business_analysis', %L)$$, :'org_c1', :'C1'),
  array['P0001'], 'tetto di spesa AI dell''organizzazione raggiunto');
:as_s
select public.__expect((select count(*) >= 1 from jsonb_array_elements(public.sa_usage(now() - interval '1 day', now() + interval '1 minute') -> 'alerts') a where a ->> 'type' = 'org_cap'),
  'avviso di superamento soglia');
select public.__expect(u -> 'by_model' @> '[{"model": "modello-test", "tokens_input": 1000, "tokens_output": 500, "cost_usd": 0.75}]'::jsonb
                       and (u ->> 'credits_used')::int >= 1 and u ? 'tokens' and u ? 'credits_used',
  'utilizzo: token per modello separati dai crediti commerciali')
  from (select public.sa_usage(now() - interval '1 day', now() + interval '1 minute') as u) t;
select public.sa_set_org_ai_cap(:'org_c1', null, 'Rimozione del tetto di prova') \g /dev/null

-- ── 12. Abbonamento White Label via Stripe (test mode) ──────────────────────
:as_service
select public.__expect(public.billing_link_reseller_customer(:'reseller_b', 'cus_TESTbeta001', false) = 'cus_TESTbeta001', 'customer Stripe collegato al rivenditore');
select public.__expect_error($$select public.billing_apply_reseller_subscription('{"reseller_id": "00000000-0000-0000-0000-000000000000", "stripe_subscription_id": "sub_TESTbeta001", "stripe_customer_id": "cus_TESTbeta001", "status": "active"}')$$,
  array['42501'], 'abbonamento con customer di un altro rivenditore rifiutato');
select public.billing_apply_reseller_subscription(jsonb_build_object('reseller_id', :'reseller_b', 'stripe_subscription_id', 'sub_TESTbeta001',
  'stripe_customer_id', 'cus_TESTbeta001', 'plan_code', 'premium', 'status', 'active', 'unit_amount_cents', 79900, 'currency', 'eur',
  'billing_interval', 'month', 'interval_count', 1, 'stripe_synced_at', now() - interval '1 minute')) \g /dev/null
select public.__expect((public.billing_apply_reseller_subscription(jsonb_build_object('reseller_id', :'reseller_b', 'stripe_subscription_id', 'sub_TESTbeta001',
  'stripe_customer_id', 'cus_TESTbeta001', 'plan_code', 'premium', 'status', 'canceled', 'stripe_synced_at', now() - interval '1 hour')) ->> 'reason') = 'stale_state',
  'evento White Label fuori ordine ignorato');
select public.billing_upsert_reseller_invoice(jsonb_build_object('stripe_invoice_id', 'in_TESTbeta001', 'reseller_id', :'reseller_b', 'stripe_customer_id', 'cus_TESTbeta001',
  'status', 'paid', 'currency', 'eur', 'billing_reason', 'subscription_create', 'total_cents', 829700, 'total_excluding_tax_cents', 678900,
  'amount_paid_cents', 829700, 'paid_at', now(), 'stripe_synced_at', now())) \g /dev/null
select public.billing_upsert_reseller_invoice(jsonb_build_object('stripe_invoice_id', 'in_TESTbeta002', 'reseller_id', :'reseller_b', 'stripe_customer_id', 'cus_TESTbeta001',
  'status', 'open', 'currency', 'eur', 'total_cents', 97478, 'amount_due_cents', 97478, 'amount_remaining_cents', 97478, 'attempt_count', 1,
  'event_type', 'invoice.payment_failed', 'stripe_synced_at', now())) \g /dev/null
:as_rb
select public.__expect((select count(*) = 2 from public.billing_invoices where reseller_id = :'reseller_b'), 'il rivenditore vede le proprie fatture');
:as_ra
select public.__expect((select count(*) = 0 from public.billing_invoices where reseller_id = :'reseller_b'), 'Alfa non vede le fatture di Beta');
:as_s
select public.__expect((o ->> 'reseller_mrr_cents')::bigint = 79900 and (o ->> 'reseller_net_collected_cents')::bigint = 678900
                               and (o ->> 'resellers_active')::int = 2 and (o ->> 'white_labels_active')::int = 1 and (o ->> 'custom_domains_active')::int = 1,
  'overview: MRR White Label, incassi netti, rivenditori e White Label attivi')
  from (select public.sa_overview(30) as o) t;
select public.__expect((select count(*) = 1 from public.admin_audit_logs where action = 'reseller.payment_failed'), 'pagamento White Label fallito in audit');
:as_service
select public.billing_apply_reseller_subscription(jsonb_build_object('reseller_id', :'reseller_b', 'stripe_subscription_id', 'sub_TESTbeta001',
  'stripe_customer_id', 'cus_TESTbeta001', 'plan_code', 'premium', 'status', 'canceled', 'ended_at', now(), 'stripe_synced_at', now())) \g /dev/null
:as_rb
-- L'abbonamento esterno di Beta resta: la cancellazione Stripe non altera l'altro contratto.
select public.__expect((public.reseller_dashboard(:'reseller_b') -> 'access' ->> 'subscription_source') = 'external', 'cancellazione Stripe: resta il contratto esterno registrato');

-- ── 11. Audit e rate limit ──────────────────────────────────────────────────
:as_postgres
select public.__expect((select count(*) >= 15 from public.admin_audit_logs), 'azioni amministrative registrate');
select public.__expect((select count(*) > 0 from public.admin_audit_logs where reason is not null and action like 'organization.%'), 'sospensioni con motivazione in audit');
select public.__expect_error($$update public.admin_audit_logs set reason = 'manomesso'$$, array['42501'], 'audit amministrativo non modificabile');
select public.__expect_error($$delete from public.admin_audit_logs$$, array['42501'], 'audit amministrativo non cancellabile');
:as_ra
select public.__expect((select count(*) = 0 from public.admin_audit_logs), 'i rivenditori non leggono l''audit di piattaforma');
:as_s
do $$
begin
  for i in 1..40 loop
    perform public.sa_add_note('organization', (select id from public.organizations order by created_at limit 1), 'nota di carico ' || i);
  end loop;
  raise exception 'FAIL  rate limit non applicato';
exception when others then
  if sqlerrm = 'rate_limited' then raise notice 'PASS  rate limit sulle azioni amministrative'; else raise; end if;
end $$;

:as_postgres
select private.billing_set_enforcement(false) \g /dev/null
\echo 'Tutti i test Control Center & White Label sono passati.'
