/**
 * SOLO TEST: store in memoria del Campaign Manager. Riproduce in forma semplificata le
 * regole di public.begin_send (verificate per intero dai test SQL) per testare il worker.
 */
import { randomUUID } from 'node:crypto'
import type { AccountRow, AccountsDb, AutomationJob, BeginSend, CampaignStore, InboundWrite, LeadBrief, PendingEvent, StepContext, WorkflowRow } from '../store'

type Msg = {
  id: string
  org: string
  kind: 'campaign' | 'reply' | 'test'
  recipientId: string | null
  stepId: string | null
  leadId: string | null
  accountId: string
  to: string
  subject: string
  body: string
  status: string
  key: string
  providerId: string | null
  attempts: number
  error: string | null
}

export function createMemoryCampaignStore() {
  const s = {
    jobs: [] as (AutomationJob & { status: string; run_at: number; last_error: string | null })[],
    messages: [] as Msg[],
    recipients: [] as { id: string; org: string; campaignId: string; leadId: string; status: string; position: number; stoppedReason?: string }[],
    steps: [] as StepContext['step'][],
    campaign: {
      id: 'camp-1',
      status: 'running',
      name: 'Hotel autunno',
      timezone: 'Europe/Rome',
      send_hour_start: 0,
      send_hour_end: 24,
      weekdays_only: false,
      activated_by: 'user-admin',
      language: 'it' as const,
    },
    leads: [] as (LeadBrief & { org: string })[],
    accounts: [] as (AccountRow & { domain_status: string; dns_records: unknown; label: string; last_error?: string | null; [k: string]: unknown })[],
    secrets: {} as Record<string, { api_key_ciphertext: string | null; webhook_secret_ciphertext: string | null }>,
    sender: { legalName: 'Kappa Consulting Srl', address: 'Via Roma 1, 00100 Roma', privacyUrl: 'https://kappa.test/privacy', signature: 'Kira — Kappa' } as { legalName: string; address: string; privacyUrl: string; signature: string | null } | null,
    tasks: [] as { org: string; leadId: string; kind: string; recipientId?: string | null; jobId?: string | null }[],
    notifications: [] as { org: string; title: string }[],
    activities: [] as { org: string; leadId: string; subject: string }[],
    events: [] as (PendingEvent & { processed?: boolean })[],
    workflows: [] as (WorkflowRow & { status: string; runs: number; lastError: string | null })[],
    inbound: [] as (InboundWrite & { id: string })[],
    delivery: [] as { eventId: string; type: string; providerMessageId: string }[],
    quotaUsed: 0,
    quotaLimit: 1000,
    unsubscribed: [] as string[],
    members: ['kira@kappa.test'],
  }

  const store: CampaignStore & AccountsDb = {
    async scheduleDueSteps() {
      return 0
    },
    async claimJobs(worker, limit) {
      const now = Date.now()
      const due = s.jobs.filter((j) => j.status === 'queued' && j.run_at <= now).slice(0, limit)
      for (const j of due) {
        j.status = 'running'
        j.attempts++
      }
      return due.map((j) => ({ ...j }))
    },
    async finishJob(id, outcome, err) {
      const j = s.jobs.find((x) => x.id === id)!
      j.last_error = err ?? null
      if (outcome === 'retry' && j.attempts < j.max_attempts) {
        j.status = 'queued'
        j.run_at = Date.now() // nei test il backoff non attende
      } else j.status = outcome === 'retry' ? 'dead' : outcome
    },
    async deferJob(id, seconds) {
      const j = s.jobs.find((x) => x.id === id)!
      j.status = 'queued'
      j.attempts = Math.max(0, j.attempts - 1)
      j.run_at = Date.now() + seconds * 1000
    },
    async enqueueJob(row) {
      if (s.jobs.some((j) => j.organization_id === row.org && j.idempotency_key === row.key)) return null
      const id = randomUUID()
      s.jobs.push({ id, organization_id: row.org, kind: row.kind, idempotency_key: row.key, payload: row.payload, attempts: 0, max_attempts: row.maxAttempts ?? 5, campaign_id: row.campaignId ?? null, workflow_id: row.workflowId ?? null, status: 'queued', run_at: Date.now(), last_error: null })
      return id
    },
    async countDueJobs() {
      return s.jobs.filter((j) => j.status === 'queued').length
    },

    async getStepContext(recipientId, stepId) {
      const r = s.recipients.find((x) => x.id === recipientId)
      const st = s.steps.find((x) => x.id === stepId)
      if (!r || !st) return null
      return { recipient: { id: r.id, organization_id: r.org, campaign_id: r.campaignId, lead_id: r.leadId, status: r.status }, step: st, campaign: { ...s.campaign } }
    },
    async prepareStepMessage(recipientId, stepId) {
      let m = s.messages.find((x) => x.recipientId === recipientId && x.stepId === stepId)
      if (!m) {
        const r = s.recipients.find((x) => x.id === recipientId)!
        const lead = s.leads.find((l) => l.id === r.leadId)!
        m = { id: randomUUID(), org: r.org, kind: 'campaign', recipientId, stepId, leadId: r.leadId, accountId: s.accounts[0]!.id, to: lead.email!, subject: `Proposta per ${lead.company_name}`, body: 'Buongiorno, …', status: 'queued', key: `om:${recipientId}:${stepId}`, providerId: null, attempts: 0, error: null }
        s.messages.push(m)
      }
      return { id: m.id, status: m.status }
    },
    async beginSend(id): Promise<BeginSend> {
      const m = s.messages.find((x) => x.id === id)
      if (!m) return { ok: false, reason: 'not_found', permanent: true }
      if (['sent', 'delivered'].includes(m.status)) return { ok: false, reason: 'already_sent', permanent: true }
      if (['cancelled', 'failed', 'unknown'].includes(m.status)) return { ok: false, reason: `message_${m.status}`, permanent: true }
      const acc = s.accounts.find((a) => a.id === m.accountId)!
      if (acc.status !== 'connected') return { ok: false, reason: 'provider_not_connected', permanent: true }
      if (m.kind === 'campaign') {
        if (s.campaign.status !== 'running') return { ok: false, reason: `campaign_${s.campaign.status}`, permanent: true }
        const lead = s.leads.find((l) => l.id === m.leadId)!
        if (lead.contact_status !== 'active') {
          m.status = 'cancelled'
          return { ok: false, reason: 'not_eligible', permanent: true }
        }
      }
      if (m.kind === 'test' && !/@resend\.dev$/.test(m.to) && !s.members.includes(m.to)) {
        m.status = 'cancelled'
        return { ok: false, reason: 'test_address_not_allowed', permanent: true }
      }
      const resume = m.status === 'sending'
      if (!resume) {
        if (s.quotaUsed >= s.quotaLimit) return { ok: false, reason: 'monthly_quota', permanent: false, retry_seconds: 3600 }
        s.quotaUsed++
        m.status = 'sending'
      }
      m.attempts++
      return { ok: true, resume, idempotency_key: m.key, kind: m.kind, lead_id: m.leadId, campaign_id: m.kind === 'campaign' ? s.campaign.id : null, basis: 'legitimate_interest', language: 'it', source_name: 'Siti web pubblici', to_email: m.to, subject: m.subject, body_text: m.body, from_name: 'Kira di Kappa', from_email: acc.from_email, reply_to: null, account_id: acc.id, provider: 'resend' }
    },
    async finishSend(id, outcome, providerId, err) {
      const m = s.messages.find((x) => x.id === id)!
      if (m.status !== 'sending') return
      m.error = err ?? null
      if (outcome === 'sent') {
        m.status = 'sent'
        m.providerId = providerId ?? null
      } else if (outcome === 'failed') m.status = 'failed'
      else if (outcome === 'unknown') m.status = 'unknown'
      else if (outcome === 'requeue') m.status = 'queued'
    },
    async advanceRecipient(recipientId, position) {
      const r = s.recipients.find((x) => x.id === recipientId)!
      r.position = position
      if (!s.steps.some((st) => st.position > position)) r.status = 'completed'
    },
    async stopRecipient(recipientId, reason) {
      const r = s.recipients.find((x) => x.id === recipientId)!
      r.status = 'stopped'
      r.stoppedReason = reason
    },

    async getAccount(org, id) {
      const a = s.accounts.find((x) => x.id === id && (!org || x.organization_id === org))
      return a ? { ...a } : null
    },
    async getAccountSecrets(id) {
      return s.secrets[id] ?? null
    },
    async setAccountStatus(id, patch) {
      Object.assign(s.accounts.find((a) => a.id === id)!, patch)
    },
    async getSenderIdentity() {
      return s.sender
    },
    async createTask(row) {
      if (row.recipientId && s.tasks.some((t) => t.recipientId === row.recipientId && t.kind === row.kind)) return null
      if (row.jobId && s.tasks.some((t) => t.jobId === row.jobId)) return null
      s.tasks.push({ org: row.org, leadId: row.leadId, kind: row.kind, recipientId: row.recipientId, jobId: row.jobId })
      return randomUUID()
    },
    async notify(org, _u, title) {
      s.notifications.push({ org, title })
    },
    async logActivity(org, leadId, subject) {
      s.activities.push({ org, leadId, subject })
    },
    async updateLeadStatus(org, leadId, status) {
      const l = s.leads.find((x) => x.id === leadId && x.org === org)
      if (l) l.status = status
    },
    async getLead(org, leadId) {
      return s.leads.find((l) => l.id === leadId && l.org === org) ?? null
    },
    async fetchPendingEvents(limit) {
      return s.events.filter((e) => !e.processed).slice(0, limit)
    },
    async markEventsProcessed(ids) {
      for (const e of s.events) if (ids.includes(e.id)) e.processed = true
    },
    async runningWorkflows(org, trigger) {
      return s.workflows.filter((w) => w.organization_id === org && w.trigger === trigger && w.status === 'running')
    },
    async recordWorkflowRun(id, err) {
      const w = s.workflows.find((x) => x.id === id)!
      w.runs++
      w.lastError = err
    },
    async getWorkflow(id) {
      return s.workflows.find((w) => w.id === id) ?? null
    },
    async findLeadByEmail(org, email) {
      return s.leads.find((l) => l.org === org && l.email?.toLowerCase() === email.toLowerCase()) ?? null
    },
    async latestOutboundTo(accountId, email) {
      const m = [...s.messages].reverse().find((x) => x.accountId === accountId && x.to === email && x.status === 'sent')
      return m ? { id: m.id, recipient_id: m.recipientId, lead_id: m.leadId } : null
    },
    async insertInbound(row) {
      const ex = s.inbound.find((i) => i.account_id === row.account_id && i.provider_message_id === row.provider_message_id)
      if (ex) return { id: ex.id, duplicate: true }
      const id = randomUUID()
      s.inbound.push({ ...row, id })
      return { id, duplicate: false }
    },
    async createOutbound(row) {
      const ex = s.messages.find((m) => m.key === row.idempotencyKey)
      if (ex) return { id: ex.id, duplicate: true }
      const id = randomUUID()
      s.messages.push({ id, org: row.org, kind: row.kind, recipientId: null, stepId: null, leadId: row.leadId, accountId: row.accountId, to: row.to, subject: row.subject, body: row.body, status: 'queued', key: row.idempotencyKey, providerId: null, attempts: 0, error: null })
      return { id, duplicate: false }
    },
    async applyDeliveryEvent(_acc, eventId, type, providerMessageId) {
      if (s.delivery.some((d) => d.eventId === eventId)) return
      s.delivery.push({ eventId, type, providerMessageId })
      const m = s.messages.find((x) => x.providerId === providerMessageId)
      if (m && type === 'email.delivered') m.status = 'delivered'
    },
    async registerUnsubscribe(id) {
      s.unsubscribed.push(id)
      return true
    },

    // AccountsDb
    async insertAccount(row) {
      const id = randomUUID()
      s.accounts.push({ id, organization_id: row.organization_id, provider: row.provider, status: 'pending', from_email: row.from_email, sending_domain: row.sending_domain, provider_domain_id: null, webhook_configured: false, domain_status: 'not_started', dns_records: [], label: row.label })
      return id
    },
    async updateAccount(org, id, patch) {
      Object.assign(s.accounts.find((a) => a.id === id && a.organization_id === org)!, patch)
    },
    async getAccountFull(org, id) {
      return s.accounts.find((a) => a.id === id && a.organization_id === org) ?? null
    },
    async upsertSecrets(id, _org, patch) {
      s.secrets[id] = { ...{ api_key_ciphertext: null, webhook_secret_ciphertext: null }, ...s.secrets[id], ...patch }
    },
    async deleteSecrets(id) {
      delete s.secrets[id]
    },
    async memberEmails() {
      return s.members
    },
  }
  return { store, state: s }
}

/** Provider Resend simulato a livello HTTP: deduplica per Idempotency-Key come il servizio reale. */
export function fakeResendFetch(opts: { failFirst?: 'timeout_after_accept' | 'auth' | 'permanent' | 'always_500'; received?: Record<string, unknown> } = {}) {
  const sent = new Map<string, { id: string; body: Record<string, unknown>; headers: Record<string, string> }>()
  const calls: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = []
  let first = true
  const impl = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url, method: String(init.method), headers, body })
    const u = new URL(url)
    if (u.pathname === '/emails' && init.method === 'POST') {
      const key = headers['idempotency-key']!
      if (opts.failFirst === 'always_500') return new Response(JSON.stringify({ name: 'internal_server_error' }), { status: 500 })
      if (first && opts.failFirst === 'auth') {
        first = false
        return new Response(JSON.stringify({ name: 'invalid_api_key' }), { status: 401 })
      }
      if (first && opts.failFirst === 'permanent') {
        first = false
        return new Response(JSON.stringify({ name: 'validation_error' }), { status: 422 })
      }
      const existing = sent.get(key)
      if (!existing) sent.set(key, { id: `re_${sent.size + 1}`, body: body!, headers })
      if (first && opts.failFirst === 'timeout_after_accept') {
        first = false
        // Il provider ha accettato, ma la risposta non arriva al client.
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      return new Response(JSON.stringify({ id: sent.get(key)!.id }), { status: 200 })
    }
    if (u.pathname.startsWith('/emails/receiving/')) return new Response(JSON.stringify(opts.received ?? {}), { status: 200 })
    if (u.pathname === '/domains' && init.method === 'POST')
      return new Response(JSON.stringify({ id: 'dom_1', name: body?.name, status: 'not_started', records: [{ record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', status: 'not_started', ttl: 'Auto' }, { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf...', status: 'not_started', ttl: 'Auto' }] }), { status: 200 })
    if (u.pathname === '/domains/dom_1/verify') return new Response(JSON.stringify({ object: 'domain', id: 'dom_1' }), { status: 200 })
    if (u.pathname === '/domains/dom_1')
      return new Response(JSON.stringify({ id: 'dom_1', name: 'mail.kappa.test', status: 'verified', records: [{ record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1', status: 'verified' }, { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=', status: 'verified' }] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { impl, sent, calls }
}
