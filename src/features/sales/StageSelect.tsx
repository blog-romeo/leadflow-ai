import { useState } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { PIPELINE_STAGES, type LeadStatus } from '../../lib/database.types'
import { salesErrorMessage } from './errors'

/**
 * Controllo accessibile per cambiare stato (alternativa al drag-and-drop).
 * La cronologia e l'utente responsabile sono registrati dal database.
 */
export function StageSelect({
  leadId,
  name,
  value,
  contactable,
  onChanged,
  onError,
  compact,
}: {
  leadId: string
  name: string
  value: LeadStatus
  contactable: boolean
  onChanged: (s: LeadStatus) => void
  onError: (msg: string) => void
  compact?: boolean
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  async function change(next: LeadStatus) {
    if (!supabase || next === value) return
    setBusy(true)
    const { error } = await supabase.from('leads').update({ status: next }).eq('id', leadId)
    setBusy(false)
    if (error) return onError(salesErrorMessage(error, t))
    onChanged(next)
  }
  const allowed = (s: LeadStatus) => contactable || ['not_contactable', 'won', 'lost'].includes(s)
  return (
    <label className={compact ? 'block' : 'block space-y-1.5'}>
      <span className={compact ? 'sr-only' : 'block text-sm font-medium'}>{t('sales.pipeline.moveTo', { name })}</span>
      <select
        value={value}
        disabled={busy}
        onChange={(e) => void change(e.target.value as LeadStatus)}
        className={
          compact
            ? 'w-full rounded-md border border-line bg-surface px-2 py-1 text-xs'
            : 'h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm focus:border-flow focus:outline-none'
        }
      >
        {PIPELINE_STAGES.map((s) => (
          <option key={s} value={s} disabled={!allowed(s)}>
            {t(`status.${s}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
