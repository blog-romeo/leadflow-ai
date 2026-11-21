-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 13 (richiesta del titolare): beta gratuita, assistenza clienti via chat,
-- cancellazione self-service di account e organizzazione. Migrazione ADDITIVA.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Beta gratuita ───────────────────────────────────────────────────────
-- Piano a costo zero NON in vendita (is_active = false: non compare nei prezzi né nel Checkout).
-- Limiti contenuti: i crediti AI restano un tetto di spesa reale per la piattaforma.
insert into public.billing_plans (code, name, description, price_cents, monthly_leads, monthly_ai_credits, max_users, features, is_active, sort_order)
values ('beta', 'Beta gratuita', 'Accesso gratuito durante la beta: Lead Finder, Analyzer, AI Sales Agent e CRM avanzato, con limiti mensili.',
        0, 100, 200, 3, array['lead_finder', 'ai_analyzer', 'ai_sales_agent', 'crm_advanced', 'export'], false, 5)
on conflict (code) do nothing;

alter table public.billing_settings add column if not exists free_beta_enabled boolean not null default false;

-- Concede il piano beta a un'organizzazione senza abbonamento che dà accesso (nessun pagamento, nessuno Stripe).
create or replace function private.grant_free_beta(p_org uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.organization_subscriptions where organization_id = p_org and status in ('active', 'trialing', 'past_due')) then
    return false;
  end if;
  insert into public.organization_subscriptions (organization_id, source, plan_code, status, started_at)
  values (p_org, 'manual', 'beta', 'active', now());
  return true;
end $$;

create or replace function private.organizations_free_beta()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select free_beta_enabled from public.billing_settings where id), false) then
    perform private.grant_free_beta(new.id);
  end if;
  return new;
end $$;
create trigger organizations_free_beta after insert on public.organizations
  for each row execute function private.organizations_free_beta();

-- Attivazione dal Super Admin (con motivazione e audit); facoltativamente concede la beta alle organizzazioni esistenti.
create or replace function public.sa_set_free_beta(p_enabled boolean, p_backfill boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int := 0; o record;
begin
  perform private.require_super_admin();
  if p_reason is null or char_length(btrim(p_reason)) < 10 then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.billing_settings set free_beta_enabled = p_enabled, updated_by = auth.uid() where id;
  if p_enabled and coalesce(p_backfill, false) then
    for o in select id from public.organizations where deleted_at is null loop
      if private.grant_free_beta(o.id) then n := n + 1; end if;
    end loop;
  end if;
  perform private.admin_audit('super_admin', 'billing.free_beta_set', 'settings', 'free_beta', p_reason, jsonb_build_object('enabled', p_enabled, 'granted', n));
  return jsonb_build_object('enabled', p_enabled, 'granted', n);
end $$;

revoke all on function private.grant_free_beta(uuid), private.organizations_free_beta() from public, anon, authenticated;
revoke all on function public.sa_set_free_beta(boolean, boolean, text) from public, anon;
grant execute on function public.sa_set_free_beta(boolean, boolean, text) to authenticated, service_role;

-- ─── 2. Assistenza via chat ────────────────────────────────────────────────
-- Nessuna tabella nuova: la chat non memorizza le conversazioni. In app l'utente può inviare la
-- trascrizione come ticket con public.support_create_ticket (esistente), solo dopo conferma esplicita.
-- I limiti di frequenza usano public.public_rate_limit (bucket support_chat*).

-- ─── 3. Cancellazione di account e organizzazione (REL-47) ─────────────────
-- Organizzazione: disattivazione immediata (deleted_at → l'accesso cessa: is_org_member la esclude),
-- eliminazione definitiva dopo 30 giorni dal job di conservazione. Le organizzazioni con fatture
-- registrate NON vengono eliminate fisicamente (obblighi di conservazione fiscale: decisione legale
-- aperta, REL-3): restano disattivate e compaiono nel report della purge.

-- protect_last_admin: un'organizzazione GIÀ disattivata (deleted_at) non ha più bisogno di un
-- amministratore, altrimenti l'unico membro non potrebbe mai cancellare il proprio account
-- (e l'eliminazione dell'utente in Supabase Auth fallirebbe per la cascata sulle membership).
create or replace function private.protect_last_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'organization_admin'
     and (tg_op = 'DELETE' or new.role <> 'organization_admin')
     and exists (select 1 from public.organizations where id = old.organization_id and deleted_at is null)
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

-- Abbonamento a pagamento ancora attivo (Stripe): va disdetto prima della cancellazione.
create or replace function private.org_has_paid_subscription(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organization_subscriptions s
                  where s.organization_id = p_org and s.source = 'stripe'
                    and s.status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused')
                    and s.ended_at is null);
$$;

create or replace function private.soft_delete_organization(p_org uuid, p_actor uuid, p_reason text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz := now();
begin
  update public.organizations set deleted_at = v_at where id = p_org and deleted_at is null;
  if not found then raise exception 'organization_not_found' using errcode = 'P0002'; end if;
  -- Il piano beta/manuale non deve restare attivo su un'organizzazione disattivata.
  update public.organization_subscriptions set status = 'canceled', canceled_at = v_at, ended_at = v_at
   where organization_id = p_org and source = 'manual' and status in ('active', 'trialing');
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org, p_actor, 'organization.deletion_requested', 'organization', p_org::text,
          jsonb_build_object('reason', p_reason, 'purge_after', v_at + interval '30 days'));
  return v_at;
end $$;

-- Stato per la UI: cosa succede alle organizzazioni dell'utente se cancella l'account.
create or replace function public.account_deletion_preflight()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return jsonb_build_object(
    'is_super_admin', private.is_super_admin(),
    'is_reseller_admin', exists (select 1 from public.reseller_members where user_id = v_uid and role = 'reseller_admin'),
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'role', m.role,
        'other_members', (select count(*) from public.organization_members x where x.organization_id = o.id and x.user_id <> v_uid),
        'other_admins', (select count(*) from public.organization_members x where x.organization_id = o.id and x.user_id <> v_uid and x.role = 'organization_admin'),
        'paid_subscription', private.org_has_paid_subscription(o.id)) order by o.name)
      from public.organization_members m join public.organizations o on o.id = m.organization_id
      where m.user_id = v_uid and o.deleted_at is null), '[]'::jsonb));
end $$;

-- Cancellazione dell'account (dati applicativi). La function Netlify /api/account/delete la chiama
-- con il JWT dell'utente e poi elimina l'utente di Supabase Auth con la service role.
-- p_confirm deve essere l'email dell'account. Le organizzazioni in cui l'utente è l'unico membro
-- vengono disattivate (stessa procedura della cancellazione dell'organizzazione).
create or replace function public.account_delete_self(p_confirm text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  o record;
  n_orgs int := 0;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select email into v_email from public.profiles where id = v_uid;
  if v_email is null or lower(btrim(coalesce(p_confirm, ''))) <> lower(v_email) then raise exception 'confirmation_mismatch' using errcode = '22023'; end if;
  if private.is_super_admin() then raise exception 'super_admin_cannot_self_delete' using errcode = 'P0001'; end if;
  if exists (select 1 from public.reseller_members where user_id = v_uid and role = 'reseller_admin') then
    raise exception 'reseller_admin_cannot_self_delete' using errcode = 'P0001';
  end if;
  for o in
    select m.organization_id as id, m.role,
           (select count(*) from public.organization_members x where x.organization_id = m.organization_id and x.user_id <> v_uid) as others,
           (select count(*) from public.organization_members x where x.organization_id = m.organization_id and x.user_id <> v_uid and x.role = 'organization_admin') as other_admins
      from public.organization_members m join public.organizations g on g.id = m.organization_id
     where m.user_id = v_uid and g.deleted_at is null
     for update of m
  loop
    if o.others = 0 then
      if private.org_has_paid_subscription(o.id) then raise exception 'paid_subscription_active' using errcode = 'P0001'; end if;
    elsif o.role = 'organization_admin' and o.other_admins = 0 then
      raise exception 'last_admin' using errcode = 'P0001';
    end if;
  end loop;
  for o in
    select m.organization_id as id,
           (select count(*) from public.organization_members x where x.organization_id = m.organization_id and x.user_id <> v_uid) as others
      from public.organization_members m join public.organizations g on g.id = m.organization_id
     where m.user_id = v_uid and g.deleted_at is null
  loop
    if o.others = 0 then
      perform private.soft_delete_organization(o.id, v_uid, 'account_deleted_sole_member');
      n_orgs := n_orgs + 1;
    end if;
    insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
    values (o.id, v_uid, 'member.account_deleted', 'user', v_uid::text, '{}'::jsonb);
  end loop;
  delete from public.organization_members where user_id = v_uid;
  update public.profiles set full_name = null where id = v_uid;
  return jsonb_build_object('ok', true, 'organizations_deactivated', n_orgs);
end $$;

-- Richiesta di cancellazione dell'organizzazione da parte di un amministratore (nome per conferma).
create or replace function public.organization_request_deletion(p_org uuid, p_confirm_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text; v_at timestamptz;
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select name into v_name from public.organizations where id = p_org and deleted_at is null for update;
  if v_name is null then raise exception 'organization_not_found' using errcode = 'P0002'; end if;
  if lower(btrim(coalesce(p_confirm_name, ''))) <> lower(btrim(v_name)) then raise exception 'confirmation_mismatch' using errcode = '22023'; end if;
  if private.org_has_paid_subscription(p_org) then raise exception 'paid_subscription_active' using errcode = 'P0001'; end if;
  v_at := private.soft_delete_organization(p_org, auth.uid(), 'admin_request');
  return jsonb_build_object('deleted_at', v_at, 'purge_after', v_at + interval '30 days');
end $$;

-- Eliminazione definitiva (dopo 30 giorni). Una organizzazione alla volta: un errore non blocca le altre.
create or replace function private.purge_deleted_organizations()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o record; n int := 0; kept int := 0; failed int := 0;
begin
  for o in select id from public.organizations where deleted_at is not null and deleted_at < now() - interval '30 days' loop
    if exists (select 1 from public.billing_invoices where organization_id = o.id) then
      kept := kept + 1;
      continue;
    end if;
    begin
      delete from public.organizations where id = o.id;
      insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
      values (null, null, 'organization.purged', 'organization', o.id::text, '{}'::jsonb);
      n := n + 1;
    exception when others then
      failed := failed + 1;
    end;
  end loop;
  return jsonb_build_object('purged', n, 'kept_fiscal', kept, 'failed', failed);
end $$;

create or replace function public.run_retention_purge()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record;
  orgs jsonb;
begin
  select * into r from private.purge_expired_data();
  orgs := private.purge_deleted_organizations();
  return jsonb_build_object('purged_soft_deleted', r.purged_soft_deleted, 'purged_retention', r.purged_retention,
    'organizations', orgs, 'ran_at', now());
end $$;

revoke all on function private.org_has_paid_subscription(uuid), private.soft_delete_organization(uuid, uuid, text),
  private.purge_deleted_organizations() from public, anon, authenticated;
revoke all on function public.account_deletion_preflight(), public.account_delete_self(text),
  public.organization_request_deletion(uuid, text) from public, anon;
grant execute on function public.account_deletion_preflight(), public.account_delete_self(text),
  public.organization_request_deletion(uuid, text) to authenticated;
revoke all on function public.run_retention_purge() from public, anon, authenticated;
grant execute on function public.run_retention_purge() to service_role;
