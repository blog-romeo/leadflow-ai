import { useI18n } from '../../i18n'
import { InlineAlert } from '../../components/ui/States'
import type { LearningResponse, LearningStat } from './types'

/** Tassi di lead per modo di chiedere, oggetto e schema (learning.py), con i giudizi dell'utente. */
export function LearningPanel({ data }: { data: LearningResponse }) {
  const { t } = useI18n()
  const empty = !data.verbs.length && !data.objects.length
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('demandHunter.learning.body')}</p>
      {data.source === 'cache' && <InlineAlert tone="signal">{t('demandHunter.learning.cached')}</InlineAlert>}
      {empty ? (
        <p className="text-sm text-muted">{t('demandHunter.learning.empty')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <StatList title={t('demandHunter.learning.verbs')} items={data.verbs} />
          <StatList title={t('demandHunter.learning.objects')} items={data.objects} />
          <StatList title={t('demandHunter.learning.patterns')} items={data.patterns} />
        </div>
      )}
    </div>
  )
}

function StatList({ title, items }: { title: string; items: LearningStat[] }) {
  const { t } = useI18n()
  const max = Math.max(0.01, ...items.map((i) => i.score))
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <ul className="space-y-2">
        {items.slice(0, 8).map((i) => (
          <li key={i.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate">{i.key}</span>
              <span className="shrink-0 text-xs text-muted">{t('demandHunter.learning.rate', { leads: i.leads, searches: i.searches })}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-flow" style={{ width: `${Math.round((i.score / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
