import { useId, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import type { EstimateResponse } from './types'

/**
 * Conferma esplicita della spesa: il pulsante si abilita solo spuntando la casella con l'importo massimo.
 * Il token monouso resta nella memoria della pagina e viene inviato una sola volta.
 */
export function BudgetConfirm({ estimate, busy, onConfirm, confirmLabel }: { estimate: EstimateResponse; busy: boolean; onConfirm: () => void; confirmLabel?: string }) {
  const { t } = useI18n()
  const [checked, setChecked] = useState(false)
  const id = useId()
  if (!estimate.allowed) {
    const key = `demandHunter.launch.refused.${estimate.reason ?? 'disabled'}`
    const msg = t(key)
    return <InlineAlert tone="danger">{msg === key ? t('demandHunter.errors.generic') : msg}</InlineAlert>
  }
  const simulated = estimate.mode === 'simulated'
  return (
    <div className="space-y-3 rounded-[var(--radius-panel)] border border-line bg-surface-2/60 p-4">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm">
        <input id={id} type="checkbox" className="mt-0.5 size-4 accent-[var(--color-flow)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span className="font-medium">{t(simulated ? 'demandHunter.launch.confirmLabelSimulated' : 'demandHunter.launch.confirmLabel', { n: estimate.paid_calls })}</span>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="size-3.5" aria-hidden />
          {t('demandHunter.launch.expires')}
        </p>
        <Button onClick={onConfirm} disabled={!checked} loading={busy}>
          {confirmLabel ?? t('demandHunter.launch.start')}
        </Button>
      </div>
    </div>
  )
}
