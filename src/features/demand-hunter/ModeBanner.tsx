import { FlaskConical, Radio } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { DhMode } from './types'

/** Dice sempre se i dati sono simulati o reali: i risultati simulati non vengono mai presentati come veri. */
export function ModeBanner({ mode }: { mode: DhMode }) {
  const { t } = useI18n()
  const simulated = mode === 'simulated'
  const Icon = simulated ? FlaskConical : Radio
  return (
    <div role="status" className={simulated ? 'flex gap-3 rounded-[var(--radius-panel)] border border-signal/40 bg-signal-soft p-4 text-sm' : 'flex gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4 text-sm'}>
      <Icon className={simulated ? 'mt-0.5 size-4 shrink-0 text-signal' : 'mt-0.5 size-4 shrink-0 text-flow'} aria-hidden />
      <div>
        <p className="font-semibold">{t(simulated ? 'demandHunter.mode.simulated' : 'demandHunter.mode.live')}</p>
        <p className="mt-0.5 text-muted">{t(simulated ? 'demandHunter.mode.simulatedBody' : 'demandHunter.mode.liveBody')}</p>
      </div>
    </div>
  )
}
