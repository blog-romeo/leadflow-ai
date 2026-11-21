import { randomUUID } from 'node:crypto'
import { log } from '../log'
import type { LeadFinderStore } from '../lead-finder/store'
import type { SalesStore } from '../sales-agent/store'
import type { ProviderAdapter } from '../lead-finder/types'
import type { SearchProviderId } from '../lead-finder/providers/registry'
import type { BillingGate } from '../billing/store'
import type { analyzeCompany } from '../lead-finder/analysis/analyzer'
import type { AiCaller } from '../sales-agent/service'
import { AGENTS } from './catalog'
import { BudgetTracker } from './budget'
import { AgentError, CancelledSignal, YieldSignal, toAgentError } from './errors'
import { agentsEnabledFor } from './flags'
import { buildEnvelope, validateActionOutput } from './envelope'
import { DEFAULT_BLOCKING, reviewStep, reviewSummary, type ReviewCode } from './reviewer'
import { buildReport } from './report'
import type { AgentStore } from './store'
import { ToolGateway } from './tools'
import type { AgentConfig, AgentKey, CostWrite, StepAction, StepRecord, StepStatus, WorkflowRecord, WorkflowStatus } from './types'

/**
 * LeadFlow AI Orchestrator — esecutore dei workflow.
 *
 * Garanzie:
 * • Un solo esecutore per workflow (lease con token; un secondo esecutore trova il lease attivo ed esce).
 * • Idempotenza: un passo completato non viene rieseguito; un passo interrotto riprende dal punto di
 *   controllo salvato (gli elementi già elaborati non vengono ripetuti né riaddebitati).
 * • Retry controllati solo per errori temporanei, con attesa crescente e numero massimo di tentativi.
 * • Timeout per passo e scadenza complessiva del workflow; l'invocazione cede il controllo prima del
 *   limite della piattaforma e riprende in una nuova invocazione.
 * • Interruzione dell'utente verificata a ogni punto di controllo.
 * • Le operazioni ad alto impatto si eseguono solo dopo un'approvazione letta dal database (non dal
 *   contenuto del passo, che potrebbe essere alterato).
 * • Budget verificato prima di ogni operazione a pagamento.
 */
export interface AgentServices {
  leadFinder: LeadFinderStore
  sales: SalesStore
  registry: Record<SearchProviderId, ProviderAdapter>
  billing?: BillingGate
  /** Solo test: analisi AI simulata. In produzione si usa l'Analyzer esistente. */
  analyze?: typeof analyzeCompany
  /** Solo test: chiamata AI simulata. In produzione si usa la Responses API di OpenAI. */
  ai?: AiCaller
}

export interface StepContext {
  orgId: string
  /** Utente che ha avviato il workflow (attore delle scritture e dei job AI). */
  userId: string
  workflow: WorkflowRecord
  step: StepRecord
  runId: string
  attempt: number
  approvalId: string | null
  /** Riepilogo dell'approvazione letto dal database (null se il passo non richiede approvazione). */
  approvalSummary: Record<string, unknown> | null
  tools: ToolGateway
  budget: BudgetTracker
  config: AgentConfig
  creditCosts: Record<string, number>
  env: NodeJS.ProcessEnv
  services: AgentServices
  store: AgentStore
  /** Avanzamento salvato dal tentativo precedente (ripresa). */
  progress: Record<string, unknown>
  prior(position: number): Record<string, unknown> | null
  priorStatus(position: number): StepStatus | undefined
  /** Salva l'avanzamento, rinnova il lease e verifica interruzione, scadenze e tempo dell'invocazione. */
  checkpoint(progress: Record<string, unknown>): Promise<void>
  recordCost(row: Omit<CostWrite, 'workflowId' | 'runId' | 'agentKey'>): Promise<void>
  now(): Date
}

export interface StepResult {
  output: Record<string, unknown>
  itemsTotal: number
  itemsFailed: number
  /** true se il passo è riuscito solo in parte (alcuni elementi falliti o saltati per limiti). */
  partial?: boolean
  model?: string | null
  tokensInput?: number
  tokensOutput?: number
}

export interface StepHandler {
  agent: AgentKey
  /** Riepilogo per l'approvazione; null = nulla da approvare (il passo viene saltato). */
  prepareApproval?(ctx: StepContext): Promise<{ action: string; summary: Record<string, unknown> } | null>
  run(ctx: StepContext): Promise<StepResult>
}

export interface EngineDeps {
  store: AgentStore
  services: AgentServices
  handlers: Record<StepAction, StepHandler>
  env?: NodeJS.ProcessEnv
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** Tempo massimo di lavoro per invocazione (le background function Netlify durano al massimo 15 minuti). */
  maxWallMs?: number
  leaseSeconds?: number
  /** Avvia un'invocazione successiva per proseguire il workflow. */
  continueLater?: (workflowId: string) => Promise<boolean>
  /** Prompt 12: codici del Quality Reviewer che bloccano il passo (da una configurazione approvata). */
  reviewerBlocking?: readonly ReviewCode[]
}

export const DEFAULT_MAX_WALL_MS = 11 * 60_000
export const MAX_RESUMES = 20
const APPROVAL_TTL_HOURS = 72
const OK_SKIPS = new Set(['nothing_to_approve', 'nothing_to_do'])
/** Attesa massima tra due tentativi (anche se il servizio chiede di più: il passo fallisce e si riprende dopo). */
export const MAX_RETRY_DELAY_MS = 30_000

/**
 * Attesa prima di un nuovo tentativo: backoff esponenziale con jitter (evita tentativi sincronizzati di più
 * workflow) e rispetto di Retry-After / retry_after quando il servizio lo indica (rate limit).
 */
export function retryDelayMs(attempt: number, details: Record<string, unknown> | undefined, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 15_000)
  const jittered = Math.round(base / 2 + random() * (base / 2))
  const raw = details?.retry_after_ms ?? (typeof details?.retry_after === 'number' ? (details.retry_after as number) * 1000 : undefined)
  const hinted = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
  return Math.min(Math.max(jittered, hinted), MAX_RETRY_DELAY_MS)
}

function defaultConfig(agent: AgentKey): AgentConfig {
  return { agentKey: agent, enabled: true, modelTier: AGENTS[agent].defaultTier, monthlyCreditBudget: null, maxCreditsPerRun: null, config: {} }
}

function monthStart(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/** Stato finale in base all'esito dei passi. */
export function finalStatus(steps: StepRecord[], cancelled: boolean): WorkflowStatus {
  if (cancelled) return 'cancelled'
  const ok = (s: StepRecord) => (s.status === 'completed' && !s.output?.partial) || (s.status === 'skipped' && OK_SKIPS.has(s.errorCode ?? ''))
  if (steps.length > 0 && steps.every(ok)) return 'completed'
  const anyResult = steps.some((s) => s.status === 'completed' || (s.output && Object.keys(s.output).length > 0 && s.status === 'failed'))
  return anyResult ? 'partial' : 'failed'
}

export async function runWorkflow(deps: EngineDeps, workflowId: string): Promise<{ status: WorkflowStatus | 'skipped' | 'yielded' }> {
  // Prompt 10: conteggio delle chiamate allo store (≈ query a Supabase) per invocazione, per misurare in
  // staging se il costo dei checkpoint (Prompt 9: 476 chiamate per 30 aziende, in processo) si ripresenta.
  const storeCalls: Record<string, number> = {}
  const store: AgentStore = new Proxy(deps.store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        storeCalls[String(prop)] = (storeCalls[String(prop)] ?? 0) + 1
        return (v as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  const invocationStats = () => {
    const total = Object.values(storeCalls).reduce((a, b) => a + b, 0)
    const top = Object.entries(storeCalls).sort((a, b) => b[1] - a[1]).slice(0, 6)
    return { store_calls: total, store_calls_top: Object.fromEntries(top), invocation_ms: Date.now() - invocationStart }
  }
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const leaseSeconds = deps.leaseSeconds ?? 180
  const maxWallMs = deps.maxWallMs ?? DEFAULT_MAX_WALL_MS
  const token = randomUUID()
  const invocationStart = Date.now()

  const claimed = await store.claimWorkflow(workflowId, token, leaseSeconds)
  if (!claimed) return { status: 'skipped' }
  let wf: WorkflowRecord = claimed
  const org = wf.organizationId
  let costUsd = wf.costUsd

  const finalize = async (status: WorkflowStatus, errorCode: string | null): Promise<{ status: WorkflowStatus }> => {
    const steps = await store.getSteps(org, wf.id)
    for (const s of steps) {
      if (s.status === 'pending' || s.status === 'running' || s.status === 'waiting_approval') {
        await store.updateStep(org, s.id, { status: status === 'cancelled' ? 'cancelled' : 'skipped', errorCode: errorCode ?? 'workflow_stopped', completedAt: now().toISOString() })
      }
    }
    const finalSteps = await store.getSteps(org, wf.id)
    const report = { ...buildReport({ ...wf, costUsd }, finalSteps, status, errorCode), perf_last_invocation: invocationStats() }
    await store.releaseWorkflow(org, wf.id, token, { status, errorCode, report, completedAt: now().toISOString(), creditsUsed: wf.creditsUsed, costUsd })
    log('info', 'ai_workflow.finished', { workflow_id: wf.id, status, error_code: errorCode, credits_used: wf.creditsUsed, ...invocationStats() })
    return { status }
  }

  if (!agentsEnabledFor(org, env)) return finalize('failed', 'feature_disabled')
  if (wf.cancelRequestedAt) return finalize('cancelled', 'cancelled_by_user')
  if (wf.resumeCount > MAX_RESUMES) return finalize(finalStatus(await store.getSteps(org, wf.id), false) === 'failed' ? 'failed' : 'partial', 'too_many_resumes')
  if (!wf.startedAt) {
    const startedAt = now()
    const deadline = new Date(startedAt.getTime() + wf.maxRuntimeSeconds * 1000).toISOString()
    await store.updateWorkflow(org, wf.id, token, { startedAt: startedAt.toISOString(), deadlineAt: deadline })
    wf = { ...wf, startedAt: startedAt.toISOString(), deadlineAt: deadline }
  }

  // Configurazione, costi in crediti e spesa del mese: base per il budget.
  const [configs, creditCosts, spend] = await Promise.all([store.getAgentConfigs(org), store.getCreditCosts(), store.getMonthlySpend(org, monthStart(now()))])
  const cfg = (k: AgentKey): AgentConfig => configs.find((c) => c.agentKey === k) ?? defaultConfig(k)
  const budget = new BudgetTracker({
    workflowBudget: wf.budgetCredits,
    workflowUsed: wf.creditsUsed,
    orgMonthlyBudget: cfg('orchestrator').monthlyCreditBudget,
    orgMonthlyUsed: spend.credits,
    agentMonthly: Object.fromEntries(configs.map((c) => [c.agentKey, { budget: c.monthlyCreditBudget, used: spend.byAgent[c.agentKey] ?? 0 }])),
    perRunMax: Object.fromEntries(configs.map((c) => [c.agentKey, c.maxCreditsPerRun])),
  })

  const persistUsage = async () => {
    wf = { ...wf, creditsUsed: budget.workflowUsed, costUsd }
    await store.updateWorkflow(org, wf.id, token, { creditsUsed: budget.workflowUsed, costUsd })
  }

  for (;;) {
    if (await store.isCancelRequested(org, wf.id)) return finalize('cancelled', 'cancelled_by_user')
    if (wf.deadlineAt && now().getTime() > new Date(wf.deadlineAt).getTime()) {
      return finalize(finalStatus(await store.getSteps(org, wf.id), false) === 'failed' ? 'failed' : 'partial', 'workflow_timeout')
    }
    const steps = await store.getSteps(org, wf.id)
    const byPos = new Map(steps.map((s) => [s.position, s]))
    let ready: StepRecord | null = null
    for (const s of steps) {
      if (!['pending', 'running'].includes(s.status)) continue
      const depSteps = s.dependsOn.map((p) => byPos.get(p))
      if (depSteps.some((d) => !d || ['failed', 'cancelled'].includes(d.status) || (d.status === 'skipped' && !OK_SKIPS.has(d.errorCode ?? '')))) {
        await store.updateStep(org, s.id, { status: 'skipped', errorCode: 'dependency_not_completed', completedAt: now().toISOString() })
        // Aggiorna anche la copia locale: i passi successivi della stessa scansione vedono il salto
        // (prima del Prompt 9 una catena di ≥2 dipendenti finiva in 'dependency_deadlock').
        s.status = 'skipped'
        s.errorCode = 'dependency_not_completed'
        continue
      }
      if (depSteps.every((d) => d!.status === 'completed' || (d!.status === 'skipped' && OK_SKIPS.has(d!.errorCode ?? '')))) {
        ready = s
        break
      }
    }
    if (!ready) {
      const fresh = await store.getSteps(org, wf.id)
      if (fresh.some((s) => s.status === 'waiting_approval')) {
        await store.releaseWorkflow(org, wf.id, token, { status: 'waiting_approval', creditsUsed: budget.workflowUsed, costUsd })
        return { status: 'waiting_approval' }
      }
      if (fresh.some((s) => s.status === 'pending' || s.status === 'running')) {
        // Dipendenze in attesa che non possono progredire: stato incoerente, si chiude in sicurezza.
        return finalize('failed', 'dependency_deadlock')
      }
      return finalize(finalStatus(fresh, false), null)
    }

    const step = ready
    const agentCfg = cfg(step.agentKey)
    const handler = deps.handlers[step.action]
    if (!handler || handler.agent !== step.agentKey) {
      await store.updateStep(org, step.id, { status: 'failed', errorCode: 'unknown_action', completedAt: now().toISOString() })
      continue
    }
    if (!agentCfg.enabled) {
      await store.updateStep(org, step.id, { status: 'skipped', errorCode: 'agent_disabled', completedAt: now().toISOString() })
      continue
    }

    // ── Approvazione esplicita ────────────────────────────────────────────
    let approvalId: string | null = null
    let approvalSummary: Record<string, unknown> | null = null
    if (step.requiresApproval) {
      const requested = typeof step.input.approval_id === 'string' ? step.input.approval_id : null
      if (!requested) {
        const ctxPre = makeContext(step, steps, null, 0, null, null, { aborted: false })
        const prep = handler.prepareApproval ? await handler.prepareApproval(ctxPre) : null
        if (!prep) {
          await store.updateStep(org, step.id, { status: 'skipped', errorCode: 'nothing_to_approve', completedAt: now().toISOString() })
          continue
        }
        const id = await store.createApproval({ org, workflowId: wf.id, stepId: step.id, action: prep.action, summary: prep.summary, expiresHours: APPROVAL_TTL_HOURS })
        await store.updateStep(org, step.id, { status: 'waiting_approval', output: { approval_id: id, summary: prep.summary } })
        await store.releaseWorkflow(org, wf.id, token, { status: 'waiting_approval', creditsUsed: budget.workflowUsed, costUsd })
        log('info', 'ai_workflow.waiting_approval', { workflow_id: wf.id, step: step.position, action: prep.action, ...invocationStats() })
        return { status: 'waiting_approval' }
      }
      // L'approvazione si verifica nel database: id, passo, organizzazione e stato devono coincidere.
      const approval = await store.getApproval(org, requested)
      if (!approval || approval.status !== 'approved' || approval.stepId !== step.id || approval.workflowId !== wf.id) {
        await store.updateStep(org, step.id, { status: 'failed', errorCode: 'approval_invalid', completedAt: now().toISOString() })
        continue
      }
      approvalId = approval.id
      approvalSummary = approval.summary
    }

    // ── Esecuzione con tentativi controllati ──────────────────────────────
    let attempt = step.attempts
    let outcome: 'next' | 'stop' = 'next'
    for (;;) {
      attempt++
      if (attempt > step.maxAttempts) {
        await store.updateStep(org, step.id, { status: 'failed', errorCode: 'max_attempts_exceeded', completedAt: now().toISOString() })
        break
      }
      await store.updateStep(org, step.id, { status: 'running', attempts: attempt, startedAt: now().toISOString() })
      const runId = await store.createRun({ org, workflowId: wf.id, stepId: step.id, agentKey: step.agentKey, attempt, inputSummary: { action: step.action, position: step.position }, createdBy: wf.createdBy })
      budget.resetRun(step.agentKey)
      const timer = { aborted: false }
      const ctx = makeContext(step, steps, runId, attempt, approvalId, approvalSummary, timer)
      const creditsBefore = budget.workflowUsed
      const costBefore = costUsd
      const runStartedAt = now()
      const envelopeFor = (status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timed_out', output: Record<string, unknown> | null, outputValid: boolean, errorCode: string | null, r?: StepResult) =>
        buildEnvelope({
          workflowId: wf.id,
          organizationId: org,
          runId,
          agentKey: step.agentKey,
          action: step.action,
          position: step.position,
          attempt,
          status,
          params: wf.params,
          dependsOn: step.dependsOn,
          approvalId,
          output,
          outputValid,
          errorCode,
          tokensInput: r?.tokensInput ?? 0,
          tokensOutput: r?.tokensOutput ?? 0,
          credits: budget.workflowUsed - creditsBefore,
          costUsd: costUsd !== costBefore ? Math.round((costUsd - costBefore) * 1e6) / 1e6 : null,
          model: r?.model ?? null,
          tier: typeof output?.model_tier === 'string' ? output.model_tier : null,
          fallback: output?.model_fallback === true,
          itemsTotal: r?.itemsTotal ?? 0,
          itemsFailed: r?.itemsFailed ?? 0,
          startedAt: runStartedAt,
          completedAt: now(),
        })
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          handler.run(ctx),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              timer.aborted = true
              reject(new AgentError('step_timeout', { retryable: true }))
            }, step.timeoutSeconds * 1000)
          }),
        ])
        clearTimeout(timeoutHandle)
        // Contratto tra agenti: l'output deve rispettare lo schema dell'azione, altrimenti non viene passato
        // ai passi successivi. Errore permanente (nessun retry: eviterebbe un secondo consumo di crediti).
        const valid = validateActionOutput(step.action, result.output)
        if (!valid.ok) {
          log('error', 'ai_workflow.invalid_agent_output', { workflow_id: wf.id, step: step.position, issues: valid.issues })
          const envelope = envelopeFor('failed', null, false, 'invalid_agent_output', result)
          await store.finishRun(org, runId, {
            status: 'failed',
            output: { ...envelope, validation_issues: valid.issues },
            errorCode: 'invalid_agent_output',
            itemsTotal: result.itemsTotal,
            itemsFailed: result.itemsTotal,
            creditsUsed: envelope.usage.credits,
            tokensInput: envelope.usage.tokens_input,
            tokensOutput: envelope.usage.tokens_output,
            costUsd: envelope.usage.cost_usd,
            model: result.model ?? null,
          })
          await store.updateStep(org, step.id, { status: 'failed', errorCode: 'invalid_agent_output', completedAt: now().toISOString() })
          await persistUsage()
          break
        }
        // Quality Reviewer (Prompt 12): validazione logica deterministica dell'output.
        const researchOut = steps.find((x) => x.action === 'research' && x.status === 'completed')?.output ?? null
        const saveOut = steps.find((x) => x.action === 'crm.save_leads' && x.status === 'completed')?.output ?? null
        const leadToCandidate: Record<string, string> = {}
        for (const r of (Array.isArray(saveOut?.results) ? saveOut.results : []) as { candidate_id?: string; lead_id?: string }[]) if (r.lead_id && r.candidate_id) leadToCandidate[r.lead_id] = r.candidate_id
        const review = reviewStep(step.action, result.output, { research: researchOut, leadToCandidate }, deps.reviewerBlocking ?? DEFAULT_BLOCKING)
        result.output = { ...result.output, review: { ...reviewSummary(review), items: review.findings.slice(0, 30) } }
        if (review.blocking.length > 0) {
          log('error', 'ai_workflow.review_blocked', { workflow_id: wf.id, step: step.position, codes: review.blocking.map((b) => b.code) })
          const envelope = envelopeFor('failed', result.output, true, 'review_blocked', result)
          await store.finishRun(org, runId, { status: 'failed', output: envelope, errorCode: 'review_blocked', itemsTotal: result.itemsTotal, itemsFailed: result.itemsTotal, creditsUsed: envelope.usage.credits, tokensInput: envelope.usage.tokens_input, tokensOutput: envelope.usage.tokens_output, costUsd: envelope.usage.cost_usd, model: result.model ?? null })
          await store.updateStep(org, step.id, { status: 'failed', output: { review: result.output.review }, errorCode: 'review_blocked', completedAt: now().toISOString() })
          await persistUsage()
          break
        }
        const partial = !!result.partial || (result.itemsFailed > 0 && result.itemsFailed < result.itemsTotal)
        const allFailed = result.itemsTotal > 0 && result.itemsFailed >= result.itemsTotal
        const runStatus = allFailed ? 'failed' : partial ? 'partial' : 'succeeded'
        const envelope = envelopeFor(runStatus, result.output, true, allFailed ? 'all_items_failed' : null, result)
        await store.finishRun(org, runId, {
          status: runStatus,
          output: envelope,
          errorCode: allFailed ? 'all_items_failed' : null,
          itemsTotal: result.itemsTotal,
          itemsFailed: result.itemsFailed,
          creditsUsed: envelope.usage.credits,
          tokensInput: envelope.usage.tokens_input,
          tokensOutput: envelope.usage.tokens_output,
          costUsd: envelope.usage.cost_usd,
          model: result.model ?? null,
        })
        await store.updateStep(org, step.id, {
          status: allFailed ? 'failed' : 'completed',
          output: { ...result.output, ...(partial ? { partial: true } : {}) },
          errorCode: allFailed ? 'all_items_failed' : null,
          completedAt: now().toISOString(),
        })
        await persistUsage()
        break
      } catch (err) {
        clearTimeout(timeoutHandle)
        timer.aborted = true
        if (err instanceof CancelledSignal) {
          await store.finishRun(org, runId, { status: 'cancelled', output: envelopeFor('cancelled', null, false, 'cancelled_by_user'), errorCode: 'cancelled_by_user', creditsUsed: budget.workflowUsed - creditsBefore })
          await persistUsage()
          return finalize('cancelled', 'cancelled_by_user')
        }
        if (err instanceof YieldSignal) {
          // Il tentativo non viene conteggiato: riprende dal punto di controllo nella prossima invocazione.
          await store.finishRun(org, runId, { status: 'cancelled', output: envelopeFor('cancelled', null, false, 'yielded'), errorCode: 'yielded', creditsUsed: budget.workflowUsed - creditsBefore })
          await store.updateStep(org, step.id, { status: 'pending', attempts: attempt - 1 })
          await persistUsage()
          await store.releaseWorkflow(org, wf.id, token, { status: 'pending', resumeCount: wf.resumeCount + 1, creditsUsed: budget.workflowUsed, costUsd })
          if (deps.continueLater) await deps.continueLater(wf.id)
          return { status: 'yielded' }
        }
        const e = toAgentError(err)
        const timedOut = e.code === 'step_timeout'
        const failEnvelope = envelopeFor(timedOut ? 'timed_out' : 'failed', null, false, e.code)
        await store.finishRun(org, runId, { status: timedOut ? 'timed_out' : 'failed', output: failEnvelope, errorCode: e.code, creditsUsed: failEnvelope.usage.credits, costUsd: failEnvelope.usage.cost_usd })
        await persistUsage()
        log('warn', 'ai_workflow.step_failed', { workflow_id: wf.id, step: step.position, code: e.code, attempt })
        if (e.stopWorkflow) {
          await store.updateStep(org, step.id, { status: 'failed', errorCode: e.code, completedAt: now().toISOString() })
          const fresh = await store.getSteps(org, wf.id)
          await finalize(finalStatus(fresh, false) === 'failed' ? 'failed' : 'partial', e.code)
          outcome = 'stop'
          break
        }
        if (e.retryable && attempt < step.maxAttempts) {
          await store.updateStep(org, step.id, { status: 'pending', attempts: attempt, errorCode: e.code })
          await sleep(retryDelayMs(attempt, e.opts.details))
          continue
        }
        await store.updateStep(org, step.id, { status: 'failed', errorCode: e.code, completedAt: now().toISOString() })
        break
      }
    }
    if (outcome === 'stop') {
      const final = await store.getWorkflow(wf.id)
      return { status: final?.status ?? 'failed' }
    }
    if (Date.now() - invocationStart > maxWallMs) {
      await store.releaseWorkflow(org, wf.id, token, { status: 'pending', resumeCount: wf.resumeCount + 1, creditsUsed: budget.workflowUsed, costUsd })
      if (deps.continueLater) await deps.continueLater(wf.id)
      return { status: 'yielded' }
    }
  }

  // ── Contesto del passo ───────────────────────────────────────────────────
  function makeContext(step: StepRecord, stepsCache: StepRecord[], runId: string | null, attempt: number, approvalId: string | null, approvalSummary: Record<string, unknown> | null, timer: { aborted: boolean }): StepContext {
    const tools = new ToolGateway(store, { orgId: org, agentKey: step.agentKey, runId, workflowId: wf.id, approvalId })
    const ctx: StepContext = {
      orgId: org,
      userId: wf.createdBy ?? '00000000-0000-0000-0000-000000000000',
      workflow: wf,
      step,
      runId: runId ?? '',
      attempt,
      approvalId,
      approvalSummary,
      tools,
      budget,
      config: cfg(step.agentKey),
      creditCosts,
      env,
      services: deps.services,
      store,
      progress: (step.output as Record<string, unknown> | null)?.progress ? ((step.output as Record<string, unknown>).progress as Record<string, unknown>) : {},
      prior: (p) => stepsCache.find((s) => s.position === p && s.status === 'completed')?.output ?? null,
      priorStatus: (p) => stepsCache.find((s) => s.position === p)?.status,
      async checkpoint(progress) {
        if (timer.aborted) throw new AgentError('step_timeout', { retryable: true })
        await store.updateStep(org, step.id, { output: { progress } })
        if (store.heartbeat) {
          // Prompt 12: 1 operazione invece di 3 per checkpoint (misurato: −82 chiamate su 476 per 30 aziende).
          wf = { ...wf, creditsUsed: budget.workflowUsed, costUsd }
          const hb = await store.heartbeat(org, wf.id, token, leaseSeconds, { creditsUsed: budget.workflowUsed, costUsd })
          if (!hb.renewed) throw new AgentError('lease_lost', { stopWorkflow: false })
          if (hb.cancelRequested) throw new CancelledSignal()
        } else {
          await persistUsage()
          const renewed = await store.renewLease(org, wf.id, token, leaseSeconds)
          if (!renewed) throw new AgentError('lease_lost', { stopWorkflow: false })
          if (await store.isCancelRequested(org, wf.id)) throw new CancelledSignal()
        }
        if (wf.deadlineAt && now().getTime() > new Date(wf.deadlineAt).getTime()) throw new AgentError('workflow_timeout', { stopWorkflow: true })
        if (Date.now() - invocationStart > maxWallMs) throw new YieldSignal()
      },
      async recordCost(row) {
        if (row.costUsd !== null) costUsd = Math.round((costUsd + row.costUsd) * 1e6) / 1e6
        await store.recordCost(org, { ...row, workflowId: wf.id, runId, agentKey: step.agentKey })
      },
      now,
    }
    return ctx
  }
}
