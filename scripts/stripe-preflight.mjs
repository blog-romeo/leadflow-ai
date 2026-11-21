#!/usr/bin/env node
/**
 * Preflight Stripe (SOLO LETTURA, SOLO MODALITÀ TEST).
 *
 * Verifica, senza creare clienti, pagamenti o abbonamenti, che l'account Stripe di test sia
 * configurato come si aspetta il codice di LeadFlow AI:
 *  - chiave di test (sk_test_/rk_test_); le chiavi live vengono rifiutate;
 *  - Price dei piani: esistenti, attivi, EUR, ricorrenti mensili, importo corretto, tax_behavior;
 *  - Price White Label (canone mensile + attivazione una tantum), se configurati;
 *  - endpoint webhook attivo verso /.netlify/functions/stripe-webhook con gli eventi gestiti;
 *  - configurazione del Customer Portal;
 *  - impostazioni Stripe Tax e registrazioni fiscali (solo lettura: nessuna attivazione).
 *
 * Uso:  STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_STARTER=price_... ... SITE_URL=https://... node scripts/stripe-preflight.mjs
 * Esce con codice 1 se c'è almeno un errore bloccante.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Importi IVA esclusa in centesimi: devono coincidere con src/config/plans.ts (verificato da un test). */
export const EXPECTED_PLANS = { starter: 14900, business: 34900, enterprise: 79900 }
export const EXPECTED_RESELLER = { agency: { monthly: 39900, setup: 299000 }, premium: { monthly: 79900, setup: 599000 } }
export const REQUIRED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]
const API = 'https://api.stripe.com/v1'

export function keyMode(key) {
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key ?? '')) return 'test'
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key ?? '')) return 'live'
  return null
}

/** Controlla un Price. kind: 'recurring' | 'one_time'. Restituisce l'elenco dei problemi. */
export function checkPrice(price, { amount, kind, automaticTax }) {
  const issues = []
  if (!price) return [{ level: 'error', msg: 'Price non trovato' }]
  if (!price.active) issues.push({ level: 'error', msg: 'Price non attivo' })
  if (price.livemode) issues.push({ level: 'error', msg: 'Price in modalità live' })
  if (price.currency !== 'eur') issues.push({ level: 'error', msg: `valuta ${price.currency} (attesa eur)` })
  if (price.unit_amount !== amount) issues.push({ level: 'error', msg: `importo ${price.unit_amount} (atteso ${amount}, IVA esclusa)` })
  if (kind === 'recurring') {
    if (price.type !== 'recurring' || price.recurring?.interval !== 'month' || (price.recurring?.interval_count ?? 1) !== 1)
      issues.push({ level: 'error', msg: 'deve essere ricorrente mensile' })
    if (price.recurring?.usage_type && price.recurring.usage_type !== 'licensed') issues.push({ level: 'error', msg: 'usage_type deve essere licensed' })
  } else if (price.type !== 'one_time') issues.push({ level: 'error', msg: 'la quota di attivazione deve essere one_time' })
  // I prezzi pubblici sono IVA esclusa: con Stripe Tax il Price deve essere "exclusive".
  if (price.tax_behavior === 'inclusive') issues.push({ level: 'error', msg: 'tax_behavior=inclusive: i prezzi pubblicati sono IVA esclusa' })
  else if (price.tax_behavior !== 'exclusive')
    issues.push({ level: automaticTax ? 'error' : 'warn', msg: `tax_behavior=${price.tax_behavior ?? 'unspecified'}: impostare "exclusive" prima di attivare Stripe Tax` })
  return issues
}

export function checkWebhooks(endpoints, siteUrl) {
  const issues = []
  const target = siteUrl ? `${siteUrl.replace(/\/+$/, '')}/.netlify/functions/stripe-webhook` : null
  const matching = (endpoints ?? []).filter((e) => (target ? e.url === target : /\/\.netlify\/functions\/stripe-webhook$/.test(e.url ?? '')))
  if (matching.length === 0) return [{ level: 'error', msg: `nessun endpoint webhook verso ${target ?? '/.netlify/functions/stripe-webhook'}` }]
  const ep = matching[0]
  if (ep.status !== 'enabled') issues.push({ level: 'error', msg: `endpoint ${ep.url} non abilitato (${ep.status})` })
  if (ep.livemode) issues.push({ level: 'error', msg: 'endpoint in modalità live' })
  const events = ep.enabled_events ?? []
  if (!events.includes('*')) {
    const missing = REQUIRED_EVENTS.filter((e) => !events.includes(e))
    if (missing.length) issues.push({ level: 'error', msg: `eventi mancanti: ${missing.join(', ')}` })
  }
  if (matching.length > 1) issues.push({ level: 'warn', msg: `${matching.length} endpoint verso lo stesso URL: eventi duplicati (gestiti, ma da evitare)` })
  return issues
}

export function checkPortal(configs) {
  const list = configs ?? []
  if (list.length === 0) return [{ level: 'error', msg: 'Customer Portal non configurato (Dashboard → Settings → Billing → Customer portal)' }]
  const def = list.find((c) => c.is_default) ?? list[0]
  const issues = []
  if (!def.active) issues.push({ level: 'error', msg: 'configurazione del portale non attiva' })
  const f = def.features ?? {}
  if (!f.invoice_history?.enabled) issues.push({ level: 'warn', msg: 'storico fatture non abilitato nel portale' })
  if (!f.payment_method_update?.enabled) issues.push({ level: 'warn', msg: 'aggiornamento metodo di pagamento non abilitato' })
  if (f.subscription_cancel?.enabled && f.subscription_cancel.mode !== 'at_period_end')
    issues.push({ level: 'error', msg: 'la disdetta dal portale deve avvenire a fine periodo (mode=at_period_end), come nelle condizioni' })
  if (f.subscription_update?.enabled) issues.push({ level: 'warn', msg: 'cambio piano abilitato nel portale: verificare che usi gli stessi Price dei piani' })
  return issues
}

export function checkTax(settings, registrations, automaticTax) {
  const issues = []
  const status = settings?.status ?? 'unknown'
  const active = (registrations ?? []).filter((r) => r.status === 'active')
  if (automaticTax) {
    if (status !== 'active') issues.push({ level: 'error', msg: `STRIPE_AUTOMATIC_TAX=true ma Stripe Tax non è attivo (status=${status})` })
    if (!active.some((r) => r.country === 'IT')) issues.push({ level: 'error', msg: 'STRIPE_AUTOMATIC_TAX=true senza registrazione fiscale attiva per l’Italia' })
  } else {
    issues.push({ level: 'warn', msg: 'STRIPE_AUTOMATIC_TAX non attivo: Stripe non calcola l’IVA (blocco HIGH-2 finché il commercialista non conferma)' })
  }
  if (settings?.head_office?.address && settings.head_office.address.country !== 'IT')
    issues.push({ level: 'warn', msg: `sede fiscale Stripe Tax in ${settings.head_office.address.country}` })
  return issues
}

async function stripeGet(key, path, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${key}`, 'stripe-version': '2025-03-31.basil' } })
  if (res.status === 404) return null
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body?.error?.code ?? ''}`.trim())
  return body
}

export async function runPreflight(env = process.env, fetchImpl = fetch) {
  const report = []
  const add = (area, issues) => report.push({ area, issues: issues.length ? issues : [{ level: 'ok', msg: 'ok' }] })
  const key = env.STRIPE_SECRET_KEY?.trim()
  const mode = keyMode(key)
  if (mode !== 'test') {
    add('chiave', [{ level: 'error', msg: mode === 'live' ? 'chiave LIVE rifiutata: il preflight lavora solo in modalità test' : 'STRIPE_SECRET_KEY assente o non valida' }])
    return report
  }
  const automaticTax = env.STRIPE_AUTOMATIC_TAX?.trim() === 'true'
  for (const [code, amount] of Object.entries(EXPECTED_PLANS)) {
    const id = env[`STRIPE_PRICE_${code.toUpperCase()}`]?.trim()
    if (!id) { add(`price ${code}`, [{ level: 'error', msg: `STRIPE_PRICE_${code.toUpperCase()} non impostato` }]); continue }
    add(`price ${code}`, checkPrice(await stripeGet(key, `/prices/${encodeURIComponent(id)}`, fetchImpl), { amount, kind: 'recurring', automaticTax }))
  }
  for (const [code, exp] of Object.entries(EXPECTED_RESELLER)) {
    for (const [suffix, kind, amount] of [['', 'recurring', exp.monthly], ['_SETUP', 'one_time', exp.setup]]) {
      const name = `STRIPE_PRICE_RESELLER_${code.toUpperCase()}${suffix}`
      const id = env[name]?.trim()
      if (!id) { add(name, [{ level: 'warn', msg: 'non impostato (White Label non vendibile)' }]); continue }
      add(name, checkPrice(await stripeGet(key, `/prices/${encodeURIComponent(id)}`, fetchImpl), { amount, kind, automaticTax }))
    }
  }
  const siteUrl = (env.SITE_URL || env.URL || env.APP_URL || '').trim()
  add('webhook', checkWebhooks((await stripeGet(key, '/webhook_endpoints?limit=100', fetchImpl))?.data, siteUrl))
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) add('webhook secret', [{ level: 'error', msg: 'STRIPE_WEBHOOK_SECRET assente o non valido' }])
  add('customer portal', checkPortal((await stripeGet(key, '/billing_portal/configurations?limit=10', fetchImpl))?.data))
  let settings = null
  let regs = null
  try {
    settings = await stripeGet(key, '/tax/settings', fetchImpl)
    regs = (await stripeGet(key, '/tax/registrations?limit=100', fetchImpl))?.data
  } catch (e) {
    add('stripe tax', [{ level: 'warn', msg: `impostazioni non leggibili (${e.message})` }])
  }
  if (settings !== null || regs !== null) add('stripe tax', checkTax(settings, regs, automaticTax))
  return report
}

function print(report) {
  const icon = { ok: '✓', warn: '!', error: '✗' }
  for (const r of report) for (const i of r.issues) console.log(`${icon[i.level]} [${r.area}] ${i.msg}`)
  const errors = report.flatMap((r) => r.issues).filter((i) => i.level === 'error').length
  console.log(errors ? `\n${errors} errori bloccanti.` : '\nNessun errore bloccante (gli avvisi vanno comunque valutati).')
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreflight()
    .then((r) => { if (print(r)) process.exitCode = 1 })
    .catch((e) => { console.error(`preflight interrotto: ${e.message}`); process.exitCode = 1 })
}
