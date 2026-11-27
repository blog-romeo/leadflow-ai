// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createServiceClient } from '../gateway'
import { demandHunterAgent, intentAnalysisAgent } from '../agents'
import type { ServiceJobView } from '../types'

/**
 * Integrazione reale gateway (TypeScript) ↔ servizio Python, in modalità SIMULATA. Saltato se non configurato:
 *   cd services/demand-hunter && DEMAND_HUNTER_SERVICE_SECRET=<32+> DH_DATA_DIR=/tmp/dh uvicorn app.main:app --port 8765
 *   DH_E2E_SERVICE_URL=http://127.0.0.1:8765 DH_E2E_SECRET=<stesso> npx vitest run service.e2e
 */
const url = process.env.DH_E2E_SERVICE_URL
const secret = process.env.DH_E2E_SECRET ?? ''
const ORG = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e'
const OTHER = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f'
const USER = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a'

describe.skipIf(!url)('e2e: gateway ↔ servizio Python (simulato)', () => {
  const client = () => createServiceClient({ url: url!, secret })
  it('firma accettata, caccia simulata completa, letture valide, isolamento', async () => {
    const ctx = { orgId: ORG, userId: USER }
    const st = await client().call<{ mode: string }>(ctx, 'GET', '/v1/status')
    expect(st.mode).toBe('simulated')
    const key = crypto.randomUUID()
    const started = await client().call<{ job_id: string }>(ctx, 'POST', '/v1/hunts', { seed: 'Laravel', budget: 6, goal: 'clienti', idempotency_key: key })
    const again = await client().call<{ job_id: string; duplicate: boolean }>(ctx, 'POST', '/v1/hunts', { seed: 'Laravel', budget: 6, goal: 'clienti', idempotency_key: key })
    expect(again).toMatchObject({ job_id: started.job_id, duplicate: true })
    let view: ServiceJobView | null = null
    for (let i = 0; i < 100; i++) {
      view = await client().call<ServiceJobView>(ctx, 'GET', `/v1/hunts/${started.job_id}`)
      if (view.terminal) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(view?.status).toBe('finita')
    const snap = demandHunterAgent(view!.hunt).output
    expect(snap.lead_list.length).toBeGreaterThan(0)
    expect(intentAnalysisAgent(snap.lead_list).output).toHaveLength(snap.lead_list.length)
    await expect(client().call({ orgId: OTHER, userId: USER }, 'GET', `/v1/hunts/${started.job_id}`)).rejects.toMatchObject({ status: 404 })
    await expect(createServiceClient({ url: url!, secret: 'x'.repeat(40) }).call(ctx, 'GET', '/v1/status')).rejects.toMatchObject({ status: 503 })
  })
})
