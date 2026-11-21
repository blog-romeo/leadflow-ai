import { describe, expect, it } from 'vitest'
import { timingSafeInternal } from '../../internalAuth'

const SECRET = 'x'.repeat(40)
const req = (h?: string) => new Request('https://x.it/api/run', { method: 'POST', headers: h === undefined ? {} : { 'x-leadflow-internal': h } })

describe('segreto interno delle background function', () => {
  it('accetta solo il segreto esatto', () => {
    process.env.LEADFLOW_INTERNAL_SECRET = SECRET
    expect(timingSafeInternal(req(SECRET))).toBe(true)
    expect(timingSafeInternal(req('y'.repeat(40)))).toBe(false)
    expect(timingSafeInternal(req())).toBe(false)
  })
  it('caratteri non ASCII con la stessa lunghezza: rifiuto, non eccezione', () => {
    process.env.LEADFLOW_INTERNAL_SECRET = SECRET
    expect(() => timingSafeInternal(req('é'.repeat(40)))).not.toThrow()
    expect(timingSafeInternal(req('é'.repeat(40)))).toBe(false)
  })
  it('segreto server troppo corto: tutto rifiutato', () => {
    process.env.LEADFLOW_INTERNAL_SECRET = 'corto'
    expect(timingSafeInternal(req('corto'))).toBe(false)
  })
})
