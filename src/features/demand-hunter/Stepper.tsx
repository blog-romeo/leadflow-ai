import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

export type Step = 1 | 2 | 3 | 4
const KEYS = ['goal', 'market', 'launch', 'results'] as const

/** Indicatore dei quattro passaggi. I passaggi già raggiunti si possono riaprire. */
export function Stepper({ step, reached, onGo }: { step: Step; reached: Step; onGo: (s: Step) => void }) {
  const { t } = useI18n()
  return (
    <nav aria-label={t('demandHunter.stepOf', { n: step })} className="mb-6">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {KEYS.map((k, i) => {
          const n = (i + 1) as Step
          const done = n < step
          const current = n === step
          const enabled = n <= reached
          return (
            <li key={k}>
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onGo(n)}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[var(--radius-control)] border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed',
                  current ? 'border-flow bg-flow-soft text-flow' : done ? 'border-line bg-surface text-ink hover:bg-surface-2' : 'border-line bg-surface text-muted',
                )}
              >
                <span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold', current ? 'bg-flow text-flow-ink' : done ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted')}>
                  {done ? <Check className="size-3.5" aria-hidden /> : n}
                </span>
                <span className="truncate font-medium">{t(`demandHunter.steps.${k}`)}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
