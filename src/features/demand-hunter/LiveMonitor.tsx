import { useI18n } from '../../i18n'
import { Badge } from '../../components/ui/Badge'
import type { ComboView, JobViewResponse } from './types'

const STATUS_TONE = { provata: 'ok', 'da provare': 'neutral', 'già fatta': 'flow', abbandonata: 'danger' } as const

/** Avanzamento in diretta: chiamate usate sul budget, combinazioni per stato, diario della ricerca. */
export function LiveMonitor({ view }: { view: JobViewResponse }) {
  const { t } = useI18n()
  const spent = view.job.spent.searches + view.job.spent.autocomplete
  const budget = view.session?.budget ?? view.job.reserved_calls
  const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0
  const byStatus = (view.job.progress?.by_status as Record<string, number> | undefined) ?? {}
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm">
          <span className="font-medium">{t('demandHunter.results.spent', { n: spent, budget })}</span>
          <span className="tabular-nums text-muted">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent}>
          <div className="h-full rounded-full bg-flow transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(byStatus).map(([k, n]) => (
            <Badge key={k} tone={STATUS_TONE[k as ComboView['status']] ?? 'neutral'}>
              {t(`demandHunter.results.comboStatus.${k}`)}: {n}
            </Badge>
          ))}
        </div>
      </div>
      {view.session && view.session.events.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t('demandHunter.results.eventsTitle')}</h3>
          <ol className="max-h-56 space-y-1 overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface-2/50 p-2 font-mono text-xs" aria-live="polite">
            {[...view.session.events].reverse().map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-muted">{e.at}</span>
                <span className={e.kind === 'errore' ? 'text-danger' : e.kind === 'abbandono' ? 'text-muted' : 'text-ink'}>{e.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

export function CombosTable({ combos }: { combos: ComboView[] }) {
  const { t } = useI18n()
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface text-muted">
          <tr>
            <th className="py-1.5 pr-2 font-medium">{t('demandHunter.launch.verbs')}</th>
            <th className="py-1.5 pr-2 font-medium">{t('demandHunter.launch.objects')}</th>
            <th className="py-1.5 pr-2 font-medium" />
            <th className="py-1.5 pr-2 text-right font-medium">#</th>
            <th className="py-1.5 text-right font-medium">Lead</th>
          </tr>
        </thead>
        <tbody>
          {combos.map((c) => (
            <tr key={c.query} className="border-t border-line">
              <td className="py-1.5 pr-2">{c.verb}</td>
              <td className="py-1.5 pr-2">{c.object}</td>
              <td className="py-1.5 pr-2">
                <Badge tone={STATUS_TONE[c.status]}>{t(`demandHunter.results.comboStatus.${c.status}`)}</Badge>
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{c.results}</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{c.leads}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
