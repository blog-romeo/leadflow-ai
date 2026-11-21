import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { AuthLayout } from '../../components/layout/AuthLayout'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { env } from '../../lib/env'
import { validateEmail, validateFullName, validatePassword } from '../../lib/validation'
import { errorKey } from '../../lib/errors'
import { track } from '../../lib/analytics'
import { useNoIndex } from '../../lib/seo'
import { PLANS, SIGNUP_PLAN_KEY } from '../../config/plans'


export default function Register() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [form, setForm] = useState({ fullName: '', email: '', password: '' })
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [params] = useSearchParams()
  const started = useRef(false)
  useNoIndex(t('auth.registerTitle'))

  // Piano scelto nella pagina prezzi: preselezionato nell'onboarding (preferenza tecnica locale).
  useEffect(() => {
    const plan = params.get('plan')
    if (plan && PLANS.some((p) => p.code === plan)) {
      try {
        localStorage.setItem(SIGNUP_PLAN_KEY, plan)
      } catch {
        /* storage non disponibile */
      }
    }
  }, [params])

  /** Prima interazione con il modulo: evento anonimo "signup_started" (solo con consenso). */
  const markStarted = () => {
    if (started.current) return
    started.current = true
    track('signup_started', '/register')
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const checks = {
      fullName: validateFullName(form.fullName),
      email: validateEmail(form.email),
      password: validatePassword(form.password),
    }
    const next = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok ? null : t(v.error)]))
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    if (!supabase) return setError(t('errors.notConfigured'))

    setBusy(true)
    const email = form.email.trim()
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password: form.password,
      options: {
        data: { full_name: form.fullName.trim() },
        emailRedirectTo: `${env.appUrl}/auth/callback`,
      },
    })
    setBusy(false)
    if (err) return setError(t(errorKey(err)))
    // Con conferma email attiva Supabase non restituisce una sessione.
    if (data.session) navigate('/onboarding', { replace: true })
    else setSentTo(email)
  }

  if (sentTo) {
    return (
      <AuthLayout title={t('auth.checkEmailTitle')}>
        <div className="flex gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-flow" aria-hidden />
          <p className="text-sm">{t('auth.checkEmailBody', { email: sentTo })}</p>
        </div>
        <Link to="/login" className="mt-6 inline-block text-sm font-medium text-flow hover:underline">
          {t('auth.backToLogin')}
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerBody')}
      footer={
        <>
          {t('auth.hasAccount')}{' '}
          <Link to="/login" className="font-medium text-flow hover:underline">
            {t('common.signIn')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} onFocus={markStarted} noValidate className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Field label={t('auth.fullName')} autoComplete="name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} maxLength={120} required />
        <Field label={t('auth.email')} type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} required />
        <Field
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          hint={t('auth.passwordHint')}
          error={errors.password}
          maxLength={128}
          required
        />
        <p className="text-xs text-muted">{t('auth.terms')}</p>
        <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!supabase}>
          {t('common.signUp')}
        </Button>
      </form>
    </AuthLayout>
  )
}
