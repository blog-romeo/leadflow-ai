# Release Readiness Report — LeadFlow AI (Prompt 13)

Data: 21/11/2026 · Archivio: `leadflow-ai-prompt13-release.zip` · Precedente: Prompt 12

## Classificazione: NOT READY

Invariata. I **5 problemi HIGH** restano aperti: build e deploy (REL-1), Stripe Test Mode (REL-2), fiscalità e fatturazione
(REL-3), documentazione legale (REL-5), integrazioni Supabase e Netlify (REL-6). Le nuove funzionalità AI **non** li risolvono.
npm, Netlify e GitHub restano non raggiungibili da questa sessione (verificato all'avvio): nessuna build, CI o deploy reale.

## Prompt 13 — beta gratuita, chatbot di assistenza, cancellazione account

Richiesta: niente pagamenti per ora, tutto funzionante, agenti "addestrati", chatbot di assistenza funzionante.
Classificazione **invariata: NOT READY** per il lancio a pagamento; i 5 HIGH restano aperti. La beta gratuita permette di
far provare il prodotto **senza** Stripe, ma non risolve REL-2/3/5: servono comunque build reale (REL-1), Supabase e
Netlify reali (REL-6) e i testi legali (privacy, termini) prima di aprire la beta a utenti esterni.

| Voce | Esito |
| --- | --- |
| Beta gratuita | migrazione 0016: piano `beta` a costo zero non in vendita (100 lead, 200 crediti AI, 3 utenti/mese), concesso dal database alle nuove organizzazioni quando `free_beta_enabled` è attivo (`sa_set_free_beta`, con motivazione e audit; pulsante in Super Admin → Impostazioni). `VITE_FREE_BETA=true` mostra la beta su prezzi e onboarding e nasconde il pagamento. **Spenta per default** |
| Chatbot di assistenza | sito + app, `POST /api/support-chat`; risposte solo dalla documentazione con fonti, astensione e passaggio a una persona (ticket con conferma in app, modulo di contatto sul sito); sul sito nessuna AI. Misurato su dataset sintetico: test P@1 0,889, astensione 4/4 (`docs/SUPPORT_CHATBOT.md`) |
| "Agenti addestrati" | **nessun modello addestrato o fine-tuned** (nessun accesso autorizzato a un modello in questa sessione). Applicati in produzione i 6 sinonimi dei settori validati dal benchmark del Prompt 12; aggiunto il benchmark del chatbot. Sono miglioramenti di regole misurati, non addestramento |
| REL-47 cancellazione | **implementata**: Impostazioni → Cancellazione account e organizzazione (conferma scritta, regola dell'ultimo amministratore, blocco con abbonamento Stripe attivo, disattivazione immediata, eliminazione definitiva dopo 30 giorni, audit). Da verificare su Supabase reale e far rivedere al legale |
| REL-46 | email dei fixture di test spostate su `.test` (10 file); restano alcuni siti web di esempio `.it` nei test di onboarding (nessun invio, nessuna richiesta) |
| Test | SQL **806** asserzioni (+41: beta, cancellazione, purge); concorrenza billing OK; runner di compatibilità (non Vitest) 38 file / 412 test, 0 falliti; typecheck parziale functions: solo i 24 errori noti dei tipi finti; 51/51 functions impacchettate; import del frontend risolti con esbuild (non è una build né un typecheck); i18n 2.818 = 2.818 chiavi; nessun segreto |
| Non verificato | build Vite, `tsc -b` del frontend, Vitest reale, test dei componenti React, deploy: possibili solo con push e CI |

| ID | Gravità | Descrizione | Stato |
| --- | --- | --- | --- |
| REL-47 | MEDIUM | Cancellazione self-service di account e organizzazione | **RISOLTO nel codice** (SQL testato); verifica in staging e revisione legale dei tempi (30 giorni) |
| REL-46 | LOW | Email di test su domini `.it` reali | **RISOLTO** (email); siti di esempio residui senza effetti |
| REL-50 | LOW | La purge definitiva delle organizzazioni cancellate gira solo con `RETENTION_PURGE_ENABLED=true`; le organizzazioni con fatture restano disattivate ma non eliminate finché non c'è la decisione fiscale (REL-3) | **APERTO** |
| REL-51 | LOW | Qualità del chatbot misurata solo su domande inventate dal team | **APERTO** — rimisurare con le domande reali in staging |

Problemi aperti dopo il Prompt 13: CRITICAL **0** · HIGH **5** · MEDIUM **15** · LOW **19**.

## Prompt 12 — sintesi con evidenze

| Voce | Esito |
| --- | --- |
| Stato git | branch `feature/leadflow-staging-release` **conservato**; commit locale `4cfe6a6` con lo stato del Prompt 11 (nessuna modifica persa) e commit locale del Prompt 12; **nessun push**, nessun remote |
| Segreti | `check-secrets` pulito prima di ogni commit; nessun `.env` versionato |
| Addestramento | **nessun modello addestrato**, nessun fine-tuning avviato; framework di valutazione e miglioramento controllato (`docs/AI_TRAINING.md`) |
| Quality Reviewer | nuova fase logica dopo ogni passo (8 controlli), blocchi da versione di configurazione approvata |
| Benchmark realmente eseguiti | 7 dataset sintetici versionati con split train/validation/test, contaminazione verificata (1 caso trovato e corretto); confronti sul test: settori F1 0,863→1,000 (candidato non applicato), scoring 1,000→1,000 (nessun guadagno), controllo output F1 0,000→1,000 (Quality Reviewer); valutazione con modello reale **non eseguita** |
| Prestazioni | chiamate allo store per 30 aziende **476 → 394** (−17%, misurato in processo); latenza reale da misurare in staging |
| Vulnerabilità/difetti corretti | la memoria poteva contenere email e telefoni → minimizzazione nel database; `approved_feedback` scrivibile a mano → ora solo dalla validazione; nuovi pattern di strumenti vietati (configurazioni, sicurezza, flag, training); errore di tipo nel benchmark trovato dal typecheck parziale |
| Test | SQL **765** asserzioni (+31) su PostgreSQL 16; runner di compatibilità (non Vitest) 36 file / 392 test; typecheck parziale delle functions con tipi finti: 0 errori nel codice; 49/49 functions impacchettate |
| CI/CD | workflow invariati e mai eseguiti; la CI esegue anche `npm run ai:benchmark` tramite `vitest run` |

### Nuovi problemi

| ID | Gravità | Descrizione | Stato |
| --- | --- | --- | --- |
| REL-47 | MEDIUM | Nessuna cancellazione self-service di account o organizzazione (diritto all'oblio gestito manualmente) | **APERTO** — da progettare con il legale (REL-5) |
| REL-48 | LOW | Benchmark con etichette scritte dallo stesso team che ha scritto le regole: risultati ottimistici, non accuratezze reali | **APERTO** — servono dati reali autorizzati e un valutatore indipendente |
| REL-49 | LOW | Il candidato "sinonimi dei settori" ha superato il gate ma il motore non legge ancora quella chiave di configurazione | **APERTO** — collegare `discovery.sector_synonyms` prima di promuoverlo |
| REL-37 | LOW | Costo dei checkpoint | **PARZIALE** — −82 chiamate in processo; da confermare in staging |

---

## Prompt 11 — GitHub, recupero del codice, primo staging

**Stato: fermo al primo passaggio manuale.** GitHub non è collegato alla sessione (nessun account collegato, `GH_TOKEN`
non valido, nessun remote), npm e Netlify non raggiungibili. Come richiesto, il deploy **non** viene simulato.

| Voce | Esito con evidenza |
| --- | --- |
| Stato git | branch `main` @ `b1ab952` (4 commit, fino al Prompt 4); nessun remote |
| Branch | creato `feature/leadflow-staging-release` (locale, **nessun commit**: repository non collegato) |
| Codice Prompt 5–10 | presente nel working tree: 213 file nuovi, 55 modificati, 1 eliminato intenzionalmente (`SuperAdmin.tsx`, sostituita da `/super-admin`); identico byte per byte allo ZIP del Prompt 10 prima delle modifiche di questo prompt. Elenco: `docs/STAGING_RELEASE_MANIFEST.md` |
| Segreti | nessuno nei file (tracciati e non) né nella storia git; nessun file `.env` reale; `.env.example` solo segnaposto; nessun file temporaneo o di backup; il frontend non legge variabili non `VITE_` → nessuna chiave da revocare |
| Dati personali | solo dati di test fittizi; alcuni fixture usano domini `.it` reali (es. `team-a.it`) per email inventate: nessun invio, sostituibili con `.test` (REL-46, LOW) |
| Build / typecheck / Vitest | **non eseguiti** (npm non raggiungibile). esbuild non è considerato build |
| Test eseguiti | SQL 734 asserzioni + concorrenza crediti su PostgreSQL 16: superati. Runner di compatibilità (non Vitest): 385/385 |
| GitHub Actions | workflow verificati staticamente (YAML valido, passi richiesti presenti, nessun `continue-on-error`, permessi minimi); **mai eseguiti** |
| Netlify | **nessun sito, nessun deploy** |
| Supabase | **nessun progetto collegato**; migrazioni 0001–0014 verificate solo in locale |
| Smoke test | preparato `npm run staging:smoke` (10 passi, anche da "Staging checks"); non eseguibile senza deploy |

**Primo passaggio manuale necessario**: collegare il codice a GitHub (`docs/STAGING_RUNBOOK.md` §0) — commit sul branch
`feature/leadflow-staging-release` e push su un repository **privato**, oppure collegare GitHub in claude.ai (Impostazioni →
Connettori) così che la prossima sessione possa leggere il repository e gli esiti della CI.

---


## Classificazione

# NOT READY

| Livello | Definizione | Stato |
| --- | --- | --- |
| **NOT READY** | manca almeno una verifica reale di build, infrastruttura o sicurezza | **attuale** |
| **READY FOR PRIVATE BETA** | gratuita, utenti selezionati, nessun incasso. Richiede: CI GitHub verde (`npm ci`, `tsc -b`, Vitest, build, SQL), staging Netlify + Supabase funzionante, isolamento verificato con due organizzazioni, provider verificati, test e2e limitato eseguito (REL-1, REL-6, REL-28, REL-35) | non raggiunto |
| **READY FOR PAID LAUNCH** | in aggiunta: Stripe test S1–S14 (REL-2), decisioni fiscali e SdI (REL-3), testi legali revisionati (REL-5), provider con condizioni d'uso commerciali (REL-41), approvazione esplicita per Stripe Live e DNS | non raggiunto |

**Nessun servizio esterno è stato raggiungibile in questa sessione** (verificato all'inizio): registry npm bloccato dal proxy,
Netlify, OpenAI, Overpass e Stripe non raggiungibili, GitHub raggiungibile ma **nessun account collegato** e token non valido,
nessuna credenziale nell'ambiente. Quindi: **nessuna build reale, nessun deploy, nessun workflow reale, nessun costo misurato**.
Nessun risultato in questo documento è presentato come reale se non lo è.

Problemi aperti: CRITICAL **0** · HIGH **5** · MEDIUM **16** · LOW **19** (Prompt 11: +REL-46; Prompt 12: +REL-47, REL-48, REL-49). Risolti nel Prompt 10: REL-42, REL-43, REL-44.

## 1. Audit: verifica dei risultati del Prompt 9

| Dichiarazione del Prompt 9 | Verifica qui | Esito |
| --- | --- | --- |
| 366 test superati con runner di compatibilità | **non equivalente a Vitest** (come richiesto dal Prompt 10) | evidenza di regressione della logica, non di `vitest run` |
| typecheck parziale (TS 6, tipi finti) | rieseguito | 0 errori nel codice; 24 dovuti ai tipi finti di supabase-js. **Non è `tsc -b`** |
| 722 asserzioni SQL | rieseguite su PostgreSQL 16 | confermate, ora **734** con la migrazione 0014 |
| build | mai eseguita | **NON ESEGUITA** |
| Concorrenza crediti | `run_billing_concurrency.sh` eseguito per la prima volta da Prompt 7 | **superato** (40 prenotazioni parallele su 10 crediti → 10 accettate; 30 conteggi lead → limite rispettato) |
| Repository pronto per GitHub | `git status` | **NO** — gran parte del codice dei Prompt 5–10 è *untracked* (REL-45) |

## 2. Fase 2 — Build reale: BLOCCATA

`npm ci` fallisce (registry irraggiungibile dal proxy della sandbox). `npx tsc -b`, `npx vitest run`, `npm run build` non
eseguibili. Preparata la pipeline GitHub Actions che li esegue in un ambiente reale (§3). **La pipeline non è mai stata
eseguita**: nessun esito da riportare.

## 3. Pipeline CI/CD (nuova, mai eseguita)

| File | Contenuto | Fallisce se |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `npm ci`, `npx tsc -b`, `npx vitest run`, `npm run build` (flag spento e acceso), bundle delle 49 functions, migrazioni 0001–0014 + test RLS/isolamento + concorrenza crediti su PostgreSQL 16, scansione segreti, `npm audit --omit=dev --audit-level=high`, `npm audit signatures`, dependency review sulle PR | qualsiasi passo fallisce |
| `.github/workflows/staging-checks.yml` | solo manuale, environment `staging` protetto: preflight integrazioni con rete, test e2e limitato facoltativo, report come artifact | errori bloccanti del preflight o e2e non completato |
| `.github/dependabot.yml` | aggiornamenti settimanali npm e Actions | — |

Permessi minimi (`contents: read`), nessun segreto nel repository, nessun push automatico, nessun deploy in produzione.

## 4. Stato dei servizi

| Servizio | Stato | Evidenza |
| --- | --- | --- |
| GitHub | **non collegato** (nessun account collegato alla sessione; nessun remote nel repository) | `list_repos`: nessun account; `git remote -v` vuoto |
| Netlify | **non configurato / non raggiungibile** | API Netlify irraggiungibile, nessun token |
| Supabase | solo **PostgreSQL 16 locale** (stub Auth/Storage) | 734 asserzioni; Storage e Auth reali non testati |
| Provider AI (OpenAI) | **PROVIDER_NOT_CONFIGURED** | nessuna chiave; API irraggiungibile |
| Provider aziende (Overpass) | **PROVIDER_NOT_CONFIGURED** | nessuna variabile; valutazione documentale in `docs/PROVIDER_ASSESSMENT.md` |
| Stripe | **non configurato** (test mode non eseguito) | nessuna chiave |

## 5. Test workflow reale ("fino a 5 aziende alberghiere a Roma, fino a 3 proposte")

**Non eseguito**: nessun provider né modello configurato. Preparato `npm run staging:e2e` (anche dal workflow GitHub):
forza 5/5/3, budget configurabile (max 50), si ferma all'approvazione salvo `E2E_APPROVE=yes-approve-crm-write`, rifiuta la
produzione, nessun invio. Il report contiene aziende, fonti, analisi, score, proposte, token, costi (o "non misurabile"),
errori e durate presi **solo** da API e database. Senza provider il report riporta `PROVIDER_NOT_CONFIGURED_OR_NOT_RUN`.

**Costi misurati: nessuno.** Stima massima teorica del test: 5 analisi × 1 + 3 strategie × 2 = 11 crediti; USD non stimabile senza prezzi.

## 6. Modifiche di questo prompt

| Area | Modifica | Verifica |
| --- | --- | --- |
| Agent Control Center | pannello "Stato provider e connessioni": `PROVIDER_NOT_CONFIGURED` / configurato non verificato / verificato (esito reale < 24 h) / scaduto / fallito; pulsante "Verifica connessioni" (admin); nota "nessun dato simulato"; token per passo e totali nel workflow | logica testata; UI solo sintassi |
| Verifica reale delle connessioni | `POST /api/ai-agents/connections-check`, tabella `integration_checks` (migrazione 0014), GET di sola lettura, una verifica al minuto, audit | test con risposte HTTP finte + SQL |
| OpenAI | `Retry-After` propagato al backoff; token di risposte troncate/rifiutate registrati come costo con 0 crediti (REL-43) | test |
| Log sicuri | oscuramento dei valori (chiavi Stripe/OpenAI/Resend/Google/GitHub, JWT, Bearer) nel logger e negli errori non gestiti (REL-42) | test |
| Osservabilità | avvisi `ai_workflows_failing`, `ai_workflows_stuck`, `integration_check_failed` in `monitoring-tick` | SQL |
| Performance | chiamate allo store per invocazione in `report.perf_last_invocation` e nel log `ai_workflow.finished`: misura pronta per staging. **Nessuna ottimizzazione** (collo di bottiglia non misurato in staging) | test |
| Strumenti di staging | `staging:e2e`, `staging:isolation` (due organizzazioni, RLS reali, sola lettura), `integrations:preflight`, `security:secrets` | test delle parti pure |
| `.gitignore` | ignora `.env.*` (eccetto `.env.example`) e `e2e-report.json` (REL-44) | — |

## 7. Test realmente eseguiti in questa sessione

| Suite | Strumento | Risultato |
| --- | --- | --- |
| SQL: migrazioni 0001–0014 + 12 suite | PostgreSQL 16 + stub Supabase | **734 asserzioni superate** (+12: verifiche di connessione, avvisi AI) |
| Concorrenza crediti e quote lead | PostgreSQL 16, 40 e 30 connessioni parallele | **superato** |
| Logica TS | runner di compatibilità (**non Vitest**) | 35 file, 383 test superati, 0 falliti; 8 file React non eseguibili |
| Typecheck parziale functions | TypeScript 6.0.3 con tipi finti | 0 errori nel codice |
| Bundle functions | esbuild 0.28.2 | 49/49 |
| Segreti | `scripts/check-secrets.mjs` su file versionati e non ignorati | nessun segreto |
| i18n | parità IT/EN | 2.680 = 2.680 chiavi |

**Non eseguiti**: `npm ci`, `tsc -b`, `vitest run`, `vite build`, CI GitHub, deploy Netlify, Supabase reale (Auth, Storage, RLS),
OpenAI, Overpass, Stripe test, test e2e, misure di latenza.

## 8. Problemi

### HIGH (aperti)

| ID | Problema | Stato | Azione successiva |
| --- | --- | --- | --- |
| REL-1 | Build e test reali mai eseguiti (`npm ci`, `tsc -b`, Vitest, build) | **APERTO** — pipeline pronta, mai eseguita | `docs/STAGING_RUNBOOK.md` §0–1: commit, push su branch `staging`, CI verde |
| REL-2 | Stripe Test Mode mai eseguito | **APERTO** | runbook §6 |
| REL-3 | Fiscalità e fatturazione elettronica | **APERTO** | `docs/FISCALE_CHECKLIST.md` |
| REL-5 | Documentazione legale incompleta (inclusi provider OSM/ODbL ed export) | **APERTO** | `docs/LEGAL_MISSING_DATA.md`, `docs/PROVIDER_ASSESSMENT.md` |
| REL-6 | Supabase e Netlify reali mai verificati | **APERTO** | runbook §2–4 |

### Nuovi e aggiornati

| ID | Gravità | Descrizione | Stato |
| --- | --- | --- | --- |
| REL-45 | MEDIUM | Il codice dei Prompt 5–10 non è committato in git: push o CI senza commit userebbero una versione vecchia | **APERTO** — Prompt 11: branch `feature/leadflow-staging-release` pronto, manifest generato, segreti verificati; manca il commit/push del proprietario (runbook §0) |
| REL-46 | LOW | Fixture di test con email inventate su domini `.it` reali | **RISOLTO** nel Prompt 13 (email su `.test`) |
| REL-41 | MEDIUM (bloccante per il lancio a pagamento) | L'istanza pubblica `overpass-api.de` chiede che l'uso commerciale passi da server propri o a pagamento e limiti molto inferiori per l'uso regolare di un'app | **APERTO** — scegliere un'istanza adeguata (`OVERPASS_API_URL`/`OVERPASS_API_KEY` già supportati) |
| REL-42 | MEDIUM | I log oscuravano solo i nomi dei campi: un segreto dentro un messaggio d'errore poteva finire nei log di Netlify | **RISOLTO** (test) |
| REL-43 | LOW | Token di risposte AI troncate o rifiutate non contabilizzati nel costo | **RISOLTO** (test) |
| REL-44 | LOW | `.gitignore` non copriva `.env.staging` e simili | **RISOLTO** |
| REL-28, REL-35 | MEDIUM | Motore multi-agent e funzioni del Prompt 9 mai eseguiti su servizi reali | **APERTI** — runbook §5 |
| REL-37 | LOW | 476 chiamate allo store per 30 aziende (in processo, Prompt 9) | **APERTO** — ora misurato automaticamente per invocazione; ottimizzare solo dopo la misura in staging |
| REL-39 | LOW | `config.background: true` da confermare nel pannello Netlify | **APERTO** |
| altri | MEDIUM/LOW | REL-9, 12, 13–18, 27, 29; REL-19–25, 30–34, 38, 40 | invariati |

## 9. Regola di rilascio (invariata)

1. READY FOR PAID LAUNCH solo senza problemi CRITICAL o HIGH su sicurezza, pagamenti, infrastruttura, fiscalità o documenti legali.
2. Stripe Live, invii commerciali, DNS e cancellazioni di dati solo con approvazione esplicita.
3. Nessuna migrazione distruttiva: 0001–0016 sono additive (la 0016 ridefinisce `protect_last_admin` e `run_retention_purge` mantenendone il comportamento sulle organizzazioni attive). Nessuna migrazione in produzione senza approvazione.
4. Una funzione è "Operativa" sul sito solo dopo la verifica in produzione.
