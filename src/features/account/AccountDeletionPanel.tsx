import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { apiFetch, ApiError } from '../../lib/api'
import { Panel } from '../../components/ui/Panel'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'

interface PreflightOrg { id: string; name: string; role: string; other_members: number; other_admins: number; paid_subscription: boolean }
interface Preflight { is_super_admin: boolean; is_reseller_admin: boolean; organizations: PreflightOrg[] }

const KNOWN = ['confirmation_mismatch', 'last_admin', 'paid_subscription_active', 'super_admin_cannot_self_delete', 'reseller_admin_cannot_self_delete', 'forbidden']
export function deletionErrorCode(err: unknown): string {
  const raw = err instanceof ApiError ? err.code : ((err as { message?: string } | null)?.message ?? '')
  return KNOWN.find((k) => raw.includes(k)) ?? 'generic'
}

/**
 * Impostazioni → Cancellazione (REL-47). Due azioni distinte, ciascuna con conferma scritta:
 * cancellare il proprio account (email) e, per gli amministratori, cancellare l'organizzazione (nome).
 */
export function AccountDeletionPanel() {
  const { t } = useI18n()
  const { currentOrg, isOrgAdmin, profile, refresh, signOut } = useAuth()
  const navigate = useNavigate()
  const [pre, setPre] = useState<Preflight | null>(null)
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<'org' | 'account' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    void supabase.rpc('account_deletion_preflight').then(({ data }) => setPre((data as unknown as Preflight | null) ?? null))
  }, [currentOrg?.id])

  const orgs = pre?.organizations ?? []
  const blockers = orgs.filter((o) => (o.other_members > 0 && o.role === 'organization_admin' && o.other_admins === 0) || (o.other_members === 0 && o.paid_subscription))
  const soleOrgs = orgs.filter((o) => o.other_members === 0)

  async function deleteOrg(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !currentOrg || busy) return
    setBusy('org')
    setError(null)
    const { error: err } = await supabase.rpc('organization_request_deletion', { p_org: currentOrg.id, p_confirm_name: orgName })
    setBusy(null)
    if (err) return setError(t(`accountDeletion.errors.${deletionErrorCode(err)}`))
    setOrgName('')
    await refresh()
    navigate('/app', { replace: true })
  }

  async function deleteAccount(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy('account')
    setError(null)
    try {
      await apiFetch('/api/account/delete', { method: 'POST', body: { confirm_email: email } })
      await signOut()
      navigate('/', { replace: true })
    } catch (err) {
      setError(t(`accountDeletion.errors.${deletionErrorCode(err)}`))
    } finally {
      setBusy(null)
    }
  }

  const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

  return (
    <Panel title={t('accountDeletion.title')}>
      <div className="space-y-8">
        {error && <InlineAlert>{error}</InlineAlert>}

        {currentOrg && isOrgAdmin && (
          <form onSubmit={deleteOrg} className="space-y-3">
            <h3 className="font-semibold">{t('accountDeletion.orgTitle')}</h3>
            <p className="max-w-prose text-sm text-muted">{t('accountDeletion.orgBody')}</p>
            <Field label={t('accountDeletion.orgConfirm', { name: currentOrg.name })} value={orgName} onChange={(e) => setOrgName(e.target.value)} autoComplete="off" />
            <Button type="submit" variant="danger" loading={busy === 'org'} disabled={!sameText(orgName, currentOrg.name)}>
              {t('accountDeletion.orgCta')}
            </Button>
          </form>
        )}

        <form onSubmit={deleteAccount} className="space-y-3">
          <h3 className="font-semibold">{t('accountDeletion.accountTitle')}</h3>
          <p className="max-w-prose text-sm text-muted">{t('accountDeletion.accountBody')}</p>
          {soleOrgs.length > 0 && <p className="max-w-prose text-sm text-muted">{t('accountDeletion.soleOrgs', { names: soleOrgs.map((o) => o.name).join(', ') })}</p>}
          {blockers.length > 0 && <InlineAlert>{t('accountDeletion.blocked', { names: blockers.map((o) => o.name).join(', ') })}</InlineAlert>}
          {pre?.is_super_admin && <InlineAlert>{t('accountDeletion.errors.super_admin_cannot_self_delete')}</InlineAlert>}
          <Field
            label={t('accountDeletion.accountConfirm', { email: profile?.email ?? '' })}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          <Button
            type="submit"
            variant="danger"
            loading={busy === 'account'}
            disabled={!profile?.email || !sameText(email, profile.email) || blockers.length > 0 || !!pre?.is_super_admin}
          >
            {t('accountDeletion.accountCta')}
          </Button>
        </form>
      </div>
    </Panel>
  )
}
