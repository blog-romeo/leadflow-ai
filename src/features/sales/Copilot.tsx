import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Plus, Send, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { supabase } from '../../lib/supabase'
import { apiFetch } from '../../lib/api'
import type { AiConversationRow, AiMessageRow } from '../../lib/database.types'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { InlineAlert } from '../../components/ui/States'
import { cn } from '../../lib/cn'
import { jobErrorReason, salesErrorMessage } from './errors'
import { useJob } from './jobs'
import { JobBanner } from './JobBanner'

const ACTION_TAB: Record<string, string> = { open_lead: 'overview', generate_messages: 'messages', generate_proposal: 'proposals', create_follow_up: 'followUps' }

function Answer({ m, names }: { m: AiMessageRow; names: Record<string, string> }) {
  const { t } = useI18n()
  const s = m.structured
  const refs = (ids: string[]) =>
    ids.length ? (
      <span className="ml-1 inline-flex flex-wrap gap-1">
        {ids.map((id) => (
          <Link key={id} to={`/app/sales-agent/leads/${id}`} className="text-xs text-flow hover:underline">
            {names[id] ?? id.slice(0, 8)}
          </Link>
        ))}
      </span>
    ) : null
  return (
    <div className="space-y-3 text-sm">
      <p className="whitespace-pre-wrap">{m.content}</p>
      {!!s?.facts.length && (
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold">
            <Badge tone="ok">{t('sales.copilot.facts')}</Badge>
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-5">{s.facts.map((f, i) => <li key={i}>{f.statement}{refs(f.lead_ids)}</li>)}</ul>
        </section>
      )}
      {!!s?.inferences.length && (
        <section>
          <h4 className="text-xs font-semibold">
            <Badge tone="signal">{t('sales.copilot.inferences')}</Badge>
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-5">{s.inferences.map((f, i) => <li key={i}>{f.statement}{refs(f.lead_ids)}</li>)}</ul>
        </section>
      )}
      {!!s?.suggestions.length && (
        <section>
          <h4 className="text-xs font-semibold">
            <Badge tone="flow">{t('sales.copilot.suggestions')}</Badge>
          </h4>
          <ul className="mt-1 space-y-1.5">
            {s.suggestions.map((sg, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span>{sg.statement}</span>
                {sg.lead_id && sg.action !== 'none' && (
                  <Link to={`/app/sales-agent/leads/${sg.lead_id}?tab=${ACTION_TAB[sg.action] ?? 'overview'}`} className="rounded-md border border-line px-2 py-0.5 text-xs text-flow hover:bg-surface-2">
                    {t(`sales.copilot.actions.${sg.action}`)}
                    {names[sg.lead_id] ? ` · ${names[sg.lead_id]}` : ''}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function Copilot({ orgId, open, onClose, leadId, leadName }: { orgId: string; open: boolean; onClose: () => void; leadId?: string; leadName?: string }) {
  const { t, list } = useI18n()
  const [conversations, setConversations] = useState<AiConversationRow[]>([])
  const [convId, setConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiMessageRow[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const loadConversations = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('ai_conversations').select('*').eq('organization_id', orgId).is('archived_at', null).order('updated_at', { ascending: false }).limit(20)
    setConversations((data ?? []) as AiConversationRow[])
  }, [orgId])

  const loadMessages = useCallback(async (id: string) => {
    if (!supabase) return
    const { data } = await supabase.from('ai_messages').select('*').eq('conversation_id', id).order('created_at').limit(100)
    const rows = (data ?? []) as unknown as AiMessageRow[]
    setMessages(rows)
    const ids = new Set<string>()
    for (const m of rows) {
      m.structured?.facts.forEach((f) => f.lead_ids.forEach((x) => ids.add(x)))
      m.structured?.inferences.forEach((f) => f.lead_ids.forEach((x) => ids.add(x)))
      m.structured?.suggestions.forEach((s) => s.lead_id && ids.add(s.lead_id))
    }
    if (ids.size) {
      const { data: leads } = await supabase.from('leads').select('id, company_name').in('id', [...ids])
      setNames(Object.fromEntries((leads ?? []).map((l) => [l.id, l.company_name])))
    }
  }, [])

  useEffect(() => {
    if (open) void loadConversations()
  }, [open, loadConversations])
  useEffect(() => {
    if (convId) void loadMessages(convId)
    else setMessages([])
  }, [convId, loadMessages])
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const { job, running } = useJob(jobId, (j) => {
    if (j.status === 'failed') setError(t('sales.copilot.failed', { code: jobErrorReason(j.error, t) }))
    if (convId) void loadMessages(convId)
    void loadConversations()
  })

  async function send(e?: FormEvent, preset?: string) {
    e?.preventDefault()
    const message = (preset ?? text).trim()
    if (message.length < 2 || running) return
    setError(null)
    setSending(true)
    try {
      const r = await apiFetch<{ job_id: string; conversation_id: string }>('/api/sales-agent/copilot', {
        method: 'POST',
        body: { organization_id: orgId, message, ...(convId ? { conversation_id: convId } : leadId ? { lead_id: leadId } : {}) },
      })
      setText('')
      setConvId(r.conversation_id)
      setJobId(r.job_id)
      await loadMessages(r.conversation_id)
    } catch (err) {
      setError(salesErrorMessage(err, t))
    } finally {
      setSending(false)
    }
  }

  async function remove(id: string) {
    if (!supabase) return
    await supabase.from('ai_conversations').delete().eq('id', id)
    if (convId === id) setConvId(null)
    void loadConversations()
  }

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title={t('sales.copilot.title')} closeLabel={t('sales.copilot.close')}>
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="conv-select">
            {t('sales.copilot.history')}
          </label>
          <select id="conv-select" value={convId ?? ''} onChange={(e) => setConvId(e.target.value || null)} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm">
            <option value="">{t('sales.copilot.newConversation')}</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title ?? c.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={() => setConvId(null)} aria-label={t('sales.copilot.newConversation')}>
            <Plus className="size-4" aria-hidden />
          </Button>
          {convId && (
            <Button size="sm" variant="ghost" onClick={() => void remove(convId)} aria-label={t('sales.copilot.delete')}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        {!convId && leadName && <p className="text-xs text-muted">{t('sales.copilot.leadContext', { name: leadName })}</p>}
        <p className="text-xs text-muted">{t('sales.copilot.disclaimer')}</p>

        <div className="min-h-[12rem] flex-1 space-y-4" aria-live="polite">
          {messages.length === 0 ? (
            <div className="space-y-3">
              <p className="flex gap-2 text-sm text-muted">
                <Bot className="size-5 shrink-0 text-flow" aria-hidden />
                {t('sales.copilot.empty')}
              </p>
              <div className="flex flex-wrap gap-2">
                {list('sales.copilot.examples').map((ex) => (
                  <button key={ex} type="button" onClick={() => void send(undefined, ex)} disabled={running || sending} className="rounded-full border border-line px-3 py-1 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={cn('rounded-[var(--radius-panel)] p-3', m.role === 'user' ? 'ml-8 bg-flow-soft' : 'mr-2 border border-line bg-surface')}>
                {m.role === 'user' ? <p className="whitespace-pre-wrap text-sm">{m.content}</p> : <Answer m={m} names={names} />}
              </div>
            ))
          )}
          {running && <JobBanner job={job} />}
          {running && <p className="text-xs text-muted">{t('sales.copilot.thinking')}</p>}
          <div ref={endRef} />
        </div>

        {error && <InlineAlert>{error}</InlineAlert>}
        <form onSubmit={(e) => void send(e)} className="sticky bottom-0 flex items-end gap-2 bg-surface pt-2">
          <label htmlFor="copilot-input" className="sr-only">
            {t('sales.copilot.placeholder')}
          </label>
          <textarea
            id="copilot-input"
            rows={2}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={t('sales.copilot.placeholder')}
            className="min-w-0 flex-1 resize-none rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm focus:border-flow focus:outline-none"
          />
          <Button type="submit" loading={sending} disabled={running || text.trim().length < 2} aria-label={t('sales.copilot.send')}>
            <Send className="size-4" aria-hidden />
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
