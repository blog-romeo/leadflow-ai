import { log } from './log'

/** Avvia una background function interna, autenticata con il segreto condiviso. */
export async function dispatchBackground(path: string, reqUrl: string, body: Record<string, unknown>): Promise<boolean> {
  const target = new URL(path, process.env.URL ?? reqUrl)
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-leadflow-internal': process.env.LEADFLOW_INTERNAL_SECRET ?? '' },
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!res || res.status >= 400) {
    log('error', 'dispatch_failed', { path, status: res?.status })
    return false
  }
  return true
}

export { timingSafeInternal } from './internalAuth'
