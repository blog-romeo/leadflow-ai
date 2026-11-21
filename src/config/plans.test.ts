import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLANS, RESELLER_PLANS, mergeServerPlans } from './plans'

// I test sono eseguiti dalla radice del repository (npm test).
const root = process.cwd()
const billingSql = readFileSync(resolve(root, 'supabase/migrations/20261122000007_billing.sql'), 'utf8')
const wlSql = readFileSync(resolve(root, 'supabase/migrations/20261123000008_control_center_white_label.sql'), 'utf8')

describe('piani pubblici coerenti con il database (e quindi con Stripe Checkout)', () => {
  for (const p of PLANS) it(p.code, () => {
    const re = new RegExp(`\\('${p.code}', '${p.name}', '[^']*', (\\d+), (\\d+), (\\d+), (\\d+),\\s*array\\[([^\\]]*)\\]`, 's')
    const m = billingSql.match(re)
    expect(m).not.toBeNull()
    const [, price, leads, credits, users, feats] = m!
    expect(Number(price)).toBe(p.priceCents)
    expect(Number(leads)).toBe(p.monthlyLeads)
    expect(Number(credits)).toBe(p.monthlyAiCredits)
    expect(Number(users)).toBe(p.maxUsers)
    expect(feats!.replace(/\s+/g, '').replace(/'/g, '').split(',')).toEqual(p.features)
  })
  it('prezzi richiesti: 149 / 349 / 799 €', () => {
    expect(PLANS.map((p) => p.priceCents)).toEqual([14900, 34900, 79900])
  })
  for (const p of RESELLER_PLANS) it(`White Label ${p.code}`, () => {
    const re = new RegExp(`\\('${p.code}', '${p.name}', (\\d+), (\\d+), (\\d+), (\\d+),`)
    const m = wlSql.match(re)
    expect(m).not.toBeNull()
    expect(m!.slice(1, 5).map(Number)).toEqual([p.setupFeeCents, p.monthlyPriceCents, p.maxOrganizations, p.maxCustomDomains])
  })
  it('i valori del server sostituiscono quelli locali', () => {
    const merged = mergeServerPlans(PLANS, [{ code: 'starter', name: 'Starter', price_cents: 15900, monthly_leads: 250, monthly_ai_credits: 500, max_users: 1, features: ['lead_finder', 'unknown'] }])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ priceCents: 15900, features: ['lead_finder'] })
  })
})
