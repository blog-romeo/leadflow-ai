-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 7: inviti dei collaboratori (organization_invitations)
--
-- • Solo un organization_admin invita, revoca o rimuove collaboratori.
-- • Token casuale (192 bit) restituito UNA volta; nel database solo l'hash SHA-256.
-- • Monouso, scadenza 7 giorni, legato all'email invitata (confermata) dell'utente che accetta.
-- • Limite utenti del piano: membri attivi + inviti validi ≤ max_users (con enforcement attivo).
-- • Ogni operazione scrive in audit_logs (senza token e con il solo dominio dell'email).
-- • Nessuno può aggiungersi da solo: INSERT su organization_members resta revocato agli utenti.
-- Migrazione additiva: non elimina tabelle né dati.
-- ════════════════════════════════════════════════════════════════════════════

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$' and char_length(email) <= 254),
  role public.org_role not null default 'member',
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  -- Esito dell'email di invito: valorizzato SOLO dal server dopo un invio riuscito o fallito.
  email_sent_at timestamptz,
  email_error text check (email_error is null or char_length(email_error) <= 60),
  check (status <> 'accepted' or (accepted_at is not null and accepted_by is not null)),
  check (status <> 'revoked' or revoked_at is not null)
);
create index organization_invitations_org_idx on public.organization_invitations (organization_id, status, created_at desc);
create unique index organization_invitations_pending_uidx on public.organization_invitations (organization_id, email) where status = 'pending';
create trigger organization_invitations_org_immutable before update on public.organization_invitations
  for each row execute function public.prevent_org_change();

-- Membri attivi + inviti in attesa non scaduti: base del controllo sul limite utenti.
create or replace function private.org_seats_used(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.organization_members where organization_id = p_org)::int
       + (select count(*) from public.organization_invitations where organization_id = p_org and status = 'pending' and expires_at > now())::int;
$$;

create or replace function public.org_create_invitation(p_org uuid, p_email text, p_role public.org_role default 'member')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_expires timestamptz := now() + interval '7 days';
  v_limit int;
  v_used int;
  v_id uuid;
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.rate_limit('team_invitation', 10);
  if v_email !~ '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$' or char_length(v_email) > 254 then raise exception 'invalid_email' using errcode = '22023'; end if;
  if (select admin_status from public.organizations where id = p_org) = 'suspended' then raise exception 'organization_suspended' using errcode = 'P0001'; end if;
  if exists (select 1 from public.organization_members m join auth.users u on u.id = m.user_id
              where m.organization_id = p_org and lower(u.email) = v_email) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;
  -- Stesso lock del trigger sul limite membri: niente corse tra inviti e accettazioni.
  perform pg_advisory_xact_lock(hashtextextended('members:' || p_org::text, 0));
  -- Un invito scaduto per la stessa email viene sostituito; uno valido va revocato esplicitamente.
  update public.organization_invitations set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
   where organization_id = p_org and email = v_email and status = 'pending' and expires_at <= now();
  if exists (select 1 from public.organization_invitations where organization_id = p_org and email = v_email and status = 'pending') then
    raise exception 'invitation_already_pending' using errcode = 'P0001';
  end if;
  if coalesce((select enforcement_enabled from public.billing_settings where id), true) then
    v_limit := (private.org_entitlements(p_org) ->> 'max_users')::int;
    v_used := private.org_seats_used(p_org);
    if v_used >= v_limit then
      raise exception 'billing_user_limit_reached' using errcode = 'P0001',
        detail = jsonb_build_object('limit', v_limit, 'used', v_used)::text;
    end if;
  end if;
  insert into public.organization_invitations (organization_id, email, role, token_hash, expires_at, created_by)
  values (p_org, v_email, coalesce(p_role, 'member'), encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expires, auth.uid())
  returning id into v_id;
  perform private.write_audit(p_org, 'invitation.created', 'organization_invitation', v_id::text,
    jsonb_build_object('role', coalesce(p_role, 'member'), 'email_domain', split_part(v_email, '@', 2)));
  -- Il token in chiaro esce SOLO qui, una volta: serve a costruire il link di invito.
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires, 'email', v_email, 'role', coalesce(p_role, 'member'));
end $$;

create or replace function public.org_revoke_invitation(p_org uuid, p_invitation uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.rate_limit('team_invitation', 10);
  update public.organization_invitations set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
   where id = p_invitation and organization_id = p_org and status = 'pending';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.write_audit(p_org, 'invitation.revoked', 'organization_invitation', p_invitation::text);
end $$;

-- Elenco per gli admin: mai il token o il suo hash.
create or replace function public.org_invitations(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at, 'expires_at', i.expires_at,
      'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
      'email_sent_at', i.email_sent_at, 'email_error', i.email_error,
      'invited_by', (select full_name from public.profiles where id = i.created_by)) order by i.created_at desc)
    from (select * from public.organization_invitations where organization_id = p_org order by created_at desc limit 100) i), '[]'::jsonb);
end $$;

-- Membri con nome ed email, visibili ai membri della stessa organizzazione.
create or replace function public.org_members(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e jsonb;
begin
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  e := private.org_entitlements(p_org);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'joined_at', m.created_at,
        'full_name', p.full_name, 'email', u.email, 'is_me', m.user_id = auth.uid()) order by m.created_at)
      from public.organization_members m left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id
      where m.organization_id = p_org), '[]'::jsonb),
    'seats', jsonb_build_object('limit', (e ->> 'max_users')::int, 'used', private.org_seats_used(p_org),
      'enforced', coalesce((select enforcement_enabled from public.billing_settings where id), true)));
end $$;

create or replace function public.org_remove_member(p_org uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.rate_limit('team_invitation', 10);
  if p_user = auth.uid() then raise exception 'cannot_remove_self' using errcode = 'P0001'; end if;
  -- Il trigger protect_last_admin impedisce di lasciare l'organizzazione senza amministratori.
  delete from public.organization_members where organization_id = p_org and user_id = p_user;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.write_audit(p_org, 'member.removed_by_admin', 'organization_member', p_user::text);
end $$;

-- Anteprima per l'invitato: solo se l'email dell'utente autenticato coincide con quella invitata.
create or replace function public.team_invitation_preview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  i public.organization_invitations;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into i from public.organization_invitations where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  -- Stesso errore per token inesistente ed email diversa: nessuna enumerazione.
  if i.id is null or i.email <> lower((select email from auth.users where id = auth.uid())) then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('organization_name', (select name from public.organizations where id = i.organization_id),
    'role', i.role, 'expires_at', i.expires_at,
    'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
    'invited_by', (select full_name from public.profiles where id = i.created_by),
    'email_confirmed', (select email_confirmed_at is not null from auth.users where id = auth.uid()));
end $$;

create or replace function public.accept_team_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.organization_invitations;
  u record;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform private.rate_limit('invitation_accept', 10);
  select * into i from public.organization_invitations where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  select email, email_confirmed_at into u from auth.users where id = auth.uid();
  if i.id is null or i.email <> lower(u.email) then raise exception 'invitation_not_found' using errcode = 'P0002'; end if;
  -- Verifica dell'identità: l'email dell'account deve essere confermata.
  if u.email_confirmed_at is null then raise exception 'email_not_confirmed' using errcode = 'P0001'; end if;
  if i.status <> 'pending' then raise exception 'invitation_not_pending' using errcode = 'P0001'; end if;
  if i.expires_at <= now() then raise exception 'invitation_expired' using errcode = 'P0001'; end if;
  if (select admin_status from public.organizations where id = i.organization_id) = 'suspended' then raise exception 'organization_suspended' using errcode = 'P0001'; end if;
  if exists (select 1 from public.organization_members where organization_id = i.organization_id and user_id = auth.uid()) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;
  -- Monouso: l'invito diventa "accepted" nella stessa transazione dell'inserimento.
  update public.organization_invitations set status = 'accepted', accepted_at = now(), accepted_by = auth.uid() where id = i.id;
  -- Il trigger members_billing_limit ricontrolla il limite utenti del piano (l'invito era già conteggiato).
  insert into public.organization_members (organization_id, user_id, role) values (i.organization_id, auth.uid(), i.role);
  perform private.write_audit(i.organization_id, 'invitation.accepted', 'organization_invitation', i.id::text, jsonb_build_object('role', i.role));
  return i.organization_id;
end $$;

-- Esito dell'invio email (solo server): non si dichiara mai inviata un'email non partita.
create or replace function public.org_invitation_mark_email(p_invitation uuid, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.organization_invitations
     set email_sent_at = case when p_error is null then now() end, email_error = left(p_error, 60)
   where id = p_invitation;
$$;

-- ─── Privilegi e RLS ────────────────────────────────────────────────────────
alter table public.organization_invitations enable row level security;
revoke all on public.organization_invitations from anon;
revoke insert, update, delete, truncate, references, trigger on public.organization_invitations from authenticated;
-- Lettura diretta solo agli admin (senza esporre token: l'hash non permette di ricostruirlo).
revoke select on public.organization_invitations from authenticated;
grant select (id, organization_id, email, role, status, expires_at, created_at, accepted_at, revoked_at, email_sent_at, email_error)
  on public.organization_invitations to authenticated;
create policy organization_invitations_select on public.organization_invitations for select to authenticated
  using (private.is_org_admin(organization_id) or private.is_super_admin());

revoke all on function public.org_create_invitation(uuid, text, public.org_role), public.org_revoke_invitation(uuid, uuid),
  public.org_invitations(uuid), public.org_members(uuid), public.org_remove_member(uuid, uuid),
  public.team_invitation_preview(text), public.accept_team_invitation(text) from public, anon;
grant execute on function public.org_create_invitation(uuid, text, public.org_role), public.org_revoke_invitation(uuid, uuid),
  public.org_invitations(uuid), public.org_members(uuid), public.org_remove_member(uuid, uuid),
  public.team_invitation_preview(text), public.accept_team_invitation(text) to authenticated;
revoke all on function public.org_invitation_mark_email(uuid, text) from public, anon, authenticated;
grant execute on function public.org_invitation_mark_email(uuid, text) to service_role;
revoke all on function private.org_seats_used(uuid) from public, anon, authenticated;
