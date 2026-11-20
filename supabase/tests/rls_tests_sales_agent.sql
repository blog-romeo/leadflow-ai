-- ════════════════════════════════════════════════════════════════════════════
-- Test Sales Agent: pipeline, cronologia, proposte, bozze, follow-up,
-- opportunità, copilota, quote AI e isolamento multi-tenant.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set E '00000000-0000-0000-0000-0000000000e1'
\set F '00000000-0000-0000-0000-0000000000f1'
\set G '00000000-0000-0000-0000-0000000000e2'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_e 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000000e1"}'';'
\set as_g 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000000e2"}'';'
\set as_f 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000000f1"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email) values (:'E', 'elena@epsilon.test'), (:'F', 'fabio@phi.test'), (:'G', 'giulia@epsilon.test');
\o
:as_e
\o /dev/null
select public.create_organization('Epsilon Web Srl');
\o
:as_f
\o /dev/null
select public.create_organization('Phi Marketing Srl');
\o
:as_postgres
select id as org_e from public.organizations where created_by = :'E' \gset
select id as org_f from public.organizations where created_by = :'F' \gset
insert into public.organization_members (organization_id, user_id, role) values (:'org_e', :'G', 'member');

select public.__expect((select count(*) = 1 from public.sales_profiles where organization_id = :'org_e' and commercial_name = 'Epsilon Web Srl'),
  'profilo commerciale creato con l''organizzazione');

-- ── Profilo commerciale ────────────────────────────────────────────────────
:as_e
do $$ declare n int; begin
  update public.sales_profiles set
    sector = 'Web agency', offer_description = 'Siti e prenotazioni dirette per hotel',
    services = '[{"id":"sito","name":"Sito web","price_from":2500,"price_unit":"una tantum"},{"id":"booking","name":"Booking engine","price_from":49,"price_unit":"/mese"}]',
    ideal_customer = 'Hotel indipendenti', tone = 'consultative', call_to_action = 'Prenota una call di 20 minuti',
    follow_up_days = '{2,5,10}'
  where true;
  get diagnostics n = row_count;
  perform public.__expect(n = 1, 'l''admin configura il profilo commerciale');
end $$;
select public.__expect((select ideal_customer = 'Hotel indipendenti' and services_description like '%Sito web%' from public.organization_profiles),
  'profilo sincronizzato verso lo scoring (fonte unica)');
select public.__expect_error($$update public.sales_profiles set services = '[{"id":"X Y","name":""}]'$$, array['23514'], 'servizi validati dal database');
select public.__expect_error($$update public.sales_profiles set follow_up_days = '{7,3}'$$, array['23514'], 'cadenze crescenti e tra 1 e 90 giorni');
select public.__expect_error($$update public.sales_profiles set booking_url = 'javascript:alert(1)'$$, array['23514'], 'calendario solo con URL https');
select public.__expect_error($$update public.organization_profiles set ideal_customer = 'altro'$$, array['42501'], 'il cliente ideale si modifica solo nel profilo commerciale');
:as_g
do $$ declare n int; begin
  update public.sales_profiles set sector = 'x' where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'un membro non modifica il profilo commerciale');
end $$;

-- ── Lead di prova ──────────────────────────────────────────────────────────
:as_e
\o /dev/null
insert into public.lead_sources (organization_id, type, name, legal_basis) values (:'org_e', 'manual', 'Elenco proprio', 'legitimate_interest');
\o
select id as src_e from public.lead_sources limit 1 \gset
\o /dev/null
insert into public.leads (organization_id, source_id, company_name, email) values
  (:'org_e', :'src_e', 'Hotel Uno', 'info@hoteluno.test'),
  (:'org_e', :'src_e', 'Hotel Due', 'info@hoteldue.test');
\o
select id as lead1 from public.leads where company_name = 'Hotel Uno' \gset
select id as lead2 from public.leads where company_name = 'Hotel Due' \gset

-- ── 4. Pipeline: stati, cronologia, responsabile ───────────────────────────
:as_g
update public.leads set status = 'qualified' where id = :'lead1';
update public.leads set status = 'to_contact' where id = :'lead1';
select public.__expect((select count(*) = 2 from public.activities where lead_id = :'lead1' and type = 'status_change'),
  'ogni cambio di stato registrato nella cronologia');
select public.__expect((select bool_and(created_by = :'G' and metadata ->> 'actor' = :'G') from public.activities where lead_id = :'lead1' and type = 'status_change'),
  'la cronologia registra l''utente responsabile');
select public.__expect((select metadata ->> 'from' = 'qualified' and metadata ->> 'to' = 'to_contact' from public.activities
  where lead_id = :'lead1' and type = 'status_change' order by occurred_at desc, created_at desc limit 1), 'cronologia con stato precedente e successivo');
select public.__expect((select count(*) = 2 from public.lead_activities where lead_id = :'lead1'), 'vista lead_activities sulle attività esistenti');

-- ── 3. Proposte e 5. follow-up programmati ─────────────────────────────────
\o /dev/null
insert into public.sales_proposals (organization_id, lead_id, title, content)
values (:'org_e', :'lead1', 'Proposta sito e booking', '{"solution":"Nuovo sito"}');
\o
select id as prop1 from public.sales_proposals where lead_id = :'lead1' \gset
select public.__expect((select created_by = :'G' and generated_by = 'manual' and status = 'draft' from public.sales_proposals where id = :'prop1'),
  'proposta salvata come bozza con autore');
select public.__expect_error(format($$insert into public.sales_proposals (organization_id, lead_id, title, content, generated_by) values (%L, %L, 'Finta AI', '{}', 'ai')$$, :'org_e', :'lead1'),
  array['42501'], 'i client non possono marcare una proposta come generata dall''AI');
select public.__expect_error(format($$update public.sales_proposals set status = 'sent_manually' where id = %L$$, :'prop1'),
  array['P0001'], 'una bozza non può risultare inviata senza approvazione');
update public.sales_proposals set status = 'approved' where id = :'prop1';
select public.__expect((select approved_by = :'G' from public.sales_proposals where id = :'prop1'), 'approvazione tracciata');
select public.__expect((select count(*) = 3 from public.follow_up_tasks where proposal_id = :'prop1' and source = 'cadence'),
  'approvazione → 3 follow-up secondo le cadenze configurate');
select public.__expect((select array_agg(kind::text order by due_at) = '{check_in,second_contact,opportunity_review}'
  and min(due_at)::date = (now() + interval '2 days')::date and max(due_at)::date = (now() + interval '10 days')::date
  from public.follow_up_tasks where proposal_id = :'prop1'), 'giorni 2/5/10 e tipi corretti');
select public.__expect_error(format($$update public.sales_proposals set title = 'Modifica' where id = %L$$, :'prop1'),
  array['P0001'], 'proposta approvata non modificabile senza tornare in bozza');
update public.sales_proposals set status = 'sent_manually' where id = :'prop1';
select public.__expect((select status = 'proposal_sent' from public.leads where id = :'lead1'),
  'registrazione manuale dell''invio → pipeline "Proposta inviata"');

-- ── Bozze di messaggi ──────────────────────────────────────────────────────
\o /dev/null
insert into public.message_drafts (organization_id, lead_id, channel, variant, subject, body)
values (:'org_e', :'lead1', 'email', 'professional', 'Oggetto', 'Testo della bozza');
\o
select id as draft1 from public.message_drafts where lead_id = :'lead1' \gset
update public.message_drafts set body = 'Testo modificato' where id = :'draft1';
select public.__expect((select edited_at is not null from public.message_drafts where id = :'draft1'), 'modifica della bozza tracciata');
update public.message_drafts set status = 'approved' where id = :'draft1';
select public.__expect_error(format($$update public.message_drafts set body = 'x' where id = %L$$, :'draft1'), array['P0001'], 'bozza approvata bloccata');
select public.__expect_error(format($$update public.message_drafts set warnings = '[]' where id = %L$$, :'draft1'), array['42501'], 'avvisi di verifica scritti solo dal server');
update public.message_drafts set status = 'archived' where id = :'draft1';
select public.__expect((select archived_at is not null from public.message_drafts where id = :'draft1'), 'archiviazione della bozza');

-- ── Opposizione: blocchi su pipeline, bozze e follow-up ───────────────────
:as_e
\o /dev/null
insert into public.message_drafts (organization_id, lead_id, channel, variant, body) values (:'org_e', :'lead1', 'whatsapp', 'direct', 'Ciao');
\o
update public.leads set contact_status = 'opted_out' where id = :'lead1';
select public.__expect((select status = 'not_contactable' from public.leads where id = :'lead1'), 'opposizione → "Non contattabile"');
select public.__expect((select count(*) = 2 and bool_and(status = 'blocked') from public.follow_up_tasks where lead_id = :'lead1' and is_contact),
  'follow-up di contatto bloccati');
select public.__expect((select status = 'open' from public.follow_up_tasks where lead_id = :'lead1' and kind = 'opportunity_review'),
  'la revisione interna dell''opportunità resta aperta');
select public.__expect_error(format($$update public.leads set status = 'contacted' where id = %L$$, :'lead1'), array['P0001'],
  'un lead non contattabile non può tornare in uno stato di contatto');
select public.__expect_error(format($$update public.message_drafts set status = 'approved' where lead_id = %L and status = 'draft'$$, :'lead1'), array['P0001'],
  'nessuna approvazione di bozze per lead con opposizione');
select public.__expect_error(format($$insert into public.follow_up_tasks (organization_id, lead_id, kind, title, due_at) values (%L, %L, 'custom', 'Richiama', now())$$, :'org_e', :'lead1'),
  array['P0001'], 'nessun nuovo promemoria di contatto per lead con opposizione');
do $$ declare n int; begin
  update public.leads set status = 'lost' where company_name = 'Hotel Uno'; get diagnostics n = row_count;
  perform public.__expect(n = 1, 'un lead non contattabile può essere chiuso come perso');
end $$;

-- ── Opportunità e conversioni ──────────────────────────────────────────────
\o /dev/null
insert into public.sales_opportunities (organization_id, lead_id, title, service_name, value_amount)
values (:'org_e', :'lead2', 'Sito Hotel Due', 'Sito web', 2500);
\o
select public.__expect_error(format($$insert into public.sales_opportunities (organization_id, lead_id, title) values (%L, %L, 'Doppia')$$, :'org_e', :'lead2'),
  array['23505'], 'una sola opportunità aperta per lead');
\o /dev/null
insert into public.appointments (organization_id, lead_id, title, starts_at, ends_at)
values (:'org_e', :'lead2', 'Call conoscitiva', now() + interval '1 day', now() + interval '1 day 30 minutes');
\o
select public.__expect((select status = 'meeting_scheduled' from public.leads where id = :'lead2'), 'appuntamento → "Appuntamento fissato"');
update public.leads set status = 'won' where id = :'lead2';
select public.__expect((select status = 'won' and closed_at is not null and closed_by = :'E' from public.sales_opportunities where lead_id = :'lead2'),
  'cliente acquisito → opportunità chiusa come vinta');
select public.__expect((select (public.sales_dashboard(:'org_e', now() - interval '30 days', now() + interval '1 minute') ->> 'conversions')::int = 1),
  'dashboard: conversione effettivamente registrata');
select public.__expect((select (d ->> 'proposals_generated')::int = 1 and (d ->> 'appointments_scheduled')::int = 1
    and (d -> 'by_stage' ->> 'won')::int = 1 and jsonb_array_length(d -> 'weekly') >= 4
  from (select public.sales_dashboard(:'org_e', now() - interval '30 days', now() + interval '1 minute') as d) x),
  'dashboard: KPI e serie settimanali da dati reali');
select public.__expect_error(format($$select public.sales_dashboard(%L, now(), now() - interval '1 day')$$, :'org_e'), array['22023'], 'periodo della dashboard validato');

-- ── Copilota: conversazioni private ────────────────────────────────────────
:as_service
\o /dev/null
insert into public.ai_conversations (organization_id, user_id, title) values (:'org_e', :'E', 'Lead da analizzare');
\o
select id as conv_e from public.ai_conversations where user_id = :'E' \gset
\o /dev/null
insert into public.ai_messages (organization_id, conversation_id, role, content) values (:'org_e', :'conv_e', 'user', 'Quali lead oggi?');
insert into public.ai_jobs (organization_id, type, task, created_by, input) values (:'org_e', 'sales_agent', 'copilot', :'E', '{}');
\o
select public.__expect((select (public.consume_usage(:'org_e', :'E', 'ai_generation', 1) ->> 'allowed')::boolean), 'quota generazioni AI');
select public.__expect((select (public.consume_usage(:'org_e', :'E', 'ai_tokens', 5000) ->> 'used')::int = 5000), 'token AI registrati a consuntivo');
:as_e
select public.__expect((select count(*) = 1 from public.ai_messages), 'l''autore legge la propria conversazione');
select public.__expect((select (public.usage_summary(:'org_e') -> 'ai_tokens' ->> 'used')::int = 5000 and public.usage_summary(:'org_e') ? 'ai_cost_usd'),
  'riepilogo token e costo per l''admin');
select public.__expect_error(format($$insert into public.ai_messages (organization_id, conversation_id, role, content) values (%L, %L, 'assistant', 'risposta falsa')$$, :'org_e', :'conv_e'),
  array['42501'], 'le risposte del copilota sono scritte solo dal server');
:as_g
select public.__expect((select count(*) = 0 from public.ai_conversations), 'un collega (anche della stessa org) non vede le conversazioni altrui');
select public.__expect((select count(*) = 0 from public.ai_messages), 'né i loro messaggi');
select public.__expect((select count(*) = 0 from public.ai_jobs where task = 'copilot'), 'né i loro job del copilota');
select public.__expect((select public.usage_summary(:'org_e') -> 'ai_cost_usd' = 'null'::jsonb), 'il costo AI è visibile solo agli admin');

-- ── 6. Isolamento multi-tenant ─────────────────────────────────────────────
:as_f
select public.__expect((select count(*) = 0 from public.sales_proposals), 'Phi non vede le proposte di Epsilon');
select public.__expect((select count(*) = 0 from public.message_drafts), 'Phi non vede le bozze di Epsilon');
select public.__expect((select count(*) = 0 from public.follow_up_tasks), 'Phi non vede i follow-up di Epsilon');
select public.__expect((select count(*) = 0 from public.sales_opportunities), 'Phi non vede le opportunità di Epsilon');
select public.__expect((select count(*) = 1 from public.sales_profiles), 'Phi vede solo il proprio profilo commerciale');
select public.__expect((select count(*) = 0 from public.lead_activities), 'Phi non vede la cronologia di Epsilon');
select public.__expect_error(format($$select public.sales_dashboard(%L, now() - interval '7 days', now())$$, :'org_e'), array['42501'],
  'Phi non legge la dashboard di Epsilon');
select public.__expect_error(format($$insert into public.sales_proposals (organization_id, lead_id, title, content) values (%L, %L, 'Furto', '{}')$$, :'org_e', :'lead2'),
  array['42501'], 'Phi non crea proposte in Epsilon');
:as_postgres
select id as org_f_src from public.organizations where id = :'org_f' \gset
:as_f
select public.__expect_error(format($$insert into public.message_drafts (organization_id, lead_id, channel, variant, body) values (%L, %L, 'email', 'direct', 'x')$$, :'org_f', :'lead2'),
  array['23503'], 'FK composita: una bozza di Phi non può puntare a un lead di Epsilon');
do $$ declare n int; begin
  update public.sales_opportunities set value_amount = 0 where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'Phi non modifica opportunità di Epsilon');
end $$;

:as_postgres
\echo 'Tutti i test Sales Agent sono passati.'
