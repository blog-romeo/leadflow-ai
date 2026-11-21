/**
 * BOZZE dei documenti legali. NON sono testi revisionati né dichiarati conformi.
 * Ogni dato mancante è un segnaposto "[DA COMPLETARE: …]" e la pagina mostra un avviso di bozza.
 * Prima del lancio commerciale vanno completati e verificati da un consulente legale/privacy
 * (vedi RELEASE_READINESS.md). I contenuti descrivono il funzionamento reale della piattaforma:
 * aggiornarli se cambiano fornitori, dati trattati o funzioni.
 */
import type { LegalPage } from '../components/public/PublicLayout'

export interface LegalSection {
  heading: string
  paragraphs: string[]
}
export interface LegalDoc {
  title: string
  updated: string
  intro?: string
  sections: LegalSection[]
}

const TITOLARE = '[DA COMPLETARE: ragione sociale del fornitore]'
const SEDE = '[DA COMPLETARE: indirizzo della sede legale]'
const PIVA = '[DA COMPLETARE: partita IVA / codice fiscale]'
const PRIVACY_EMAIL = '[DA COMPLETARE: email per le richieste privacy]'
const UPDATED = '[DA COMPLETARE: data di pubblicazione]'

/** Fornitori (sub-responsabili) realmente usati dal codice. Da confermare con i contratti. */
const SUBPROCESSORS = [
  'Supabase (database, autenticazione, archiviazione file) — [DA COMPLETARE: regione del progetto e riferimento DPA]',
  'Netlify (hosting del sito e delle funzioni server) — [DA COMPLETARE: riferimento DPA]',
  'Stripe (pagamenti e fatturazione) — titolare autonomo per i dati di pagamento; [DA COMPLETARE: riferimento]',
  'OpenAI (elaborazione AI delle richieste: analisi, bozze, assistente) — chiamate API con store disattivato; [DA COMPLETARE: riferimento DPA e regione]',
  'Resend (email della piattaforma: notifiche interne e inviti dei collaboratori, se attivate) — [DA COMPLETARE: riferimento DPA]',
  'Fonti dati del Lead Finder: servizio Overpass/OpenStreetMap [DA COMPLETARE: fornitore scelto] e, se attivo, Google Places API',
]

export const LEGAL_DOCS: Record<LegalPage, LegalDoc> = {
  privacy: {
    title: 'Informativa privacy',
    updated: UPDATED,
    intro: `Questa informativa descrive come ${TITOLARE} tratta i dati personali di visitatori del sito, utenti registrati e richiedenti di una demo. Per i dati dei lead caricati o cercati dai clienti si veda la pagina "Trattamento dati B2B".`,
    sections: [
      { heading: 'Titolare del trattamento', paragraphs: [`${TITOLARE}, ${SEDE}, ${PIVA}. Contatto privacy: ${PRIVACY_EMAIL}. [DA COMPLETARE: eventuale DPO / referente privacy]`] },
      {
        heading: 'Dati trattati',
        paragraphs: [
          'Account: nome, email, password (conservata dal fornitore di autenticazione in forma non leggibile), organizzazione di appartenenza e ruolo.',
          'Dati aziendali inseriti durante l’onboarding: ragione sociale, partita IVA, settore, sito web, dimensione, profilo commerciale.',
          'Richieste di demo: nome, azienda, email, telefono (se indicato), settore, numero di dipendenti (facoltativo), messaggio, preferenza di contatto, data del consenso.',
          'Ticket di assistenza: contenuto dei messaggi scambiati con lo staff.',
          'Inviti dei collaboratori: email della persona invitata, ruolo, autore dell’invito, date di invio, accettazione o revoca. Il link di invito è conservato solo in forma di hash non reversibile.',
          'Assistente di onboarding: la domanda viene inviata al fornitore AI per generare la risposta e non viene salvata da LeadFlow AI; si registrano solo consumo e costo dell’elaborazione.',
          'Dati tecnici: registri di sicurezza e di funzionamento (senza indirizzo IP in chiaro per i limiti di frequenza, che usano un hash), errori applicativi sanificati.',
          'Statistiche di visita, solo con consenso: un identificativo casuale e le pagine visitate (home, prezzi, avvio registrazione). Nessun cookie di profilazione.',
          'Pagamenti: gestiti da Stripe; LeadFlow AI non riceve né conserva i dati della carta.',
        ],
      },
      {
        heading: 'Finalità e basi giuridiche',
        paragraphs: [
          'Erogazione del servizio e gestione dell’abbonamento: esecuzione del contratto (art. 6.1.b GDPR).',
          'Invito dei collaboratori da parte di un cliente: [DA COMPLETARE: base giuridica — es. legittimo interesse del cliente a consentire l’accesso ai propri collaboratori; ruolo di LeadFlow AI per questi dati]',
          'Risposta alle richieste di demo e di assistenza: misure precontrattuali / contratto (art. 6.1.b).',
          'Sicurezza, prevenzione abusi, monitoraggio degli errori: legittimo interesse (art. 6.1.f).',
          'Statistiche di visita: consenso (art. 6.1.a), revocabile in qualsiasi momento dal link "Preferenze cookie".',
          'Obblighi fiscali e contabili: obbligo di legge (art. 6.1.c).',
          '[DA COMPLETARE: eventuali comunicazioni commerciali al cliente e relativa base giuridica — oggi la piattaforma non invia newsletter]',
        ],
      },
      { heading: 'Destinatari e sub-responsabili', paragraphs: SUBPROCESSORS },
      { heading: 'Trasferimenti extra UE', paragraphs: ['[DA COMPLETARE: elenco dei fornitori con sede o trattamento fuori dallo SEE e garanzie applicate (decisione di adeguatezza / clausole contrattuali standard)]'] },
      {
        heading: 'Conservazione',
        paragraphs: [
          'Dati dell’account e dell’organizzazione: per la durata del contratto e [DA COMPLETARE: periodo di conservazione dopo la cessazione] dopo la cessazione.',
          'Richieste di demo non seguite da un contratto: [DA COMPLETARE: periodo di conservazione delle richieste demo].',
          'Errori applicativi e limiti di frequenza: [DA COMPLETARE: periodo di conservazione degli errori]; i limiti di frequenza sono eliminati automaticamente dopo 2 giorni.',
          'Inviti dei collaboratori (accettati, revocati o scaduti): [DA COMPLETARE: periodo di conservazione degli inviti]. Oggi non sono eliminati automaticamente.',
          'Documenti fiscali: secondo i termini di legge.',
        ],
      },
      { heading: 'Diritti dell’interessato', paragraphs: [`Accesso, rettifica, cancellazione, limitazione, portabilità, opposizione e revoca del consenso scrivendo a ${PRIVACY_EMAIL}. Diritto di reclamo al Garante per la protezione dei dati personali.`] },
    ],
  },
  cookie: {
    title: 'Cookie policy',
    updated: UPDATED,
    sections: [
      {
        heading: 'Strumenti tecnici (senza consenso)',
        paragraphs: [
          'Sessione di autenticazione (Supabase Auth, memorizzazione locale del browser): necessaria per l’accesso all’area riservata.',
          'Preferenze di interfaccia: lingua (lf-locale), tema (lf-theme), organizzazione selezionata nell’area riservata e piano scelto prima della registrazione (lf-signup-plan).',
          'Registrazione della scelta sul consenso (lf-consent-analytics).',
        ],
      },
      {
        heading: 'Statistiche (solo con consenso)',
        paragraphs: [
          'Identificativo casuale (lf-anon-id) memorizzato nel browser e inviato ai nostri server insieme a tre eventi: visita della home, visualizzazione dei prezzi, avvio della registrazione. Non è un cookie di terze parti, non viene incrociato con altri dati e non contiene informazioni personali.',
          'Se il browser invia il segnale Global Privacy Control, le statistiche restano disattivate.',
          'Puoi cambiare scelta in qualsiasi momento dal link "Preferenze cookie" nel footer: in caso di rifiuto l’identificativo viene cancellato.',
        ],
      },
      { heading: 'Terze parti', paragraphs: ['Il sito non usa cookie di profilazione né strumenti pubblicitari. La pagina di pagamento è ospitata da Stripe, che applica la propria cookie policy. [DA COMPLETARE: verificare prima del lancio che nessun altro strumento sia stato aggiunto]'] },
    ],
  },
  termini: {
    title: 'Termini di servizio',
    updated: UPDATED,
    sections: [
      { heading: 'Parti e oggetto', paragraphs: [`Il servizio LeadFlow AI è fornito da ${TITOLARE} (${SEDE}, ${PIVA}) a clienti professionali (B2B). Il servizio non è destinato a consumatori. [DA COMPLETARE: verifica legale della clausola B2B]`] },
      {
        heading: 'Descrizione del servizio',
        paragraphs: [
          'Piattaforma software per la ricerca di potenziali clienti aziendali, l’analisi con strumenti di intelligenza artificiale, la gestione commerciale (CRM) e l’invio di campagne email tramite account del cliente.',
          'Le funzioni indicate come "Beta" o "In preparazione" possono essere modificate o non essere disponibili.',
          'Il servizio non garantisce l’acquisizione di clienti, vendite o altri risultati commerciali.',
        ],
      },
      {
        heading: 'Contenuti generati dall’AI',
        paragraphs: ['Analisi, messaggi e proposte generati dall’AI possono contenere errori. Il cliente è tenuto a verificarli prima dell’uso; nessun messaggio viene inviato senza un’azione del cliente.'],
      },
      {
        heading: 'Obblighi del cliente',
        paragraphs: [
          'Usare il servizio nel rispetto della normativa su protezione dei dati, comunicazioni commerciali e concorrenza; indicare fonte e base giuridica dei dati importati; gestire opposizioni e disiscrizioni.',
          'Custodire le credenziali, non condividere l’accesso oltre il numero di utenti del piano e non tentare di eludere limiti tecnici o di sicurezza.',
        ],
      },
      { heading: 'Disponibilità e assistenza', paragraphs: ['[DA COMPLETARE: livello di servizio, finestre di manutenzione, tempi di risposta dell’assistenza per piano]'] },
      { heading: 'Responsabilità', paragraphs: ['[DA COMPLETARE: limitazioni di responsabilità, da redigere con un legale]'] },
      { heading: 'Legge applicabile e foro', paragraphs: ['[DA COMPLETARE: legge applicabile e foro competente]'] },
    ],
  },
  'condizioni-abbonamento': {
    title: 'Condizioni di abbonamento',
    updated: UPDATED,
    sections: [
      {
        heading: 'Piani e prezzi',
        paragraphs: [
          'Starter 149 € / mese, Business 349 € / mese, Enterprise 799 € / mese, IVA esclusa. Limiti mensili di lead, crediti AI e utenti come indicato nella pagina Prezzi.',
          'White Label per agenzie: Agency 2.990 € di attivazione + 399 € / mese; Premium 5.990 € di attivazione + 799 € / mese, IVA esclusa.',
        ],
      },
      {
        heading: 'Pagamento e attivazione',
        paragraphs: [
          'Il pagamento avviene tramite Stripe con fatturazione mensile anticipata. L’abbonamento si attiva solo dopo la conferma del pagamento da parte di Stripe.',
          'In caso di pagamento non riuscito l’accesso ai moduli a pagamento può essere sospeso fino alla regolarizzazione. [DA COMPLETARE: periodo di tolleranza]',
        ],
      },
      {
        heading: 'Crediti AI e quote',
        paragraphs: [
          'Un credito AI corrisponde a un’operazione AI completata con successo, con un budget massimo di elaborazione per credito; le operazioni fallite non consumano crediti. Il costo in crediti di ogni operazione è indicato nella pagina Abbonamento.',
          'Lead e crediti si rinnovano a ogni periodo e non sono cumulabili né rimborsabili. Il saldo non può diventare negativo.',
        ],
      },
      {
        heading: 'Cambio piano, disdetta e rimborsi',
        paragraphs: [
          'Il cambio di piano è immediato con calcolo proporzionale effettuato da Stripe.',
          'La disdetta, dal portale clienti, ha effetto alla fine del periodo già pagato. [DA COMPLETARE: politica di rimborso]',
        ],
      },
      { heading: 'Fatturazione elettronica', paragraphs: ['[DA COMPLETARE: modalità di emissione della fattura elettronica (SDI), codice destinatario / PEC del cliente]'] },
    ],
  },
  cancellazione: {
    title: 'Politica di cancellazione, recesso e cessazione',
    updated: UPDATED,
    intro: 'Descrive come si disdice l’abbonamento e cosa accade ai dati alla cessazione, secondo il funzionamento attuale della piattaforma.',
    sections: [
      {
        heading: 'Disdetta dell’abbonamento',
        paragraphs: [
          'L’amministratore dell’organizzazione disdice dalla pagina Abbonamento o dal portale clienti Stripe.',
          'La disdetta ha effetto alla fine del periodo già pagato: fino a quella data l’accesso resta attivo; nessun rinnovo successivo viene addebitato.',
          'Prima della scadenza la disdetta può essere annullata dalla stessa pagina.',
          'Cambio piano: l’upgrade è immediato con addebito proporzionale; il downgrade genera un credito proporzionale sulla fattura successiva (calcolo di Stripe).',
        ],
      },
      {
        heading: 'Rimborsi',
        paragraphs: ['[DA COMPLETARE: politica di rimborso — es. nessun rimborso per periodi parziali salvo obblighi di legge o inadempimento del fornitore]'],
      },
      {
        heading: 'Pagamenti non riusciti',
        paragraphs: [
          'Se un rinnovo non va a buon fine, Stripe ritenta l’incasso; durante i tentativi l’accesso resta attivo.',
          'Se l’incasso non riesce, l’abbonamento viene chiuso secondo le impostazioni di Stripe e i moduli a pagamento vengono bloccati. [DA COMPLETARE: numero di tentativi e durata, come configurati in Stripe]',
        ],
      },
      {
        heading: 'Recesso del fornitore e sospensione',
        paragraphs: ['[DA COMPLETARE: casi di sospensione o risoluzione da parte del fornitore (es. uso illecito, mancato pagamento) e preavviso]'],
      },
      {
        heading: 'Dati alla cessazione',
        paragraphs: [
          'Dopo la cessazione i dati dell’organizzazione restano nel database fino alla cancellazione secondo la politica di conservazione indicata nell’informativa privacy.',
          'Esportazione prima della cessazione: lead in CSV dove consentito dalla licenza della fonte (i dati di Google Places non sono esportabili). [DA COMPLETARE: altre esportazioni offerte su richiesta]',
          'Cancellazione su richiesta: [DA COMPLETARE: procedura, tempi e conferma scritta]. Oggi la cancellazione completa di un’organizzazione è un’operazione eseguita dallo staff, non un comando self-service.',
          'Le fatture e i dati fiscali sono conservati per i termini di legge.',
        ],
      },
      {
        heading: 'Collaboratori',
        paragraphs: ['Un amministratore può rimuovere un collaboratore in qualsiasi momento: l’accesso cessa subito. Un collaboratore che vuole lasciare l’organizzazione lo chiede a un amministratore; l’ultimo amministratore non può essere rimosso.'],
      },
    ],
  },
  'informazioni-societarie': {
    title: 'Informazioni societarie',
    updated: UPDATED,
    sections: [
      {
        heading: 'Fornitore del servizio',
        paragraphs: [
          `Ragione sociale: ${TITOLARE}`,
          `Sede legale: ${SEDE}`,
          `Partita IVA / Codice fiscale: ${PIVA}`,
          'Numero REA e registro delle imprese: [DA COMPLETARE: numero REA]',
          'Capitale sociale (se società di capitali): [DA COMPLETARE: capitale sociale]',
          'PEC: [DA COMPLETARE: indirizzo PEC]',
        ],
      },
    ],
  },
  'trattamento-dati-b2b': {
    title: 'Trattamento dei dati B2B e accordo sul trattamento (DPA)',
    updated: UPDATED,
    intro: 'Questa pagina descrive i ruoli privacy per i dati dei lead (aziende e loro referenti) gestiti dai clienti nella piattaforma e riassume gli elementi dell’accordo sul trattamento dei dati ai sensi dell’art. 28 GDPR. Non sostituisce il DPA firmato.',
    sections: [
      {
        heading: 'Ruoli',
        paragraphs: [
          'Il cliente è titolare del trattamento dei dati dei propri lead e contatti: decide quali aziende cercare, importare, contattare e per quali finalità.',
          `${TITOLARE} agisce come responsabile del trattamento per conto del cliente, limitatamente all’erogazione del servizio.`,
        ],
      },
      {
        heading: 'Obblighi del cliente come titolare',
        paragraphs: [
          'Indicare per ogni fonte la base giuridica (legittimo interesse, consenso, contratto, dati professionali pubblici) e, se il legittimo interesse è la base, averne valutato il bilanciamento.',
          'Fornire l’informativa agli interessati, gestire opposizioni, disiscrizioni e richieste di cancellazione; non importare dati ottenuti illecitamente.',
          'Rispettare le norme sulle comunicazioni commerciali (es. art. 130 Codice Privacy) per le campagne email.',
        ],
      },
      {
        heading: 'Elementi del DPA',
        paragraphs: [
          'Oggetto, durata, natura e finalità: archiviazione, ricerca, analisi AI e invio di comunicazioni su istruzione del cliente, per la durata del contratto.',
          'Categorie di interessati: referenti di aziende clienti e potenziali clienti; utenti del cliente e collaboratori invitati.',
          'Categorie di dati: dati di contatto professionali, ruolo, informazioni aziendali pubbliche, contenuti delle comunicazioni.',
          'Istruzioni: il responsabile tratta i dati solo secondo le funzioni del servizio attivate dal cliente.',
          'Riservatezza: accesso limitato al personale autorizzato; i dati di ogni organizzazione sono isolati a livello di database.',
          'Misure di sicurezza: cifratura in transito (HTTPS), controllo degli accessi per ruolo, policy di sicurezza a livello di riga, credenziali dei provider cifrate, registri di audit. [DA COMPLETARE: allegato tecnico delle misure]',
          'Sub-responsabili: elencati nell’informativa privacy; il cliente viene informato delle modifiche [DA COMPLETARE: modalità e preavviso].',
          'Assistenza al titolare per richieste degli interessati, violazioni di dati (notifica entro [DA COMPLETARE: ore per la notifica di violazione] ore) e valutazioni d’impatto.',
          'Restituzione e cancellazione dei dati alla cessazione: [DA COMPLETARE: procedura e tempi].',
          'Audit: [DA COMPLETARE: modalità].',
        ],
      },
      { heading: 'Firma del DPA', paragraphs: ['[DA COMPLETARE: modalità di sottoscrizione del DPA (allegato ai termini o documento separato)]'] },
    ],
  },
  contatti: {
    title: 'Contatti',
    updated: UPDATED,
    sections: [
      {
        heading: 'Come contattarci',
        paragraphs: [
          'Clienti: apri un ticket dal Centro assistenza nell’app.',
          'Informazioni commerciali e demo: usa il modulo "Richiedi una demo".',
          'Email: [DA COMPLETARE: indirizzo email di contatto]',
          `Privacy: ${PRIVACY_EMAIL}`,
          `Sede: ${SEDE}`,
        ],
      },
    ],
  },
}
