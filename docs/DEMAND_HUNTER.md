# Lead AI Generate 2.0 — Demand Hunter (integrazione BuyerML)

Stato: **integrato su ramo di anteprima, non in produzione.** Migrazione Supabase preparata e provata solo su
un PostgreSQL locale temporaneo; servizio Python pronto per Docker ma non ancora installato su un server.

## 1. Analisi preliminare

**Sorgente:** `BuyerML-Caccia-27nov-sorgenti-integrazione.zip` (218 file), letto per intero. Nessun file di
licenza nello ZIP: il proprietario ha confermato di essere titolare dei diritti (o di avere l'autorizzazione
scritta del titolare) prima dell'incorporazione.

| BuyerML | Lead AI Generate | Decisione |
|---|---|---|
| Python, FastAPI, SQLite, job in memoria | React/Vite + Netlify Functions (TypeScript) + Supabase | motore Python **separato** (Docker), gateway in TypeScript |
| `hunt.py`, `demand.py`, `learning.py`, `areas.py`, tassonomia IT, aree di mercato | nessun equivalente (il Lead Finder cerca aziende su OSM/Google Places, non richieste) | **integrati senza modifiche** |
| Conferme di spesa: token in memoria (`api.py` `Confirmations`) | quote `usage_events`, crediti AI, Control Center | sostituite da token monouso **in Supabase** (hash, utente, org, azione, budget) + limiti per organizzazione |
| Job in memoria (persi al riavvio) | — | job persistenti nel servizio (`service.db`) **e** in Supabase |
| Nessuna autenticazione né separazione clienti (`PRODUCT.md`) | Supabase Auth, organizzazioni, RLS | autenticazione e isolamento multi-tenant aggiunti |
| Pipeline e messaggi (`outreach.py`) | CRM, pipeline, AI Sales Agent, Follow-up | **non importati** (duplicati): i lead vanno nel CRM esistente |
| Clara (`clara.py`) | chatbot di assistenza, Assistente | non importato (fase futura) |
| Chiamate Bland (`bland_calls.py`, `call_script.py`) | — | non importato (fase futura, vedi §7) |
| Interfaccia React di BuyerML (`web/`) | design system esistente | **riscritta** con i componenti esistenti; concetti ripresi (Caccia, CostConfirm) |
| Dorking LinkedIn (`linkedin.com/in`) | — | **escluso** (profili personali). La caccia usa solo il canale `facebook_groups` di `hunt.py`, letto dai risultati di Google |

Dipendenze del servizio: `fastapi` (MIT), `uvicorn` (BSD-3), `httpx` (BSD-3), `requests` (Apache-2.0). Nessuna
nuova dipendenza npm. Dati ATECO ISTAT e modelli addestrabili non inclusi in questa fase.

## 2. Architettura

```
Browser (React)                    Netlify Functions (gateway)                      Server dedicato (Docker)
/app/demand-hunter  ──JWT──▶  /api/demand-hunter/{status,areas,estimate,   ──HMAC──▶  FastAPI + motore BuyerML
                                start,job,stop,feedback,learning,crm}                 SQLite per organizzazione
                               • requireOrgMember + piano «lead_finder»                job persistenti
                               • token monouso, limiti, rate limit                      ──▶ SerpApi (Google)
                               • Supabase service role (dopo i controlli)
                               scheduled: demand-hunter-sync (ogni 5 min)
```

Il servizio Python non è mai raggiungibile dal browser e non conosce Supabase: riceve l'organizzazione solo
negli header firmati. Supabase è la fonte di verità per sessioni, lead, prove, feedback, consumi e job; il
servizio conserva lo stato interno del motore (deduplicazione delle ricerche già fatte, apprendimento).

### Agenti

Gli agenti del Demand Hunter (`netlify/functions/_shared/demand-hunter/agents.ts`) seguono le regole del
catalogo esistente (`_shared/agents/catalog.ts`): strumenti in allowlist nel codice, strumenti vietati
rifiutati (`isForbiddenTool`), `crm.save_leads` solo con azione esplicita, output strutturati validati con zod.
Sono deterministici: la logica è quella di BuyerML, nessun modello AI viene chiamato.

| Agente | Compito | Strumenti | Riceve da / passa a |
|---|---|---|---|
| Agent Orchestrator | limiti, conferme, sequenza | `dh.limits.read`, `dh.confirmations.consume` | — |
| Market Discovery Agent | albero delle aree, concetti scoperti (`areas.py`) | `service.areas.*` | → Demand Hunter |
| Demand Hunter Agent | caccia verbo × oggetto via SerpApi (`hunt.py`) | `service.hunt.*`, `dh.leads.write` | → Intent Analysis |
| Intent Analysis Agent | chi scrive, intenzioni, stadio, prove (`demand.py`) | `service.classify` | → Lead Qualification |
| Lead Qualification Agent | priorità, esclusioni, CRM deduplicato | `crm.save_leads` | → agente esistente **scoring** (e poi strategy/follow_up) |
| Learning Agent | Giusto/Sbagliato, tassi per verbo/oggetto/schema (`learning.py`) | `service.learning.*`, `dh.feedback.write` | → priorità delle cacce successive |

Non sono stati aggiunti al motore di workflow esistente (`ai_workflows`): richiederebbe di modificare i vincoli
`agent_key` delle tabelle della migrazione 0012. Vedi «Problemi aperti».

## 3. Supabase (migrazione `20261202000018_demand_hunter.sql`)

Solo additiva. Tabelle: `demand_hunter_limits`, `_jobs`, `_sessions`, `_combinations`, `_leads`,
`_intent_classifications`, `_feedback`, `_concepts`, `_learning_stats`, `_api_usage`, `_confirmations`; valore
`demand_hunter` aggiunto a `lead_provider`. RLS su tutte: lettura ai membri dell'organizzazione, **nessuna
scrittura dai client**, token di conferma invisibili ai client. RPC solo `service_role`:
`demand_hunter_usage_summary`, `_consume_confirmation`, `_reserve`, `_settle`, `_purge_confirmations`.
Vincoli: un job per conferma, lead unici per (org, URL) e (org, obiettivo, testo), chiavi esterne composte con
l'organizzazione (nessun riferimento tra organizzazioni), `organization_id` immutabile.

**Non applicata al database di produzione.** Per applicarla: prima su un branch Supabase/staging, poi
`npm run test:rls` su quel database, poi produzione con approvazione del proprietario.

## 4. Sicurezza e controllo costi

- Nessuno scraping di Facebook o LinkedIn: si leggono solo titolo ed estratto dei risultati Google (SerpApi).
- Nessun invio di messaggi: il CRM riceve il lead con la nota «contatto manuale».
- Nessuna spesa senza conferma: stima gratuita → token monouso (256 bit, solo hash nel DB, 10 minuti) legato a
  utente, organizzazione, obiettivo, seme e budget → casella di conferma esplicita → avvio.
- Richieste duplicate: token consumato in modo atomico, `unique(confirmation_id)` sui job, chiave di idempotenza
  verso il servizio, nonce HMAC monouso.
- Limiti per organizzazione: chiamate live/mese (default 200) e massimo per caccia (default 50) in
  `demand_hunter_limits`, prenotati prima e chiusi dopo; tetto del servizio; una caccia alla volta; rate limit.
- Chiamate SerpApi reali registrate nel Control Center (`billing_record_provider_call`, provider `serpapi`):
  costi e sospensione del provider dalla console Super Admin.
- Stripe: nessuna modifica. Accesso con la funzionalità di piano già esistente `lead_finder`.
- Modalità simulata sempre dichiarata (banner, badge, URL «esempio-simulato»); i lead simulati non entrano
  nel CRM e non consumano il limite mensile.

## 5. Variabili d'ambiente

Netlify (server-side, mai `VITE_`): `DEMAND_HUNTER_SERVICE_URL`, `DEMAND_HUNTER_SERVICE_SECRET`,
`DEMAND_HUNTER_ENABLED` (facoltativa), `DEMAND_HUNTER_ALLOW_HTTP` (solo sviluppo locale).
Server: vedi `services/demand-hunter/README.md`.

## 6. Test

| Suite | Comando | Risultato |
|---|---|---|
| Vitest (esistenti + nuovi) | `npm test` | 51 file superati, 502 test superati (453 esistenti + 49 nuovi); 1 test e2e saltato senza servizio |
| TypeScript | `npm run typecheck` | nessun errore |
| RLS e migrazioni (PostgreSQL 17 locale) | `LC_ALL=C npm run test:rls` | 18 migrazioni applicate; 899 controlli superati (848 esistenti + 51 nuovi) |
| Servizio Python | `python -m unittest discover -s tests -t .` | 86 test superati (28 nuovi + 58 originali BuyerML) |
| Integrazione gateway ↔ servizio | `service.e2e.test.ts` con il servizio locale | superato (simulato) |
| Segreti | `npm run security:secrets` | nessun segreto |

Nota: `npm run test:rls` richiede `LC_ALL=C` in ambienti con locale diverso; altrimenti la shell ordina
`rls_tests_billing.sql` prima di `rls_tests.sql` (problema preesistente dello script, non del modulo).

## 7. Funzionalità future: punti di integrazione (non implementate)

| Modulo | Codice BuyerML | Punto di integrazione | Prerequisiti |
|---|---|---|---|
| Google Trends Intelligence | `trends.py` (monitor, z-score, breakout, discovery), `TrendDiscovery` | nuovo endpoint del servizio `/v1/trends/*` → semi suggeriti al passaggio 2; tabella `demand_hunter_trend_observations` | conferma di spesa (1 chiamata ogni 5 termini), job programmato |
| ATECO Intelligence | `ateco.py`, `data/ateco_2025.csv`, `layer3.py`, `companies.py` | da un lead «cliente» → codice ATECO del settore → aziende simili nel **Lead Finder** esistente (provider) | licenza dati ISTAT, Google Maps via SerpApi a pagamento |
| SEO e AEO Intelligence | `buyerml_seo_aeo_workflow.py` (8 fasi) | gli oggetti con più lead (`learning`) diventano brief di contenuti per il marketing | volumi solo da autocomplete/Trends (decisione BuyerML) |
| Assistente Clara | `clara.py`, `docs/CLARA_ARCHITETTURA.md` | orchestratore conversazionale sopra le stesse API del gateway; budget di richieste per conversazione | AI Gateway/OpenAI già presente nell'app, schema JSON, nessun tool calling libero |
| AI Voice | `bland_calls.py`, `call_script.py` | campagne di chiamata dal CRM con conferma forte e lista «non chiamare» | consenso, Registro delle opposizioni, contratto Bland, revisione legale |
| Modelli AI addestrabili | `label_demand.py`, `train_demand.py`, `eval_demand.py` | `demand.from_model` già previsto: un lettore addestrato sostituisce le regole con lo stesso contratto; i feedback Giusto/Sbagliato sono le etichette | GPU, licenze modelli (twitter-xlm-roberta da verificare), set di controllo reale |
| Market Intelligence universale | `CACCIA.md` §«livello universale»: 80% budget IT / 20% universale, cancellazione a 90 giorni | nuovo obiettivo oltre `clienti`/`lavoro`, archivio separato, job di conservazione | politica di conservazione approvata, valutazione GDPR |

## 8. Problemi aperti

1. Servizio Python non ancora installato: senza `DEMAND_HUNTER_SERVICE_URL`/`SECRET` la pagina mostra
   «servizio non collegato» e nessuna ricerca parte.
2. Migrazione 0018 da applicare su staging e poi produzione (non eseguita).
3. Base giuridica e conservazione: gli estratti pubblici possono contenere nomi di persone. Base indicata
   «legittimo interesse»: da validare con il consulente privacy; manca una conservazione automatica dei lead
   Demand Hunter non trasferiti (BuyerML prevedeva 90 giorni per i non IT).
4. Termini d'uso: verificare con SerpApi e con i termini di Google l'uso commerciale dei risultati.
5. Agenti non registrati nel motore di workflow `ai_workflows` (richiede una migrazione dei vincoli `agent_key`).
6. Limiti per organizzazione modificabili solo via SQL (nessuna schermata Super Admin ancora).
7. Il servizio usa un solo processo: per più istanze servono nonce e job condivisi (es. Redis/Postgres).
8. L'espansione di un'area è sincrona (timeout 9 s, sotto il limite di 10 s delle functions): se SerpApi è lento la richiesta fallisce e la prenotazione resta conteggiata (mai sottostimata).
