import { json } from './_shared/http'

/** GET /api/health — liveness check senza informazioni sensibili. */
export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  return json({ status: 'ok', service: 'leadflow-ai', time: new Date().toISOString() })
}
export const config = { path: '/api/health' }
