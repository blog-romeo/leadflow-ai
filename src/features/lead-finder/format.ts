import type { Priority } from './types'

export const priorityTone: Record<Priority, 'ok' | 'signal' | 'neutral'> = { high: 'ok', medium: 'signal', low: 'neutral' }

/** Solo link http(s): impedisce javascript: o altri schemi provenienti da dati esterni. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

export function displayDomain(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
