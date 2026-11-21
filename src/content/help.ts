/**
 * Base di conoscenza del Centro assistenza e dell'Assistente di onboarding.
 *
 * È la FONTE UNICA della documentazione mostrata ai clienti: l'assistente AI risponde solo
 * citando questi articoli (vedi netlify/functions/_shared/assistant). Ogni articolo descrive
 * funzioni realmente presenti nel codice; ciò che non è disponibile è dichiarato come tale.
 * Nessuna promessa di risultati commerciali. Modificare qui = aggiornare help center e assistente.
 * File senza dipendenze: importato sia dal frontend sia dalle Netlify Functions.
 */
export type HelpLocale = 'it' | 'en'
export type HelpCategory = 'start' | 'leads' | 'ai' | 'crm' | 'campaigns' | 'billing' | 'account' | 'privacy' | 'white_label'

export interface HelpArticle {
  id: string
  category: HelpCategory
  /** Percorso dell'app in cui si usa la funzione (link "Apri"). */
  link?: string
  keywords: string[]
  title: Record<HelpLocale, string>
  body: Record<HelpLocale, string>
}

export const HELP_CATEGORIES: Record<HelpCategory, Record<HelpLocale, string>> = {
  start: { it: 'Primi passi', en: 'Getting started' },
  leads: { it: 'Ricerca lead', en: 'Lead search' },
  ai: { it: 'Funzioni AI', en: 'AI features' },
  crm: { it: 'CRM e pipeline', en: 'CRM & pipeline' },
  campaigns: { it: 'Campagne email', en: 'Email campaigns' },
  billing: { it: 'Piani e fatturazione', en: 'Plans & billing' },
  account: { it: 'Account e team', en: 'Account & team' },
  privacy: { it: 'Privacy e dati', en: 'Privacy & data' },
  white_label: { it: 'White Label', en: 'White Label' },
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'getting-started',
    category: 'start',
    link: '/app',
    keywords: ['inizio', 'iniziare', 'primi', 'passi', 'onboarding', 'configurazione', 'start', 'setup', 'checklist', 'tour'],
    title: { it: 'Come iniziare con LeadFlow AI', en: 'Getting started with LeadFlow AI' },
    body: {
      it: "Dopo la registrazione l'onboarding guidato ti chiede i dati dell'azienda, il profilo commerciale (cosa vendi, il cliente ideale, l'area geografica) e il piano. Il profilo commerciale viene usato dal Lead Finder per il punteggio e dall'AI per personalizzare analisi e messaggi. Puoi interrompere l'onboarding in qualsiasi momento e riprenderlo dallo stesso punto. Nella dashboard trovi la checklist dei primi passi: completare il profilo, fare la prima ricerca, salvare il primo lead e avviare la prima analisi AI.",
      en: 'After signing up, the guided onboarding asks for your company details, your commercial profile (what you sell, your ideal customer, your geographic area) and a plan. The commercial profile is used by Lead Finder for scoring and by the AI to tailor analyses and messages. You can stop the onboarding at any time and resume from the same step. The dashboard shows a getting-started checklist: complete the profile, run the first search, save the first lead and run the first AI analysis.',
    },
  },
  {
    id: 'lead-finder-search',
    category: 'leads',
    link: '/app/lead-finder',
    keywords: ['ricerca', 'cercare', 'trovare', 'lead', 'aziende', 'potenziali', 'clienti', 'settore', 'città', 'search', 'find', 'companies', 'openstreetmap', 'google', 'places', 'fonte'],
    title: { it: 'Cercare nuove aziende con il Lead Finder', en: 'Finding companies with Lead Finder' },
    body: {
      it: "Nel Lead Finder indichi settore e località: la ricerca interroga le fonti dati configurate dalla piattaforma (OpenStreetMap tramite Overpass e, se attivo, Google Places). I risultati sono candidati: li valuti, li escludi o li salvi come lead nel CRM. I risultati di Google Places sono mostrati solo durante la sessione e non vengono salvati né esportati, come richiesto dai termini di Google. Ogni lead salvato conta nella quota mensile del piano. LeadFlow AI non garantisce che un'azienda trovata sia interessata ai tuoi servizi: la ricerca individua potenziali contatti, la qualificazione resta a te.",
      en: 'In Lead Finder you enter a sector and a location: the search queries the data sources configured by the platform (OpenStreetMap via Overpass and, when enabled, Google Places). Results are candidates: you review them, exclude them or save them as leads in the CRM. Google Places results are shown only during the session and are not stored or exported, as required by Google terms. Every saved lead counts toward the monthly quota of your plan. LeadFlow AI does not guarantee that a company found is interested in your services: the search identifies potential contacts, qualification is up to you.',
    },
  },
  {
    id: 'lead-import-export',
    category: 'leads',
    link: '/app/lead-finder',
    keywords: ['import', 'importare', 'csv', 'file', 'export', 'esportare', 'excel', 'caricare'],
    title: { it: 'Importare ed esportare lead (CSV)', en: 'Importing and exporting leads (CSV)' },
    body: {
      it: "Puoi importare un file CSV di aziende dal Lead Finder: i record vengono validati, i duplicati vengono riconosciuti e per ogni import devi indicare la fonte e la base giuridica del trattamento. L'esportazione in CSV è disponibile nei piani che la includono. I dati ottenuti da Google Places non sono esportabili.",
      en: 'You can import a CSV file of companies from Lead Finder: records are validated, duplicates are detected and for each import you must state the source and the legal basis for processing. CSV export is available on plans that include it. Data obtained from Google Places cannot be exported.',
    },
  },
  {
    id: 'lead-scoring',
    category: 'ai',
    link: '/app/lead-scoring',
    keywords: ['punteggio', 'score', 'scoring', 'priorità', 'pesi', 'qualificazione', 'priority', 'weights'],
    title: { it: 'Come funziona il punteggio dei lead', en: 'How lead scoring works' },
    body: {
      it: "Il punteggio da 0 a 100 combina criteri trasparenti: corrispondenza del settore, area geografica, aderenza al cliente ideale, segnali disponibili e completezza dei dati. I pesi di ciascun criterio si modificano nelle impostazioni del Lead Scoring. Se esegui l'analisi AI di un lead, il punteggio può includerne l'esito. Il punteggio è un aiuto per dare priorità ai contatti, non una previsione di vendita.",
      en: 'The 0–100 score combines transparent criteria: sector match, geographic area, fit with the ideal customer, available signals and data completeness. The weight of each criterion can be changed in the Lead Scoring settings. If you run the AI analysis of a lead, the score can include its result. The score helps you prioritise contacts; it is not a sales forecast.',
    },
  },
  {
    id: 'business-analyzer',
    category: 'ai',
    link: '/app/lead-finder',
    keywords: ['analisi', 'analizzare', 'analyzer', 'business', 'ai', 'intelligenza', 'artificiale', 'opportunità', 'analysis', 'crediti'],
    title: { it: "Analisi AI di un'azienda (Business Analyzer)", en: 'AI company analysis (Business Analyzer)' },
    body: {
      it: "Dal Lead Finder puoi avviare l'analisi AI di un candidato o di un lead: l'AI usa solo i dati disponibili sull'azienda e il tuo profilo commerciale per descrivere l'opportunità e i possibili punti di contatto. Ogni analisi completata consuma crediti AI secondo il listino del piano; le analisi fallite non consumano crediti. L'AI può sbagliare: verifica sempre le informazioni prima di usarle con un cliente.",
      en: 'From Lead Finder you can start the AI analysis of a candidate or lead: the AI uses only the available company data and your commercial profile to describe the opportunity and possible talking points. Each completed analysis uses AI credits according to your plan; failed analyses do not use credits. The AI can make mistakes: always check the information before using it with a prospect.',
    },
  },
  {
    id: 'sales-agent',
    category: 'ai',
    link: '/app/sales-agent',
    keywords: ['sales', 'agent', 'email', 'messaggi', 'proposta', 'preventivo', 'follow', 'copilot', 'scrivere', 'bozza', 'draft', 'proposal'],
    title: { it: 'AI Sales Agent: messaggi, proposte e follow-up', en: 'AI Sales Agent: messages, proposals and follow-ups' },
    body: {
      it: "L'AI Sales Agent prepara bozze di messaggi, proposte commerciali e suggerimenti di follow-up per un lead, partendo dal tuo profilo commerciale e dai dati del lead. Le bozze non vengono mai inviate automaticamente: le rivedi, le modifichi e decidi tu se usarle. È incluso nei piani Business ed Enterprise e consuma crediti AI per ogni generazione completata.",
      en: 'The AI Sales Agent drafts messages, commercial proposals and follow-up suggestions for a lead, based on your commercial profile and the lead data. Drafts are never sent automatically: you review, edit and decide whether to use them. It is included in the Business and Enterprise plans and uses AI credits for each completed generation.',
    },
  },
  {
    id: 'crm-pipeline',
    category: 'crm',
    link: '/app/crm',
    keywords: ['crm', 'pipeline', 'fasi', 'opportunità', 'attività', 'appuntamenti', 'note', 'kanban', 'stage', 'deal'],
    title: { it: 'Gestire lead e opportunità nel CRM', en: 'Managing leads and deals in the CRM' },
    body: {
      it: "Lo Smart CRM organizza i lead per fase (nuovo, contattato, qualificato, proposta, vinto, perso), con attività, note, appuntamenti e opportunità. Ogni cambio di fase viene registrato nella cronologia. Gli appuntamenti sono annotazioni interne: LeadFlow AI non è collegato a calendari esterni e non invia inviti.",
      en: 'Smart CRM organises leads by stage (new, contacted, qualified, proposal, won, lost), with activities, notes, appointments and deals. Every stage change is recorded in the history. Appointments are internal records: LeadFlow AI is not connected to external calendars and does not send invitations.',
    },
  },
  {
    id: 'campaigns',
    category: 'campaigns',
    link: '/app/campaigns',
    keywords: ['campagne', 'campagna', 'email', 'sequenze', 'invio', 'resend', 'dominio', 'disiscrizione', 'unsubscribe', 'campaign', 'sequence', 'automazioni'],
    title: { it: 'Campagne email e automazioni', en: 'Email campaigns and automations' },
    body: {
      it: "Il Campaign Manager invia sequenze email dal TUO account Resend, collegato in Impostazioni → Canali email con un dominio verificato. Ogni messaggio include un link di disiscrizione personale; i contatti disiscritti o soppressi vengono esclusi automaticamente. Sei tu il responsabile del rispetto delle norme sulle comunicazioni commerciali (base giuridica, informativa, opposizione). Le automazioni eseguono azioni sui lead in base a eventi e regole che definisci. È incluso nei piani Business ed Enterprise.",
      en: 'Campaign Manager sends email sequences from YOUR Resend account, connected in Settings → Email channels with a verified domain. Every message includes a personal unsubscribe link; unsubscribed or suppressed contacts are excluded automatically. You are responsible for complying with rules on commercial communications (legal basis, notice, right to object). Automations run actions on leads based on events and rules you define. It is included in the Business and Enterprise plans.',
    },
  },
  {
    id: 'plans',
    category: 'billing',
    link: '/app/billing',
    keywords: ['piano', 'piani', 'prezzo', 'prezzi', 'costo', 'starter', 'business', 'enterprise', 'abbonamento', 'iva', 'plan', 'pricing', 'price', 'upgrade', 'downgrade'],
    title: { it: 'Piani, prezzi e limiti', en: 'Plans, prices and limits' },
    body: {
      it: "Starter (149 € al mese + IVA): Lead Finder, Business Analyzer ed export, 250 lead e 500 crediti AI al mese, 1 utente. Business (349 € al mese + IVA): aggiunge AI Sales Agent, Campaign Manager e CRM avanzato, 1.000 lead, 2.500 crediti AI, 5 utenti. Enterprise (799 € al mese + IVA): tutti i moduli, automazioni, analytics avanzate e supporto prioritario, 5.000 lead, 10.000 crediti AI, 20 utenti. Quote e crediti si rinnovano a ogni periodo di fatturazione. Puoi cambiare piano dalla pagina Abbonamento.",
      en: 'Starter (€149 per month + VAT): Lead Finder, Business Analyzer and export, 250 leads and 500 AI credits per month, 1 user. Business (€349 per month + VAT): adds AI Sales Agent, Campaign Manager and advanced CRM, 1,000 leads, 2,500 AI credits, 5 users. Enterprise (€799 per month + VAT): all modules, automations, advanced analytics and priority support, 5,000 leads, 10,000 AI credits, 20 users. Quotas and credits renew every billing period. You can change plan from the Subscription page.',
    },
  },
  {
    id: 'credits',
    category: 'billing',
    link: '/app/billing',
    keywords: ['crediti', 'credito', 'ai', 'consumo', 'saldo', 'esauriti', 'credits', 'usage', 'quota', 'token'],
    title: { it: 'Come funzionano i crediti AI', en: 'How AI credits work' },
    body: {
      it: "Un credito AI corrisponde a un'operazione AI unitaria completata con successo. Ogni operazione ha un costo in crediti (ad esempio 1 per un'analisi, 3 per una proposta) e un budget massimo di token per credito. I crediti vengono prenotati all'avvio, addebitati solo se l'operazione riesce e restituiti se fallisce o viene annullata. Il saldo non può diventare negativo: quando i crediti finiscono, le nuove operazioni AI vengono bloccate fino al rinnovo o a un cambio di piano. I crediti sono un'unità commerciale e non coincidono con i token dei modelli AI.",
      en: 'One AI credit is one unit AI operation completed successfully. Each operation has a credit cost (for example 1 for an analysis, 3 for a proposal) and a maximum token budget per credit. Credits are reserved when the operation starts, charged only if it succeeds and returned if it fails or is cancelled. The balance cannot go negative: when credits run out, new AI operations are blocked until renewal or a plan change. Credits are a commercial unit and do not equal AI model tokens.',
    },
  },
  {
    id: 'payment-cancel',
    category: 'billing',
    link: '/app/billing',
    keywords: ['pagamento', 'carta', 'fattura', 'fatture', 'disdetta', 'disdire', 'annullare', 'cancellare', 'abbonamento', 'subscription', 'portale', 'stripe', 'invoice', 'cancel', 'payment', 'rinnovo'],
    title: { it: 'Pagamenti, fatture e disdetta', en: 'Payments, invoices and cancellation' },
    body: {
      it: "I pagamenti sono gestiti da Stripe tramite una pagina di pagamento ospitata: LeadFlow AI non vede né conserva i dati della carta. L'abbonamento si attiva solo quando Stripe conferma il pagamento. Metodo di pagamento e fatture si gestiscono dal portale clienti Stripe, raggiungibile dalla pagina Abbonamento. La disdetta ha effetto alla fine del periodo già pagato: fino ad allora mantieni l'accesso.",
      en: 'Payments are handled by Stripe through a hosted payment page: LeadFlow AI never sees or stores card data. The subscription is activated only when Stripe confirms the payment. Payment method and invoices are managed in the Stripe customer portal, reachable from the Subscription page. Cancellation takes effect at the end of the period already paid: you keep access until then.',
    },
  },
  {
    id: 'team',
    category: 'account',
    link: '/app/settings',
    keywords: ['team', 'utenti', 'utente', 'invitare', 'invito', 'collaboratori', 'colleghi', 'ruoli', 'admin', 'membro', 'collaboratori', 'users', 'invite', 'roles', 'password'],
    title: { it: 'Utenti, ruoli e impostazioni', en: 'Users, roles and settings' },
    body: {
      it: "Ogni organizzazione ha amministratori e membri. Gli amministratori gestiscono abbonamento, impostazioni, canali email e utenti; i membri lavorano su lead, CRM e funzioni AI incluse nel piano. Il numero massimo di utenti dipende dal piano (membri e inviti in attesa contano entrambi). Gli amministratori invitano i colleghi da Impostazioni → Collaboratori scegliendo il ruolo: l'invito vale 7 giorni, si usa una sola volta e funziona solo con l'email invitata, già confermata. Gli amministratori possono revocare un invito o rimuovere un collaboratore; ogni operazione viene registrata. La password si reimposta dalla pagina di accesso con il link \"Password dimenticata\".",
      en: 'Each organisation has admins and members. Admins manage subscription, settings, email channels and users; members work on leads, CRM and the AI features included in the plan. The maximum number of users depends on the plan (members and pending invitations both count). Admins invite colleagues from Settings → Team members choosing a role: the invitation lasts 7 days, can be used once and works only with the invited, confirmed email. Admins can revoke an invitation or remove a team member; every operation is logged. You can reset your password from the sign-in page with the "Forgot password" link.',
    },
  },
  {
    id: 'privacy-data',
    category: 'privacy',
    keywords: ['privacy', 'gdpr', 'dati', 'personali', 'cancellazione', 'conservazione', 'sicurezza', 'dpa', 'data', 'deletion', 'security', 'isolamento'],
    title: { it: 'Privacy, sicurezza e dati B2B', en: 'Privacy, security and B2B data' },
    body: {
      it: "I dati di ogni organizzazione sono isolati a livello di database: nessun'altra azienda può leggerli. Le chiavi di servizio restano sul server e le credenziali dei provider email sono cifrate. I dati dei lead possono includere dati personali di referenti aziendali: per ciascuna fonte devi indicare la base giuridica e rispettare le richieste di opposizione e cancellazione. Le informative legali e l'accordo sul trattamento dei dati (DPA) sono disponibili nelle pagine legali; per richieste privacy apri un ticket con categoria Privacy.",
      en: "Each organisation's data is isolated at database level: no other company can read it. Service keys stay on the server and email provider credentials are encrypted. Lead data may include personal data of company contacts: for each source you must state the legal basis and honour objection and deletion requests. Legal notices and the data processing agreement (DPA) are available on the legal pages; for privacy requests open a ticket with the Privacy category.",
    },
  },
  {
    id: 'support',
    category: 'account',
    link: '/app/support',
    keywords: ['supporto', 'assistenza', 'ticket', 'aiuto', 'problema', 'errore', 'contatto', 'support', 'help', 'bug', 'risposta'],
    title: { it: 'Aprire un ticket di assistenza', en: 'Opening a support ticket' },
    body: {
      it: "Dal Centro assistenza apri un ticket scegliendo la categoria e la priorità e descrivendo il problema. Vedi lo stato del ticket (aperto, in attesa di risposta, risolto, chiuso) e tutta la cronologia dei messaggi; quando lo staff risponde ricevi una notifica nell'app. Non inserire password, chiavi API o dati di carte nei ticket.",
      en: 'From the Support center you open a ticket by choosing a category and priority and describing the problem. You can see the ticket status (open, awaiting reply, resolved, closed) and the full message history; when the staff replies you get an in-app notification. Do not put passwords, API keys or card data in tickets.',
    },
  },
  {
    id: 'white-label',
    category: 'white_label',
    keywords: ['white', 'label', 'rivenditore', 'agenzia', 'marchio', 'logo', 'dominio', 'personalizzato', 'reseller', 'branding', 'domain'],
    title: { it: 'Programma White Label per agenzie', en: 'White Label programme for agencies' },
    body: {
      it: "Il programma White Label permette a un'agenzia di offrire LeadFlow AI ai propri clienti con logo, colori e dominio personalizzato. Piani: Agency (attivazione 2.990 € + 399 € al mese + IVA, fino a 25 clienti, 1 dominio) e Premium (attivazione 5.990 € + 799 € al mese + IVA, fino a 100 clienti, 10 domini). Il dominio personalizzato richiede la verifica DNS e una configurazione manuale da parte del nostro staff prima di essere attivo. Ogni agenzia vede solo i propri clienti. Per aderire richiedi una demo.",
      en: 'The White Label programme lets an agency offer LeadFlow AI to its clients with its own logo, colours and custom domain. Plans: Agency (€2,990 setup + €399 per month + VAT, up to 25 clients, 1 domain) and Premium (€5,990 setup + €799 per month + VAT, up to 100 clients, 10 domains). A custom domain requires DNS verification and a manual configuration by our staff before it goes live. Each agency sees only its own clients. To join, request a demo.',
    },
  },
  {
    id: 'not-available',
    category: 'start',
    keywords: ['calendario', 'linkedin', 'whatsapp', 'telefono', 'chiamate', 'integrazione', 'hubspot', 'salesforce', 'api', 'zapier', 'calendar', 'integration', 'garanzia', 'garantiti'],
    title: { it: 'Cosa LeadFlow AI non fa (ancora)', en: 'What LeadFlow AI does not do (yet)' },
    body: {
      it: "Oggi LeadFlow AI non è collegato a calendari esterni, LinkedIn, WhatsApp, centralini telefonici o CRM di terze parti, e non offre un'API pubblica. Non invia messaggi senza la tua azione e non garantisce clienti, vendite o risultati commerciali. Se una di queste funzioni è importante per te, segnalalo con un ticket: ci aiuta a decidere le priorità.",
      en: 'Today LeadFlow AI is not connected to external calendars, LinkedIn, WhatsApp, phone systems or third-party CRMs, and it does not offer a public API. It does not send messages without your action and it does not guarantee customers, sales or business results. If one of these features matters to you, tell us with a ticket: it helps us set priorities.',
    },
  },
]

// ── Ricerca testuale (usata dall'help center e, lato server, dall'assistente) ──
const STOPWORDS = new Set(
  ('il lo la i gli le un una uno di da in con su per tra fra e o ma se che chi come cosa dove quando quale quali è sono ho hai ha mio mia miei mie tuo tua ' +
    'del della dei delle dello al alla ai alle nel nella nei nelle sul sulla non più posso puoi può si mi ti ci vi anche questo questa quello ' +
    'the a an of to in on for with and or but if how what where when which is are do does can i my you your it this that be').split(' '),
)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/** Radice grezza (prime 5 lettere) per far combaciare singolare/plurale e coniugazioni. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w)

export interface HelpHit {
  article: HelpArticle
  score: number
}

export function searchHelp(query: string, locale: HelpLocale = 'it', limit = 3): HelpHit[] {
  const q = [...new Set(tokenize(query).map(stem))]
  if (q.length === 0) return []
  const hits: HelpHit[] = []
  for (const a of HELP_ARTICLES) {
    const kw = new Set(a.keywords.flatMap((k) => tokenize(k)).map(stem))
    const title = new Set(tokenize(`${a.title.it} ${a.title.en}`).map(stem))
    const body = new Set(tokenize(a.body[locale]).map(stem))
    let score = 0
    for (const w of q) {
      if (kw.has(w)) score += 3
      if (title.has(w)) score += 2
      if (body.has(w)) score += 1
    }
    if (score > 0) hits.push({ article: a, score: score / Math.sqrt(q.length) })
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, limit)
}
