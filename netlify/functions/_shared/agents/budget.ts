import { AgentError } from './errors'
import type { AgentKey } from './types'

/**
 * Budget dei workflow. Tre limiti indipendenti, tutti in crediti AI:
 *  • budget del workflow (scelto all'avvio, immutabile);
 *  • budget mensile dell'organizzazione per gli agenti (ai_agents.orchestrator.monthly_credit_budget);
 *  • budget mensile e per esecuzione del singolo agente (ai_agents.<agente>).
 * A questi si aggiungono, nel database, i crediti del piano (trigger su ai_jobs) e i tetti di spesa in USD
 * del Control Center: il budget degli agenti non può mai superarli.
 *
 * Il costo di un'operazione è letto da ai_credit_costs (nessun valore nel codice). Il controllo avviene
 * PRIMA di ogni operazione: se l'operazione farebbe superare un limite, non viene eseguita.
 */
export interface BudgetLimits {
  workflowBudget: number
  workflowUsed: number
  orgMonthlyBudget: number | null
  orgMonthlyUsed: number
  agentMonthly: Partial<Record<AgentKey, { budget: number | null; used: number }>>
  perRunMax: Partial<Record<AgentKey, number | null>>
}

export type BudgetDenial = 'workflow_budget_exceeded' | 'org_agent_budget_exceeded' | 'agent_budget_exceeded' | 'run_budget_exceeded'

export class BudgetTracker {
  private runUsed: Partial<Record<AgentKey, number>> = {}
  private spentNow = 0

  constructor(private limits: BudgetLimits) {}

  get workflowUsed(): number {
    return this.limits.workflowUsed
  }

  get workflowRemaining(): number {
    return Math.max(this.limits.workflowBudget - this.limits.workflowUsed, 0)
  }

  /** Crediti spesi in questa invocazione (per i test e il report). */
  get spentInInvocation(): number {
    return this.spentNow
  }

  check(agent: AgentKey, credits: number): BudgetDenial | null {
    if (credits <= 0) return null
    if (this.limits.workflowUsed + credits > this.limits.workflowBudget) return 'workflow_budget_exceeded'
    if (this.limits.orgMonthlyBudget !== null && this.limits.orgMonthlyUsed + credits > this.limits.orgMonthlyBudget) return 'org_agent_budget_exceeded'
    const a = this.limits.agentMonthly[agent]
    if (a && a.budget !== null && a.used + credits > a.budget) return 'agent_budget_exceeded'
    const runMax = this.limits.perRunMax[agent]
    if (runMax !== null && runMax !== undefined && (this.runUsed[agent] ?? 0) + credits > runMax) return 'run_budget_exceeded'
    return null
  }

  /** Verifica e impegna: lancia AgentError(stopWorkflow) se un limite verrebbe superato. */
  reserve(agent: AgentKey, credits: number): void {
    const denial = this.check(agent, credits)
    if (denial) {
      throw new AgentError(denial, { stopWorkflow: true, details: { credits, workflow_used: this.limits.workflowUsed, workflow_budget: this.limits.workflowBudget } })
    }
    this.apply(agent, credits)
  }

  /** Restituisce crediti impegnati per un'operazione fallita (i crediti del piano sono rimborsati dal trigger). */
  refund(agent: AgentKey, credits: number): void {
    this.apply(agent, -credits)
  }

  private apply(agent: AgentKey, credits: number) {
    this.limits.workflowUsed = Math.max(this.limits.workflowUsed + credits, 0)
    this.limits.orgMonthlyUsed = Math.max(this.limits.orgMonthlyUsed + credits, 0)
    const a = this.limits.agentMonthly[agent]
    if (a) a.used = Math.max(a.used + credits, 0)
    this.runUsed[agent] = Math.max((this.runUsed[agent] ?? 0) + credits, 0)
    this.spentNow += credits
  }

  resetRun(agent: AgentKey): void {
    this.runUsed[agent] = 0
  }
}
