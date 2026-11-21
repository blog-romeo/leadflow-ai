# Checklist di deploy su Netlify

Checklist operativa per mettere online LeadFlow AI. Ogni voce indica **chi** la esegue e **come verificarla**.
Nessun passaggio di questa checklist è stato eseguito dallo sviluppo: vanno eseguiti e spuntati dal titolare.

> Regole: non attivare Stripe Live, invii commerciali o modifiche DNS senza autorizzazione esplicita.
> Non eseguire migrazioni distruttive in produzione (tutte le migrazioni 0001–0014 sono additive; 0011 aggiunge solo una funzione, 0012 le tabelle del motore multi-agent, 0013 il monitoraggio AI e il limite di workflow concorrenti, 0014 le verifiche di connessione e gli avvisi AI).

## 1. Repository

- [ ] Repository GitHub privato con il codice di questo archivio (nessun file `.env` committato: `git status` pulito, `.gitignore` include `.env*`).
- [ ] Branch di produzione (`main`) protetto; deploy preview attivi sulle pull request.

## 2. Sito Netlify

| Impostazione | Valore | Dove |
| --- | --- | --- |
| Build command | `npm run build` (`tsc -b && vite build && node scripts/generate-seo.mjs`) | `netlify.toml` |
| Publish directory | `dist` | `netlify.toml` |
| Functions directory | `netlify/functions` (bundler esbuild) | `netlify.toml` |
| Node | 22 | `netlify.toml` → `NODE_VERSION` |
| SPA redirect | `/*` → `/index.html` (200) | `netlify.toml` |
| Header di sicurezza | CSP con hash dello script inline, HSTS, X-Frame-Options, `X-Robots-Tag: noindex` sulle aree private | `netlify.toml` |
| Functions pianificate | `automation-tick` (ogni minuto), `monitoring-tick` (ogni 15 minuti), `retention-tick` (03:15 UTC, inattiva senza `RETENTION_PURGE_ENABLED`), `ai-workflows-tick` (ogni 5 minuti, inattiva senza `AI_AGENTS_ENABLED`) | `config.schedule` nel codice |

- [ ] Primo deploy completato senza errori di build (log Netlify).
- [ ] `GET https://<dominio>/api/health` → `{"status":"ok"}`.
- [ ] Le functions pianificate compaiono in *Logs → Functions* (non girano sui Deploy Preview).

## 3. Variabili d'ambiente (Site configuration → Environment variables)

Vedi `.env.example` per la descrizione completa. **Mai** il prefisso `VITE_` per i segreti.

| Variabile | Obbligatoria | Note |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL` | sì | pubbliche (browser) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | sì | solo functions |
| `LEADFLOW_INTERNAL_SECRET` (≥ 32 caratteri) | sì | job in background + hash IP dei limiti pubblici (senza: modulo demo 503) |
| `LEADFLOW_CREDENTIALS_KEY` (32 byte base64) | sì per le campagne | cifratura credenziali provider |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | sì per le funzioni AI | `OPENAI_PRICE_*` per stimare i costi |
| `OVERPASS_API_URL`, `OVERPASS_CONTACT` (+ `OVERPASS_API_KEY`) | sì per il Lead Finder | endpoint commerciale o self-hosted |
| `GOOGLE_PLACES_API_KEY` | facoltativa | solo sessione |
| `STRIPE_SECRET_KEY` (**`sk_test_…`**), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/BUSINESS/ENTERPRISE` | sì per il billing | modalità test |
| `STRIPE_PRICE_RESELLER_*` | per il White Label | canone + attivazione |
| `STRIPE_AUTOMATIC_TAX` | **da decidere** | `true` solo con Stripe Tax configurato (vedi RELEASE_READINESS) |
| `STRIPE_LIVE_MODE_APPROVED` | **vuota** | solo dopo approvazione esplicita del passaggio a Live |
| `PLATFORM_NOTIFY_RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM`, `PLATFORM_NOTIFY_TO` | consigliate | notifiche demo e avvisi critici |
| `SITE_URL` | consigliata | URL canonico per sitemap/robots/OG (default `URL` di Netlify) |
| `PLATFORM_NOTIFY_RESEND_API_KEY` + `PLATFORM_NOTIFY_FROM` | consigliate | anche per l'email degli **inviti collaboratori**; senza, l'admin riceve il link da consegnare a mano |
| `RETENTION_PURGE_ENABLED` | **da decidere** | `true` attiva l'eliminazione giornaliera dei dati scaduti (`retention-tick`); non usarla insieme a pg_cron |
| `APP_URL` | facoltativa | redirect Checkout/Portale (default `URL`) |
| `AI_AGENTS_ENABLED` | **vuota** (Prompt 8) | `true` abilita le API del motore multi-agent; lasciarla vuota in produzione finché non è verificato su staging |
| `AI_AGENTS_PILOT_ORGS` | facoltativa | elenco di UUID di organizzazioni per la beta privata (vuota = tutte, se il flag è attivo) |
| `VITE_FEATURE_AI_AGENTS` | **vuota** | `true` mostra nel menu AI Agents e AI Workflows (solo visibilità; richiede un nuovo build) |
| `OPENAI_MODEL_ECONOMY`, `OPENAI_MODEL_ADVANCED` | facoltative | modelli per livello; routing per compito con fallback solo verso livelli ammessi (Prompt 9) |
| `AI_ROUTE_<COMPITO>` | facoltative | override server-side del livello per compito (`economy`/`standard`/`advanced`), sempre ≥ minimo del compito |
| `OPENAI_PRICE_{INPUT,OUTPUT}_PER_MTOK_{ECONOMY,ADVANCED}` | facoltative | prezzi per livello; senza, il costo resta "non configurato" |

- [ ] Console Super Admin → **Sistema → Integrazioni**: tutte le voci necessarie risultano "Configurata".
      (Indica solo la presenza delle variabili, non il funzionamento.)

## 4. Supabase

- [ ] Migrazioni 0001–0014 applicate in ordine (`supabase db push` o SQL Editor). Nessuna è distruttiva.
- [ ] **Non** applicare `supabase/tests/local_supabase_stub.sql` al progetto reale.
- [ ] Super admin nominati con `select private.set_platform_role('<email>', 'super_admin', '<motivazione>')` (SQL Editor).
- [ ] *Authentication → URL Configuration*: **Site URL** = `https://<dominio>`; **Redirect URLs** includono
      `https://<dominio>/auth/callback` e `https://<dominio>/reset-password` (e gli URL dei Deploy Preview se servono).
- [ ] *Authentication → Providers → Email*: conferma email **attiva**; template email in italiano.
- [ ] *Authentication → Rate limits* e protezione bot (CAPTCHA) valutate: la registrazione pubblica non ha CAPTCHA nel codice.
- [ ] SMTP personalizzato configurato (l'SMTP di default di Supabase ha limiti molto bassi e non è adatto alla produzione).
- [ ] Storage: bucket `branding` presente (creato dalla migrazione 0008).
- [ ] Backup: verificare il piano (backup giornalieri / PITR) — vedi `docs/OPERATIONS.md`.

## 5. Stripe (modalità test)

- [ ] Prodotti e Price ricorrenti mensili in EUR: Starter 149, Business 349, Enterprise 799 (IVA esclusa); White Label
      Agency 399/mese + 2.990 una tantum, Premium 799/mese + 5.990 una tantum. Gli importi devono coincidere con
      `billing_plans` / `reseller_plans` (il test `src/config/plans.test.ts` verifica la coerenza tra sito e database).
- [ ] **Success / cancel URL**: generati dal server da `APP_URL`/`URL` — `/dashboard/billing?checkout=success|cancelled`
      (pagina Abbonamento) e `/onboarding?checkout=success|cancelled` (onboarding). Nessuna configurazione nel Dashboard.
- [ ] **Webhook**: endpoint `https://<dominio>/.netlify/functions/stripe-webhook`, eventi:
      `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
      (vedi sezione Billing del README). Copiare il signing secret in `STRIPE_WEBHOOK_SECRET`.
- [ ] Customer Portal configurato (cambio metodo di pagamento, fatture, disdetta a fine periodo).
- [ ] Stripe Tax: decisione su attivazione (vedi RELEASE_READINESS, HIGH-2).
- [ ] `npm run stripe:preflight` con le variabili di test: nessun errore bloccante.
- [ ] Scenari S1–S14 di `docs/STRIPE_TEST_PLAN.md` eseguiti e annotati.

## 6. Dominio personalizzato e HTTPS

> Le modifiche DNS richiedono autorizzazione esplicita del titolare del dominio.

- [ ] *Domain management → Add a domain*: dominio principale (es. `leadflow.it`) e `www`.
- [ ] Record DNS indicati da Netlify (A/ALIAS sull'apex o CNAME su `www` verso `<sito>.netlify.app`).
- [ ] HTTPS: certificato Let's Encrypt emesso automaticamente; *Force HTTPS* attivo (HSTS è già negli header).
- [ ] Aggiornare `VITE_APP_URL`, `SITE_URL`, Site URL di Supabase e l'endpoint webhook Stripe con il dominio definitivo; ridistribuire.
- [ ] Domini White Label: provisioning **manuale** (alias aggiunto dal super admin), limiti Netlify sugli alias (≈ 50 consigliati, ~100 massimo per sito).

## 7. Verifiche dopo il deploy (smoke test)

- [ ] Home, `/prezzi`, `/demo`, pagine legali: caricamento su mobile e desktop.
- [ ] `https://<dominio>/robots.txt` e `/sitemap.xml` presenti con l'URL corretto; `/app` risponde con `X-Robots-Tag: noindex`.
- [ ] Richiesta demo → riga in Console → Assistenza e demo; email interna ricevuta (se configurata).
- [ ] Registrazione → email di conferma → onboarding → checkout test → piano attivo dopo il webhook.
- [ ] Ticket di assistenza: apertura, risposta dello staff, notifica in-app.
- [ ] Inviti collaboratori: invito da Impostazioni → Collaboratori, email ricevuta (o link copiato), registrazione con l'email invitata, conferma email, accettazione su `/join`, limite utenti del piano, revoca, rimozione.
- [ ] Console → Sistema: nessun avviso critico; errori API a zero.
- [ ] Eseguire i test E2E manuali di `RELEASE_READINESS.md` e aggiornare lì l'esito.

## Prompt 9 — verifiche di staging aggiuntive

- [ ] `npm run integrations:preflight` con le variabili di staging (prima senza rete, poi `PREFLIGHT_NETWORK=1`): nessun errore bloccante.
      Verifica, in sola lettura, migrazioni 0012/0013, esistenza dei modelli OpenAI configurati, Overpass, `/api/health`.
- [ ] `ai-workflows-run` usa `config.background: true` (sintassi introdotta da Netlify a giugno 2026, il suffisso `-background` resta
      supportato): nel pannello Functions del deploy deve risultare **background** (fino a 15 minuti). Se risultasse sincrona,
      rinominare il file in `ai-workflows-run-background.ts` mantenendo `config.path`.
- [ ] `/super-admin/ai-monitoring` raggiungibile solo dal super admin; con un utente normale la console mostra "accesso negato" e l'API risponde 403.
- [ ] Avviare tre workflow nella stessa organizzazione di test: il terzo deve essere rifiutato con `too_many_active_workflows` (409).

## Prompt 10

- Runbook completo (GitHub, CI, Netlify, Supabase, provider, test reale): `docs/STAGING_RUNBOOK.md`.
- Nuova function `POST /api/ai-agents/connections-check` (solo admin, sola lettura verso OpenAI e Overpass).
- `monitoring-tick` valuta anche `ai_monitoring_evaluate` (workflow falliti/fermi, verifiche di connessione fallite).
