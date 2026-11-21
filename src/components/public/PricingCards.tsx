import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { useI18n } from '../../i18n'
import { buttonClasses } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { PLANS, PLAN_FEATURE_ORDER, VAT_RATE_IT, formatEuro, mergeServerPlans, type PlanCode, type PublicPlan } from '../../config/plans'
import { cn } from '../../lib/cn'

/** Piani dalla configurazione centrale, aggiornati con /api/pricing se disponibile. */
export function usePublicPlans(): PublicPlan[] {
  const [plans, setPlans] = useState(PLANS)
  useEffect(() => {
    let alive = true
    fetch('/api/pricing')
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((d: { plans: Parameters<typeof mergeServerPlans>[1] } | null) => {
        if (alive && d?.plans) setPlans(mergeServerPlans(PLANS, d.plans))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return plans
}

export function PricingCards({
  onChoose,
  selected,
  ctaHref = (code) => `/register?plan=${code}`,
  compact,
}: {
  onChoose?: (code: PlanCode) => void
  selected?: PlanCode | null
  ctaHref?: (code: PlanCode) => string
  compact?: boolean
}) {
  const { t, locale, formatNumber } = useI18n()
  const plans = usePublicPlans()
  return (
    <div>
      <ul className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const isSel = selected === p.code
          return (
            <li
              key={p.code}
              className={cn(
                'flex flex-col rounded-[var(--radius-panel)] border bg-surface p-6',
                p.highlighted ? 'border-flow' : 'border-line',
                isSel && 'ring-2 ring-flow',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xl font-semibold">{p.name}</h3>
                {p.highlighted && <Badge tone="flow">{t('pricing.recommended')}</Badge>}
              </div>
              <p className="mt-4">
                <span className="font-display text-4xl font-semibold tabular">{formatEuro(p.priceCents, locale)}</span>
                <span className="text-muted">{t('pricing.perMonth')}</span>
              </p>
              <p className="text-xs text-muted">{t('pricing.vatExcluded')}</p>
              <ul className="mt-5 space-y-1.5 text-sm">
                <li className="font-medium">{t('pricing.leads', { n: formatNumber(p.monthlyLeads) })}</li>
                <li className="font-medium">{t('pricing.credits', { n: formatNumber(p.monthlyAiCredits) })}</li>
                <li className="font-medium">{p.maxUsers === 1 ? t('pricing.oneUser') : t('pricing.users', { n: p.maxUsers })}</li>
              </ul>
              {!compact && (
                <ul className="mt-4 flex-1 space-y-1.5 border-t border-line pt-4 text-sm">
                  {PLAN_FEATURE_ORDER.filter((f) => p.features.includes(f)).map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                      {t(`pricing.featureNames.${f}`)}
                    </li>
                  ))}
                </ul>
              )}
              {onChoose ? (
                <button type="button" onClick={() => onChoose(p.code)} aria-pressed={isSel} className={buttonClasses(isSel || p.highlighted ? 'primary' : 'secondary', 'md', 'mt-6 w-full')}>
                  {t('pricing.choose', { plan: p.name })}
                </button>
              ) : (
                <Link to={ctaHref(p.code)} className={buttonClasses(p.highlighted ? 'primary' : 'secondary', 'md', 'mt-6 w-full')}>
                  {t('pricing.choose', { plan: p.name })}
                </Link>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-4 text-sm text-muted">{t('pricing.vatNote', { rate: VAT_RATE_IT })}</p>
    </div>
  )
}
