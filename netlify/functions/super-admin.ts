import { HttpError, handleError, json, readJson } from './_shared/http'
import { requireSuperAdmin } from './_shared/control/roles'
import { rpc } from './_shared/control/rpc'
import { bool, int, isoDate, obj, oneOf, optStr, reason, str, uuid } from './_shared/control/validate'
import { integrationStatus } from './_shared/launch/integrations'
import { AI_TASKS, routeModel } from './_shared/agents/models'
import { agentsEnabledFor, agentsFlag } from './_shared/agents/flags'
import { AGENT_KEYS } from './_shared/agents/types'
import { BENCHMARK_VERSION, EVALUABLE_CONFIG_KEYS, runBenchmark } from './_shared/agents/training/benchmark'
import { DATASETS } from './_shared/agents/training/catalog'
import { supabaseAdmin } from './_shared/supabaseAdmin'

/**
 * /api/super-admin/<azione> — console di piattaforma. Accesso SOLO per profiles.platform_role
 * = 'super_admin' (verificato qui e di nuovo dentro ogni RPC). Le RPC sono chiamate con il JWT
 * dell'utente: il database applica ruolo, rate limit e audit (admin_audit_logs).
 * Nessuna azione tocca Stripe: le sospensioni sono amministrative, non simulano pagamenti.
 */
type Db = Awaited<ReturnType<typeof requireSuperAdmin>>['db']

const GET: Record<string, (db: Db, q: URLSearchParams) => Promise<unknown>> = {
  async overview(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'overview' })
    return rpc(db, 'sa_overview', { p_days: int(q.get('days') ?? '30', 'days', 1, 366) })
  },
  async organizations(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'organizations' })
    const page = int(q.get('page') ?? '1', 'page', 1, 10_000)
    const status = q.get('status')
    return rpc(db, 'sa_organizations', {
      p_search: (q.get('q') ?? '').slice(0, 120) || null,
      p_status: status ? oneOf(status, 'status', ['active', 'suspended'] as const) : null,
      p_limit: 25,
      p_offset: (page - 1) * 25,
    })
  },
  async organization(db, q) {
    const id = uuid(q.get('id'), 'id')
    await rpc(db, 'sa_log_access', { p_section: 'organization_detail' })
    return rpc(db, 'sa_organization_detail', { p_org: id })
  },
  async usage(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'usage' })
    const from = isoDate(q.get('from'), 'from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const to = isoDate(q.get('to'), 'to') ?? new Date().toISOString()
    return rpc(db, 'sa_usage', { p_from: from, p_to: to })
  },
  async resellers(db) {
    await rpc(db, 'sa_log_access', { p_section: 'resellers' })
    const [resellers, domains, plans] = await Promise.all([
      rpc(db, 'sa_resellers'),
      rpc(db, 'sa_domains'),
      db.from('reseller_plans').select('code, name, setup_fee_cents, monthly_price_cents, max_organizations, max_custom_domains, allowed_client_plans, features').order('sort_order'),
    ])
    if (plans.error) throw new HttpError(500, 'storage_error')
    return { resellers, domains, plans: plans.data }
  },
  async settings(db) {
    await rpc(db, 'sa_log_access', { p_section: 'settings' })
    const [settings, flags, billing] = await Promise.all([
      db.from('platform_settings').select('key, value, updated_at'),
      db.from('feature_flags').select('key, description, scope, enabled, updated_at').order('key'),
      db.from('billing_settings').select('free_beta_enabled').maybeSingle(),
    ])
    if (settings.error || flags.error) throw new HttpError(500, 'storage_error')
    return {
      settings: Object.fromEntries((settings.data ?? []).map((s: { key: string; value: unknown }) => [s.key, s.value])),
      flags: flags.data,
      free_beta_enabled: (billing.data as { free_beta_enabled?: boolean } | null)?.free_beta_enabled ?? false,
    }
  },
  async growth(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'growth' })
    const from = isoDate(q.get('from'), 'from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const to = isoDate(q.get('to'), 'to') ?? new Date().toISOString()
    return rpc(db, 'sa_growth', { p_from: from, p_to: to })
  },
  async system(db) {
    await rpc(db, 'sa_log_access', { p_section: 'system' })
    const status = (await rpc(db, 'sa_system_status')) as Record<string, unknown>
    return { ...status, integrations: integrationStatus(), release: process.env.COMMIT_REF?.slice(0, 12) ?? null, context: process.env.CONTEXT ?? null }
  },
  // Prompt 9: osservabilità del motore multi-agent (solo aggregati, nessun contenuto commerciale).
  async 'ai-monitoring'(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'ai_monitoring' })
    const from = isoDate(q.get('from'), 'from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const to = isoDate(q.get('to'), 'to') ?? new Date().toISOString()
    const org = q.get('organization_id')
    const agent = q.get('agent')
    const status = q.get('status')
    const data = await rpc(db, 'sa_ai_monitoring', {
      p_from: from,
      p_to: to,
      p_org: org ? uuid(org, 'organization_id') : null,
      p_agent: agent ? oneOf(agent, 'agent', AGENT_KEYS) : null,
      p_status: status ? oneOf(status, 'status', ['pending', 'running', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled'] as const) : null,
    })
    // Provider e modelli: solo presenza della configurazione (nessun valore dei segreti).
    const keys = ['supabase', 'openai', 'overpass', 'google_places', 'internal_secret']
    const providers = integrationStatus().filter((i) => keys.includes(i.key))
    const routing = AI_TASKS.map((task) => {
      const r = routeModel(task, null)
      return { task, requested: r.requested, effective: r.effective, configured: !!r.model, model: r.model, fallback: r.fallback }
    })
    return { ...(data as Record<string, unknown>), providers, routing, engine_enabled: agentsFlag().enabled, pilot_orgs: agentsFlag().pilotOrgs?.length ?? null, engine_enabled_for_filter: org ? agentsEnabledFor(org) : null }
  },
  // Prompt 12: AI Training (versioni, benchmark, feedback aggregati). Nessun contenuto dei clienti.
  async 'ai-training'(db) {
    await rpc(db, 'sa_log_access', { p_section: 'ai_training' })
    const overview = (await rpc(db, 'sa_ai_training_overview')) as Record<string, unknown>
    return { ...overview, datasets: DATASETS, benchmark_version: BENCHMARK_VERSION, evaluable_config_keys: EVALUABLE_CONFIG_KEYS, applied_config_keys: ['quality_reviewer.blocking_codes'] }
  },
  async 'demo-requests'(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'demo_requests' })
    const status = q.get('status')
    return rpc(db, 'sa_demo_requests', { p_status: status ? oneOf(status, 'status', ['new', 'contacted', 'scheduled', 'closed', 'spam'] as const) : null })
  },
  async 'support-tickets'(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'support' })
    const status = q.get('status')
    return rpc(db, 'sa_support_tickets', { p_status: status ? oneOf(status, 'status', ['open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'] as const) : null })
  },
  async audit(db, q) {
    await rpc(db, 'sa_log_access', { p_section: 'audit' })
    const page = int(q.get('page') ?? '1', 'page', 1, 10_000)
    let query = db.from('admin_audit_logs').select('id, actor_id, actor_role, action, target_type, target_id, reason, metadata, created_at', { count: 'exact' })
      .order('created_at', { ascending: false }).range((page - 1) * 50, page * 50 - 1)
    const action = q.get('action')
    if (action) query = query.like('action', `${str(action, 'action', 2, 60).replace(/[%_\\]/g, '')}%`)
    const { data, count, error } = await query
    if (error) throw new HttpError(500, 'storage_error')
    return { rows: data, total: count ?? 0 }
  },
}

const POST: Record<string, (db: Db, b: Record<string, unknown>, userId: string) => Promise<unknown>> = {
  // Prompt 12: benchmark eseguito dal SERVER sui dataset sintetici versionati; il risultato è registrato con
  // la service role (un utente non può inserire o alterare un esito di benchmark).
  'ai-benchmark-run': async (db, b, userId) => {
    let candidate: Parameters<typeof runBenchmark>[1]
    let candidateId: string | null = null
    if (b.candidate_version_id !== undefined && b.candidate_version_id !== null) {
      candidateId = uuid(b.candidate_version_id, 'candidate_version_id')
      const { data: v, error } = await db.from('ai_agent_config_versions').select('id, config_key, config, status').eq('id', candidateId).maybeSingle()
      if (error) throw new HttpError(500, 'storage_error')
      if (!v || v.status !== 'candidate') throw new HttpError(409, 'version_not_candidate')
      const { data: active } = await db.from('ai_agent_config_versions').select('config').eq('config_key', v.config_key).eq('status', 'active').maybeSingle()
      candidate = { config_key: v.config_key as string, config: v.config as Record<string, unknown>, baseline_config: (active?.config as Record<string, unknown> | undefined) ?? null }
    }
    const report = await runBenchmark(() => new Date(), candidate)
    const gate = report.candidate_config?.gate_passed ?? false
    const { data, error } = await supabaseAdmin().from('ai_benchmark_runs').insert({ benchmark_version: report.benchmark_version, data_kind: report.data_kind, candidate_version_id: candidateId, report, gate_passed: gate, executed_by: userId }).select('id').single()
    if (error) throw new HttpError(500, 'storage_error')
    return { id: (data as { id: string }).id, gate_passed: gate, candidate_config: report.candidate_config ?? null, comparisons: report.comparisons }
  },
  'ai-config-propose': async (db, b) => ({
    id: await rpc(db, 'sa_ai_config_propose', {
      p_agent: oneOf(b.agent_key, 'agent_key', [...AGENT_KEYS, 'quality_reviewer'] as const),
      p_config_key: str(b.config_key, 'config_key', 3, 61),
      p_kind: oneOf(b.kind, 'kind', ['prompt', 'retrieval', 'few_shot', 'fine_tuned_model', 'rules'] as const),
      p_version: str(b.version, 'version', 5, 20),
      p_config: obj(b.config, 'config'),
      p_notes: optStr(b.notes, 'notes', 2000),
    }),
  }),
  'ai-config-activate': (db, b) => rpc(db, 'sa_ai_config_activate', { p_version: uuid(b.version_id, 'version_id'), p_benchmark: uuid(b.benchmark_id, 'benchmark_id'), p_reason: reason(b.reason) }),
  'ai-config-reject': (db, b) => rpc(db, 'sa_ai_config_reject', { p_version: uuid(b.version_id, 'version_id'), p_reason: reason(b.reason) }),
  'free-beta': (db, b) => rpc(db, 'sa_set_free_beta', { p_enabled: b.enabled === true, p_backfill: b.backfill === true, p_reason: reason(b.reason) }),
  'ai-config-rollback': (db, b) => rpc(db, 'sa_ai_config_rollback', { p_config_key: str(b.config_key, 'config_key', 3, 61), p_reason: reason(b.reason) }),
  'organization-status': (db, b) =>
    rpc(db, 'sa_set_organization_status', { p_org: uuid(b.organization_id, 'organization_id'), p_action: oneOf(b.action, 'action', ['suspend', 'reactivate'] as const), p_reason: reason(b.reason) }),
  'note-add': (db, b) =>
    rpc(db, 'sa_add_note', { p_target_type: oneOf(b.target_type, 'target_type', ['organization', 'reseller'] as const), p_target_id: uuid(b.target_id, 'target_id'), p_body: str(b.body, 'body', 1, 4000) }),
  'note-delete': (db, b) => rpc(db, 'sa_delete_note', { p_note: uuid(b.note_id, 'note_id') }),
  'org-ai-cap': (db, b) =>
    rpc(db, 'sa_set_org_ai_cap', {
      p_org: uuid(b.organization_id, 'organization_id'),
      p_cap_usd: b.cap_usd === null ? null : typeof b.cap_usd === 'number' && b.cap_usd >= 0 && b.cap_usd <= 1_000_000 ? b.cap_usd : (() => { throw new HttpError(400, 'invalid_cap_usd') })(),
      p_reason: reason(b.reason),
    }),
  setting: (db, b) => rpc(db, 'sa_update_setting', { p_key: oneOf(b.key, 'key', ['cost_controls', 'operations', 'white_label'] as const), p_value: obj(b.value, 'value'), p_reason: reason(b.reason) }),
  flag: (db, b) => rpc(db, 'sa_set_feature_flag', { p_key: str(b.key, 'key', 2, 40), p_enabled: bool(b.enabled, 'enabled'), p_reason: reason(b.reason) }),
  'flag-override': (db, b) =>
    rpc(db, 'sa_set_flag_override', {
      p_key: str(b.key, 'key', 2, 40),
      p_target_type: oneOf(b.target_type, 'target_type', ['organization', 'reseller'] as const),
      p_target: uuid(b.target_id, 'target_id'),
      p_enabled: b.enabled === null ? null : bool(b.enabled, 'enabled'),
      p_reason: reason(b.reason),
    }),
  'reseller-create': async (db, b) => ({
    id: await rpc(db, 'sa_create_reseller', {
      p_name: str(b.name, 'name', 2, 120),
      p_slug: str(b.slug, 'slug', 2, 41).toLowerCase(),
      p_plan: oneOf(b.plan_code, 'plan_code', ['agency', 'premium'] as const),
      p_admin_email: str(b.admin_email, 'admin_email', 3, 254),
      p_contact_email: optStr(b.contact_email, 'contact_email', 254),
      p_wholesale: b.wholesale_prices === undefined ? {} : obj(b.wholesale_prices, 'wholesale_prices'),
      p_max_orgs: b.max_organizations === undefined || b.max_organizations === null ? null : int(b.max_organizations, 'max_organizations', 0, 10_000),
    }),
  }),
  'reseller-update': (db, b) => rpc(db, 'sa_update_reseller', { p_reseller: uuid(b.reseller_id, 'reseller_id'), p_patch: obj(b.patch, 'patch'), p_reason: reason(b.reason) }),
  'reseller-status': (db, b) =>
    rpc(db, 'sa_set_reseller_status', { p_reseller: uuid(b.reseller_id, 'reseller_id'), p_action: oneOf(b.action, 'action', ['suspend', 'reactivate'] as const), p_reason: reason(b.reason) }),
  'reseller-member': (db, b) =>
    rpc(db, 'sa_set_reseller_member', {
      p_reseller: uuid(b.reseller_id, 'reseller_id'),
      p_email: str(b.email, 'email', 3, 254),
      p_role: b.role === null ? null : oneOf(b.role, 'role', ['reseller_admin', 'reseller_member'] as const),
      p_reason: reason(b.reason),
    }),
  'reseller-external-billing': (db, b) =>
    rpc(db, 'sa_set_reseller_external_billing', { p_reseller: uuid(b.reseller_id, 'reseller_id'), p_active: bool(b.active, 'active'), p_reason: reason(b.reason) }),
  'demo-request': (db, b) =>
    rpc(db, 'sa_update_demo_request', {
      p_id: uuid(b.id, 'id'),
      p_status: oneOf(b.status, 'status', ['new', 'contacted', 'scheduled', 'closed', 'spam'] as const),
      p_note: optStr(b.note, 'note', 2000),
    }),
  'ticket-reply': async (db, b) => ({ id: await rpc(db, 'support_reply', { p_ticket: uuid(b.ticket_id, 'ticket_id'), p_body: str(b.body, 'body', 1, 5000) }) }),
  'ticket-status': (db, b) =>
    rpc(db, 'support_set_status', { p_ticket: uuid(b.ticket_id, 'ticket_id'), p_status: oneOf(b.status, 'status', ['open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'] as const) }),
  'ticket-read': (db, b) => rpc(db, 'support_mark_read', { p_ticket: uuid(b.ticket_id, 'ticket_id') }),
  'domain-provisioned': (db, b) =>
    rpc(db, 'sa_mark_domain_provisioned', { p_domain: uuid(b.domain_id, 'domain_id'), p_done: bool(b.done, 'done'), p_reason: reason(b.reason) }),
}

export default async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url)
    const action = url.pathname.replace(/^\/api\/super-admin\/?/, '')
    const table = req.method === 'GET' ? GET : req.method === 'POST' ? POST : null
    if (!table) return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' })
    const handler = Object.hasOwn(table, action) ? table[action] : undefined
    if (!handler) throw new HttpError(404, 'unknown_action')
    // Autorizzazione PRIMA di leggere il body o eseguire qualsiasi azione.
    const { db, user } = await requireSuperAdmin(req)
    const result = req.method === 'GET' ? await (handler as (typeof GET)[string])(db, url.searchParams) : await (handler as (typeof POST)[string])(db, obj(await readJson(req, 32_000), 'body'), user.id)
    return json(result ?? { ok: true })
  } catch (err) {
    return handleError(err, '/api/super-admin')
  }
}
export const config = { path: '/api/super-admin/*' }
