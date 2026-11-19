/** fetch con timeout esplicito. Il chiamante decide come mappare gli errori. */
export class TimeoutError extends Error {
  constructor() {
    super('timeout')
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { dispatcher?: unknown },
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal } as RequestInit)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new TimeoutError()
    throw err
  } finally {
    clearTimeout(timer)
  }
}
