/**
 * Stima dei costi AI: prezzi per milione di token da variabili d'ambiente
 * (dipendono dal modello scelto e cambiano nel tempo, quindi non sono nel codice).
 */
export function estimateCostUsd(usage: { input_tokens: number; output_tokens: number }, env: NodeJS.ProcessEnv = process.env): number | null {
  const pin = Number(env.OPENAI_PRICE_INPUT_PER_MTOK)
  const pout = Number(env.OPENAI_PRICE_OUTPUT_PER_MTOK)
  if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0 || !env.OPENAI_PRICE_INPUT_PER_MTOK || !env.OPENAI_PRICE_OUTPUT_PER_MTOK) return null
  return Math.round(((usage.input_tokens * pin + usage.output_tokens * pout) / 1_000_000) * 1e6) / 1e6
}

/** Limiti di output per compito: contengono i costi per singola chiamata. */
export const MAX_OUTPUT_TOKENS: Record<string, number> = {
  intelligence: 3000,
  messages: 4000,
  proposal: 4000,
  follow_up_suggestion: 2000,
  copilot: 2500,
}
