import { Navigate, useParams } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { PublicLayout, LEGAL_PAGES, type LegalPage } from '../../components/public/PublicLayout'
import { InlineAlert } from '../../components/ui/States'
import { LEGAL_DOCS } from '../../content/legal'
import { useSeo } from '../../lib/seo'

export default function Legal() {
  const { page } = useParams()
  const { t } = useI18n()
  const valid = (LEGAL_PAGES as readonly string[]).includes(page ?? '')
  const doc = valid ? LEGAL_DOCS[page as LegalPage] : null
  // Le bozze non vengono indicizzate finché non sono complete e revisionate.
  useSeo({ title: doc ? `${doc.title} — LeadFlow AI` : 'LeadFlow AI', noindex: true })
  if (!doc) return <Navigate to="/" replace />
  return (
    <PublicLayout>
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6" lang="it">
        <InlineAlert tone="signal">{t('legal.draftBanner')}</InlineAlert>
        {t('legal.italianOnly') && <p className="mt-3 text-sm text-muted" lang="en">{t('legal.italianOnly')}</p>}
        <h1 className="mt-6 text-3xl font-semibold">{doc.title}</h1>
        <p className="mt-1 text-sm text-muted">{t('legal.lastUpdate', { date: doc.updated })}</p>
        {doc.intro && <p className="mt-6 text-muted">{doc.intro}</p>}
        {doc.sections.map((s) => (
          <section key={s.heading} className="mt-8">
            <h2 className="text-xl font-semibold">{s.heading}</h2>
            {s.paragraphs.length > 1 ? (
              <ul className="mt-3 list-disc space-y-2 pl-5 text-muted">
                {s.paragraphs.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-muted">{s.paragraphs[0]}</p>
            )}
          </section>
        ))}
      </article>
    </PublicLayout>
  )
}
