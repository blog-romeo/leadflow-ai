-- ════════════════════════════════════════════════════════════════════════════
-- Test di isolamento multi-tenant e autorizzazioni.
-- Eseguiti da supabase/tests/run_local_rls_tests.sh su un Postgres temporaneo.
-- Ogni asserzione fallita interrompe l'esecuzione (ON_ERROR_STOP).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1

-- Utenti di test
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'
\set M '00000000-0000-0000-0000-00000000000c'
\set S '00000000-0000-0000-0000-00000000000d'
\set O '00000000-0000-0000-0000-00000000000e'

\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000000a"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000000b"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000000c"}'';'
\set as_s 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000000d"}'';'
\set as_o 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-00000000000e"}'';'

-- Helper: si aspetta che lo statement fallisca con uno degli SQLSTATE indicati.
create or replace function public.__expect_error(p_sql text, p_states text[], p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = any (p_states) then
      raise notice 'PASS  %', p_label;
      return;
    end if;
    raise exception 'FAIL  % (sqlstate % atteso %): %', p_label, sqlstate, p_states, sqlerrm;
  end;
  raise exception 'FAIL  % (nessun errore, atteso %)', p_label, p_states;
end $$;

create or replace function public.__expect(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL  %', p_label;
  end if;
  raise notice 'PASS  %', p_label;
end $$;
grant execute on function public.__expect_error(text, text[], text), public.__expect(boolean, text) to anon, authenticated;

\pset tuples_only on
\pset format unaligned
\o /dev/null

-- ── Setup utenti (trigger handle_new_user crea i profili) ──────────────────
:as_postgres
insert into auth.users (id, email, raw_user_meta_data) values
  (:'A', 'anna@alfa.test', '{"full_name":"Anna Alfa"}'),
  (:'B', 'bruno@beta.test', '{"full_name":"Bruno Beta"}'),
  (:'M', 'marco@alfa.test', '{"full_name":"Marco Membro"}'),
  (:'S', 'sara@leadflow.test', '{"full_name":"Sara Super"}'),
  (:'O', 'otto@outside.test', '{}');
\o
select public.__expect((select count(*) = 5 from public.profiles), 'profili creati automaticamente alla registrazione');

-- ── Creazione organizzazioni via RPC ───────────────────────────────────────
:as_anon
select public.__expect_error($$select public.create_organization('Anon Srl')$$, array['42501'], 'anon non può creare organizzazioni');

:as_a
select public.__expect_error($$select public.create_organization('x')$$, array['22023'], 'nome organizzazione validato lato server');
select public.__expect_error($$select public.create_organization('Alfa', 'ZZ!!')$$, array['22023'], 'partita IVA validata lato server');
\o /dev/null
select public.create_organization('Alfa Srl', 'IT01234567890');
\o
:as_b
\o /dev/null
select public.create_organization('Beta S.p.A.');
\o

:as_postgres
select id as org_a from public.organizations where created_by = :'A' \gset
select id as org_b from public.organizations where created_by = :'B' \gset
insert into public.organization_members (organization_id, user_id, role) values (:'org_a', :'M', 'member');
update public.profiles set platform_role = 'super_admin' where id = :'S';

select public.__expect((select role = 'organization_admin' from public.organization_members where user_id = :'A'), 'il creatore diventa organization_admin');

-- ── Dati commerciali di Alfa ───────────────────────────────────────────────
:as_a
\o /dev/null
insert into public.lead_sources (organization_id, type, name, legal_basis, created_by)
values (:'org_a', 'manual', 'Inserimento manuale', 'legitimate_interest', :'B');  -- created_by falsificato
\o
select id as src_a from public.lead_sources limit 1 \gset
\o /dev/null
insert into public.leads (organization_id, source_id, company_name, email)
values (:'org_a', :'src_a', 'Cliente Uno Srl', 'info@clienteuno.test'),
       (:'org_a', :'src_a', 'Cliente Due Srl', 'acquisti@clientedue.test');
\o
select public.__expect((select created_by = :'A' from public.lead_sources where id = :'src_a'), 'created_by imposto dal server (non falsificabile)');
select id as lead_a1 from public.leads where company_name = 'Cliente Uno Srl' \gset
select id as lead_a2 from public.leads where company_name = 'Cliente Due Srl' \gset

:as_b
\o /dev/null
insert into public.lead_sources (organization_id, type, name, legal_basis)
values (:'org_b', 'csv_import', 'Fiera 2026', 'legitimate_interest');
\o
select id as src_b from public.lead_sources limit 1 \gset

-- ── Isolamento tra tenant ──────────────────────────────────────────────────
select public.__expect((select count(*) = 1 from public.organizations), 'B vede solo la propria organizzazione');
select public.__expect((select count(*) = 0 from public.leads), 'B non vede i lead di Alfa');
select public.__expect((select count(*) = 1 from public.lead_sources), 'B vede solo le proprie fonti');
select public.__expect_error(format($$insert into public.leads (organization_id, source_id, company_name) values (%L, %L, 'Furto')$$, :'org_a', :'src_a'),
  array['42501'], 'B non può inserire lead in Alfa');
select public.__expect_error(format($$insert into public.leads (organization_id, source_id, company_name) values (%L, %L, 'Mix')$$, :'org_b', :'src_a'),
  array['23503'], 'FK composita: un lead di Beta non può usare una fonte di Alfa');
do $$ declare n int; begin
  update public.leads set company_name = 'Hacked' where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'B non può modificare lead di Alfa');
  delete from public.leads where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'B non può cancellare lead di Alfa');
  update public.organizations set name = 'Hacked' where id <> (select organization_id from public.organization_members limit 1); get diagnostics n = row_count;
  perform public.__expect(n = 0, 'B non può modificare l''organizzazione Alfa');
end $$;
select public.__expect((select count(*) = 0 from public.profiles where id = :'A'), 'B non vede il profilo di utenti di altre org');
select public.__expect((select count(*) = 0 from public.audit_logs where organization_id = :'org_a'), 'B non vede l''audit log di Alfa');

-- ── Membro (non admin) di Alfa ─────────────────────────────────────────────
:as_m
select public.__expect((select count(*) = 2 from public.leads), 'il membro vede i lead della propria org');
select public.__expect((select count(*) = 2 from public.profiles), 'il membro vede i profili dei colleghi');
do $$ declare n int; begin
  delete from public.leads where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'il membro non può cancellare lead (solo admin)');
  update public.organizations set name = 'Membro' where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'il membro non può modificare l''organizzazione');
  update public.organization_members set role = 'organization_admin' where true; get diagnostics n = row_count;
  perform public.__expect(n = 0, 'il membro non può promuoversi admin');
end $$;
select public.__expect((select count(*) = 0 from public.audit_logs), 'il membro non vede l''audit log');
select public.__expect((select count(*) = 0 from public.subscriptions), 'il membro non vede la subscription');

-- ── Admin di Alfa: limiti di colonna e tabelle server-only ────────────────
:as_a
do $$ declare n int; begin
  update public.organizations set name = 'Alfa Group Srl' where true; get diagnostics n = row_count;
  perform public.__expect(n = 1, 'l''admin aggiorna la propria organizzazione');
end $$;
select public.__expect_error($$update public.organizations set slug = 'hijack'$$, array['42501'], 'slug non modificabile dal client');
select public.__expect_error($$update public.profiles set platform_role = 'super_admin'$$, array['42501'], 'nessuno può autopromuoversi super_admin');
select public.__expect_error(format($$insert into public.ai_jobs (organization_id, type) values (%L, 'lead_scoring')$$, :'org_a'),
  array['42501'], 'ai_jobs scrivibili solo dal server');
select public.__expect_error(format($$insert into public.audit_logs (organization_id, action, entity_type) values (%L, 'fake', 'x')$$, :'org_a'),
  array['42501'], 'audit_logs append-only lato server');
select public.__expect_error(format($$insert into public.subscriptions (organization_id, plan, status) values (%L, 'enterprise', 'active')$$, :'org_a'),
  array['42501'], 'subscriptions scrivibili solo dal webhook server');
select public.__expect_error(format($$insert into public.organization_members (organization_id, user_id) values (%L, %L)$$, :'org_a', :'O'),
  array['42501'], 'aggiunta membri solo tramite flusso server (inviti)');
select public.__expect_error(format($$update public.leads set organization_id = %L where id = %L$$, :'org_b', :'lead_a1'),
  array['42501'], 'un lead non può essere spostato in un''altra org');
select public.__expect_error($$truncate public.leads$$, array['42501'], 'TRUNCATE negato ai client (bypasserebbe RLS)');
select public.__expect_error(format($$update public.organization_members set role = 'member' where user_id = %L$$, :'A'),
  array['P0001'], 'l''ultimo admin non può degradarsi');
select public.__expect((select count(*) > 0 from public.audit_logs where organization_id = :'org_a'), 'l''admin vede l''audit log della propria org');

-- ── Opposizione e soppressione ─────────────────────────────────────────────
update public.leads set contact_status = 'opted_out' where id = :'lead_a1';
select public.__expect((select opted_out_at is not null from public.leads where id = :'lead_a1'), 'opposizione registra la data');
select public.__expect((select count(*) = 1 from public.contact_suppressions), 'opposizione aggiunge l''hash alla suppression list');
select public.__expect_error(format($$insert into public.leads (organization_id, source_id, company_name, email) values (%L, %L, 'Reimport', 'INFO@clienteuno.test ')$$, :'org_a', :'src_a'),
  array['P0001'], 'un contatto opposto non può essere reimportato');
:as_m
select public.__expect_error(format($$update public.leads set contact_status = 'active' where id = %L$$, :'lead_a1'),
  array['42501'], 'solo un admin può revocare un''opposizione');
select public.suppress_lead(:'lead_a2');
select public.__expect((select email is null and contact_name is null and contact_status = 'suppressed' from public.leads where id = :'lead_a2'),
  'soppressione cancella i dati personali');
select public.__expect_error(format($$update public.leads set email = 'x@y.test', contact_status = 'active' where id = %L$$, :'lead_a2'),
  array['P0001'], 'un contatto soppresso non può essere ripristinato');
:as_b
select public.__expect_error(format($$select public.suppress_lead(%L)$$, :'lead_a1'),
  array['P0002'], 'B non può sopprimere lead di Alfa (non li vede)');

-- ── Super admin ────────────────────────────────────────────────────────────
:as_s
select public.__expect((select count(*) = 2 from public.organizations), 'super_admin vede tutte le organizzazioni');
select public.__expect((select count(*) = 3 from public.organization_members), 'super_admin vede le membership');
select public.__expect((select count(*) = 0 from public.leads), 'super_admin NON vede i dati commerciali dei tenant');
select public.__expect((select count(*) > 0 from public.audit_logs), 'super_admin vede l''audit log di piattaforma');

-- ── Utente esterno ─────────────────────────────────────────────────────────
:as_o
select public.__expect((select count(*) = 0 from public.organizations), 'utente senza org non vede organizzazioni');
select public.__expect((select count(*) = 1 from public.profiles), 'utente senza org vede solo il proprio profilo');

-- ── Anonimo ────────────────────────────────────────────────────────────────
:as_anon
select public.__expect_error($$select count(*) from public.leads$$, array['42501'], 'anon non ha accesso alle tabelle');

-- ── Organizzazione disattivata ─────────────────────────────────────────────
:as_postgres
update public.organizations set deleted_at = now() where id = :'org_b';
:as_b
select public.__expect((select count(*) = 0 from public.lead_sources), 'org disattivata: i membri perdono l''accesso');

:as_postgres
\echo 'Tutti i test RLS sono passati.'
