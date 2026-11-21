import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, CreditCard, ExternalLink, FileText, RefreshCw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api'
import { cn } from '../../lib/cn'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { useMoney } from '../../features/sales/ProposalBuilder'
import { billingApiErrorMessage } from '../../features/billing/errors'
import type { BillingPlan, BillingStatus, SubscriptionStatus } from '../../features/billing/types'

const STATUS_TONE: Record<SubscriptionStatus, 'ok' | 'signal' | 'danger' | 'neutral' | 'flow'> = {
  active: 'ok',
  trialing: 'flow',
  past_due: 'signal',
  incomplete: 'signal',
  unpaid: 'danger',
  canceled: 'neutral',
  incomplete_expired: 'neutral',
  paused: 'neutral',
}

/** Solo URL HTTPS di Stripe: nessun redirect verso domini arbitrari. */
function safeStripeUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com')) ? u.href : null
  } catch {
    return null
  }
}

function Meter({ label, value, detail, ratio }: { label: string; value: string; detail: string; ratio: number }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-control)] border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular mt-0.5 font-display text-2xl font-semibold">{value}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
        <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-danger' : ratio > 0.8 ? 'bg-signal' : 'bg-flow')} style={{ width: `${Math.min(1, ratio) * 100}%` }} />
      </div>
      <p className="tabular mt-1.5 text-xs text-muted">{detail}</p>
    </div>
  )
}

type Pending = { kind: 'change'; plan: BillingPlan; direction: 'upgrade' | 'downgrade' } | { kind: 'cancel' } | null

export default function Billing() {
  const { t, formatDate, formatNumber } = useI18n()
  const { currentOrg, isOrgAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<BillingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [checkoutState, setCheckoutState] = useState<'waiting' | 'confirmed' | 'timeout' | 'cancelled' | null>(null)
  const polls = useRef(0)
  const orgId = currentOrg?.id

  const load = useCallback(async () => {
    if (!orgId) return null
    setLoadError(false)
    try {
      const res = await apiFetch<BillingStatus>(`/api/billing/status?organization_id=${orgId}`)
      setData(res)
      return res
    } catch {
      setLoadError(true)
      return null
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  // Ritorno da Stripe Checkout: il piano si attiva SOLO quando arriva il webhook firmato.
  // Qui ci limitiamo a rileggere lo stato dal database finché la conferma non compare.
  useEffect(() => {
    const flag = params.get('checkout')
    if (!flag) return
    const next = new URLSearchParams(params)
    next.delete('checkout')
    setParams(next, { replace: true })
    if (flag === 'cancelled') return setCheckoutState('cancelled')
    if (flag !== 'success') return
    setCheckoutState('waiting')
    polls.current = 0
    const timer = window.setInterval(async () => {
      polls.current += 1
      const res = await load()
      if (res?.entitlements.has_access && res.subscription?.source === 'stripe') {
        setCheckoutState('confirmed')
        window.clearInterval(timer)
      } else if (polls.current >= 20) {
        setCheckoutState('timeout')
        window.clearInterval(timer)
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  const sub = data?.subscription ?? null
  const plans = data?.plans ?? []
  const currentPlan = plans.find((p) => p.code === sub?.plan_code) ?? null
  const hasStripeSub = Boolean(sub && sub.source === 'stripe' && !['canceled', 'incomplete_expired'].includes(sub.status))
  const currency = (sub?.currency ?? currentPlan?.currency ?? plans[0]?.currency ?? 'eur').toUpperCase()
  const money = useMoney(currency)
  const cents = (n: number | null | undefined) => money((n ?? 0) / 100)

  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key)
      setActionError(null)
      try {
        await fn()
      } catch (err) {
        setActionError(billingApiErrorMessage(err, t))
      } finally {
        setBusy(null)
      }
    },
    [t],
  )

  const redirect = (url: string) => {
    const safe = safeStripeUrl(url)
    if (!safe) throw new Error('unsafe_redirect')
    window.location.assign(safe)
  }

  const checkout = (plan: BillingPlan) =>
    run(`checkout:${plan.code}`, async () => {
      const r = await apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: { organization_id: orgId, plan: plan.code } })
      redirect(r.url)
    })
  const portal = () =>
    run('portal', async () => {
      const r = await apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST', body: { organization_id: orgId } })
      redirect(r.url)
    })
  const confirmPending = () => {
    if (!pending) return
    const p = pending
    setPending(null)
    if (p.kind === 'change') {
      void run(`change:${p.plan.code}`, async () => {
        await apiFetch('/api/billing/change-plan', { method: 'POST', body: { organization_id: orgId, plan: p.plan.code } })
        await load()
      })
    } else {
      void run('cancel', async () => {
        await apiFetch('/api/billing/cancel', { method: 'POST', body: { organization_id: orgId, action: 'cancel', confirm: true } })
        await load()
      })
    }
  }
  const resume = () =>
    run('resume', async () => {
      await apiFetch('/api/billing/cancel', { method: 'POST', body: { organization_id: orgId, action: 'resume' } })
      await load()
    })

  const usage = data?.usage
  const periodLabel = useMemo(
    () => (usage?.period_start && usage.period_end ? t('billing.period', { start: formatDate(usage.period_start), end: formatDate(usage.period_end) }) : null),
    [usage, t, formatDate],
  )

  if (loading) return <LoadingState />
  if (loadError || !data) return <ErrorState message={t('billing.errors.generic')} onRetry={() => void load()} />

  const canManage = isOrgAdmin && data.stripe.configured
  const featureLabel = (f: string) => t(`billing.features.${f}`)

  return (
    <>
      <PageHeader
        title={t('billing.title')}
        subtitle={t('billing.subtitle')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void load()} aria-label={t('billing.refresh')}>
            <RefreshCw className="size-4" aria-hidden />
            {t('billing.refresh')}
          </Button>
        }
      />
      <div className="space-y-5">
        {checkoutState === 'waiting' && <InlineAlert tone="signal">{t('billing.checkoutSuccess')}</InlineAlert>}
        {checkoutState === 'confirmed' && <InlineAlert tone="ok">{t('billing.checkoutConfirmed')}</InlineAlert>}
        {checkoutState === 'timeout' && <InlineAlert tone="signal">{t('billing.checkoutPending')}</InlineAlert>}
        {checkoutState === 'cancelled' && <InlineAlert tone="signal">{t('billing.checkoutCancelled')}</InlineAlert>}
        {actionError && <InlineAlert>{actionError}</InlineAlert>}
        {data.stripe.mode === 'test' && <InlineAlert tone="signal">{t('billing.testMode')}</InlineAlert>}
        {!data.stripe.configured && (
          <InlineAlert tone="signal">
            {t('billing.notConfigured')}
            {isOrgAdmin && [...data.stripe.missing, ...data.stripe.blocked].length > 0 && (
              <span className="block text-xs">{t('billing.notConfiguredAdmin', { list: [...data.stripe.missing, ...data.stripe.blocked].join(', ') })}</span>
            )}
          </InlineAlert>
        )}
        {!data.entitlements.enforced && <InlineAlert tone="signal">{t('billing.notEnforced')}</InlineAlert>}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* ── Piano attuale ─────────────────────────────────────────────── */}
          <Panel title={t('billing.currentPlan')}>
            {sub && currentPlan ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-display text-2xl font-semibold">{currentPlan.name}</span>
                  <Badge tone={STATUS_TONE[sub.status]}>{t(`billing.status.${sub.status}`)}</Badge>
                </div>
                {sub.source === 'manual' ? (
                  <p className="text-sm text-muted">{t('billing.manualPlan')}</p>
                ) : (
                  <p className="text-sm">
                    <span className="tabular font-semibold">{cents(sub.unit_amount_cents ?? currentPlan.price_cents)}</span>
                    <span className="text-muted">
                      {t('billing.perMonth')} · {t('billing.vatExcluded')}
                    </span>
                  </p>
                )}
                {sub.current_period_end && sub.source === 'stripe' && (
                  <p className="text-sm text-muted">
                    {sub.cancel_at_period_end || sub.status === 'canceled' ? t('billing.endsOn') : t('billing.nextRenewal')}:{' '}
                    <time dateTime={sub.current_period_end} className="text-ink">
                      {formatDate(sub.current_period_end)}
                    </time>
                  </p>
                )}
                {sub.cancel_at_period_end && sub.current_period_end && (
                  <InlineAlert tone="signal">{t('billing.cancelScheduled', { date: formatDate(sub.current_period_end) })}</InlineAlert>
                )}
                {sub.status === 'past_due' && <InlineAlert tone="signal">{t('billing.pastDue')}</InlineAlert>}
                {!data.entitlements.has_access && data.entitlements.enforced && <InlineAlert>{t('billing.inactive')}</InlineAlert>}
              </div>
            ) : (
              <p className="text-sm text-muted">{t('billing.noSubscription')}</p>
            )}

            {isOrgAdmin ? (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                {data.has_customer && (
                  <Button variant="secondary" size="sm" onClick={() => void portal()} loading={busy === 'portal'} disabled={!canManage || !!busy}>
                    <CreditCard className="size-4" aria-hidden />
                    {t('billing.manage')}
                  </Button>
                )}
                {hasStripeSub && sub && !sub.cancel_at_period_end && (
                  <Button variant="ghost" size="sm" onClick={() => setPending({ kind: 'cancel' })} disabled={!canManage || !!busy} loading={busy === 'cancel'}>
                    {t('billing.cancel')}
                  </Button>
                )}
                {hasStripeSub && sub?.cancel_at_period_end && (
                  <Button variant="secondary" size="sm" onClick={() => void resume()} disabled={!canManage || !!busy} loading={busy === 'resume'}>
                    {t('billing.resume')}
                  </Button>
                )}
                {data.has_customer && <p className="w-full text-xs text-muted">{t('billing.manageHint')}</p>}
              </div>
            ) : (
              <p className="mt-4 border-t border-line pt-4 text-xs text-muted">{t('billing.adminOnly')}</p>
            )}
          </Panel>

          {/* ── Consumi del periodo ───────────────────────────────────────── */}
          <Panel title={t('billing.usageTitle')} action={periodLabel ? <span className="text-xs text-muted">{periodLabel}</span> : undefined}>
            {usage && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Meter
                  label={t('billing.credits')}
                  value={formatNumber(usage.ai_credits.available)}
                  ratio={usage.ai_credits.limit > 0 ? (usage.ai_credits.used + usage.ai_credits.reserved) / usage.ai_credits.limit : 0}
                  detail={t('billing.creditsDetail', { used: formatNumber(usage.ai_credits.used), reserved: formatNumber(usage.ai_credits.reserved), limit: formatNumber(usage.ai_credits.limit) })}
                />
                <Meter
                  label={t('billing.leads')}
                  value={formatNumber(usage.leads.used)}
                  ratio={usage.leads.limit > 0 ? usage.leads.used / usage.leads.limit : 0}
                  detail={t('billing.leadsDetail', { used: formatNumber(usage.leads.used), limit: formatNumber(usage.leads.limit), remaining: formatNumber(usage.leads.remaining) })}
                />
                <Meter
                  label={t('billing.users')}
                  value={formatNumber(usage.users.used)}
                  ratio={usage.users.limit > 0 ? usage.users.used / usage.users.limit : 0}
                  detail={t('billing.usersDetail', { used: formatNumber(usage.users.used), limit: formatNumber(usage.users.limit) })}
                />
              </div>
            )}
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium">{t('billing.creditDefinitionTitle')}</summary>
              <p className="mt-2 text-muted">{t('billing.creditDefinition')}</p>
              <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">{t('billing.creditCostsTitle')}</h3>
              <ul className="mt-1.5 divide-y divide-line">
                {data.credit_costs.map((c) => (
                  <li key={c.operation} className="flex justify-between gap-3 py-1.5">
                    <span>{c.description}</span>
                    <span className="tabular whitespace-nowrap font-medium">{c.credits === 1 ? t('billing.creditUnit') : t('billing.creditsUnit', { n: c.credits })}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted">{t('billing.creditCostsNote')}</p>
            </details>
          </Panel>
        </div>

        {/* ── Piani ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="plans-title">
          <h2 id="plans-title" className="mb-3 text-base font-semibold">
            {t('billing.plansTitle')}
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {plans.filter((p) => p.is_active).map((p) => {
              const isCurrent = p.code === sub?.plan_code && data.entitlements.has_access
              const direction: 'upgrade' | 'downgrade' = currentPlan && p.price_cents < currentPlan.price_cents ? 'downgrade' : 'upgrade'
              const label = hasStripeSub ? t('billing.switchTo', { plan: p.name }) : t('billing.choose', { plan: p.name })
              return (
                <article key={p.code} className={cn('flex min-w-0 flex-col rounded-[var(--radius-panel)] border bg-surface p-5', isCurrent ? 'border-flow' : 'border-line')}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-display text-lg font-semibold">{p.name}</h3>
                    {isCurrent && <Badge tone="flow">{t('billing.current')}</Badge>}
                  </div>
                  <p className="mt-1">
                    <span className="tabular font-display text-3xl font-semibold">{money(p.price_cents / 100)}</span>
                    <span className="text-sm text-muted">{t('billing.perMonth')}</span>
                  </p>
                  <p className="text-xs text-muted">{t('billing.vatExcluded')}</p>
                  {p.description && <p className="mt-2 text-sm text-muted">{p.description}</p>}
                  <ul className="mt-3 space-y-1.5 text-sm">
                    <li className="tabular">{t('billing.limits.leads', { n: formatNumber(p.monthly_leads) })}</li>
                    <li className="tabular">{t('billing.limits.credits', { n: formatNumber(p.monthly_ai_credits) })}</li>
                    <li>{p.max_users === 1 ? t('billing.limits.user') : t('billing.limits.users', { n: p.max_users })}</li>
                    {['crm', ...p.features].map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                        {featureLabel(f)}
                      </li>
                    ))}
                  </ul>
                  {isOrgAdmin && !isCurrent && (
                    <div className="mt-auto pt-4">
                      <Button
                        className="w-full"
                        variant={hasStripeSub ? 'secondary' : 'primary'}
                        disabled={!canManage || !p.purchasable || !!busy || (hasStripeSub && sub?.status !== 'active' && sub?.status !== 'trialing')}
                        loading={busy === `checkout:${p.code}` || busy === `change:${p.code}`}
                        onClick={() => (hasStripeSub ? setPending({ kind: 'change', plan: p, direction }) : void checkout(p))}
                      >
                        {busy === `checkout:${p.code}` ? t('billing.redirecting') : label}
                      </Button>
                      {!p.purchasable && data.stripe.configured && <p className="mt-1.5 text-xs text-muted">{t('billing.notPurchasable')}</p>}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>

        {/* ── Fatture ───────────────────────────────────────────────────── */}
        {isOrgAdmin && (
          <Panel title={t('billing.invoicesTitle')}>
            {data.invoices.length === 0 ? (
              <p className="text-sm text-muted">{t('billing.invoicesEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">{t('billing.colNumber')}</th>
                      <th className="py-2 pr-3 font-medium">{t('billing.colDate')}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t('billing.colNet')}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t('billing.colTotal')}</th>
                      <th className="py-2 pr-3 font-medium">{t('billing.colStatus')}</th>
                      <th className="py-2 font-medium">
                        <span className="sr-only">PDF</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.invoices.map((inv) => {
                      const date = inv.paid_at ?? inv.stripe_created_at
                      const fmt = (n: number | null) => new Intl.NumberFormat(undefined, { style: 'currency', currency: inv.currency.toUpperCase() }).format((n ?? 0) / 100)
                      return (
                        <tr key={inv.stripe_invoice_id}>
                          <td className="py-2 pr-3">{inv.number ?? '—'}</td>
                          <td className="py-2 pr-3">{date ? formatDate(date) : '—'}</td>
                          <td className="tabular py-2 pr-3 text-right">{fmt(inv.total_excluding_tax_cents)}</td>
                          <td className="tabular py-2 pr-3 text-right">{fmt(inv.total_cents)}</td>
                          <td className="py-2 pr-3">
                            <Badge tone={inv.status === 'paid' ? 'ok' : inv.status === 'open' ? 'signal' : 'neutral'}>{t(`billing.invoiceStatus.${inv.status}`)}</Badge>
                          </td>
                          <td className="py-2">
                            <span className="flex gap-3">
                              {inv.hosted_invoice_url && safeStripeUrl(inv.hosted_invoice_url) && (
                                <a className="inline-flex items-center gap-1 text-flow hover:underline" href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                                  <ExternalLink className="size-3.5" aria-hidden />
                                  {t('billing.open')}
                                </a>
                              )}
                              {inv.invoice_pdf && safeStripeUrl(inv.invoice_pdf) && (
                                <a className="inline-flex items-center gap-1 text-flow hover:underline" href={inv.invoice_pdf} target="_blank" rel="noopener noreferrer">
                                  <FileText className="size-3.5" aria-hidden />
                                  {t('billing.pdf')}
                                </a>
                              )}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-xs text-muted">{t('billing.taxNotice')}</p>
          </Panel>
        )}
      </div>

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        closeLabel={t('billing.back')}
        title={pending?.kind === 'change' ? t('billing.changeTitle', { plan: pending.plan.name }) : t('billing.cancelTitle')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('billing.back')}
            </Button>
            <Button variant={pending?.kind === 'cancel' ? 'danger' : 'primary'} onClick={confirmPending} data-autofocus>
              {pending?.kind === 'cancel' ? t('billing.cancelConfirm') : t('billing.confirm')}
            </Button>
          </div>
        }
      >
        <p className="text-sm">
          {pending?.kind === 'change'
            ? pending.direction === 'upgrade'
              ? t('billing.upgradeBody')
              : t('billing.downgradeBody')
            : t('billing.cancelBody', { date: sub?.current_period_end ? formatDate(sub.current_period_end) : '—' })}
        </p>
      </Dialog>
    </>
  )
}
