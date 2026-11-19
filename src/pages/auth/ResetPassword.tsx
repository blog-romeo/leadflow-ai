import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../../components/layout/AuthLayout'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { FullPageLoader, InlineAlert } from '../../components/ui/States'
import { useI18n } from '../../i18n'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { validatePassword } from '../../lib/validation'
import { errorKey } from '../../lib/errors'

export default function ResetPassword() {
  const { t } = useI18n()
  const { status, session } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'loading') return <FullPageLoader />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const v = validatePassword(password)
    setFieldError(v.ok ? null : t(v.error))
    if (!v.ok || !supabase) return
    setBusy(true)
    const { error: err } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (err) return setError(t(errorKey(err)))
    navigate('/app', { replace: true })
  }

  return (
    <AuthLayout title={t('auth.resetTitle')}>
      {!session ? (
        <div className="space-y-4">
          <InlineAlert>{t('auth.resetInvalid')}</InlineAlert>
          <Link to="/forgot-password" className="text-sm font-medium text-flow hover:underline">
            {t('auth.forgotSubmit')}
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          <Field
            label={t('auth.password')}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={t('auth.passwordHint')}
            error={fieldError}
            required
          />
          <Button type="submit" className="w-full" size="lg" loading={busy}>
            {t('auth.resetSubmit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
