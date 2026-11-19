import { PlugZap } from 'lucide-react'
import { useI18n } from '../../i18n'

export function ConfigNotice() {
  const { t } = useI18n()
  return (
    <div role="status" className="flex gap-3 rounded-[var(--radius-control)] border border-signal/40 bg-signal-soft p-3.5 text-sm">
      <PlugZap className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
      <div>
        <p className="font-semibold text-ink">{t('config.missingTitle')}</p>
        <p className="mt-0.5 text-muted">{t('config.missingBody')}</p>
      </div>
    </div>
  )
}
