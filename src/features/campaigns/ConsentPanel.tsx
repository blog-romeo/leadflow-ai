import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { OUTREACH_CHANNELS, type ConsentRecordRow, type OutreachChannel } from '../../lib/database.types'
import { Panel } from '../../components/ui/Panel'
import { Field, Select } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { InlineAlert } from '../../components/ui/States'
import { cmError, splitList } from './shared'

/** Registro dei consensi/opposizioni per canale (append-only) e tag del lead. */
export function ConsentPanel({ orgId, leadId }: { orgId: string; leadId: string }) {
  const { t, formatDate } = useI18n()
  const [rows, setRows] = useState<ConsentRecordRow[]>([])
  const [tags, setTags] = useState('')
  const [f, setF] = useState({ channel: 'email' as OutreachChannel, status: 'granted' as ConsentRecordRow['status'], evidence: '', evidence_url: '', policy_version: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const [c, l] = await Promise.all([
      supabase.from('consent_records').select('*').eq('organization_id', orgId).eq('lead_id', leadId).order('captured_at', { ascending: false }).limit(50),
      supabase.from('leads').select('tags').eq('organization_id', orgId).eq('id', leadId).maybeSingle(),
    ])
    setRows((c.data ?? []) as ConsentRecordRow[])
    setTags(((l.data?.tags as string[] | undefined) ?? []).join(', '))
  }, [orgId, leadId])
  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!supabase || f.evidence.trim().length < 5) return
    setBusy(true)
    const { error } = await supabase.from('consent_records').insert({
      organization_id: orgId,
      lead_id: leadId,
      channel: f.channel,
      status: f.status,
      evidence: f.evidence.trim(),
      evidence_url: f.evidence_url.trim() || null,
      policy_version: f.policy_version.trim() || null,
    })
    setBusy(false)
    if (error) return setMsg({ ok: false, text: cmError(error, t) })
    setMsg({ ok: true, text: t('consent.added') })
    setF({ ...f, evidence: '', evidence_url: '' })
    void load()
  }

  async function saveTags() {
    if (!supabase) return
    const list = [...new Set(splitList(tags).map((x) => x.toLowerCase().slice(0, 40)))].slice(0, 20)
    const { error } = await supabase.from('leads').update({ tags: list }).eq('organization_id', orgId).eq('id', leadId)
    setMsg(error ? { ok: false, text: cmError(error, t) } : { ok: true, text: t('consent.tagsSaved') })
  }

  return (
    <Panel title={t('consent.title')} as="h3">
      <div className="space-y-4 text-sm">
        <p className="text-muted">{t('consent.intro')}</p>
        {rows.length === 0 ? (
          <p className="text-muted">{t('consent.none')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id} className="border-b border-line/60 pb-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={r.status === 'granted' ? 'ok' : 'danger'}>{t(`consent.statuses.${r.status}`)}</Badge>
                  <Badge tone="neutral">{t(`cm.channels.${r.channel}`)}</Badge>
                  <span className="text-xs text-muted">{formatDate(r.captured_at)}</span>
                </div>
                <p className="mt-1 break-words">{r.evidence}</p>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(e) => void add(e)} className="space-y-3 border-t border-line pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label={t('consent.channel')} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as OutreachChannel })}>
              {OUTREACH_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`cm.channels.${c}`)}
                </option>
              ))}
            </Select>
            <Select label={t('consent.status')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as ConsentRecordRow['status'] })}>
              {(['granted', 'withdrawn', 'objected'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`consent.statuses.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <Field label={t('consent.evidence')} hint={t('consent.evidenceHint')} value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} maxLength={2000} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('consent.evidenceUrl')} type="url" placeholder="https://" value={f.evidence_url} onChange={(e) => setF({ ...f, evidence_url: e.target.value })} />
            <Field label={t('consent.policyVersion')} value={f.policy_version} onChange={(e) => setF({ ...f, policy_version: e.target.value })} maxLength={60} />
          </div>
          <Button type="submit" size="sm" loading={busy} disabled={f.evidence.trim().length < 5}>
            {t('consent.add')}
          </Button>
        </form>
        <div className="space-y-2 border-t border-line pt-3">
          <Field label={t('consent.tags')} hint={t('consent.tagsHint')} value={tags} onChange={(e) => setTags(e.target.value)} />
          <Button size="sm" variant="secondary" onClick={() => void saveTags()}>
            {t('consent.saveTags')}
          </Button>
        </div>
        <div aria-live="polite" className="empty:hidden">
          {msg && <InlineAlert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</InlineAlert>}
        </div>
      </div>
    </Panel>
  )
}
