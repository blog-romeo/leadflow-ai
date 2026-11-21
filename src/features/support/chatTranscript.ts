/** Utilità pure del chatbot di assistenza (testabili senza React). */
export interface ChatSource { id: string; title: string; link?: string }
export interface ChatReply {
  mode: 'intent' | 'ai' | 'docs' | 'no_match'
  intent: 'greeting' | 'thanks' | 'human' | null
  answer: string
  sources: ChatSource[]
  handoff: boolean
}
export interface ChatMessage { role: 'user' | 'assistant'; text: string; reply?: ChatReply; error?: boolean }

/** Ultimi turni da rimandare al server come contesto (il server li ripulisce comunque). */
export function historyForServer(messages: ChatMessage[], max = 6): { role: 'user' | 'assistant'; text: string }[] {
  return messages.filter((m) => !m.error && m.text).slice(-max).map((m) => ({ role: m.role, text: m.text.slice(0, 600) }))
}

/** Oggetto del ticket: la prima domanda dell'utente, accorciata (3–160 caratteri, vincolo del database). */
export function ticketSubject(messages: ChatMessage[], fallback: string): string {
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? ''
  const s = first.length >= 3 ? first : fallback
  return s.length > 150 ? `${s.slice(0, 147)}…` : s
}

/** Trascrizione leggibile allegata al ticket (massimo 5.000 caratteri, vincolo del database). */
export function ticketBody(messages: ChatMessage[], labels: { intro: string; user: string; bot: string; note?: string }): string {
  const lines = [labels.intro, '']
  for (const m of messages) if (m.text && !m.error) lines.push(`${m.role === 'user' ? labels.user : labels.bot}: ${m.text.replace(/\s+/g, ' ').trim()}`)
  if (labels.note?.trim()) lines.push('', labels.note.trim())
  const body = lines.join('\n')
  return body.length > 5000 ? `${body.slice(0, 4990)}\n…` : body
}
