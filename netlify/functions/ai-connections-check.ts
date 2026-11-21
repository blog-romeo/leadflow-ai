import { HttpError, handleError, json, readJson, requireMethod, requireUuid } from './_shared/http'
import { requireOrgMember } from './_shared/auth'
import { assertAgentsEnabled } from './_shared/agents/flags'
import { checkConnections } from './_shared/agents/connections'
import { supabaseAdmin } from './_shared/supabaseAdmin'
import { log } from './_shared/log'

/**
 * POST /api/ai-agents/connections-check — verifica REALE (sola lettura) di OpenAI e Overpass (Prompt 10).
 * Solo amministratori di un'organizzazione con il motore attivo. Nessun token o credito consumato.
 * Risultati (stato, codice, latenza; nessun segreto) salvati in integration_checks, visibili nella console.
 * Limite: una verifica al minuto per la piattaforma (le chiamate successive ricevono l'ultimo esito).
 */
export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST')
    const body = (await readJson(req, 2_000)) as { organization_id?: unknown }
    const orgId = requireUuid(typeof body?.organization_id === 'string' ? body.organization_id : null, 'organization_id')
    const { user } = await requireOrgMember(req, orgId, { admin: true })
    assertAgentsEnabled(orgId)
    const db = supabaseAdmin()
    const { data: recent, error: re } = await db.from('integration_checks').select('key, status, code, latency_ms, checked_at').gte('checked_at', new Date(Date.now() - 60_000).toISOString()).order('checked_at', { ascending: false })
    if (re) throw new HttpError(500, 'storage_error')
    if (recent && recent.length > 0) return json({ cached: true, results: recent })
    const results = await checkConnections()
    const rows = results.map((r) => ({ key: r.key, status: r.state, code: r.code, latency_ms: r.latency_ms }))
    const { error } = await db.from('integration_checks').insert(rows)
    if (error) throw new HttpError(500, 'storage_error')
    await db.from('audit_logs').insert({ organization_id: orgId, actor_id: user.id, action: 'ai_agent.connections_checked', entity_type: 'organization', entity_id: orgId, metadata: { results: rows.map((r) => `${r.key}:${r.status}`) } })
    log('info', 'ai_connections.checked', { results: rows.map((r) => `${r.key}:${r.status}:${r.code}`) })
    return json({ cached: false, results: rows.map((r) => ({ ...r, checked_at: new Date().toISOString() })) })
  } catch (err) {
    return handleError(err, '/api/ai-agents/connections-check')
  }
}

export const config = { path: '/api/ai-agents/connections-check' }
