-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Migrazione 0001: schema iniziale multi-tenant
-- Ogni record aziendale appartiene a una organization (organization_id).
-- L'isolamento tra tenant è garantito da RLS (migrazione 0002) + vincoli FK
-- compositi che impediscono collegamenti tra record di organizzazioni diverse.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ─── Tipi enumerati ─────────────────────────────────────────────────────────
create type public.platform_role as enum ('user', 'super_admin');
create type public.org_role as enum ('organization_admin', 'member');

create type public.lead_status as enum ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost');
-- active: contattabile · opted_out: opposizione (art. 21 GDPR), dati conservati per rispettarla
-- suppressed: dati personali cancellati, resta solo l'hash nella suppression list
create type public.contact_status as enum ('active', 'opted_out', 'suppressed');

create type public.lead_source_type as enum ('manual', 'csv_import', 'website_form', 'public_registry', 'partner', 'api');
create type public.legal_basis as enum ('legitimate_interest', 'consent', 'contract', 'public_professional_data');

create type public.campaign_status as enum ('draft', 'active', 'paused', 'completed', 'archived');
create type public.campaign_lead_status as enum ('pending', 'contacted', 'replied', 'excluded');
create type public.activity_type as enum ('note', 'call', 'email', 'meeting', 'status_change', 'system');
create type public.appointment_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');

create type public.ai_job_type as enum ('lead_finder', 'business_analysis', 'lead_scoring', 'sales_agent', 'follow_up');
create type public.ai_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused');

-- ─── Utility: updated_at ───────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Impedisce lo spostamento di un record verso un'altra organizzazione.
create or replace function public.prevent_org_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

-- ─── profiles ──────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text check (full_name is null or char_length(full_name) between 1 and 120),
  platform_role public.platform_role not null default 'user',
  locale text not null default 'it' check (locale in ('it', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ─── organizations ─────────────────────────────────────────────────────────
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  vat_number text check (vat_number is null or vat_number ~ '^([A-Z]{2})?[0-9A-Z]{8,15}$'),
  country text not null default 'IT' check (country ~ '^[A-Z]{2}$'),
  -- Periodo di conservazione dei lead inattivi (giorni) per la policy di retention.
  data_retention_days integer not null default 730 check (data_retention_days between 30 and 3650),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create trigger organizations_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();

-- ─── organization_members ──────────────────────────────────────────────────
create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

-- ─── lead_sources: provenienza tracciata di ogni lead ─────────────────────
create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type public.lead_source_type not null,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  description text check (description is null or char_length(description) <= 2000),
  legal_basis public.legal_basis not null,
  source_url text check (source_url is null or source_url ~* '^https?://'),
  acquired_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index lead_sources_org_idx on public.lead_sources (organization_id);

-- ─── leads ─────────────────────────────────────────────────────────────────
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null,
  company_name text not null check (char_length(btrim(company_name)) between 1 and 200),
  website text check (website is null or website ~* '^https?://'),
  vat_number text,
  industry text,
  city text,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  contact_name text,
  contact_role text,
  email text check (email is null or email ~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  phone text,
  status public.lead_status not null default 'new',
  contact_status public.contact_status not null default 'active',
  opted_out_at timestamptz,
  suppressed_at timestamptz,
  score smallint check (score is null or score between 0 and 100),
  owner_id uuid references auth.users (id) on delete set null,
  notes text check (notes is null or char_length(notes) <= 10000),
  last_activity_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  -- La fonte deve appartenere alla stessa organizzazione del lead.
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete restrict
);
create index leads_org_status_idx on public.leads (organization_id, status) where deleted_at is null;
create index leads_org_created_idx on public.leads (organization_id, created_at desc);
create index leads_company_idx on public.leads (organization_id, lower(company_name));
create trigger leads_updated_at before update on public.leads
  for each row execute function public.set_updated_at();
create trigger leads_org_immutable before update on public.leads
  for each row execute function public.prevent_org_change();

-- ─── contact_suppressions: elenco di soppressione per hash ────────────────
-- Conserva solo l'hash SHA-256 dell'email: permette di impedire reimportazioni
-- di contatti che si sono opposti o hanno chiesto la cancellazione.
create table public.contact_suppressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason in ('opt_out', 'erasure_request', 'bounce', 'manual')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, email_hash)
);

-- ─── lead_analyses (scritte solo dal server AI) ───────────────────────────
create table public.lead_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null,
  ai_job_id uuid,
  summary text,
  data jsonb not null default '{}'::jsonb,
  model text,
  created_at timestamptz not null default now(),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
create index lead_analyses_lead_idx on public.lead_analyses (organization_id, lead_id);

-- ─── campaigns ─────────────────────────────────────────────────────────────
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  description text check (description is null or char_length(description) <= 4000),
  status public.campaign_status not null default 'draft',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index campaigns_org_status_idx on public.campaigns (organization_id, status);
create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();
create trigger campaigns_org_immutable before update on public.campaigns
  for each row execute function public.prevent_org_change();

-- ─── campaign_leads ────────────────────────────────────────────────────────
create table public.campaign_leads (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  campaign_id uuid not null,
  lead_id uuid not null,
  status public.campaign_lead_status not null default 'pending',
  added_at timestamptz not null default now(),
  primary key (campaign_id, lead_id),
  foreign key (organization_id, campaign_id) references public.campaigns (organization_id, id) on delete cascade,
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
create trigger campaign_leads_org_immutable before update on public.campaign_leads
  for each row execute function public.prevent_org_change();

-- ─── activities ────────────────────────────────────────────────────────────
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid,
  type public.activity_type not null,
  subject text check (subject is null or char_length(subject) <= 300),
  body text check (body is null or char_length(body) <= 10000),
  occurred_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
create index activities_org_time_idx on public.activities (organization_id, occurred_at desc);
create trigger activities_org_immutable before update on public.activities
  for each row execute function public.prevent_org_change();

-- ─── appointments ──────────────────────────────────────────────────────────
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid,
  title text not null check (char_length(btrim(title)) between 2 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  status public.appointment_status not null default 'scheduled',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
create index appointments_org_start_idx on public.appointments (organization_id, starts_at);
create trigger appointments_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();
create trigger appointments_org_immutable before update on public.appointments
  for each row execute function public.prevent_org_change();

-- ─── ai_jobs (creati/aggiornati solo dal server) ───────────────────────────
create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type public.ai_job_type not null,
  status public.ai_job_status not null default 'queued',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  model text,
  tokens_input integer check (tokens_input is null or tokens_input >= 0),
  tokens_output integer check (tokens_output is null or tokens_output >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index ai_jobs_org_created_idx on public.ai_jobs (organization_id, created_at desc);
alter table public.lead_analyses
  add constraint lead_analyses_ai_job_fk foreign key (ai_job_id) references public.ai_jobs (id) on delete set null;

-- ─── subscriptions (scritte solo dal webhook Stripe lato server) ──────────
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'free',
  status public.subscription_status not null default 'trialing',
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ─── usage_events (metering, scritti dal server) ──────────────────────────
create table public.usage_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (char_length(event_type) between 2 and 80),
  quantity integer not null default 1 check (quantity >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index usage_events_org_time_idx on public.usage_events (organization_id, created_at desc);

-- ─── audit_logs (append-only) ──────────────────────────────────────────────
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete set null,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_time_idx on public.audit_logs (organization_id, created_at desc);
