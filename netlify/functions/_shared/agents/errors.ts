/**
 * Errori del motore multi-agent. Il codice è stabile (salvato nel database e tradotto dall'interfaccia).
 *
 * - retryable: il passo può essere ripetuto (timeout, servizio temporaneamente non disponibile).
 * - stopWorkflow: il workflow si ferma (budget o crediti esauriti, configurazione mancante):
 *   i passi successivi non vengono eseguiti e i risultati già salvati restano disponibili.
 */
export class AgentError extends Error {
  constructor(
    public code: string,
    public opts: { retryable?: boolean; stopWorkflow?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(code)
  }
  get retryable(): boolean {
    return !!this.opts.retryable
  }
  get stopWorkflow(): boolean {
    return !!this.opts.stopWorkflow
  }
}

/** Richiesta di interruzione dell'utente rilevata a un punto di controllo. */
export class CancelledSignal extends Error {
  constructor() {
    super('cancelled_by_user')
  }
}

/** Tempo dell'invocazione esaurito: il lavoro riprende in una nuova invocazione dal punto salvato. */
export class YieldSignal extends Error {
  constructor() {
    super('yield')
  }
}

export class ToolDeniedError extends AgentError {
  constructor(public reason: string) {
    super('tool_denied', { details: { reason } })
  }
}

const RETRYABLE = new Set(['provider_timeout', 'provider_unavailable', 'provider_rate_limited', 'ai_timeout', 'ai_unavailable', 'ai_rate_limited', 'step_timeout'])

/** Converte errori dei moduli riusati (HttpError, AiError, ProviderError) in AgentError. */
export function toAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err
  const e = err as { code?: unknown; status?: unknown; details?: Record<string, unknown> }
  const code = typeof e?.code === 'string' && /^[a-z0-9_]{2,80}$/.test(e.code) ? e.code : 'internal_error'
  // Piano, crediti e tetti di spesa: il workflow si ferma (nessun tentativo ulteriore).
  const stop =
    code.startsWith('billing_') ||
    code.startsWith('platform_') ||
    code.startsWith('quota_') ||
    code === 'ai_not_configured' ||
    code === 'provider_not_configured' ||
    code === 'ai_auth_failed' ||
    code === 'sales_profile_incomplete'
  return new AgentError(code, { retryable: RETRYABLE.has(code) || (typeof e?.status === 'number' && e.status >= 500 && e.status !== 503 && !stop), stopWorkflow: stop, details: e?.details })
}
