#!/usr/bin/env node
/**
 * Test di isolamento multi-tenant sul progetto Supabase di STAGING (Prompt 10) — SOLA LETTURA.
 *
 * Accede con due utenti di TEST di due organizzazioni diverse (A e B) e verifica, con la chiave anon e il
 * JWT di ciascun utente (quindi con le policy RLS reali), che:
 *  • ognuno legga la propria organizzazione;
 *  • nessuno legga righe dell'altra organizzazione nelle tabelle commerciali e del motore multi-agent;
 *  • le RPC di un'altra organizzazione rispondano "forbidden";
 *  • le scritture dirette sulle tabelle protette siano rifiutate (tentativo su una tabella di registro).
 * Nessun dato viene modificato: il tentativo di scrittura deve fallire per RLS/privilegi.
 *
 * Variabili: ISO_SUPABASE_URL, ISO_SUPABASE_ANON_KEY, ISO_A_EMAIL, ISO_A_PASSWORD, ISO_A_ORG,
 *            ISO_B_EMAIL, ISO_B_PASSWORD, ISO_B_ORG
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const TABLES = [
  'leads', 'lead_candidates', 'lead_searches', 'sales_opportunities', 'message_drafts', 'campaigns',
  'ai_workflows', 'ai_workflow_steps', 'ai_agent_runs', 'ai_agent_tool_calls', 'ai_agent_approvals',
  'ai_research_evidence', 'ai_agent_costs', 'ai_company_memory', 'ai_agents', 'audit_logs', 'organization_members',
]

export function evaluate(results) {
  const failures = results.filter((r) => !r.pass)
  return { passed: results.length - failures.length, failed: failures.length, failures }
}

async function main(env = process.env) {
  for (const k of ['ISO_SUPABASE_URL', 'ISO_SUPABASE_ANON_KEY', 'ISO_A_EMAIL', 'ISO_A_PASSWORD', 'ISO_A_ORG', 'ISO_B_EMAIL', 'ISO_B_PASSWORD', 'ISO_B_ORG']) {
    if (!(env[k] ?? '').trim()) throw new Error(`${k} mancante`)
  }
  if (env.ISO_A_ORG === env.ISO_B_ORG) throw new Error('servono due organizzazioni diverse')
  const sb = env.ISO_SUPABASE_URL.trim().replace(/\/$/, '')
  const anon = env.ISO_SUPABASE_ANON_KEY.trim()
  const login = async (email, password) => {
    const r = await fetch(`${sb}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    if (!r.ok) throw new Error(`login fallito (${email.replace(/(.).*@/, '$1***@')}): HTTP ${r.status}`)
    return (await r.json()).access_token
  }
  const users = { A: { jwt: await login(env.ISO_A_EMAIL, env.ISO_A_PASSWORD), org: env.ISO_A_ORG }, B: { jwt: await login(env.ISO_B_EMAIL, env.ISO_B_PASSWORD), org: env.ISO_B_ORG } }
  const h = (jwt) => ({ apikey: anon, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' })
  const results = []
  for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
    const u = users[me]
    const foreign = users[other].org
    const own = await fetch(`${sb}/rest/v1/organizations?id=eq.${u.org}&select=id`, { headers: h(u.jwt) }).then((r) => r.json())
    results.push({ check: `${me}: legge la propria organizzazione`, pass: Array.isArray(own) && own.length === 1 })
    for (const t of TABLES) {
      const col = 'organization_id'
      const r = await fetch(`${sb}/rest/v1/${t}?${col}=eq.${foreign}&select=${col}&limit=1`, { headers: h(u.jwt) })
      const body = await r.json().catch(() => null)
      // 200 con 0 righe (RLS) o 401/403/404 (nessun accesso o tabella assente) sono entrambi esiti sicuri.
      results.push({ check: `${me}: nessuna riga di ${other} in ${t}`, pass: (r.ok && Array.isArray(body) && body.length === 0) || [401, 403, 404].includes(r.status), status: r.status })
    }
    const rpc = await fetch(`${sb}/rest/v1/rpc/ai_agent_spend`, { method: 'POST', headers: h(u.jwt), body: JSON.stringify({ p_org: foreign, p_from: new Date(Date.now() - 86_400_000).toISOString() }) })
    results.push({ check: `${me}: RPC ai_agent_spend di ${other} negata`, pass: !rpc.ok, status: rpc.status })
    const write = await fetch(`${sb}/rest/v1/ai_agent_costs`, { method: 'POST', headers: { ...h(u.jwt), prefer: 'return=minimal' }, body: JSON.stringify({ organization_id: u.org, agent_key: 'research', kind: 'ai_tokens', credits: 0 }) })
    results.push({ check: `${me}: scrittura diretta su ai_agent_costs rifiutata`, pass: !write.ok, status: write.status })
    const monitor = await fetch(`${sb}/rest/v1/rpc/sa_ai_monitoring`, { method: 'POST', headers: h(u.jwt), body: JSON.stringify({ p_from: new Date(Date.now() - 86_400_000).toISOString(), p_to: new Date().toISOString() }) })
    results.push({ check: `${me}: monitoraggio Super Admin negato`, pass: !monitor.ok, status: monitor.status })
  }
  return evaluate(results)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await main()
    for (const f of r.failures) console.log(`✗ ${f.check} (HTTP ${f.status ?? '-'})`)
    console.log(`Isolamento: ${r.passed} controlli superati, ${r.failed} falliti.`)
    process.exit(r.failed ? 1 : 0)
  } catch (e) {
    console.error(`isolamento: ${e.message}`)
    process.exit(1)
  }
}
