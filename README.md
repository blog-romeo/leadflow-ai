# LeadFlow AI

Piattaforma SaaS multi-tenant per trovare, analizzare, qualificare e gestire opportunità commerciali B2B.

**Stato: Fase 2 (AI Lead Finder).** Oltre alle fondamenta della fase 1 (auth, organizzazioni, dashboard,
CRM, RLS) sono operativi: **AI Lead Finder** (ricerca su fonti autorizzate, importazione CSV,
deduplicazione, salvataggio nel CRM, esclusione, export dove consentito), **AI Business Analyzer**
(analisi del sito con OpenAI, lato server) e **AI Lead Scoring** (criteri e pesi configurabili).
Sales Agent, Campagne, Follow-up, Analytics e Billing restano **dichiaratamente "in preparazione"**.
Nessun dato simulato viene mostrato come reale: i mock esistono solo nei test.

## Stack

| Livello | Tecnologia |
| --- | --- |
| Frontend | React 18, Vite, TypeScript (strict), Tailwind CSS v4, React Router 6 |
| Backend dati | Supabase PostgreSQL, Auth, Row Level Security |
| Serverless | Netlify Functions (`netlify/functions`, esposte su `/api/*`) |
| AI (fasi successive) | OpenAI API, solo lato server |
| Pagamenti (fasi successive) | Stripe, webhook lato server |

## Struttura

```
src/
  components/      ui/ (design system), layout/ (AppShell, AuthLayout), FlowVisual
  config/          modules.ts (registro dei 12 moduli), countries.ts
  contexts/        AuthContext (sessione, profilo, membership, org corrente), ThemeContext
  i18n/            it.ts (predefinita), en.ts, provider
  lib/             supabase client (solo anon key), env, validation, errors, tipi DB
  pages/           Landing, auth/*, Onboarding, app/* (Dashboard, Crm, Settings, Billing, SuperAdmin, ModulePreview)
  routes/guards    RequireAuth, RequireOrganization, RequireSuperAdmin, PublicOnly
netlify/functions  health, ai-status, _shared (auth server-side, http)
supabase/
  migrations/      0001 schema · 0002 sicurezza, RLS, trigger, RPC
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
| `OPENAI_API_KEY`, `OPENAI_MODEL` | solo Netlify Functions | AI Business Analyzer |
| `LEADFLOW_INTERNAL_SECRET` | solo Netlify Functions | ≥ 32 caratteri, autentica l'avvio dei job AI in background |
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

### Configurazione Auth

In *Authentication → URL Configuration*:

- **Site URL**: l'URL di produzione (es. `https://leadflow.netlify.app`)
- **Redirect URLs**: `https://<dominio>/auth/callback`, `https://<dominio>/reset-password`
  e, in sviluppo, `http://localhost:5173/auth/callback`, `http://localhost:5173/reset-password`

Si consiglia di lasciare attiva la conferma email.

### Modello dati

Tabelle: `profiles`, `organizations`, `organization_members`, `lead_sources`, `leads`,
`contact_suppressions`, `lead_analyses`, `campaigns`, `campaign_leads`, `activities`, `appointments`,
`ai_jobs`, `subscriptions`, `usage_events`, `audit_logs`.

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
npm run test:rls    # migrazioni + 78 test SQL (isolamento, dedup, licenze, quote) su Postgres temporaneo
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

## Roadmap

- **Fase 2 (completata)**: AI Lead Finder, Business Analyzer, Lead Scoring.
- **Prossimo**: scheda lead nel CRM con attività, opposizione/soppressione da UI, inviti al team via function.
- **Fase 4**: Stripe (checkout, portale, webhook → `subscriptions`), limiti per piano.
- **Fase 5**: Campaign Manager, AI Follow-up, Sales Agent (solo bozze con approvazione umana), Analytics.
