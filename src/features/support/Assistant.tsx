import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { MessageCircleQuestion, RotateCcw, Send, UserRound } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch, ApiError } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { env } from '../../lib/env'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { historyForServer, ticketBody, ticketSubject, type ChatMessage, type ChatReply } from './chatTranscript'

type Audience = 'app' | 'public'

/** Chiamata pubblica (visitatori senza account): nessun token, il server limita per IP. */
async function publicChat(body: unknown): Promise<ChatReply> {
  let res: Response
  try {
    res = await fetch('/api/support-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'network')
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Partial<ChatReply>
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'generic')
  return data as ChatReply
}

/**
 * Chatbot di assistenza clienti. Risponde solo dalla documentazione, non esegue azioni e non legge
 * dati dell'account. Se non trova la risposta lo dice e propone una persona: in app crea un ticket
 * con la trascrizione SOLO dopo conferma esplicita dell'utente; sul sito rimanda al modulo di contatto.
 */
export function AssistantChat({ audience = 'app' }: { audience?: Audience }) {
  const { t, locale } = useI18n()
  const { currentOrg } = useAuth()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const [note, setNote] = useState('')
  const [ticket, setTicket] = useState<{ id?: string; error?: boolean } | null>(null)
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const isApp = audience === 'app'
  const scroll = () => requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }))

  async function send(question: string) {
    question = question.trim()
    if (question.length < 3 || busy || (isApp && !currentOrg)) return
    setQ('')
    setBusy(true)
    const history = historyForServer(messages)
    setMessages((ms) => [...ms, { role: 'user', text: question }])
    scroll()
    let next: ChatMessage
    try {
      const body = { question, locale, history, ...(isApp ? { organization_id: currentOrg!.id } : {}) }
      const reply = isApp ? await apiFetch<ChatReply>('/api/support-chat', { method: 'POST', body }) : await publicChat(body)
      next = { role: 'assistant', text: reply.answer, reply }
      if (reply.handoff) setHandoff(true)
    } catch (err) {
      next = { role: 'assistant', text: t(`assistant.errors.${err instanceof ApiError && err.code === 'rate_limited' ? 'rate_limited' : 'generic'}`), error: true }
    }
    setMessages((ms) => [...ms, next])
    setBusy(false)
    scroll()
  }

  async function createTicket() {
    if (!supabase || !currentOrg || sending) return
    setSending(true)
    const { data, error } = await supabase.rpc('support_create_ticket', {
      p_org: currentOrg.id,
      p_subject: ticketSubject(messages, t('assistant.ticketFallbackSubject')),
      p_category: 'other',
      p_priority: 'normal',
      p_body: ticketBody(messages, { intro: t('assistant.ticketIntro'), user: t('assistant.ticketUser'), bot: t('assistant.ticketBot'), note }),
    })
    setSending(false)
    if (error || !data) return setTicket({ error: true })
    setTicket({ id: String(data) })
    setHandoff(false)
    setNote('')
  }

  function reset() {
    setMessages([])
    setHandoff(false)
    setTicket(null)
    setNote('')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void send(q)
  }
  const suggestions = (['q1', 'q2', 'q3', 'q4'] as const).map((k) => t(`assistant.suggestions.${k}`))

  return (
    <div className="flex h-full min-h-[22rem] flex-col">
      <p className="text-sm text-muted">{isApp ? t('assistant.intro') : t('assistant.publicIntro')}</p>
      {messages.length === 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted">{t('assistant.suggestions.label')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-line px-3 py-1 text-xs hover:border-flow">
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex-1 space-y-3 overflow-y-auto" aria-live="polite">
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <p key={i} className="ml-auto max-w-[85%] rounded-lg bg-flow-soft px-3 py-2 text-sm text-ink">{m.text}</p>
          ) : m.error ? (
            <p key={i} className="max-w-[90%] rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{m.text}</p>
          ) : (
            <div key={i} className="max-w-[90%] rounded-lg border border-line bg-surface px-3 py-2 text-sm">
              <p className="whitespace-pre-line">{m.text}</p>
              {(m.reply?.mode === 'ai' || m.reply?.mode === 'docs') && (
                <p className="mt-2 text-xs text-muted">{m.reply.mode === 'ai' ? t('assistant.modeAi') : t('assistant.modeDocs')}</p>
              )}
              {m.reply && m.reply.sources.length > 0 && (
                <p className="mt-2 text-xs">
                  <span className="text-muted">{t('assistant.sources')}: </span>
                  {m.reply.sources.map((s, j) => (
                    <span key={s.id}>
                      {j > 0 && ' · '}
                      {isApp ? <Link to={`/app/support?article=${s.id}`} className="text-flow hover:underline">{s.title}</Link> : <span>{s.title}</span>}
                    </span>
                  ))}
                </p>
              )}
            </div>
          ),
        )}
        {busy && <p className="text-sm text-muted" role="status">{t('assistant.thinking')}</p>}

        {ticket && (
          <p className={ticket.error ? 'rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger' : 'rounded-lg bg-flow-soft px-3 py-2 text-sm'} role="status">
            {ticket.error ? t('assistant.handoffError') : t('assistant.handoffSent')}
            {isApp && ticket.id && <> <Link to={`/app/support?ticket=${ticket.id}`} className="font-medium text-flow hover:underline">→</Link></>}
          </p>
        )}

        {handoff && (
          <div className="rounded-lg border border-flow/40 bg-surface px-3 py-3 text-sm">
            <p className="font-medium">{t('assistant.handoffTitle')}</p>
            <p className="mt-1 text-muted">{isApp ? t('assistant.handoffApp') : t('assistant.handoffPublic')}</p>
            {isApp ? (
              <>
                <label htmlFor="assistant-note" className="mt-3 block text-xs text-muted">{t('assistant.handoffNote')}</label>
                <textarea
                  id="assistant-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1000}
                  rows={2}
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-sm focus:border-flow focus:outline-none"
                />
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void createTicket()} loading={sending}>{t('assistant.handoffConfirm')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setHandoff(false)}>{t('assistant.handoffCancel')}</Button>
                </div>
              </>
            ) : (
              <div className="mt-2 flex gap-2">
                <Link to="/demo" className="text-sm font-medium text-flow hover:underline">{t('assistant.handoffContact')} →</Link>
                <button type="button" onClick={() => setHandoff(false)} className="text-sm text-muted hover:text-ink">{t('assistant.handoffCancel')}</button>
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="mt-3 flex items-center gap-3 text-xs">
        {!handoff && (
          <button type="button" onClick={() => setHandoff(true)} className="inline-flex items-center gap-1 text-muted hover:text-ink">
            <UserRound className="size-3.5" aria-hidden /> {t('assistant.talkToHuman')}
          </button>
        )}
        {messages.length > 0 && (
          <button type="button" onClick={reset} className="ml-auto inline-flex items-center gap-1 text-muted hover:text-ink">
            <RotateCcw className="size-3.5" aria-hidden /> {t('assistant.reset')}
          </button>
        )}
      </div>
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <label htmlFor={`assistant-q-${audience}`} className="sr-only">{t('assistant.placeholder')}</label>
        <input
          id={`assistant-q-${audience}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={600}
          placeholder={t('assistant.placeholder')}
          className="h-10 flex-1 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm focus:border-flow focus:outline-none focus:ring-2 focus:ring-flow/25"
        />
        <Button type="submit" loading={busy} disabled={q.trim().length < 3} aria-label={t('assistant.send')}>
          <Send className="size-4" aria-hidden />
        </Button>
      </form>
    </div>
  )
}

/** Pulsante flottante del chatbot: in tutta l'app (audience 'app') e sul sito pubblico ('public'). */
export function AssistantWidget({ audience = 'app' }: { audience?: Audience }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (!env.featureSupportChat) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-30 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-sm font-medium shadow-lg hover:border-flow"
        aria-haspopup="dialog"
      >
        <MessageCircleQuestion className="size-4 text-flow" aria-hidden />
        {t('assistant.open')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('assistant.title')} variant="drawer" closeLabel={t('assistant.close')}>
        <AssistantChat audience={audience} />
      </Dialog>
    </>
  )
}
