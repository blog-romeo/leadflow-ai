import { timingSafeEqual } from 'node:crypto'

/** Verifica il segreto interno delle background function (confronto a tempo costante). */
export function timingSafeInternal(req: Request): boolean {
  const expected = process.env.LEADFLOW_INTERNAL_SECRET ?? ''
  const got = req.headers.get('x-leadflow-internal') ?? ''
  if (expected.length < 32 || got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}
