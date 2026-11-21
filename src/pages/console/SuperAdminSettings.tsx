import { useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ErrorState, LoadingState } from '../../components/ui/States'
import { PlanAdmin } from '../../features/billing/PlanAdmin'
import { ReasonDialog, inputCls, post, useApi } from '../../features/console/shared'

interface Flag { key: string; description: string; scope: 'organization' | 'reseller'; enabled: boolean }
interface Settings { settings: { white_label?: { cname_target: string | null } }; flags: Flag[] }

export default function SuperAdminSettings() {
  const { t } = useI18n()
  const { data, error, loading, reload } = useApi<Settings>('/api/super-admin/settings')
  const [pending, setPending] = useState<null | { title: string; danger?: boolean; run: (reason: string) => Promise<unknown> }>(null)
  const [override, setOverride] = useState({ key: 'lead_finder', target_type: 'organization', target_id: '', enabled: 'false' })
  const [cname, setCname] = useState<string | null>(null)
  if (loading && !data) return <LoadingState />
  if (error || !data) return <ErrorState message={t('console.loadError')} onRetry={() => void reload()} />
  const cnameValue = cname ?? data.settings.white_label?.cname_target ?? ''
  const ask = (title: string, run: (reason: string) => Promise<unknown>, danger = false) => setPending({ title, danger, run: async (r) => { await run(r); await reload() } })

  return (
    <>
      <PageHeader title={t('saSettings.title')} />
      <div className="space-y-5">
        <Panel title={t('saSettings.flags')}>
          <p className="mb-3 text-xs text-muted">{t('saSettings.flagsHint')}</p>
          <ul className="divide-y divide-line text-sm">
            {data.flags.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-mono text-xs">{f.key}</span> <span className="text-muted">· {f.description} · {t(`saSettings.scope.${f.scope}`)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={f.enabled ? 'ok' : 'danger'}>{f.enabled ? t('saSettings.enabled') : t('saSettings.disabled')}</Badge>
                  <Button size="sm" variant={f.enabled ? 'ghost' : 'secondary'} onClick={() => ask(`${f.key}: ${f.enabled ? t('saSettings.disabled') : t('saSettings.enabled')}`, (reason) => post('/api/super-admin/flag', { key: f.key, enabled: !f.enabled, reason }), f.enabled)}>
                    {f.enabled ? t('saSettings.disabled') : t('saSettings.enabled')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-sm font-semibold">{t('saSettings.override')}</h3>
          <div className="mt-2 grid gap-2 text-sm md:grid-cols-5">
            <select className={inputCls} value={override.key} onChange={(e) => setOverride({ ...override, key: e.target.value })} aria-label="flag">
              {data.flags.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}
            </select>
            <select className={inputCls} value={override.target_type} onChange={(e) => setOverride({ ...override, target_type: e.target.value })} aria-label={t('saSettings.overrideType')}>
              <option value="organization">organization</option>
              <option value="reseller">reseller</option>
            </select>
            <input className={inputCls} placeholder={t('saSettings.overrideTarget')} value={override.target_id} onChange={(e) => setOverride({ ...override, target_id: e.target.value.trim() })} />
            <select className={inputCls} value={override.enabled} onChange={(e) => setOverride({ ...override, enabled: e.target.value })} aria-label={t('saSettings.overrideValue')}>
              <option value="true">{t('saSettings.enabled')}</option>
              <option value="false">{t('saSettings.disabled')}</option>
              <option value="null">{t('saSettings.overrideRemove')}</option>
            </select>
            <Button size="sm" variant="secondary" disabled={!/^[0-9a-f-]{36}$/i.test(override.target_id)}
              onClick={() => ask(t('saSettings.override'), (reason) => post('/api/super-admin/flag-override', { ...override, enabled: override.enabled === 'null' ? null : override.enabled === 'true', reason }))}>
              {t('console.save')}
            </Button>
          </div>
        </Panel>

        <Panel title={t('saSettings.whiteLabel')}>
          <p className="mb-2 text-xs text-muted">{t('saSettings.cnameHint')}</p>
          <div className="flex max-w-xl gap-2 text-sm">
            <input className={inputCls} value={cnameValue} placeholder="leadflow.netlify.app" onChange={(e) => setCname(e.target.value.trim().toLowerCase())} aria-label={t('saSettings.cnameTarget')} />
            <Button size="sm" variant="secondary" onClick={() => ask(t('saSettings.cnameTarget'), (reason) => post('/api/super-admin/setting', { key: 'white_label', value: { cname_target: cnameValue || null }, reason }))}>{t('console.save')}</Button>
          </div>
        </Panel>

        <PlanAdmin />
      </div>
      <ReasonDialog open={pending !== null} title={pending?.title ?? ''} danger={pending?.danger} onClose={() => setPending(null)} onConfirm={async (reason) => { await pending?.run(reason) }} />
    </>
  )
}
