import { discoveryV1 } from './datasets/discovery'
import { injectionV1 } from './datasets/injection'
import { leadScoringV2 } from './datasets/leadScoring'
import { llmTasksV1 } from './datasets/llmTasks'
import { outputReviewV1 } from './datasets/outputReview'
import { providerErrorsV1 } from './datasets/providerErrors'
import { sectorClassificationV1 } from './datasets/sectorClassification'
import type { Dataset } from './datasets/types'
import { supportQuestionsV1 } from '../../assistant/eval/supportQuestions'

/**
 * Catalogo dei dataset (Prompt 12): solo metadati (nessun contenuto) per la dashboard e i report.
 * `technique` indica a quale delle cinque tecniche serve il dataset:
 *   A prompt optimization · B retrieval/memoria · C few-shot · D fine-tuning reale · E model evaluation.
 * Nessun dataset è usato per fine-tuning (D): il fine-tuning non è implementato né avviato.
 */
const all: [Dataset<unknown>, string, string[]][] = [
  [sectorClassificationV1 as Dataset<unknown>, 'Discovery', ['E', 'A (regole: sinonimi)']],
  [discoveryV1 as Dataset<unknown>, 'Discovery', ['E']],
  [providerErrorsV1 as Dataset<unknown>, 'Discovery', ['E']],
  [leadScoringV2 as Dataset<unknown>, 'Scoring', ['E', 'A (regole: pesi)']],
  [outputReviewV1 as Dataset<unknown>, 'Quality Reviewer', ['E']],
  [injectionV1 as Dataset<unknown>, 'Sicurezza', ['E']],
  [supportQuestionsV1 as Dataset<unknown>, 'Customer Service chatbot', ['B (retrieval)', 'E', 'A (regole: sinonimi, soglia)']],
  [llmTasksV1 as Dataset<unknown>, 'Strategy (modello reale)', ['E — non eseguito senza credenziali']],
]

export const DATASETS = all.map(([d, agent, technique]) => ({
  id: d.id,
  version: d.version,
  task: d.task,
  agent,
  technique,
  synthetic: d.synthetic,
  splits: { train: d.splits.train.length, validation: d.splits.validation.length, test: d.splits.test.length },
}))
