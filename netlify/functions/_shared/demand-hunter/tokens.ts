import { createHash, randomBytes } from 'node:crypto'
import type { DhAction, Goal } from './types'

/** Token di conferma: 256 bit casuali. Nel database c'è solo lo SHA-256. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000

export function newConfirmationToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function normalizeText(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

/**
 * Chiave dell'azione confermata: il token vale SOLO per questo obiettivo, questo seme/area e questo
 * numero di chiamate a pagamento (come hunt_key di BuyerML api.py). Cambiare il budget richiede una nuova stima.
 */
export function actionKey(action: DhAction, goal: Goal, subject: string, paidCalls: number): string {
  return `${action}:${goal}:${normalizeText(subject)}:${paidCalls}`
}
