import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AuthLayout } from '../../components/layout/AuthLayout'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { env } from '../../lib/env'
import { validateEmail } from '../../lib/validation'
import { errorKey } from '../../lib/errors'

export default function ForgotPassword() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const v = validateEmail(email)
    setFieldError(v.ok ? null : t(v.error))
    if (!v.ok) return
    if (!supabase) return setError(t('errors.notConfigured'))
    setBusy(true)
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${env.appUrl}/reset-password` })
    setBusy(false)
    // Messaggio identico anche se l'account non esiste: nessuna enumerazione utenti.
    if (err && errorKey(err) !== 'errors.generic') return setError(t(errorKey(err)))
    setSent(true)
  }

  return (
    <AuthLayout title={t('auth.forgotTitle')} subtitle={t('auth.forgotBody')} footer={<Link to="/login" className="font-medium text-flow hover:underline">{t('auth.backToLogin')}</Link>}>
      {sent ? (
        <InlineAlert tone="ok">{t('auth.forgotSent', { email: email.trim() })}</InlineAlert>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          <Field label={t('auth.email')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldError} required />
          <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!supabase}>
            {t('auth.forgotSubmit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
