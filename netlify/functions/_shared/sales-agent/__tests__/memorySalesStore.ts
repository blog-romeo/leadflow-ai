/** SOLO TEST: store in memoria con isolamento per organizzazione e quote. */
import { randomUUID } from 'node:crypto'
import type { LeadRaw, SalesProfile } from '../context'
import type { CampaignContentContext, CopilotSnapshot, DraftWrite, FollowUpTaskRow, InboundRow, ProposalWrite, SalesJob, SalesStore } from '../store'

export interface SalesMemState {
  profiles: Record<string, SalesProfile>
  leads: Record<string, LeadRaw & { org: string }>
  tasks: (FollowUpTaskRow & { org: string; ai_suggestion?: unknown })[]
  jobs: (SalesJob & { output?: unknown; error?: string | null; tokensInput?: number; tokensOutput?: number; costUsd?: number | null })[]
  drafts: (DraftWrite & { id: string; org: string })[]
  proposals: (ProposalWrite & { id: string; org: string })[]
  intelligence: { id: string; org: string; leadId: string; data: Record<string, unknown> }[]
  conversations: { id: string; org: string; user_id: string; lead_id: string | null; archived_at: string | null }[]
  messages: { id: string; org: string; conversation_id: string; role: 'user' | 'assistant'; content: string; structured?: unknown }[]
  usage: { org: string; event: string; qty: number }[]
  activities: { org: string; leadId: string; subject: string }[]
  limits: { generations: number; tokens: number; rpm: number }
  rate: number
  campaigns: (CampaignContentContext & { org: string })[]
  stepVariants: { org: string; stepId: string; variants: unknown[]; warnings: unknown[]; jobId: string }[]
  inbound: { org: string; row: InboundRow }[]
  inboundAnalyses: { org: string; id: string; classification: string; summary: string; suggested_reply: string | null; needs_human: boolean; jobId: string }[]
}

export function createMemorySalesStore(init: Partial<SalesMemState> = {}) {
  const s: SalesMemState = {
    profiles: {}, leads: {}, tasks: [], jobs: [], drafts: [], proposals: [], intelligence: [], conversations: [], messages: [], usage: [], activities: [],
    limits: { generations: 100, tokens: 1_000_000, rpm: 100 }, rate: 0,
    campaigns: [], stepVariants: [], inbound: [], inboundAnalyses: [], ...init,
  }
  const used = (org: string, ev: string) => s.usage.filter((u) => u.org === org && u.event === ev).reduce((a, u) => a + u.qty, 0)
  const store: SalesStore = {
    async checkRateLimit() {
      s.rate++
      return s.rate > s.limits.rpm ? { allowed: false, retry_after: 30 } : { allowed: true }
    },
    async consumeUsage(org, _user, event, qty) {
      const limit = event === 'ai_generation' ? s.limits.generations : s.limits.tokens
      const u = used(org, event)
      if (event === 'ai_generation' && u + qty > limit) return { allowed: false, used: u, limit, remaining: Math.max(0, limit - u) }
      if (qty > 0) s.usage.push({ org, event, qty })
      return { allowed: true, used: u + qty, limit, remaining: Math.max(0, limit - u - qty) }
    },
    async countInflight(org) {
      return s.jobs.filter((j) => j.organizationId === org && (j.status === 'queued' || j.status === 'running')).length
    },
    async getProfile(org) {
      return s.profiles[org] ?? { organizationId: org, commercialName: null, sector: null, offerDescription: null, services: [], priceRange: null, currency: 'EUR', servedAreas: [], idealCustomer: null, differentiators: [], website: null, language: 'it', tone: 'consultative', callToAction: null, bookingUrl: null, commercialTerms: null, followUpDays: [3, 7, 14] }
    },
    async getLead(org, id) {
      const l = s.leads[id]
      return l && l.org === org ? structuredClone(l) : null
    },
    async getFollowUpTask(org, id) {
      const t = s.tasks.find((x) => x.id === id && x.org === org)
      return t ? { ...t } : null
    },
    async getCopilotSnapshot(org): Promise<CopilotSnapshot> {
      const leads = Object.values(s.leads).filter((l) => l.org === org)
      return {
        generated_at: new Date().toISOString(),
        by_stage: {},
        leads: leads.map((l) => ({ id: l.lead.id, company_name: l.lead.company_name, industry: l.lead.industry, city: l.lead.city, stage: l.lead.status, score: l.lead.score, priority: l.lead.priority, contactable: l.lead.contact_status === 'active' && l.lead.status !== 'not_contactable', days_since_activity: 20, has_business_analysis: !!l.businessAnalysis })),
        due_follow_ups: [],
        open_opportunities: [],
      }
    },
    async getConversation(org, id) {
      return s.conversations.find((c) => c.id === id && c.org === org) ?? null
    },
    async getConversationMessages(org, convId) {
      return s.messages.filter((m) => m.org === org && m.conversation_id === convId)
    },
    async createConversation(org, userId, _title, leadId) {
      const id = randomUUID()
      s.conversations.push({ id, org, user_id: userId, lead_id: leadId, archived_at: null })
      return id
    },
    async insertUserMessage(org, convId, content) {
      const id = randomUUID()
      s.messages.push({ id, org, conversation_id: convId, role: 'user', content })
      return id
    },
    async createJob(row) {
      const id = randomUUID()
      s.jobs.push({ id, organizationId: row.org, status: 'queued', task: row.task, leadId: row.leadId, input: row.input, createdBy: row.createdBy })
      return id
    },
    async getJob(id) {
      const j = s.jobs.find((x) => x.id === id)
      return j ? { ...j } : null
    },
    async updateJob(org, id, p) {
      const j = s.jobs.find((x) => x.id === id && x.organizationId === org)
      if (!j) return
      if (p.status) j.status = p.status
      if ('output' in p) j.output = p.output
      if ('error' in p) j.error = p.error
      if (p.tokensInput !== undefined) j.tokensInput = p.tokensInput
      if (p.tokensOutput !== undefined) j.tokensOutput = p.tokensOutput
      if ('costUsd' in p) j.costUsd = p.costUsd
    },
    async insertDrafts(org, rows) {
      return rows.map((r) => {
        const id = randomUUID()
        s.drafts.push({ ...r, id, org })
        return id
      })
    },
    async insertProposal(org, r) {
      const id = randomUUID()
      s.proposals.push({ ...r, id, org })
      return id
    },
    async insertIntelligence(org, leadId, data) {
      const id = randomUUID()
      s.intelligence.push({ id, org, leadId, data })
      return id
    },
    async setFollowUpSuggestion(org, taskId, sug) {
      const t = s.tasks.find((x) => x.id === taskId && x.org === org)
      if (t) t.ai_suggestion = sug
    },
    async insertAssistantMessage(org, convId, r) {
      const id = randomUUID()
      s.messages.push({ id, org, conversation_id: convId, role: 'assistant', content: r.content, structured: r.structured })
      return id
    },
    async logActivity(org, leadId, _actor, subject) {
      s.activities.push({ org, leadId, subject })
    },
    async getCampaignForContent(org, campaignId, position) {
      const c = s.campaigns.find((x) => x.org === org && x.campaign.id === campaignId && x.step.position === position)
      return c ? { campaign: c.campaign, step: c.step, audience: c.audience } : null
    },
    async saveStepVariants(org, stepId, variants, warnings, jobId) {
      s.stepVariants.push({ org, stepId, variants, warnings, jobId })
    },
    async getInbound(org, id) {
      return s.inbound.find((i) => i.org === org && i.row.id === id)?.row ?? null
    },
    async saveInboundAnalysis(org, id, a) {
      s.inboundAnalyses.push({ org, id, ...a })
    },
  }
  return { store, state: s }
}
