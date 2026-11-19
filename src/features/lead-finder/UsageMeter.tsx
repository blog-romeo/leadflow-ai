import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import type { UsageSummary } from './types'

/** Crediti del mese: barre con valori reali dal database (usage_summary). */
export function UsageMeter({ usage }: { usage: UsageSummary | null }) {
  const { t, formatNumber } = useI18n()
  const items = [
    { label: t('leadFinder.creditsSearches'), v: usage?.searches },
    { label: t('leadFinder.creditsResults'), v: usage?.results },
    { label: t('leadFinder.creditsAi'), v: usage?.ai_analyses },
  ]
  return (
    <section aria-label={t('leadFinder.creditsPeriod')} className="grid grid-cols-3 gap-3">
      {items.map(({ label, v }) => {
        const ratio = v && v.limit > 0 ? Math.min(1, v.used / v.limit) : 0
        return (
          <div key={label} className="min-w-0 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2.5">
            <p className="truncate text-xs text-muted">{label}</p>
            <p className="tabular mt-0.5 text-sm font-semibold">
              {v ? t('leadFinder.creditsOf', { used: formatNumber(v.used), limit: formatNumber(v.limit) }) : '—'}
            </p>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2" role="presentation">
              <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-danger' : ratio > 0.8 ? 'bg-signal' : 'bg-flow')} style={{ width: `${ratio * 100}%` }} />
            </div>
          </div>
        )
      })}
    </section>
  )
}
