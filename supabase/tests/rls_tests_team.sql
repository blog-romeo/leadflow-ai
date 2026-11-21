-- ════════════════════════════════════════════════════════════════════════════
-- Test Prompt 7: inviti dei collaboratori.
-- Token monouso con hash, scadenza, verifica identità (email confermata e coincidente),
-- limite utenti del piano, revoca, rimozione, audit, isolamento tra organizzazioni.
-- Abbonamenti Stripe simulati come dal webhook verificato (dati di test, nessuna transazione).
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

\set A  '00000000-0000-0000-0000-0000000ee701'
\set M  '00000000-0000-0000-0000-0000000ee702'
\set X  '00000000-0000-0000-0000-0000000ee703'
\set U  '00000000-0000-0000-0000-0000000ee704'
\set B  '00000000-0000-0000-0000-0000000ee705'
\set as_postgres 'reset role; reset request.jwt.claims;'
\set as_service 'set role service_role; reset request.jwt.claims;'
\set as_anon 'set role anon; reset request.jwt.claims;'
\set as_a 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ee701"}'';'
\set as_m 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ee702"}'';'
\set as_x 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ee703"}'';'
\set as_u 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ee704"}'';'
\set as_b 'set role authenticated; set request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-0000000ee705"}'';'

:as_postgres
select private.billing_set_enforcement(true) \g /dev/null
\o /dev/null
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (:'A', 'anna@team-a.test', '{"full_name":"Anna Admin"}', now()),
  (:'M', 'marco@team-a.test', '{"full_name":"Marco Membro"}', now()),
  (:'X', 'xenia@altrove.test', '{}', now()),
  (:'U', 'ugo@team-a.test', '{}', null),
  (:'B', 'bruno@team-b.test', '{}', now());
\o

:as_a
select id as org_a from public.create_organization('Team A Srl', null, 'IT') \gset
:as_b
select id as org_b from public.create_organization('Team B Srl', null, 'IT') \gset

-- ── 1. Senza abbonamento: limite di 1 utente, nessun invito ────────────────
:as_a
select public.__expect_error(format($$select public.org_create_invitation(%L, 'marco@team-a.test', 'member')$$, :'org_a'),
  array['P0001'], 'senza piano attivo: limite utenti (1) raggiunto, invito rifiutato');

-- Piano Business (5 utenti) attivato dal webhook (simulato).
:as_service
select public.billing_link_customer(:'org_a', 'cus_TESTteamA1', false) \g /dev/null
select public.billing_apply_subscription(jsonb_build_object(
  'organization_id', :'org_a', 'stripe_subscription_id', 'sub_TESTteamA1', 'stripe_customer_id', 'cus_TESTteamA1',
  'stripe_price_id', 'price_TESTbusiness', 'plan_code', 'business', 'status', 'active', 'unit_amount_cents', 34900,
  'currency', 'eur', 'billing_interval', 'month', 'interval_count', 1,
  'current_period_start', date_trunc('day', now()), 'current_period_end', date_trunc('day', now()) + interval '30 days',
  'started_at', now(), 'stripe_synced_at', now(), 'event_type', 'checkout.session.completed')) \g /dev/null

-- ── 2. Creazione: solo admin, token restituito una volta, salvato solo come hash ──
:as_a
select public.org_create_invitation(:'org_a', '  Marco@Team-A.test ', 'member') as inv \gset
select (:'inv'::jsonb ->> 'token') as tok, (:'inv'::jsonb ->> 'id') as inv_id \gset
select public.__expect(length(:'tok') = 48 and :'tok' ~ '^[0-9a-f]+$', 'token casuale da 192 bit');
select public.__expect((:'inv'::jsonb ->> 'email') = 'marco@team-a.test', 'email normalizzata');
select public.__expect_error(format($$select public.org_create_invitation(%L, 'marco@team-a.test', 'member')$$, :'org_a'), array['P0001'], 'invito già in attesa per la stessa email');
select public.__expect_error(format($$select public.org_create_invitation(%L, 'anna@team-a.test', 'member')$$, :'org_a'), array['P0001'], 'chi è già membro non si invita');
select public.__expect_error(format($$select public.org_create_invitation(%L, 'non-una-email', 'member')$$, :'org_a'), array['22023'], 'email non valida');
select public.__expect((select count(*) = 1 from jsonb_array_elements(public.org_invitations(:'org_a')) e where e ->> 'email' = 'marco@team-a.test' and e ->> 'status' = 'pending' and not (e ? 'token_hash')), 'elenco inviti senza token');
select public.__expect_error($$select token_hash from public.organization_invitations$$, array['42501'], 'colonna token_hash non leggibile dagli utenti');
:as_postgres
select public.__expect((select token_hash = encode(extensions.digest(:'tok', 'sha256'), 'hex') and token_hash <> :'tok' from public.organization_invitations where id = :'inv_id'), 'nel database solo l''hash SHA-256 del token');
select public.__expect((select count(*) = 1 from public.audit_logs where action = 'invitation.created' and entity_id = :'inv_id' and metadata ->> 'email_domain' = 'team-a.test'
  and not (metadata::text like '%' || :'tok' || '%') and not (metadata::text like '%marco@%')), 'audit della creazione senza token né email completa');

-- ── 3. Nessuna auto-aggiunta, nessun accesso di altri ───────────────────────
:as_x
select public.__expect_error(format($$insert into public.organization_members (organization_id, user_id, role) values (%L, auth.uid(), 'member')$$, :'org_a'), array['42501'], 'nessuno si aggiunge da solo a un''organizzazione');
select public.__expect_error(format($$select public.org_create_invitation(%L, 'xenia@altrove.test', 'organization_admin')$$, :'org_a'), array['42501'], 'un estraneo non crea inviti');
select public.__expect_error(format($$select public.team_invitation_preview(%L)$$, :'tok'), array['P0002'], 'token valido ma email diversa: invito non trovato');
select public.__expect_error(format($$select public.accept_team_invitation(%L)$$, :'tok'), array['P0002'], 'un''altra persona non può usare il link');
select public.__expect((select count(*) = 0 from public.organization_invitations), 'inviti di altre organizzazioni non visibili');
:as_b
select public.__expect_error(format($$select public.org_revoke_invitation(%L, %L)$$, :'org_a', :'inv_id'), array['42501'], 'l''admin di un''altra organizzazione non revoca');
select public.__expect_error(format($$select public.org_invitations(%L)$$, :'org_a'), array['42501'], 'l''admin di un''altra organizzazione non legge gli inviti');
:as_anon
select public.__expect_error(format($$select public.accept_team_invitation(%L)$$, :'tok'), array['42501'], 'anon non accetta inviti');
select public.__expect_error(format($$select public.team_invitation_preview(%L)$$, :'tok'), array['42501'], 'anon non vede l''anteprima');
:as_m
select public.__expect_error($$select public.accept_team_invitation('0000')$$, array['P0002'], 'token inventato rifiutato');

-- ── 4. Accettazione: identità verificata, monouso ──────────────────────────
select public.__expect((public.team_invitation_preview(:'tok') ->> 'organization_name') = 'Team A Srl', 'anteprima per l''invitato');
select public.__expect(public.accept_team_invitation(:'tok') = :'org_a'::uuid, 'invito accettato');
select public.__expect((select role = 'member' from public.organization_members where organization_id = :'org_a' and user_id = :'M'), 'utente associato con il ruolo scelto');
select public.__expect_error(format($$select public.accept_team_invitation(%L)$$, :'tok'), array['P0001'], 'token monouso: seconda accettazione rifiutata');
select public.__expect((public.team_invitation_preview(:'tok') ->> 'status') = 'accepted', 'stato accettato');
select public.__expect_error(format($$select public.org_create_invitation(%L, 'xenia@altrove.test', 'member')$$, :'org_a'), array['42501'], 'un membro non amministratore non invita');
select public.__expect_error(format($$select public.org_invitations(%L)$$, :'org_a'), array['42501'], 'un membro non legge l''elenco inviti');
select public.__expect(jsonb_array_length(public.org_members(:'org_a') -> 'members') = 2, 'il membro vede i colleghi');
:as_postgres
select public.__expect((select count(*) = 1 from public.audit_logs where action = 'invitation.accepted' and organization_id = :'org_a'), 'audit dell''accettazione');

-- Email non confermata: identità non verificata.
:as_a
select public.org_create_invitation(:'org_a', 'ugo@team-a.test', 'member') ->> 'token' as tok_u \gset
:as_u
select public.__expect((public.team_invitation_preview(:'tok_u') ->> 'email_confirmed')::boolean = false, 'anteprima: email non confermata segnalata');
select public.__expect_error(format($$select public.accept_team_invitation(%L)$$, :'tok_u'), array['P0001'], 'email non confermata: accettazione rifiutata');
:as_postgres
update auth.users set email_confirmed_at = now() where id = :'U';
:as_u
select public.accept_team_invitation(:'tok_u') \g /dev/null
select public.__expect((select count(*) = 1 from public.organization_members where organization_id = :'org_a' and user_id = :'U'), 'dopo la conferma l''invito si accetta');

-- ── 5. Scadenza e revoca ───────────────────────────────────────────────────
:as_a
select public.org_create_invitation(:'org_a', 'xenia@altrove.test', 'member') as inv_x \gset
:as_postgres
update public.organization_invitations set expires_at = now() - interval '1 minute' where id = (:'inv_x'::jsonb ->> 'id')::uuid;
:as_x
select public.__expect_error(format($$select public.accept_team_invitation(%L)$$, :'inv_x'::jsonb ->> 'token'), array['P0001'], 'invito scaduto rifiutato');
select public.__expect((public.team_invitation_preview(:'inv_x'::jsonb ->> 'token') ->> 'status') = 'expired', 'stato scaduto');
:as_a
select public.org_create_invitation(:'org_a', 'xenia@altrove.test', 'member') as inv_x2 \gset
select public.__expect((select count(*) = 1 from public.organization_invitations where email = 'xenia@altrove.test' and status = 'revoked'), 'l''invito scaduto viene sostituito');
select public.org_revoke_invitation(:'org_a', (:'inv_x2'::jsonb ->> 'id')::uuid) \g /dev/null
:as_x
select public.__expect_error(format($$select public.accept_team_invitation(%L)$$, :'inv_x2'::jsonb ->> 'token'), array['P0001'], 'invito revocato rifiutato');
:as_a
select public.__expect_error(format($$select public.org_revoke_invitation(%L, %L)$$, :'org_a', (:'inv_x2'::jsonb ->> 'id')), array['P0002'], 'revoca ripetuta: non trovato');

-- ── 6. Limite utenti del piano (Business = 5): membri + inviti validi ──────
-- Membri: A, M, U = 3. Due inviti validi portano a 5; il sesto posto non esiste.
select public.org_create_invitation(:'org_a', 'quattro@team-a.test', 'member') \g /dev/null
select public.org_create_invitation(:'org_a', 'cinque@team-a.test', 'member') \g /dev/null
select public.__expect((public.org_members(:'org_a') -> 'seats' ->> 'used')::int = 5 and (public.org_members(:'org_a') -> 'seats' ->> 'limit')::int = 5, 'posti: 5 usati su 5');
select public.__expect_error(format($$select public.org_create_invitation(%L, 'sei@team-a.test', 'member')$$, :'org_a'), array['P0001'], 'oltre il limite del piano: invito rifiutato');

-- ── 7. Rimozione collaboratori ─────────────────────────────────────────────
:as_m
select public.__expect_error(format($$select public.org_remove_member(%L, %L)$$, :'org_a', :'U'), array['42501'], 'un membro non rimuove i colleghi');
:as_a
select public.__expect_error(format($$select public.org_remove_member(%L, %L)$$, :'org_a', :'A'), array['P0001'], 'l''admin non si rimuove da solo con questa funzione');
select public.org_remove_member(:'org_a', :'U') \g /dev/null
select public.__expect((select count(*) = 0 from public.organization_members where organization_id = :'org_a' and user_id = :'U'), 'collaboratore rimosso');
select public.__expect_error(format($$select public.org_remove_member(%L, %L)$$, :'org_a', :'U'), array['P0002'], 'rimozione di un non membro: non trovato');
:as_b
select public.__expect_error(format($$select public.org_remove_member(%L, %L)$$, :'org_a', :'M'), array['42501'], 'un''altra organizzazione non rimuove membri');
:as_postgres
select public.__expect((select count(*) = 1 from public.audit_logs where action = 'member.removed_by_admin' and organization_id = :'org_a' and actor_id = :'A'), 'audit della rimozione con autore');
-- Ultimo admin protetto anche promuovendo e rimuovendo.
update public.organization_members set role = 'organization_admin' where organization_id = :'org_a' and user_id = :'M';
:as_m
select public.org_remove_member(:'org_a', :'A') \g /dev/null
select public.__expect_error(format($$delete from public.organization_members where organization_id = %L and user_id = %L$$, :'org_a', :'M'), array['P0001'], 'l''ultimo amministratore non può lasciare l''organizzazione');

-- ── 8. Esito email registrato solo dal server ──────────────────────────────
select public.__expect_error(format($$select public.org_invitation_mark_email(%L, null)$$, (:'inv'::jsonb ->> 'id')), array['42501'], 'gli utenti non dichiarano inviate le email');
:as_service
select public.org_invitation_mark_email((:'inv'::jsonb ->> 'id')::uuid, 'not_configured') \g /dev/null
:as_postgres
select public.__expect((select email_sent_at is null and email_error = 'not_configured' from public.organization_invitations where id = :'inv_id'), 'email non configurata: nessun invio dichiarato');

select private.billing_set_enforcement(false) \g /dev/null
\echo 'Tutti i test Inviti collaboratori sono passati.'
