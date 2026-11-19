-- ════════════════════════════════════════════════════════════════════════════
-- Test Lead Finder: isolamento, deduplicazione, licenze, quote e rate limit.
-- Indipendente da rls_tests.sql (usa utenti e organizzazioni propri).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set C '00000000-0000-0000-0000-0000000000c1'
\set D '00000000-0000-0000-0000-0000000000d1'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_c 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000000c1"}'';'
\set as_d 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000000d1"}'';'

:as_postgres
\o /dev/null
insert into auth.users (id, email) values (:'C', 'carla@gamma.test'), (:'D', 'dario@delta.test');
\o
:as_c
\o /dev/null
select public.create_organization('Gamma Consulting Srl');
\o
:as_d
\o /dev/null
select public.create_organization('Delta Digital Srl');
\o
:as_postgres
select id as org_c from public.organizations where created_by = :'C' \gset
select id as org_d from public.organizations where created_by = :'D' \gset

select public.__expect((select count(*) = 2 from public.organization_profiles where organization_id in (:'org_c', :'org_d')),
  'profilo ICP creato con l''organizzazione');
select public.__expect((select monthly_searches = 50 from public.organization_quotas where organization_id = :'org_c'),
  'quote predefinite create con l''organizzazione');

-- ── Scritture lato server (service role) ───────────────────────────────────
:as_service
\o /dev/null
insert into public.lead_searches (organization_id, provider, params, created_by)
values (:'org_c', 'osm_overpass', '{"sector":"hotel","location":"Roma"}', :'C');
\o
select id as search_c from public.lead_searches where organization_id = :'org_c' \gset
\o /dev/null
insert into public.lead_candidates (organization_id, provider, external_id, search_id, company_name, city, country, website,
  can_store_content, can_export, can_save_to_crm, dedup_key, score, priority, score_basis)
values (:'org_c', 'osm_overpass', 'node/101', :'search_c', 'Hotel Aurora', 'Roma', 'IT', 'https://hotelaurora.example',
  true, true, true, 'hotelaurora.example', 62, 'medium', 'rules');
\o
select id as cand_c from public.lead_candidates where organization_id = :'org_c' \gset

select public.__expect_error(format($$insert into public.lead_candidates (organization_id, provider, external_id, can_store_content, can_export, can_save_to_crm)
  values (%L, 'osm_overpass', 'node/101', true, true, true)$$, :'org_c'), array['23505'], 'duplicato candidato per stessa org e fonte bloccato');
select public.__expect_error(format($$insert into public.lead_candidates (organization_id, provider, external_id, company_name, can_store_content, can_export, can_save_to_crm)
  values (%L, 'google_places', 'ChIJabc', 'Nome da Google', false, false, false)$$, :'org_c'), array['23514'], 'licenza Google: il nome non può essere memorizzato');
\o /dev/null
insert into public.lead_candidates (organization_id, provider, external_id, can_store_content, can_export, can_save_to_crm)
values (:'org_c', 'google_places', 'ChIJabc', false, false, false);
\o
select public.__expect_error(format($$update public.lead_candidates set status = 'saved' where organization_id = %L and provider = 'google_places'$$, :'org_c'),
  array['23514'], 'un candidato non salvabile per licenza non può risultare salvato');
\o /dev/null
-- Stesso id esterno in un'altra organizzazione: consentito (dati separati).
insert into public.lead_candidates (organization_id, provider, external_id, company_name, can_store_content, can_export, can_save_to_crm)
values (:'org_d', 'osm_overpass', 'node/101', 'Hotel Aurora', true, true, true);
\o

-- ── Persistenza CRM e deduplicazione dei lead ──────────────────────────────
\o /dev/null
insert into public.lead_sources (organization_id, type, name, legal_basis, provider, created_by)
values (:'org_c', 'api', 'OpenStreetMap (Overpass)', 'legitimate_interest', 'osm_overpass', :'C');
\o
select id as src_c from public.lead_sources where organization_id = :'org_c' \gset
select public.__expect_error(format($$insert into public.lead_sources (organization_id, type, name, legal_basis, provider) values (%L, 'api', 'Doppione', 'legitimate_interest', 'osm_overpass')$$, :'org_c'),
  array['23505'], 'una sola fonte API per provider e organizzazione');
\o /dev/null
insert into public.leads (organization_id, source_id, company_name, city, country, website, provider, external_id, dedup_key,
  score, priority, score_basis, acquired_at, created_by)
values (:'org_c', :'src_c', 'Hotel Aurora', 'Roma', 'IT', 'https://hotelaurora.example', 'osm_overpass', 'node/101',
  'hotelaurora.example', 62, 'medium', 'rules', now(), :'C');
\o
select id as lead_c from public.leads where organization_id = :'org_c' \gset
update public.lead_candidates set status = 'saved', lead_id = :'lead_c' where id = :'cand_c';
select public.__expect((select created_by = :'C' from public.leads where id = :'lead_c'), 'il server registra l''autore del salvataggio');
select public.__expect_error(format($$insert into public.leads (organization_id, source_id, company_name, provider, external_id) values (%L, %L, 'Hotel Aurora bis', 'osm_overpass', 'node/101')$$, :'org_c', :'src_c'),
  array['23505'], 'stesso lead dalla stessa fonte non salvabile due volte');
select public.__expect_error(format($$insert into public.leads (organization_id, source_id, company_name, dedup_key) values (%L, %L, 'Hotel Aurora', 'hotelaurora.example')$$, :'org_c', :'src_c'),
  array['23505'], 'stessa azienda (dominio) non duplicabile nel CRM');
select public.__expect_error(format($$insert into public.leads (organization_id, source_id, company_name, provider) values (%L, %L, 'X', 'osm_overpass')$$, :'org_c', :'src_c'),
  array['23514'], 'provider e id esterno sempre in coppia');

-- ── Quote e rate limit ─────────────────────────────────────────────────────
:as_postgres
update public.organization_quotas set monthly_searches = 2, requests_per_minute = 3 where organization_id = :'org_c';
:as_service
select public.__expect((select (public.consume_usage(:'org_c', :'C', 'lead_search', 1) ->> 'allowed')::boolean), 'quota: 1ª ricerca consentita');
select public.__expect((select (public.consume_usage(:'org_c', :'C', 'lead_search', 1) ->> 'allowed')::boolean), 'quota: 2ª ricerca consentita');
select public.__expect((select not (public.consume_usage(:'org_c', :'C', 'lead_search', 1) ->> 'allowed')::boolean), 'quota: 3ª ricerca bloccata al limite');
select public.__expect((select (public.consume_usage(:'org_d', :'D', 'lead_search', 1) ->> 'allowed')::boolean), 'quota: il limite di un''org non tocca le altre');
select public.__expect((select (public.consume_usage(:'org_c', :'C', 'lead_result', 0) ->> 'remaining')::int = 1000), 'quota: consultazione senza consumo');
select public.__expect((select bool_and((public.check_rate_limit(:'org_c', :'C', 'search') ->> 'allowed')::boolean) from generate_series(1, 3)),
  'rate limit: 3 richieste al minuto consentite');
select public.__expect((select not (public.check_rate_limit(:'org_c', :'C', 'search') ->> 'allowed')::boolean), 'rate limit: la 4ª richiesta è respinta');

-- ── Lato client ────────────────────────────────────────────────────────────
:as_d
select public.__expect((select count(*) = 1 from public.lead_candidates), 'D vede solo i candidati della propria org');
select public.__expect((select count(*) = 0 from public.lead_searches), 'D non vede le ricerche di Gamma');
select public.__expect_error(format($$select public.usage_summary(%L)$$, :'org_c'), array['42501'], 'D non legge i consumi di Gamma');
select public.__expect_error($$select public.consume_usage(gen_random_uuid(), gen_random_uuid(), 'lead_search', -100)$$, array['42501'],
  'i client non possono manipolare le quote');
:as_c
select public.__expect((select count(*) = 2 from public.lead_candidates), 'Gamma vede i propri candidati');
select public.__expect((select (public.usage_summary(:'org_c') -> 'searches' ->> 'used')::int = 2), 'riepilogo crediti utilizzati per i membri');
select public.__expect_error(format($$update public.lead_candidates set score = 100 where id = %L$$, :'cand_c'), array['42501'],
  'il punteggio AI non è modificabile dal client');
select public.__expect_error(format($$update public.leads set score = 100 where id = %L$$, :'lead_c'), array['42501'],
  'lo scoring dei lead è scritto solo dal server');
select public.__expect_error(format($$update public.organization_quotas set monthly_searches = 99999 where organization_id = %L$$, :'org_c'), array['42501'],
  'le quote non sono modificabili dal client');
select public.__expect_error(format($$update public.organization_profiles set weight_sector = 90 where organization_id = %L$$, :'org_c'), array['23514'],
  'i pesi dello scoring devono sommare 100');
do $$ declare n int; begin
  update public.organization_profiles
     set weight_sector = 40, weight_geography = 10, target_sectors = '{hotel}', target_countries = '{IT}'
   where true;
  get diagnostics n = row_count;
  perform public.__expect(n = 1, 'l''admin configura cliente ideale e pesi della propria org');
end $$;
select public.__expect_error($$update public.organization_profiles set target_countries = '{italia}'$$, array['23514'], 'paesi target validati (ISO 3166)');

:as_postgres
\echo 'Tutti i test Lead Finder sono passati.'
