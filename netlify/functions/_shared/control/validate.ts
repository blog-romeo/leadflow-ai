import { HttpError } from '../http'

/** Validatori minimi per i parametri delle API della console (errore 400 con codice stabile). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function uuid(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `invalid_${name}`)
  return v
}
export function str(v: unknown, name: string, min = 1, max = 500): string {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new HttpError(400, `invalid_${name}`)
  return v.trim()
}
export function optStr(v: unknown, name: string, max = 500): string | null {
  if (v === undefined || v === null || v === '') return null
  return str(v, name, 1, max)
}
export function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError(400, `invalid_${name}`)
  return v
}
export function oneOf<T extends string>(v: unknown, name: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) throw new HttpError(400, `invalid_${name}`)
  return v as T
}
export function reason(v: unknown): string {
  // Ogni azione amministrativa che modifica stato o accessi va motivata.
  return str(v, 'reason', 10, 1000)
}
export function obj(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `invalid_${name}`)
  return v as Record<string, unknown>
}
export function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `invalid_${name}`)
  return n
}
export function isoDate(v: string | null, name: string): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `invalid_${name}`)
  return d.toISOString()
}
