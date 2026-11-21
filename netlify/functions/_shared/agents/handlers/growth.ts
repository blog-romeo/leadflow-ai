import type { StepContext, StepHandler, StepResult } from '../engine'
import type { GrowthMetrics } from '../store'
import type { GrowthParams } from '../validation'

/**
 * AI Growth Analyst — analisi delle prestazioni commerciali sui dati EFFETTIVI dell'organizzazione.
 *
 * Nessuna chiamata AI: le affermazioni sono generate da regole e solo quando i dati sono sufficienti.
 * Il confronto tra settori ("percentuale di appuntamenti superiore") richiede un campione minimo per
 * gruppo e un test statistico (z-test su due proporzioni, p < 0,05); in caso contrario viene indicato
 * che i dati non bastano. Le variazioni rispetto al periodo precedente sono descrittive.
 */
export const MIN_SECTOR_LEADS = 30
export const MIN_PERIOD_LEADS = 30

export interface Insight {
  code: string
  params: Record<string, string | number>
  basis: 'data'
  test?: { type: 'two_proportion_z'; z: number; p_value: number }
}

/** Funzione di errore complementare (Abramowitz-Stegun 7.1.26), sufficiente per p-value indicativi. */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x)
  return x >= 0 ? y : 2 - y
}

export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): { z: number; p: number } | null {
  if (n1 <= 0 || n2 <= 0) return null
  const p1 = x1 / n1
  const p2 = x2 / n2
  const pool = (x1 + x2) / (n1 + n2)
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2))
  if (se === 0) return null
  const z = (p1 - p2) / se
  return { z, p: erfc(Math.abs(z) / Math.SQRT2) }
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

export function growthInsights(cur: GrowthMetrics, prev: GrowthMetrics | null): { insights: Insight[]; data_gaps: string[] } {
  const insights: Insight[] = []
  const gaps: string[] = []
  if (cur.leads_acquired === 0) gaps.push('no_leads_in_period')

  // 1. Settori con percentuale di appuntamenti significativamente superiore al resto.
  const sectors = cur.by_sector.filter((s) => s.sector !== 'n/d')
  const eligible = sectors.filter((s) => s.leads >= MIN_SECTOR_LEADS)
  let compared = false
  for (const s of eligible) {
    const rest = sectors.filter((o) => o.sector !== s.sector)
    const nRest = rest.reduce((a, o) => a + o.leads, 0)
    const xRest = rest.reduce((a, o) => a + o.with_appointment, 0)
    if (nRest < MIN_SECTOR_LEADS) continue
    compared = true
    const t = twoProportionZ(s.with_appointment, s.leads, xRest, nRest)
    if (t && t.z > 0 && t.p < 0.05) {
      insights.push({
        code: 'sector_higher_appointment_rate',
        params: { sector: s.sector, rate: pct(s.with_appointment, s.leads), n: s.leads, rest_rate: pct(xRest, nRest), rest_n: nRest },
        basis: 'data',
        test: { type: 'two_proportion_z', z: Math.round(t.z * 100) / 100, p_value: Math.round(t.p * 10000) / 10000 },
      })
    }
  }
  if (!compared) gaps.push('insufficient_data_sector_comparison')
  insights.sort((a, b) => (b.test?.z ?? 0) - (a.test?.z ?? 0))
  const top = insights.slice(0, 3)

  // 2. Contattabilità dei lead acquisiti (descrittivo).
  if (cur.leads_acquired >= MIN_PERIOD_LEADS && cur.leads_contactable / cur.leads_acquired < 0.5) {
    top.push({ code: 'low_contactable_share', params: { rate: pct(cur.leads_contactable, cur.leads_acquired), n: cur.leads_acquired }, basis: 'data' })
  }
  // 3. Tasso di risposta sui lead contattati (descrittivo).
  if (cur.leads_contacted >= MIN_PERIOD_LEADS) {
    top.push({ code: 'response_rate', params: { rate: pct(cur.responses, cur.leads_contacted), responses: cur.responses, contacted: cur.leads_contacted }, basis: 'data' })
  }
  // 4. Variazione del volume di lead rispetto al periodo precedente (descrittivo).
  if (prev && cur.leads_acquired >= MIN_PERIOD_LEADS && prev.leads_acquired >= MIN_PERIOD_LEADS) {
    const change = (cur.leads_acquired - prev.leads_acquired) / prev.leads_acquired
    if (Math.abs(change) >= 0.25) {
      top.push({ code: change > 0 ? 'lead_volume_increase' : 'lead_volume_decrease', params: { current: cur.leads_acquired, previous: prev.leads_acquired, change_pct: Math.round(change * 1000) / 10 }, basis: 'data' })
    }
  }
  if (cur.cost_per_lead_usd === null) gaps.push(cur.leads_acquired === 0 ? 'cost_per_lead_no_leads' : 'costs_not_configured')
  if (cur.won_without_value > 0) gaps.push('won_without_value')
  return { insights: top, data_gaps: gaps }
}

export const growthHandler: StepHandler = {
  agent: 'growth_analyst',
  async run(ctx: StepContext): Promise<StepResult> {
    const p = ctx.workflow.params as unknown as GrowthParams
    const days = p.period_days ?? 90
    const to = ctx.now()
    const from = new Date(to.getTime() - days * 86_400_000)
    const prevFrom = new Date(from.getTime() - days * 86_400_000)
    const [cur, prev] = await ctx.tools.call('metrics.read', { period_days: days }, () =>
      Promise.all([ctx.store.growthMetrics(ctx.orgId, from.toISOString(), to.toISOString()), ctx.store.growthMetrics(ctx.orgId, prevFrom.toISOString(), from.toISOString())]),
    )
    const { insights, data_gaps } = growthInsights(cur, prev)
    const spend = await ctx.store.getMonthlySpend(ctx.orgId, from.toISOString())
    return {
      output: {
        period: { from: from.toISOString(), to: to.toISOString(), days },
        metrics: cur,
        previous: prev,
        agent_credits_in_period: spend.credits,
        insights,
        data_gaps,
        thresholds: { min_sector_leads: MIN_SECTOR_LEADS, min_period_leads: MIN_PERIOD_LEADS, significance: 0.05 },
        counts: { total: insights.length },
      },
      itemsTotal: 1,
      itemsFailed: 0,
    }
  },
}
