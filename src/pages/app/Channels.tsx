import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Copy, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api'
import type { CommunicationAccountRow } from '../../lib/database.types'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Field } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Dialog } from '../../components/ui/Dialog'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { CheckBadge, cmError } from '../../features/campaigns/shared'

type Account = CommunicationAccountRow & { webhook_url: string }
interface ProvidersResponse {
  server: { credentials_key: 'ok' | 'missing' | 'invalid'; worker_secret: boolean; service_role: boolean }
  providers: { id: string; label: string; implemented: boolean; auth: string; docs_url: string; notes: string }[]
  accounts: Account[]
}

function Notice({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return <div aria-live="polite" className="empty:hidden">{msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}</div>
}

function AccountCard({ orgId, a, admin, onChanged, myEmail }: { orgId: string; a: Account; admin: boolean; onChanged: () => void; myEmail: string }) {
  const { t, formatDate } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [secret, setSecret] = useState('')
  const [to, setTo] = useState(myEmail)
  const [limits, setLimits] = useState({ daily: String(a.daily_limit), minute: String(a.per_minute_limit) })
  const [confirm, setConfirm] = useState(false)
  const [copied, setCopied] = useState(false)

  async function act(action: string, body: Record<string, unknown>, ok: string, path = '/api/communication/accounts') {
    setBusy(action)
    setMsg(null)
    try {
      await apiFetch(path, { method: 'POST', body: { organization_id: orgId, account_id: a.id, ...(path.endsWith('accounts') ? { action } : {}), ...body } })
      setMsg({ ok: true, text: ok })
      onChanged()
    } catch (err) {
      setMsg({ ok: false, text: cmError(err, t) })
    } finally {
      setBusy(null)
    }
  }

  const domainState = a.domain_status === 'verified' ? 'pass' : a.domain_status === 'failed' ? 'fail' : 'missing'
  return (
    <article className="space-y-4 rounded-[var(--radius-panel)] border border-line p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold break-words">
            {a.label} · {a.from_name} &lt;{a.from_email}&gt;
          </h3>
          <p className="text-xs text-muted">
            Resend · {a.sending_domain}
            {a.last_checked_at ? ` · ${formatDate(a.last_checked_at)}` : ''}
          </p>
        </div>
        <Badge tone={a.status === 'connected' ? 'ok' : a.status === 'error' ? 'danger' : 'signal'}>{t(`channels.status.${a.status}`)}</Badge>
      </header>
      {a.last_error && <InlineAlert>{t('channels.lastError', { error: a.last_error })}</InlineAlert>}
      <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {(
          [
            ['domain', domainState],
            ['spf', a.spf_status],
            ['dkim', a.dkim_status],
            ['dmarc', a.dmarc_status],
            ['webhook', a.webhook_configured ? 'pass' : 'missing'],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5">
            <dt className="text-muted">{t(`channels.checks.${k}`)}</dt>
            <dd>
              <CheckBadge value={v} />
            </dd>
          </div>
        ))}
      </dl>
      {a.dns_records.length > 0 && a.domain_status !== 'verified' && (
        <section>
          <h4 className="mb-2 text-sm font-semibold">{t('channels.dns')}</h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <caption className="sr-only">{t('channels.dns')}</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('channels.dnsType')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('channels.dnsName')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('channels.dnsValue')}</th>
                  <th scope="col" className="py-1.5 font-medium">{t('channels.dnsStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {a.dns_records.map((r, i) => (
                  <tr key={i} className="border-b border-line/60 align-top">
                    <td className="py-1.5 pr-3">{r.record} · {r.type}{r.priority != null ? ` (${r.priority})` : ''}</td>
                    <td className="py-1.5 pr-3 font-mono break-all">{r.name}</td>
                    <td className="max-w-[22rem] py-1.5 pr-3 font-mono break-all">{r.value}</td>
                    <td className="py-1.5">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {a.dmarc_status !== 'pass' && <p className="text-xs text-muted">{t('channels.dmarcHint', { domain: a.sending_domain })}</p>}
      {admin && (
        <Button size="sm" variant="secondary" loading={busy === 'refresh'} onClick={() => void act('refresh', { request_verification: a.domain_status !== 'verified' }, t('channels.refreshed'))}>
          <RefreshCw className="size-4" aria-hidden />
          {t('channels.refresh')}
        </Button>
      )}

      <section className="space-y-2 border-t border-line pt-4">
        <h4 className="text-sm font-semibold">{t('channels.webhook')}</h4>
        <p className="text-xs text-muted">{t('channels.webhookHelp')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 rounded-[var(--radius-control)] bg-surface-2 px-2 py-1.5 text-xs break-all">{a.webhook_url}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(a.webhook_url)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            <Copy className="size-4" aria-hidden />
            {copied ? t('channels.copied') : t('channels.copy')}
          </Button>
        </div>
        <p className="text-xs">{a.webhook_configured ? t('channels.webhookOk') : t('channels.webhookWaiting')}</p>
        {admin && (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              void act('webhook_secret', { secret: secret.trim() }, t('channels.secretSaved')).then(() => setSecret(''))
            }}
          >
            <Field className="flex-1" type="password" autoComplete="off" label={t('channels.webhookSecret')} value={secret} onChange={(e) => setSecret(e.target.value)} />
            <Button type="submit" size="md" variant="secondary" loading={busy === 'webhook_secret'} disabled={!secret.trim().startsWith('whsec_')}>
              {t('channels.saveSecret')}
            </Button>
          </form>
        )}
      </section>

      {admin && a.status === 'connected' && (
        <section className="space-y-2 border-t border-line pt-4">
          <h4 className="text-sm font-semibold">{t('channels.test')}</h4>
          <p className="text-xs text-muted">{t('channels.testHelp')}</p>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              void act('test', { to: to.trim() }, t('channels.testSent'), '/api/communication/test-send')
            }}
          >
            <Field className="flex-1" type="email" label={t('channels.testTo')} value={to} onChange={(e) => setTo(e.target.value)} />
            <Button type="submit" variant="secondary" loading={busy === 'test'}>
              {t('channels.testSend')}
            </Button>
          </form>
        </section>
      )}

      {admin && (
        <section className="space-y-2 border-t border-line pt-4">
          <h4 className="text-sm font-semibold">{t('channels.limits')}</h4>
          <form
            className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              void act('limits', { daily_limit: Number(limits.daily), per_minute_limit: Number(limits.minute) }, t('channels.limitsSaved'))
            }}
          >
            <Field type="number" min={1} max={5000} label={t('channels.dailyLimit')} value={limits.daily} onChange={(e) => setLimits({ ...limits, daily: e.target.value })} />
            <Field type="number" min={1} max={120} label={t('channels.perMinute')} value={limits.minute} onChange={(e) => setLimits({ ...limits, minute: e.target.value })} />
            <Button type="submit" variant="secondary" loading={busy === 'limits'}>
              {t('channels.saveLimits')}
            </Button>
          </form>
        </section>
      )}

      <Notice msg={msg} />
      {admin && (
        <div className="border-t border-line pt-4">
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
            <Unplug className="size-4" aria-hidden />
            {t('channels.revoke')}
          </Button>
        </div>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('channels.revoke')}
        closeLabel={t('common.close')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy === 'revoke'}
              onClick={() => {
                setConfirm(false)
                void act('revoke', {}, t('channels.revoked'))
              }}
            >
              {t('channels.revoke')}
            </Button>
          </div>
        }
      >
        <p className="text-sm">{t('channels.revokeConfirm')}</p>
      </Dialog>
    </article>
  )
}

export default function Channels() {
  const { t } = useI18n()
  const { currentOrg, isOrgAdmin, user } = useAuth()
  const orgId = currentOrg?.id ?? ''
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [f, setF] = useState({ label: '', from_name: '', from_email: '', reply_to: '', api_key: '', daily_limit: '100' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    try {
      setData(await apiFetch<ProvidersResponse>(`/api/communication/providers?organization_id=${orgId}`))
      setError(null)
    } catch (err) {
      setError(cmError(err, t))
    }
  }, [orgId, t])
  useEffect(() => {
    void load()
  }, [load])

  async function connect(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      await apiFetch('/api/communication/accounts', {
        method: 'POST',
        body: {
          action: 'create',
          organization_id: orgId,
          provider: 'resend',
          label: f.label.trim(),
          from_name: f.from_name.trim(),
          from_email: f.from_email.trim(),
          reply_to: f.reply_to.trim() || null,
          api_key: f.api_key.trim(),
          daily_limit: Number(f.daily_limit) || 100,
        },
      })
      setF({ label: '', from_name: '', from_email: '', reply_to: '', api_key: '', daily_limit: '100' })
      setMsg({ ok: true, text: t('channels.connected') })
      void load()
    } catch (err) {
      setMsg({ ok: false, text: cmError(err, t) })
    } finally {
      setBusy(false)
    }
  }

  const active = (data?.accounts ?? []).filter((a) => a.status !== 'revoked')
  return (
    <>
      <PageHeader title={t('channels.title')} subtitle={t('channels.subtitle')} />
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title={t('channels.server')}>
              <ul className="space-y-2 text-sm">
                {(['credentials_key', 'worker_secret', 'service_role'] as const).map((k) => {
                  const ok = k === 'credentials_key' ? data.server.credentials_key === 'ok' : data.server[k]
                  return (
                    <li key={k} className="flex items-center justify-between gap-3">
                      <span>{t(`channels.serverItems.${k}`)}</span>
                      <Badge tone={ok ? 'ok' : 'danger'}>{ok ? t('channels.serverOk') : t('channels.serverMissing')}</Badge>
                    </li>
                  )
                })}
              </ul>
            </Panel>
            <Panel title={t('channels.providers')}>
              <ul className="space-y-2 text-sm">
                {data.providers.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{p.label}</p>
                      <p className="text-xs text-muted">{p.notes}</p>
                    </div>
                    <Badge tone={p.implemented ? 'ok' : 'neutral'}>{p.implemented ? t('channels.available') : t('channels.notAvailable')}</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">{t('channels.oauthNote')}</p>
            </Panel>
          </div>

          <Panel title={t('channels.connect')}>
            {!isOrgAdmin ? (
              <p className="text-sm text-muted">{t('channels.adminOnly')}</p>
            ) : (
              <form onSubmit={(e) => void connect(e)} className="space-y-4" autoComplete="off">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label={t('channels.label')} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={80} required />
                  <Field label={t('channels.fromName')} value={f.from_name} onChange={(e) => setF({ ...f, from_name: e.target.value })} maxLength={80} required />
                  <Field type="email" label={t('channels.fromEmail')} hint={t('channels.fromEmailHint')} value={f.from_email} onChange={(e) => setF({ ...f, from_email: e.target.value })} required />
                  <Field type="email" label={t('channels.replyTo')} value={f.reply_to} onChange={(e) => setF({ ...f, reply_to: e.target.value })} />
                  <Field type="password" label={t('channels.apiKey')} hint={t('channels.apiKeyHint')} value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} required autoComplete="new-password" />
                  <Field type="number" min={1} max={5000} label={t('channels.dailyLimit')} value={f.daily_limit} onChange={(e) => setF({ ...f, daily_limit: e.target.value })} />
                </div>
                <Button type="submit" loading={busy} disabled={data.server.credentials_key !== 'ok' || !f.label.trim() || !f.from_name.trim() || !f.from_email.includes('@') || f.api_key.trim().length < 10}>
                  <ShieldCheck className="size-4" aria-hidden />
                  {t('channels.connectBtn')}
                </Button>
                {data.server.credentials_key !== 'ok' && <InlineAlert tone="signal">{t('channels.errors.credentials_key_not_configured')}</InlineAlert>}
                <Notice msg={msg} />
              </form>
            )}
          </Panel>

          <Panel title={t('channels.accounts')}>
            {active.length === 0 ? (
              <p className="text-sm text-muted">{t('channels.none')}</p>
            ) : (
              <div className="space-y-4">
                {active.map((a) => (
                  <AccountCard key={a.id} orgId={orgId} a={a} admin={isOrgAdmin} onChanged={() => void load()} myEmail={user?.email ?? ''} />
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  )
}
