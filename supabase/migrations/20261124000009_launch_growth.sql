-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 6: Production launch, onboarding, support & growth
--
-- • onboarding_progress      avanzamento dell'onboarding guidato (ripristinabile)
-- • demo_requests            richieste di demo dal sito pubblico (scritte solo dal server)
-- • public_rate_limits       limiti di frequenza per endpoint pubblici (chiave = hash, nessun IP in chiaro)
-- • support_tickets / support_ticket_messages   centro assistenza
-- • funnel_events            eventi del funnel, deduplicati per chiave (nessun dato personale)
-- • app_errors               errori applicativi aggregati per impronta (messaggi sanificati)
-- • monitoring_alerts        avvisi di monitoraggio deduplicati per giorno
-- Non elimina tabelle né dati.
-- ════════════════════════════════════════════════════════════════════════════

-- L'assistente di onboarding registra il proprio consumo come job AI (task nullo: nessun credito
-- commerciale), così costi, tetti di spesa e sospensioni del Control Center valgono anche per lui.
alter type public.ai_job_type add value if not exists 'support_assistant';

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Onboarding guidato
-- ════════════════════════════════════════════════════════════════════════════
create table public.onboarding_progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  -- 1 account · 2 azienda · 3 profilo commerciale · 4 piano · 5 pagamento · 6 prima configurazione
  step smallint not null default 2 check (step between 1 and 6),
  company jsonb not null default '{}'::jsonb check (jsonb_typeof(company) = 'object'),
  commercial jsonb not null default '{}'::jsonb check (jsonb_typeof(commercial) = 'object'),
  plan_code text references public.billing_plans (code) on update cascade,
  payment_deferred boolean not null default false,
  tour_completed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger onboarding_progress_updated_at before update on public.onboarding_progress
  for each row execute function public.set_updated_at();

create or replace function private.onboarding_row()
returns public.onboarding_progress language plpgsql security definer set search_path = '' as $$
declare
  r public.onboarding_progress;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  insert into public.onboarding_progress (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  select * into r from public.onboarding_progress where user_id = auth.uid() for update;
  -- Un'organizzazione già esistente (creata prima dell'onboarding guidato o al passo 2) viene agganciata.
  if r.organization_id is null then
    update public.onboarding_progress set organization_id = (
      select m.organization_id from public.organization_members m join public.organizations o on o.id = m.organization_id
       where m.user_id = auth.uid() and m.role = 'organization_admin' and o.deleted_at is null order by m.created_at limit 1)
     where user_id = auth.uid() returning * into r;
  end if;
  return r;
end $$;

create or replace function public.onboarding_state()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.onboarding_progress;
begin
  r := private.onboarding_row();
  return to_jsonb(r) - 'user_id';
end $$;

-- Passo 2: dati aziendali aggiuntivi (l'organizzazione è creata con create_organization).
create or replace function public.onboarding_save_company(p_org uuid, p_sector text, p_website text, p_size text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.onboarding_progress;
  v_site text := nullif(btrim(coalesce(p_website, '')), '');
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_size is not null and p_size not in ('1-9', '10-49', '50-249', '250+') then raise exception 'invalid_size' using errcode = '22023'; end if;
  if v_site is not null and v_site !~* '^https?://' then v_site := 'https://' || v_site; end if;
  if v_site is not null and (v_site !~* '^https?://[a-z0-9.-]+\.[a-z]{2,}(/[^\s<>"]*)?$' or char_length(v_site) > 300) then
    raise exception 'invalid_website' using errcode = '22023';
  end if;
  if p_sector is not null and (char_length(btrim(p_sector)) > 160 or p_sector ~ '[<>]') then raise exception 'invalid_sector' using errcode = '22023'; end if;
  r := private.onboarding_row();
  update public.onboarding_progress
     set organization_id = p_org, step = greatest(step, 3),
         company = jsonb_strip_nulls(jsonb_build_object('sector', nullif(btrim(coalesce(p_sector, '')), ''), 'website', v_site, 'size', p_size))
   where user_id = auth.uid() returning * into r;
  update public.sales_profiles set sector = coalesce(nullif(btrim(coalesce(p_sector, '')), ''), sector), website = coalesce(v_site, website), updated_by = auth.uid()
   where organization_id = p_org;
  return to_jsonb(r) - 'user_id';
end $$;

-- Passo 3: profilo commerciale → profilo del Lead Finder e del Sales Agent (stesse tabelle usate dai moduli).
create or replace function public.onboarding_save_commercial(p_org uuid, p_services text, p_ideal_customer text, p_area text, p_goal text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.onboarding_progress;
  v_area text[] := array(select btrim(x) from unnest(string_to_array(coalesce(p_area, ''), ',')) x where btrim(x) <> '' limit 20);
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(coalesce(p_services, '')) > 4000 or char_length(coalesce(p_ideal_customer, '')) > 4000
     or char_length(coalesce(p_area, '')) > 600 or char_length(coalesce(p_goal, '')) > 600 then
    raise exception 'too_long' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_area) a where char_length(a) > 80) then raise exception 'invalid_area' using errcode = '22023'; end if;
  r := private.onboarding_row();
  update public.onboarding_progress
     set organization_id = p_org, step = greatest(step, 4),
         commercial = jsonb_strip_nulls(jsonb_build_object('services', nullif(btrim(coalesce(p_services, '')), ''),
           'ideal_customer', nullif(btrim(coalesce(p_ideal_customer, '')), ''), 'area', nullif(btrim(coalesce(p_area, '')), ''),
           'goal', nullif(btrim(coalesce(p_goal, '')), '')))
   where user_id = auth.uid() returning * into r;
  update public.organization_profiles
     set services_description = coalesce(nullif(btrim(coalesce(p_services, '')), ''), services_description),
         ideal_customer = coalesce(nullif(btrim(coalesce(p_ideal_customer, '')), ''), ideal_customer),
         target_regions = case when cardinality(v_area) > 0 then v_area else target_regions end,
         updated_by = auth.uid()
   where organization_id = p_org;
  update public.sales_profiles
     set offer_description = coalesce(nullif(btrim(coalesce(p_services, '')), ''), offer_description),
         ideal_customer = coalesce(nullif(btrim(coalesce(p_ideal_customer, '')), ''), ideal_customer),
         served_areas = case when cardinality(v_area) > 0 then v_area else served_areas end,
         updated_by = auth.uid()
   where organization_id = p_org;
  return to_jsonb(r) - 'user_id';
end $$;

-- Passi 4–6: piano scelto, pagamento rimandato, tour, completamento.
create or replace function public.onboarding_advance(p_action text, p_plan text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.onboarding_progress;
begin
  r := private.onboarding_row();
  if r.organization_id is null or not private.is_org_member(r.organization_id) then raise exception 'organization_required' using errcode = 'P0001'; end if;
  if p_action = 'choose_plan' then
    if not exists (select 1 from public.billing_plans where code = p_plan and is_active) then raise exception 'plan_not_found' using errcode = '22023'; end if;
    update public.onboarding_progress set plan_code = p_plan, step = greatest(step, 5) where user_id = auth.uid() returning * into r;
  elsif p_action = 'defer_payment' then
    -- Nessun abbonamento viene simulato: l'utente entra con i soli moduli gratuiti finché non paga.
    update public.onboarding_progress set payment_deferred = true, step = greatest(step, 6) where user_id = auth.uid() returning * into r;
  elsif p_action = 'payment_confirmed' then
    -- Avanza solo se l'abbonamento è davvero attivo (stato scritto dal webhook Stripe verificato).
    if not (private.org_entitlements(r.organization_id) ->> 'has_access')::boolean then raise exception 'payment_not_confirmed' using errcode = 'P0001'; end if;
    update public.onboarding_progress set payment_deferred = false, step = greatest(step, 6) where user_id = auth.uid() returning * into r;
  elsif p_action = 'tour_done' then
    update public.onboarding_progress set tour_completed_at = coalesce(tour_completed_at, now()) where user_id = auth.uid() returning * into r;
  elsif p_action = 'complete' then
    update public.onboarding_progress set completed_at = coalesce(completed_at, now()), step = 6 where user_id = auth.uid() returning * into r;
  else
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  return to_jsonb(r) - 'user_id';
end $$;

-- Checklist "primi passi" calcolata da dati reali dell'organizzazione (solo conteggi).
create or replace function public.onboarding_checklist(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'profile_completed', exists (select 1 from public.organization_profiles where organization_id = p_org and (services_description is not null or ideal_customer is not null)),
    'first_search', exists (select 1 from public.lead_searches where organization_id = p_org),
    'first_lead_saved', exists (select 1 from public.leads where organization_id = p_org and deleted_at is null),
    'first_ai_analysis', exists (select 1 from public.ai_jobs where organization_id = p_org and status = 'succeeded' and type = 'business_analysis'),
    'has_access', (private.org_entitlements(p_org) ->> 'has_access')::boolean,
    'ai_configured', null
  );
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Limiti di frequenza per endpoint pubblici (anonimi)
-- ════════════════════════════════════════════════════════════════════════════
create table public.public_rate_limits (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  bucket text not null check (char_length(bucket) between 2 and 40),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key_hash, bucket, window_start)
);
create index public_rate_limits_window_idx on public.public_rate_limits (window_start);

-- Restituisce true se la richiesta è entro il limite. La chiave è già un hash (HMAC lato server).
create or replace function public.public_rate_limit(p_key_hash text, p_bucket text, p_max integer, p_window_minutes integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / (p_window_minutes * 60)) * (p_window_minutes * 60));
  v_hits int;
begin
  insert into public.public_rate_limits as r (key_hash, bucket, window_start, hits) values (p_key_hash, p_bucket, v_window, 1)
  on conflict (key_hash, bucket, window_start) do update set hits = r.hits + 1 returning hits into v_hits;
  -- Pulizia opportunistica delle finestre vecchie.
  if random() < 0.02 then delete from public.public_rate_limits where window_start < now() - interval '2 days'; end if;
  return v_hits <= p_max;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Richieste di demo
-- ════════════════════════════════════════════════════════════════════════════
create table public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120 and name !~ '[<>]'),
  company text not null check (char_length(btrim(company)) between 2 and 160 and company !~ '[<>]'),
  email text not null check (email = lower(email) and email ~ '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$' and char_length(email) <= 254),
  phone text check (phone is null or phone ~ '^\+?[0-9 ()./-]{6,25}$'),
  sector text not null check (char_length(btrim(sector)) between 2 and 120 and sector !~ '[<>]'),
  employees text check (employees is null or employees in ('1-9', '10-49', '50-249', '250+')),
  message text not null check (char_length(btrim(message)) between 10 and 2000),
  contact_preference text not null check (contact_preference in ('email', 'phone', 'video_call')),
  locale text not null default 'it' check (locale in ('it', 'en')),
  consent_at timestamptz not null,
  -- new → contacted → scheduled → closed (spam per le richieste non valide). "scheduled" lo imposta
  -- un operatore dopo aver fissato davvero l'appuntamento: nessun calendario è collegato.
  status text not null default 'new' check (status in ('new', 'contacted', 'scheduled', 'closed', 'spam')),
  notified_at timestamptz,
  notification_error text check (notification_error is null or char_length(notification_error) <= 100),
  internal_note text check (internal_note is null or char_length(internal_note) <= 2000),
  handled_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_preference <> 'phone' or phone is not null)
);
create index demo_requests_status_idx on public.demo_requests (status, created_at desc);
create trigger demo_requests_updated_at before update on public.demo_requests for each row execute function public.set_updated_at();

create or replace function public.sa_demo_requests(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  return coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from (
    select * from public.demo_requests where p_status is null or status = p_status order by created_at desc limit 200) d), '[]'::jsonb);
end $$;

create or replace function public.sa_update_demo_request(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  perform private.rate_limit('sa_mutation', 30);
  if p_status not in ('new', 'contacted', 'scheduled', 'closed', 'spam') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.demo_requests set status = p_status, internal_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), internal_note), handled_by = auth.uid()
   where id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.admin_audit('super_admin', 'demo_request.updated', 'console', p_id::text, null, jsonb_build_object('status', p_status));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Centro assistenza: ticket
-- ════════════════════════════════════════════════════════════════════════════
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  subject text not null check (char_length(btrim(subject)) between 3 and 160),
  category text not null check (category in ('account', 'billing', 'lead_finder', 'ai', 'crm', 'campaigns', 'white_label', 'privacy', 'bug', 'other')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed')),
  customer_unread boolean not null default false,
  staff_unread boolean not null default true,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_tickets_org_idx on public.support_tickets (organization_id, last_activity_at desc);
create index support_tickets_status_idx on public.support_tickets (status, last_activity_at desc);
create trigger support_tickets_updated_at before update on public.support_tickets for each row execute function public.set_updated_at();
create trigger support_tickets_org_immutable before update on public.support_tickets for each row execute function public.prevent_org_change();

create table public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  author_role text not null check (author_role in ('customer', 'staff')),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index support_ticket_messages_ticket_idx on public.support_ticket_messages (ticket_id, created_at);

-- Chi può vedere un ticket: chi l'ha aperto e gli admin dell'organizzazione; lo staff (super admin).
create or replace function private.can_see_ticket(p_ticket uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.support_tickets t where t.id = p_ticket
                   and (t.created_by = (select auth.uid()) or private.is_org_admin(t.organization_id) or private.is_super_admin()));
$$;
grant execute on function private.can_see_ticket(uuid) to authenticated;

create or replace function public.support_create_ticket(p_org uuid, p_subject text, p_category text, p_priority text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.rate_limit('support_ticket', 5);
  insert into public.support_tickets (organization_id, created_by, subject, category, priority)
  values (p_org, auth.uid(), btrim(p_subject), p_category, coalesce(p_priority, 'normal')) returning id into v_id;
  insert into public.support_ticket_messages (ticket_id, author_id, author_role, body) values (v_id, auth.uid(), 'customer', btrim(p_body));
  return v_id;
end $$;

create or replace function public.support_reply(p_ticket uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t public.support_tickets;
  v_staff boolean := private.is_super_admin();
  v_id uuid;
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  if t.id is null or not private.can_see_ticket(p_ticket) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if t.status = 'closed' and not v_staff then raise exception 'ticket_closed' using errcode = 'P0001'; end if;
  perform private.rate_limit('support_reply', 20);
  insert into public.support_ticket_messages (ticket_id, author_id, author_role, body)
  values (p_ticket, auth.uid(), case when v_staff then 'staff' else 'customer' end, btrim(p_body)) returning id into v_id;
  update public.support_tickets set
    last_activity_at = now(),
    status = case when v_staff then 'waiting_customer' else 'waiting_staff' end,
    customer_unread = v_staff, staff_unread = not v_staff
  where id = p_ticket;
  if v_staff then
    -- Notifica in-app a chi ha aperto il ticket.
    insert into public.notifications (organization_id, user_id, title, body, link)
    values (t.organization_id, t.created_by, left('Risposta al ticket #' || t.number || ': ' || t.subject, 200), null, '/app/support?ticket=' || t.id::text);
    perform private.admin_audit('super_admin', 'support.replied', 'organization', t.organization_id::text, null, jsonb_build_object('ticket', t.number));
  end if;
  return v_id;
end $$;

create or replace function public.support_set_status(p_ticket uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t public.support_tickets;
  v_staff boolean := private.is_super_admin();
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  if t.id is null or not private.can_see_ticket(p_ticket) then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- Il cliente può solo chiudere o riaprire; lo staff può impostare qualsiasi stato.
  if not v_staff and p_status not in ('closed', 'open') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.support_tickets set status = p_status, last_activity_at = now(), customer_unread = v_staff, staff_unread = not v_staff where id = p_ticket;
  if v_staff then
    perform private.admin_audit('super_admin', 'support.status_changed', 'organization', t.organization_id::text, null, jsonb_build_object('ticket', t.number, 'status', p_status));
  end if;
end $$;

create or replace function public.support_mark_read(p_ticket uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_see_ticket(p_ticket) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if private.is_super_admin() and not exists (select 1 from public.support_tickets t where t.id = p_ticket and t.created_by = auth.uid()) then
    update public.support_tickets set staff_unread = false where id = p_ticket;
  else
    update public.support_tickets set customer_unread = false where id = p_ticket;
  end if;
end $$;

create or replace function public.sa_support_tickets(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'subject', t.subject, 'category', t.category, 'priority', t.priority,
      'status', t.status, 'staff_unread', t.staff_unread, 'last_activity_at', t.last_activity_at, 'created_at', t.created_at,
      'organization', o.name, 'organization_id', o.id, 'plan_code', private.org_entitlements(o.id) ->> 'plan_code') order by t.staff_unread desc, t.last_activity_at desc)
    from (select * from public.support_tickets where p_status is null or status = p_status order by last_activity_at desc limit 200) t
    join public.organizations o on o.id = t.organization_id), '[]'::jsonb);
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Funnel di crescita
-- ════════════════════════════════════════════════════════════════════════════
-- Nessun dato personale: solo identificativi interni o un id anonimo casuale (generato nel browser
-- SOLO dopo il consenso alle statistiche). Ogni evento ha una chiave di deduplicazione unica.
create table public.funnel_events (
  id bigint generated always as identity primary key,
  event text not null check (event in ('landing_visit', 'pricing_viewed', 'signup_started', 'signup_completed', 'onboarding_completed',
    'checkout_started', 'subscription_activated', 'first_lead_search', 'first_lead_saved', 'first_ai_analysis', 'demo_requested')),
  anonymous_id text check (anonymous_id is null or anonymous_id ~ '^[0-9a-f]{32}$'),
  user_id uuid references auth.users (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  dedup_key text not null unique check (char_length(dedup_key) <= 200),
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object' and pg_column_size(properties) < 1000),
  occurred_at timestamptz not null default now()
);
create index funnel_events_event_time_idx on public.funnel_events (event, occurred_at);

create or replace function private.funnel(p_event text, p_key text, p_user uuid, p_org uuid, p_props jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.funnel_events (event, dedup_key, user_id, organization_id, properties)
  values (p_event, p_key, p_user, p_org, coalesce(p_props, '{}'::jsonb))
  on conflict (dedup_key) do nothing;
exception when others then
  -- Le statistiche non devono mai bloccare l'operazione principale.
  null;
end $$;

create or replace function private.funnel_on_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.funnel('signup_completed', 'signup_completed:' || new.id, new.id, null);
  return new;
end $$;
create trigger profiles_funnel after insert on public.profiles for each row execute function private.funnel_on_profile();

create or replace function private.funnel_on_onboarding() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.completed_at is not null and (tg_op = 'INSERT' or old.completed_at is null) then
    perform private.funnel('onboarding_completed', 'onboarding_completed:' || new.user_id, new.user_id, new.organization_id,
      jsonb_strip_nulls(jsonb_build_object('plan', new.plan_code, 'payment_deferred', new.payment_deferred)));
  end if;
  return new;
end $$;
create trigger onboarding_progress_funnel after insert or update of completed_at on public.onboarding_progress
  for each row execute function private.funnel_on_onboarding();

create or replace function private.funnel_on_billing_audit() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.action = 'checkout.started' and new.organization_id is not null then
    perform private.funnel('checkout_started', 'checkout_started:' || new.organization_id, new.actor_id, new.organization_id,
      jsonb_strip_nulls(jsonb_build_object('plan', new.metadata ->> 'plan')));
  end if;
  return new;
end $$;
create trigger billing_audit_logs_funnel after insert on public.billing_audit_logs for each row execute function private.funnel_on_billing_audit();

create or replace function private.funnel_on_subscription() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source = 'stripe' and new.status in ('active', 'trialing') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform private.funnel('subscription_activated', 'subscription_activated:' || new.organization_id, null, new.organization_id,
      jsonb_build_object('plan', new.plan_code, 'livemode', new.livemode));
  end if;
  return new;
end $$;
create trigger organization_subscriptions_funnel after insert or update of status on public.organization_subscriptions
  for each row execute function private.funnel_on_subscription();

create or replace function private.funnel_on_search() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.funnel('first_lead_search', 'first_lead_search:' || new.organization_id, new.created_by, new.organization_id);
  return new;
end $$;
create trigger lead_searches_funnel after insert on public.lead_searches for each row execute function private.funnel_on_search();

create or replace function private.funnel_on_lead() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.funnel('first_lead_saved', 'first_lead_saved:' || new.organization_id, new.created_by, new.organization_id);
  return new;
end $$;
create trigger leads_funnel after insert on public.leads for each row execute function private.funnel_on_lead();

create or replace function private.funnel_on_ai_job() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'succeeded' and old.status is distinct from 'succeeded' and new.type in ('business_analysis', 'sales_agent') then
    perform private.funnel('first_ai_analysis', 'first_ai_analysis:' || new.organization_id, new.created_by, new.organization_id);
  end if;
  return new;
end $$;
create trigger ai_jobs_funnel after update of status on public.ai_jobs for each row execute function private.funnel_on_ai_job();

create or replace function private.funnel_on_demo() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.funnel('demo_requested', 'demo_requested:' || new.id, null, null);
  return new;
end $$;
create trigger demo_requests_funnel after insert on public.demo_requests for each row execute function private.funnel_on_demo();

-- Eventi anonimi dal sito pubblico (solo con consenso, chiamata dal server). Deduplicati per giorno.
create or replace function public.track_public_event(p_event text, p_anonymous_id text, p_page text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_page text := case when p_page ~ '^/[a-z0-9/_-]{0,60}$' then p_page end;
begin
  if p_event not in ('landing_visit', 'pricing_viewed', 'signup_started') then raise exception 'invalid_event' using errcode = '22023'; end if;
  if p_anonymous_id !~ '^[0-9a-f]{32}$' then raise exception 'invalid_id' using errcode = '22023'; end if;
  insert into public.funnel_events (event, anonymous_id, dedup_key, properties)
  values (p_event, p_anonymous_id,
          p_event || ':' || p_anonymous_id || case when p_event = 'signup_started' then '' else ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD') end,
          jsonb_strip_nulls(jsonb_build_object('page', v_page)))
  on conflict (dedup_key) do nothing;
  return found;
end $$;

-- Metriche del funnel per il super admin. I visitatori contano solo chi ha dato il consenso.
create or replace function public.sa_growth(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to timestamptz := coalesce(p_to, now());
  r jsonb;
begin
  perform private.require_super_admin();
  if v_to <= v_from or v_to - v_from > interval '366 days' then raise exception 'invalid_range' using errcode = '22023'; end if;
  with ev as (select * from public.funnel_events where occurred_at >= v_from and occurred_at < v_to),
  signups as (select distinct user_id from ev where event = 'signup_completed' and user_id is not null),
  -- Coorte: organizzazioni create da utenti registrati nel periodo.
  cohort_orgs as (select o.id from public.organizations o where o.created_by in (select user_id from signups)),
  counts as (select event, count(*) n, count(distinct coalesce(anonymous_id, user_id::text, organization_id::text)) u from ev group by event)
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'events', coalesce((select jsonb_object_agg(event, n) from counts), '{}'::jsonb),
    'visitors_consented', coalesce((select count(distinct anonymous_id) from ev where event = 'landing_visit'), 0),
    'pricing_viewers', coalesce((select count(distinct anonymous_id) from ev where event = 'pricing_viewed'), 0),
    'signups', (select count(*) from signups),
    'onboarding_started', (select count(*) from public.onboarding_progress where user_id in (select user_id from signups)),
    'onboarding_completed', (select count(*) from public.onboarding_progress where user_id in (select user_id from signups) and completed_at is not null),
    'onboarding_abandoned', (select count(*) from public.onboarding_progress where user_id in (select user_id from signups)
                               and completed_at is null and updated_at < now() - interval '7 days'),
    'cohort_organizations', (select count(*) from cohort_orgs),
    'cohort_paid', (select count(*) from cohort_orgs c where exists (select 1 from public.funnel_events f where f.event = 'subscription_activated' and f.organization_id = c.id)),
    'cohort_activated', (select count(*) from cohort_orgs c where exists (select 1 from public.funnel_events f where f.event = 'first_lead_search' and f.organization_id = c.id)),
    'cohort_ai', (select count(*) from cohort_orgs c where exists (select 1 from public.funnel_events f where f.event = 'first_ai_analysis' and f.organization_id = c.id)),
    'demo_requests', (select count(*) from ev where event = 'demo_requested'),
    'paying_customers', (select count(distinct organization_id) from public.organization_subscriptions where source = 'stripe' and status in ('active', 'trialing', 'past_due')),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'visits', v, 'signups', s) order by d) from (
        select gs::date d,
               (select count(distinct anonymous_id) from ev where event = 'landing_visit' and occurred_at::date = gs::date) v,
               (select count(*) from ev where event = 'signup_completed' and occurred_at::date = gs::date) s
          from generate_series(date_trunc('day', v_from), date_trunc('day', v_to - interval '1 second'), interval '1 day') gs) x), '[]'::jsonb)
  ) into r;
  return r || jsonb_build_object('mrr', (public.billing_admin_revenue(least(greatest(extract(day from v_to - v_from)::int, 1), 366)) -> 'mrr_cents'));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Monitoraggio: errori applicativi e avvisi
-- ════════════════════════════════════════════════════════════════════════════
create table public.app_errors (
  id bigint generated always as identity primary key,
  source text not null check (source in ('client', 'function')),
  code text not null check (char_length(code) between 1 and 80),
  message text check (message is null or char_length(message) <= 300),
  path text check (path is null or char_length(path) <= 200),
  release text check (release is null or char_length(release) <= 40),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{16,64}$'),
  day date not null default (now() at time zone 'UTC')::date,
  occurrences integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (fingerprint, day)
);
create index app_errors_last_seen_idx on public.app_errors (last_seen desc);

create or replace function public.record_app_error(p_source text, p_code text, p_message text, p_path text, p_release text, p_fingerprint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.app_errors as e (source, code, message, path, release, fingerprint)
  values (p_source, left(p_code, 80), left(p_message, 300), left(p_path, 200), left(p_release, 40), p_fingerprint)
  on conflict (fingerprint, day) do update set occurrences = e.occurrences + 1, last_seen = now();
end $$;

create table public.monitoring_alerts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('function_errors', 'client_errors', 'webhook_failed', 'webhook_stuck', 'ai_jobs_stuck', 'ai_jobs_failing',
    'automation_failing', 'ai_cost', 'integration_missing')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  message text not null check (char_length(message) <= 300),
  details jsonb not null default '{}'::jsonb,
  dedup_key text not null unique,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  notify_error text check (notify_error is null or char_length(notify_error) <= 100)
);
create index monitoring_alerts_time_idx on public.monitoring_alerts (created_at desc);

-- Stato del sistema calcolato da dati reali (job, webhook, errori, costi). Solo aggregati.
create or replace function private.system_checks()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cc jsonb := (select value from public.platform_settings where key = 'cost_controls');
  v_month_cost numeric := (select coalesce(sum(cost_usd), 0) from public.ai_jobs where created_at >= date_trunc('month', now()));
begin
  return jsonb_build_object(
    'webhooks', jsonb_build_object(
      'processed_24h', (select count(*) from public.stripe_webhook_events where status = 'processed' and received_at > now() - interval '24 hours'),
      'failed_24h', (select count(*) from public.stripe_webhook_events where status = 'failed' and received_at > now() - interval '24 hours'),
      'stuck', (select count(*) from public.stripe_webhook_events where status = 'processing' and locked_until < now() - interval '10 minutes'),
      'last_processed_at', (select max(processed_at) from public.stripe_webhook_events where status = 'processed')),
    'ai_jobs', jsonb_build_object(
      'queued', (select count(*) from public.ai_jobs where status = 'queued'),
      'running', (select count(*) from public.ai_jobs where status = 'running'),
      'stuck', (select count(*) from public.ai_jobs where status in ('queued', 'running') and created_at < now() - interval '20 minutes'),
      'failed_24h', (select count(*) from public.ai_jobs where status = 'failed' and created_at > now() - interval '24 hours'),
      'succeeded_24h', (select count(*) from public.ai_jobs where status = 'succeeded' and created_at > now() - interval '24 hours')),
    'automation_jobs', jsonb_build_object(
      'failed_24h', (select count(*) from public.automation_jobs where status = 'dead' and updated_at > now() - interval '24 hours'),
      'pending', (select count(*) from public.automation_jobs where status = 'queued')),
    'errors', jsonb_build_object(
      'function_24h', (select coalesce(sum(occurrences), 0) from public.app_errors where source = 'function' and last_seen > now() - interval '24 hours'),
      'client_24h', (select coalesce(sum(occurrences), 0) from public.app_errors where source = 'client' and last_seen > now() - interval '24 hours'),
      'top', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'code', code, 'path', path, 'occurrences', occurrences, 'last_seen', last_seen) order by occurrences desc)
                       from (select * from public.app_errors where last_seen > now() - interval '24 hours' order by occurrences desc limit 10) t), '[]'::jsonb)),
    'ai_cost', jsonb_build_object('month_usd', round(v_month_cost, 4), 'budget_usd', nullif(cc ->> 'monthly_ai_budget_usd', '')::numeric,
      'threshold_pct', coalesce((cc ->> 'alert_threshold_pct')::numeric, 80)),
    'support', jsonb_build_object(
      'open', (select count(*) from public.support_tickets where status in ('open', 'waiting_staff')),
      'urgent', (select count(*) from public.support_tickets where status in ('open', 'waiting_staff') and priority = 'urgent')),
    'demo_requests_new', (select count(*) from public.demo_requests where status = 'new'),
    'operations', (select value from public.platform_settings where key = 'operations'),
    'enforcement', (select enforcement_enabled from public.billing_settings where id)
  );
end $$;

create or replace function public.sa_system_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_super_admin();
  return private.system_checks() || jsonb_build_object(
    'alerts', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from (select * from public.monitoring_alerts order by created_at desc limit 50) a), '[]'::jsonb));
end $$;

-- Valuta le soglie e registra gli avvisi (uno per tipo al giorno). Chiamata dalla function pianificata.
create or replace function public.monitoring_evaluate()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s jsonb := private.system_checks();
  v_day text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  v_new jsonb := '[]'::jsonb;
  a record;
begin
  for a in
    select * from (values
      ('webhook_failed', 'critical', 'Webhook Stripe falliti nelle ultime 24 ore: ' || (s -> 'webhooks' ->> 'failed_24h'), ((s -> 'webhooks' ->> 'failed_24h')::int > 0)),
      ('webhook_stuck', 'critical', 'Webhook Stripe bloccati in elaborazione: ' || (s -> 'webhooks' ->> 'stuck'), ((s -> 'webhooks' ->> 'stuck')::int > 0)),
      ('ai_jobs_stuck', 'warning', 'Job AI fermi da oltre 20 minuti: ' || (s -> 'ai_jobs' ->> 'stuck'), ((s -> 'ai_jobs' ->> 'stuck')::int > 0)),
      ('ai_jobs_failing', 'warning', 'Job AI falliti nelle ultime 24 ore: ' || (s -> 'ai_jobs' ->> 'failed_24h'),
        ((s -> 'ai_jobs' ->> 'failed_24h')::int >= 10 and (s -> 'ai_jobs' ->> 'failed_24h')::numeric > (s -> 'ai_jobs' ->> 'succeeded_24h')::numeric * 0.2)),
      ('automation_failing', 'warning', 'Job di automazione falliti nelle ultime 24 ore: ' || (s -> 'automation_jobs' ->> 'failed_24h'), ((s -> 'automation_jobs' ->> 'failed_24h')::int >= 10)),
      ('function_errors', 'critical', 'Errori delle API (500) nelle ultime 24 ore: ' || (s -> 'errors' ->> 'function_24h'), ((s -> 'errors' ->> 'function_24h')::int >= 20)),
      ('client_errors', 'warning', 'Errori nel browser nelle ultime 24 ore: ' || (s -> 'errors' ->> 'client_24h'), ((s -> 'errors' ->> 'client_24h')::int >= 50)),
      ('ai_cost', 'warning', 'Costo AI del mese: ' || (s -> 'ai_cost' ->> 'month_usd') || ' USD su un budget di ' || coalesce(s -> 'ai_cost' ->> 'budget_usd', '-') || ' USD',
        (s -> 'ai_cost' ->> 'budget_usd' is not null and (s -> 'ai_cost' ->> 'month_usd')::numeric >= (s -> 'ai_cost' ->> 'budget_usd')::numeric * (s -> 'ai_cost' ->> 'threshold_pct')::numeric / 100))
    ) as t(kind, severity, message, firing)
    where firing
  loop
    insert into public.monitoring_alerts (kind, severity, message, details, dedup_key)
    values (a.kind, a.severity, a.message, s, a.kind || ':' || v_day)
    on conflict (dedup_key) do nothing;
    if found then v_new := v_new || jsonb_build_array(jsonb_build_object('kind', a.kind, 'severity', a.severity, 'message', a.message)); end if;
  end loop;
  return jsonb_build_object('new_alerts', v_new);
end $$;

create or replace function public.monitoring_mark_notified(p_kinds text[], p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.monitoring_alerts set notified_at = case when p_error is null then now() end, notify_error = left(p_error, 100)
   where kind = any (p_kinds) and dedup_key like '%:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD') and notified_at is null;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Privilegi e RLS
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.onboarding_progress, public.public_rate_limits, public.demo_requests, public.support_tickets,
  public.support_ticket_messages, public.funnel_events, public.app_errors, public.monitoring_alerts from anon;
revoke insert, update, delete, truncate, references, trigger on public.onboarding_progress, public.public_rate_limits, public.demo_requests,
  public.support_tickets, public.support_ticket_messages, public.funnel_events, public.app_errors, public.monitoring_alerts from authenticated;

alter table public.onboarding_progress enable row level security;
alter table public.public_rate_limits enable row level security;
alter table public.demo_requests enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;
alter table public.funnel_events enable row level security;
alter table public.app_errors enable row level security;
alter table public.monitoring_alerts enable row level security;

create policy onboarding_progress_select on public.onboarding_progress for select to authenticated using (user_id = (select auth.uid()));
create policy demo_requests_select on public.demo_requests for select to authenticated using (private.is_super_admin());
create policy support_tickets_select on public.support_tickets for select to authenticated
  using (created_by = (select auth.uid()) or private.is_org_admin(organization_id) or private.is_super_admin());
create policy support_ticket_messages_select on public.support_ticket_messages for select to authenticated using (private.can_see_ticket(ticket_id));
create policy funnel_events_select on public.funnel_events for select to authenticated using (private.is_super_admin());
create policy app_errors_select on public.app_errors for select to authenticated using (private.is_super_admin());
create policy monitoring_alerts_select on public.monitoring_alerts for select to authenticated using (private.is_super_admin());

revoke all on function public.onboarding_state(), public.onboarding_save_company(uuid, text, text, text),
  public.onboarding_save_commercial(uuid, text, text, text, text), public.onboarding_advance(text, text), public.onboarding_checklist(uuid),
  public.sa_demo_requests(text), public.sa_update_demo_request(uuid, text, text), public.support_create_ticket(uuid, text, text, text, text),
  public.support_reply(uuid, text), public.support_set_status(uuid, text), public.support_mark_read(uuid), public.sa_support_tickets(text),
  public.sa_growth(timestamptz, timestamptz), public.sa_system_status() from public, anon;
grant execute on function public.onboarding_state(), public.onboarding_save_company(uuid, text, text, text),
  public.onboarding_save_commercial(uuid, text, text, text, text), public.onboarding_advance(text, text), public.onboarding_checklist(uuid),
  public.sa_demo_requests(text), public.sa_update_demo_request(uuid, text, text), public.support_create_ticket(uuid, text, text, text, text),
  public.support_reply(uuid, text), public.support_set_status(uuid, text), public.support_mark_read(uuid), public.sa_support_tickets(text),
  public.sa_growth(timestamptz, timestamptz), public.sa_system_status() to authenticated;

revoke all on function public.public_rate_limit(text, text, integer, integer), public.track_public_event(text, text, text),
  public.record_app_error(text, text, text, text, text, text), public.monitoring_evaluate(), public.monitoring_mark_notified(text[], text)
  from public, anon, authenticated;
grant execute on function public.public_rate_limit(text, text, integer, integer), public.track_public_event(text, text, text),
  public.record_app_error(text, text, text, text, text, text), public.monitoring_evaluate(), public.monitoring_mark_notified(text[], text)
  to service_role;

revoke all on function private.onboarding_row(), private.funnel(text, text, uuid, uuid, jsonb), private.funnel_on_profile(),
  private.funnel_on_onboarding(), private.funnel_on_billing_audit(), private.funnel_on_subscription(), private.funnel_on_search(),
  private.funnel_on_lead(), private.funnel_on_ai_job(), private.funnel_on_demo(), private.system_checks()
  from public, anon, authenticated;
