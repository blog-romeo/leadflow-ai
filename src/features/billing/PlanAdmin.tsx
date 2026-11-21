import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import type { AiCreditCostRow, BillingPlanRow } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'

type Draft = Pick<BillingPlanRow, 'price_cents' | 'stripe_price_id' | 'monthly_leads' | 'monthly_ai_credits' | 'max_users' | 'is_active'>

const input = 'h-9 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 text-sm tabular'

/**
 * Configurazione amministrativa di prezzi, limiti e costi in crediti. Le modifiche passano
 * dalle RPC admin_update_* che verificano il ruolo super_admin e scrivono l'audit.
 */
export function PlanAdmin() {
  const { t } = useI18n()
  const [plans, setPlans] = useState<BillingPlanRow[]>([])
  const [costs, setCosts] = useState<AiCreditCostRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const [p, c] = await Promise.all([
      supabase.from('billing_plans').select('*').order('sort_order'),
      supabase.from('ai_credit_costs').select('*').order('credits'),
    ])
    setError(Boolean(p.error || c.error))
    const rows = (p.data ?? []) as BillingPlanRow[]
    setPlans(rows)
    setCosts((c.data ?? []) as AiCreditCostRow[])
    setDrafts(Object.fromEntries(rows.map((r) => [r.code, { price_cents: r.price_cents, stripe_price_id: r.stripe_price_id, monthly_leads: r.monthly_leads, monthly_ai_credits: r.monthly_ai_credits, max_users: r.max_users, is_active: r.is_active }])))
    setLoading(false)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const set = (code: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [code]: { ...d[code]!, ...patch } }))

  const savePlan = async (code: string) => {
    if (!supabase) return
    setSaving(code)
    setMessage(null)
    const d = drafts[code]!
    const { error: err } = await supabase.rpc('admin_update_billing_plan', { p_code: code, p_patch: { ...d, stripe_price_id: d.stripe_price_id?.trim() || '' } })
    setSaving(null)
    setMessage(err ? { tone: 'danger', text: t('planAdmin.error') } : { tone: 'ok', text: t('planAdmin.saved') })
    if (!err) void load()
  }
  const saveCost = async (operation: string, credits: number) => {
    if (!supabase) return
    setSaving(operation)
    const { error: err } = await supabase.rpc('admin_update_credit_cost', { p_operation: operation, p_credits: credits })
    setSaving(null)
    setMessage(err ? { tone: 'danger', text: t('planAdmin.error') } : { tone: 'ok', text: t('planAdmin.costSaved') })
    if (!err) void load()
  }

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={t('errors.generic')} onRetry={() => void load()} />

  const num = (v: string) => (v === '' ? 0 : Math.max(0, Math.floor(Number(v))))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('planAdmin.subtitle')}</p>
      {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const d = drafts[p.code]
          if (!d) return null
          return (
            <Panel key={p.code} title={p.name} as="h3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="text-muted">{t('planAdmin.price')}</span>
                  <input className={input} type="number" min={0} value={d.price_cents} onChange={(e) => set(p.code, { price_cents: num(e.target.value) })} />
                </label>
                <label className="space-y-1">
                  <span className="text-muted">{t('planAdmin.users')}</span>
                  <input className={input} type="number" min={1} value={d.max_users} onChange={(e) => set(p.code, { max_users: Math.max(1, num(e.target.value)) })} />
                </label>
                <label className="space-y-1">
                  <span className="text-muted">{t('planAdmin.leads')}</span>
                  <input className={input} type="number" min={0} value={d.monthly_leads} onChange={(e) => set(p.code, { monthly_leads: num(e.target.value) })} />
                </label>
                <label className="space-y-1">
                  <span className="text-muted">{t('planAdmin.credits')}</span>
                  <input className={input} type="number" min={0} value={d.monthly_ai_credits} onChange={(e) => set(p.code, { monthly_ai_credits: num(e.target.value) })} />
                </label>
                <label className="col-span-2 space-y-1">
                  <span className="text-muted">{t('planAdmin.priceId')}</span>
                  <input className={input} value={d.stripe_price_id ?? ''} placeholder="price_…" onChange={(e) => set(p.code, { stripe_price_id: e.target.value })} />
                  <span className="text-muted">{t('planAdmin.priceIdHint')}</span>
                </label>
                <label className="col-span-2 flex items-center gap-2">
                  <input type="checkbox" checked={d.is_active} onChange={(e) => set(p.code, { is_active: e.target.checked })} />
                  <span>{t('planAdmin.active')}</span>
                </label>
              </div>
              <Button size="sm" className="mt-3" onClick={() => void savePlan(p.code)} loading={saving === p.code}>
                {t('planAdmin.save')}
              </Button>
            </Panel>
          )
        })}
      </div>
      <Panel title={t('planAdmin.costsTitle')} as="h3">
        <ul className="divide-y divide-line text-sm">
          {costs.map((c) => (
            <li key={c.operation} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">{c.description}</span>
              <span className="flex items-center gap-2">
                <input
                  className={`${input} w-20`}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={c.credits}
                  aria-label={c.description}
                  onBlur={(e) => {
                    const v = Math.min(100, num(e.target.value))
                    if (v !== c.credits) void saveCost(c.operation, v)
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
