-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Migrazione 0006: Campaign Manager & Automation Engine
--
-- Estende lo schema esistente senza duplicazioni né perdita di dati:
-- • contact_suppressions → suppression_entries (rinominata ed estesa; vista di compatibilità)
-- • campaign_leads       → campaign_recipients (rinominata ed estesa)
-- • campaigns            → stati di workflow, obiettivo, canale, contenuti, autorizzazione
-- Nuove tabelle: consent_records, communication_accounts (+ segreti server-only),
-- campaign_sequences, campaign_steps, outbound_messages, inbound_messages,
-- delivery_events, automation_workflows, automation_events, automation_jobs, notifications.
--
-- Principi:
-- • Il database è l'ultimo controllo prima di ogni invio (public.begin_send): stato
--   della campagna, idoneità del destinatario (paese/canale/finalità/base giuridica),
--   opposizioni, suppression list, consensi, connessione del provider e limiti.
-- • Un contatto trovato su Internet NON è automaticamente contattabile: senza consenso
--   registrato l'email promozionale è ammessa solo dove una regola nazionale lo prevede.
-- • Ogni opposizione, disiscrizione, bounce permanente, reclamo, risposta o revoca
--   della connessione ferma subito le sequenze interessate (trigger).
-- • Credenziali dei provider in una tabella senza alcun privilegio per i client.
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Tipi
-- ════════════════════════════════════════════════════════════════════════════
create type public.workflow_status as enum
  ('draft', 'pending_approval', 'scheduled', 'running', 'paused', 'completed', 'failed', 'cancelled');
create type public.campaign_goal as enum ('meeting', 'demo', 'proposal', 'awareness', 'reactivation', 'other');
create type public.outreach_channel as enum ('email', 'linkedin', 'whatsapp', 'phone');
create type public.recipient_status as enum ('pending', 'eligible', 'excluded', 'in_sequence', 'stopped', 'completed');
create type public.step_kind as enum ('email', 'ai_review', 'follow_up_email', 'opportunity_review');
create type public.outbound_status as enum
  ('queued', 'sending', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'cancelled', 'unknown');
create type public.outbound_kind as enum ('campaign', 'reply', 'test');
create type public.inbound_class as enum
  ('positive', 'question', 'neutral', 'not_interested', 'unsubscribe', 'out_of_office', 'needs_human', 'other');
create type public.consent_status as enum ('granted', 'withdrawn', 'objected');
create type public.communication_provider as enum ('resend', 'gmail', 'microsoft365');
create type public.account_status as enum ('pending', 'connected', 'error', 'revoked');
create type public.automation_trigger as enum
  ('lead_qualified', 'draft_approved', 'campaign_activated', 'message_delivered', 'reply_received',
   'appointment_scheduled', 'opportunity_updated', 'opt_out_registered');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'dead', 'cancelled');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Suppression list: contact_suppressions → suppression_entries
-- ════════════════════════════════════════════════════════════════════════════
alter table public.contact_suppressions rename to suppression_entries;
alter table public.suppression_entries drop constraint contact_suppressions_reason_check;
alter table public.suppression_entries
  add constraint suppression_entries_reason_check
    check (reason in ('opt_out', 'erasure_request', 'bounce', 'manual', 'unsubscribe', 'complaint')),
  add column source text not null default 'manual'
    check (source in ('manual', 'lead_update', 'erasure', 'unsubscribe_link', 'reply', 'provider_bounce', 'provider_complaint', 'import')),
  add column campaign_id uuid,
  add column note text check (note is null or char_length(note) <= 500);
alter index if exists contact_suppressions_pkey rename to suppression_entries_pkey;

-- Vista di compatibilità in sola lettura per codice e report esistenti.
create view public.contact_suppressions with (security_invoker = true) as
  select id, organization_id, email_hash, reason, created_by, created_at from public.suppression_entries;
revoke all on public.contact_suppressions from anon, authenticated;
grant select on public.contact_suppressions to authenticated;

-- Le funzioni esistenti puntano al nuovo nome.
create or replace function private.leads_contact_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
begin
  if new.email is not null and (tg_op = 'INSERT' or new.email is distinct from old.email) then
    v_hash := private.email_hash(new.email);
    if exists (select 1 from public.suppression_entries s
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

  if old.contact_status = 'suppressed' then
    if new.contact_status <> 'suppressed'
       or new.email is not null or new.phone is not null or new.contact_name is not null then
      raise exception 'suppressed contacts cannot be restored' using errcode = 'P0001';
    end if;
  end if;

  if old.contact_status = 'opted_out' and new.contact_status = 'active'
     and auth.uid() is not null and not private.is_org_admin(new.organization_id) then
    raise exception 'only organization admins can revert an opt-out' using errcode = '42501';
  end if;

  if new.contact_status = 'opted_out' and old.contact_status <> 'opted_out' then
    new.opted_out_at := now();
    if new.email is not null then
      insert into public.suppression_entries (organization_id, email_hash, reason, source, created_by)
      values (new.organization_id, private.email_hash(new.email), 'opt_out', 'lead_update', auth.uid())
      on conflict (organization_id, email_hash) do nothing;
    end if;
  elsif new.contact_status = 'active' and old.contact_status = 'opted_out' then
    new.opted_out_at := null;
    delete from public.suppression_entries
     where organization_id = new.organization_id
       and email_hash = private.email_hash(new.email)
       and reason = 'opt_out';
  end if;
  return new;
end $$;

-- Ora security definer (scrive anche la colonna "source", non scrivibile dai client):
-- l'appartenenza all'organizzazione è verificata esplicitamente.
create or replace function public.suppress_lead(p_lead_id uuid, p_reason text default 'erasure_request')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_lead public.leads;
begin
  if p_reason not in ('opt_out', 'erasure_request', 'bounce', 'manual') then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not private.is_org_member(v_lead.organization_id) then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_lead.email is not null then
    insert into public.suppression_entries (organization_id, email_hash, reason, source)
    values (v_lead.organization_id, private.email_hash(v_lead.email), p_reason, 'erasure')
    on conflict (organization_id, email_hash) do nothing;
  end if;
  update public.leads
     set contact_name = null, contact_role = null, email = null, phone = null, notes = null,
         contact_status = 'suppressed', suppressed_at = now()
   where id = p_lead_id;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Lead: tag (filtri dei destinatari)
-- ════════════════════════════════════════════════════════════════════════════
alter table public.leads add column tags text[] not null default '{}'
  check (cardinality(tags) <= 20 and array_position(tags, null) is null);
create index leads_tags_gin_idx on public.leads using gin (tags);
grant update (tags) on public.leads to authenticated;

-- Dati del mittente per l'informativa e il piè di pagina obbligatorio delle email.
alter table public.sales_profiles
  add column sender_legal_name text check (sender_legal_name is null or char_length(sender_legal_name) between 2 and 200),
  add column sender_address text check (sender_address is null or char_length(sender_address) between 5 and 300),
  add column privacy_policy_url text check (privacy_policy_url is null or privacy_policy_url ~* '^https://[^\s]+$'),
  add column email_signature text check (email_signature is null or char_length(email_signature) <= 1000);
grant update (sender_legal_name, sender_address, privacy_policy_url, email_signature) on public.sales_profiles to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Registro dei consensi e delle preferenze di comunicazione
-- ════════════════════════════════════════════════════════════════════════════
-- granted: consenso documentato · withdrawn: consenso revocato · objected: opposizione
-- per un canale specifico (preferenza), che non blocca necessariamente gli altri canali.
create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  channel public.outreach_channel not null,
  purpose text not null default 'b2b_prospecting' check (purpose in ('b2b_prospecting', 'newsletter', 'service')),
  status public.consent_status not null,
  evidence text not null check (char_length(btrim(evidence)) between 5 and 2000),
  evidence_url text check (evidence_url is null or evidence_url ~* '^https://[^\s]+$'),
  policy_version text check (policy_version is null or char_length(policy_version) <= 60),
  captured_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
create index consent_records_lead_idx on public.consent_records (organization_id, lead_id, channel, purpose, captured_at desc);

-- Stato corrente del consenso: vale l'ultima registrazione per lead/canale/finalità.
create or replace function private.consent_state(p_org uuid, p_lead uuid, p_channel public.outreach_channel, p_purpose text)
returns public.consent_status language sql stable security definer set search_path = '' as $$
  select c.status from public.consent_records c
   where c.organization_id = p_org and c.lead_id = p_lead and c.channel = p_channel and c.purpose = p_purpose
   order by c.captured_at desc, c.created_at desc limit 1;
$$;
revoke all on function private.consent_state(uuid, uuid, public.outreach_channel, text) from public;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Account di comunicazione (provider autorizzati)
-- ════════════════════════════════════════════════════════════════════════════
create table public.communication_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider public.communication_provider not null,
  label text not null check (char_length(btrim(label)) between 2 and 80),
  from_name text not null check (char_length(btrim(from_name)) between 2 and 80),
  from_email text not null check (from_email ~* '^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$'),
  reply_to text check (reply_to is null or reply_to ~* '^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$'),
  sending_domain text not null check (sending_domain ~* '^([a-z0-9-]+\.)+[a-z]{2,}$'),
  provider_domain_id text,
  domain_status text not null default 'not_started',
  dns_records jsonb not null default '[]'::jsonb,
  spf_status text not null default 'unknown' check (spf_status in ('unknown', 'pass', 'missing', 'fail')),
  dkim_status text not null default 'unknown' check (dkim_status in ('unknown', 'pass', 'missing', 'fail')),
  dmarc_status text not null default 'unknown' check (dmarc_status in ('unknown', 'pass', 'missing', 'fail')),
  dmarc_policy text,
  status public.account_status not null default 'pending',
  webhook_configured boolean not null default false,
  inbound_enabled boolean not null default false,
  daily_limit integer not null default 100 check (daily_limit between 1 and 5000),
  per_minute_limit integer not null default 10 check (per_minute_limit between 1 and 120),
  last_checked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (lower(split_part(from_email, '@', 2)) = lower(sending_domain)
         or lower(split_part(from_email, '@', 2)) like '%.' || lower(sending_domain))
);
create unique index communication_accounts_active_uidx on public.communication_accounts
  (organization_id, provider, lower(from_email)) where status <> 'revoked';

-- Credenziali cifrate (AES-256-GCM lato server). Nessun privilegio per i client.
create table public.communication_account_secrets (
  account_id uuid primary key references public.communication_accounts (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  api_key_ciphertext text,
  webhook_secret_ciphertext text,
  key_version smallint not null default 1,
  updated_at timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Campagne: stati di workflow e nuovi campi
-- ════════════════════════════════════════════════════════════════════════════
alter table public.campaigns alter column status drop default;
alter table public.campaigns alter column status type public.workflow_status using (
  case status::text
    when 'draft' then 'draft' when 'active' then 'running' when 'paused' then 'paused'
    when 'completed' then 'completed' else 'completed' end)::public.workflow_status;
alter table public.campaigns alter column status set default 'draft';
drop type public.campaign_status;

alter table public.campaigns
  add column goal public.campaign_goal not null default 'meeting',
  add column service_name text check (service_name is null or char_length(service_name) <= 160),
  add column language text not null default 'it' check (language in ('it', 'en')),
  add column channel public.outreach_channel not null default 'email',
  add column purpose text not null default 'b2b_prospecting' check (purpose in ('b2b_prospecting')),
  add column planned_start_at timestamptz,
  add column timezone text not null default 'Europe/Rome' check (char_length(timezone) between 3 and 60),
  add column send_hour_start smallint not null default 9 check (send_hour_start between 0 and 23),
  add column send_hour_end smallint not null default 18 check (send_hour_end between 1 and 24),
  add column weekdays_only boolean not null default true,
  add column audience_filters jsonb not null default '{}'::jsonb check (jsonb_typeof(audience_filters) = 'object'),
  add column account_id uuid,
  add column stop_on_appointment boolean not null default true,
  add column call_to_action text check (call_to_action is null or char_length(call_to_action) <= 300),
  add column content_approved_by uuid references auth.users (id) on delete set null,
  add column content_approved_at timestamptz,
  add column activated_by uuid references auth.users (id) on delete set null,
  add column activated_at timestamptz,
  add column activation_snapshot jsonb,
  add column paused_reason text check (paused_reason is null or char_length(paused_reason) <= 120),
  add column completed_at timestamptz,
  add column archived_at timestamptz,
  add constraint campaigns_account_fk foreign key (organization_id, account_id)
    references public.communication_accounts (organization_id, id) on delete set null (account_id),
  add constraint campaigns_send_window check (send_hour_end > send_hour_start);
create index campaigns_org_created_idx on public.campaigns (organization_id, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Sequenze e step
-- ════════════════════════════════════════════════════════════════════════════
create table public.campaign_sequences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  campaign_id uuid not null,
  name text not null default 'Sequenza principale' check (char_length(btrim(name)) between 2 and 120),
  -- Una risposta ferma sempre la sequenza del destinatario: non è configurabile.
  stop_on_reply boolean not null default true check (stop_on_reply),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (campaign_id),
  foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete cascade
);

create table public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sequence_id uuid not null,
  position smallint not null check (position between 0 and 9),
  day_offset smallint not null check (day_offset between 0 and 90),
  kind public.step_kind not null,
  subject text check (subject is null or char_length(subject) <= 200),
  body text check (body is null or char_length(body) <= 6000),
  ai_variants jsonb not null default '[]'::jsonb check (jsonb_typeof(ai_variants) = 'array'),
  ai_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(ai_warnings) = 'array'),
  ai_job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (sequence_id, position),
  foreign key (organization_id, sequence_id) references public.campaign_sequences (organization_id, id) on delete cascade,
  check (kind not in ('email', 'follow_up_email') or position = 0 or day_offset > 0),
  check (position > 0 or (kind = 'email' and day_offset = 0))
);

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Destinatari: campaign_leads → campaign_recipients
-- ════════════════════════════════════════════════════════════════════════════
alter table public.campaign_leads rename to campaign_recipients;
alter table public.campaign_recipients alter column status drop default;
alter table public.campaign_recipients alter column status type public.recipient_status using (
  case status::text
    when 'pending' then 'pending' when 'contacted' then 'in_sequence'
    when 'replied' then 'stopped' else 'excluded' end)::public.recipient_status;
alter table public.campaign_recipients alter column status set default 'pending';
drop type public.campaign_lead_status;
alter table public.campaign_recipients
  add column id uuid not null default gen_random_uuid(),
  add column eligible boolean,
  add column eligibility jsonb not null default '{}'::jsonb,
  add column exclusion_reasons text[] not null default '{}',
  add column evaluated_at timestamptz,
  add column current_position smallint,
  add column next_step_at timestamptz,
  add column last_message_at timestamptz,
  add column stopped_reason text check (stopped_reason is null or char_length(stopped_reason) <= 80),
  add column stopped_at timestamptz,
  add column completed_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint campaign_recipients_id_key unique (id),
  add constraint campaign_recipients_org_id_key unique (organization_id, id);
update public.campaign_recipients set stopped_reason = 'reply', stopped_at = now() where status = 'stopped';
alter index if exists campaign_leads_pkey rename to campaign_recipients_pkey;
create index campaign_recipients_due_idx on public.campaign_recipients (next_step_at) where status = 'in_sequence';
create index campaign_recipients_lead_idx on public.campaign_recipients (organization_id, lead_id);
create trigger campaign_recipients_updated_at before update on public.campaign_recipients
  for each row execute function public.set_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Messaggi in uscita, in arrivo ed eventi di consegna
-- ════════════════════════════════════════════════════════════════════════════
create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind public.outbound_kind not null,
  campaign_id uuid,
  recipient_id uuid,
  step_id uuid,
  lead_id uuid,
  account_id uuid not null,
  in_reply_to uuid,
  to_email text not null check (to_email ~* '^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$'),
  subject text not null check (char_length(subject) between 1 and 200),
  body_text text not null check (char_length(body_text) between 1 and 12000),
  status public.outbound_status not null default 'queued',
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 256),
  provider_message_id text,
  attempts smallint not null default 0,
  confirmed_by uuid references auth.users (id) on delete set null,
  scheduled_at timestamptz not null default now(),
  sending_started_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (idempotency_key),
  foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete cascade,
  foreign key (organization_id, recipient_id) references public.campaign_recipients (organization_id, id) on delete cascade,
  foreign key (organization_id, step_id) references public.campaign_steps (organization_id, id) on delete set null (step_id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, account_id) references public.communication_accounts (organization_id, id) on delete cascade,
  check (kind <> 'campaign' or (campaign_id is not null and recipient_id is not null and lead_id is not null)),
  check (kind <> 'reply' or lead_id is not null)
);
-- Deduplicazione: un solo messaggio per destinatario e step.
create unique index outbound_messages_step_uidx on public.outbound_messages (recipient_id, step_id) where kind = 'campaign';
create index outbound_messages_org_time_idx on public.outbound_messages (organization_id, created_at desc);
create index outbound_messages_lead_idx on public.outbound_messages (organization_id, lead_id, created_at desc);
create index outbound_messages_account_sent_idx on public.outbound_messages (account_id, sending_started_at)
  where status not in ('queued', 'cancelled');
create unique index outbound_messages_provider_uidx on public.outbound_messages (account_id, provider_message_id)
  where provider_message_id is not null;

create table public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  account_id uuid not null,
  provider_message_id text not null,
  lead_id uuid,
  recipient_id uuid,
  outbound_message_id uuid,
  from_email text not null check (char_length(from_email) <= 320),
  subject text check (subject is null or char_length(subject) <= 300),
  body_text text check (body_text is null or char_length(body_text) <= 20000),
  received_at timestamptz not null default now(),
  ai_classification public.inbound_class,
  ai_summary text check (ai_summary is null or char_length(ai_summary) <= 1500),
  ai_suggested_reply text check (ai_suggested_reply is null or char_length(ai_suggested_reply) <= 4000),
  ai_needs_human boolean,
  ai_job_id uuid,
  classification public.inbound_class,
  classification_confirmed_by uuid references auth.users (id) on delete set null,
  classification_confirmed_at timestamptz,
  handled_at timestamptz,
  handled_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (account_id, provider_message_id),
  foreign key (organization_id, account_id) references public.communication_accounts (organization_id, id) on delete cascade,
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id),
  foreign key (organization_id, recipient_id) references public.campaign_recipients (organization_id, id) on delete set null (recipient_id),
  foreign key (organization_id, outbound_message_id) references public.outbound_messages (organization_id, id) on delete set null (outbound_message_id)
);
create index inbound_messages_org_time_idx on public.inbound_messages (organization_id, received_at desc);
create index inbound_messages_lead_idx on public.inbound_messages (organization_id, lead_id, received_at desc);

alter table public.outbound_messages add constraint outbound_messages_reply_fk
  foreign key (organization_id, in_reply_to) references public.inbound_messages (organization_id, id) on delete set null (in_reply_to);

create table public.delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  account_id uuid not null,
  provider public.communication_provider not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 3 and 60),
  outbound_message_id uuid,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Idempotenza dei webhook: lo stesso evento del provider viene registrato una sola volta.
  unique (provider, provider_event_id),
  foreign key (organization_id, account_id) references public.communication_accounts (organization_id, id) on delete cascade,
  foreign key (organization_id, outbound_message_id) references public.outbound_messages (organization_id, id) on delete set null (outbound_message_id)
);
create index delivery_events_message_idx on public.delivery_events (outbound_message_id, occurred_at);

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Automazioni: workflow, eventi, job, notifiche
-- ════════════════════════════════════════════════════════════════════════════
create table public.automation_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  trigger public.automation_trigger not null,
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  actions jsonb not null check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) between 1 and 5),
  status public.workflow_status not null default 'draft',
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  run_count integer not null default 0,
  last_run_at timestamptz,
  last_error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (status in ('draft', 'pending_approval', 'running', 'paused', 'cancelled', 'failed'))
);

-- Azioni ammesse. L'invio NON è un'azione dei workflow: avviene solo negli step di
-- una campagna attivata esplicitamente, dopo i controlli di begin_send.
create or replace function private.valid_workflow_actions(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'array' and not exists (
    select 1 from jsonb_array_elements(p) a
     where jsonb_typeof(a) <> 'object'
        or (a ->> 'type') is null
        or (a ->> 'type') not in ('create_activity', 'notify', 'generate_draft', 'update_lead_status', 'create_reminder', 'prepare_follow_up')
        or ((a ->> 'type') = 'update_lead_status' and coalesce(a ->> 'status', '') not in
            ('new', 'to_qualify', 'qualified', 'to_contact', 'contacted', 'in_conversation', 'meeting_scheduled', 'proposal_sent', 'negotiation', 'not_contactable'))
        or ((a ->> 'type') = 'create_reminder' and coalesce((a ->> 'days')::int, -1) not between 0 and 90)
        or char_length(a::text) > 1000);
$$;
alter table public.automation_workflows add constraint automation_workflows_actions_valid
  check (private.valid_workflow_actions(actions));

create table public.automation_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type public.automation_trigger not null,
  lead_id uuid,
  campaign_id uuid,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index automation_events_pending_idx on public.automation_events (created_at) where processed_at is null;
create index automation_events_org_idx on public.automation_events (organization_id, created_at desc);

create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('run_step', 'send_message', 'run_action', 'ingest_inbound', 'analyze_inbound', 'generate_content')),
  idempotency_key text not null check (char_length(idempotency_key) between 4 and 300),
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'queued',
  run_at timestamptz not null default now(),
  attempts smallint not null default 0,
  max_attempts smallint not null default 5 check (max_attempts between 1 and 10),
  locked_until timestamptz,
  locked_by text,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  campaign_id uuid,
  workflow_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, idempotency_key)
);
create index automation_jobs_due_idx on public.automation_jobs (run_at) where status in ('queued', 'running');
create index automation_jobs_org_idx on public.automation_jobs (organization_id, status, created_at desc);
create index automation_jobs_campaign_idx on public.automation_jobs (campaign_id) where status in ('queued', 'running');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 2 and 200),
  body text check (body is null or char_length(body) <= 1000),
  link text check (link is null or link ~ '^/app/[A-Za-z0-9/_?=&.-]*$'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (organization_id, user_id, created_at desc);

-- Promemoria creati da sequenze e automazioni (deduplicati per destinatario/step e per job).
alter table public.follow_up_tasks drop constraint follow_up_tasks_source_check;
alter table public.follow_up_tasks add constraint follow_up_tasks_source_check check (source in ('cadence', 'manual', 'ai', 'campaign', 'automation'));
alter table public.follow_up_tasks
  add column campaign_recipient_id uuid,
  add column automation_job_id uuid;
create unique index follow_up_tasks_recipient_uidx on public.follow_up_tasks (campaign_recipient_id, kind) where campaign_recipient_id is not null;
create unique index follow_up_tasks_job_uidx on public.follow_up_tasks (automation_job_id) where automation_job_id is not null;

-- Job AI: contenuti di campagna e analisi delle risposte.
alter table public.ai_jobs drop constraint ai_jobs_task_check;
alter table public.ai_jobs add constraint ai_jobs_task_check check (task is null or task in
  ('business_analysis', 'intelligence', 'messages', 'proposal', 'follow_up_suggestion', 'copilot', 'campaign_content', 'inbound_analysis'));

-- Quote: email mensili per organizzazione.
alter table public.organization_quotas
  add column monthly_emails integer not null default 1000 check (monthly_emails >= 0);

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
           when 'email_sent' then q.monthly_emails
         end
    into v_limit
    from public.organization_quotas q where q.organization_id = p_org;
  if v_limit is null then raise exception 'unknown quota for event %', p_event using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_event, 0));
  select coalesce(sum(quantity), 0) into v_used from public.usage_events
   where organization_id = p_org and event_type = p_event and created_at >= v_month;

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

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Idoneità: paese × canale × finalità × base giuridica
-- ════════════════════════════════════════════════════════════════════════════
-- Regole prudenziali, NON un parere legale. Per l'email promozionale B2B:
-- • consenso registrato (consent_records) → ammessa ovunque;
-- • cliente esistente (base "contract") → soft opt-in, solo servizi analoghi e opt-out in ogni messaggio;
-- • legittimo interesse / dati professionali pubblici → ammessa SOLO in FR e GB, verso indirizzi
--   professionali e con oggetto pertinente al ruolo; altrove serve il consenso
--   (es. IT art. 130 Codice privacy, DE § 7 UWG, ES art. 21 LSSI);
-- • "consent" dichiarato sulla fonte senza prova registrata → non basta.
-- Canali senza invio dalla piattaforma: LinkedIn e telefono solo manuali; WhatsApp richiede opt-in.
create or replace function private.lead_eligibility(
  p_org uuid, p_lead uuid, p_channel public.outreach_channel, p_purpose text default 'b2b_prospecting'
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  l record;
  v_reasons text[] := '{}';
  v_warnings text[] := '{}';
  v_basis text;
  v_country text;
  v_consent public.consent_status;
begin
  if auth.uid() is not null and not private.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select le.id, le.email, le.phone, le.country, le.status, le.contact_status, le.deleted_at,
         s.id as source_id, s.legal_basis, s.type as source_type, s.acquired_at, o.country as org_country
    into l
    from public.leads le
    join public.organizations o on o.id = le.organization_id
    left join public.lead_sources s on s.organization_id = le.organization_id and s.id = le.source_id
   where le.organization_id = p_org and le.id = p_lead;
  if not found then
    return jsonb_build_object('eligible', false, 'reasons', jsonb_build_array('lead_not_found'), 'warnings', '[]'::jsonb);
  end if;

  v_country := coalesce(l.country, l.org_country, 'EU');

  -- Provenienza e base giuridica documentate
  if l.source_id is null then v_reasons := v_reasons || 'no_source'::text; end if;
  if l.legal_basis is null then v_reasons := v_reasons || 'no_legal_basis'::text; end if;
  -- Stato del contatto
  if l.deleted_at is not null then v_reasons := v_reasons || 'lead_deleted'::text; end if;
  if l.contact_status = 'opted_out' then v_reasons := v_reasons || 'opted_out'::text; end if;
  if l.contact_status = 'suppressed' then v_reasons := v_reasons || 'suppressed'::text; end if;
  if l.status = 'not_contactable' then v_reasons := v_reasons || 'not_contactable'::text; end if;
  if l.status in ('won', 'lost') then v_warnings := v_warnings || ('lead_' || l.status::text); end if;
  -- Suppression list (anche per contatti cancellati e reinseriti)
  if l.email is not null and exists (select 1 from public.suppression_entries se
      where se.organization_id = p_org and se.email_hash = private.email_hash(l.email)) then
    v_reasons := v_reasons || 'in_suppression_list'::text;
  end if;
  -- Preferenze e consensi per canale
  v_consent := private.consent_state(p_org, p_lead, p_channel, p_purpose);
  if v_consent = 'objected' then v_reasons := v_reasons || 'channel_objection'::text; end if;
  if v_consent = 'withdrawn' then v_reasons := v_reasons || 'consent_withdrawn'::text; end if;

  if p_channel = 'email' then
    if l.email is null then v_reasons := v_reasons || 'no_email'::text; end if;
    if v_consent = 'granted' then
      v_basis := 'consent';
    elsif l.legal_basis = 'contract' then
      v_basis := 'soft_opt_in';
      v_warnings := v_warnings || 'soft_opt_in_similar_services_only'::text;
    elsif l.legal_basis = 'consent' then
      v_reasons := v_reasons || 'consent_not_recorded'::text;
    elsif l.legal_basis in ('legitimate_interest', 'public_professional_data') then
      if v_country in ('FR', 'GB') then
        v_basis := 'legitimate_interest';
        v_warnings := v_warnings || ('li_country_rule_' || lower(v_country));
        v_warnings := v_warnings || 'li_professional_address_only'::text;
      else
        v_reasons := v_reasons || 'consent_required'::text;
      end if;
    end if;
  elsif p_channel = 'whatsapp' then
    if l.phone is null then v_reasons := v_reasons || 'no_phone'::text; end if;
    if v_consent is distinct from 'granted' then v_reasons := v_reasons || 'whatsapp_opt_in_required'::text; end if;
    v_basis := 'consent';
    v_warnings := v_warnings || 'manual_channel'::text;
  elsif p_channel = 'phone' then
    if l.phone is null then v_reasons := v_reasons || 'no_phone'::text; end if;
    v_basis := coalesce(case when v_consent = 'granted' then 'consent' end, l.legal_basis::text);
    v_warnings := v_warnings || 'manual_channel'::text || 'check_national_opt_out_register'::text;
  else -- linkedin
    v_basis := coalesce(case when v_consent = 'granted' then 'consent' end, l.legal_basis::text);
    v_warnings := v_warnings || 'manual_channel'::text || 'linkedin_no_automation'::text;
  end if;

  if l.legal_basis = 'public_professional_data' then
    v_warnings := v_warnings || 'public_data_not_consent'::text;
  end if;
  if l.legal_basis is not null and l.legal_basis <> 'consent' and v_consent is distinct from 'granted' then
    v_warnings := v_warnings || 'art14_notice_required'::text;
  end if;

  return jsonb_build_object(
    'eligible', cardinality(v_reasons) = 0,
    'basis', v_basis,
    'country', v_country,
    'channel', p_channel,
    'reasons', to_jsonb(v_reasons),
    'warnings', to_jsonb(v_warnings),
    'source_type', l.source_type,
    'source_basis', l.legal_basis,
    'checked_at', now());
end $$;
revoke all on function private.lead_eligibility(uuid, uuid, public.outreach_channel, text) from public;
grant execute on function private.lead_eligibility(uuid, uuid, public.outreach_channel, text) to authenticated, service_role;

-- Valuta (o rivaluta) tutti i destinatari di una campagna non ancora in sequenza.
create or replace function public.evaluate_campaign_recipients(p_campaign uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  r record;
  v_e jsonb;
  v_ok int := 0;
  v_ko int := 0;
begin
  select * into c from public.campaigns where id = p_campaign;
  if not found or not private.is_org_member(c.organization_id) then
    raise exception 'campaign not found' using errcode = 'P0002';
  end if;
  for r in select id, lead_id, status from public.campaign_recipients
            where campaign_id = p_campaign and status in ('pending', 'eligible', 'excluded') for update
  loop
    v_e := private.lead_eligibility(c.organization_id, r.lead_id, c.channel, c.purpose);
    update public.campaign_recipients
       set eligible = (v_e ->> 'eligible')::boolean,
           eligibility = v_e,
           exclusion_reasons = array(select jsonb_array_elements_text(v_e -> 'reasons')),
           evaluated_at = now(),
           status = case when (v_e ->> 'eligible')::boolean then 'eligible' else 'excluded' end::public.recipient_status
     where id = r.id;
    if (v_e ->> 'eligible')::boolean then v_ok := v_ok + 1; else v_ko := v_ko + 1; end if;
  end loop;
  return jsonb_build_object('eligible', v_ok, 'excluded', v_ko);
end $$;
revoke all on function public.evaluate_campaign_recipients(uuid) from public, anon;
grant execute on function public.evaluate_campaign_recipients(uuid) to authenticated, service_role;

-- Selezione dei destinatari dal CRM con filtri (max 2000 per campagna).
create or replace function public.add_campaign_recipients(p_campaign uuid, p_filters jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  v_added int;
  v_total int;
  f jsonb := coalesce(p_filters, '{}'::jsonb);
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or not private.is_org_member(c.organization_id) then
    raise exception 'campaign not found' using errcode = 'P0002';
  end if;
  if c.status not in ('draft', 'pending_approval') then
    raise exception 'campaign_locked: recipients can change only in draft' using errcode = 'P0001';
  end if;
  if c.status = 'pending_approval' then
    update public.campaigns set status = 'draft' where id = c.id;
  end if;

  with picked as (
    select l.id from public.leads l
     where l.organization_id = c.organization_id and l.deleted_at is null
       and (f -> 'lead_ids' is null or l.id in (select (x)::uuid from jsonb_array_elements_text(f -> 'lead_ids') x))
       and (f -> 'industries' is null or lower(coalesce(l.industry, '')) in (select lower(x) from jsonb_array_elements_text(f -> 'industries') x))
       and (f -> 'countries' is null or l.country in (select x from jsonb_array_elements_text(f -> 'countries') x))
       and (f -> 'cities' is null or lower(coalesce(l.city, '')) in (select lower(x) from jsonb_array_elements_text(f -> 'cities') x))
       and (f -> 'statuses' is null or l.status::text in (select x from jsonb_array_elements_text(f -> 'statuses') x))
       and (f -> 'source_ids' is null or l.source_id in (select (x)::uuid from jsonb_array_elements_text(f -> 'source_ids') x))
       and (f -> 'tags' is null or l.tags && array(select x from jsonb_array_elements_text(f -> 'tags') x))
       and (f ->> 'min_score' is null or coalesce(l.score, 0) >= (f ->> 'min_score')::int)
     order by l.score desc nulls last, l.created_at
     limit 2000
  ), ins as (
    insert into public.campaign_recipients (organization_id, campaign_id, lead_id)
    select c.organization_id, c.id, p.id from picked p
    on conflict (campaign_id, lead_id) do nothing
    returning 1
  )
  select count(*) into v_added from ins;

  select count(*) into v_total from public.campaign_recipients where campaign_id = c.id;
  if v_total > 2000 then
    raise exception 'too_many_recipients: max 2000 per campaign' using errcode = '22023';
  end if;
  update public.campaigns set audience_filters = f - 'lead_ids' where id = c.id;
  perform public.evaluate_campaign_recipients(c.id);
  return jsonb_build_object('added', v_added, 'total', v_total);
end $$;
revoke all on function public.add_campaign_recipients(uuid, jsonb) from public, anon;
grant execute on function public.add_campaign_recipients(uuid, jsonb) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Eventi di automazione e arresto immediato delle sequenze
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.emit_event(
  p_org uuid, p_type public.automation_trigger, p_entity_type text, p_entity_id text,
  p_lead uuid default null, p_campaign uuid default null, p_payload jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = '' as $$
  insert into public.automation_events (organization_id, type, entity_type, entity_id, lead_id, campaign_id, payload)
  values (p_org, p_type, p_entity_type, p_entity_id, p_lead, p_campaign, coalesce(p_payload, '{}'::jsonb));
$$;
revoke all on function private.emit_event(uuid, public.automation_trigger, text, text, uuid, uuid, jsonb) from public;

-- Ferma le sequenze attive di un lead (per tutte le campagne o per un canale) e
-- annulla i messaggi e i job non ancora partiti.
create or replace function private.stop_lead_sequences(p_org uuid, p_lead uuid, p_reason text, p_channel public.outreach_channel default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(r.id), '{}') into v_ids
    from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id
   where r.organization_id = p_org and r.lead_id = p_lead
     and r.status in ('pending', 'eligible', 'in_sequence')
     and (p_channel is null or c.channel = p_channel);
  if cardinality(v_ids) = 0 then return 0; end if;
  update public.campaign_recipients
     set status = case when status = 'in_sequence' then 'stopped' else 'excluded' end::public.recipient_status,
         stopped_reason = p_reason, stopped_at = now(), next_step_at = null,
         eligible = case when status = 'in_sequence' then eligible else false end,
         exclusion_reasons = case when status = 'in_sequence' then exclusion_reasons else array_append(exclusion_reasons, p_reason) end
   where id = any (v_ids);
  update public.outbound_messages set status = 'cancelled', last_error = 'stopped:' || p_reason
   where recipient_id = any (v_ids) and status = 'queued';
  update public.automation_jobs set status = 'cancelled', last_error = 'stopped:' || p_reason, finished_at = now()
   where organization_id = p_org and status = 'queued' and (payload ->> 'recipient_id')::uuid = any (v_ids);
  return cardinality(v_ids);
end $$;
revoke all on function private.stop_lead_sequences(uuid, uuid, text, public.outreach_channel) from public;

-- Lead: qualificazione e opposizione
create or replace function private.leads_automation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'qualified' and old.status is distinct from 'qualified' then
    perform private.emit_event(new.organization_id, 'lead_qualified', 'lead', new.id::text, new.id);
  end if;
  if new.contact_status in ('opted_out', 'suppressed') and old.contact_status = 'active' then
    perform private.stop_lead_sequences(new.organization_id, new.id, 'opt_out');
    perform private.emit_event(new.organization_id, 'opt_out_registered', 'lead', new.id::text, new.id,
      null, jsonb_build_object('contact_status', new.contact_status));
  end if;
  if new.status = 'not_contactable' and old.status is distinct from 'not_contactable' then
    perform private.stop_lead_sequences(new.organization_id, new.id, 'not_contactable');
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    perform private.stop_lead_sequences(new.organization_id, new.id, 'lead_deleted');
  end if;
  return new;
end $$;
create trigger leads_automation after update on public.leads
  for each row execute function private.leads_automation();

-- Consensi revocati/opposizioni di canale
create or replace function private.consent_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('withdrawn', 'objected') then
    perform private.stop_lead_sequences(new.organization_id, new.lead_id,
      case when new.status = 'withdrawn' then 'consent_withdrawn' else 'channel_objection' end, new.channel);
    perform private.emit_event(new.organization_id, 'opt_out_registered', 'consent_record', new.id::text, new.lead_id,
      null, jsonb_build_object('channel', new.channel, 'status', new.status));
  end if;
  perform private.write_audit(new.organization_id, 'consent.' || new.status::text, 'lead', new.lead_id::text,
    jsonb_build_object('channel', new.channel, 'purpose', new.purpose));
  return new;
end $$;
create trigger consent_records_after after insert on public.consent_records
  for each row execute function private.consent_after();

-- Nuove voci di suppression list (bounce, reclamo, disiscrizione): stop su tutti i lead con quell'hash.
create or replace function private.suppression_after()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_lead uuid;
begin
  for v_lead in select id from public.leads
                 where organization_id = new.organization_id and email is not null
                   and private.email_hash(email) = new.email_hash
  loop
    perform private.stop_lead_sequences(new.organization_id, v_lead,
      case when new.reason in ('opt_out', 'unsubscribe') then new.reason else 'suppressed_' || new.reason end);
  end loop;
  perform private.write_audit(new.organization_id, 'suppression.added', 'suppression_entry', new.id::text,
    jsonb_build_object('reason', new.reason, 'source', new.source));
  return new;
end $$;
create trigger suppression_entries_after after insert on public.suppression_entries
  for each row execute function private.suppression_after();

-- Bozze e proposte approvate
create or replace function private.drafts_automation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform private.emit_event(new.organization_id, 'draft_approved', tg_table_name, new.id::text, new.lead_id);
  end if;
  return new;
end $$;
create trigger message_drafts_automation after update on public.message_drafts
  for each row execute function private.drafts_automation();
create trigger sales_proposals_automation after update on public.sales_proposals
  for each row execute function private.drafts_automation();

-- Opportunità aggiornate
create or replace function private.opportunities_automation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.value_amount is distinct from old.value_amount then
    perform private.emit_event(new.organization_id, 'opportunity_updated', 'sales_opportunity', new.id::text, new.lead_id,
      null, jsonb_build_object('status', new.status));
  end if;
  return new;
end $$;
create trigger sales_opportunities_automation after insert or update on public.sales_opportunities
  for each row execute function private.opportunities_automation();

-- Appuntamenti: evento + stop delle sequenze configurate per fermarsi
create or replace function private.appointments_automation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if new.lead_id is null then return new; end if;
  perform private.emit_event(new.organization_id, 'appointment_scheduled', 'appointment', new.id::text, new.lead_id);
  for r in select cr.id from public.campaign_recipients cr join public.campaigns c on c.id = cr.campaign_id
            where cr.organization_id = new.organization_id and cr.lead_id = new.lead_id
              and cr.status = 'in_sequence' and c.stop_on_appointment
  loop
    update public.campaign_recipients set status = 'stopped', stopped_reason = 'appointment', stopped_at = now(), next_step_at = null
     where id = r.id;
    update public.outbound_messages set status = 'cancelled', last_error = 'stopped:appointment'
     where recipient_id = r.id and status = 'queued';
  end loop;
  return new;
end $$;
create trigger appointments_automation after insert on public.appointments
  for each row execute function private.appointments_automation();

-- Risposte ricevute: stop della sequenza del destinatario, evento, attività CRM
create or replace function private.inbound_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.recipient_id is not null then
    update public.campaign_recipients set status = 'stopped', stopped_reason = 'reply', stopped_at = now(), next_step_at = null
     where id = new.recipient_id and status = 'in_sequence';
    update public.outbound_messages set status = 'cancelled', last_error = 'stopped:reply'
     where recipient_id = new.recipient_id and status = 'queued';
  end if;
  if new.lead_id is not null then
    perform private.log_activity(new.organization_id, new.lead_id, 'email',
      'Risposta ricevuta: ' || coalesce(left(new.subject, 200), '(senza oggetto)'),
      jsonb_build_object('inbound_message_id', new.id));
    if exists (select 1 from public.leads where id = new.lead_id and status in ('contacted', 'to_contact', 'qualified', 'to_qualify', 'new')) then
      update public.leads set status = 'in_conversation' where id = new.lead_id and contact_status = 'active';
    end if;
  end if;
  perform private.emit_event(new.organization_id, 'reply_received', 'inbound_message', new.id::text, new.lead_id,
    (select campaign_id from public.campaign_recipients where id = new.recipient_id));
  return new;
end $$;
create trigger inbound_messages_after after insert on public.inbound_messages
  for each row execute function private.inbound_after();

-- Classificazione confermata da una persona come "disiscrizione" → opposizione.
create or replace function private.inbound_classification_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.classification = 'unsubscribe' and old.classification is distinct from 'unsubscribe' and new.lead_id is not null then
    update public.leads set contact_status = 'opted_out' where id = new.lead_id and contact_status = 'active';
  end if;
  return new;
end $$;
create trigger inbound_messages_classification after update of classification on public.inbound_messages
  for each row execute function private.inbound_classification_after();

-- Esiti di consegna: aggiornano il messaggio; bounce permanenti e reclami entrano nella suppression list.
create or replace function private.outbound_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = old.status then return new; end if;
  if new.kind = 'campaign' and new.status in ('sent', 'delivered') and old.status in ('queued', 'sending', 'unknown') then
    update public.campaign_recipients set last_message_at = coalesce(new.sent_at, now()) where id = new.recipient_id;
    perform private.log_activity(new.organization_id, new.lead_id, 'email',
      'Email di campagna inviata: ' || left(new.subject, 200),
      jsonb_build_object('outbound_message_id', new.id, 'campaign_id', new.campaign_id));
    update public.leads set status = 'contacted'
     where id = new.lead_id and status in ('new', 'to_qualify', 'qualified', 'to_contact');
  end if;
  if new.status = 'delivered' then
    perform private.emit_event(new.organization_id, 'message_delivered', 'outbound_message', new.id::text, new.lead_id, new.campaign_id);
  end if;
  if new.status in ('bounced', 'complained') then
    insert into public.suppression_entries (organization_id, email_hash, reason, source, campaign_id)
    values (new.organization_id, private.email_hash(new.to_email),
            case when new.status = 'bounced' then 'bounce' else 'complaint' end,
            case when new.status = 'bounced' then 'provider_bounce' else 'provider_complaint' end, new.campaign_id)
    on conflict (organization_id, email_hash) do nothing;
    if new.status = 'complained' and new.lead_id is not null then
      update public.leads set contact_status = 'opted_out' where id = new.lead_id and contact_status = 'active';
    end if;
  end if;
  return new;
end $$;
create trigger outbound_messages_after after update on public.outbound_messages
  for each row execute function private.outbound_after();

-- Revoca o errore della connessione: le campagne che la usano vengono sospese.
create or replace function private.accounts_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('revoked', 'error') and old.status = 'connected' then
    perform set_config('leadflow.campaign_transition', 'on', true);
    update public.campaigns set status = 'paused', paused_reason = 'connection_' || new.status::text
     where account_id = new.id and status in ('running', 'scheduled');
    perform set_config('leadflow.campaign_transition', '', true);
    update public.outbound_messages set status = 'cancelled', last_error = 'connection_' || new.status::text
     where account_id = new.id and status = 'queued';
    update public.automation_jobs set status = 'cancelled', last_error = 'connection_' || new.status::text, finished_at = now()
     where organization_id = new.organization_id and status = 'queued' and payload ->> 'account_id' = new.id::text;
  end if;
  perform private.write_audit(new.organization_id, 'communication_account.' || new.status::text, 'communication_account',
    new.id::text, jsonb_build_object('provider', new.provider, 'from_email', new.from_email));
  return new;
end $$;
create trigger communication_accounts_after after update of status on public.communication_accounts
  for each row when (new.status is distinct from old.status)
  execute function private.accounts_after();

-- ════════════════════════════════════════════════════════════════════════════
-- 13. Campagne: sequenza predefinita, guardie e transizioni di stato
-- ════════════════════════════════════════════════════════════════════════════
create or replace function private.campaigns_init()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_seq uuid;
  v_days int[];
begin
  select follow_up_days into v_days from public.sales_profiles where organization_id = new.organization_id;
  v_days := coalesce(v_days, '{3,7,14}');
  insert into public.campaign_sequences (organization_id, campaign_id) values (new.organization_id, new.id)
  returning id into v_seq;
  insert into public.campaign_steps (organization_id, sequence_id, position, day_offset, kind) values
    (new.organization_id, v_seq, 0, 0, 'email'),
    (new.organization_id, v_seq, 1, v_days[1], 'ai_review'),
    (new.organization_id, v_seq, 2, v_days[least(2, cardinality(v_days))], 'follow_up_email'),
    (new.organization_id, v_seq, 3, v_days[cardinality(v_days)], 'opportunity_review');
  perform private.write_audit(new.organization_id, 'campaign.created', 'campaign', new.id::text);
  return new;
end $$;
create trigger campaigns_init after insert on public.campaigns
  for each row execute function private.campaigns_init();

-- Lo stato cambia solo tramite public.campaign_transition; i contenuti solo in bozza.
create or replace function private.campaigns_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' and auth.uid() is not null then
      raise exception 'campaigns start as draft' using errcode = '22023';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status and coalesce(current_setting('leadflow.campaign_transition', true), '') <> 'on' then
    raise exception 'campaign status changes only through campaign_transition' using errcode = '42501';
  end if;
  if old.status not in ('draft', 'pending_approval') and coalesce(current_setting('leadflow.campaign_transition', true), '') <> 'on'
     and (new.name, new.goal, new.channel, new.language, new.account_id, new.call_to_action, new.service_name, new.purpose,
          new.send_hour_start, new.send_hour_end, new.weekdays_only, new.timezone, new.stop_on_appointment)
         is distinct from
         (old.name, old.goal, old.channel, old.language, old.account_id, old.call_to_action, old.service_name, old.purpose,
          old.send_hour_start, old.send_hour_end, old.weekdays_only, old.timezone, old.stop_on_appointment) then
    raise exception 'campaign_locked: settings can change only in draft' using errcode = 'P0001';
  end if;
  -- Modifiche durante l'approvazione: si torna in bozza (serve una nuova revisione).
  if old.status = 'pending_approval' and new.status = 'pending_approval'
     and coalesce(current_setting('leadflow.campaign_transition', true), '') <> 'on'
     and (new.name, new.goal, new.channel, new.language, new.account_id, new.call_to_action, new.purpose, new.planned_start_at)
         is distinct from (old.name, old.goal, old.channel, old.language, old.account_id, old.call_to_action, old.purpose, old.planned_start_at) then
    new.status := 'draft';
    new.content_approved_at := null;
    new.content_approved_by := null;
  end if;
  if new.channel is distinct from old.channel then
    update public.campaign_recipients set status = 'pending', eligible = null where campaign_id = new.id and status in ('eligible', 'excluded');
  end if;
  return new;
end $$;
create trigger campaigns_guard before insert or update on public.campaigns
  for each row execute function private.campaigns_guard();

-- Le campagne che hanno inviato messaggi non si cancellano (prova degli invii e delle
-- opposizioni): si archiviano. Si cancellano solo bozze mai inviate.
create or replace function private.campaigns_delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and (old.status not in ('draft', 'pending_approval')
     or exists (select 1 from public.outbound_messages where campaign_id = old.id)) then
    raise exception 'campaign_not_deletable: archive it instead' using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger campaigns_delete_guard before delete on public.campaigns
  for each row execute function private.campaigns_delete_guard();

create or replace function private.steps_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.workflow_status;
  v_campaign uuid;
begin
  select c.status, c.id into v_status, v_campaign from public.campaign_sequences s join public.campaigns c on c.id = s.campaign_id
   where s.id = coalesce(new.sequence_id, old.sequence_id);
  if v_status not in ('draft', 'pending_approval') and coalesce(current_setting('leadflow.campaign_transition', true), '') <> 'on' then
    raise exception 'campaign_locked: content can change only in draft' using errcode = 'P0001';
  end if;
  if v_status = 'pending_approval' and coalesce(current_setting('leadflow.campaign_transition', true), '') <> 'on' then
    perform set_config('leadflow.campaign_transition', 'on', true);
    update public.campaigns set status = 'draft', content_approved_at = null, content_approved_by = null where id = v_campaign;
    perform set_config('leadflow.campaign_transition', '', true);
  end if;
  return coalesce(new, old);
end $$;
create trigger campaign_steps_guard before insert or update or delete on public.campaign_steps
  for each row execute function private.steps_guard();

-- I destinatari si rimuovono solo prima dell'attivazione (dopo restano come prova degli invii).
create or replace function private.recipients_delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and exists (select 1 from public.campaigns c where c.id = old.campaign_id and c.status not in ('draft', 'pending_approval')) then
    raise exception 'campaign_locked: recipients can change only in draft' using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger campaign_recipients_delete_guard before delete on public.campaign_recipients
  for each row execute function private.recipients_delete_guard();

-- Sostituisce i segnaposto consentiti. Nessun altro segnaposto viene interpretato.
create or replace function private.render_template(p_text text, p_lead uuid, p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  l record;
  v text := coalesce(p_text, '');
begin
  select company_name, city, industry, contact_name into l from public.leads where id = p_lead and organization_id = p_org;
  v := replace(v, '{{azienda}}', coalesce(l.company_name, ''));
  v := replace(v, '{{company_name}}', coalesce(l.company_name, ''));
  v := replace(v, '{{citta}}', coalesce(l.city, ''));
  v := replace(v, '{{city}}', coalesce(l.city, ''));
  v := replace(v, '{{settore}}', coalesce(l.industry, ''));
  v := replace(v, '{{industry}}', coalesce(l.industry, ''));
  v := replace(v, '{{nome}}', coalesce(split_part(l.contact_name, ' ', 1), ''));
  v := replace(v, '{{first_name}}', coalesce(split_part(l.contact_name, ' ', 1), ''));
  return v;
end $$;
revoke all on function private.render_template(text, uuid, uuid) from public;

-- Controllo di prontezza della campagna (usato dalla revisione e dall'attivazione).
create or replace function public.campaign_readiness(p_campaign uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c public.campaigns;
  a public.communication_accounts;
  sp public.sales_profiles;
  v_issues text[] := '{}';
  v_warnings text[] := '{}';
  v_eligible int;
  v_excluded int;
  v_pending int;
  v_quota int;
  v_used bigint;
begin
  select * into c from public.campaigns where id = p_campaign;
  if not found or not (private.is_org_member(c.organization_id) or auth.uid() is null) then
    raise exception 'campaign not found' using errcode = 'P0002';
  end if;
  select * into sp from public.sales_profiles where organization_id = c.organization_id;
  select count(*) filter (where status = 'eligible'), count(*) filter (where status = 'excluded'), count(*) filter (where status = 'pending')
    into v_eligible, v_excluded, v_pending from public.campaign_recipients where campaign_id = c.id;

  if v_eligible = 0 then v_issues := v_issues || 'no_eligible_recipients'::text; end if;
  if v_pending > 0 then v_issues := v_issues || 'recipients_not_evaluated'::text; end if;
  if exists (select 1 from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id
              where s.campaign_id = c.id and st.kind in ('email', 'follow_up_email')
                and (coalesce(btrim(st.subject), '') = '' or coalesce(btrim(st.body), '') = '')) then
    v_issues := v_issues || 'content_missing'::text;
  end if;
  if exists (select 1 from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id
              where s.campaign_id = c.id and st.body ~ '\{\{(?!(azienda|company_name|citta|city|settore|industry|nome|first_name)\}\})[^}]*\}\}') then
    v_issues := v_issues || 'unknown_placeholder'::text;
  end if;
  if sp.sender_legal_name is null or sp.sender_address is null or sp.privacy_policy_url is null then
    v_issues := v_issues || 'sender_identity_missing'::text;
  end if;

  if c.channel <> 'email' then
    v_issues := v_issues || 'channel_manual_only'::text;
  else
    if c.account_id is null then
      v_issues := v_issues || 'no_provider'::text;
    else
      select * into a from public.communication_accounts where id = c.account_id;
      if a.status <> 'connected' then v_issues := v_issues || 'provider_not_connected'::text; end if;
      if a.domain_status <> 'verified' then v_issues := v_issues || 'domain_not_verified'::text; end if;
      if a.dmarc_status <> 'pass' then v_warnings := v_warnings || 'dmarc_missing'::text; end if;
      if not a.webhook_configured then v_warnings := v_warnings || 'webhook_not_configured'::text; end if;
    end if;
  end if;

  select monthly_emails into v_quota from public.organization_quotas where organization_id = c.organization_id;
  select coalesce(sum(quantity), 0) into v_used from public.usage_events
   where organization_id = c.organization_id and event_type = 'email_sent' and created_at >= date_trunc('month', now());
  if v_eligible > (coalesce(v_quota, 0) - v_used) then v_warnings := v_warnings || 'quota_insufficient'::text; end if;
  if exists (select 1 from public.campaign_recipients where campaign_id = c.id and status = 'eligible'
              and eligibility -> 'warnings' ? 'art14_notice_required') then
    v_warnings := v_warnings || 'art14_notice_required'::text;
  end if;
  if exists (select 1 from public.campaign_recipients where campaign_id = c.id and status = 'eligible'
              and (eligibility ->> 'basis') = 'legitimate_interest') then
    v_warnings := v_warnings || 'legitimate_interest_review'::text;
  end if;

  return jsonb_build_object(
    'can_activate', cardinality(v_issues) = 0,
    'can_submit', cardinality(array_remove(array_remove(array_remove(array_remove(v_issues,
        'no_provider'), 'provider_not_connected'), 'domain_not_verified'), 'channel_manual_only')) = 0,
    'issues', to_jsonb(v_issues), 'warnings', to_jsonb(v_warnings),
    'eligible', v_eligible, 'excluded', v_excluded, 'pending', v_pending,
    'emails_remaining_month', coalesce(v_quota, 0) - v_used,
    'estimated_messages', v_eligible * (select count(*) from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id
                                         where s.campaign_id = c.id and st.kind in ('email', 'follow_up_email')));
end $$;
revoke all on function public.campaign_readiness(uuid) from public, anon;
grant execute on function public.campaign_readiness(uuid) to authenticated, service_role;

-- Transizioni di stato. L'attivazione richiede un admin e una conferma esplicita
-- che riporta il numero di destinatari idonei visto in revisione (niente approvazioni "stale").
create or replace function public.campaign_transition(p_campaign uuid, p_action text, p_confirmation jsonb default '{}'::jsonb)
returns public.campaigns language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  v_ready jsonb;
  v_start timestamptz;
  v_uid uuid := auth.uid();
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or not private.is_org_member(c.organization_id) then
    raise exception 'campaign not found' using errcode = 'P0002';
  end if;
  perform set_config('leadflow.campaign_transition', 'on', true);

  if p_action = 'submit' then
    if c.status <> 'draft' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    perform public.evaluate_campaign_recipients(c.id);
    v_ready := public.campaign_readiness(c.id);
    if not (v_ready ->> 'can_submit')::boolean then
      raise exception 'campaign_not_ready: %', v_ready ->> 'issues' using errcode = 'P0001';
    end if;
    update public.campaigns set status = 'pending_approval' where id = c.id returning * into c;

  elsif p_action = 'back_to_draft' then
    if c.status not in ('pending_approval', 'scheduled') then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.campaigns set status = 'draft', content_approved_at = null, content_approved_by = null where id = c.id returning * into c;

  elsif p_action = 'activate' then
    if not private.is_org_admin(c.organization_id) then
      raise exception 'only organization admins can activate campaigns' using errcode = '42501';
    end if;
    if c.status <> 'pending_approval' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if coalesce((p_confirmation ->> 'confirm')::boolean, false) is not true
       or coalesce((p_confirmation ->> 'compliance_acknowledged')::boolean, false) is not true then
      raise exception 'explicit_confirmation_required' using errcode = '22023';
    end if;
    perform public.evaluate_campaign_recipients(c.id);
    v_ready := public.campaign_readiness(c.id);
    if not (v_ready ->> 'can_activate')::boolean then
      raise exception 'campaign_not_ready: %', v_ready ->> 'issues' using errcode = 'P0001';
    end if;
    if (p_confirmation ->> 'expected_recipients')::int is distinct from (v_ready ->> 'eligible')::int then
      raise exception 'recipients_changed: review again' using errcode = 'P0001';
    end if;
    v_start := greatest(now(), coalesce(c.planned_start_at, now()));
    update public.campaigns
       set status = case when v_start > now() + interval '1 minute' then 'scheduled' else 'running' end::public.workflow_status,
           content_approved_by = v_uid, content_approved_at = now(),
           activated_by = v_uid, activated_at = now(),
           activation_snapshot = v_ready || jsonb_build_object('confirmed_by', v_uid, 'confirmed_at', now(),
             'steps', (select jsonb_agg(jsonb_build_object('position', st.position, 'day_offset', st.day_offset, 'kind', st.kind,
                         'subject_md5', md5(coalesce(st.subject, '')), 'body_md5', md5(coalesce(st.body, ''))) order by st.position)
                       from public.campaign_steps st join public.campaign_sequences s on s.id = st.sequence_id where s.campaign_id = c.id)),
           paused_reason = null
     where id = c.id returning * into c;
    update public.campaign_recipients set status = 'in_sequence', current_position = -1, next_step_at = v_start
     where campaign_id = c.id and status = 'eligible';
    perform private.emit_event(c.organization_id, 'campaign_activated', 'campaign', c.id::text, null, c.id);

  elsif p_action = 'pause' then
    if c.status not in ('running', 'scheduled') then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.campaigns set status = 'paused', paused_reason = 'manual' where id = c.id returning * into c;
    update public.automation_jobs set status = 'cancelled', last_error = 'campaign_paused', finished_at = now()
     where campaign_id = c.id and status = 'queued';

  elsif p_action = 'resume' then
    if c.status <> 'paused' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if not private.is_org_admin(c.organization_id) then
      raise exception 'only organization admins can resume campaigns' using errcode = '42501';
    end if;
    v_ready := public.campaign_readiness(c.id);
    if c.channel = 'email' and (v_ready -> 'issues') ?| array['provider_not_connected', 'domain_not_verified', 'no_provider', 'sender_identity_missing'] then
      raise exception 'campaign_not_ready: %', v_ready ->> 'issues' using errcode = 'P0001';
    end if;
    update public.campaigns set status = 'running', paused_reason = null where id = c.id returning * into c;
    -- I destinatari che erano in coda ripartono dal prossimo step (con nuovi controlli).
    update public.campaign_recipients set next_step_at = greatest(coalesce(next_step_at, now()), now())
     where campaign_id = c.id and status = 'in_sequence';
    update public.outbound_messages set status = 'cancelled', last_error = 'campaign_paused'
     where campaign_id = c.id and status = 'queued';

  elsif p_action = 'cancel' then
    if c.status in ('completed', 'cancelled') then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if c.status in ('running', 'scheduled', 'paused') and not private.is_org_admin(c.organization_id) then
      raise exception 'only organization admins can cancel active campaigns' using errcode = '42501';
    end if;
    update public.campaigns set status = 'cancelled', completed_at = now() where id = c.id returning * into c;
    update public.campaign_recipients set status = 'stopped', stopped_reason = 'campaign_cancelled', stopped_at = now(), next_step_at = null
     where campaign_id = c.id and status = 'in_sequence';
    update public.outbound_messages set status = 'cancelled', last_error = 'campaign_cancelled'
     where campaign_id = c.id and status = 'queued';
    update public.automation_jobs set status = 'cancelled', last_error = 'campaign_cancelled', finished_at = now()
     where campaign_id = c.id and status = 'queued';

  elsif p_action = 'archive' then
    if c.status not in ('completed', 'cancelled', 'failed', 'draft') then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.campaigns set archived_at = now() where id = c.id returning * into c;
  else
    raise exception 'unknown action' using errcode = '22023';
  end if;

  perform private.write_audit(c.organization_id, 'campaign.' || p_action, 'campaign', c.id::text,
    jsonb_build_object('status', c.status) || coalesce(case when p_action = 'activate' then
      jsonb_build_object('eligible', v_ready -> 'eligible', 'warnings', v_ready -> 'warnings') end, '{}'::jsonb));
  perform set_config('leadflow.campaign_transition', '', true);
  return c;
end $$;
revoke all on function public.campaign_transition(uuid, text, jsonb) from public, anon;
grant execute on function public.campaign_transition(uuid, text, jsonb) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 14. Motore dei job (solo service_role)
-- ════════════════════════════════════════════════════════════════════════════
-- Attiva le campagne programmate e crea un job idempotente per ogni step in scadenza.
create or replace function public.schedule_due_steps(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count int := 0;
  r record;
  v_next record;
begin
  perform set_config('leadflow.campaign_transition', 'on', true);
  update public.campaigns set status = 'running'
   where status = 'scheduled' and coalesce(planned_start_at, now()) <= now();
  perform set_config('leadflow.campaign_transition', '', true);

  for r in
    select cr.id, cr.organization_id, cr.campaign_id, cr.current_position, c.account_id, s.id as sequence_id
      from public.campaign_recipients cr
      join public.campaigns c on c.id = cr.campaign_id
      join public.campaign_sequences s on s.campaign_id = c.id
     where cr.status = 'in_sequence' and cr.next_step_at <= now() and c.status = 'running'
     order by cr.next_step_at
     limit greatest(1, least(p_limit, 2000))
     for update of cr skip locked
  loop
    select st.* into v_next from public.campaign_steps st
     where st.sequence_id = r.sequence_id and st.position > coalesce(r.current_position, -1)
     order by st.position limit 1;
    if not found then
      update public.campaign_recipients set status = 'completed', completed_at = now(), next_step_at = null where id = r.id;
      continue;
    end if;
    insert into public.automation_jobs (organization_id, kind, idempotency_key, payload, campaign_id)
    values (r.organization_id, 'run_step', 'step:' || r.id || ':' || v_next.position,
            jsonb_build_object('recipient_id', r.id, 'step_id', v_next.id, 'position', v_next.position, 'account_id', r.account_id),
            r.campaign_id)
    on conflict (organization_id, idempotency_key) do update
      set status = 'queued', attempts = 0, run_at = now(), last_error = null, finished_at = null, locked_until = null
      where public.automation_jobs.status = 'cancelled';
    -- Il prossimo step viene ricalcolato quando questo job termina.
    update public.campaign_recipients set next_step_at = null where id = r.id;
    v_count := v_count + 1;
  end loop;

  -- Campagne senza destinatari attivi: completate.
  perform set_config('leadflow.campaign_transition', 'on', true);
  update public.campaigns c set status = 'completed', completed_at = now()
   where c.status = 'running'
     and not exists (select 1 from public.campaign_recipients cr where cr.campaign_id = c.id and cr.status = 'in_sequence')
     and not exists (select 1 from public.automation_jobs j where j.campaign_id = c.id and j.status in ('queued', 'running'));
  perform set_config('leadflow.campaign_transition', '', true);
  return v_count;
end $$;

-- Dopo uno step: posizione corrente e scadenza del successivo.
create or replace function public.advance_recipient(p_recipient uuid, p_position integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_next record;
  v_base timestamptz;
begin
  select cr.*, s.id as sequence_id, c.activated_at into r
    from public.campaign_recipients cr
    join public.campaign_sequences s on s.campaign_id = cr.campaign_id
    join public.campaigns c on c.id = cr.campaign_id
   where cr.id = p_recipient for update of cr;
  if not found or r.status <> 'in_sequence' then return; end if;
  select st.* into v_next from public.campaign_steps st
   where st.sequence_id = r.sequence_id and st.position > p_position order by st.position limit 1;
  v_base := coalesce((select min(sent_at) from public.outbound_messages where recipient_id = p_recipient and status in ('sent', 'delivered', 'delivery_delayed')),
                     r.activated_at, now());
  if v_next.id is null then
    update public.campaign_recipients set current_position = p_position, status = 'completed', completed_at = now(), next_step_at = null
     where id = p_recipient;
  else
    update public.campaign_recipients set current_position = p_position,
           next_step_at = greatest(now(), v_base + make_interval(days => v_next.day_offset))
     where id = p_recipient;
  end if;
end $$;

-- Preleva job in scadenza con lease (FOR UPDATE SKIP LOCKED: più worker in sicurezza).
-- I job "running" con lease scaduto (worker interrotto) tornano disponibili.
create or replace function public.claim_automation_jobs(p_worker text, p_limit integer default 20, p_lease_seconds integer default 120)
returns setof public.automation_jobs language plpgsql security definer set search_path = '' as $$
begin
  -- Lease scaduti oltre il numero massimo di tentativi → dead-letter.
  update public.automation_jobs set status = 'dead', last_error = coalesce(last_error, 'lease_expired'), finished_at = now()
   where status = 'running' and locked_until < now() and attempts >= max_attempts;
  return query
  with picked as (
    select id from public.automation_jobs
     where (status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now())
     order by run_at
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update public.automation_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker,
         locked_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)))
    from picked where j.id = picked.id
  returning j.*;
end $$;

-- Esito di un job: successo, nuovo tentativo con backoff esponenziale, dead-letter o annullamento.
create or replace function public.finish_automation_job(p_job uuid, p_outcome text, p_error text default null, p_retry_seconds integer default null)
returns public.automation_jobs language plpgsql security definer set search_path = '' as $$
declare
  j public.automation_jobs;
  v_delay int;
begin
  select * into j from public.automation_jobs where id = p_job for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if j.status <> 'running' then return j; end if;
  if p_outcome = 'succeeded' then
    update public.automation_jobs set status = 'succeeded', last_error = null, locked_until = null, finished_at = now()
     where id = p_job returning * into j;
  elsif p_outcome = 'cancelled' then
    update public.automation_jobs set status = 'cancelled', last_error = left(p_error, 1000), locked_until = null, finished_at = now()
     where id = p_job returning * into j;
  elsif p_outcome = 'retry' and j.attempts < j.max_attempts then
    -- 60s, 120s, 240s, 480s… (max 1h) + jitter fino al 20%
    v_delay := coalesce(p_retry_seconds, least(3600, 60 * power(2, greatest(j.attempts - 1, 0))::int));
    v_delay := v_delay + floor(random() * v_delay * 0.2)::int;
    update public.automation_jobs set status = 'queued', last_error = left(p_error, 1000), locked_until = null,
           run_at = now() + make_interval(secs => v_delay)
     where id = p_job returning * into j;
  else
    update public.automation_jobs set status = 'dead', last_error = left(coalesce(p_error, 'failed'), 1000), locked_until = null, finished_at = now()
     where id = p_job returning * into j;
  end if;
  return j;
end $$;

-- Prepara il messaggio di uno step email (idempotente: un messaggio per destinatario e step).
create or replace function public.prepare_step_message(p_recipient uuid, p_step uuid)
returns public.outbound_messages language plpgsql security definer set search_path = '' as $$
declare
  r record;
  st public.campaign_steps;
  m public.outbound_messages;
begin
  select cr.*, c.account_id, c.status as campaign_status, l.email
    into r from public.campaign_recipients cr
    join public.campaigns c on c.id = cr.campaign_id
    join public.leads l on l.id = cr.lead_id
   where cr.id = p_recipient;
  select * into st from public.campaign_steps where id = p_step;
  if r.id is null or st.id is null or st.kind not in ('email', 'follow_up_email') then
    raise exception 'invalid step' using errcode = '22023';
  end if;
  select * into m from public.outbound_messages where recipient_id = p_recipient and step_id = p_step and kind = 'campaign' for update;
  if found then
    -- Un messaggio annullato prima di arrivare al provider (pausa, coda) viene rigenerato:
    -- la chiave di idempotenza non è mai stata usata. begin_send ripeterà tutti i controlli.
    if m.status = 'cancelled' and r.status = 'in_sequence' and r.campaign_status = 'running' and r.email is not null then
      update public.outbound_messages
         set status = 'queued', last_error = null, to_email = r.email,
             subject = left(private.render_template(st.subject, r.lead_id, r.organization_id), 200),
             body_text = private.render_template(st.body, r.lead_id, r.organization_id)
       where id = m.id returning * into m;
    end if;
    return m;
  end if;
  if r.email is null then raise exception 'no_email' using errcode = 'P0001'; end if;
  insert into public.outbound_messages (organization_id, kind, campaign_id, recipient_id, step_id, lead_id, account_id,
         to_email, subject, body_text, idempotency_key)
  values (r.organization_id, 'campaign', r.campaign_id, r.id, st.id, r.lead_id, r.account_id, r.email,
          left(private.render_template(st.subject, r.lead_id, r.organization_id), 200),
          private.render_template(st.body, r.lead_id, r.organization_id),
          'om:' || r.id || ':' || st.id)
  on conflict do nothing
  returning * into m;
  if m.id is null then
    select * into m from public.outbound_messages where recipient_id = p_recipient and step_id = p_step and kind = 'campaign';
  end if;
  return m;
end $$;

-- Ultimo controllo prima della chiamata al provider. Ripete TUTTI i controlli di idoneità
-- e i limiti; passa il messaggio a "sending" in modo atomico. Un messaggio già "sending"
-- (worker interrotto) può essere ritentato con la stessa chiave di idempotenza, senza
-- riconsumare la quota: il provider deduplica la richiesta.
create or replace function public.begin_send(p_message uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m public.outbound_messages;
  c public.campaigns;
  a public.communication_accounts;
  cr public.campaign_recipients;
  v_e jsonb;
  v_today int;
  v_minute int;
  v_quota jsonb;
  v_resume boolean := false;
  l public.leads;
begin
  select * into m from public.outbound_messages where id = p_message for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'permanent', true); end if;
  if m.status in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained') then
    return jsonb_build_object('ok', false, 'reason', 'already_sent', 'permanent', true);
  end if;
  if m.status in ('cancelled', 'failed', 'unknown') then
    return jsonb_build_object('ok', false, 'reason', 'message_' || m.status, 'permanent', true);
  end if;
  if m.status = 'sending' then
    -- Le chiavi di idempotenza del provider valgono 24 ore: oltre, esito incerto → revisione umana.
    if m.sending_started_at < now() - interval '23 hours' then
      update public.outbound_messages set status = 'unknown', last_error = 'outcome_unknown_after_24h' where id = m.id;
      return jsonb_build_object('ok', false, 'reason', 'outcome_unknown', 'permanent', true);
    end if;
    v_resume := true;
  end if;

  select * into a from public.communication_accounts where id = m.account_id;
  if a.status <> 'connected' then
    return jsonb_build_object('ok', false, 'reason', 'provider_not_connected', 'permanent', true);
  end if;

  if m.kind = 'campaign' then
    select * into c from public.campaigns where id = m.campaign_id;
    if c.status <> 'running' then
      return jsonb_build_object('ok', false, 'reason', 'campaign_' || c.status::text, 'permanent', true);
    end if;
    select * into cr from public.campaign_recipients where id = m.recipient_id;
    if cr.status <> 'in_sequence' then
      update public.outbound_messages set status = 'cancelled', last_error = 'recipient_' || cr.status::text where id = m.id and status = 'queued';
      return jsonb_build_object('ok', false, 'reason', 'recipient_' || cr.status::text, 'permanent', true);
    end if;
    v_e := private.lead_eligibility(m.organization_id, m.lead_id, c.channel, c.purpose);
    if not (v_e ->> 'eligible')::boolean then
      perform private.stop_lead_sequences(m.organization_id, m.lead_id, 'not_eligible', c.channel);
      update public.outbound_messages set status = 'cancelled', last_error = 'not_eligible:' || (v_e ->> 'reasons') where id = m.id;
      return jsonb_build_object('ok', false, 'reason', 'not_eligible', 'detail', v_e -> 'reasons', 'permanent', true);
    end if;
    select * into l from public.leads where id = m.lead_id;
    if l.email is distinct from m.to_email then
      update public.outbound_messages set status = 'cancelled', last_error = 'recipient_address_changed' where id = m.id;
      return jsonb_build_object('ok', false, 'reason', 'recipient_address_changed', 'permanent', true);
    end if;
  elsif m.kind = 'reply' then
    select * into l from public.leads where id = m.lead_id;
    if l.contact_status <> 'active' or exists (select 1 from public.suppression_entries se
         where se.organization_id = m.organization_id and se.email_hash = private.email_hash(m.to_email) and se.reason <> 'bounce') then
      update public.outbound_messages set status = 'cancelled', last_error = 'contact_opted_out' where id = m.id;
      return jsonb_build_object('ok', false, 'reason', 'contact_opted_out', 'permanent', true);
    end if;
  elsif m.kind = 'test' then
    -- Invii di prova solo verso indirizzi di test del provider o verso un membro dell'organizzazione.
    if not (lower(m.to_email) ~ '^(delivered|bounced|complained)(\+[a-z0-9_-]+)?@resend\.dev$'
            or exists (select 1 from public.organization_members om join public.profiles p on p.id = om.user_id
                        where om.organization_id = m.organization_id and lower(p.email) = lower(m.to_email))) then
      update public.outbound_messages set status = 'cancelled', last_error = 'test_address_not_allowed' where id = m.id;
      return jsonb_build_object('ok', false, 'reason', 'test_address_not_allowed', 'permanent', true);
    end if;
  end if;

  if exists (select 1 from public.suppression_entries se where se.organization_id = m.organization_id
              and se.email_hash = private.email_hash(m.to_email)) and m.kind <> 'test' and m.kind <> 'reply' then
    update public.outbound_messages set status = 'cancelled', last_error = 'in_suppression_list' where id = m.id;
    return jsonb_build_object('ok', false, 'reason', 'in_suppression_list', 'permanent', true);
  end if;

  if not v_resume then
    -- Limiti dell'account: giornaliero e al minuto (rinvio, non errore).
    perform pg_advisory_xact_lock(hashtextextended('send:' || a.id::text, 0));
    select count(*) filter (where sending_started_at >= date_trunc('day', now())),
           count(*) filter (where sending_started_at >= now() - interval '1 minute')
      into v_today, v_minute
      from public.outbound_messages
     where account_id = a.id and sending_started_at >= date_trunc('day', now()) - interval '1 minute' and status <> 'cancelled';
    if v_today >= a.daily_limit then
      return jsonb_build_object('ok', false, 'reason', 'daily_limit', 'permanent', false,
        'retry_seconds', greatest(60, extract(epoch from (date_trunc('day', now()) + interval '1 day' - now()))::int));
    end if;
    if v_minute >= a.per_minute_limit then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'permanent', false, 'retry_seconds', 60);
    end if;
    v_quota := public.consume_usage(m.organization_id, null, 'email_sent', 1, jsonb_build_object('message_id', m.id));
    if not (v_quota ->> 'allowed')::boolean then
      return jsonb_build_object('ok', false, 'reason', 'monthly_quota', 'permanent', false, 'retry_seconds', 3600);
    end if;
    update public.outbound_messages set status = 'sending', sending_started_at = now(), attempts = attempts + 1 where id = m.id;
  else
    update public.outbound_messages set attempts = attempts + 1 where id = m.id;
  end if;

  return jsonb_build_object('ok', true, 'resume', v_resume, 'idempotency_key', m.idempotency_key,
    'kind', m.kind, 'lead_id', m.lead_id, 'campaign_id', m.campaign_id,
    'basis', v_e ->> 'basis', 'language', coalesce(c.language, 'it'),
    'source_name', (select s.name from public.leads le join public.lead_sources s on s.id = le.source_id where le.id = m.lead_id),
    'to_email', m.to_email, 'subject', m.subject, 'body_text', m.body_text,
    'from_name', a.from_name, 'from_email', a.from_email, 'reply_to', a.reply_to, 'account_id', a.id, 'provider', a.provider);
end $$;

-- Esito della chiamata al provider.
create or replace function public.finish_send(p_message uuid, p_outcome text, p_provider_id text default null, p_error text default null)
returns public.outbound_messages language plpgsql security definer set search_path = '' as $$
declare
  m public.outbound_messages;
begin
  select * into m from public.outbound_messages where id = p_message for update;
  if not found or m.status <> 'sending' then return m; end if;
  if p_outcome = 'sent' then
    update public.outbound_messages set status = 'sent', sent_at = now(), provider_message_id = p_provider_id, last_error = null
     where id = p_message returning * into m;
  elsif p_outcome = 'failed' then
    update public.outbound_messages set status = 'failed', last_error = left(p_error, 500) where id = p_message returning * into m;
  elsif p_outcome = 'requeue' then
    -- Rifiuto certo prima dell'elaborazione (es. credenziali revocate): nessun invio avvenuto.
    update public.outbound_messages set status = 'queued', sending_started_at = null, last_error = left(p_error, 500)
     where id = p_message returning * into m;
  elsif p_outcome = 'unknown' then
    -- Tentativi esauriti dopo una chiamata dall'esito incerto: nessun nuovo invio automatico.
    update public.outbound_messages set status = 'unknown', last_error = left(coalesce(p_error, 'outcome_unknown'), 500) where id = p_message returning * into m;
  else -- retry: resta "sending" (stessa chiave di idempotenza al prossimo tentativo)
    update public.outbound_messages set last_error = left(p_error, 500) where id = p_message returning * into m;
  end if;
  return m;
end $$;

-- Aggiornamenti di consegna dai webhook (gli stati non tornano mai indietro).
create or replace function public.apply_delivery_event(
  p_account uuid, p_provider public.communication_provider, p_event_id text, p_type text,
  p_provider_message_id text, p_occurred_at timestamptz, p_detail jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.communication_accounts;
  m public.outbound_messages;
  v_new public.outbound_status;
  v_rank int;
  v_cur int;
begin
  select * into a from public.communication_accounts where id = p_account;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_account'); end if;
  select * into m from public.outbound_messages where account_id = p_account and provider_message_id = p_provider_message_id for update;
  insert into public.delivery_events (organization_id, account_id, provider, provider_event_id, event_type, outbound_message_id, detail, occurred_at)
  values (a.organization_id, a.id, p_provider, p_event_id, p_type, m.id, coalesce(p_detail, '{}'::jsonb), coalesce(p_occurred_at, now()))
  on conflict (provider, provider_event_id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  if m.id is null then return jsonb_build_object('ok', true, 'matched', false); end if;

  v_new := case p_type
    when 'email.sent' then 'sent' when 'email.delivered' then 'delivered'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.bounced' then case when coalesce(p_detail ->> 'bounce_type', 'Permanent') = 'Permanent' then 'bounced' else 'delivery_delayed' end
    when 'email.complained' then 'complained'
    else null end::public.outbound_status;
  if v_new is null then return jsonb_build_object('ok', true, 'ignored', p_type); end if;
  v_rank := array_position(array['sending', 'sent', 'delivery_delayed', 'delivered', 'bounced', 'complained']::text[], v_new::text);
  v_cur := coalesce(array_position(array['sending', 'sent', 'delivery_delayed', 'delivered', 'bounced', 'complained']::text[], m.status::text), 0);
  if v_rank > v_cur or v_new in ('bounced', 'complained') and m.status not in ('bounced', 'complained') then
    update public.outbound_messages
       set status = v_new,
           sent_at = coalesce(sent_at, case when v_new in ('sent', 'delivered') then coalesce(p_occurred_at, now()) end),
           delivered_at = case when v_new = 'delivered' then coalesce(p_occurred_at, now()) else delivered_at end,
           bounced_at = case when v_new = 'bounced' then coalesce(p_occurred_at, now()) else bounced_at end
     where id = m.id;
  end if;
  return jsonb_build_object('ok', true, 'status', v_new);
end $$;

-- Disiscrizione dal link o dall'header List-Unsubscribe (one-click, RFC 8058).
create or replace function public.register_unsubscribe(p_message uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m public.outbound_messages;
begin
  select * into m from public.outbound_messages where id = p_message;
  if not found then return jsonb_build_object('ok', false); end if;
  insert into public.suppression_entries (organization_id, email_hash, reason, source, campaign_id)
  values (m.organization_id, private.email_hash(m.to_email), 'unsubscribe', 'unsubscribe_link', m.campaign_id)
  on conflict (organization_id, email_hash) do update set reason = 'unsubscribe', source = 'unsubscribe_link'
    where public.suppression_entries.reason = 'bounce';
  if m.lead_id is not null then
    update public.leads set contact_status = 'opted_out' where id = m.lead_id and contact_status = 'active';
    perform private.log_activity(m.organization_id, m.lead_id, 'system', 'Disiscrizione tramite link nell''email',
      jsonb_build_object('outbound_message_id', m.id));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Rinvio di un job senza consumare un tentativo (finestra di invio, limiti dell'account).
create or replace function public.defer_automation_job(p_job uuid, p_seconds integer)
returns void language sql security definer set search_path = '' as $$
  update public.automation_jobs
     set status = 'queued', locked_until = null, attempts = greatest(attempts - 1, 0),
         run_at = now() + make_interval(secs => greatest(30, least(p_seconds, 7 * 86400)))
   where id = p_job and status = 'running';
$$;

-- Arresto di un destinatario per errore permanente (es. indirizzo rifiutato dal provider).
create or replace function public.stop_recipient(p_recipient uuid, p_reason text)
returns void language sql security definer set search_path = '' as $$
  update public.campaign_recipients set status = 'stopped', stopped_reason = left(p_reason, 80), stopped_at = now(), next_step_at = null
   where id = p_recipient and status = 'in_sequence';
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.defer_automation_job(uuid, integer)', 'public.stop_recipient(uuid, text)',
    'public.schedule_due_steps(integer)', 'public.advance_recipient(uuid, integer)',
    'public.claim_automation_jobs(text, integer, integer)', 'public.finish_automation_job(uuid, text, text, integer)',
    'public.prepare_step_message(uuid, uuid)', 'public.begin_send(uuid)', 'public.finish_send(uuid, text, text, text)',
    'public.apply_delivery_event(uuid, public.communication_provider, text, text, text, timestamptz, jsonb)',
    'public.register_unsubscribe(uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 15. Analytics (eventi reali; aperture NON misurate)
-- ════════════════════════════════════════════════════════════════════════════
-- Attribuzione: un appuntamento, un'opportunità o una conversione è attribuita a una
-- campagna se avviene dopo il primo messaggio inviato a quel lead da quella campagna,
-- entro 90 giorni. I ricavi contano solo opportunità "won" con importo registrato.
create or replace function public.campaign_metrics(
  p_org uuid, p_from timestamptz, p_to timestamptz,
  p_campaign uuid default null, p_channel public.outreach_channel default null, p_status public.workflow_status default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v jsonb;
begin
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  with camp as (
    select c.* from public.campaigns c
     where c.organization_id = p_org and c.archived_at is null
       and (p_campaign is null or c.id = p_campaign)
       and (p_channel is null or c.channel = p_channel)
       and (p_status is null or c.status = p_status)
  ), msgs as (
    select m.* from public.outbound_messages m join camp on camp.id = m.campaign_id
     where m.kind = 'campaign' and m.sent_at >= p_from and m.sent_at < p_to
  ), first_touch as (
    select m.campaign_id, m.lead_id, min(m.sent_at) as first_at
      from public.outbound_messages m join camp on camp.id = m.campaign_id
     where m.kind = 'campaign' and m.sent_at is not null
     group by m.campaign_id, m.lead_id
  ), replies as (
    select i.*, cr.campaign_id from public.inbound_messages i
      join public.campaign_recipients cr on cr.id = i.recipient_id
      join camp on camp.id = cr.campaign_id
     where i.received_at >= p_from and i.received_at < p_to
  ), appts as (
    select distinct ft.campaign_id, a.id from public.appointments a
      join first_touch ft on ft.lead_id = a.lead_id
     where a.organization_id = p_org and a.created_at >= ft.first_at and a.created_at < ft.first_at + interval '90 days'
       and a.created_at >= p_from and a.created_at < p_to
  ), opps as (
    select distinct on (ft.campaign_id, o.id) ft.campaign_id, o.id, o.status, o.value_amount, o.currency
      from public.sales_opportunities o
      join first_touch ft on ft.lead_id = o.lead_id
     where o.organization_id = p_org and o.created_at >= ft.first_at and o.created_at < ft.first_at + interval '90 days'
       and o.created_at >= p_from and o.created_at < p_to
  ), wins as (
    select distinct ft.campaign_id, a.lead_id from public.activities a
      join first_touch ft on ft.lead_id = a.lead_id
     where a.organization_id = p_org and a.type = 'status_change' and a.metadata ->> 'to' = 'won'
       and a.occurred_at >= ft.first_at and a.occurred_at < ft.first_at + interval '90 days'
       and a.occurred_at >= p_from and a.occurred_at < p_to
  ), per_campaign as (
    select camp.id, camp.name, camp.status, camp.channel, camp.created_at, camp.activated_at,
      (select count(*) from public.campaign_recipients cr where cr.campaign_id = camp.id and (cr.eligible or cr.status in ('in_sequence', 'completed', 'stopped'))) as eligible,
      (select count(*) from public.campaign_recipients cr where cr.campaign_id = camp.id and cr.status = 'excluded') as excluded,
      (select count(*) from msgs where msgs.campaign_id = camp.id) as sent,
      (select count(*) from msgs where msgs.campaign_id = camp.id and msgs.status = 'delivered') as delivered,
      (select count(*) from msgs where msgs.campaign_id = camp.id and msgs.status = 'bounced') as bounced,
      (select count(*) from msgs where msgs.campaign_id = camp.id and msgs.status = 'complained') as complaints,
      (select count(distinct lead_id) from msgs where msgs.campaign_id = camp.id) as contacted,
      (select count(*) from replies where replies.campaign_id = camp.id) as replies,
      (select count(*) from replies where replies.campaign_id = camp.id and replies.classification = 'positive') as positive_confirmed,
      (select count(*) from replies where replies.campaign_id = camp.id and replies.classification is null and replies.ai_classification = 'positive') as positive_ai_unconfirmed,
      (select count(*) from appts where appts.campaign_id = camp.id) as appointments,
      (select count(*) from opps where opps.campaign_id = camp.id) as opportunities,
      (select count(*) from wins where wins.campaign_id = camp.id) as customers
    from camp
  ), totals as (
    select coalesce(sum(eligible), 0) eligible, coalesce(sum(excluded), 0) excluded, coalesce(sum(sent), 0) sent,
           coalesce(sum(delivered), 0) delivered, coalesce(sum(bounced), 0) bounced, coalesce(sum(complaints), 0) complaints,
           coalesce(sum(contacted), 0) contacted, coalesce(sum(replies), 0) replies,
           coalesce(sum(positive_confirmed), 0) positive_confirmed, coalesce(sum(positive_ai_unconfirmed), 0) positive_ai_unconfirmed,
           coalesce(sum(appointments), 0) appointments, coalesce(sum(opportunities), 0) opportunities, coalesce(sum(customers), 0) customers
      from per_campaign
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'campaigns', jsonb_build_object(
      'total', (select count(*) from camp),
      'running', (select count(*) from camp where status in ('running', 'scheduled')),
      'draft', (select count(*) from camp where status in ('draft', 'pending_approval')),
      'paused', (select count(*) from camp where status = 'paused'),
      'completed', (select count(*) from camp where status = 'completed')),
    'totals', to_jsonb(t.*),
    'rates', jsonb_build_object(
      'reply_rate', jsonb_build_object('numerator', t.replies, 'denominator', t.delivered, 'denominator_label', 'delivered',
        'value', case when t.delivered > 0 then round(t.replies * 100.0 / t.delivered, 1) end),
      'appointment_rate', jsonb_build_object('numerator', t.appointments, 'denominator', t.delivered, 'denominator_label', 'delivered',
        'value', case when t.delivered > 0 then round(t.appointments * 100.0 / t.delivered, 1) end),
      'conversion_rate', jsonb_build_object('numerator', t.customers, 'denominator', t.contacted, 'denominator_label', 'contacted',
        'value', case when t.contacted > 0 then round(t.customers * 100.0 / t.contacted, 1) end),
      'bounce_rate', jsonb_build_object('numerator', t.bounced, 'denominator', t.sent, 'denominator_label', 'sent',
        'value', case when t.sent > 0 then round(t.bounced * 100.0 / t.sent, 1) end)),
    'revenue', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'opportunities', n))
        from (select o.currency, sum(o.value_amount) amount, count(*) n from opps o
               where o.status = 'won' and o.value_amount is not null group by o.currency) x), '[]'::jsonb),
    'by_campaign', coalesce((select jsonb_agg(to_jsonb(pc.*) order by pc.created_at desc) from per_campaign pc), '[]'::jsonb),
    'weekly_sent', coalesce((select jsonb_agg(jsonb_build_object('week', w, 'sent', n) order by w)
        from (select date_trunc('week', sent_at)::date w, count(*) n from msgs group by 1) x), '[]'::jsonb)
  ) into v from totals t;
  return v;
end $$;
revoke all on function public.campaign_metrics(uuid, timestamptz, timestamptz, uuid, public.outreach_channel, public.workflow_status) from public, anon;
grant execute on function public.campaign_metrics(uuid, timestamptz, timestamptz, uuid, public.outreach_channel, public.workflow_status) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 16. Trigger comuni, privilegi e RLS
-- ════════════════════════════════════════════════════════════════════════════
create trigger consent_records_created_by before insert on public.consent_records for each row execute function private.set_created_by();
create trigger automation_workflows_created_by before insert on public.automation_workflows for each row execute function private.set_created_by();

do $$
declare t text;
begin
  foreach t in array array['communication_accounts', 'campaign_sequences', 'campaign_steps', 'outbound_messages',
                           'automation_workflows', 'automation_jobs']
  loop
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
  foreach t in array array['consent_records', 'communication_accounts', 'campaign_sequences', 'campaign_steps', 'outbound_messages',
                           'inbound_messages', 'delivery_events', 'automation_workflows', 'automation_events', 'automation_jobs',
                           'notifications', 'communication_account_secrets']
  loop
    execute format('create trigger %1$s_org_immutable before update on public.%1$I for each row execute function public.prevent_org_change()', t);
  end loop;
end $$;

-- Workflow: l'attivazione richiede un admin; modifiche a un workflow attivo lo rimettono in bozza.
create or replace function private.workflows_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.approved_by := null; new.approved_at := null; new.run_count := 0;
    return new;
  end if;
  if (new.trigger, new.conditions, new.actions) is distinct from (old.trigger, old.conditions, old.actions)
     and old.status in ('running', 'paused') then
    new.status := 'draft'; new.approved_by := null; new.approved_at := null;
  end if;
  if new.status = 'running' and old.status is distinct from 'running' then
    if not private.is_org_admin(new.organization_id) then
      raise exception 'only organization admins can activate workflows' using errcode = '42501';
    end if;
    new.approved_by := auth.uid(); new.approved_at := now();
  end if;
  if new.status not in ('draft', 'pending_approval', 'running', 'paused', 'cancelled') then
    raise exception 'invalid workflow status' using errcode = '22023';
  end if;
  new.run_count := old.run_count; new.last_run_at := old.last_run_at; new.last_error := old.last_error;
  return new;
end $$;
create trigger automation_workflows_guard before insert or update on public.automation_workflows
  for each row execute function private.workflows_guard();

create or replace function private.audit_workflows()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(new.organization_id, 'workflow.' || tg_op, 'automation_workflow', new.id::text,
    jsonb_build_object('status', new.status, 'trigger', new.trigger));
  return new;
end $$;
create trigger automation_workflows_audit after insert or update on public.automation_workflows
  for each row execute function private.audit_workflows();

-- Privilegi: nulla ad anon; i client scrivono solo le colonne previste.
revoke all on public.consent_records, public.communication_accounts, public.communication_account_secrets,
  public.campaign_sequences, public.campaign_steps, public.outbound_messages, public.inbound_messages,
  public.delivery_events, public.automation_workflows, public.automation_events, public.automation_jobs,
  public.notifications from anon, authenticated;
revoke truncate, references, trigger on public.campaigns, public.campaign_recipients, public.suppression_entries from authenticated;

grant select on public.consent_records, public.communication_accounts, public.campaign_sequences, public.campaign_steps,
  public.outbound_messages, public.inbound_messages, public.delivery_events, public.automation_workflows,
  public.automation_events, public.automation_jobs, public.notifications to authenticated;
grant insert (organization_id, lead_id, channel, purpose, status, evidence, evidence_url, policy_version, captured_at)
  on public.consent_records to authenticated;
grant update (subject, body) on public.campaign_steps to authenticated;
grant update (classification, handled_at) on public.inbound_messages to authenticated;
grant insert (organization_id, name, trigger, conditions, actions) on public.automation_workflows to authenticated;
grant update (name, trigger, conditions, actions, status) on public.automation_workflows to authenticated;
grant delete on public.automation_workflows to authenticated;
grant update (read_at) on public.notifications to authenticated;

revoke insert, update on public.campaigns from authenticated;
grant insert (organization_id, name, description, goal, service_name, language, channel, planned_start_at, timezone,
  send_hour_start, send_hour_end, weekdays_only, account_id, stop_on_appointment, call_to_action)
  on public.campaigns to authenticated;
grant update (name, description, goal, service_name, language, channel, planned_start_at, timezone,
  send_hour_start, send_hour_end, weekdays_only, account_id, stop_on_appointment, call_to_action)
  on public.campaigns to authenticated;
revoke insert, update on public.campaign_recipients from authenticated;
grant insert (organization_id, campaign_id, lead_id) on public.campaign_recipients to authenticated;
revoke insert, update, delete on public.suppression_entries from authenticated;
grant insert (organization_id, email_hash, reason, note) on public.suppression_entries to authenticated;
grant delete on public.suppression_entries to authenticated;

alter table public.consent_records enable row level security;
alter table public.communication_accounts enable row level security;
alter table public.communication_account_secrets enable row level security;
alter table public.campaign_sequences enable row level security;
alter table public.campaign_steps enable row level security;
alter table public.outbound_messages enable row level security;
alter table public.inbound_messages enable row level security;
alter table public.delivery_events enable row level security;
alter table public.automation_workflows enable row level security;
alter table public.automation_events enable row level security;
alter table public.automation_jobs enable row level security;
alter table public.notifications enable row level security;
-- communication_account_secrets: RLS attiva e nessuna policy → inaccessibile ai client.

do $$
declare t text;
begin
  foreach t in array array['consent_records', 'communication_accounts', 'campaign_sequences', 'campaign_steps', 'outbound_messages',
                           'inbound_messages', 'delivery_events', 'automation_workflows', 'automation_events', 'automation_jobs']
  loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (private.is_org_member(organization_id))', t);
  end loop;
end $$;
create policy consent_records_insert on public.consent_records for insert to authenticated
  with check (private.is_org_member(organization_id));
create policy campaign_steps_update on public.campaign_steps for update to authenticated
  using (private.is_org_member(organization_id)) with check (private.is_org_member(organization_id));
create policy inbound_messages_update on public.inbound_messages for update to authenticated
  using (private.is_org_member(organization_id)) with check (private.is_org_member(organization_id));
create policy automation_workflows_insert on public.automation_workflows for insert to authenticated
  with check (private.is_org_member(organization_id));
create policy automation_workflows_update on public.automation_workflows for update to authenticated
  using (private.is_org_member(organization_id)) with check (private.is_org_member(organization_id));
create policy automation_workflows_delete on public.automation_workflows for delete to authenticated
  using (private.is_org_admin(organization_id));
create policy notifications_select on public.notifications for select to authenticated
  using (private.is_org_member(organization_id) and (user_id is null or user_id = (select auth.uid())));
create policy notifications_update on public.notifications for update to authenticated
  using (private.is_org_member(organization_id) and user_id = (select auth.uid()))
  with check (private.is_org_member(organization_id) and user_id = (select auth.uid()));

-- Classificazione confermata: chi conferma viene registrato dal trigger.
create or replace function private.inbound_confirm()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.classification is distinct from old.classification and auth.uid() is not null then
    new.classification_confirmed_by := auth.uid();
    new.classification_confirmed_at := now();
  end if;
  if new.handled_at is distinct from old.handled_at and auth.uid() is not null then
    new.handled_by := case when new.handled_at is null then null else auth.uid() end;
  end if;
  return new;
end $$;
create trigger inbound_messages_confirm before update on public.inbound_messages
  for each row execute function private.inbound_confirm();

-- Consensi: gli stati "granted" li registra chiunque nell'org con evidenza; nessuna modifica successiva
-- (append-only): una revoca è un nuovo record.
-- suppression_entries: i membri aggiungono hash manuali; solo gli admin rimuovono (policy esistenti).
