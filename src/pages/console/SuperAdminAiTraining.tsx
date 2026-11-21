import { useState } from 'react'
import { useI18n } from '../../i18n'
import { PageHeader } from '../../components/ui/PageHeader'
import { Panel } from '../../components/ui/Panel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ErrorState, InlineAlert, LoadingState } from '../../components/ui/States'
import { Table, consoleError, inputCls, post, useApi, useFormatters } from '../../features/console/shared'

/**
 * /super-admin/ai-training (Prompt 12): versioni di configurazione degli agenti, dataset, benchmark,
 * confronto baseline/candidato, feedback aggregati, errori e costi, approvazione e rollback.
 * Tutti i benchmark sono su dataset SINTETICI (etichetta sempre visibile). Nessun contenuto dei clienti.
 */
interface Version { id: string; agent_key: string; config_key: string; kind: string; version: string; status: 'candidate' | 'active' | 'retired' | 'rejected'; config: unknown; notes: string | null; created_at: string; activated_at: string | null }
interface Comparison { suite: string; primary_metric: string; baseline: { config: string; value: number | null }; candidate: { config: string; value: number | null }; delta: number | null; gate_passed: boolean }
interface Suite { suite: string; split: string; config: string; status: string; reason?: string; cases: number; metrics: Record<string, unknown>; ms: number }
interface Benchmark { id: string; benchmark_version: string; data_kind: string; candidate_version_id: string | null; gate_passed: boolean; executed_at: string; comparisons: Comparison[] | null; suites: Suite[] | null }
interface Overview {
  versions: Version[]
  benchmarks: Benchmark[]
  feedback: { by_status: Record<string, number>; by_agent: Record<string, { total: number; negative: number }>; organizations_with_feedback: number }
  errors_30d: Record<string, number>
  costs_30d: { credits: number; cost_usd: number; unpriced_calls: number }
  datasets: { id: string; version: string; task: string; agent: string; technique: string[]; synthetic: boolean; splits: { train: number; validation: number; test: number } }[]
  benchmark_version: string
  evaluable_config_keys: string[]
  applied_config_keys: string[]
}

const STATUS_TONE = { active: 'ok', candidate: 'signal', retired: 'neutral', rejected: 'danger' } as const
const fmt = (v: unknown) => (typeof v === 'number' ? String(v) : v === null || v === undefined ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v))

export default function SuperAdminAiTraining() {
  const { t, formatDate } = useI18n()
  const { num, usd } = useFormatters()
  const { data, error, loading, reload } = useApi<Overview>('/api/super-admin/ai-training')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState({ config_key: 'quality_reviewer.blocking_codes', version: '', config: '{"blocking_codes": ["duplicate_ids", "contradiction"]}', notes: '' })

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setMsg(null)
    try {
      await fn()
      setMsg({ tone: 'ok', text: t('aiTraining.done') })
      await reload()
    } catch (e) {
      setMsg({ tone: 'danger', text: consoleError(e, t) })
    } finally {
      setBusy(null)
    }
  }
  const askReason = () => {
    const r = window.prompt(t('aiTraining.reasonPrompt')) ?? ''
    if (r.trim().length < 10) throw new Error('reason_required')
    return r.trim()
  }

  if (error) return <ErrorState message={t('support.errors.generic')} onRetry={() => void reload()} />
  if (loading || !data) return <LoadingState />
  const latest = data.benchmarks[0]
  const shown = data.benchmarks.find((b) => b.id === selected) ?? latest

  return (
    <>
      <PageHeader title={t('aiTraining.title')} subtitle={t('aiTraining.subtitle')} actions={<Button size="sm" loading={busy === 'run'} onClick={() => void act('run', () => post('/api/super-admin/ai-benchmark-run', {}))}>{t('aiTraining.runBenchmark')}</Button>} />
      {msg && <InlineAlert tone={msg.tone === 'ok' ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
      <p className="mb-4 rounded-[var(--radius-control)] border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{t('aiTraining.syntheticBanner')}</p>

      <div className="space-y-6">
        <Panel title={t('aiTraining.versions')}>
          <Table head={[t('aiTraining.cols.config'), t('aiTraining.cols.kind'), t('aiTraining.cols.version'), t('aiTraining.cols.status'), t('aiTraining.cols.applied'), '']} minWidth={760}>
            {data.versions.map((v) => (
              <tr key={v.id} className="border-t border-line align-top">
                <td className="py-2 pr-3"><span className="font-mono text-xs">{v.config_key}</span>{v.notes && <span className="block text-xs text-muted">{v.notes}</span>}</td>
                <td className="pr-3">{t(`aiTraining.kinds.${v.kind}`)}</td>
                <td className="pr-3 tabular">{v.version}</td>
                <td className="pr-3"><Badge tone={STATUS_TONE[v.status]}>{t(`aiTraining.status.${v.status}`)}</Badge></td>
                <td className="pr-3 text-xs">{data.applied_config_keys.includes(v.config_key) ? t('aiTraining.appliedYes') : t('aiTraining.appliedNo')}</td>
                <td className="flex flex-wrap gap-1.5 py-2">
                  {v.status === 'candidate' && data.evaluable_config_keys.includes(v.config_key) && (
                    <Button size="sm" variant="secondary" loading={busy === `b-${v.id}`} onClick={() => void act(`b-${v.id}`, () => post('/api/super-admin/ai-benchmark-run', { candidate_version_id: v.id }))}>{t('aiTraining.evaluate')}</Button>
                  )}
                  {v.status === 'candidate' && (() => {
                    const passed = data.benchmarks.find((b) => b.candidate_version_id === v.id && b.gate_passed)
                    return (
                      <>
                        <Button size="sm" disabled={!passed} loading={busy === `a-${v.id}`} onClick={() => void act(`a-${v.id}`, async () => post('/api/super-admin/ai-config-activate', { version_id: v.id, benchmark_id: passed!.id, reason: askReason() }))}>{t('aiTraining.approve')}</Button>
                        <Button size="sm" variant="ghost" loading={busy === `r-${v.id}`} onClick={() => void act(`r-${v.id}`, async () => post('/api/super-admin/ai-config-reject', { version_id: v.id, reason: askReason() }))}>{t('aiTraining.reject')}</Button>
                      </>
                    )
                  })()}
                  {v.status === 'active' && data.versions.some((x) => x.config_key === v.config_key && x.status === 'retired' && x.activated_at) && (
                    <Button size="sm" variant="secondary" loading={busy === `rb-${v.id}`} onClick={() => void act(`rb-${v.id}`, async () => post('/api/super-admin/ai-config-rollback', { config_key: v.config_key, reason: askReason() }))}>{t('aiTraining.rollback')}</Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <form
            className="mt-4 grid gap-2 border-t border-line pt-4 text-sm md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault()
              void act('propose', async () => post('/api/super-admin/ai-config-propose', { agent_key: 'quality_reviewer', config_key: draft.config_key, kind: 'rules', version: draft.version, config: JSON.parse(draft.config), notes: draft.notes || undefined }))
            }}
          >
            <label className="block">{t('aiTraining.cols.config')}<input className={inputCls} value={draft.config_key} onChange={(e) => setDraft({ ...draft, config_key: e.target.value })} /></label>
            <label className="block">{t('aiTraining.cols.version')}<input className={inputCls} placeholder="1.1.0" value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} /></label>
            <label className="block md:col-span-2">JSON<input className={`${inputCls} font-mono`} value={draft.config} onChange={(e) => setDraft({ ...draft, config: e.target.value })} /></label>
            <label className="block md:col-span-3">{t('aiTraining.notes')}<input className={inputCls} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
            <div className="flex items-end"><Button size="sm" type="submit" loading={busy === 'propose'}>{t('aiTraining.propose')}</Button></div>
          </form>
          <p className="mt-2 text-xs text-muted">{t('aiTraining.proposeNote')}</p>
        </Panel>

        <Panel title={t('aiTraining.benchmarks')}>
          {!shown ? (
            <p className="text-sm text-muted">{t('aiTraining.noBenchmarks')}</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <select className={`${inputCls} max-w-sm`} value={shown.id} onChange={(e) => setSelected(e.target.value)}>
                  {data.benchmarks.map((b) => <option key={b.id} value={b.id}>{formatDate(b.executed_at)} · v{b.benchmark_version}{b.candidate_version_id ? ` · ${t('aiTraining.withCandidate')}` : ''}</option>)}
                </select>
                <Badge tone="signal">{t(`aiTraining.dataKind.${shown.data_kind}`)}</Badge>
                {shown.candidate_version_id && <Badge tone={shown.gate_passed ? 'ok' : 'danger'}>{shown.gate_passed ? t('aiTraining.gatePassed') : t('aiTraining.gateFailed')}</Badge>}
              </div>
              <h3 className="mb-1 text-xs font-medium text-muted">{t('aiTraining.comparison')}</h3>
              <Table head={[t('aiTraining.cols.suite'), t('aiTraining.cols.metric'), t('aiTraining.cols.baseline'), t('aiTraining.cols.candidate'), 'Δ', t('aiTraining.cols.gate')]} minWidth={720}>
                {(shown.comparisons ?? []).map((c) => (
                  <tr key={c.suite} className="border-t border-line">
                    <td className="py-2 pr-3">{c.suite}</td>
                    <td className="pr-3 font-mono text-xs">{c.primary_metric}</td>
                    <td className="pr-3 text-xs"><span className="tabular">{fmt(c.baseline.value)}</span> <span className="text-muted">{c.baseline.config}</span></td>
                    <td className="pr-3 text-xs"><span className="tabular">{fmt(c.candidate.value)}</span> <span className="text-muted">{c.candidate.config}</span></td>
                    <td className="pr-3 tabular">{fmt(c.delta)}</td>
                    <td><Badge tone={c.gate_passed ? 'ok' : 'danger'}>{c.gate_passed ? t('aiTraining.gatePassed') : t('aiTraining.gateFailed')}</Badge></td>
                  </tr>
                ))}
              </Table>
              <h3 className="mb-1 mt-4 text-xs font-medium text-muted">{t('aiTraining.suites')}</h3>
              <Table head={[t('aiTraining.cols.suite'), 'split', t('aiTraining.cols.config'), t('aiTraining.cols.cases'), t('aiTraining.cols.metrics'), 'ms']} minWidth={860}>
                {(shown.suites ?? []).filter((s) => s.split === 'test').map((s, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="py-2 pr-3">{s.suite}</td>
                    <td className="pr-3">{s.split}</td>
                    <td className="pr-3 text-xs">{s.config}</td>
                    <td className="pr-3 tabular">{s.cases}</td>
                    <td className="pr-3 text-xs">{s.status === 'executed' ? Object.entries(s.metrics).filter(([, v]) => typeof v === 'number' || v === null).map(([k, v]) => `${k}=${fmt(v)}`).join(' · ') : t('aiTraining.notExecuted', { reason: s.reason ?? '' })}</td>
                    <td className="tabular">{s.ms}</td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title={t('aiTraining.datasets')}>
            <Table head={['dataset', t('aiTraining.cols.agent'), 'train / val / test', t('aiTraining.cols.technique')]} minWidth={520}>
              {data.datasets.map((d) => (
                <tr key={d.id} className="border-t border-line">
                  <td className="py-2 pr-3 text-xs"><span className="font-mono">{d.id}@{d.version}</span>{d.synthetic && <Badge tone="signal" className="ml-1">{t('aiTraining.synthetic')}</Badge>}</td>
                  <td className="pr-3">{d.agent}</td>
                  <td className="pr-3 tabular">{d.splits.train} / {d.splits.validation} / {d.splits.test}</td>
                  <td className="text-xs">{d.technique.join(', ')}</td>
                </tr>
              ))}
            </Table>
            <p className="mt-3 text-xs text-muted">{t('aiTraining.techniquesNote')}</p>
          </Panel>
          <Panel title={t('aiTraining.feedbackErrorsCosts')}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {Object.entries(data.feedback.by_status).map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-line py-1"><dt className="text-muted">{t('aiTraining.feedback')} · {k}</dt><dd className="tabular">{num(v)}</dd></div>
              ))}
              <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">{t('aiTraining.orgsWithFeedback')}</dt><dd className="tabular">{num(data.feedback.organizations_with_feedback)}</dd></div>
              <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">{t('aiTraining.credits30')}</dt><dd className="tabular">{num(data.costs_30d.credits)}</dd></div>
              <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">{t('aiTraining.cost30')}</dt><dd className="tabular">{usd(data.costs_30d.cost_usd)}{data.costs_30d.unpriced_calls ? ' *' : ''}</dd></div>
              {Object.entries(data.errors_30d).slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-line py-1"><dt className="font-mono text-xs text-muted">{k}</dt><dd className="tabular">{num(v)}</dd></div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">{t('aiTraining.feedbackNote')}</p>
          </Panel>
        </div>
      </div>
    </>
  )
}
