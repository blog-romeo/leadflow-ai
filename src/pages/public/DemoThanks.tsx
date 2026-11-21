import { Link } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { PublicLayout } from '../../components/public/PublicLayout'
import { buttonClasses } from '../../components/ui/Button'
import { useSeo } from '../../lib/seo'

export default function DemoThanks() {
  const { t } = useI18n()
  useSeo({ title: `${t('demo.thanksTitle')} — LeadFlow AI`, noindex: true })
  return (
    <PublicLayout>
      <div className="mx-auto max-w-xl px-4 py-20 text-center sm:px-6">
        <CheckCircle2 className="mx-auto size-12 text-ok" aria-hidden />
        <h1 className="mt-4 text-3xl font-semibold">{t('demo.thanksTitle')}</h1>
        <p className="mt-3 text-muted">{t('demo.thanksBody')}</p>
        <p className="mt-2 text-sm text-muted">{t('demo.thanksNote')}</p>
        <Link to="/" className={buttonClasses('secondary', 'md', 'mt-8')}>
          {t('demo.backHome')}
        </Link>
      </div>
    </PublicLayout>
  )
}
