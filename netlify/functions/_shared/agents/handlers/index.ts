import type { StepHandler } from '../engine'
import type { StepAction } from '../types'
import { discoveryHandler } from './discovery'
import { researchHandler } from './research'
import { scoringHandler } from './scoring'
import { saveLeadsHandler } from './saveLeads'
import { strategyHandler } from './strategy'
import { followUpAnalyzeHandler, followUpApplyHandler } from './followUp'
import { growthHandler } from './growth'

/** Azioni eseguibili dai workflow: ogni azione appartiene a un solo agente (verificato dal motore). */
export const HANDLERS: Record<StepAction, StepHandler> = {
  discover: discoveryHandler,
  research: researchHandler,
  score: scoringHandler,
  'crm.save_leads': saveLeadsHandler,
  strategy: strategyHandler,
  'follow_up.analyze': followUpAnalyzeHandler,
  'follow_up.apply': followUpApplyHandler,
  'growth.analyze': growthHandler,
}
