import { timingSafeEqual } from 'node:crypto'

/** Verifica il segreto interno delle background function (confronto a tempo costante). */
export function timingSafeInternal(req: Request): boolean {
  const expected = process.env.LEADFLOW_INTERNAL_SECRET ?? ''
  const got = req.headers.get('x-leadflow-internal') ?? ''
  if (expected.length < 32) return false
  // Confronto sui BYTE: con caratteri non ASCII la lunghezza della stringa non coincide con quella dei byte
  // e timingSafeEqual lancerebbe un'eccezione (500 invece di 401).
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
