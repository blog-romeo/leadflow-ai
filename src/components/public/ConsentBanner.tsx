import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { Button } from '../ui/Button'
import { getConsent, onConsentChange, setConsent } from '../../lib/analytics'

/**
 * Banner di consenso per le statistiche anonime. "Rifiuta" ha lo stesso peso di "Accetta".
 * Nessuna statistica viene inviata prima della scelta. Riapribile dal link nel footer.
 */
export function ConsentBanner() {
  const { t } = useI18n()
  const [choice, setChoice] = useState(getConsent)
  useEffect(() => onConsentChange(() => setChoice(getConsent())), [])
  if (choice !== null) return null
  return (
    <div role="region" aria-label={t('consent.title')} className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-6">
        <p className="flex-1 text-sm text-muted">
          <strong className="text-ink">{t('consent.title')}.</strong> {t('consent.body')}{' '}
          <Link to="/legal/cookie" className="underline hover:text-ink">
            {t('consent.more')}
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={() => setConsent('denied')}>
            {t('consent.reject')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConsent('granted')}>
            {t('consent.accept')}
          </Button>
        </div>
      </div>
    </div>
  )
}
