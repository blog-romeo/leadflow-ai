import type { z } from 'zod'
import { AGENTS, HIGH_IMPACT_TOOLS, MAX_TOOL_CALLS_PER_RUN, isForbiddenTool, type ToolName } from './catalog'
import { AgentError, ToolDeniedError, toAgentError } from './errors'
import type { AgentKey } from './types'

/**
 * Tool Gateway: unico punto da cui un agente può compiere un'azione.
 *
 * Per ogni chiamata verifica, nell'ordine:
 *  1. lo strumento non è vietato (segreti, ruoli, pagamenti, invii, cancellazioni massive, altre org);
 *  2. lo strumento è nell'allowlist dell'agente (definita nel codice, catalog.ts);
 *  3. le operazioni ad alto impatto hanno un'approvazione verificata nel database;
 *  4. gli argomenti non fanno riferimento a un'altra organizzazione (isolamento del tenant);
 *  5. gli argomenti rispettano lo schema (validazione input);
 *  6. il numero di chiamate per esecuzione non supera il limite.
 * Dopo l'esecuzione valida l'output (se è previsto uno schema) e registra la chiamata, anche se negata,
 * in ai_agent_tool_calls con argomenti riassunti e oscurati.
 */
export interface ToolCallRecord {
  runId: string | null
  workflowId: string | null
  agentKey: AgentKey
  tool: string
  outcome: 'succeeded' | 'failed' | 'denied'
  deniedReason: string | null
  errorCode: string | null
  argsSummary: Record<string, unknown>
  resultSummary: Record<string, unknown>
  durationMs: number | null
}

export interface ToolRecorder {
  recordToolCall(org: string, row: ToolCallRecord): Promise<void>
}

export interface GatewayContext {
  orgId: string
  agentKey: AgentKey
  runId: string | null
  workflowId: string | null
  /** Id dell'approvazione verificata dal motore (stato "approved" nel database) per il passo corrente. */
  approvalId: string | null
  maxCalls?: number
}

const SECRET_KEY = /(key|secret|token|password|authorization|cookie|credential|bearer)/i
const ORG_KEY = /^(organization_id|org|org_id|organizationId|orgId|tenant|tenant_id)$/

/** Riassunto sicuro degli argomenti/risultati: niente segreti, stringhe brevi, al massimo 20 campi. */
export function summarize(value: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!value || typeof value !== 'object') return out
  let n = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= 20) break
    if (SECRET_KEY.test(k)) {
      out[k] = '[redacted]'
    } else if (typeof v === 'string') {
      out[k] = /^(sk|rk|pk|whsec|re)_[A-Za-z0-9_]{6,}/.test(v) || /^Bearer\s/i.test(v) ? '[redacted]' : v.length > 120 ? `${v.slice(0, 120)}…` : v
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length}]`
    } else if (depth < 1) {
      out[k] = summarize(v, depth + 1)
    } else {
      out[k] = '{…}'
    }
  }
  return out
}

function findForeignOrg(args: unknown, orgId: string, depth = 0): boolean {
  if (!args || typeof args !== 'object' || depth > 4) return false
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (ORG_KEY.test(k) && typeof v === 'string' && v.toLowerCase() !== orgId.toLowerCase()) return true
    if (v && typeof v === 'object' && findForeignOrg(v, orgId, depth + 1)) return true
  }
  return false
}

export class ToolGateway {
  private calls = 0

  constructor(
    private recorder: ToolRecorder,
    private ctx: GatewayContext,
  ) {}

  get callCount(): number {
    return this.calls
  }

  private async deny(tool: string, reason: string, args: unknown): Promise<never> {
    await this.recorder
      .recordToolCall(this.ctx.orgId, {
        runId: this.ctx.runId,
        workflowId: this.ctx.workflowId,
        agentKey: this.ctx.agentKey,
        tool: /^[a-z][a-z_.]{2,60}$/.test(tool) ? tool : 'invalid.tool',
        outcome: 'denied',
        deniedReason: reason,
        errorCode: null,
        argsSummary: summarize(args),
        resultSummary: {},
        durationMs: null,
      })
      .catch(() => undefined)
    throw new ToolDeniedError(reason)
  }

  /** Verifica senza eseguire (usata anche dai test e dal planner). */
  check(tool: string, args: unknown = {}): string | null {
    if (isForbiddenTool(tool)) return 'tool_forbidden'
    if (!(AGENTS[this.ctx.agentKey].tools as readonly string[]).includes(tool)) return 'tool_not_allowed'
    if (HIGH_IMPACT_TOOLS.has(tool as ToolName) && !this.ctx.approvalId) return 'approval_required'
    if (findForeignOrg(args, this.ctx.orgId)) return 'cross_tenant'
    if (this.calls >= (this.ctx.maxCalls ?? MAX_TOOL_CALLS_PER_RUN)) return 'tool_call_limit'
    return null
  }

  async call<A, R>(
    tool: ToolName | string,
    args: A,
    fn: (args: A) => Promise<R>,
    opts: { argsSchema?: z.ZodType<A>; resultSchema?: z.ZodType<unknown>; summarizeResult?: (r: R) => Record<string, unknown> } = {},
  ): Promise<R> {
    const reason = this.check(tool, args)
    if (reason) return this.deny(tool, reason, args)
    let parsed = args
    if (opts.argsSchema) {
      const r = opts.argsSchema.safeParse(args)
      if (!r.success) return this.deny(tool, 'invalid_args', args)
      parsed = r.data
    }
    this.calls++
    const started = Date.now()
    try {
      const result = await fn(parsed)
      if (opts.resultSchema && !opts.resultSchema.safeParse(result).success) throw new AgentError('invalid_tool_output')
      await this.recorder.recordToolCall(this.ctx.orgId, {
        runId: this.ctx.runId,
        workflowId: this.ctx.workflowId,
        agentKey: this.ctx.agentKey,
        tool,
        outcome: 'succeeded',
        deniedReason: null,
        errorCode: null,
        argsSummary: summarize(parsed),
        resultSummary: opts.summarizeResult ? summarize(opts.summarizeResult(result)) : {},
        durationMs: Date.now() - started,
      })
      return result
    } catch (err) {
      const e = toAgentError(err)
      await this.recorder
        .recordToolCall(this.ctx.orgId, {
          runId: this.ctx.runId,
          workflowId: this.ctx.workflowId,
          agentKey: this.ctx.agentKey,
          tool,
          outcome: 'failed',
          deniedReason: null,
          errorCode: e.code,
          argsSummary: summarize(parsed),
          resultSummary: {},
          durationMs: Date.now() - started,
        })
        .catch(() => undefined)
      throw e
    }
  }
}
