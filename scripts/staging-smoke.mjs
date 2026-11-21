#!/usr/bin/env node
/**
 * Smoke test di STAGING (Prompt 11) — da eseguire SOLO dopo un deploy riuscito e autorizzato.
 *
 * Controlli HTTP e API (nessun pagamento, nessun invio, nessuna azione sui provider esterni):
 *  1. homepage  2. pagina prezzi  3. registrazione account test (facoltativa, SMOKE_SIGNUP=1)
 *  4. login (utente di test già confermato)  5. organizzazione (lettura; creazione solo con SMOKE_CREATE_ORG=1)
 *  6. dashboard  7. AI Agents  8. AI Workflows  9. endpoint, header di sicurezza, HTTPS
 *  10. isolamento dati: vedi `npm run staging:isolation` (due organizzazioni) — qui solo il controllo base.
 * Le pagine 6–8 sono una SPA: il controllo HTTP verifica il fallback e l'HTML servito; il rendering con i
 * dati si verifica a mano (checklist in docs/STAGING_RUNBOOK.md §8).
 *
 * Variabili: SMOKE_APP_URL, SMOKE_SUPABASE_URL, SMOKE_SUPABASE_ANON_KEY, SMOKE_EMAIL, SMOKE_PASSWORD,
 *            [SMOKE_SIGNUP=1 + SMOKE_SIGNUP_DOMAIN], [SMOKE_CREATE_ORG=1], [SMOKE_ALLOW_URL]
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function assertStaging(env) {
  const url = (env.SMOKE_APP_URL ?? '').trim().replace(/\/$/, '')
  if (!url.startsWith('https://')) throw new Error('SMOKE_APP_URL deve essere https://')
  if (env.CONTEXT === 'production') throw new Error('rifiutato: CONTEXT=production')
  if (!/staging|deploy-preview|--/i.test(url) && env.SMOKE_ALLOW_URL !== url) throw new Error('URL non riconosciuto come staging: impostare SMOKE_ALLOW_URL uguale a SMOKE_APP_URL per confermare')
  return url
}

export const REQUIRED_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy']

export function checkHeaders(headers) {
  return REQUIRED_HEADERS.filter((h) => !headers.get(h))
}

async function main(env = process.env) {
  const app = assertStaging(env)
  const results = []
  const add = (step, name, pass, detail = '') => results.push({ step, name, pass, detail })
  const get = (p, init) => fetch(`${app}${p}`, { redirect: 'manual', ...init })

  // 1–2. Pagine pubbliche
  const home = await get('/')
  const html = await home.text()
  add(1, 'homepage 200 con root React', home.status === 200 && html.includes('id="root"'), `HTTP ${home.status}`)
  const missing = checkHeaders(home.headers)
  add(9, 'header di sicurezza sulla homepage', missing.length === 0, missing.length ? `mancano: ${missing.join(', ')}` : 'ok')
  const prices = await get('/prezzi')
  add(2, 'pagina prezzi 200', prices.status === 200, `HTTP ${prices.status}`)
  const plain = await fetch(app.replace('https://', 'http://') + '/', { redirect: 'manual' }).catch(() => null)
  add(9, 'HTTP reindirizzato a HTTPS', !!plain && [301, 302, 307, 308].includes(plain.status) && (plain.headers.get('location') ?? '').startsWith('https://'), plain ? `HTTP ${plain.status}` : 'nessuna risposta')

  // 9. Endpoint
  const health = await get('/api/health')
  const hj = await health.json().catch(() => ({}))
  add(9, '/api/health', health.status === 200 && hj.status === 'ok', `HTTP ${health.status}`)
  const pricing = await get('/api/pricing')
  add(9, '/api/pricing', pricing.status === 200, `HTTP ${pricing.status}`)
  const noAuth = await get('/api/ai-workflows/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  add(9, 'API protette senza token → 401', noAuth.status === 401, `HTTP ${noAuth.status}`)

  const sb = (env.SMOKE_SUPABASE_URL ?? '').trim().replace(/\/$/, '')
  const anon = (env.SMOKE_SUPABASE_ANON_KEY ?? '').trim()
  if (!sb || !anon || !env.SMOKE_EMAIL || !env.SMOKE_PASSWORD) {
    add(4, 'login (credenziali di test non fornite)', false, 'SMOKE_SUPABASE_URL/ANON_KEY/EMAIL/PASSWORD mancanti')
    return results
  }
  // 3. Registrazione (facoltativa: crea un utente nello staging; usare un dominio controllato dal proprietario)
  if (env.SMOKE_SIGNUP === '1' && env.SMOKE_SIGNUP_DOMAIN) {
    const email = `smoke+${Date.now()}@${env.SMOKE_SIGNUP_DOMAIN}`
    const r = await fetch(`${sb}/auth/v1/signup`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: `Smk-${crypto.randomUUID()}` }) })
    add(3, 'registrazione account test accettata', r.ok, `HTTP ${r.status} (conferma via email secondo le impostazioni Auth)`)
  } else add(3, 'registrazione (saltata: SMOKE_SIGNUP non attivo)', true, 'skipped')

  // 4. Login
  const login = await fetch(`${sb}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD }) })
  add(4, 'login utente di test', login.ok, `HTTP ${login.status}`)
  if (!login.ok) return results
  const { access_token: jwt, user } = await login.json()
  const auth = { apikey: anon, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }

  // 5. Organizzazione
  let orgs = await fetch(`${sb}/rest/v1/organization_members?user_id=eq.${user.id}&select=organization_id,role`, { headers: auth }).then((r) => r.json())
  if ((!Array.isArray(orgs) || orgs.length === 0) && env.SMOKE_CREATE_ORG === '1') {
    const r = await fetch(`${sb}/rest/v1/rpc/create_organization`, { method: 'POST', headers: auth, body: JSON.stringify({ p_name: `Smoke Test ${new Date().toISOString().slice(0, 10)}`, p_country: 'IT' }) })
    add(5, 'creazione organizzazione di test', r.ok, `HTTP ${r.status}`)
    orgs = await fetch(`${sb}/rest/v1/organization_members?user_id=eq.${user.id}&select=organization_id,role`, { headers: auth }).then((x) => x.json())
  }
  add(5, 'utente membro di un\'organizzazione', Array.isArray(orgs) && orgs.length > 0, Array.isArray(orgs) ? `${orgs.length} organizzazioni` : 'errore')
  const org = Array.isArray(orgs) && orgs[0] ? orgs[0].organization_id : null

  // 6–8. Pagine dell'app (SPA) e API degli agenti
  for (const [step, p] of [[6, '/dashboard'], [7, '/dashboard/ai-agents'], [8, '/dashboard/ai-workflows']]) {
    const r = await get(p)
    add(step, `${p} servita (fallback SPA)`, r.status === 200, `HTTP ${r.status}`)
  }
  if (org) {
    const st = await get(`/api/ai-agents/status?organization_id=${org}`, { headers: { authorization: `Bearer ${jwt}` } })
    const sj = await st.json().catch(() => ({}))
    add(7, 'API stato agenti', st.status === 200, `HTTP ${st.status} · motore ${sj.enabled ? 'attivo' : 'non attivo'}`)
    // 10. Isolamento (base): un'organizzazione inventata non è accessibile.
    const foreign = await get(`/api/ai-agents/status?organization_id=00000000-0000-4000-8000-000000000000`, { headers: { authorization: `Bearer ${jwt}` } })
    add(10, 'organizzazione non propria → negata', [403, 404].includes(foreign.status), `HTTP ${foreign.status}`)
    const sa = await get('/api/super-admin/overview', { headers: { authorization: `Bearer ${jwt}` } })
    add(10, 'console Super Admin negata a un utente normale', sa.status === 403, `HTTP ${sa.status}`)
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = await main()
    for (const r of results) console.log(`${r.pass ? '✓' : '✗'} [${r.step}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    const failed = results.filter((r) => !r.pass).length
    console.log(`\nSmoke test: ${results.length - failed} superati, ${failed} falliti. Isolamento completo: npm run staging:isolation`)
    process.exit(failed ? 1 : 0)
  } catch (e) {
    console.error(`smoke: ${e.message}`)
    process.exit(1)
  }
}
