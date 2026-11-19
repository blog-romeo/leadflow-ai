/** Utility HTTP condivise dalle Netlify Functions. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}

/** Converte qualsiasi errore in una risposta senza esporre dettagli interni. */
export function handleError(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.code }, err.status)
  console.error('[function-error]', err)
  return json({ error: 'internal_error' }, 500)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function requireUuid(value: string | null, name: string): string {
  if (!value || !UUID_RE.test(value)) throw new HttpError(400, `invalid_${name}`)
  return value
}
