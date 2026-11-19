import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../../components/layout/AuthLayout'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { validateEmail } from '../../lib/validation'
import { errorKey } from '../../lib/errors'

export default function Login() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const v = validateEmail(email)
    setEmailError(v.ok ? null : t(v.error))
    if (!v.ok || !password) return
    if (!supabase) return setError(t('errors.notConfigured'))
    setBusy(true)
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (err) return setError(t(errorKey(err)))
    // Solo percorsi interni: evita open redirect.
    navigate(from && from.startsWith('/app') ? from : '/app', { replace: true })
  }

  return (
    <AuthLayout
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginBody')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-medium text-flow hover:underline">
            {t('common.signUp')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Field label={t('auth.email')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} required />
        <Field label={t('auth.password')} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm text-flow hover:underline">
            {t('auth.forgot')}
          </Link>
        </div>
        <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!supabase}>
          {t('common.signIn')}
        </Button>
      </form>
    </AuthLayout>
  )
}
