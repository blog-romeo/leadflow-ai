-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Migrazione 0002: autorizzazioni, RLS, trigger di sicurezza, RPC
--
-- Modello dei ruoli
--   • profiles.platform_role = 'super_admin'  → operatore della piattaforma.
--     Vede organizzazioni, membri, abbonamenti, consumi e audit log, ma NON i
--     dati commerciali dei tenant (lead, campagne, attività…): privacy by design.
--     Si assegna solo via SQL con service role (vedi README).
--   • organization_members.role = 'organization_admin' → gestisce la propria org.
--   • organization_members.role = 'member' → opera sui dati della propria org.
--
-- Tabelle "server-only" (ai_jobs, lead_analyses, subscriptions, usage_events,
-- audit_logs): leggibili secondo ruolo, scrivibili solo con service role dalle
-- Netlify Functions (che bypassano RLS) o da trigger security definer.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Schema privato per le funzioni helper (non esposto da PostgREST) ──────
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.platform_role = 'super_admin'
  );
$$;

create or replace function private.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and o.deleted_at is null
  );
$$;

create or replace function private.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = 'organization_admin'
      and o.deleted_at is null
  );
$$;

-- true se l'utente corrente condivide almeno un'organizzazione con p_user
create or replace function private.shares_org_with(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members a
    join public.organization_members b on b.organization_id = a.organization_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  );
$$;

revoke all on all functions in schema private from public;
grant execute on function private.is_super_admin(), private.is_org_member(uuid),
  private.is_org_admin(uuid), private.shares_org_with(uuid) to authenticated, service_role;

-- ─── Profilo automatico alla registrazione ─────────────────────────────────
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ─── Autore dei record impostato dal server, non dal client ───────────────
create or replace function private.set_created_by()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end $$;

create trigger lead_sources_created_by before insert on public.lead_sources for each row execute function private.set_created_by();
create trigger leads_created_by before insert on public.leads for each row execute function private.set_created_by();
create trigger campaigns_created_by before insert on public.campaigns for each row execute function private.set_created_by();
create trigger activities_created_by before insert on public.activities for each row execute function private.set_created_by();
create trigger appointments_created_by before insert on public.appointments for each row execute function private.set_created_by();
create trigger contact_suppressions_created_by before insert on public.contact_suppressions for each row execute function private.set_created_by();

-- ─── Audit log (append-only, scritto da trigger security definer) ──────────
create or replace function private.write_audit(
  p_org uuid, p_action text, p_entity_type text, p_entity_id text, p_metadata jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org, auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;
revoke all on function private.write_audit(uuid, text, text, text, jsonb) from public;

create or replace function private.audit_leads()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.organization_id, 'lead.created', 'lead', new.id::text,
      jsonb_build_object('source_id', new.source_id));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform private.write_audit(new.organization_id, 'lead.status_changed', 'lead', new.id::text,
        jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.contact_status is distinct from old.contact_status then
      perform private.write_audit(new.organization_id, 'lead.contact_status_changed', 'lead', new.id::text,
        jsonb_build_object('from', old.contact_status, 'to', new.contact_status));
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      perform private.write_audit(new.organization_id, 'lead.soft_deleted', 'lead', new.id::text);
    end if;
    return new;
  else
    perform private.write_audit(old.organization_id, 'lead.deleted', 'lead', old.id::text);
    return old;
  end if;
end $$;
create trigger leads_audit after insert or update or delete on public.leads
  for each row execute function private.audit_leads();

create or replace function private.audit_members()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.organization_id, 'member.added', 'organization_member', new.user_id::text,
      jsonb_build_object('role', new.role));
    return new;
  elsif tg_op = 'UPDATE' then
    perform private.write_audit(new.organization_id, 'member.role_changed', 'organization_member', new.user_id::text,
      jsonb_build_object('from', old.role, 'to', new.role));
    return new;
  else
    -- In caso di cancellazione a cascata dell'organizzazione non scriviamo log orfani.
    if exists (select 1 from public.organizations where id = old.organization_id) then
      perform private.write_audit(old.organization_id, 'member.removed', 'organization_member', old.user_id::text);
    end if;
    return old;
  end if;
end $$;
create trigger organization_members_audit after insert or update or delete on public.organization_members
  for each row execute function private.audit_members();

create or replace function private.audit_organizations()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(new.id, 'organization.updated', 'organization', new.id::text,
    jsonb_build_object('changed', (
      select coalesce(jsonb_agg(k), '[]'::jsonb)
      from jsonb_each(to_jsonb(new)) n(k, v)
      where k not in ('updated_at') and (to_jsonb(old) -> k) is distinct from v
    )));
  return new;
end $$;
create trigger organizations_audit after update on public.organizations
  for each row execute function private.audit_organizations();

-- ─── Protezione: almeno un organization_admin per organizzazione ──────────
create or replace function private.protect_last_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'organization_admin'
     and (tg_op = 'DELETE' or new.role <> 'organization_admin')
     and exists (select 1 from public.organizations where id = old.organization_id)
     and not exists (
       select 1 from public.organization_members
       where organization_id = old.organization_id
         and role = 'organization_admin'
         and user_id <> old.user_id
     )
  then
    raise exception 'last_admin: an organization must keep at least one organization_admin' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and (new.organization_id <> old.organization_id or new.user_id <> old.user_id) then
    raise exception 'membership keys are immutable' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger organization_members_protect before update or delete on public.organization_members
  for each row execute function private.protect_last_admin();

-- ─── Opposizione e soppressione dei contatti ──────────────────────────────
create or replace function private.email_hash(p_email text)
returns text language sql immutable set search_path = '' as $$
  select case when p_email is null or btrim(p_email) = '' then null
    else encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex') end;
$$;
grant execute on function private.email_hash(text) to authenticated, service_role;

create or replace function private.leads_contact_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
begin
  -- 1. Un contatto presente nella suppression list non può essere (re)inserito.
  if new.email is not null and (tg_op = 'INSERT' or new.email is distinct from old.email) then
    v_hash := private.email_hash(new.email);
    if exists (select 1 from public.contact_suppressions s
               where s.organization_id = new.organization_id and s.email_hash = v_hash) then
      raise exception 'contact_suppressed: this contact asked not to be processed' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.contact_status <> 'active' then
      raise exception 'new leads must start as active contacts' using errcode = '22023';
    end if;
    return new;
  end if;

  -- 2. La soppressione è definitiva e i dati personali restano vuoti.
  if old.contact_status = 'suppressed' then
    if new.contact_status <> 'suppressed'
       or new.email is not null or new.phone is not null or new.contact_name is not null then
      raise exception 'suppressed contacts cannot be restored' using errcode = 'P0001';
    end if;
  end if;

  -- 3. Revoca dell'opposizione consentita solo agli organization_admin.
  if old.contact_status = 'opted_out' and new.contact_status = 'active'
     and auth.uid() is not null and not private.is_org_admin(new.organization_id) then
    raise exception 'only organization admins can revert an opt-out' using errcode = '42501';
  end if;

  if new.contact_status = 'opted_out' and old.contact_status <> 'opted_out' then
    new.opted_out_at := now();
    if new.email is not null then
      insert into public.contact_suppressions (organization_id, email_hash, reason, created_by)
      values (new.organization_id, private.email_hash(new.email), 'opt_out', auth.uid())
      on conflict (organization_id, email_hash) do nothing;
    end if;
  elsif new.contact_status = 'active' and old.contact_status = 'opted_out' then
    new.opted_out_at := null;
    delete from public.contact_suppressions
     where organization_id = new.organization_id
       and email_hash = private.email_hash(new.email)
       and reason = 'opt_out';
  end if;
  return new;
end $$;
create trigger leads_contact_guard before insert or update on public.leads
  for each row execute function private.leads_contact_guard();

-- RPC: cancellazione dei dati personali di un contatto (diritto all'oblio).
-- Security invoker: RLS si applica, quindi funziona solo su lead della propria org.
create or replace function public.suppress_lead(p_lead_id uuid, p_reason text default 'erasure_request')
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_lead public.leads;
begin
  if p_reason not in ('opt_out', 'erasure_request', 'bounce', 'manual') then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_lead.email is not null then
    insert into public.contact_suppressions (organization_id, email_hash, reason)
    values (v_lead.organization_id, private.email_hash(v_lead.email), p_reason)
    on conflict (organization_id, email_hash) do nothing;
  end if;
  update public.leads
     set contact_name = null, contact_role = null, email = null, phone = null, notes = null,
         contact_status = 'suppressed', suppressed_at = now()
   where id = p_lead_id;
end $$;
revoke all on function public.suppress_lead(uuid, text) from public, anon;
grant execute on function public.suppress_lead(uuid, text) to authenticated;

-- ─── RPC: creazione organizzazione dopo la registrazione ───────────────────
create or replace function public.create_organization(
  p_name text,
  p_vat_number text default null,
  p_country text default 'IT'
) returns public.organizations
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organizations;
  v_name text := btrim(coalesce(p_name, ''));
  v_vat text := nullif(upper(regexp_replace(coalesce(p_vat_number, ''), '\s', '', 'g')), '');
  v_country text := upper(coalesce(nullif(btrim(p_country), ''), 'IT'));
  v_base text;
  v_slug text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if char_length(v_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if v_vat is not null and v_vat !~ '^([A-Z]{2})?[0-9A-Z]{8,15}$' then
    raise exception 'invalid_vat_number' using errcode = '22023';
  end if;
  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'invalid_country' using errcode = '22023';
  end if;
  if (select count(*) from public.organization_members
      where user_id = v_uid and role = 'organization_admin') >= 5 then
    raise exception 'organization_limit_reached' using errcode = 'P0001';
  end if;

  -- Garantisce il profilo (es. utenti creati prima del trigger).
  insert into public.profiles (id, email)
  select u.id, coalesce(u.email, '') from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  v_base := trim(both '-' from left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 40));
  if char_length(v_base) < 2 then v_base := 'org'; end if;
  v_slug := v_base || '-' || substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 6);

  insert into public.organizations (name, slug, vat_number, country, created_by)
  values (v_name, v_slug, v_vat, v_country, v_uid)
  returning * into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org.id, v_uid, 'organization_admin');

  perform private.write_audit(v_org.id, 'organization.created', 'organization', v_org.id::text,
    jsonb_build_object('name', v_name));

  return v_org;
end $$;
revoke all on function public.create_organization(text, text, text) from public, anon;
grant execute on function public.create_organization(text, text, text) to authenticated;

-- ─── Retention: pulizia periodica (solo service role / pg_cron) ────────────
create or replace function private.purge_expired_data()
returns table (purged_soft_deleted bigint, purged_retention bigint)
language plpgsql security definer set search_path = '' as $$
declare
  a bigint; b bigint;
begin
  delete from public.leads where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics a = row_count;
  delete from public.leads l
   using public.organizations o
   where o.id = l.organization_id
     and coalesce(l.last_activity_at, l.updated_at) < now() - make_interval(days => o.data_retention_days);
  get diagnostics b = row_count;
  return query select a, b;
end $$;
revoke all on function private.purge_expired_data() from public, authenticated;
grant execute on function private.purge_expired_data() to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- Privilegi di tabella (difesa in profondità oltre a RLS)
-- ════════════════════════════════════════════════════════════════════════════
-- TRUNCATE/REFERENCES/TRIGGER non sono soggetti a RLS: li revochiamo ai ruoli client.
revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- Tabelle scritte solo dal server.
revoke insert, update, delete on public.ai_jobs, public.lead_analyses, public.subscriptions,
  public.usage_events, public.audit_logs from authenticated;

-- Colonne modificabili dai client.
revoke insert, update, delete on public.profiles from authenticated;
grant update (full_name, locale) on public.profiles to authenticated;

revoke insert, update, delete on public.organizations from authenticated;
grant update (name, vat_number, country, data_retention_days) on public.organizations to authenticated;

revoke insert on public.organization_members from authenticated;   -- inviti: fase successiva, lato server
revoke update on public.organization_members from authenticated;
grant update (role) on public.organization_members to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ════════════════════════════════════════════════════════════════════════════
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.lead_sources enable row level security;
alter table public.leads enable row level security;
alter table public.contact_suppressions enable row level security;
alter table public.lead_analyses enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_leads enable row level security;
alter table public.activities enable row level security;
alter table public.appointments enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;
alter table public.audit_logs enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_org_with(id) or private.is_super_admin());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- organizations
create policy organizations_select on public.organizations for select to authenticated
  using (private.is_org_member(id) or private.is_super_admin());
create policy organizations_update_admin on public.organizations for update to authenticated
  using (private.is_org_admin(id)) with check (private.is_org_admin(id));

-- organization_members
create policy members_select on public.organization_members for select to authenticated
  using (private.is_org_member(organization_id) or private.is_super_admin());
create policy members_update_admin on public.organization_members for update to authenticated
  using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
create policy members_delete on public.organization_members for delete to authenticated
  using (private.is_org_admin(organization_id) or user_id = (select auth.uid()));

-- Dati commerciali: lettura/scrittura per i membri, cancellazione per gli admin.
-- Il super_admin NON ha accesso a queste tabelle.
do $$
declare t text;
begin
  foreach t in array array['lead_sources', 'leads', 'campaigns', 'campaign_leads', 'activities', 'appointments']
  loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (private.is_org_member(organization_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (private.is_org_member(organization_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (private.is_org_member(organization_id)) with check (private.is_org_member(organization_id))', t);
    execute format('create policy %1$s_delete on public.%1$I for delete to authenticated using (private.is_org_admin(organization_id))', t);
  end loop;
end $$;

-- contact_suppressions: i membri leggono e aggiungono; solo gli admin rimuovono.
create policy suppressions_select on public.contact_suppressions for select to authenticated
  using (private.is_org_member(organization_id));
create policy suppressions_insert on public.contact_suppressions for insert to authenticated
  with check (private.is_org_member(organization_id));
create policy suppressions_delete on public.contact_suppressions for delete to authenticated
  using (private.is_org_admin(organization_id));
revoke update on public.contact_suppressions from authenticated;

-- Output AI: sola lettura per i membri.
create policy lead_analyses_select on public.lead_analyses for select to authenticated
  using (private.is_org_member(organization_id));
create policy ai_jobs_select on public.ai_jobs for select to authenticated
  using (private.is_org_member(organization_id));

-- Billing e consumi: admin dell'org e super_admin.
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (private.is_org_admin(organization_id) or private.is_super_admin());
create policy usage_events_select on public.usage_events for select to authenticated
  using (private.is_org_admin(organization_id) or private.is_super_admin());

-- Audit: admin dell'org e super_admin.
create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((organization_id is not null and private.is_org_admin(organization_id)) or private.is_super_admin());
