import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { apiFetch } from '../../lib/api'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { InlineAlert } from '../../components/ui/States'
import { aiErrorMessage, type AgentsStatus } from './shared'
import { CONNECTION_KEYS, configuredFor, connectionState, type ConnectionCheck, type ConnectionUiState } from './connectionState'

const TONE: Record<ConnectionUiState, 'ok' | 'danger' | 'signal' | 'neutral'> = {
  verified: 'ok',
  failed: 'danger',
  verification_stale: 'signal',
  configured_unverified: 'signal',
  not_configured: 'neutral',
}

/** Stato provider e connessioni (Prompt 10): mai "connesso" senza un esito reale recente. */
export function ConnectionsPanel({ status, orgId, onChecked }: { status: AgentsStatus; orgId: string; onChecked: () => void }) {
  const { t, formatDate } = useI18n()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const av = status.availability!
  const checks = (status.connections ?? []) as ConnectionCheck[]

  async function verify() {
    setBusy(true)
    setErr(null)
    try {
      await apiFetch('/api/ai-agents/connections-check', { method: 'POST', body: { organization_id: orgId } })
      onChecked()
    } catch (e) {
      setErr(aiErrorMessage(e, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={t('aiAgentsP10.connections.title')}
      className="mb-4"
      action={
        status.is_admin ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void verify()}>
            <RefreshCw className="size-4" aria-hidden />
            {t('aiAgentsP10.connections.verify')}
          </Button>
        ) : undefined
      }
    >
      {err && <InlineAlert>{err}</InlineAlert>}
      <ul className="divide-y divide-line text-sm">
        {CONNECTION_KEYS.map((k) => {
          const check = checks.find((c) => c.key === k)
          const state = connectionState(configuredFor(k, av), check)
          return (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{t(`aiAgentsP10.connections.names.${k}`)}</span>
              <span className="flex flex-wrap items-center gap-2 text-xs">
                {check && state !== 'not_configured' && (
                  <span className="text-muted">
                    {formatDate(check.checked_at)}
                    {check.latency_ms !== null ? ` · ${check.latency_ms} ms` : ''}
                    {state === 'failed' ? ` · ${check.code}` : ''}
                  </span>
                )}
                <Badge tone={TONE[state]}>{state === 'not_configured' ? 'PROVIDER_NOT_CONFIGURED' : t(`aiAgentsP10.connections.states.${state}`)}</Badge>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">{t('aiAgentsP10.connections.note')}</p>
      <p className="mt-1 text-xs text-muted">{t('aiAgentsP10.connections.noSimulated')}</p>
    </Panel>
  )
}
