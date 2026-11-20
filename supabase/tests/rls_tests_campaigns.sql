-- ════════════════════════════════════════════════════════════════════════════
-- Test Campaign Manager: creazione, destinatari, idoneità per paese/canale,
-- approvazione e attivazione, invio controllato (begin_send), idempotenza,
-- webhook, pausa/ripresa, opposizione durante la sequenza, job con retry,
-- analytics e isolamento multi-tenant.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set K '00000000-0000-0000-0000-00000000cc01'
\set M '00000000-0000-0000-0000-00000000cc02'
\set X '00000000-0000-0000-0000-00000000dd01'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_k 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000cc01"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000cc02"}'';'
\set as_x 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000dd01"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email) values (:'K', 'kira@kappa.test'), (:'M', 'marco@kappa.test'), (:'X', 'xena@xray.test');
\o
:as_k
\o /dev/null
select public.create_organization('Kappa Consulting Srl', null, 'IT');
\o
:as_x
\o /dev/null
select public.create_organization('Xray Media Srl', null, 'IT');
\o
:as_postgres
select id as org_k from public.organizations where created_by = :'K' \gset
select id as org_x from public.organizations where created_by = :'X' \gset
insert into public.organization_members (organization_id, user_id, role) values (:'org_k', :'M', 'member');

-- ── Dati di prova ──────────────────────────────────────────────────────────
:as_k
\o /dev/null
insert into public.lead_sources (organization_id, type, name, legal_basis) values
  (:'org_k', 'public_registry', 'Siti web pubblici', 'public_professional_data'),
  (:'org_k', 'manual', 'Clienti esistenti', 'contract'),
  (:'org_k', 'website_form', 'Modulo contatti', 'consent');
\o
select id as src_pub from public.lead_sources where name = 'Siti web pubblici' \gset
select id as src_cli from public.lead_sources where name = 'Clienti esistenti' \gset
select id as src_form from public.lead_sources where name = 'Modulo contatti' \gset
\o /dev/null
insert into public.leads (organization_id, source_id, company_name, email, country, industry, city, tags, score) values
  (:'org_k', :'src_pub',  'Hotel Italia',   'info@hotelitalia.test',   'IT', 'Hotel', 'Roma',   '{hotel}', 80),
  (:'org_k', :'src_pub',  'Hôtel Paris',    'contact@hotelparis.test', 'FR', 'Hotel', 'Paris',  '{hotel}', 75),
  (:'org_k', :'src_cli',  'Cliente Storico','admin@storico.test',      'IT', 'Hotel', 'Milano', '{hotel,cliente}', 90),
  (:'org_k', :'src_form', 'Form Senza Prova','ciao@form.test',         'IT', 'Hotel', 'Torino', '{hotel}', 70),
  (:'org_k', :'src_pub',  'Hotel Consenso', 'info@consenso.test',      'IT', 'Hotel', 'Napoli', '{hotel}', 85),
  (:'org_k', :'src_pub',  'Senza Email',    null,                      'IT', 'Hotel', 'Bari',   '{hotel}', 60),
  (:'org_k', :'src_pub',  'Ristorante Uno', 'info@ristorante.test',    'IT', 'Ristorante', 'Roma', '{}', 95);
\o
select id as l_it from public.leads where company_name = 'Hotel Italia' \gset
select id as l_fr from public.leads where company_name = 'Hôtel Paris' \gset
select id as l_cli from public.leads where company_name = 'Cliente Storico' \gset
select id as l_form from public.leads where company_name = 'Form Senza Prova' \gset
select id as l_cons from public.leads where company_name = 'Hotel Consenso' \gset
select id as l_noemail from public.leads where company_name = 'Senza Email' \gset
insert into public.consent_records (organization_id, lead_id, channel, status, evidence, policy_version)
values (:'org_k', :'l_cons', 'email', 'granted', 'Modulo fiera 12/10, casella spuntata, copia firmata in archivio', 'v2');

-- ── 1. Creazione campagna ──────────────────────────────────────────────────
:as_m
\o /dev/null
insert into public.campaigns (organization_id, name, goal, service_name, channel, call_to_action)
values (:'org_k', 'Hotel autunno', 'meeting', 'Sito web', 'email', 'Fissiamo una call di 20 minuti?');
\o
select id as camp from public.campaigns where name = 'Hotel autunno' \gset
select public.__expect((select status = 'draft' and created_by = :'M' from public.campaigns where id = :'camp'), 'campagna creata in bozza con autore');
select public.__expect((select count(*) = 4 from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id where s.campaign_id = :'camp'),
  'sequenza predefinita 0/3/7/14 creata');
select public.__expect((select array_agg(day_offset order by position) = '{0,3,7,14}' from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id where s.campaign_id = :'camp'),
  'giorni della sequenza dal profilo commerciale');
select public.__expect_error(format($$update public.campaigns set status = 'running' where id = %L$$, :'camp'), array['42501'],
  'lo stato non si cambia con un update diretto');
select public.__expect_error(format($$insert into public.campaigns (organization_id, name, status) values (%L, 'Furba', 'running')$$, :'org_k'), array['42501'],
  'non si crea una campagna già attiva');

-- ── 2. Selezione destinatari con filtri ────────────────────────────────────
select public.__expect((select (public.add_campaign_recipients(:'camp', '{"industries":["hotel"],"tags":["hotel"],"min_score":50}') ->> 'added')::int = 6),
  'filtri settore/tag/punteggio: 6 hotel selezionati, ristorante escluso');
select public.__expect((select (public.add_campaign_recipients(:'camp', '{"industries":["hotel"]}') ->> 'added')::int = 0),
  'deduplicazione: lo stesso lead non viene aggiunto due volte');

-- ── 3. Esclusione dei contatti non idonei (paese × canale × base) ──────────
select public.__expect((select status = 'excluded' and exclusion_reasons @> '{consent_required}' from public.campaign_recipients where lead_id = :'l_it' and campaign_id = :'camp'),
  'IT + dati pubblici: trovato su Internet ≠ contattabile, serve il consenso');
select public.__expect((select status = 'eligible' and eligibility ->> 'basis' = 'legitimate_interest' and eligibility -> 'warnings' ? 'li_country_rule_fr'
   from public.campaign_recipients where lead_id = :'l_fr' and campaign_id = :'camp'),
  'FR + indirizzo professionale: legittimo interesse con avviso di revisione');
select public.__expect((select status = 'eligible' and eligibility ->> 'basis' = 'soft_opt_in' from public.campaign_recipients where lead_id = :'l_cli' and campaign_id = :'camp'),
  'cliente esistente: soft opt-in con limiti');
select public.__expect((select status = 'excluded' and exclusion_reasons @> '{consent_not_recorded}' from public.campaign_recipients where lead_id = :'l_form' and campaign_id = :'camp'),
  'consenso dichiarato sulla fonte ma non registrato: escluso');
select public.__expect((select status = 'eligible' and eligibility ->> 'basis' = 'consent' from public.campaign_recipients where lead_id = :'l_cons' and campaign_id = :'camp'),
  'consenso registrato con evidenza: idoneo');
select public.__expect((select status = 'excluded' and exclusion_reasons @> '{no_email}' from public.campaign_recipients where lead_id = :'l_noemail' and campaign_id = :'camp'),
  'senza indirizzo email: escluso');
insert into public.consent_records (organization_id, lead_id, channel, status, evidence)
values (:'org_k', :'l_cli', 'email', 'objected', 'Ha chiesto per telefono di non ricevere email');
select public.evaluate_campaign_recipients(:'camp') \gset
select public.__expect((select status = 'excluded' and exclusion_reasons @> '{channel_objection}' from public.campaign_recipients where lead_id = :'l_cli' and campaign_id = :'camp'),
  'preferenza di canale (opposizione email) rispettata');
select public.__expect((select (private.lead_eligibility(:'org_k', :'l_cli', 'linkedin') ->> 'eligible')::boolean),
  'l''opposizione all''email non blocca altri canali (solo manuali)');

-- ── 4. Contenuti, revisione, provider non configurato ──────────────────────
update public.campaign_steps st set subject = 'Prenotazioni dirette per {{azienda}}',
  body = 'Buongiorno, aiutiamo hotel come {{azienda}} a {{citta}} a ridurre le commissioni. {{call_to_action}}'
  from public.campaign_sequences s where s.id = st.sequence_id and s.campaign_id = :'camp' and st.kind in ('email', 'follow_up_email');
select public.__expect((select public.campaign_readiness(:'camp') -> 'issues' ? 'unknown_placeholder'), 'segnaposto non consentiti bloccati');
update public.campaign_steps st set body = 'Buongiorno, aiutiamo hotel come {{azienda}} a {{citta}} a ridurre le commissioni.'
  from public.campaign_sequences s where s.id = st.sequence_id and s.campaign_id = :'camp' and st.kind in ('email', 'follow_up_email');
select public.__expect((select public.campaign_readiness(:'camp') -> 'issues' ? 'sender_identity_missing'), 'identità del mittente e informativa obbligatorie');
:as_k
update public.sales_profiles set sender_legal_name = 'Kappa Consulting Srl', sender_address = 'Via Roma 1, 00100 Roma',
  privacy_policy_url = 'https://kappa.test/privacy' where organization_id = :'org_k';
:as_m
select public.__expect((select (r ->> 'can_activate')::boolean = false and r -> 'issues' ? 'no_provider' and (r ->> 'can_submit')::boolean
   from public.campaign_readiness(:'camp') r), 'provider non configurato: bozza completabile, invio disabilitato');

-- ── Account del provider (scritto dal server) ──────────────────────────────
:as_service
insert into public.communication_accounts (organization_id, provider, label, from_name, from_email, sending_domain, status, domain_status, dmarc_status, webhook_configured)
values (:'org_k', 'resend', 'Commerciale', 'Kira di Kappa', 'kira@mail.kappa.test', 'mail.kappa.test', 'connected', 'verified', 'pass', true);
select id as acc from public.communication_accounts where organization_id = :'org_k' \gset
insert into public.communication_account_secrets (account_id, organization_id, api_key_ciphertext) values (:'acc', :'org_k', 'v1:cifrato');
:as_k
select public.__expect_error($$select * from public.communication_account_secrets$$, array['42501'], 'le credenziali non sono leggibili dai client, nemmeno dall''admin');
select public.__expect_error(format($$update public.communication_accounts set status = 'connected' where id = %L$$, :'acc'), array['42501'],
  'lo stato della connessione lo scrive solo il server');
:as_m
update public.campaigns set account_id = :'acc' where id = :'camp';
select public.campaign_transition(:'camp', 'submit') \gset
select public.__expect((select status = 'pending_approval' from public.campaigns where id = :'camp'), 'campagna inviata in approvazione');
select public.__expect_error(format($$select public.campaign_transition(%L, 'activate', '{"confirm":true,"compliance_acknowledged":true,"expected_recipients":3}')$$, :'camp'),
  array['42501'], 'un membro non può attivare una campagna');
:as_k
select public.__expect_error(format($$select public.campaign_transition(%L, 'activate', '{"confirm":true}')$$, :'camp'),
  array['22023'], 'attivazione senza presa visione degli avvisi di conformità rifiutata');
select public.__expect_error(format($$select public.campaign_transition(%L, 'activate', '{"confirm":true,"compliance_acknowledged":true,"expected_recipients":99}')$$, :'camp'),
  array['P0001'], 'conferma con numero di destinatari diverso da quello in revisione rifiutata');

-- ── 5. Approvazione e attivazione esplicita ────────────────────────────────
select public.campaign_transition(:'camp', 'activate', '{"confirm":true,"compliance_acknowledged":true,"expected_recipients":2}') \gset
select public.__expect((select status = 'running' and activated_by = :'K' and activation_snapshot ? 'steps' from public.campaigns where id = :'camp'),
  'attivazione registrata con autore e istantanea dei contenuti');
select public.__expect((select count(*) = 2 from public.campaign_recipients where campaign_id = :'camp' and status = 'in_sequence'), 'solo gli idonei entrano in sequenza');
select public.__expect((select count(*) = 1 from public.automation_events where type = 'campaign_activated' and campaign_id = :'camp'), 'evento campagna attivata');
select public.__expect_error(format($$update public.campaign_steps set body = 'cambiato' where sequence_id = (select id from public.campaign_sequences where campaign_id = %L) and position = 0$$, :'camp'),
  array['P0001'], 'contenuti bloccati dopo l''attivazione');
select public.__expect_error(format($$delete from public.campaigns where id = %L$$, :'camp'), array['P0001'], 'una campagna attivata non si cancella');

-- ── 6. Scheduling dei job e preparazione idempotente ───────────────────────
:as_service
select public.schedule_due_steps() as scheduled \gset
select public.__expect(:scheduled = 2, 'due job creati per lo step 0');
update public.campaign_recipients set next_step_at = now() where campaign_id = :'camp' and status = 'in_sequence';
select public.schedule_due_steps() \gset
select public.__expect((select count(*) = 2 from public.automation_jobs where campaign_id = :'camp' and kind = 'run_step'), 'job idempotenti (chiave per destinatario e step)');
select id as rec_fr from public.campaign_recipients where campaign_id = :'camp' and lead_id = :'l_fr' \gset
select id as rec_cons from public.campaign_recipients where campaign_id = :'camp' and lead_id = :'l_cons' \gset
select st.id as step0 from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id where s.campaign_id = :'camp' and st.position = 0 \gset
select (public.prepare_step_message(:'rec_fr', :'step0')).id as msg_fr \gset
select (public.prepare_step_message(:'rec_fr', :'step0')).id as msg_fr_again \gset
select public.__expect(:'msg_fr' = :'msg_fr_again', 'un solo messaggio per destinatario e step');
select public.__expect((select subject = 'Prenotazioni dirette per Hôtel Paris' and body_text like '%a Paris a ridurre%' from public.outbound_messages where id = :'msg_fr'),
  'segnaposto sostituiti con i dati del lead');

-- ── 7. Invio controllato e retry senza duplicati ───────────────────────────
select public.__expect((select (public.begin_send(:'msg_fr') ->> 'ok')::boolean), 'begin_send: tutti i controlli superati');
select public.__expect((select status = 'sending' and attempts = 1 from public.outbound_messages where id = :'msg_fr'), 'messaggio in invio');
select public.__expect((select (r ->> 'ok')::boolean and (r ->> 'resume')::boolean from public.begin_send(:'msg_fr') r),
  'worker interrotto: ripresa con la stessa chiave di idempotenza');
select public.__expect((select count(*) = 1 from public.usage_events where organization_id = :'org_k' and event_type = 'email_sent'),
  'la ripresa non consuma di nuovo la quota');
select public.finish_send(:'msg_fr', 'sent', 're_123') \gset
select public.__expect((select (public.begin_send(:'msg_fr') ->> 'reason') = 'already_sent'), 'un messaggio inviato non viene reinviato');
select public.__expect((select status = 'contacted' from public.leads where id = :'l_fr'), 'lead passato a "contattato"');

-- Webhook di consegna idempotenti
select public.apply_delivery_event(:'acc', 'resend', 'msg_evt_1', 'email.delivered', 're_123', now(), '{}') \gset
select public.apply_delivery_event(:'acc', 'resend', 'msg_evt_1', 'email.delivered', 're_123', now(), '{}') \gset
select public.__expect((select count(*) = 1 from public.delivery_events where provider_event_id = 'msg_evt_1'), 'evento webhook registrato una sola volta');
select public.__expect((select status = 'delivered' and delivered_at is not null from public.outbound_messages where id = :'msg_fr'), 'stato consegnato');
select public.apply_delivery_event(:'acc', 'resend', 'msg_evt_0', 'email.sent', 're_123', now() - interval '1 minute', '{}') \gset
select public.__expect((select status = 'delivered' from public.outbound_messages where id = :'msg_fr'), 'gli stati non tornano indietro con eventi in ritardo');

-- ── 8. Webhook di risposta: stop della sequenza ────────────────────────────
insert into public.inbound_messages (organization_id, account_id, provider_message_id, lead_id, recipient_id, outbound_message_id, from_email, subject, body_text)
values (:'org_k', :'acc', 'in_1', :'l_fr', :'rec_fr', :'msg_fr', 'contact@hotelparis.test', 'Re: Prenotazioni', 'Interessante, chiamatemi');
select public.__expect((select status = 'stopped' and stopped_reason = 'reply' from public.campaign_recipients where id = :'rec_fr'), 'una risposta ferma la sequenza');
select public.__expect((select status = 'in_conversation' from public.leads where id = :'l_fr'), 'lead passato a "in conversazione"');
select public.__expect_error(format($$insert into public.inbound_messages (organization_id, account_id, provider_message_id, from_email) values (%L, %L, 'in_1', 'x@y.test')$$, :'org_k', :'acc'),
  array['23505'], 'messaggi in arrivo deduplicati per id del provider');

-- ── 9. Pausa e ripresa ─────────────────────────────────────────────────────
:as_k
select public.campaign_transition(:'camp', 'pause') \gset
:as_service
select (public.prepare_step_message(:'rec_cons', :'step0')).id as msg_cons \gset
select public.__expect((select (r ->> 'ok')::boolean = false and r ->> 'reason' = 'campaign_paused' from public.begin_send(:'msg_cons') r), 'campagna in pausa: nessun invio');
:as_k
select public.campaign_transition(:'camp', 'resume') \gset
select public.__expect((select status = 'running' from public.campaigns where id = :'camp'), 'campagna ripresa');
:as_service
select public.__expect((select status = 'cancelled' from public.outbound_messages where id = :'msg_cons'), 'i messaggi in coda durante la pausa vengono annullati');
select public.__expect((select (public.prepare_step_message(:'rec_cons', :'step0')).status = 'queued'), 'dopo la ripresa il messaggio annullato viene rigenerato (stessa chiave, mai usata)');
select public.__expect((select count(*) = 1 from public.outbound_messages where recipient_id = :'rec_cons'), 'nessun duplicato dopo la ripresa');

-- ── 10. Opposizione durante la sequenza ────────────────────────────────────
:as_m
update public.leads set contact_status = 'opted_out' where id = :'l_cons';
select public.__expect((select status = 'stopped' and stopped_reason = 'opt_out' from public.campaign_recipients where id = :'rec_cons'), 'opposizione: sequenza fermata subito');
select public.__expect((select count(*) = 1 from public.automation_events where type = 'opt_out_registered' and lead_id = :'l_cons'), 'evento opposizione registrata');
:as_service
select public.__expect((select (r ->> 'ok')::boolean = false from public.begin_send(:'msg_cons') r), 'nessun invio dopo l''opposizione');

-- Bounce permanente e reclamo → suppression list
:as_service
insert into public.outbound_messages (organization_id, kind, account_id, to_email, subject, body_text, idempotency_key, status, provider_message_id)
values (:'org_k', 'test', :'acc', 'bounced@resend.dev', 'Prova', 'Prova', 'test:bounce:0001', 'sent', 're_b1');
select public.apply_delivery_event(:'acc', 'resend', 'msg_evt_b1', 'email.bounced', 're_b1', now(), '{"bounce_type":"Permanent"}') \gset
select public.__expect((select count(*) = 1 from public.suppression_entries where email_hash = private.email_hash('bounced@resend.dev') and reason = 'bounce'),
  'bounce permanente aggiunto alla suppression list');

-- Invii di prova solo verso indirizzi controllati
insert into public.outbound_messages (organization_id, kind, account_id, to_email, subject, body_text, idempotency_key)
values (:'org_k', 'test', :'acc', 'qualcuno@esterno.test', 'Prova', 'Prova', 'test:ext:0001') returning id as msg_ext \gset
select public.__expect((select r ->> 'reason' = 'test_address_not_allowed' from public.begin_send(:'msg_ext') r), 'invio di prova verso indirizzo esterno rifiutato');
insert into public.outbound_messages (organization_id, kind, account_id, to_email, subject, body_text, idempotency_key)
values (:'org_k', 'test', :'acc', 'marco@kappa.test', 'Prova', 'Prova', 'test:member:0001') returning id as msg_member \gset
select public.__expect((select (public.begin_send(:'msg_member') ->> 'ok')::boolean), 'invio di prova autorizzato verso un membro dell''organizzazione');
insert into public.outbound_messages (organization_id, kind, account_id, to_email, subject, body_text, idempotency_key)
values (:'org_k', 'test', :'acc', 'delivered+t1@resend.dev', 'Prova', 'Prova', 'test:sandbox:0001') returning id as msg_sbx \gset
select public.__expect((select (public.begin_send(:'msg_sbx') ->> 'ok')::boolean), 'invio di prova verso indirizzo sandbox del provider');

-- Disiscrizione one-click
:as_service
select public.register_unsubscribe(:'msg_fr') \gset
select public.__expect((select contact_status = 'opted_out' from public.leads where id = :'l_fr'), 'disiscrizione dal link: opposizione registrata');
select public.__expect((select reason = 'unsubscribe' or reason = 'opt_out' from public.suppression_entries where email_hash = private.email_hash('contact@hotelparis.test')),
  'disiscrizione in suppression list');

-- ── 11. Job: retry con backoff, dead-letter, lease ─────────────────────────
insert into public.automation_jobs (organization_id, kind, idempotency_key, payload, max_attempts)
values (:'org_k', 'run_action', 'test:job:1', '{}', 2);
select count(*) as claimed from public.claim_automation_jobs('w1', 50, 60) where idempotency_key = 'test:job:1' \gset
select public.__expect(:claimed = 1, 'job prelevato con lease');
select public.__expect((select count(*) = 0 from public.claim_automation_jobs('w2', 50, 60) where idempotency_key = 'test:job:1'), 'un job in lease non viene prelevato da un altro worker');
select id as job1 from public.automation_jobs where idempotency_key = 'test:job:1' \gset
select public.finish_automation_job(:'job1', 'retry', 'timeout') \gset
select public.__expect((select status = 'queued' and run_at > now() + interval '50 seconds' from public.automation_jobs where id = :'job1'), 'retry con backoff');
update public.automation_jobs set run_at = now() where id = :'job1';
select count(*) from public.claim_automation_jobs('w1', 50, 60) \gset
select public.finish_automation_job(:'job1', 'retry', 'timeout') \gset
select public.__expect((select status = 'dead' from public.automation_jobs where id = :'job1'), 'tentativi esauriti: dead-letter');
select public.__expect_error($$insert into public.automation_jobs (organization_id, kind, idempotency_key) select organization_id, 'run_action', 'test:job:1' from public.automation_jobs where idempotency_key = 'test:job:1'$$,
  array['23505'], 'chiave di idempotenza dei job univoca');

-- ── Workflow ───────────────────────────────────────────────────────────────
:as_m
select public.__expect_error(format($$insert into public.automation_workflows (organization_id, name, trigger, actions) values (%L, 'Invia', 'lead_qualified', '[{"type":"send_email"}]')$$, :'org_k'),
  array['23514'], 'l''invio non è un''azione dei workflow');
insert into public.automation_workflows (organization_id, name, trigger, actions)
values (:'org_k', 'Promemoria qualificati', 'lead_qualified', '[{"type":"create_reminder","days":2},{"type":"notify"}]');
select id as wf from public.automation_workflows where name = 'Promemoria qualificati' \gset
select public.__expect_error(format($$update public.automation_workflows set status = 'running' where id = %L$$, :'wf'), array['42501'],
  'un membro non attiva un workflow');
:as_k
update public.automation_workflows set status = 'running' where id = :'wf';
select public.__expect((select status = 'running' and approved_by = :'K' from public.automation_workflows where id = :'wf'), 'workflow approvato da un admin');
update public.automation_workflows set actions = '[{"type":"notify"}]' where id = :'wf';
select public.__expect((select status = 'draft' and approved_by is null from public.automation_workflows where id = :'wf'), 'modificare un workflow attivo lo riporta in bozza');

-- ── Analytics con denominatori ─────────────────────────────────────────────
:as_m
select public.__expect((select (m -> 'totals' ->> 'sent')::int = 1 and (m -> 'totals' ->> 'delivered')::int = 1 and (m -> 'totals' ->> 'replies')::int = 1
   and (m -> 'rates' -> 'reply_rate' ->> 'denominator')::int = 1 and (m -> 'rates' -> 'reply_rate' ->> 'value')::numeric = 100
   and m -> 'rates' -> 'reply_rate' ->> 'denominator_label' = 'delivered'
   from public.campaign_metrics(:'org_k', now() - interval '1 day', now() + interval '1 day') m),
  'metriche reali con denominatore esplicito (test esclusi)');

-- ── 12. Isolamento multi-tenant ────────────────────────────────────────────
:as_x
select public.__expect((select count(*) = 0 from public.campaigns), 'Xray non vede le campagne di Kappa');
select public.__expect((select count(*) = 0 from public.outbound_messages), 'Xray non vede i messaggi di Kappa');
select public.__expect((select count(*) = 0 from public.inbound_messages), 'Xray non vede le risposte di Kappa');
select public.__expect((select count(*) = 0 from public.communication_accounts), 'Xray non vede gli account di Kappa');
select public.__expect((select count(*) = 0 from public.consent_records), 'Xray non vede i consensi di Kappa');
select public.__expect_error(format($$select public.add_campaign_recipients(%L, '{}')$$, :'camp'), array['P0002'], 'Xray non aggiunge destinatari alle campagne di Kappa');
select public.__expect_error(format($$select public.campaign_transition(%L, 'pause')$$, :'camp'), array['P0002'], 'Xray non mette in pausa campagne di Kappa');
select public.__expect_error(format($$select public.campaign_metrics(%L, now() - interval '1 day', now())$$, :'org_k'), array['42501'], 'Xray non legge le metriche di Kappa');
select public.__expect_error(format($$select private.lead_eligibility(%L, %L, 'email')$$, :'org_k', :'l_it'), array['42501'], 'Xray non interroga l''idoneità dei lead di Kappa');
:as_postgres
\o /dev/null
insert into public.campaigns (organization_id, name) values (:'org_x', 'Campagna Xray');
\o
select id as camp_x from public.campaigns where name = 'Campagna Xray' \gset
:as_x
select public.__expect_error(format($$insert into public.campaign_recipients (organization_id, campaign_id, lead_id) values (%L, %L, %L)$$, :'org_x', :'camp_x', :'l_it'),
  array['23503'], 'FK composita: nessun lead di Kappa in una campagna Xray');
select public.__expect_error(format($$update public.campaigns set account_id = %L where id = %L$$, :'acc', :'camp_x'),
  array['23503'], 'FK composita: nessun account di Kappa in una campagna Xray');
select public.__expect_error($$select public.begin_send(gen_random_uuid())$$, array['42501'], 'i client non chiamano begin_send');
select public.__expect_error($$select * from public.claim_automation_jobs('x', 1, 60)$$, array['42501'], 'i client non prelevano job');
:as_k
select public.__expect_error(format($$insert into public.outbound_messages (organization_id, kind, account_id, to_email, subject, body_text, idempotency_key) values (%L, 'test', %L, 'a@b.test', 'x', 'y', 'client:1')$$, :'org_k', :'acc'),
  array['42501'], 'i client non creano messaggi in uscita');

:as_postgres
\echo 'Tutti i test Campaign Manager sono passati.'
