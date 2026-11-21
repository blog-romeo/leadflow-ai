import { useEffect, useState } from 'react'
import { pendingInvite } from '../../lib/pendingInvite'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { FullPageLoader, InlineAlert } from '../../components/ui/States'
import { AuthLayout } from '../../components/layout/AuthLayout'

/** Atterraggio del link di conferma email: supabase-js completa lo scambio PKCE automaticamente. */
export default function AuthCallback() {
  const { status, session } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (status === 'ready' && session) navigate(pendingInvite() ? '/join' : '/app', { replace: true })
  }, [status, session, navigate])

  useEffect(() => {
    const id = window.setTimeout(() => setTimedOut(true), 8000)
    return () => window.clearTimeout(id)
  }, [])

  if (!timedOut || status === 'loading') return <FullPageLoader />
  return (
    <AuthLayout title={t('auth.callbackWorking')}>
      <InlineAlert>{t('auth.resetInvalid')}</InlineAlert>
      <Link to="/login" className="mt-4 inline-block text-sm font-medium text-flow hover:underline">
        {t('auth.backToLogin')}
      </Link>
    </AuthLayout>
  )
}
