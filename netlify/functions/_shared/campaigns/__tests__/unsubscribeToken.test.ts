import { describe, expect, it } from 'vitest'
import { unsubscribeToken, verifyUnsubscribeToken } from '../crypto'

const env = { LEADFLOW_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString('base64') } as unknown as NodeJS.ProcessEnv
const ID = '3f2b8c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e'

describe('token di disiscrizione', () => {
  it('valido → id del messaggio', () => {
    expect(verifyUnsubscribeToken(unsubscribeToken(ID, env), env)).toBe(ID)
  })
  it('MAC con caratteri non ASCII della stessa lunghezza: rifiutato senza eccezioni', () => {
    const [idPart] = unsubscribeToken(ID, env).split('.')
    const forged = `${idPart}.${'é'.repeat(32)}`
    expect(() => verifyUnsubscribeToken(forged, env)).not.toThrow()
    expect(verifyUnsubscribeToken(forged, env)).toBeNull()
  })
  it('MAC alterato: rifiutato', () => {
    const t = unsubscribeToken(ID, env)
    expect(verifyUnsubscribeToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), env)).toBeNull()
  })
})
