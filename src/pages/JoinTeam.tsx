import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useNoIndex } from '../lib/seo'
import { clearPendingInvite, pendingInvite, savePendingInvite, tokenFromHash } from '../lib/pendingInvite'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Button, buttonClasses } from '../components/ui/Button'
import { InlineAlert, LoadingState } from '../components/ui/States'

interface Preview { organization_name: string; role: 'member' | 'organization_admin'; status: 'pending' | 'accepted' | 'revoked' | 'expired'; expires_at: string; invited_by: string | null; email_confirmed: boolean }

/**
 * /join#t=<token> — accettazione di un invito collaboratore.
 * Il token è nel frammento (non inviato al server con la richiesta della pagina). Senza sessione si
 * salva localmente e si chiede di accedere o registrarsi con l'email invitata; dopo il login si torna qui.
 */
export default function JoinTeam() {
  const { t, formatDate } = useI18n()
  useNoIndex(t('team.joinTitle'))
  const { status, session, user, setCurrentOrgId, refresh, signOut } = useAuth()
  const navigate = useNavigate()
  const [token] = useState(() => {
    const fromHash = typeof location !== 'undefined' ? tokenFromHash(location.hash) : null
    if (fromHash) {
      savePendingInvite(fromHash)
      // Il token non resta nella barra degli indirizzi né nella cronologia.
      history.replaceState(null, '', location.pathname)
    }
    return fromHash ?? pendingInvite()
  })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token || !session || !supabase) return
    void supabase.rpc('team_invitation_preview', { p_token: token }).then(({ data, error: err }) => {
      if (err) setError(t(`team.errors.${err.message === 'invitation_not_found' ? 'invitation_not_found' : 'generic'}`))
      else setPreview(data as unknown as Preview)
    })
  }, [token, session, t])

  if (status === 'loading') return <LoadingState className="min-h-dvh" />
  if (!token)
    return (
      <AuthLayout title={t('team.joinTitle')}>
        <InlineAlert>{t('team.errors.invitation_not_found')}</InlineAlert>
      </AuthLayout>
    )

  if (!session)
    return (
      <AuthLayout title={t('team.joinTitle')} subtitle={t('team.joinSignIn')}>
        <div className="flex flex-wrap gap-3">
          <Link to="/login" state={{ from: '/join' }} className={buttonClasses('primary', 'lg')}>{t('common.signIn')}</Link>
          <Link to="/register" className={buttonClasses('secondary', 'lg')}>{t('common.signUp')}</Link>
        </div>
        <p className="mt-4 text-sm text-muted">{t('team.joinSameEmail')}</p>
      </AuthLayout>
    )

  async function accept() {
    if (!supabase || !token) return
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('accept_team_invitation', { p_token: token })
    setBusy(false)
    if (err || !data) {
      const k = `team.errors.${err?.message ?? 'generic'}`
      const m = t(k)
      return setError(m === k ? t('team.errors.generic') : m)
    }
    clearPendingInvite()
    setCurrentOrgId(data)
    await refresh()
    navigate('/app', { replace: true })
  }

  return (
    <AuthLayout
      title={t('team.joinTitle')}
      footer={
        <span className="flex flex-wrap items-center gap-x-2">
          {t('onboarding.signedInAs', { email: user?.email ?? '' })}
          <button type="button" onClick={() => void signOut()} className="font-medium text-flow hover:underline">{t('common.signOut')}</button>
        </span>
      }
    >
      {error && <div className="mb-4"><InlineAlert>{error}</InlineAlert></div>}
      {!preview ? (
        !error && <LoadingState />
      ) : preview.status !== 'pending' ? (
        <InlineAlert>{t(`team.errors.invitation_${preview.status === 'expired' ? 'expired' : 'not_pending'}`)}</InlineAlert>
      ) : (
        <div className="space-y-4">
          <p>
            {t('team.joinBody', { org: preview.organization_name, role: t(`roles.${preview.role}`) })}
            {preview.invited_by && <span className="block text-sm text-muted">{t('team.invitedBy', { name: preview.invited_by })}</span>}
          </p>
          <p className="text-sm text-muted">{t('team.expires', { date: formatDate(preview.expires_at) })}</p>
          {!preview.email_confirmed && <InlineAlert tone="signal">{t('team.errors.email_not_confirmed')}</InlineAlert>}
          <div className="flex gap-3">
            <Button size="lg" loading={busy} disabled={!preview.email_confirmed} onClick={() => void accept()}>{t('team.accept')}</Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                clearPendingInvite()
                navigate('/app', { replace: true })
              }}
            >
              {t('team.decline')}
            </Button>
          </div>
        </div>
      )}
    </AuthLayout>
  )
}
