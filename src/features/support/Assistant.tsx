import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { MessageCircleQuestion, Send } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch, ApiError } from '../../lib/api'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'

interface Answer {
  mode: 'ai' | 'docs' | 'no_match'
  answer: string
  sources: { id: string; title: string; link?: string }[]
  suggest_ticket: boolean
}
interface Turn {
  q: string
  a?: Answer
  error?: string
}

/** Chat con l'assistente: risponde solo dalla documentazione, non esegue azioni. */
export function AssistantChat() {
  const { t, locale } = useI18n()
  const { currentOrg } = useAuth()
  const [turns, setTurns] = useState<Turn[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  async function ask(e: FormEvent) {
    e.preventDefault()
    const question = q.trim()
    if (question.length < 3 || !currentOrg || busy) return
    setQ('')
    setBusy(true)
    setTurns((ts) => [...ts, { q: question }])
    let turn: Turn
    try {
      const a = await apiFetch<Answer>('/api/assistant', { method: 'POST', body: { organization_id: currentOrg.id, question, locale } })
      turn = { q: question, a }
    } catch (err) {
      turn = { q: question, error: t(`assistant.errors.${err instanceof ApiError && err.code === 'rate_limited' ? 'rate_limited' : 'generic'}`) }
    }
    setTurns((ts) => [...ts.slice(0, -1), turn])
    setBusy(false)
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }))
  }

  return (
    <div className="flex h-full min-h-[22rem] flex-col">
      <p className="text-sm text-muted">{t('assistant.intro')}</p>
      <div className="mt-4 flex-1 space-y-4 overflow-y-auto" aria-live="polite">
        {turns.map((turn, i) => (
          <div key={i} className="space-y-2">
            <p className="ml-auto max-w-[85%] rounded-lg bg-flow-soft px-3 py-2 text-sm text-ink">{turn.q}</p>
            {turn.error ? (
              <p className="max-w-[90%] rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{turn.error}</p>
            ) : turn.a ? (
              <div className="max-w-[90%] rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                <p className="whitespace-pre-line">{turn.a.answer}</p>
                {turn.a.mode !== 'no_match' && (
                  <p className="mt-2 text-xs text-muted">{turn.a.mode === 'ai' ? t('assistant.modeAi') : t('assistant.modeDocs')}</p>
                )}
                {turn.a.sources.length > 0 && (
                  <p className="mt-2 text-xs">
                    <span className="text-muted">{t('assistant.sources')}: </span>
                    {turn.a.sources.map((s, j) => (
                      <span key={s.id}>
                        {j > 0 && ' · '}
                        <Link to={`/app/support?article=${s.id}`} className="text-flow hover:underline">{s.title}</Link>
                      </span>
                    ))}
                  </p>
                )}
                {turn.a.suggest_ticket && (
                  <Link to="/app/support?tab=tickets&new=1" className="mt-2 inline-block text-xs font-medium text-flow hover:underline">
                    {t('assistant.openTicket')} →
                  </Link>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted" role="status">{t('assistant.thinking')}</p>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={ask} className="mt-4 flex gap-2">
        <label htmlFor="assistant-q" className="sr-only">{t('assistant.placeholder')}</label>
        <input
          id="assistant-q"
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

/** Pulsante flottante dell'assistente, presente in tutta l'app. */
export function AssistantWidget() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
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
        <AssistantChat />
      </Dialog>
    </>
  )
}
