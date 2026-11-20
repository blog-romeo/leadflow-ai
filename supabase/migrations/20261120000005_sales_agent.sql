-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Migrazione 0005: AI Sales Agent
--
-- • Pipeline commerciale a 12 stati sulla colonna esistente leads.status,
--   con cronologia (attività + audit) e blocchi per i contatti non contattabili
-- • sales_profiles, sales_opportunities, sales_proposals, message_drafts,
--   follow_up_tasks, ai_conversations, ai_messages, vista lead_activities
-- • Nessun invio: "approvato" e "inviata manualmente" sono registrazioni umane
-- • Quote e costi AI per organizzazione; RPC dashboard
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Pipeline a 12 stati (sostituisce i 6 stati precedenti, dati migrati)
-- ════════════════════════════════════════════════════════════════════════════
alter table public.leads alter column status drop default;
alter type public.lead_status rename to lead_status_v1;
create type public.lead_status as enum (
  'new', 'to_qualify', 'qualified', 'to_contact', 'contacted', 'in_conversation',
  'meeting_scheduled', 'proposal_sent', 'negotiation', 'won', 'lost', 'not_contactable'
);
alter table public.leads alter column status type public.lead_status
  using (case status::text when 'proposal' then 'proposal_sent' else status::text end)::public.lead_status;
alter table public.leads alter column status set default 'new';
drop type public.lead_status_v1;

alter table public.leads add column stage_changed_at timestamptz;
update public.leads set stage_changed_at = updated_at;
update public.leads set status = 'not_contactable' where contact_status <> 'active' and status not in ('won', 'lost');

-- Stati che implicano un contatto con il lead.
create or replace function private.is_contact_stage(p public.lead_status)
returns boolean language sql immutable set search_path = '' as $$
  select p in ('to_contact', 'contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation');
$$;

-- Un lead con opposizione o soppressione è sempre "non contattabile" (salvo chiusure già registrate).
create or replace function private.leads_stage_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.contact_status <> 'active' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status
       and new.status not in ('not_contactable', 'won', 'lost') then
      raise exception 'lead_not_contactable' using errcode = 'P0001';
    end if;
    if new.status not in ('won', 'lost') then
      new.status := 'not_contactable';
    end if;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.stage_changed_at := now();
  end if;
  return new;
end $$;
-- Il nome segue "leads_contact_guard" in ordine alfabetico: lo stato di contatto è già definitivo.
create trigger leads_stage_guard before insert or update on public.leads
  for each row execute function private.leads_stage_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Attività: metadati e vista lead_activities (nessuna tabella duplicata)
-- ════════════════════════════════════════════════════════════════════════════
alter table public.activities add column metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 8000);
create index activities_org_lead_time_idx on public.activities (organization_id, lead_id, occurred_at desc);

create view public.lead_activities with (security_invoker = true) as
  select id, organization_id, lead_id, type, subject, body, metadata, occurred_at, created_by, created_at
  from public.activities
  where lead_id is not null;
revoke all on public.lead_activities from anon;
grant select on public.lead_activities to authenticated;

create or replace function private.log_activity(
  p_org uuid, p_lead uuid, p_type public.activity_type, p_subject text, p_metadata jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = '' as $$
  insert into public.activities (organization_id, lead_id, type, subject, metadata, created_by)
  values (p_org, p_lead, p_type, left(p_subject, 300), coalesce(p_metadata, '{}'::jsonb), auth.uid());
$$;
revoke all on function private.log_activity(uuid, uuid, public.activity_type, text, jsonb) from public;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Profilo commerciale
-- ════════════════════════════════════════════════════════════════════════════
create type public.sales_tone as enum ('formal', 'friendly', 'direct', 'consultative');

create or replace function private.valid_offsets(p int[])
returns boolean language sql immutable set search_path = '' as $$
  select cardinality(p) between 1 and 6
     and coalesce(bool_and(v between 1 and 90), false)
     and coalesce((select bool_and(a < b) from unnest(p[1:cardinality(p) - 1], p[2:cardinality(p)]) as x(a, b)), true)
  from unnest(p) as v;
$$;

-- Servizi: [{id, name, description?, price_from?, price_to?, price_unit?}]
create or replace function private.valid_services(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 30 and coalesce(bool_and(
    jsonb_typeof(s) = 'object'
    and s ->> 'id' ~ '^[a-z0-9-]{1,40}$'
    and char_length(coalesce(s ->> 'name', '')) between 1 and 120
    and char_length(coalesce(s ->> 'description', '')) <= 1000
    and char_length(coalesce(s ->> 'price_unit', '')) <= 40
    and (s -> 'price_from' is null or jsonb_typeof(s -> 'price_from') = 'null' or (jsonb_typeof(s -> 'price_from') = 'number' and (s ->> 'price_from')::numeric >= 0))
    and (s -> 'price_to' is null or jsonb_typeof(s -> 'price_to') = 'null' or (jsonb_typeof(s -> 'price_to') = 'number' and (s ->> 'price_to')::numeric >= 0))
  ), true)
  from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) as s;
$$;

create table public.sales_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete cascade,
  commercial_name text check (commercial_name is null or char_length(commercial_name) between 1 and 160),
  sector text check (sector is null or char_length(sector) <= 160),
  offer_description text check (offer_description is null or char_length(offer_description) <= 4000),
  services jsonb not null default '[]'::jsonb check (private.valid_services(services)),
  price_range text check (price_range is null or char_length(price_range) <= 200),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  served_areas text[] not null default '{}' check (cardinality(served_areas) <= 50),
  ideal_customer text check (ideal_customer is null or char_length(ideal_customer) <= 4000),
  differentiators text[] not null default '{}' check (cardinality(differentiators) <= 15),
  website text check (website is null or website ~* '^https?://[^\s]+$'),
  language text not null default 'it' check (language in ('it', 'en')),
  tone public.sales_tone not null default 'consultative',
  call_to_action text check (call_to_action is null or char_length(call_to_action) <= 300),
  booking_url text check (booking_url is null or booking_url ~* '^https://[^\s]+$'),
  commercial_terms text check (commercial_terms is null or char_length(commercial_terms) <= 4000),
  follow_up_days int[] not null default '{3,7,14}' check (private.valid_offsets(follow_up_days)),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger sales_profiles_updated_at before update on public.sales_profiles
  for each row execute function public.set_updated_at();

-- Un'unica fonte per cliente ideale e servizi: lo scoring legge organization_profiles.
create or replace function private.sync_sales_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.organization_profiles
     set ideal_customer = new.ideal_customer,
         services_description = nullif(left(concat_ws(E'\n', new.offer_description,
           (select string_agg(s ->> 'name', ', ') from jsonb_array_elements(new.services) s)), 4000), '')
   where organization_id = new.organization_id;
  if tg_op = 'UPDATE' then
    perform private.write_audit(new.organization_id, 'sales_profile.updated', 'sales_profile', new.id::text);
  end if;
  return new;
end $$;
create trigger sales_profiles_sync after insert or update on public.sales_profiles
  for each row execute function private.sync_sales_profile();

create or replace function private.init_organization_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_profiles (organization_id) values (new.id) on conflict do nothing;
  insert into public.organization_quotas (organization_id) values (new.id) on conflict do nothing;
  insert into public.sales_profiles (organization_id, commercial_name) values (new.id, left(new.name, 160)) on conflict do nothing;
  return new;
end $$;

insert into public.sales_profiles (organization_id, commercial_name, ideal_customer)
select o.id, left(o.name, 160), p.ideal_customer
  from public.organizations o left join public.organization_profiles p on p.organization_id = o.id
on conflict do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Opportunità
-- ════════════════════════════════════════════════════════════════════════════
create type public.opportunity_status as enum ('open', 'won', 'lost');

create table public.sales_opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  title text not null check (char_length(btrim(title)) between 2 and 200),
  service_name text check (service_name is null or char_length(service_name) <= 160),
  value_amount numeric(12, 2) check (value_amount is null or value_amount >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  status public.opportunity_status not null default 'open',
  expected_close_date date,
  owner_id uuid references auth.users (id) on delete set null,
  notes text check (notes is null or char_length(notes) <= 4000),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
create unique index sales_opportunities_one_open_uidx on public.sales_opportunities (organization_id, lead_id) where status = 'open';
create index sales_opportunities_org_status_idx on public.sales_opportunities (organization_id, status, updated_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Proposte commerciali
-- ════════════════════════════════════════════════════════════════════════════
create type public.message_variant as enum ('professional', 'direct', 'consultative');
create type public.proposal_status as enum ('draft', 'approved', 'sent_manually', 'archived');
create type public.draft_status as enum ('draft', 'approved', 'archived');

create table public.sales_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  opportunity_id uuid,
  title text not null check (char_length(btrim(title)) between 2 and 200),
  status public.proposal_status not null default 'draft',
  variant public.message_variant not null default 'consultative',
  language text not null default 'it' check (language in ('it', 'en')),
  -- Sezioni: company_presentation, opportunity, solution, services_included, benefits,
  -- pricing {currency, lines[]}, conditions, call_to_action
  content jsonb not null check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 60000),
  facts_used jsonb not null default '[]'::jsonb check (jsonb_typeof(facts_used) = 'array'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  generated_by text not null default 'manual' check (generated_by in ('ai', 'manual')),
  ai_job_id uuid,
  version integer not null default 1 check (version >= 1),
  edited_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  sent_at timestamptz,
  sent_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, opportunity_id) references public.sales_opportunities (organization_id, id) on delete set null (opportunity_id),
  foreign key (organization_id, ai_job_id) references public.ai_jobs (organization_id, id) on delete set null (ai_job_id)
);
create index sales_proposals_org_lead_idx on public.sales_proposals (organization_id, lead_id, created_at desc);
create index sales_proposals_org_status_idx on public.sales_proposals (organization_id, status, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Bozze di messaggi (mai inviate dalla piattaforma)
-- ════════════════════════════════════════════════════════════════════════════
create type public.message_channel as enum ('email', 'linkedin', 'whatsapp', 'phone_script', 'follow_up');

create table public.message_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  channel public.message_channel not null,
  variant public.message_variant not null,
  generation_id uuid not null default gen_random_uuid(),
  subject text check (subject is null or char_length(subject) <= 300),
  body text not null check (char_length(body) between 1 and 8000),
  status public.draft_status not null default 'draft',
  facts_used jsonb not null default '[]'::jsonb check (jsonb_typeof(facts_used) = 'array'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  generated_by text not null default 'manual' check (generated_by in ('ai', 'manual')),
  ai_job_id uuid,
  follow_up_task_id uuid,
  edited_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, ai_job_id) references public.ai_jobs (organization_id, id) on delete set null (ai_job_id)
);
create index message_drafts_org_lead_idx on public.message_drafts (organization_id, lead_id, created_at desc);
create index message_drafts_org_status_idx on public.message_drafts (organization_id, status, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Follow-up (promemoria, mai invii)
-- ════════════════════════════════════════════════════════════════════════════
create type public.follow_up_kind as enum ('check_in', 'second_contact', 'opportunity_review', 'custom');
create type public.follow_up_status as enum ('open', 'done', 'dismissed', 'blocked');

create table public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  proposal_id uuid,
  opportunity_id uuid,
  kind public.follow_up_kind not null default 'custom',
  -- La revisione dell'opportunità è interna; gli altri tipi implicano un contatto.
  is_contact boolean generated always as (kind <> 'opportunity_review') stored,
  title text not null check (char_length(btrim(title)) between 2 and 200),
  notes text check (notes is null or char_length(notes) <= 4000),
  due_at timestamptz not null,
  status public.follow_up_status not null default 'open',
  priority public.lead_priority not null default 'medium',
  assigned_to uuid references auth.users (id) on delete set null,
  source text not null default 'manual' check (source in ('cadence', 'manual', 'ai')),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 200),
  ai_suggestion jsonb,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, proposal_id) references public.sales_proposals (organization_id, id) on delete set null (proposal_id),
  foreign key (organization_id, opportunity_id) references public.sales_opportunities (organization_id, id) on delete set null (opportunity_id)
);
create index follow_up_tasks_org_due_idx on public.follow_up_tasks (organization_id, status, due_at);
create index follow_up_tasks_org_lead_idx on public.follow_up_tasks (organization_id, lead_id);
create unique index follow_up_tasks_cadence_uidx on public.follow_up_tasks (proposal_id, kind, due_at) where source = 'cadence';

alter table public.message_drafts
  add constraint message_drafts_follow_up_fk foreign key (organization_id, follow_up_task_id)
  references public.follow_up_tasks (organization_id, id) on delete set null (follow_up_task_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Copilota: conversazioni private dell'utente
-- ════════════════════════════════════════════════════════════════════════════
create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text check (title is null or char_length(title) <= 200),
  lead_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id)
);
create index ai_conversations_user_idx on public.ai_conversations (organization_id, user_id, updated_at desc);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 8000),
  -- Risposta strutturata: facts, inferences, suggestions (sempre separati)
  structured jsonb,
  ai_job_id uuid,
  model text,
  tokens_input integer,
  tokens_output integer,
  created_at timestamptz not null default now(),
  foreign key (organization_id, conversation_id) references public.ai_conversations (organization_id, id) on delete cascade,
  foreign key (organization_id, ai_job_id) references public.ai_jobs (organization_id, id) on delete set null (ai_job_id)
);
create index ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at);

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Job AI: compito, lead, costo; analisi di tipo "sales_intelligence"
-- ════════════════════════════════════════════════════════════════════════════
alter table public.ai_jobs
  add column task text check (task is null or task in ('business_analysis', 'intelligence', 'messages', 'proposal', 'follow_up_suggestion', 'copilot')),
  add column lead_id uuid,
  add column cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0);
alter table public.ai_jobs add constraint ai_jobs_lead_fk
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id);
create index ai_jobs_org_lead_idx on public.ai_jobs (organization_id, lead_id, created_at desc);

alter table public.lead_analyses add column kind text not null default 'business_analysis'
  check (kind in ('business_analysis', 'sales_intelligence'));
create index lead_analyses_org_lead_kind_idx on public.lead_analyses (organization_id, lead_id, kind, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Trigger di dominio
-- ════════════════════════════════════════════════════════════════════════════
create trigger sales_opportunities_created_by before insert on public.sales_opportunities for each row execute function private.set_created_by();
create trigger sales_proposals_created_by before insert on public.sales_proposals for each row execute function private.set_created_by();
create trigger message_drafts_created_by before insert on public.message_drafts for each row execute function private.set_created_by();
create trigger follow_up_tasks_created_by before insert on public.follow_up_tasks for each row execute function private.set_created_by();

do $$
declare t text;
begin
  foreach t in array array['sales_opportunities', 'sales_proposals', 'message_drafts', 'follow_up_tasks', 'ai_conversations']
  loop
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
    execute format('create trigger %1$s_org_immutable before update on public.%1$I for each row execute function public.prevent_org_change()', t);
  end loop;
end $$;

-- Ultima attività del lead (usata dal copilota, dai follow-up e dalla retention).
create or replace function private.activities_touch_lead()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.lead_id is not null then
    update public.leads set last_activity_at = new.occurred_at
     where id = new.lead_id and organization_id = new.organization_id
       and (last_activity_at is null or last_activity_at < new.occurred_at);
  end if;
  return new;
end $$;
create trigger activities_touch_lead after insert on public.activities
  for each row execute function private.activities_touch_lead();

-- Lead: cronologia degli stati, chiusura opportunità, blocco follow-up.
create or replace function private.leads_after_stage_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    perform private.log_activity(new.organization_id, new.id, 'status_change',
      'Stato: ' || old.status || ' → ' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status, 'actor', coalesce(auth.uid()::text, 'system')));
    if new.status in ('won', 'lost') then
      update public.sales_opportunities
         set status = (case when new.status = 'won' then 'won' else 'lost' end)::public.opportunity_status
       where organization_id = new.organization_id and lead_id = new.id and status = 'open';
      update public.follow_up_tasks
         set status = 'dismissed', blocked_reason = 'lead_closed'
       where organization_id = new.organization_id and lead_id = new.id and status = 'open' and is_contact;
    end if;
  end if;
  if new.status = 'not_contactable' and old.status is distinct from 'not_contactable' then
    update public.follow_up_tasks
       set status = 'blocked', blocked_reason = 'lead_not_contactable'
     where organization_id = new.organization_id and lead_id = new.id and status = 'open' and is_contact;
  end if;
  return new;
end $$;
-- Nota: "after update" senza lista di colonne, perché lo stato può essere cambiato
-- dal trigger leads_stage_guard (es. opposizione) senza comparire nella SET.
create trigger leads_after_stage_change after update on public.leads
  for each row when (new.status is distinct from old.status)
  execute function private.leads_after_stage_change();

-- Opportunità: chiusura tracciata, attività e audit.
create or replace function private.opportunities_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'open' then
      new.closed_at := null; new.closed_by := null;
    else
      new.closed_at := now(); new.closed_by := auth.uid();
    end if;
  end if;
  if tg_op = 'INSERT' and new.status <> 'open' then
    new.closed_at := now(); new.closed_by := auth.uid();
  end if;
  return new;
end $$;
create trigger sales_opportunities_guard before insert or update on public.sales_opportunities
  for each row execute function private.opportunities_guard();

create or replace function private.opportunities_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.organization_id, new.lead_id, 'opportunity', 'Opportunità aperta: ' || new.title,
      jsonb_build_object('opportunity_id', new.id, 'value', new.value_amount, 'currency', new.currency));
    perform private.write_audit(new.organization_id, 'opportunity.created', 'sales_opportunity', new.id::text);
  elsif new.status is distinct from old.status then
    perform private.log_activity(new.organization_id, new.lead_id, 'opportunity', 'Opportunità ' || new.status || ': ' || new.title,
      jsonb_build_object('opportunity_id', new.id, 'from', old.status, 'to', new.status));
    perform private.write_audit(new.organization_id, 'opportunity.' || new.status, 'sales_opportunity', new.id::text);
  end if;
  return new;
end $$;
create trigger sales_opportunities_log after insert or update on public.sales_opportunities
  for each row execute function private.opportunities_log();

-- Programmazione delle cadenze di follow-up (giorni configurabili nel profilo commerciale).
create or replace function private.schedule_follow_ups(p_org uuid, p_lead uuid, p_proposal uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_days int[];
  v_lead public.leads;
  v_title text;
  v_kind public.follow_up_kind;
  i int;
  n int := 0;
begin
  select * into v_lead from public.leads where id = p_lead and organization_id = p_org;
  if not found or v_lead.contact_status <> 'active' or v_lead.status in ('not_contactable', 'won', 'lost') or v_lead.deleted_at is not null then
    return 0;
  end if;
  select follow_up_days into v_days from public.sales_profiles where organization_id = p_org;
  v_days := coalesce(v_days, '{3,7,14}');
  for i in 1 .. cardinality(v_days) loop
    v_kind := case when i = cardinality(v_days) and cardinality(v_days) > 1 then 'opportunity_review'
                   when i = 1 then 'check_in' else 'second_contact' end;
    v_title := case v_kind when 'check_in' then 'Verifica ricezione della proposta'
                           when 'second_contact' then 'Secondo contatto'
                           else 'Revisione dell''opportunità' end;
    insert into public.follow_up_tasks (organization_id, lead_id, proposal_id, kind, title, due_at, source, priority, created_by)
    values (p_org, p_lead, p_proposal, v_kind, v_title, now() + make_interval(days => v_days[i]), 'cadence',
            coalesce(v_lead.priority, 'medium'), auth.uid())
    on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function private.schedule_follow_ups(uuid, uuid, uuid) from public;

-- Proposte: transizioni di stato controllate, contenuto bloccato dopo l'approvazione.
create or replace function private.proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_contact public.contact_status;
  v_stage public.lead_status;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and (new.generated_by <> 'manual' or new.ai_job_id is not null) then
      raise exception 'ai fields are server-only' using errcode = '42501';
    end if;
    if new.status <> 'draft' then
      raise exception 'proposals start as draft' using errcode = '22023';
    end if;
    return new;
  end if;

  if old.status <> 'draft' and (new.content is distinct from old.content or new.title is distinct from old.title) then
    raise exception 'proposal_locked: return it to draft before editing' using errcode = 'P0001';
  end if;
  if new.content is distinct from old.content or new.title is distinct from old.title then
    new.edited_at := now();
  end if;

  if new.status is distinct from old.status then
    -- Transizioni ammesse: draft→approved/archived, approved→draft/sent_manually/archived,
    -- sent_manually→archived, archived→draft.
    if not ((old.status = 'draft' and new.status in ('approved', 'archived'))
         or (old.status = 'approved' and new.status in ('draft', 'sent_manually', 'archived'))
         or (old.status = 'sent_manually' and new.status = 'archived')
         or (old.status = 'archived' and new.status = 'draft')) then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if new.status = 'approved' then
      new.approved_at := now(); new.approved_by := auth.uid();
    elsif new.status = 'draft' then
      new.approved_at := null; new.approved_by := null; new.archived_at := null;
      new.version := old.version + 1;
    elsif new.status = 'sent_manually' then
      select contact_status, status into v_contact, v_stage from public.leads where id = new.lead_id;
      if v_contact <> 'active' or v_stage = 'not_contactable' then
        raise exception 'lead_not_contactable' using errcode = 'P0001';
      end if;
      new.sent_at := now(); new.sent_by := auth.uid();
    elsif new.status = 'archived' then
      new.archived_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger sales_proposals_guard before insert or update on public.sales_proposals
  for each row execute function private.proposals_guard();

create or replace function private.proposals_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.organization_id, new.lead_id, 'proposal', 'Proposta preparata: ' || new.title,
      jsonb_build_object('proposal_id', new.id, 'generated_by', new.generated_by));
    return new;
  end if;
  if new.status is distinct from old.status then
    perform private.log_activity(new.organization_id, new.lead_id, 'proposal', 'Proposta ' || new.status || ': ' || new.title,
      jsonb_build_object('proposal_id', new.id, 'from', old.status, 'to', new.status));
    perform private.write_audit(new.organization_id, 'proposal.' || new.status, 'sales_proposal', new.id::text);
    if new.status = 'approved' then
      perform private.schedule_follow_ups(new.organization_id, new.lead_id, new.id);
    elsif new.status = 'sent_manually' then
      -- Registrazione manuale di un invio fatto dall'utente fuori dalla piattaforma.
      update public.leads set status = 'proposal_sent'
       where id = new.lead_id and organization_id = new.organization_id
         and status in ('new', 'to_qualify', 'qualified', 'to_contact', 'contacted', 'in_conversation', 'meeting_scheduled');
    end if;
  end if;
  return new;
end $$;
create trigger sales_proposals_after after insert or update on public.sales_proposals
  for each row execute function private.proposals_after();

-- Bozze: approvazione ≠ autorizzazione all'invio; contatti non contattabili esclusi.
create or replace function private.drafts_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_contact public.contact_status;
  v_stage public.lead_status;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and (new.generated_by <> 'manual' or new.ai_job_id is not null) then
      raise exception 'ai fields are server-only' using errcode = '42501';
    end if;
    if new.status <> 'draft' then
      raise exception 'drafts start as draft' using errcode = '22023';
    end if;
    return new;
  end if;
  if old.status <> 'draft' and (new.body is distinct from old.body or new.subject is distinct from old.subject) then
    raise exception 'draft_locked: return it to draft before editing' using errcode = 'P0001';
  end if;
  if new.body is distinct from old.body or new.subject is distinct from old.subject then
    new.edited_at := now();
  end if;
  if new.status is distinct from old.status then
    if new.status = 'approved' then
      if old.status <> 'draft' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      select contact_status, status into v_contact, v_stage from public.leads where id = new.lead_id;
      if v_contact <> 'active' or v_stage = 'not_contactable' then
        raise exception 'lead_not_contactable' using errcode = 'P0001';
      end if;
      new.approved_at := now(); new.approved_by := auth.uid();
    elsif new.status = 'archived' then
      new.archived_at := now();
    elsif new.status = 'draft' then
      new.approved_at := null; new.approved_by := null; new.archived_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger message_drafts_guard before insert or update on public.message_drafts
  for each row execute function private.drafts_guard();

create or replace function private.drafts_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status in ('approved', 'archived') then
    perform private.log_activity(new.organization_id, new.lead_id, 'message_draft',
      'Bozza ' || new.channel || ' ' || new.status,
      jsonb_build_object('draft_id', new.id, 'channel', new.channel, 'variant', new.variant, 'to', new.status));
    perform private.write_audit(new.organization_id, 'message_draft.' || new.status, 'message_draft', new.id::text);
  end if;
  return new;
end $$;
create trigger message_drafts_after after update on public.message_drafts
  for each row execute function private.drafts_after();

-- Follow-up: nessun promemoria di contatto per lead non contattabili, esclusi o chiusi.
create or replace function private.follow_ups_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_lead public.leads;
begin
  -- source e ai_suggestion non sono scrivibili dai client (privilegi di colonna):
  -- le cadenze nascono dal trigger sulle proposte, i suggerimenti AI dal server.
  -- Le colonne generate non sono ancora calcolate nei trigger BEFORE: si usa il tipo.
  if new.status = 'open' and new.kind <> 'opportunity_review' and (tg_op = 'INSERT' or old.status <> 'open' or new.lead_id <> old.lead_id) then
    select * into v_lead from public.leads where id = new.lead_id;
    if v_lead.contact_status <> 'active' or v_lead.status in ('not_contactable', 'won', 'lost') or v_lead.deleted_at is not null then
      raise exception 'lead_not_contactable' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'done' then
      new.completed_at := now(); new.completed_by := auth.uid();
    elsif new.status = 'open' then
      new.completed_at := null; new.completed_by := null; new.blocked_reason := null;
    end if;
  end if;
  return new;
end $$;
create trigger follow_up_tasks_guard before insert or update on public.follow_up_tasks
  for each row execute function private.follow_ups_guard();

create or replace function private.follow_ups_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('done', 'dismissed') then
    perform private.log_activity(new.organization_id, new.lead_id, 'follow_up',
      'Follow-up ' || new.status || ': ' || new.title, jsonb_build_object('task_id', new.id, 'kind', new.kind));
  end if;
  return new;
end $$;
create trigger follow_up_tasks_after after update on public.follow_up_tasks
  for each row execute function private.follow_ups_after();

-- Appuntamenti: attività e avanzamento della pipeline (solo per lead contattabili).
create or replace function private.appointments_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.lead_id is not null then
    perform private.log_activity(new.organization_id, new.lead_id, 'appointment', 'Appuntamento: ' || new.title,
      jsonb_build_object('appointment_id', new.id, 'starts_at', new.starts_at));
    update public.leads set status = 'meeting_scheduled'
     where id = new.lead_id and organization_id = new.organization_id and contact_status = 'active'
       and status in ('new', 'to_qualify', 'qualified', 'to_contact', 'contacted', 'in_conversation');
  end if;
  return new;
end $$;
create trigger appointments_after after insert on public.appointments
  for each row execute function private.appointments_after();

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Quote e costi AI
-- ════════════════════════════════════════════════════════════════════════════
alter table public.organization_quotas
  add column monthly_ai_generations integer not null default 300 check (monthly_ai_generations >= 0),
  add column monthly_ai_tokens bigint not null default 3000000 check (monthly_ai_tokens >= 0);

create or replace function public.consume_usage(
  p_org uuid, p_user uuid, p_event text, p_quantity integer, p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limit bigint;
  v_used bigint;
  v_month timestamptz := date_trunc('month', now());
begin
  if p_quantity < 0 then raise exception 'invalid quantity' using errcode = '22023'; end if;
  select case p_event
           when 'lead_search' then q.monthly_searches
           when 'lead_result' then q.monthly_results
           when 'ai_analysis' then q.monthly_ai_analyses
           when 'ai_generation' then q.monthly_ai_generations
           when 'ai_tokens' then q.monthly_ai_tokens
         end
    into v_limit
    from public.organization_quotas q where q.organization_id = p_org;
  if v_limit is null then raise exception 'unknown quota for event %', p_event using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_event, 0));
  select coalesce(sum(quantity), 0) into v_used from public.usage_events
   where organization_id = p_org and event_type = p_event and created_at >= v_month;

  -- I token si registrano sempre a consuntivo (il controllo preventivo avviene prima del job).
  if p_event <> 'ai_tokens' and v_used + p_quantity > v_limit then
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'remaining', greatest(v_limit - v_used, 0));
  end if;
  if p_quantity > 0 then
    insert into public.usage_events (organization_id, user_id, event_type, quantity, metadata)
    values (p_org, p_user, p_event, p_quantity, coalesce(p_metadata, '{}'::jsonb));
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used + p_quantity, 'limit', v_limit, 'remaining', greatest(v_limit - v_used - p_quantity, 0));
end $$;
revoke all on function public.consume_usage(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.consume_usage(uuid, uuid, text, integer, jsonb) to service_role;

create or replace function public.usage_summary(p_org uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q public.organization_quotas;
  v_month timestamptz := date_trunc('month', now());
  v_admin boolean;
begin
  if not private.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_admin := private.is_org_admin(p_org);
  select * into q from public.organization_quotas where organization_id = p_org;
  return jsonb_build_object(
    'period_start', v_month,
    'plan', q.plan,
    'searches', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'lead_search' and created_at >= v_month), 'limit', q.monthly_searches),
    'results', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'lead_result' and created_at >= v_month), 'limit', q.monthly_results),
    'ai_analyses', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'ai_analysis' and created_at >= v_month), 'limit', q.monthly_ai_analyses),
    'ai_generations', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'ai_generation' and created_at >= v_month), 'limit', q.monthly_ai_generations),
    'ai_tokens', jsonb_build_object('used', (select coalesce(sum(quantity), 0) from public.usage_events
        where organization_id = p_org and event_type = 'ai_tokens' and created_at >= v_month), 'limit', q.monthly_ai_tokens),
    -- Il costo stimato è visibile solo agli amministratori.
    'ai_cost_usd', case when v_admin then (select round(coalesce(sum(cost_usd), 0), 4) from public.ai_jobs
        where organization_id = p_org and created_at >= v_month) end
  );
end $$;
revoke all on function public.usage_summary(uuid) from public, anon;
grant execute on function public.usage_summary(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Dashboard Sales Agent (RLS applicata: security invoker)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.sales_dashboard(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v jsonb;
begin
  if not private.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'invalid_period' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'leads_available', (select count(*) from public.leads where organization_id = p_org and deleted_at is null
        and status not in ('won', 'lost', 'not_contactable')),
    'leads_qualified', (select count(*) from public.leads where organization_id = p_org and deleted_at is null
        and status in ('qualified', 'to_contact', 'contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation')),
    'proposals_generated', (select count(*) from public.sales_proposals where organization_id = p_org
        and created_at >= p_from and created_at < p_to),
    'drafts_pending', (select count(*) from public.message_drafts where organization_id = p_org and status = 'draft')
        + (select count(*) from public.sales_proposals where organization_id = p_org and status = 'draft'),
    'follow_ups_due', (select count(*) from public.follow_up_tasks where organization_id = p_org and status = 'open'
        and due_at < date_trunc('day', now()) + interval '1 day'),
    'follow_ups_overdue', (select count(*) from public.follow_up_tasks where organization_id = p_org and status = 'open'
        and due_at < now()),
    'appointments_scheduled', (select count(*) from public.appointments where organization_id = p_org
        and status = 'scheduled' and starts_at >= now()),
    'opportunities_open', (select count(*) from public.sales_opportunities where organization_id = p_org and status = 'open'),
    'opportunities_open_value', (select coalesce(sum(value_amount), 0) from public.sales_opportunities
        where organization_id = p_org and status = 'open'),
    -- Conversioni: passaggi a "Cliente acquisito" effettivamente registrati nel periodo.
    'conversions', (select count(*) from public.activities where organization_id = p_org and type = 'status_change'
        and metadata ->> 'to' = 'won' and occurred_at >= p_from and occurred_at < p_to),
    'by_stage', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
        select status, count(*) as n from public.leads where organization_id = p_org and deleted_at is null group by status) s),
    'weekly', (select coalesce(jsonb_agg(w order by w ->> 'week'), '[]'::jsonb) from (
        select jsonb_build_object(
          'week', to_char(wk, 'YYYY-MM-DD'),
          'proposals', (select count(*) from public.sales_proposals where organization_id = p_org
              and created_at >= wk and created_at < wk + interval '7 days'),
          'drafts_approved', (select count(*) from public.message_drafts where organization_id = p_org
              and approved_at >= wk and approved_at < wk + interval '7 days'),
          'conversions', (select count(*) from public.activities where organization_id = p_org and type = 'status_change'
              and metadata ->> 'to' = 'won' and occurred_at >= wk and occurred_at < wk + interval '7 days')
        ) as w
        from generate_series(date_trunc('week', p_from), p_to, interval '7 days') as wk) x)
  ) into v;
  return v;
end $$;
revoke all on function public.sales_dashboard(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_dashboard(uuid, timestamptz, timestamptz) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 13. Privilegi e RLS
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.sales_profiles, public.sales_opportunities, public.sales_proposals, public.message_drafts,
  public.follow_up_tasks, public.ai_conversations, public.ai_messages from anon;
revoke truncate, references, trigger on public.sales_profiles, public.sales_opportunities, public.sales_proposals,
  public.message_drafts, public.follow_up_tasks, public.ai_conversations, public.ai_messages from authenticated;

-- Cliente ideale e servizi si modificano nel profilo commerciale (sincronizzati verso lo scoring).
revoke update (services_description, ideal_customer) on public.organization_profiles from authenticated;

-- Profilo commerciale: solo aggiornamento dei campi descrittivi, da parte degli admin (RLS).
revoke insert, update, delete on public.sales_profiles from authenticated;
grant update (commercial_name, sector, offer_description, services, price_range, currency, served_areas, ideal_customer,
  differentiators, website, language, tone, call_to_action, booking_url, commercial_terms, follow_up_days, updated_by)
  on public.sales_profiles to authenticated;

-- Opportunità: create e gestite dai membri.
revoke insert, update on public.sales_opportunities from authenticated;
grant insert (organization_id, lead_id, title, service_name, value_amount, currency, status, expected_close_date, owner_id, notes)
  on public.sales_opportunities to authenticated;
grant update (title, service_name, value_amount, currency, status, expected_close_date, owner_id, notes)
  on public.sales_opportunities to authenticated;

-- Proposte e bozze: i campi AI (generated_by, ai_job_id, facts_used, warnings) sono solo server.
revoke insert, update on public.sales_proposals from authenticated;
grant insert (organization_id, lead_id, opportunity_id, title, variant, language, content)
  on public.sales_proposals to authenticated;
grant update (title, content, status, opportunity_id) on public.sales_proposals to authenticated;

revoke insert, update on public.message_drafts from authenticated;
grant insert (organization_id, lead_id, channel, variant, generation_id, subject, body)
  on public.message_drafts to authenticated;
grant update (subject, body, status) on public.message_drafts to authenticated;

revoke insert, update on public.follow_up_tasks from authenticated;
grant insert (organization_id, lead_id, proposal_id, opportunity_id, kind, title, notes, due_at, priority, assigned_to)
  on public.follow_up_tasks to authenticated;
grant update (title, notes, due_at, status, priority, assigned_to) on public.follow_up_tasks to authenticated;

-- Copilota: messaggi scritti solo dal server; l'utente può rinominare, archiviare o cancellare.
revoke insert, update, delete on public.ai_conversations, public.ai_messages from authenticated;
grant update (title, archived_at) on public.ai_conversations to authenticated;
grant delete on public.ai_conversations to authenticated;

alter table public.sales_profiles enable row level security;
alter table public.sales_opportunities enable row level security;
alter table public.sales_proposals enable row level security;
alter table public.message_drafts enable row level security;
alter table public.follow_up_tasks enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

create policy sales_profiles_select on public.sales_profiles for select to authenticated
  using (private.is_org_member(organization_id));
create policy sales_profiles_update on public.sales_profiles for update to authenticated
  using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));

do $$
declare t text;
begin
  foreach t in array array['sales_opportunities', 'sales_proposals', 'message_drafts', 'follow_up_tasks']
  loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (private.is_org_member(organization_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (private.is_org_member(organization_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (private.is_org_member(organization_id)) with check (private.is_org_member(organization_id))', t);
    execute format('create policy %1$s_delete on public.%1$I for delete to authenticated using (private.is_org_admin(organization_id))', t);
  end loop;
end $$;

-- Le conversazioni del copilota sono private: nemmeno gli admin leggono quelle dei colleghi.
create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(organization_id));
create policy ai_conversations_update on public.ai_conversations for update to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(organization_id))
  with check (user_id = (select auth.uid()) and private.is_org_member(organization_id));
create policy ai_conversations_delete on public.ai_conversations for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(organization_id));
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (private.is_org_member(organization_id) and exists (
    select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));

-- I job del copilota sono visibili solo a chi li ha avviati (contengono solo riferimenti, mai testo).
drop policy ai_jobs_select on public.ai_jobs;
create policy ai_jobs_select on public.ai_jobs for select to authenticated
  using (private.is_org_member(organization_id) and (task is distinct from 'copilot' or created_by = (select auth.uid())));
