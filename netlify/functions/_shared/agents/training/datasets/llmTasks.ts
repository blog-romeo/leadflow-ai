import type { Dataset } from './types'

/**
 * Compiti che richiedono un MODELLO reale (analisi commerciale, personalizzazione, strategia di vendita).
 * Il benchmark di questi compiti NON viene eseguito senza credenziali e senza approvazione dei costi: il
 * risultato è "not_executed". I contesti sono sintetici; i criteri attesi sono verificabili sull'output
 * (JSON valido, FACT solo con estratto presente nel contesto, astensione quando i dati mancano).
 */
export interface LlmCase { id: string; context: string; expectFactsAllowed: boolean; mustMention?: string[] }

export const llmTasksV1: Dataset<LlmCase> = {
  id: 'llm_strategy',
  version: '1.0.0',
  task: 'sales_strategy_generation',
  synthetic: true,
  notice: 'Contesti sintetici per la valutazione live dei modelli (non eseguita senza credenziali).',
  splits: {
    train: [{ id: 'lt-tr-01', context: 'Hotel Esempio, Roma. Dal sito: "Per prenotare scrivete una email alla reception."', expectFactsAllowed: true, mustMention: ['email'] }],
    validation: [{ id: 'lt-va-01', context: 'B&B Esempio, Roma. Nessun sito disponibile. Nessun dato sulle prenotazioni.', expectFactsAllowed: false }],
    test: [
      { id: 'lt-te-01', context: 'Hotel Prova, Roma. Dal sito: "Prenotazioni solo telefoniche dalle 9 alle 18."', expectFactsAllowed: true, mustMention: ['telefon'] },
      { id: 'lt-te-02', context: 'Albergo Prova, Roma. Il sito non è raggiungibile.', expectFactsAllowed: false },
    ],
  },
}
