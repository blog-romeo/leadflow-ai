import { Check, LoaderCircle } from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

export const STAGES = ['querying_provider', 'deduplicating', 'scoring', 'saving', 'done'] as const
export type Stage = (typeof STAGES)[number]

/** Avanzamento reale: lo stadio è letto dalla riga lead_searches aggiornata dal server. */
export function SearchProgress({ stage }: { stage: Stage }) {
  const { t } = useI18n()
  const current = STAGES.indexOf(stage)
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface px-5 py-4">
      <p className="sr-only" aria-live="polite">
        {t(`leadFinder.stages.${stage}`)}
      </p>
      <ol aria-label={t('leadFinder.progressLabel')} className="grid gap-2 sm:grid-cols-5">
        {STAGES.map((s, i) => {
          const done = i < current || stage === 'done'
          const active = i === current && stage !== 'done'
          return (
            <li key={s} className="flex items-center gap-2 text-sm" aria-current={active ? 'step' : undefined}>
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full border',
                  done ? 'border-flow bg-flow text-flow-ink' : active ? 'border-flow text-flow' : 'border-line text-muted',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden /> : active ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <span className="text-xs tabular">{i + 1}</span>}
              </span>
              <span className={cn(!done && !active && 'text-muted')}>{t(`leadFinder.stages.${s}`)}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
