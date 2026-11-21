import { describe, expect, it } from 'vitest'
import { historyForServer, ticketBody, ticketSubject, type ChatMessage } from './chatTranscript'

const msgs: ChatMessage[] = [
  { role: 'user', text: 'Come   esporto i lead?' },
  { role: 'assistant', text: 'Da Lead → Esporta CSV.' },
  { role: 'assistant', text: 'Troppe richieste', error: true },
  { role: 'user', text: 'E i contatti del CRM?' },
]

describe('chatTranscript', () => {
  it('rimanda al server solo turni validi, al massimo 6', () => {
    const h = historyForServer([...msgs, ...msgs, ...msgs])
    expect(h.length).toBe(6)
    expect(h.some((t) => t.text === 'Troppe richieste')).toBe(false)
  })
  it('oggetto del ticket dalla prima domanda, entro i limiti del database', () => {
    expect(ticketSubject(msgs, 'fallback')).toBe('Come esporto i lead?')
    expect(ticketSubject([], 'Richiesta dal chatbot')).toBe('Richiesta dal chatbot')
    expect(ticketSubject([{ role: 'user', text: 'x'.repeat(400) }], 'f').length).toBeLessThanOrEqual(160)
  })
  it('trascrizione leggibile, senza errori, con nota, massimo 5.000 caratteri', () => {
    const b = ticketBody(msgs, { intro: 'Intro', user: 'Cliente', bot: 'Assistente', note: ' urgente ' })
    expect(b).toContain('Cliente: Come esporto i lead?')
    expect(b).toContain('Assistente: Da Lead → Esporta CSV.')
    expect(b).not.toContain('Troppe richieste')
    expect(b.endsWith('urgente')).toBe(true)
    const long = ticketBody(Array.from({ length: 50 }, () => ({ role: 'user' as const, text: 'y'.repeat(300) })), { intro: 'I', user: 'U', bot: 'B' })
    expect(long.length).toBeLessThanOrEqual(5000)
  })
})
