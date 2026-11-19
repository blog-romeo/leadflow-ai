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
    public details?: Record<string, unknown>,
  ) {
    super(code)
  }
}

/** Converte qualsiasi errore in una risposta senza esporre dettagli interni. */
export function handleError(err: unknown): Response {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {}
    if (typeof err.details?.retry_after === 'number') headers['retry-after'] = String(err.details.retry_after)
    return json({ error: err.code, ...(err.details ?? {}) }, err.status, headers)
  }
  console.error(JSON.stringify({ level: 'error', event: 'unhandled_function_error', message: (err as Error)?.message?.slice(0, 200) }))
  return json({ error: 'internal_error' }, 500)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function requireUuid(value: string | null, name: string): string {
  if (!value || !UUID_RE.test(value)) throw new HttpError(400, `invalid_${name}`)
  return value
}

/** Legge un body JSON con limite di dimensione. */
export async function readJson(req: Request, maxBytes = 512_000): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > maxBytes) throw new HttpError(413, 'payload_too_large')
  const text = await req.text()
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

export function requireMethod(req: Request, method: string): void {
  if (req.method !== method) throw new HttpError(405, 'method_not_allowed')
}
