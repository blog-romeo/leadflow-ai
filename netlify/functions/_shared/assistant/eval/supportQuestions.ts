import type { Dataset } from '../../agents/training/datasets/types'

/**
 * Domande di clienti SINTETICHE per valutare il chatbot di assistenza (Prompt 13).
 * expected = articolo che una persona dello staff indicherebbe; null = la documentazione non copre la domanda
 * (il bot deve astenersi e proporre una persona). Etichette scritte a mano prima di eseguire la valutazione.
 */
/** alt = altri articoli che rispondono altrettanto bene (es. domande sul prezzo: beta gratuita o piani). */
export interface SupportCase { id: string; q: string; audience: 'public' | 'app'; expected: string | null; alt?: string[] }
const c = (id: string, q: string, expected: string | null, audience: 'public' | 'app' = 'app', alt?: string[]): SupportCase => ({ id, q, audience, expected, ...(alt ? { alt } : {}) })

export const supportQuestionsV1: Dataset<SupportCase> = {
  id: 'support_chat',
  version: '1.0.0',
  task: 'support_retrieval',
  synthetic: true,
  notice: 'Domande inventate dal team, in italiano e inglese, per utenti dell’app e visitatori del sito.',
  splits: {
    train: [
      c('sq-tr-01', 'Quanto costa usare LeadFlow?', 'free-beta', 'public', ['plans']),
      c('sq-tr-02', 'Come faccio a trovare nuove aziende nella mia città?', 'lead-finder-search'),
      c('sq-tr-03', 'Ho dimenticato la password', 'login-password', 'public'),
      c('sq-tr-04', 'Posso invitare un collega nel mio account?', 'team'),
      c('sq-tr-05', 'Come disdico l abbonamento?', 'payment-cancel'),
      c('sq-tr-06', 'Cosa sono i crediti AI?', 'credits'),
      c('sq-tr-07', 'Come esporto i miei lead in excel?', 'lead-import-export'),
      c('sq-tr-08', 'I miei dati sono al sicuro?', 'privacy-data', 'public'),
      c('sq-tr-09', 'Voglio parlare con un operatore', 'contact-human'),
      c('sq-tr-10', 'Come approvo il salvataggio dei lead proposti dal workflow?', 'ai-workflows'),
      c('sq-tr-11', 'Gli agenti mandano email da soli?', 'ai-agents'),
      c('sq-tr-12', 'Come elimino il mio account?', 'account-deletion'),
      c('sq-tr-13', 'Posso rivendere la piattaforma con il mio marchio?', 'white-label', 'public'),
      c('sq-tr-14', 'Che tempo fa domani a Roma?', null, 'public'),
      c('sq-tr-15', 'Avete un integrazione con Salesforce?', 'not-available'),
      c('sq-tr-16', 'How do I reset my password?', 'login-password', 'public'),
      c('sq-tr-17', 'Come funziona il punteggio dei lead?', 'lead-scoring'),
      c('sq-tr-18', 'Mi consigli un buon ristorante?', null, 'public'),
      c('sq-tr-19', 'Come apro un ticket di assistenza?', 'support'),
      c('sq-tr-20', 'Cos e LeadFlow AI?', 'what-is-leadflow', 'public'),
    ],
    validation: [
      c('sq-va-01', 'Serve la carta di credito per la beta?', 'free-beta', 'public'),
      c('sq-va-02', 'Cerco hotel a Milano, come faccio?', 'lead-finder-search'),
      c('sq-va-03', 'Non riesco ad accedere, non ricordo le credenziali', 'login-password', 'public'),
      c('sq-va-04', 'Quanti utenti posso aggiungere al team?', 'team'),
      c('sq-va-05', 'Voglio annullare il piano a pagamento', 'payment-cancel'),
      c('sq-va-06', 'Cosa succede quando finiscono i crediti?', 'credits'),
      c('sq-va-07', 'Posso importare un file CSV di contatti?', 'lead-import-export'),
      c('sq-va-08', 'Rispettate il GDPR?', 'privacy-data', 'public'),
      c('sq-va-09', 'Posso parlare con una persona vera?', 'contact-human', 'public'),
      c('sq-va-10', 'Come interrompo un workflow in corso?', 'ai-workflows'),
      c('sq-va-11', 'Cosa fa il Research Agent?', 'ai-agents'),
      c('sq-va-12', 'Vorrei chiudere l organizzazione e cancellare i dati', 'account-deletion'),
      c('sq-va-13', 'Programma rivenditori white label', 'white-label', 'public'),
      c('sq-va-14', 'Qual è la capitale della Francia?', null, 'public'),
      c('sq-va-15', 'Si collega a WhatsApp?', 'not-available'),
      c('sq-va-16', 'What does LeadFlow AI do?', 'what-is-leadflow', 'public'),
      c('sq-va-17', 'Il feedback addestra il modello?', 'ai-feedback-memory'),
      c('sq-va-18', 'Scrivimi una poesia', null, 'public'),
      c('sq-va-19', 'Come invio una campagna email?', 'campaigns'),
      c('sq-va-20', 'Come si usa la pipeline del CRM?', 'crm-pipeline'),
    ],
    test: [
      c('sq-te-01', 'La beta è gratis?', 'free-beta', 'public'),
      c('sq-te-02', 'Come cerco potenziali clienti nel settore dentisti?', 'lead-finder-search'),
      c('sq-te-03', 'Non mi arriva l email di conferma della registrazione', 'login-password', 'public'),
      c('sq-te-04', 'Come aggiungo un collaboratore come amministratore?', 'team'),
      c('sq-te-05', 'Se disdico perdo subito l accesso?', 'payment-cancel'),
      c('sq-te-06', 'Quanti crediti consuma un analisi?', 'credits'),
      c('sq-te-07', 'Esportare i contatti in CSV', 'lead-import-export'),
      c('sq-te-08', 'Altre aziende possono vedere i miei lead?', 'privacy-data', 'public'),
      c('sq-te-09', 'Vorrei parlare con qualcuno dell assistenza', 'contact-human', 'public'),
      c('sq-te-10', 'Posso esportare i risultati di un workflow AI?', 'ai-workflows'),
      c('sq-te-11', 'Gli agenti possono modificare i pagamenti?', 'ai-agents'),
      c('sq-te-12', 'How can I delete my account?', 'account-deletion'),
      c('sq-te-13', 'Offrite un programma per agenzie con il proprio marchio?', 'white-label', 'public'),
      c('sq-te-14', 'Chi ha vinto il campionato?', null, 'public'),
      c('sq-te-15', 'Esiste un API pubblica?', 'not-available'),
      c('sq-te-16', 'Is there a free plan?', 'free-beta', 'public', ['plans']),
      c('sq-te-17', 'Come miglioro le risposte degli agenti con i miei esempi?', 'ai-feedback-memory'),
      c('sq-te-18', 'Raccontami una barzelletta', null, 'public'),
      c('sq-te-19', 'Come vedo lo stato del mio ticket?', 'support'),
      c('sq-te-20', 'Cosa analizza il Business Analyzer?', 'business-analyzer'),
    ],
  },
}
