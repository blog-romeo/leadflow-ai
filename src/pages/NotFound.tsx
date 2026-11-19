import { Link } from 'react-router-dom'
import { useI18n } from '../i18n'
import { buttonClasses } from '../components/ui/Button'
import { Logo } from '../components/ui/Logo'

export default function NotFound() {
  const { t } = useI18n()
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-bg px-4">
      <div className="text-center">
        <Logo className="mb-8 justify-center" />
        <h1 className="text-3xl font-semibold">{t('notFound.title')}</h1>
        <p className="mt-2 text-muted">{t('notFound.body')}</p>
        <Link to="/" className={buttonClasses('primary', 'md', 'mt-6')}>
          {t('notFound.cta')}
        </Link>
      </div>
    </main>
  )
}
