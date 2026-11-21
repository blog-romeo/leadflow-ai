# LeadFlow AI

Piattaforma SaaS multi-tenant per trovare, analizzare, qualificare e gestire opportunità commerciali B2B.

**Stato: Prompt 5 — Super Admin, White Label & SaaS Control Center** (sopra la Fase 5 Billing). Console
`/super-admin` (panoramica, aziende, utilizzo e costi, rivenditori, impostazioni, audit), portale `/reseller` con
inviti clienti, branding dinamico e domini personalizzati verificati via DNS, abbonamenti White Label su Stripe
(test mode), feature flag, sospensioni motivate e audit amministrativo. Vedi la sezione **Control Center & White Label**.

**Fase 5 — Stripe Billing & SaaS Monetization (Prompt 4), in modalità test.** Abbonamenti Stripe (Checkout
ospitato, Customer Portal, webhook firmati e idempotenti), tre piani configurabili, controllo delle funzionalità lato
server e nel database, motore crediti AI con prenotazione atomica, quote di nuovi lead deduplicate, dashboard
`/dashboard/billing` e Revenue Analytics per il Super Admin. Vedi la sezione **Billing (Stripe)**.

**Fase 4 (Campaign Manager & Automation Engine).** Oltre a fondamenta, **AI Lead Finder** e
**AI Sales Agent** sono operativi nel codice: **Campaign Manager** (builder in 6 passi, verifica di idoneità per
paese/canale/base giuridica, contenuti AI con segnaposto, approvazione e attivazione esplicita), **motore di
automazione** (job con lease, retry con backoff, dead-letter, idempotenza), **provider email Resend** (API key
cifrata, verifica dominio SPF/DKIM/DMARC, webhook firmati, disiscrizione one-click), **Comunicazioni** (risposte
ricevute con analisi AI), **Analytics** con denominatori espliciti e **Automazioni** a regole. Nessun invio avviene
senza provider collegato, dominio verificato e conferma esplicita di un amministratore. Nessun dato simulato viene
mostrato come reale: i mock esistono solo nei test.

> Gli invii reali, i webhook e il motore pianificato **non sono stati verificati contro servizi live**
> (Resend, Supabase e Netlify di produzione): sono coperti da test automatici con provider simulato
> a livello HTTP e da test SQL. Vedi "Limiti e verifiche" più sotto.

## Stack

| Livello | Tecnologia |
| --- | --- |
| Frontend | React 18, Vite, TypeScript (strict), Tailwind CSS v4, React Router 6 |
| Backend dati | Supabase PostgreSQL, Auth, Row Level Security |
| Serverless | Netlify Functions (`netlify/functions`, esposte su `/api/*`) |
| AI | OpenAI Responses API (Structured Outputs), solo lato server |
| Pagamenti | Stripe Checkout ospitato, Customer Portal, webhook firmati (API REST ufficiale, versione fissata) |

## Struttura

```
src/
  components/      ui/ (design system), layout/ (AppShell, AuthLayout), FlowVisual
  config/          modules.ts (registro dei 12 moduli), countries.ts
  contexts/        AuthContext (sessione, profilo, membership, org corrente), ThemeContext
  i18n/            it.ts (predefinita), en.ts, provider
  lib/             supabase client (solo anon key), env, validation, errors, tipi DB
  features/        lead-finder/, sales/ (generatore, proposte, follow-up, pipeline, Copilot, grafici),
                   campaigns/ (builder, idoneità, contenuti, monitoraggio, consensi)
  pages/           Landing, auth/*, Onboarding, app/* (Dashboard, Crm, Pipeline, FollowUps, LeadFinder,
                   SalesDashboard, SalesProfile, SalesLead, Settings, Billing, SuperAdmin, ModulePreview)
  routes/guards    RequireAuth, RequireOrganization, RequireSuperAdmin, PublicOnly
netlify/functions  health, ai-status, lead-finder-*, sales-agent-*, communication-*, campaigns-*, inbox-*,
                   webhooks-resend, unsubscribe, automation-tick (pianificata), automation-worker (background),
                   billing-* (status, checkout, portal, change-plan, cancel), stripe-webhook, admin-revenue,
                   _shared (auth, http, dispatch, lead-finder/, sales-agent/, campaigns/, billing/)
supabase/
  migrations/      0001 schema · 0002 sicurezza/RLS · 0003 Lead Finder · 0004 tipi attività · 0005 Sales Agent
                   · 0006 Campaign Manager · 0007 Billing · 0008 Control Center & White Label
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
| `LEADFLOW_CREDENTIALS_KEY` | solo Netlify Functions | 32 byte base64: cifra le credenziali dei provider (AES-256-GCM) e firma i link di disiscrizione |
| `URL` | impostata da Netlify | URL del sito, usata per link di disiscrizione e invocazione del worker |
| `STRIPE_SECRET_KEY` | solo Netlify Functions | chiave segreta Stripe. In sviluppo **solo** `sk_test_…`/`rk_test_…` |
| `STRIPE_PUBLISHABLE_KEY` | facoltativa | `pk_test_…`: non serve al flusso (Checkout ospitato); se presente deve essere della stessa modalità |
| `STRIPE_WEBHOOK_SECRET` | solo Netlify Functions | `whsec_…` dell'endpoint webhook (Stripe Dashboard o `stripe listen`) |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_BUSINESS`, `STRIPE_PRICE_ENTERPRISE` | solo Netlify Functions | Price ID ricorrenti mensili (`price_…`); sovrascrivibili da `billing_plans.stripe_price_id` |
| `STRIPE_LIVE_MODE_APPROVED` | solo Netlify Functions | deve valere `yes-i-approve-live-payments` per usare chiavi live: senza, il billing si blocca |
| `STRIPE_API_VERSION` | facoltativa | default `2025-03-31.basil` (versione con cui il codice è scritto) |
| `APP_URL` | facoltativa | URL per i redirect di Checkout/Portale; se assente si usa `URL` di Netlify |

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
6. `supabase/migrations/20261121000006_campaign_manager.sql`
7. `supabase/migrations/20261122000007_billing.sql`
8. `supabase/migrations/20261123000008_control_center_white_label.sql`

La migrazione 0005 sostituisce l'enum `lead_status` con le 12 fasi della pipeline: i lead esistenti in
`proposal` passano a `proposal_sent`; nessun dato viene cancellato. Le organizzazioni esistenti ricevono
un profilo commerciale vuoto.

La migrazione 0006 **rinomina senza perdere dati** `contact_suppressions` → `suppression_entries` (resta una vista
di compatibilità in sola lettura) e `campaign_leads` → `campaign_recipients`; gli stati delle campagne esistenti
vengono convertiti (`active` → `running`, `archived` → `completed`).

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
npm run test:rls    # migrazioni + test SQL (isolamento, dedup, licenze, quote, Sales Agent, campagne, billing) su Postgres temporaneo
npm run test:billing-concurrency  # 40 prenotazioni crediti e 30 conteggi lead in parallelo: mai oltre quota
npm run build       # build di produzione + robots.txt/sitemap.xml (scripts/generate-seo.mjs)
npm run stripe:preflight  # controllo in sola lettura dell'account Stripe di TEST (vedi docs/STRIPE_TEST_PLAN.md)
```

`npm run test:rls` esegue per ultimo `rls_tests_zz_security_audit.sql`: RLS su tutte le tabelle, `search_path` delle
funzioni SECURITY DEFINER, privilegi di `anon` e delle funzioni solo-server.

`npm run test:rls` richiede PostgreSQL 15+ installato localmente (`initdb`, `pg_ctl`, `psql`). Usa
`supabase/tests/local_supabase_stub.sql` per simulare ruoli e `auth.uid()` di Supabase: lo stub
**non** va applicato al progetto Supabase reale.

## Deploy su Netlify

> Checklist completa (variabili, Supabase Auth, Stripe test, webhook, dominio, HTTPS, smoke test):
> **`docs/DEPLOY_NETLIFY.md`**. Operazioni, backup e ripristino: `docs/OPERATIONS.md`. Audit di sicurezza:
> `docs/SECURITY_AUDIT.md`. Stato di rilascio: **`RELEASE_READINESS.md`**.

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
| `GET /api/communication/providers?organization_id=` | Bearer JWT, membro | provider, prerequisiti del server, account (mai credenziali) |
| `POST /api/communication/accounts` | Bearer JWT, admin | `create`, `refresh`, `webhook_secret`, `limits`, `revoke` |
| `POST /api/communication/test-send` | Bearer JWT, admin | invio di prova verso sandbox Resend o membri dell'organizzazione |
| `POST /api/campaigns/generate-content` | Bearer JWT, membro | 3 varianti AI per uno step email (202) |
| `POST /api/inbox/actions` | Bearer JWT, membro | `reply` (con conferma esplicita) o `analyze` di una risposta ricevuta |
| `POST /api/webhooks/resend/:accountId` | firma Svix | eventi di consegna e risposte ricevute |
| `GET/POST /api/unsubscribe?t=` | token HMAC | pagina di conferma (GET) e disiscrizione one-click (POST, RFC 8058) |
| `POST /api/automation/worker` | segreto interno | background function che esegue i job di automazione |
| `automation-tick` | pianificata (ogni minuto) | step in scadenza, eventi → workflow, avvio del worker |
| `GET /api/billing/status?organization_id=` | Bearer JWT, membro | piano, stato, periodo, crediti/lead/utenti, piani, costi in crediti, fatture (admin) |
| `POST /api/billing/checkout` | Bearer JWT, admin | `{ plan }` → Stripe Customer + Checkout Session ospitata (URL) |
| `POST /api/billing/portal` | Bearer JWT, admin | sessione Stripe Customer Portal |
| `POST /api/billing/change-plan` | Bearer JWT, admin | upgrade (pro-rata subito) o downgrade (credito sulla prossima fattura) |
| `POST /api/billing/cancel` | Bearer JWT, admin | `{ action: 'cancel', confirm: true }` (fine periodo) o `{ action: 'resume' }` |
| `POST /.netlify/functions/stripe-webhook` | firma Stripe | eventi Stripe (vedi sezione Billing) |
| `GET /api/admin/revenue?days=` | Bearer JWT, super admin | Revenue Analytics (solo aggregati) |
| `GET /api/super-admin/{overview,organizations,organization,usage,resellers,settings,audit}` | Bearer JWT, super admin | console di piattaforma (accessi registrati) |
| `POST /api/super-admin/{organization-status,note-add,note-delete,org-ai-cap,setting,flag,flag-override,reseller-create,reseller-update,reseller-status,reseller-member,reseller-external-billing,domain-provisioned}` | Bearer JWT, super admin | azioni amministrative motivate e auditate |
| `GET /api/reseller/{me,dashboard}` | Bearer JWT, membro rivenditore | portale rivenditore |
| `POST /api/reseller/{invitation-create,invitation-revoke,client-plan,branding,branding-asset,domain-add,domain-remove,domain-verify,billing-checkout,billing-portal}` | Bearer JWT, reseller_admin | gestione clienti, branding, domini, abbonamento White Label |
| `GET /api/tenant` | pubblico | branding del dominio White Label della richiesta (solo domini attivi) |
| `GET /api/pricing` | pubblico | piani attivi da `billing_plans` (aggiorna i prezzi del sito) |
| `POST /api/demo` | pubblico, antispam | richiesta di demo (honeypot, tempo minimo, 5/ora per IP-hash, 200/ora globali) |
| `POST /api/events` | pubblico, solo con consenso | `landing_visit`, `pricing_viewed`, `signup_started` (id anonimo, nessun IP) |
| `POST /api/monitoring/client-error` | pubblico, 30/ora | errori JavaScript del browser (sanificati) |
| `POST /api/assistant` | Bearer JWT, membro | assistente di onboarding basato sulla documentazione (20/ora) |
| `GET /api/super-admin/{growth,system,demo-requests,support-tickets}` | Bearer JWT, super admin | crescita, stato del sistema, richieste demo, ticket |
| `POST /api/super-admin/{demo-request,ticket-reply,ticket-status,ticket-read}` | Bearer JWT, super admin | gestione demo e ticket |
| `monitoring-tick` | pianificata (ogni 15 minuti) | valuta le soglie, registra gli avvisi, notifica (se configurato) |
| `POST /api/team/invite` | Bearer JWT, admin | invito collaboratore (email se configurata, altrimenti link per consegna manuale) |
| `retention-tick` | pianificata (03:15 UTC) | conservazione dei dati; **inattiva** senza `RETENTION_PURGE_ENABLED=true` |

Le pagine `/dashboard/*` reindirizzano a `/app/*` (es. `/dashboard/lead-finder`).

## Motore multi-agent (Prompt 8, beta privata spenta di default)

Orchestrator e sette agenti (Discovery, Research, Scoring, Strategy, Follow-up, Growth Analyst) con tool allowlist,
approvazioni esplicite per le operazioni ad alto impatto, budget e audit. Pagine `/dashboard/ai-agents` e
`/dashboard/ai-workflows` (alias di `/app/...`). Attivazione: `AI_AGENTS_ENABLED`, `AI_AGENTS_PILOT_ORGS`,
`VITE_FEATURE_AI_AGENTS`. Architettura, sicurezza, costi ed endpoint: [`docs/AI_AGENTS.md`](docs/AI_AGENTS.md).
Migrazione `20261126000012_ai_agents.sql` (additiva).

**Prompt 9**: envelope JSON validato per ogni esecuzione degli agenti, routing dei modelli per compito, valutazione su
dataset sintetici (`npm run ai:eval`), monitoraggio per il Super Admin (`/super-admin/ai-monitoring`), limite di workflow
concorrenti, export dei risultati, preflight di sola lettura delle integrazioni (`npm run integrations:preflight`).
Migrazione `20261127000013_ai_monitoring_resilience.sql` (additiva). Dettagli: `docs/AI_AGENTS.md` §9.

**Prompt 10**: CI GitHub Actions (`.github/workflows/ci.yml`), verifiche manuali di staging (`staging-checks.yml`),
verifica reale delle connessioni nella console agenti, log senza segreti, avvisi AI, strumenti `staging:e2e` e
`staging:isolation`. Procedura per il proprietario: [`docs/STAGING_RUNBOOK.md`](docs/STAGING_RUNBOOK.md). Migrazione 0014 (additiva).

**Prompt 11**: branch `feature/leadflow-staging-release`, manifest dei file da versionare (`docs/STAGING_RELEASE_MANIFEST.md`),
smoke test di staging (`npm run staging:smoke`).

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

12 fasi: `new`, `to_qualify`, `qualified`, `to_contact`, `contacted`, `in_conversation`,
`meeting_scheduled`, `proposal_sent`, `negotiation`, `won`, `lost`, `not_contactable`. Ogni cambio di fase è
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

## Campaign Manager & Automation Engine

Pagine: `/app/campaigns` (alias `/dashboard/campaigns`: KPI e filtri per data, campagna, canale, stato),
`/app/campaigns/new` e `/app/campaigns/:id` (builder in 6 passi o monitoraggio), `/app/inbox` (alias
`/dashboard/inbox`), `/app/analytics`, `/app/automations`, `/app/settings/channels`. Nella scheda del lead:
registro consensi/opposizioni per canale e tag.

### Flusso di una campagna

1. **Informazioni**: obiettivo, servizio, lingua, canale, data, finestra di invio (fuso orario, giorni feriali).
2. **Destinatari**: filtri su settore, paese, città, punteggio, fase, tag, origine (eseguiti in SQL, max 2000, deduplicati).
3. **Idoneità** (`private.lead_eligibility`, unica fonte di verità): provenienza, base giuridica per paese e
   canale, consensi, opposizioni, preferenze di canale, suppression list. Regole prudenziali (non parere legale):
   email promozionale con consenso registrato ovunque; soft opt-in per clienti esistenti; legittimo interesse
   solo FR e GB (indirizzi professionali); altrove (IT, DE, ES, resto) serve il consenso. LinkedIn e telefono solo
   manuali, WhatsApp solo con opt-in. Un "consenso" dichiarato sulla fonte senza prova registrata non basta.
4. **Contenuti**: modello con segnaposto `{{azienda}}`, `{{citta}}`, `{{settore}}`, `{{nome}}`; 3 varianti AI
   (al modello vanno solo dati aggregati del pubblico). Il server segnala testimonianze, urgenza artificiale,
   finti rapporti pregressi, promesse, importi e link non verificati, segnaposto non ammessi.
5. **Revisione** (`campaign_readiness`): idonei, esclusi con motivi, messaggi previsti, canale, quota, avvisi.
6. **Attivazione**: solo `organization_admin`, con presa visione degli avvisi e conferma del numero di
   destinatari visto in revisione; contenuti e impostazioni restano bloccati e salvati nell'istantanea.

Sequenza predefinita: giorno 0 email, 3 verifica + suggerimento AI (promemoria, nessun invio), 7 follow-up se
ancora consentito, 14 revisione dell'opportunità (giorni dal profilo commerciale).

### Invio e motore dei job

- `automation-tick` (scheduled function, max 30 s) crea job idempotenti per gli step in scadenza e smista gli
  eventi; `automation-worker` (background function, fino a 15 min) li esegue con lease (`FOR UPDATE SKIP LOCKED`).
- Prima di **ogni** invio `public.begin_send` ripete nel database idoneità, stato di campagna e destinatario,
  suppression list, connessione del provider, limiti giornalieri/al minuto e quota mensile.
- Idempotenza: un messaggio per destinatario e step; chiave `Idempotency-Key` di Resend (24 h) sul messaggio,
  quindi un retry dopo un timeout non produce un doppio invio. Oltre 23 h un esito incerto diventa `unknown`.
- Retry con backoff esponenziale (60 s, 120 s… max 1 h, jitter), 5 tentativi, poi dead-letter visibile in
  Automazioni e nel monitoraggio. Finestra di invio e limiti rinviano senza consumare tentativi.
- Arresto immediato (trigger): opposizione, disiscrizione, bounce permanente, reclamo, risposta, appuntamento
  (se previsto), lead non contattabile, revoca o errore della connessione (campagne in pausa), pausa e annullamento.
- Nessun server SMTP: solo API del provider. Nessun tracciamento di aperture o clic.

### Provider email

Implementato: **Resend** (API key per organizzazione, cifrata AES-256-GCM con `LEADFLOW_CREDENTIALS_KEY` in una
tabella senza privilegi client). Il collegamento verifica la chiave registrando il dominio mittente presso
Resend e mostra i record DNS; lo stato diventa "collegato" solo a dominio verificato. DMARC è letto via DNS.
Webhook: URL per account, firma Svix verificata con tolleranza 5 minuti e idempotenza per id evento.
Risposte ricevute: richiedono la ricezione (Inbound) configurata su Resend e l'evento `email.received`.
**Gmail e Microsoft 365 (OAuth)** sono previsti nell'interfaccia ma **non implementati**: richiedono un'app
OAuth verificata da Google/Microsoft.

Ogni email include firma, ragione sociale e indirizzo, motivo del contatto e origine dei dati (art. 14 GDPR),
link all'informativa e link di disiscrizione, più gli header `List-Unsubscribe` e `List-Unsubscribe-Post`.

### Automazioni

Regole evento → azioni: trigger lead qualificato, bozza approvata, campagna attivata, messaggio consegnato,
risposta ricevuta, appuntamento fissato, opportunità aggiornata, opposizione registrata; azioni attività CRM,
notifica interna, bozza AI (da approvare), aggiornamento stato, promemoria, follow-up con suggerimento AI.
**L'invio non è un'azione dei workflow** (vincolo nel database): avviene solo negli step delle campagne attivate.
Stati: bozza → in approvazione → attiva (solo admin) → in pausa/disattivata; modificare una regola attiva la
riporta in bozza.

### Analytics

Reply rate = risposte / consegnati; Appointment rate = appuntamenti / consegnati; Conversion rate = clienti /
lead contattati (+ bounce rate). Ogni tasso mostra numeratore e denominatore. Attribuzione entro 90 giorni dal
primo invio. Le risposte positive contano solo se confermate da una persona (quelle solo AI sono mostrate a parte).
Ricavi solo da opportunità vinte con importo. Invii di prova esclusi; aperture non misurate.

### Limiti e verifiche

- Quote: 1000 email/mese per organizzazione (`organization_quotas.monthly_emails`), limiti per account
  (default 100/giorno, 10/minuto), max 2000 destinatari per campagna.
- Le scheduled function non girano su Deploy Preview/branch deploy; latenza di avvio ≤ 1 minuto.
- Non verificati dal vivo: chiamate reali a Resend, webhook reali, esecuzione pianificata su Netlify, Supabase reale.
  Per il primo collaudo usare gli indirizzi sandbox `delivered@resend.dev`, `bounced@resend.dev`,
  `complained@resend.dev` dall'invio di prova.

## Billing (Stripe)

### Piani iniziali (IVA esclusa, modificabili dal Super Admin)

| Piano | Prezzo | Nuovi lead/mese | Crediti AI/mese | Utenti | Funzionalità |
| --- | --- | --- | --- | --- | --- |
| Starter | 149 € | 250 | 500 | 1 | Lead Finder, AI Analyzer, CRM essenziale, export |
| Business | 349 € | 1.000 | 2.500 | 5 | + AI Sales Agent, Campaign Manager, CRM avanzato |
| Enterprise | 799 € | 5.000 | 10.000 | 20 | tutti i moduli + Analytics avanzate, Automazioni, supporto prioritario |

Prezzi e limiti stanno in `billing_plans` e si modificano da **Super Admin → Configurazione piani** (RPC
`admin_update_billing_plan`, con audit). **L'importo addebitato è sempre quello del Price Stripe**: per cambiare
prezzo crea un nuovo Price su Stripe e aggiorna il Price ID (nel piano o in `STRIPE_PRICE_<PIANO>`). I limiti
nuovi valgono subito per il periodo in corso.

### Crediti AI: definizione tecnica

**1 credito = un'operazione AI completata con successo, con un budget massimo di `tokens_per_credit` token
(input + output, default 6.000).** Se un'operazione supera `crediti × tokens_per_credit` token, la differenza viene
addebitata in crediti aggiuntivi, entro il saldo disponibile (mai saldi negativi). Le operazioni fallite non costano.
I crediti si azzerano a ogni periodo di fatturazione Stripe.

| Operazione (`ai_credit_costs`) | Compito AI | Crediti | Funzionalità richiesta |
| --- | --- | --- | --- |
| `lead_analysis` | analisi lead (Business Analyzer) | 1 | AI Analyzer |
| `email_generation` | messaggi commerciali | 1 | AI Sales Agent |
| `proposal` | proposta commerciale | 3 | AI Sales Agent |
| `deep_analysis` | sales intelligence | 5 | AI Sales Agent |
| `follow_up_suggestion`, `copilot_message` | follow-up, Copilot | 1 | AI Sales Agent |
| `campaign_content` | 3 varianti di uno step | 2 | Campaign Manager |
| `inbound_analysis` | analisi di una risposta | 1 | Campaign Manager |

**Valori provvisori**: confrontali con il costo reale per operazione (Revenue Analytics mostra token e costo API
stimato per organizzazione quando `OPENAI_PRICE_*` sono impostate) e correggili da Super Admin.

Motore (`supabase/migrations/20261122000007_billing.sql`):

- **Prenotazione atomica**: un trigger su `ai_jobs` prenota i crediti nella stessa transazione in cui nasce il job
  (lock di riga su `usage_quotas`): nessun job AI può esistere senza crediti, e richieste concorrenti non superano la quota.
- **Conferma** quando il job passa a `succeeded` (con il conteggio dei token), **rimborso** su `failed`/`cancelled`.
- **Idempotenza**: chiave `ai_job:<id>` unica per organizzazione; prenotazioni scadute (job bloccati, default 60 min)
  rimborsate automaticamente; una conferma dopo il rimborso non addebita nulla.
- **Registro consumi** in `usage_ledger`; vincoli `CHECK (… >= 0)` impediscono saldi negativi.

### Quote di nuovi lead

- Verificata **prima** di interrogare il provider (nessun costo se la quota è finita); il limite di risultati della
  ricerca è ridotto alla quota residua (ricerca parziale, segnalata in `plan_leads.partial`).
- Conteggio lato server per **candidate id**: un lead già visto o rivisualizzato non viene ricontato; duplicati nello
  stesso batch contati una volta. In caso di ricerche concorrenti i candidati oltre quota vengono esclusi
  (`excluded_reason = 'lead_quota_exceeded'`) e non possono essere ripristinati finché la quota è esaurita.
- Ogni chiamata a un provider è registrata (`provider_call`) con il costo stimato da `billing_settings.provider_cost_usd`
  (es. `{"google_places": 0.032}`), mostrato nelle Revenue Analytics.

### Controllo delle funzionalità

`canUseFeature(organizationId, feature)` (`_shared/billing/access.ts` → RPC `billing_can_use_feature`) è chiamato
negli endpoint: Lead Finder (search/import/save/exclude), AI Analyzer, AI Sales Agent (generate/copilot), Campaign
Manager (contenuti, canali email, invio di prova, inbox), Export. Risposta **402** con codice `billing_*`.
Il database applica gli stessi controlli anche senza passare dalle API: job AI (trigger), attivazione campagne
(`campaigns_zbilling_guard`), attivazione automazioni (`automation_workflows_zbilling_guard`), numero di utenti
(`organization_members_billing_limit`). Quando l'abbonamento termina o si passa a un piano inferiore, campagne e
automazioni in corso vanno **in pausa** automaticamente (`paused_reason = 'billing_inactive'`).

Accesso: `active`, `trialing` e `past_due` (durante i tentativi di incasso di Stripe, disattivabile con
`billing_settings.past_due_grace`). `unpaid`, `canceled`, `incomplete*`, `paused` → solo CRM e dati esistenti.

### Flusso di checkout

1. L'admin sceglie un piano in `/dashboard/billing` → `POST /api/billing/checkout`.
2. Il server verifica JWT, appartenenza e ruolo admin; rifiuta se esiste già un abbonamento (si usa cambio piano/portale).
3. Crea o recupera lo **Stripe Customer** (Idempotency-Key per organizzazione, mappatura in `stripe_customers`).
4. Crea la **Checkout Session** ospitata (`mode=subscription`, indirizzo di fatturazione e partita IVA raccolti da Stripe).
5. L'utente paga su Stripe (nessun dato di carta passa dai nostri server).
6–8. Stripe invia il webhook → firma verificata → stato dell'abbonamento **riletto da Stripe** e salvato.
9–10. Il piano viene assegnato e la dashboard (che al ritorno interroga il database ogni 3 s) mostra lo stato aggiornato.

Il redirect alla pagina di successo **non attiva nulla**: senza webhook l'abbonamento non esiste.

### Webhook

Endpoint: **`https://<dominio>/.netlify/functions/stripe-webhook`**. Eventi gestiti:
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

- Firma `Stripe-Signature` verificata sul **body grezzo** (HMAC-SHA256, tolleranza 5 minuti, confronto a tempo costante).
- **Idempotenza** per `event.id` (`stripe_webhook_events`): duplicati → 200 senza rielaborazione; evento in corso
  altrove → 409 (Stripe ritenta); errori temporanei → 500 e retry sicuro (tutte le scritture sono idempotenti).
- **Eventi fuori ordine**: il payload non viene usato per lo stato; abbonamenti, fatture e sessioni vengono riletti da
  Stripe, e uno stato letto prima di quello già salvato viene scartato (`stripe_synced_at`).
- Il customer deve essere quello creato da LeadFlow per l'organizzazione; metadati incoerenti → evento ignorato.
- Eventi live con chiavi test (e viceversa) ignorati. Nessun payload né dato sensibile salvato o loggato.

### Configurazione (modalità test)

1. Stripe Dashboard in **Test mode** → crea un prodotto per piano con un **Price ricorrente mensile** in EUR
   (149/349/799, IVA esclusa: *tax behavior = exclusive* se usi Stripe Tax).
2. *Developers → Webhooks → Add endpoint*: URL sopra, i 6 eventi elencati. Copia il signing secret (`whsec_…`).
3. *Settings → Billing → Customer portal*: abilita aggiornamento metodo di pagamento, fatture, cancellazione **a fine
   periodo** e (facoltativo) cambio piano tra i 3 Price.
4. Netlify → *Site configuration → Environment variables* (scope *Functions*): `STRIPE_SECRET_KEY` (sk_test),
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_BUSINESS`, `STRIPE_PRICE_ENTERPRISE`
   (facoltative: `STRIPE_PUBLISHABLE_KEY`, `APP_URL`). Mai con prefisso `VITE_`. Poi *Deploy*.
5. In locale: `stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook` (con `netlify dev`) e usa
   il `whsec_` stampato dalla CLI. Carta di test `4242 4242 4242 4242`; `4000 0000 0000 0341` per pagamenti falliti.

**Passaggio a Stripe Live**: richiede chiavi live, nuovi Price e webhook live **e** `STRIPE_LIVE_MODE_APPROVED=yes-i-approve-live-payments`.
Senza quest'ultima il server rifiuta le chiavi live. I customer di test non vengono riutilizzati in live.

**Rollout**: dopo la migrazione i limiti sono **applicati subito** (le organizzazioni senza abbonamento perdono l'accesso
ai moduli a pagamento, non ai dati). Per un passaggio graduale, nel SQL Editor:
`select private.billing_set_enforcement(false);` (e `true` per riattivare). Per pilot o uso interno l'operatore può
concedere un piano senza Stripe: `select private.billing_grant_manual_plan('<org_id>', 'business', 'pilot');`
(revoca con `private.billing_revoke_manual_plan`). Nessun utente né Netlify Function può farlo.

### Fiscalità

Le fatture/ricevute di Stripe **non** rendono automaticamente conforme la fatturazione italiana (fattura elettronica
SdI, obblighi di venditore e cliente, reverse charge UE). La dashboard lo dichiara esplicitamente. Valuta con il
commercialista Stripe Tax e un'integrazione SdI prima del go-live. Le Revenue Analytics escludono sempre le imposte:
MRR dai prezzi (IVA esclusa), incassi netti = importo pagato × (totale senza imposte / totale).

### Revenue Analytics (Super Admin)

MRR contrattuale (abbonamenti `active` + `past_due`, normalizzato al mese) e ARR = MRR × 12, distinti dagli
**incassi effettivi** (fatture pagate nel periodo, al netto delle imposte); abbonamenti attivi, nuovi, cancellazioni,
churn (cancellazioni ÷ attivi a inizio periodo), pagamenti falliti, consumo AI per organizzazione, costo API stimato
(da `ai_jobs.cost_usd`) e costi provider, margine operativo stimato (incassi netti − costi stimati; esclude
commissioni Stripe e altri costi; EUR e USD non convertiti). Solo aggregati: nessun dato commerciale dei tenant.

### Limiti e verifiche del billing

- **Non eseguito contro Stripe reale**: in questo ambiente non c'è accesso di rete a Stripe né chiavi di test. Checkout,
  portale, webhook reali e build di produzione vanno collaudati come descritto sopra.
- L'integrazione usa l'**API REST ufficiale** di Stripe con versione fissata (`STRIPE_API_VERSION`) dietro l'interfaccia
  `StripeGateway` (`_shared/billing/stripeClient.ts`), non il pacchetto npm `stripe`: in questo ambiente non era
  installabile. La verifica della firma implementa lo schema documentato da Stripe. Sostituire il trasporto con l'SDK
  richiede di modificare solo quel file.
- Le quote tecniche preesistenti (`organization_quotas`, mese di calendario) restano come limite di sicurezza e vengono
  alzate automaticamente ai valori del piano.

## Control Center & White Label (Prompt 5)

### Ruoli e permessi

| Ruolo | Dove | Come si ottiene | Può |
| --- | --- | --- | --- |
| `super_admin` | `profiles.platform_role` | **solo** da SQL Editor (ruolo `postgres`): `select private.set_platform_role('email', 'super_admin', 'motivazione');` | console `/super-admin`: aziende, consumi, costi, rivenditori, impostazioni, audit. Non vede lead, campagne o messaggi dei tenant |
| `reseller_admin` | `reseller_members.role` | assegnato dal super admin | portale `/reseller`: inviti, piani dei clienti, branding, domini, abbonamento White Label |
| `reseller_member` | `reseller_members.role` | assegnato dal super admin | portale in sola lettura (senza inviti né token DNS) |
| `organization_admin` | `organization_members.role` | creazione dell'organizzazione o invito accettato | come nelle fasi precedenti |
| `organization_member` | `organization_members.role = 'member'` | — | come nelle fasi precedenti |

Protezioni: un trigger su `profiles` impedisce a **anon, authenticated e service_role** di creare o modificare un
`super_admin` (i metadati della registrazione pubblica sono ignorati); `private.set_platform_role` non è eseguibile
da nessun ruolo API. Ogni endpoint verifica il ruolo in TypeScript **e** ogni RPC lo ricontrolla nel database
(`private.require_super_admin`, `private.require_reseller`). Azioni amministrative: motivazione obbligatoria
(≥ 10 caratteri), rate limit (30/min per super admin, 20/min per rivenditore, 10/min accettazione inviti) e scrittura
in `admin_audit_logs` (append-only). Gli accessi alla console sono registrati (`console.access`, deduplicati 5 min).

### Isolamento

- Un'organizzazione appartiene al massimo a un rivenditore (`reseller_organizations` con PK su `organization_id`).
- I rivenditori vedono **solo anagrafica e consumi aggregati** dei propri clienti: le policy RLS su lead, fonti,
  campagne e messaggi non cambiano. Nessun accesso a clienti, inviti, branding, domini o fatture di altri rivenditori.
- I test SQL verificano isolamento organizzazioni ↔ rivenditori, rivenditore ↔ rivenditore e member ↔ admin.

### Clienti dei rivenditori e fatturazione White Label

- Il rivenditore **invita** un cliente (email, ragione sociale, piano tra quelli ammessi dal suo piano White Label).
  Il link `/invite?token=…` vale 14 giorni, una volta, solo per l'account con la stessa email; il token è salvato come
  hash SHA-256. **L'invio email non è automatico**: il rivenditore copia e condivide il link.
- Limite clienti: clienti attivi + inviti pendenti ≤ `max_organizations` del piano (o override del super admin).
- Il cliente usa i moduli con il piano assegnato dal rivenditore **finché il rivenditore è attivo e il suo abbonamento
  White Label dà accesso**; un abbonamento Stripe proprio del cliente ha la precedenza. Sospensione o fine abbonamento
  del rivenditore → clienti senza accesso, campagne e automazioni in pausa.
- Piani White Label (`reseller_plans`, configurabili): **Agency** setup 2.990 € + 399 €/mese (25 clienti, 1 dominio,
  piani cliente Starter/Business), **Premium** setup 5.990 € + 799 €/mese (100 clienti, 10 domini, tutti i piani).
  Checkout Stripe con canone ricorrente + quota di attivazione una tantum (solo al primo abbonamento), Customer Portal,
  rinnovi, pagamenti falliti e cancellazioni tramite **lo stesso webhook** (`/.netlify/functions/stripe-webhook`): il
  customer viene riconosciuto come organizzazione o come rivenditore; nulla cambia per gli abbonamenti delle organizzazioni.
- Contratti fatturati fuori da Stripe: il super admin può registrare un "contratto esterno" motivato
  (`reseller_subscriptions.source = 'external'`). Non crea né modifica abbonamenti Stripe.
- Prezzo **wholesale** per cliente e piano (definito dal super admin): mostrato come costo stimato a rivenditore e
  piattaforma; **non viene addebitato automaticamente** (fatturazione esterna). La fatturazione dei clienti finali è
  del rivenditore, con procedure proprie. **Stripe Connect / split payment non sono implementati.**

### Branding dinamico

Un solo frontend: `GET /api/tenant` risolve il tenant dall'**hostname della richiesta** (lato server, mai da parametri)
e restituisce solo campi pubblici rivalidati; `TenantProvider` applica nome, logo, favicon, colori (variabili CSS
generate solo da valori `#rrggbb`), tema predefinito, testi e link della pagina di login. Validazione: testi senza `<`/`>`,
URL solo `https://`, email, colori esadecimali (vincoli SQL + rivalidazione server e client). Upload loghi:
PNG/JPEG/WebP (favicon PNG/ICO), tipo riconosciuto dai **magic bytes** e confrontato con il MIME dichiarato, limiti di
peso (512/128 KB) e pixel (2048/512 px), **SVG rifiutato**, nome file generato dal server, bucket Storage `branding`
pubblico in lettura e scrivibile solo dalla service role (creato dalla migrazione se lo schema `storage` esiste).

### Domini personalizzati

Stati: `pending_verification` → `verified` (record TXT `_leadflow-challenge.<host>` = `leadflow-verify=<token>`) →
`active` (CNAME verso la destinazione configurata **e** alias confermato dal super admin **e** `https://<host>/api/health`
risponde come LeadFlow). Solo i domini `active` di rivenditori attivi applicano il branding; domini non verificati,
rimossi o sconosciuti → marchio predefinito. Controlli DNS lato server (timeout), richiesta HTTPS tramite il fetch
anti-SSRF, massimo una verifica ogni 30 s per dominio. Ammessi solo sottodomini (es. `app.agenzia-cliente.it`);
rifiutati domini della piattaforma, `*.netlify.app`, domini riservati e IP.

**Provisioning sull'hosting: NON automatico.** Verifica fatta sull'infrastruttura Netlify (docs e forum ufficiali):
Netlify consiglia al massimo ~50 alias per sito e ha un limite rigido intorno a 100 domini per sito; le modifiche agli
alias sono soggette a limiti di frequenza (sul piano Free 3 modifiche/ora) e i certificati Let's Encrypt hanno limiti
settimanali per nome. L'API `PATCH /api/v1/sites/{id}` sostituisce l'intero elenco `domain_aliases`: un errore di
integrazione può rimuovere alias esistenti. Per questo il collegamento resta un passaggio manuale del super admin
(Netlify → Domain management → *Add domain alias*, poi "Conferma alias configurato" in console). Oltre qualche decina
di domini serve un'architettura diversa (più siti, wildcard su piano Pro con DNS Netlify, o un proxy/CDN dedicato).

### Utilizzo, costi e operazioni costose

`/super-admin/usage`: token per modello e costo stimato (da `ai_jobs`, prezzi `OPENAI_PRICE_*`), richieste e
operazioni fallite, provider dati (`provider_cost_events`, costi da `billing_settings.provider_cost_usd`), crediti
commerciali e lead (riportati **separatamente** dai token), costo e incassi per organizzazione e per piano, grafici
giornalieri, avvisi (budget di piattaforma, tetto per organizzazione, tasso di errore, prezzi mancanti).
Limiti: budget AI mensile con soglia di avviso e blocco opzionale, tetto mensile per organizzazione (predefinito o
specifico), sospensione immediata di tutte le operazioni AI o di singoli provider dati — applicati da trigger su
`ai_jobs` e dalla registrazione delle chiamate provider (risposta 503 `platform_*`). I tetti usano il costo già
registrato: un job in corso può superarli di una singola operazione.

### Feature flag

`feature_flags` (`lead_finder`, `ai_analyzer`, `sales_agent`, `campaign_manager`, `advanced_analytics`,
`custom_branding`, `custom_domain`, `reseller_portal`) con override per organizzazione o rivenditore. Si **sommano**
ai controlli di piano e permessi (`private.feature_check`): un flag attivo non concede nulla senza abbonamento.

### Sospensione amministrativa

`organizations.admin_status`: sospensione e riattivazione motivate, registrate in audit e nello storico eventi; moduli
bloccati (`organization_suspended`), job AI rifiutati, campagne e automazioni in pausa, **dati sempre leggibili**
dall'organizzazione. Lo stato dei pagamenti Stripe non viene toccato.

### Configurazione richiesta

1. Applica la migrazione 0008. Nomina i super admin con `private.set_platform_role` (SQL Editor).
2. Supabase Storage: verifica che esista il bucket pubblico `branding` (lo crea la migrazione).
3. Super Admin → Impostazioni → *Destinazione CNAME* (es. `<sito>.netlify.app`).
4. Stripe test mode: crea i Price Agency/Premium (ricorrente mensile + una tantum di attivazione) e imposta
   `STRIPE_PRICE_RESELLER_AGENCY(_SETUP)` / `STRIPE_PRICE_RESELLER_PREMIUM(_SETUP)` su Netlify. Il webhook resta lo stesso.
5. Per ogni dominio: il rivenditore configura TXT + CNAME, verifica; il super admin aggiunge l'alias su Netlify e conferma.

### Costi infrastrutturali da verificare

Piano Netlify (domini alias e limiti di frequenza, certificati, invocazioni delle functions e banda), Supabase
(Storage ed egress delle immagini, dimensione del database per audit e ledger), commissioni Stripe su canoni e
attivazioni, eventuale DNS/CDN dedicato oltre i ~50–100 domini, costo dei modelli AI e dei provider dati (da impostare
in `OPENAI_PRICE_*` e `provider_cost_usd` perché le stime siano significative).

## Collaboratori e inviti (Prompt 7)

Migrazione 0010. Da **Impostazioni → Collaboratori** un `organization_admin` invita per email scegliendo il ruolo
(`member` o `organization_admin`), revoca gli inviti e rimuove i collaboratori. Regole applicate dal database:

- token casuale da 192 bit restituito **una sola volta**; nel database solo l'hash SHA-256 (colonna non leggibile dagli utenti);
- monouso, scadenza 7 giorni, valido solo per l'email invitata e con email **confermata** (`auth.users.email_confirmed_at`);
- limite utenti del piano: membri + inviti validi ≤ `max_users` (stesso lock del trigger sui membri);
- audit in `audit_logs` (`invitation.created/revoked/accepted`, `member.removed_by_admin`) senza token e con il solo dominio dell'email;
- nessuno può inserirsi da solo in `organization_members` (INSERT revocato; verificato dall'audit dello schema).

Il link è `https://<dominio>/join#t=<token>`: il token sta nel frammento (non arriva ai server) e la pagina lo rimuove
dalla barra degli indirizzi. Se `PLATFORM_NOTIFY_RESEND_API_KEY` e `PLATFORM_NOTIFY_FROM` non sono configurati l'invito
viene comunque creato, l'email è registrata come **non inviata** e l'admin riceve il link da consegnare a mano.

## Lancio, onboarding e crescita (Prompt 6)

**Sito pubblico** (`src/pages/Landing.tsx`, `src/pages/public/*`, layout `PublicLayout`): home con i testi richiesti,
"Come funziona" in 4 passi, 8 funzionalità con stato esplicito (`src/config/features.ts`: Operativa / Beta / In
preparazione), prezzi da `src/config/plans.ts` (coerenti con `billing_plans` — test `plans.test.ts` — e aggiornati
da `/api/pricing`), IVA esclusa e condizioni commerciali, 7 FAQ, `/prezzi`, `/demo` → `/demo/grazie`, pagine legali
`/legal/{privacy,cookie,termini,condizioni-abbonamento,informazioni-societarie,trattamento-dati-b2b,contatti}`.
I testi legali sono **bozze** (`src/content/legal.ts`) con segnaposto `[DA COMPLETARE: …]`, avviso visibile e `noindex`.
Nessuna recensione, cliente, partnership o certificazione è citata; nessun risultato è promesso.

**Registrazione e onboarding guidato** (`src/pages/Onboarding.tsx`, migrazione 0009): 1 account (registrazione con
conferma email) · 2 azienda · 3 profilo commerciale (salvato in `organization_profiles` e `sales_profiles`) · 4 piano ·
5 pagamento (Stripe Checkout con `return_to: 'onboarding'`; il passo avanza **solo** quando il webhook ha attivato
l'abbonamento, `onboarding_advance('payment_confirmed')`) · 6 prima configurazione (dashboard, guida rapida, prima
ricerca, configurazione AI). Lo stato è in `onboarding_progress` e si riprende dal punto lasciato. La dashboard
mostra la checklist calcolata dai dati reali (`onboarding_checklist`).

**Richieste demo** (`/api/demo`): validazione e antispam lato server, salvataggio in `demo_requests` (solo service
role), notifica interna via Resend **solo se** `PLATFORM_NOTIFY_*` è configurato, stati
`new → contacted → scheduled → closed | spam` gestiti dallo staff. Nessun calendario è collegato: l'invio non prenota
un appuntamento.

**Assistente di onboarding** (`/api/assistant`, `src/content/help.ts`): recupera gli articoli della documentazione e,
se OpenAI è configurato, riformula la risposta citando solo quegli articoli; altrimenti mostra gli estratti. Non
esegue azioni, non salva la domanda, rispetta pausa AI e tetti di spesa (job `support_assistant`, senza crediti).

**Centro assistenza** (`/app/support`, alias `/dashboard/support`): guide e FAQ con ricerca, assistente, ticket con
stato e cronologia (`support_tickets`, `support_ticket_messages`: il membro vede i propri, l'admin quelli
dell'organizzazione), notifiche in-app alle risposte dello staff. La chat AI con accesso ai dati è dichiarata
"in preparazione". Console staff: `/super-admin/support`.

**Analytics di crescita** (`funnel_events`, `/super-admin/growth`): eventi generati dal database e deduplicati per
chiave (registrazione, onboarding completato, checkout avviato, abbonamento attivato, prima ricerca, primo lead, prima
analisi AI, demo); dal sito solo con consenso (`landing_visit`, `pricing_viewed`, `signup_started`, id anonimo
casuale, nessun cookie di profilazione, Global Privacy Control rispettato). Metriche: visitatori con consenso,
registrazioni, onboarding completati/abbandonati, attivazione, conversione a pagamento, clienti paganti, MRR.

**SEO**: `useSeo` (title, description, canonical, Open Graph, JSON-LD `SoftwareApplication` e `FAQPage`), meta statici
in `index.html` (lo script inline non è cambiato), `public/og-image.png`, `robots.txt` e `sitemap.xml` generati in build
da `seo/public-routes.json`, `X-Robots-Tag: noindex` sulle aree private in `netlify.toml`, Deploy Preview non indicizzati.

**Monitoraggio** (`/super-admin/system`, `docs/OPERATIONS.md`): errori 500 delle functions ed errori del browser
sanificati e aggregati in `app_errors`; `monitoring-tick` valuta webhook falliti/bloccati, job AI fermi o falliti,
automazioni, errori e costo AI e registra gli avvisi; stato delle integrazioni (solo presenza della configurazione).

**IVA**: `STRIPE_AUTOMATIC_TAX=true` attiva `automatic_tax` nel Checkout (richiede Stripe Tax configurato). Spenta per
impostazione predefinita: vedi `RELEASE_READINESS.md` (HIGH-2).

## Roadmap

- **Fase 2 (completata)**: AI Lead Finder, Business Analyzer, Lead Scoring.
- **Fase 3 (completata)**: AI Sales Agent, pipeline a 12 fasi, follow-up, Copilot.
- **Fase 4 (codice completato, collaudo live da eseguire)**: Campaign Manager, provider Resend, motore di automazione, Comunicazioni, Analytics.
- **Fase 5 (codice completato in modalità test, collaudo con Stripe test da eseguire)**: Stripe Billing, piani, crediti AI, quote lead, Revenue Analytics.
- **Prompt 5 (codice completato, collaudo da eseguire)**: Super Admin Control Center, rivenditori White Label, branding, domini personalizzati (provisioning manuale), feature flag, controllo costi.
- **Prompt 6 (codice completato, collaudo da eseguire — vedi `RELEASE_READINESS.md`)**: sito pubblico, onboarding guidato, demo, assistente, centro assistenza, analytics di crescita, SEO, monitoraggio, bozze legali, audit di sicurezza.
- **Prompt 7**: inviti collaboratori, preflight e piano di test Stripe, checklist fiscale, politica di cancellazione, correzioni di sicurezza, job di conservazione (inattivo), verifica dei test con librerie reali.
- **In preparazione**: provider OAuth (Gmail, Microsoft 365), export PDF delle proposte, fatturazione elettronica SdI, email transazionali di piattaforma (inviti), provisioning automatico dei domini, Stripe Connect.
