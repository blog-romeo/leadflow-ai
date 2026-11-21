-- ════════════════════════════════════════════════════════════════════════════
-- Audit automatico dello schema (Prompt 6, eseguito per ultimo):
-- RLS su tutte le tabelle, funzioni SECURITY DEFINER con search_path fisso, privilegi
-- del ruolo anon, funzioni interne non esposte, tabelle sensibili senza scrittura diretta.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
reset role;

-- 1. Ogni tabella dello schema public ha RLS attiva.
select public.__expect(
  (select count(*) = 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  'RLS attiva su tutte le tabelle public: ' || coalesce((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 'ok'));

-- 2. Ogni funzione SECURITY DEFINER (public e private) fissa il search_path.
select public.__expect(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')),
  'search_path fisso su tutte le funzioni security definer: ' || coalesce((select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')), 'ok'));

-- 3. Il ruolo anon non può scrivere in nessuna tabella public.
select public.__expect(
  (select count(*) = 0 from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  'anon senza privilegi di scrittura: ' || coalesce((select string_agg(distinct table_name, ', ') from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')), 'ok'));

-- 4. Lo schema private (non esposto dall'API) non è utilizzabile da anon; per gli utenti
--    autenticati sono eseguibili solo predicati/validatori NON volatili usati dalle policy RLS.
select public.__expect(not has_schema_privilege('anon', 'private', 'usage'), 'schema private non accessibile ad anon');
select public.__expect(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.provolatile = 'v' and pg_get_function_result(p.oid) <> 'trigger'
      and has_function_privilege('authenticated', p.oid, 'execute')),
  'nessuna funzione private con effetti eseguibile dagli utenti: ' || coalesce((select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.provolatile = 'v' and pg_get_function_result(p.oid) <> 'trigger' and has_function_privilege('authenticated', p.oid, 'execute')), 'ok'));

-- 5. Le funzioni public SECURITY DEFINER eseguibili da anon sono solo quelle pubbliche previste.
select public.__expect(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
      and p.proname not in ('invitation_preview', '__expect', '__expect_error')),
  'funzioni security definer esposte ad anon solo se previste: ' || coalesce((select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') and p.proname not in ('invitation_preview', '__expect', '__expect_error')), 'ok'));

-- 6. Funzioni riservate al server (service role) non eseguibili dagli utenti autenticati.
select public.__expect(not has_function_privilege('authenticated', 'public.' || f, 'execute'), 'solo service role: ' || f)
  from unnest(array[
    'billing_apply_subscription(jsonb)', 'billing_claim_webhook_event(text,text,boolean,timestamp with time zone)',
    'tenant_by_hostname(text)', 'track_public_event(text,text,text)', 'record_app_error(text,text,text,text,text,text)',
    'monitoring_evaluate()', 'public_rate_limit(text,text,integer,integer)', 'org_invitation_mark_email(uuid,text)', 'run_retention_purge()',
    'ai_memory_record(uuid,text,text,jsonb,uuid,uuid,integer)', 'ai_memory_purge_expired()']) f
 where to_regprocedure('public.' || f) is not null;

-- 7. Tabelle di stato commerciale e di audit: nessuna scrittura diretta da authenticated.
select public.__expect(not has_table_privilege('authenticated', 'public.' || t, 'INSERT') and not has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
                        and not has_table_privilege('authenticated', 'public.' || t, 'DELETE'),
  'nessuna scrittura diretta su ' || t)
  from unnest(array['organization_subscriptions', 'usage_quotas', 'usage_ledger', 'stripe_webhook_events', 'billing_audit_logs', 'admin_audit_logs',
    'funnel_events', 'demo_requests', 'support_tickets', 'support_ticket_messages', 'onboarding_progress', 'app_errors', 'monitoring_alerts', 'reseller_subscriptions', 'organization_invitations',
    -- Prompt 8: motore multi-agent (scritture solo dal server o tramite RPC con controllo di ruolo).
    'ai_agents', 'ai_workflows', 'ai_workflow_steps', 'ai_agent_runs', 'ai_agent_tool_calls', 'ai_agent_approvals', 'ai_company_memory',
    'ai_research_evidence', 'ai_agent_costs']) t
 where to_regclass('public.' || t) is not null;

-- 8. Appartenenza alle organizzazioni: nessun INSERT diretto (solo creazione org e inviti accettati).
select public.__expect(not has_table_privilege('authenticated', 'public.organization_members', 'INSERT') and not has_table_privilege('anon', 'public.organization_members', 'INSERT'),
  'nessun inserimento diretto in organization_members');

-- 9. La pulizia di conservazione (elimina dati) è eseguibile solo dal server.
select public.__expect(not has_function_privilege('authenticated', 'public.run_retention_purge()', 'execute') and not has_function_privilege('anon', 'public.run_retention_purge()', 'execute'),
  'pulizia di conservazione non eseguibile dagli utenti');
set role service_role;
select public.__expect((public.run_retention_purge() ? 'purged_retention'), 'pulizia di conservazione eseguibile dalla service role');
reset role;

\echo 'Audit di sicurezza dello schema completato.'
