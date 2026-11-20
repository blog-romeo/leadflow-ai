/**
 * Difese contro prompt injection per i contenuti non attendibili
 * (testi da siti web, nomi e dati dei lead, analisi precedenti, note).
 *
 * 1. I dati vengono passati al modello solo come JSON dentro un blocco delimitato,
 *    mai concatenati alle istruzioni (vedi prompts.ts).
 * 2. Si rimuovono caratteri di controllo, delimitatori e marcatori di ruolo.
 * 3. Le frasi che somigliano a istruzioni per il modello vengono sostituite e segnalate.
 * 4. L'output è comunque validato e verificato lato server (postcheck.ts).
 */
export const DATA_TAG = 'dati_non_attendibili'

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|above|previous|system)\b/i,
  /\b(ignora|dimentica|trascura|sovrascrivi)\b[^.\n]{0,40}\b(istruzion\w*|regol\w*|prompt|precedent\w*|sistema)\b/i,
  /\byou are (now|no longer)\b/i,
  /\b(ora sei|adesso sei|da ora sei)\b/i,
  /\b(system|developer)\s*(prompt|message|instructions?)\b/i,
  /\bprompt di sistema\b/i,
  /\b(new|nuove?)\s+(instructions?|istruzion\w*)\s*:/i,
  /\b(jailbreak|DAN mode|developer mode)\b/i,
  /\b(reveal|print|show|rivela|mostra|stampa)\b[^.\n]{0,30}\b(prompt|instructions?|istruzion\w*|api key|chiave)\b/i,
  /\b(send|invia|manda)\b[^.\n]{0,40}\b(email|e-mail|messaggio|message)\b[^.\n]{0,40}\b(to|a)\b[^.\n]{0,40}@/i,
]

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g
const ROLE_MARKERS = /<\/?\s*(system|assistant|user|developer|dati_non_attendibili|untrusted[_-]?data|instructions?)\b[^>]*>|\[\/?(INST|SYS)\]|<\|[^|]{0,20}\|>/gi

export interface SanitizeStats {
  flagged: number
}

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text))
}

export function sanitizeUntrusted(value: string, max = 2000, stats?: SanitizeStats): string {
  let t = value.replace(CONTROL, ' ').replace(ROLE_MARKERS, ' ').replace(/```+/g, ' ')
  // Valuta frase per frase: sostituisce solo le frasi sospette.
  const parts = t.split(/(?<=[.!?\n])\s+/)
  t = parts
    .map((p) => {
      if (looksLikeInjection(p)) {
        if (stats) stats.flagged++
        return '[testo rimosso: possibile istruzione non attendibile]'
      }
      return p
    })
    .join(' ')
  t = t.replace(/[ \t]+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Applica la sanificazione a tutte le stringhe di una struttura dati. */
export function sanitizeDeep<T>(value: T, max = 2000, stats: SanitizeStats = { flagged: 0 }, depth = 0): T {
  if (depth > 8) return value
  if (typeof value === 'string') return sanitizeUntrusted(value, max, stats) as T
  if (Array.isArray(value)) return value.slice(0, 60).map((v) => sanitizeDeep(v, max, stats, depth + 1)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeDeep(v, max, stats, depth + 1)
    return out as T
  }
  return value
}
