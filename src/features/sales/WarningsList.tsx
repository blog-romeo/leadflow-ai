import { TriangleAlert } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { FactUsed, Warning } from '../../lib/database.types'
import { Badge } from '../../components/ui/Badge'

/** Avvisi delle verifiche server (link, importi, promesse, base giuridica…). */
export function WarningsList({ warnings }: { warnings: Warning[] }) {
  const { t } = useI18n()
  if (!warnings?.length) return null
  return (
    <div className="rounded-[var(--radius-control)] border border-signal/40 bg-signal-soft px-3 py-2 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <TriangleAlert className="size-4 text-signal" aria-hidden />
        {t('sales.messages.warningsTitle')}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink/85">
        {warnings.map((w, i) => {
          const key = `sales.warnings.${w.code}`
          const detail = w.code === 'legal_basis_check_required' && w.detail ? t(`leadFinder.csv.basis.${w.detail}`) : (w.detail ?? '')
          const text = t(key, { detail })
          return <li key={i}>{text === key ? w.code : text}</li>
        })}
      </ul>
    </div>
  )
}

export function FactsList({ facts }: { facts: FactUsed[] }) {
  const { t } = useI18n()
  if (!facts?.length) return null
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted">{t('sales.messages.factsTitle')} ({facts.length})</summary>
      <ul className="mt-1 space-y-1">
        {facts.map((f, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1.5">
            <span>{f.fact}</span>
            <Badge tone={f.verified ? 'ok' : 'signal'}>{f.verified ? t('sales.messages.verified') : t('sales.messages.unverified')}</Badge>
            <span className="text-xs text-muted">{f.source}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
