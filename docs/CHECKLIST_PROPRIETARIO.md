# Checklist operativa per il proprietario

> Prompt 10: la procedura passo per passo dello staging (GitHub, CI, Netlify, Supabase, provider, test reale) è in
> `docs/STAGING_RUNBOOK.md`. Prima di tutto: **committare il codice dei Prompt 5–10** (§0 del runbook).

Ordine consigliato. Ogni passo indica cosa serve e come si verifica. Nessuno di questi passi è stato eseguito dallo
sviluppo: richiedono account, credenziali o decisioni del titolare.

## 1. Build e test reali (½ giornata)

- [ ] Su un computer con accesso a internet: `npm ci && npm run typecheck && npm test && npm run build`.
- [ ] `npm run test:rls` (richiede PostgreSQL 15+ locale) e `npm run test:billing-concurrency`.
- [ ] Annotare l'esito in `RELEASE_READINESS.md` (REL-1). In caso di errori TypeScript reali, correggerli prima di proseguire.
- [ ] Prompt 8: questi comandi sono stati eseguiti con esito positivo nella sandbox di sviluppo (Node 22, Linux). Resta da
      confermare il **build sul CI di Netlify** (primo deploy di staging).

## 2. Ambiente di staging (1 giornata)

- [ ] Progetto **Supabase di test** separato dalla produzione; migrazioni 0001–0014; super admin nominato.
- [ ] Supabase Auth: conferma email attiva, SMTP personalizzato, Site URL e Redirect URL dello staging (`/auth/callback`, `/reset-password`).
- [ ] Sito Netlify di staging collegato al repository; variabili d'ambiente da `docs/DEPLOY_NETLIFY.md` §3 (chiavi Stripe **test**).
- [ ] `PLATFORM_NOTIFY_RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM` (dominio verificato in Resend), `PLATFORM_NOTIFY_TO`.
- [ ] Smoke test di `docs/DEPLOY_NETLIFY.md` §7.

## 2-bis. Motore multi-agent su staging (Prompt 8, ½ giornata — dopo §2)

- [ ] Staging: `AI_AGENTS_ENABLED=true`, `AI_AGENTS_PILOT_ORGS=<uuid org di test>`, `VITE_FEATURE_AI_AGENTS=true` (nuovo build).
- [ ] Profilo commerciale completo (Sales Agent → Profilo) e fonte Overpass configurata.
- [ ] Workflow "Ricerca e qualificazione" con 5 aziende, analisi 3, strategie 2, budget 15: verificare approvazione,
      salvataggio nel CRM dei soli lead approvati, bozze in stato "draft", nessuna email inviata, crediti in Abbonamento.
- [ ] Interruzione di un workflow in corso; workflow "Revisione follow-up" e "Analisi delle prestazioni".
- [ ] Log Netlify: `ai-workflows-run` (background) e `ai-workflows-tick` (pianificata) senza errori; nessun segreto nei log.
- [ ] In produzione lasciare `AI_AGENTS_ENABLED` vuota finché questi punti non sono superati.

## 2-ter. Prompt 9: workflow reale e verifiche multi-tenant su staging (1 giornata — dopo §2-bis)

Nessuna chiave va incollata in chat: le variabili si impostano nel pannello Netlify (staging) e in un file locale `.env.staging` non versionato.

- [ ] `npm run integrations:preflight` (poi con `PREFLIGHT_NETWORK=1`): zero errori bloccanti. Conservare l'output.
- [ ] **Due organizzazioni di test** (A e B) con utenti distinti, entrambe in `AI_AGENTS_PILOT_ORGS`; nessun dato di clienti reali.
- [ ] Organizzazione A: obiettivo *"Trova 30 aziende nel settore alberghiero a Roma, analizzale, identifica le 10 più compatibili e
      prepara proposte commerciali personalizzate"*, budget 50 crediti. Verificare: piano non bloccato; 30 aziende dalla fonte
      Overpass (OpenStreetMap, con attribuzione); analisi con evidenze FACT/INFERENCE/UNKNOWN; classifica; richiesta di
      approvazione; dopo l'approvazione solo i lead approvati nel CRM; ≤ 10 strategie con bozze in stato "draft"; **nessuna email inviata**.
- [ ] Annotare: durata di ogni passo, crediti per passo (pagina del workflow), costo stimato, token (Super Admin → Monitoraggio AI).
- [ ] Organizzazione B: verificare che non veda workflow, evidenze, bozze e lead di A (pagine e API); `/super-admin/ai-monitoring`
      negato agli utenti di A e B.
- [ ] Interrompere un workflow in esecuzione; avviarne tre in parallelo (il terzo rifiutato); ripetere lo stesso avvio con la stessa
      chiave (nessun doppione, nessun doppio addebito).
- [ ] Togliere temporaneamente `OVERPASS_API_URL` su un deploy di prova: il piano deve risultare bloccato, nessuna ricerca simulata.
- [ ] `AI_EVAL_LIVE=1 npm run ai:eval` con le chiavi di staging (consuma pochi token): annotare JSON validi, evidenze, avvisi.
- [ ] Riportare gli esiti in `RELEASE_READINESS.md` (REL-6, REL-28, REL-35).

## 2-quater. Prompt 13: beta gratuita e chatbot su staging (½ giornata — dopo §2)

- [ ] Applica la migrazione `0016` su staging; esegui `supabase/tests/run_local_rls_tests.sh` in CI o in locale.
- [ ] Super Admin → Impostazioni → **Beta gratuita** → "Attiva per le nuove organizzazioni" (motivazione obbligatoria).
- [ ] Netlify (staging): `VITE_FREE_BETA=true`, nuovo deploy. Registra un account di prova: l'onboarding deve offrire
      "Continua con la beta gratuita" e non chiedere la carta.
- [ ] Chatbot: apri il sito senza login e fai 5 domande (una fuori tema: deve dire che non lo sa e proporre il contatto).
      In app chiedi "voglio parlare con una persona" → invia → il ticket deve comparire in `/super-admin/support`.
- [ ] Facoltativo: `OPENAI_API_KEY` e `OPENAI_MODEL` su staging per le risposte AI in app (costo per domanda nel Control Center).
- [ ] Cancellazione: con un account di prova cancella l'organizzazione (nome per conferma) e poi l'account (email). Verifica
      che non sia più possibile accedere. L'eliminazione definitiva dopo 30 giorni richiede `RETENTION_PURGE_ENABLED=true`.
- [ ] **Prima di aprire la beta a persone esterne**: privacy e termini definitivi (REL-5) e Supabase/Netlify verificati (REL-6).

## 3. Stripe in modalità test (½ giornata)

- [ ] Prodotti e Price (importi IVA esclusa, `tax_behavior=exclusive`), webhook, Customer Portal (disdetta a fine periodo).
- [ ] `npm run stripe:preflight` senza errori bloccanti.
- [ ] Scenari S1–S14 di `docs/STRIPE_TEST_PLAN.md` (S15 se vendi il White Label).

## 4. Fiscale (con il commercialista)

- [ ] Decisioni di `docs/FISCALE_CHECKLIST.md` (regime, trattamento per paese/tipo cliente, Stripe Tax o alternativa, fatturazione elettronica SdI).
- [ ] Se Stripe Tax: configurazione in Stripe, `STRIPE_AUTOMATIC_TAX=true` su staging, preflight e S3/S10 ripetuti.

## 5. Legale

- [ ] Compilare i dati di `docs/LEGAL_MISSING_DATA.md` (5 dati societari + 31 voci).
- [ ] Revisione professionale di privacy, cookie, termini, condizioni di abbonamento, politica di cancellazione, DPA.
- [ ] Solo dopo: rimuovere l'avviso di bozza e il `noindex` delle pagine legali (sviluppo: `Legal.tsx`, `seo/public-routes.json`).

## 6. Decisioni operative

- [ ] Conservazione dei dati: attivare `RETENTION_PURGE_ENABLED=true` **oppure** il job pg_cron del README (non entrambi), dopo aver fissato i periodi nell'informativa.
- [ ] Backup: verificare piano Supabase, eseguire una prova di ripristino (`docs/OPERATIONS.md`).
- [ ] CAPTCHA per la registrazione in Supabase Auth.
- [ ] Monitoraggio esterno su `/api/health`.

## 7. Produzione (solo con approvazione esplicita)

- [ ] Dominio e DNS (autorizzazione del titolare del dominio).
- [ ] Progetto Supabase di produzione, variabili Netlify di produzione.
- [ ] Passaggio a Stripe Live: chiavi live + `STRIPE_LIVE_MODE_APPROVED=yes-i-approve-live-payments`, Price live, webhook live, preflight adattato.
- [ ] Aggiornare `src/config/features.ts` (Beta → Operativa) solo per le funzioni verificate in produzione.
