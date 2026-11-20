import { fetchWithTimeout, TimeoutError } from '../../fetchTimeout'

/**
 * Client minimale per OpenAI Responses API con Structured Outputs.
 * Solo lato server: la chiave arriva da OPENAI_API_KEY e non lascia mai le functions.
 */
export class AiError extends Error {
  constructor(
    public code: 'ai_not_configured' | 'ai_auth_failed' | 'ai_rate_limited' | 'ai_timeout' | 'ai_unavailable' | 'ai_refused' | 'ai_incomplete' | 'ai_bad_response',
    public retryable = false,
  ) {
    super(code)
  }
}

export interface AiCallResult {
  json: unknown
  model: string
  usage: { input_tokens: number; output_tokens: number }
}

export async function callStructured(params: {
  apiKey: string
  model: string
  system: string
  user: string
  schemaName: string
  schema: unknown
  timeoutMs: number
  maxOutputTokens?: number
  fetchImpl?: typeof fetch
}): Promise<AiCallResult> {
  if (!params.apiKey || !params.model) throw new AiError('ai_not_configured')
  let res: Response
  try {
    res = await fetchWithTimeout(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${params.apiKey}` },
        body: JSON.stringify({
          model: params.model,
          store: false,
          max_output_tokens: params.maxOutputTokens ?? 4000,
          input: [
            { role: 'system', content: params.system },
            { role: 'user', content: params.user },
          ],
          text: { format: { type: 'json_schema', name: params.schemaName, schema: params.schema, strict: true } },
        }),
      },
      params.timeoutMs,
      params.fetchImpl,
    )
  } catch (err) {
    if (err instanceof TimeoutError) throw new AiError('ai_timeout', true)
    throw new AiError('ai_unavailable', true)
  }
  if (res.status === 401 || res.status === 403) throw new AiError('ai_auth_failed')
  if (res.status === 429) throw new AiError('ai_rate_limited', true)
  if (!res.ok) throw new AiError(res.status >= 500 ? 'ai_unavailable' : 'ai_bad_response', res.status >= 500)

  type Part = { type: string; text?: string; refusal?: string }
  let body: { status?: string; model?: string; output?: { type: string; content?: Part[] }[]; usage?: { input_tokens?: number; output_tokens?: number } }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new AiError('ai_bad_response')
  }
  if (body.status === 'incomplete') throw new AiError('ai_incomplete')
  const parts = (body.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? [])
  if (parts.some((p) => p.type === 'refusal')) throw new AiError('ai_refused')
  const text = parts.find((p) => p.type === 'output_text')?.text
  if (!text) throw new AiError('ai_bad_response')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new AiError('ai_bad_response')
  }
  return {
    json,
    model: body.model ?? params.model,
    usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
  }
}
