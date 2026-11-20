# LeadFlow AI

Piattaforma SaaS multi-tenant per trovare, analizzare, qualificare e gestire opportunità commerciali B2B.

**Stato: Fase 3 (AI Sales Agent).** Oltre alle fondamenta (auth, organizzazioni, dashboard, CRM, RLS) e
all'**AI Lead Finder** (ricerca su fonti autorizzate, import CSV, Business Analyzer, Lead Scoring) sono
operativi: **AI Sales Agent** (profilo commerciale, Lead Intelligence, generatore di bozze messaggi,
proposte commerciali, follow-up intelligente, Copilot), **pipeline a 12 fasi** con drag-and-drop e
storico, **calendario follow-up**. Il Sales Agent **non invia nulla**: produce solo bozze; l'approvazione
di una bozza non autorizza l'invio. Campagne, Analytics e Billing restano **"in preparazione"**.
Nessun dato simulato viene mostrato come reale: i mock esistono solo nei test.

## Stack

| Livello | Tecnologia |
| --- | --- |
| Frontend | React 18, Vite, TypeScript (strict), Tailwind CSS v4, React Router 6 |
| Backend dati | Supabase PostgreSQL, Auth, Row Level Security |
| Serverless | Netlify Functions (`netlify/functions`, esposte su `/api/*`) |
| AI | OpenAI Responses API (Structured Outputs), solo lato server |
| Pagamenti (fasi successive) | Stripe, webhook lato server |

## Struttura

```
src/
  components/      ui/ (design system), layout/ (AppShell, AuthLayout), FlowVisual
  config/          modules.ts (registro dei 12 moduli), countries.ts
  contexts/        AuthContext (sessione, profilo, membership, org corrente), ThemeContext
  i18n/            it.ts (predefinita), en.ts, provider
  lib/             supabase client (solo anon key), env, validation, errors, tipi DB
  features/        lead-finder/, sales/ (generatore, proposte, follow-up, pipeline, Copilot, grafici)
  pages/           Landing, auth/*, Onboarding, app/* (Dashboard, Crm, Pipeline, FollowUps, LeadFinder,
                   SalesDashboard, SalesProfile, SalesLead, Settings, Billing, SuperAdmin, ModulePreview)
  routes/guards    RequireAuth, RequireOrganization, RequireSuperAdmin, PublicOnly
netlify/functions  health, ai-status, lead-finder-*, sales-agent-*, _shared (auth, http, dispatch,
                   lead-finder/, sales-agent/)
supabase/
  migrations/      0001 schema · 0002 sicurezza/RLS · 0003 Lead Finder · 0004 tipi attività · 0005 Sales Agent
  tests/           test RLS eseguibili su Postgres locale
```

## Installazione locale

Requisiti: Node.js ≥ 20, un progetto Supabase.

```bash
npm install
cp .env.example .env        # compila VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm run dev                 # http://localhost:5173
```

Senza variabili Supabase l'app si avvia comunque: la landing funziona e le pagine di accesso
mostrano un avviso "Supabase non è configurato" con i form disabilitati.

### Variabili d'ambiente

| Variabile | Dove | Uso |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | browser | URL del progetto Supabase |
| `VITE_SUPABASE_ANON_KEY` | browser | chiave pubblica; la protezione dei dati è data da RLS |
| `VITE_APP_URL` | browser | URL pubblico, per i redirect delle email di Auth |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | solo Netlify Functions | verifica dei JWT lato server |
| `SUPABASE_SERVICE_ROLE_KEY` | solo Netlify Functions | scritture server del Lead Finder dopo i controlli. Mai nel browser |
| `OVERPASS_API_URL`, `OVERPASS_CONTACT`, `OVERPASS_API_KEY` | solo Netlify Functions | fonte OpenStreetMap (endpoint HTTPS a pagamento o self-hosted) |
| `GOOGLE_PLACES_API_KEY` | solo Netlify Functions | fonte Google Places (solo sessione) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | solo Netlify Functions | Business Analyzer e Sales Agent |
| `LEADFLOW_INTERNAL_SECRET` | solo Netlify Functions | ≥ 32 caratteri, autentica l'avvio dei job AI in background (Lead Finder e Sales Agent) |
| `OPENAI_PRICE_INPUT_PER_MTOK`, `OPENAI_PRICE_OUTPUT_PER_MTOK` | solo Netlify Functions | facoltative: USD per 1M token, per stimare `ai_jobs.cost_usd` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | solo Netlify Functions | fasi successive |

Le variabili server **non** devono mai avere il prefisso `VITE_`, altrimenti Vite le inserisce nel bundle.

## Database Supabase

### Applicare le migrazioni

Con la CLI Supabase:

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
```

In alternativa, nel SQL Editor di Supabase esegui nell'ordine:

1. `supabase/migrations/20261119000001_initial_schema.sql`
2. `supabase/migrations/20261119000002_security_rls.sql`
3. `supabase/migrations/20261119000003_lead_finder.sql`
4. `supabase/migrations/20261120000004_activity_types.sql` (da eseguire **da sola**: `ALTER TYPE … ADD VALUE`
   non può essere usato nella stessa transazione che usa i nuovi valori)
5. `supabase/migrations/20261120000005_sales_agent.sql`

La migrazione 0005 sostituisce l'enum `lead_status` con le 12 fasi della pipeline: i lead esistenti in
`proposal` passano a `proposal_sent`; nessun dato viene cancellato. Le organizzazioni esistenti ricevono
un profilo commerciale vuoto.

### Configurazione Auth

In *Authentication → URL Configuration*:

- **Site URL**: l'URL di produzione (es. `https://leadflow.netlify.app`)
- **Redirect URLs**: `https://<dominio>/auth/callback`, `https://<dominio>/reset-password`
  e, in sviluppo, `http://localhost:5173/auth/callback`, `http://localhost:5173/reset-password`

Si consiglia di lasciare attiva la conferma email.

### Modello dati

Tabelle: `profiles`, `organizations`, `organization_members`, `lead_sources`, `leads`,
`contact_suppressions`, `lead_analyses`, `campaigns`, `campaign_leads`, `activities`, `appointments`,
`ai_jobs`, `subscriptions`, `usage_events`, `audit_logs`, e per il Sales Agent `sales_profiles`,
`sales_opportunities`, `sales_proposals`, `message_drafts`, `follow_up_tasks`, `ai_conversations`,
`ai_messages` (più la vista `lead_activities` su `activities`).

Ogni record aziendale ha `organization_id`. Le relazioni tra tabelle aziendali usano **chiavi esterne
composite** `(organization_id, id)`: è impossibile collegare un lead a una fonte o a una campagna di
un'altra organizzazione anche aggirando l'interfaccia.

### Ruoli e autorizzazioni

| Ruolo | Dove | Può |
| --- | --- | --- |
| `super_admin` | `profiles.platform_role` | vedere organizzazioni, membership, abbonamenti, consumi e audit di piattaforma. **Non** vede lead, campagne o attività dei tenant |
| `organization_admin` | `organization_members.role` | modificare l'organizzazione, cambiare ruoli, cancellare record, revocare opposizioni, leggere audit e abbonamento |
| `member` | `organization_members.role` | leggere e scrivere i dati commerciali della propria organizzazione |

Controlli implementati nel database (non aggirabili dal client):

- RLS su tutte le tabelle; funzioni helper `security definer` nello schema `private` (non esposto).
- Privilegi di colonna: un utente non può modificare `platform_role`, lo `slug` dell'org, ecc.
- `TRUNCATE` revocato ai ruoli client (non è soggetto a RLS).
- Tabelle server-only (`ai_jobs`, `lead_analyses`, `subscriptions`, `usage_events`, `audit_logs`) senza scrittura client.
- `created_by` impostato da trigger, `organization_id` immutabile, ultimo admin non rimovibile.
- Creazione organizzazione solo tramite RPC `create_organization` (validazione + ruolo admin atomici, max 5 org per utente).
- Audit log append-only scritto da trigger.

Per nominare un super admin (SQL Editor, come `postgres`):

```sql
update public.profiles set platform_role = 'super_admin' where email = 'operatore@tuodominio.it';
```

### Privacy e conformità

- **Provenienza**: `leads.source_id` è obbligatorio e punta a `lead_sources` con tipo, base giuridica, URL e data di acquisizione.
- **Opposizione** (`contact_status = 'opted_out'`): data registrata, hash SHA-256 dell'email inserito in `contact_suppressions`; solo un admin può revocarla.
- **Soppressione** (`public.suppress_lead(lead_id)`): cancella i dati personali del contatto e conserva solo l'hash; è irreversibile.
- I contatti presenti nella suppression list **non possono essere reinseriti** (trigger).
- **Conservazione**: `organizations.data_retention_days` (30–3650). La funzione `private.purge_expired_data()`
  (eseguibile solo da `service_role`) elimina i lead soft-deleted da oltre 30 giorni e quelli inattivi oltre il periodo.
  Pianificazione suggerita con `pg_cron`:
  ```sql
  select cron.schedule('leadflow-retention', '15 3 * * *', $$select private.purge_expired_data()$$);
  ```

## Test

```bash
npm run typecheck   # TypeScript su app, config e functions
npm test            # unit test (validazione, i18n, guard delle rotte, DataTable, CSP)
npm run test:rls    # migrazioni + 134 test SQL (isolamento, dedup, licenze, quote, Sales Agent) su Postgres temporaneo
npm run build       # build di produzione
```

`npm run test:rls` richiede PostgreSQL 15+ installato localmente (`initdb`, `pg_ctl`, `psql`). Usa
`supabase/tests/local_supabase_stub.sql` per simulare ruoli e `auth.uid()` di Supabase: lo stub
**non** va applicato al progetto Supabase reale.

## Deploy su Netlify

1. Pubblica il repository su GitHub.
2. Netlify → *Add new site → Import from Git* → seleziona il repository. Build command e cartella di
   pubblicazione sono già in `netlify.toml` (`npm run build`, `dist`).
3. *Site configuration → Environment variables*: imposta `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_APP_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
4. Deploy. Verifica `https://<dominio>/api/health`.
5. Aggiorna Site URL e Redirect URLs in Supabase Auth con il dominio Netlify.

`netlify.toml` include fallback SPA, redirect `/api/*` → functions e header di sicurezza (CSP, HSTS,
X-Frame-Options). La CSP autorizza lo script inline di `index.html` tramite hash: se lo modifichi,
aggiorna l'hash (un test lo verifica).

## API serverless

| Endpoint | Auth | Descrizione |
| --- | --- | --- |
| `GET /api/health` | no | liveness |
| `GET /api/ai-status?organization_id=` | Bearer JWT, membro | stato dei moduli AI |
| `GET /api/lead-finder/providers?organization_id=` | Bearer JWT, membro | fonti configurate, diritti di licenza, stato AI |
| `POST /api/lead-finder/search` | Bearer JWT, membro | ricerca su una fonte (rate limit + quote) |
| `POST /api/lead-finder/import` | Bearer JWT, membro | import CSV (max 1000 righe, base giuridica obbligatoria) |
| `POST /api/lead-finder/analyze` | Bearer JWT, membro | avvia un job di analisi AI (202) |
| `POST /api/lead-finder/analyze-run` | segreto interno | background function che esegue il job |
| `POST /api/lead-finder/save` | Bearer JWT, membro | salva nel CRM i candidati consentiti |
| `POST /api/lead-finder/exclude` | Bearer JWT, membro | esclude/ripristina candidati |
| `GET /api/lead-finder/export` | Bearer JWT, membro | CSV dei soli dati esportabili per licenza |
| `GET /api/sales-agent/status?organization_id=` | Bearer JWT, membro | configurazione AI, completezza profilo, quote |
| `POST /api/sales-agent/generate` | Bearer JWT, membro | avvia un job: `intelligence`, `messages`, `proposal`, `follow_up_suggestion` (202) |
| `POST /api/sales-agent/copilot` | Bearer JWT, membro | domanda al Copilot; crea/continua una conversazione privata (202) |
| `POST /api/sales-agent/run` | segreto interno | background function che esegue i job del Sales Agent |

Le pagine `/dashboard/*` reindirizzano a `/app/*` (es. `/dashboard/lead-finder`).

## AI Lead Finder

### Architettura (`netlify/functions/_shared/lead-finder/`)

| Servizio | File | Ruolo |
| --- | --- | --- |
| Lead Search Service | `services.ts` → `runSearch` | quote, rate limit, avanzamento reale su `lead_searches` |
| Provider Adapter | `providers/*.ts`, `registry.ts` | OpenStreetMap/Overpass, Google Places; licenza dichiarata per provider |
| Lead Normalization | `normalize.ts`, `sectors.ts` | testo, URL sicuri, telefoni, catalogo settori IT/EN ↔ tag OSM |
| Lead Deduplication | `dedup.ts` + vincoli DB | per (org, provider, id esterno) e per dominio o nome+città |
| AI Analysis Service | `analysis/*`, `analysisService.ts` | sito (anti-SSRF, robots.txt), OpenAI Structured Outputs, verifica citazioni |
| Lead Scoring Service | `scoring.ts` | 5 criteri, pesi da `organization_profiles` |
| CRM Persistence | `services.ts` → `saveToCrm`, `supabaseStore.ts` | lead con fonte, punteggio e analisi |

Ogni endpoint verifica il JWT e l'appartenenza all'organizzazione **prima** di usare la service role; ogni
query server filtra per `organization_id`. I log sono JSON senza dati personali né segreti.

### Fonti integrate e limiti di licenza

| Fonte | Memorizzazione | Export CSV | CRM | Note |
| --- | --- | --- | --- | --- |
| OpenStreetMap (Overpass) | sì | sì, con attribuzione | sì | ODbL. L'istanza pubblica `overpass-api.de` chiede server propri o a pagamento per l'uso commerciale e sconsiglia app su netlify.app: serve `OVERPASS_API_URL`. Copertura di siti/telefoni variabile. |
| Google Places (New) | solo `place_id` | no | no | Per clienti SEE gli usi consentiti sono un elenco chiuso che non copre esplicitamente le liste lead; solo place_id memorizzabile. Risultati mostrati in sessione; il vincolo è anche nel DB (`lead_candidates_license_storage`). |
| Import CSV | sì | sì | sì | Dati acquisiti legittimamente, base giuridica e conferma obbligatorie. |

Per aggiungere un provider B2B con licenza: implementare `ProviderAdapter`, dichiarare i diritti in
`license` dopo aver letto i termini, registrarlo in `registry.ts`.

### Scoring

Compatibilità settore 30 · geografica 20 · cliente ideale 25 · segnali verificabili 15 · completezza 10
(pesi modificabili in *AI Lead Scoring*, somma 100). Priorità: alta ≥ 80, media ≥ 50, bassa < 50.
Senza analisi AI il punteggio è marcato **preliminare** (cliente ideale e segnali a 0). I segnali contano
solo se la citazione compare davvero nel testo del sito.

### Analisi AI

Il sito viene letto solo se `robots.txt` lo consente, tramite fetch con DNS verificato alla connessione
(blocco IP privati/metadata), porte 80/443, max 3 redirect, 600 KB, timeout. Le email vengono rimosse
prima dell'invio a OpenAI (`store: false`). Ogni citazione non trovata nel testo viene declassata a
ipotesi; le esigenze digitali sono sempre ipotesi. Il credito si consuma solo ad analisi riuscita.

### Costi da configurare

- **Google Places**: la ricerca richiede sito e telefono, quindi ogni pagina (max 20 risultati, fino a 3
  pagine per ricerca) è fatturata con lo SKU *Text Search Enterprise*. Imposta budget e quote nel Google Cloud Console.
- **Overpass**: dipende dal provider scelto (abbonamento) o dai costi del server self-hosted.
- **OpenAI**: una chiamata per analisi (≈ 2–5k token in ingresso, ≤ 4k in uscita); consumo registrato in `ai_jobs`.
- **Quote interne** (`organization_quotas`, default per mese): 50 ricerche, 1000 risultati, 100 analisi AI,
  20 richieste/minuto per utente. Si modificano via SQL (service role).

## AI Sales Agent

Pagine: `/app/sales-agent` (KPI, grafici, filtri 7/30/90/365 giorni; alias
`/dashboard/sales-agent`), `/app/sales-agent/profile`, `/app/sales-agent/leads/:id` (schede Panoramica,
Messaggi, Proposte, Follow-up, Cronologia), `/app/crm/pipeline`, `/app/follow-up`. Dal Lead Finder un
lead salvato si apre con "Apri nel Sales Agent".

### Architettura (`netlify/functions/_shared/sales-agent/`)

| File | Ruolo |
| --- | --- |
| `validation.ts` | input zod (unione discriminata per compito), limiti di lunghezza |
| `service.ts` | `requestSalesJob` / `requestCopilot` (autorizzazione, quote, job) e `runSalesJob` (esecuzione) |
| `context.ts` | profilo e lead minimizzati per il modello: niente email, telefoni o nomi di persone |
| `sanitize.ts` | neutralizza testo esterno (siti, note, campi lead) prima del prompt |
| `prompts.ts` | regole di sistema + istruzioni per compito; i dati vanno in `<dati_non_attendibili>` |
| `schemas.ts` | JSON Schema strict per OpenAI + zod per rivalidare la risposta |
| `postcheck.ts` | controlli dopo la generazione: email, URL, telefoni, importi, promesse, fatti non supportati |
| `costs.ts` | stima costo e limite di token in uscita per compito |
| `supabaseStore.ts` | persistenza (service role solo dopo verifica JWT e membership) |

Flusso: l'endpoint verifica JWT, appartenenza, configurazione AI, rate limit e quote → crea un record
`ai_jobs` → avvia la background function con il segreto interno → il client segue lo stato del job
(polling RLS su `ai_jobs`) → le bozze vengono salvate come `message_drafts`/`sales_proposals` in stato `draft`.

### Sicurezza dei contenuti AI

- Le regole di sistema sono fisse nel codice; siti, note, nomi e campi del lead sono passati come dati
  JSON non attendibili. Frasi che sembrano istruzioni ("ignora le istruzioni…", marcatori di ruolo)
  vengono sostituite prima dell'invio.
- La risposta è validata due volte (Structured Outputs strict + zod). Dopo la generazione: email
  rimosse; URL, telefoni e importi accettati solo se presenti nel profilo/listino o nei dati del lead;
  promesse ("garantito", "100%"…) e fatti non verificabili segnalati come avvisi visibili.
- Il Copilot riceve solo dati dell'organizzazione corrente (RLS + filtri server) e separa **fatti**,
  **inferenze** e **suggerimenti**; le azioni proposte su lead non contattabili vengono declassate.

### Conformità commerciale

- **Nessun invio automatico.** Nessuna integrazione email, LinkedIn, WhatsApp o telefonia è configurata.
  Per i messaggi è disponibile solo "Copia testo"; per le proposte "Segna come inviata da me" registra un invio fatto fuori dalla piattaforma.
- **Approvare ≠ autorizzare l'invio.** L'interfaccia lo ripete in testata e alla conferma di ogni approvazione.
- **Email pubblica ≠ consenso marketing.** La scheda Conformità mostra fonte e base giuridica del lead e
  ricorda di verificarla prima del contatto.
- Il database blocca (trigger, non solo UI): approvazione di bozze, invio manuale di proposte e
  follow-up di contatto per lead in opposizione, soppressi o `not_contactable`; un lead in opposizione
  è forzato in `not_contactable`. Lo spostamento a won/lost chiude le opportunità e annulla i follow-up di contatto.

### Pipeline

12 fasi: `new`, `qualified`, `to_contact`, `contacted`, `replied`, `meeting_scheduled`,
`proposal_sent`, `negotiation`, `won`, `lost`, `follow_up`, `not_contactable`. Ogni cambio di fase è
registrato da trigger in `activities` (da/a, utente responsabile). Alternativa accessibile al
drag-and-drop: un menu "Sposta in" su ogni scheda, utilizzabile da tastiera e screen reader.

### Follow-up

Cadenza configurabile nel profilo (predefinita 3/7/14 giorni). All'approvazione di una proposta
vengono pianificati: primo contatto di verifica, secondo contatto, revisione dell'opportunità. I compiti
di contatto non si possono creare o completare per lead non contattabili.

### Limiti e costi

- **Quote mensili** (`organization_quotas`): 300 generazioni AI, 3.000.000 token AI; rate limit 20
  richieste/minuto per utente. Si modificano via SQL (service role). Il riepilogo è in `usage_summary`
  (costo stimato visibile solo agli admin).
- **Token massimi in uscita per chiamata**: intelligence 3000, messaggi 4000, proposta 4000,
  suggerimento follow-up 2000, Copilot 2500. Input tipico 2–6k token (profilo + lead + analisi).
- **Costo**: ogni job salva token in ingresso/uscita e, se configurati i prezzi
  (`OPENAI_PRICE_*_PER_MTOK`), il costo stimato in `ai_jobs.cost_usd`. I prezzi variano per modello:
  consulta il listino OpenAI e imposta budget e limiti anche nella dashboard OpenAI.

## Roadmap

- **Fase 2 (completata)**: AI Lead Finder, Business Analyzer, Lead Scoring.
- **Fase 3 (completata)**: AI Sales Agent, pipeline a 12 fasi, follow-up, Copilot.
- **In preparazione**: export PDF delle proposte; integrazioni di invio (email/LinkedIn/WhatsApp) con
  consenso verificato e doppia conferma; Campaign Manager; Analytics; Stripe (checkout, portale, webhook).
