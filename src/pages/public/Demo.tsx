import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '../../i18n'
import { PublicLayout } from '../../components/public/PublicLayout'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { useSeo } from '../../lib/seo'
import { validateDemoClient, type DemoErrors as Errors } from '../../features/demo/validate'

const EMPLOYEES = ['1-9', '10-49', '50-249', '250+'] as const
const PREFS = ['email', 'phone', 'video_call'] as const
const textareaCls =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/80 focus:border-flow focus:outline-none focus:ring-2 focus:ring-flow/25 aria-[invalid=true]:border-danger'

export default function Demo() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  useSeo({ title: t('seo.demoTitle'), description: t('seo.demoDescription'), path: '/demo', locale })
  const startedAt = useRef(Date.now())
  const [v, setV] = useState({ name: '', company: '', email: '', phone: '', sector: '', employees: '', message: '', contact_preference: 'email', website_url: '' })
  const [consent, setConsentBox] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const err = (k: keyof Errors) => (errors[k] ? t(`demo.errors.${errors[k]}`) : null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const local = validateDemoClient(v, consent)
    setErrors(local)
    if (Object.keys(local).length > 0) return
    setSending(true)
    try {
      const res = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...v, employees: v.employees || null, phone: v.phone || null, consent, locale, started_at: startedAt.current }),
      })
      if (res.ok) {
        navigate('/demo/grazie', { replace: true })
        return
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Errors }
      if (body.error === 'validation_failed' && body.fields) setErrors(body.fields)
      else setFormError(t(`demo.errors.${body.error === 'rate_limited' ? 'rate_limited' : 'generic'}`))
    } catch {
      setFormError(t('demo.errors.generic'))
    } finally {
      setSending(false)
    }
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-4xl font-semibold">{t('demo.title')}</h1>
        <p className="mt-3 text-lg text-muted">{t('demo.subtitle')}</p>
        <form onSubmit={submit} noValidate className="mt-8 space-y-5">
          {formError && <InlineAlert>{formError}</InlineAlert>}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('demo.name')} value={v.name} onChange={set('name')} autoComplete="name" required maxLength={120} error={err('name')} />
            <Field label={t('demo.company')} value={v.company} onChange={set('company')} autoComplete="organization" required maxLength={160} error={err('company')} />
            <Field label={t('demo.email')} type="email" value={v.email} onChange={set('email')} autoComplete="email" required maxLength={254} hint={t('demo.emailHint')} error={err('email')} />
            <Field label={t('demo.phone')} type="tel" value={v.phone} onChange={set('phone')} autoComplete="tel" maxLength={25} hint={t('demo.phoneHint')} error={err('phone')} />
            <Field label={t('demo.sector')} value={v.sector} onChange={set('sector')} required maxLength={120} error={err('sector')} />
            <Select label={t('demo.employees')} value={v.employees} onChange={set('employees')}>
              <option value="">{t('demo.employeesNone')}</option>
              {EMPLOYEES.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="demo-message" className="block text-sm font-medium">{t('demo.message')}</label>
            <textarea id="demo-message" rows={5} value={v.message} onChange={set('message')} required maxLength={2000} aria-invalid={!!errors.message || undefined} aria-describedby="demo-message-hint" className={textareaCls} />
            <p id="demo-message-hint" className={errors.message ? 'text-xs font-medium text-danger' : 'text-xs text-muted'} role={errors.message ? 'alert' : undefined}>
              {err('message') ?? t('demo.messageHint')}
            </p>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">{t('demo.preference')}</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {PREFS.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="contact_preference" value={p} checked={v.contact_preference === p} onChange={set('contact_preference')} />
                  {t(`demo.prefs.${p}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {/* Campo esca per i bot: nascosto a utenti e tecnologie assistive. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label>
              {t('demo.honeypot')}
              <input type="text" tabIndex={-1} autoComplete="off" value={v.website_url} onChange={set('website_url')} />
            </label>
          </div>
          <div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsentBox(e.target.checked)} aria-invalid={!!errors.consent || undefined} />
              <span>
                {t('demo.consent')}{' '}
                <Link to="/legal/privacy" className="text-flow underline">{t('demo.privacyLink')}</Link>
              </span>
            </label>
            {errors.consent && <p role="alert" className="mt-1 text-xs font-medium text-danger">{t('demo.errors.required')}</p>}
          </div>
          <Button type="submit" size="lg" loading={sending} disabled={sending}>
            {sending ? t('demo.sending') : t('demo.submit')}
          </Button>
          <p className="text-sm text-muted">{t('demo.noBooking')}</p>
        </form>
      </div>
    </PublicLayout>
  )
}
