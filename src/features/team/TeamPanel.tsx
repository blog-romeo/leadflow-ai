import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Copy, UserMinus, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { apiFetch, ApiError } from '../../lib/api'
import type { OrgRole } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Field, Select } from '../../components/ui/Field'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'

interface Member { user_id: string; role: OrgRole; full_name: string | null; email: string | null; is_me: boolean; joined_at: string }
interface Seats { limit: number; used: number; enforced: boolean }
interface Invitation { id: string; email: string; role: OrgRole; status: 'pending' | 'accepted' | 'revoked' | 'expired'; expires_at: string; created_at: string; email_sent_at: string | null; email_error: string | null; invited_by: string | null }
interface Created { id: string; email: string; email_status: 'sent' | 'not_configured' | 'failed'; invite_url?: string; expires_at: string }

function teamError(t: (k: string, v?: Record<string, string | number>) => string, err: unknown): string {
  const code = err instanceof ApiError ? err.code : (err as { message?: string } | null)?.message ?? ''
  const limit = err instanceof ApiError ? Number(err.details.limit ?? 0) : 0
  const k = `team.errors.${code}`
  const m = t(k, { limit })
  return m === k ? t('team.errors.generic') : m
}

/** Collaboratori: elenco, inviti (solo admin), revoca e rimozione. Controlli reali nelle RPC. */
export function TeamPanel() {
  const { t, locale, formatDate } = useI18n()
  const { currentOrg, isOrgAdmin } = useAuth()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [seats, setSeats] = useState<Seats | null>(null)
  const [invites, setInvites] = useState<Invitation[]>([])
  const [loadError, setLoadError] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    if (!supabase || !currentOrg) return
    setLoadError(false)
    const m = await supabase.rpc('org_members', { p_org: currentOrg.id })
    if (m.error) return setLoadError(true)
    const d = m.data as unknown as { members: Member[]; seats: Seats }
    setMembers(d.members)
    setSeats(d.seats)
    if (isOrgAdmin) {
      const i = await supabase.rpc('org_invitations', { p_org: currentOrg.id })
      if (!i.error) setInvites((i.data as unknown as Invitation[]).filter((x) => x.status === 'pending' || x.status === 'expired'))
    }
  }, [currentOrg, isOrgAdmin])
  useEffect(() => {
    void load()
  }, [load])

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!currentOrg) return
    setBusy(true)
    setError(null)
    setCreated(null)
    setCopied(false)
    try {
      const r = await apiFetch<Created>('/api/team/invite', { method: 'POST', body: { organization_id: currentOrg.id, email: email.trim(), role, locale } })
      setCreated(r)
      setEmail('')
      await load()
    } catch (err) {
      setError(teamError(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function rpc(fn: () => PromiseLike<{ error: { message?: string } | null }>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setError(null)
    const { error: err } = await fn()
    if (err) setError(teamError(t, err))
    await load()
  }

  if (loadError) return <Panel title={t('team.title')}><ErrorState message={t('errors.generic')} onRetry={() => void load()} /></Panel>
  if (!members || !seats) return <Panel title={t('team.title')}><LoadingState /></Panel>
  const full = seats.enforced && seats.used >= seats.limit

  return (
    <Panel title={t('team.title')} action={<span className="text-xs text-muted tabular">{t('team.seats', { used: seats.used, limit: seats.limit })}</span>}>
      {error && <div className="mb-3"><InlineAlert>{error}</InlineAlert></div>}
      <ul className="divide-y divide-line">
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {m.full_name || m.email}
                {m.is_me && <span className="text-muted"> ({t('settings.you')})</span>}
              </p>
              {m.full_name && <p className="truncate text-xs text-muted">{m.email}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={m.role === 'organization_admin' ? 'flow' : 'neutral'}>{t(`roles.${m.role}`)}</Badge>
              {isOrgAdmin && !m.is_me && (
                <button
                  type="button"
                  className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label={t('team.remove', { name: m.full_name || m.email || '' })}
                  onClick={() => void rpc(() => supabase!.rpc('org_remove_member', { p_org: currentOrg!.id, p_user: m.user_id }), t('team.removeConfirm', { name: m.full_name || m.email || '' }))}
                >
                  <UserMinus className="size-4" aria-hidden />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {isOrgAdmin ? (
        <>
          {invites.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-semibold">{t('team.pending')}</h3>
              <ul className="mt-2 divide-y divide-line">
                {invites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate">{i.email} · {t(`roles.${i.role}`)}</p>
                      <p className="text-xs text-muted">
                        {i.status === 'expired' ? t('team.expired') : t('team.expires', { date: formatDate(i.expires_at) })} ·{' '}
                        {i.email_sent_at ? t('team.emailSent') : t('team.emailNotSent')}
                      </p>
                    </div>
                    {i.status === 'pending' && (
                      <button
                        type="button"
                        className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger"
                        aria-label={t('team.revoke', { email: i.email })}
                        onClick={() => void rpc(() => supabase!.rpc('org_revoke_invitation', { p_org: currentOrg!.id, p_invitation: i.id }), t('team.revokeConfirm', { email: i.email }))}
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {created && (
            <div className="mt-4 rounded-md border border-line bg-surface-2 p-3 text-sm" role="status">
              {created.email_status === 'sent' ? (
                <p>{t('team.createdSent', { email: created.email })}</p>
              ) : (
                <>
                  <p className="font-medium">{t(created.email_status === 'failed' ? 'team.createdFailed' : 'team.createdNotSent', { email: created.email })}</p>
                  <div className="mt-2 flex gap-2">
                    <input readOnly value={created.invite_url ?? ''} aria-label={t('team.link')} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-xs" onFocus={(e) => e.target.select()} />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(created.invite_url ?? '')
                          setCopied(true)
                        } catch {
                          setCopied(false)
                        }
                      }}
                    >
                      <Copy className="size-4" aria-hidden />
                      {copied ? t('team.copied') : t('team.copy')}
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted">{t('team.linkWarning')}</p>
                </>
              )}
            </div>
          )}

          <form onSubmit={invite} className="mt-5 grid gap-3 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
            <Field label={t('team.email')} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} disabled={full} />
            <Select label={t('team.role')} value={role} onChange={(e) => setRole(e.target.value as OrgRole)} disabled={full}>
              <option value="member">{t('roles.member')}</option>
              <option value="organization_admin">{t('roles.organization_admin')}</option>
            </Select>
            <Button type="submit" loading={busy} disabled={full || !email.trim()}>
              {t('team.invite')}
            </Button>
          </form>
          {full && <p className="mt-2 text-xs text-signal">{t('team.full', { limit: seats.limit })}</p>}
        </>
      ) : (
        <p className="mt-3 text-xs text-muted">{t('team.adminOnly')}</p>
      )}
    </Panel>
  )
}
