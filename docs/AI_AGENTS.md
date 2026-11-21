# LeadFlow AI — Motore multi-agent (Prompt 8, aggiornato al Prompt 9)

Stato: **beta privata, spenta di default** (`AI_AGENTS_ENABLED` vuota). Implementato e testato con servizi
simulati; **mai eseguito su Supabase, OpenAI o Overpass reali** (vedi `RELEASE_READINESS.md`, REL-28).

## 1. Architettura

```
Utente ── /app/ai-workflows ──► POST /api/ai-workflows/plan   (interpretazione a regole, nessun effetto)
                              ► POST /api/ai-workflows/start  (auth + org + flag + piano + idempotenza)
                                          │ dispatch (segreto interno)
                                          ▼
                         background /api/ai-workflows/run ──► LeadFlow AI Orchestrator (engine.ts)
                                          │ lease nel DB, un solo esecutore per workflow
             ┌────────────┬───────────────┼────────────────┬───────────────┬──────────────┐
         Discovery     Research        Scoring      Orchestrator      Strategy      Follow-up / Growth
         runSearch     Analyzer +      scoreLead +  saveToCrm         Responses API  CRM / metriche SQL
         (Lead Finder) evidenze        storico      (dopo APPROVAZIONE) + postcheck   (+ Sales Agent)
             └────────────┴──────── Tool Gateway (allowlist, approvazioni, tenant, limiti, audit) ─────┘
                                          │
                 Supabase: ai_workflows, ai_workflow_steps, ai_agent_runs, ai_agent_tool_calls,
                 ai_agent_approvals, ai_research_evidence, ai_agent_costs, ai_company_memory, ai_agents
                 + ai_jobs (crediti del piano tramite i trigger di billing esistenti)
```

Codice: `netlify/functions/_shared/agents/` (`engine.ts`, `tools.ts`, `catalog.ts`, `planner.ts`, `budget.ts`,
`models.ts`, `handlers/*`, `supabaseStore.ts`). Interfaccia: `src/pages/app/AiAgents.tsx`, `AiWorkflows.tsx`,
`src/features/ai-agents/*`. Migrazione: `supabase/migrations/20261126000012_ai_agents.sql`.

### Stati

Workflow: `PENDING → RUNNING → (WAITING_APPROVAL ↔ PENDING) → COMPLETED | PARTIAL | FAILED | CANCELLED`.
Gli stati finali sono immutabili (trigger `ai_workflows_guard`). `PARTIAL` = almeno un risultato utile ma non tutti i
passi riusciti (budget, approvazione rifiutata, errori di singoli elementi).

### Garanzie dell'Orchestrator

| Requisito | Implementazione |
| --- | --- |
| Organizzazione autenticata | `requireOrgMember` (JWT verificato) su ogni endpoint; RLS sulle letture |
| Abbonamento e crediti | piano verificato nel planner (`billing_can_use_feature`); ogni chiamata AI crea un `ai_jobs` → prenotazione/addebito/rimborso crediti dai trigger esistenti, tetti USD del Control Center inclusi |
| Pianificazione | modelli fissi (`prospecting`, `follow_up_review`, `growth_report`); l'obiettivo libero è interpretato **con regole**, non da un LLM |
| Dipendenze | `depends_on` per passo; un passo con dipendenze fallite viene saltato (`dependency_not_completed`) |
| Idempotenza | `idempotency_key` unica per organizzazione; passi completati mai rieseguiti; avanzamento per elemento salvato a ogni checkpoint; un run per tentativo (`unique(step_id, attempt)`) |
| Timeout | per passo (`timeout_seconds`), per workflow (`deadline_at`), per invocazione (cessione a 11 min e ripresa) |
| Retry controllati | solo errori temporanei (timeout, 5xx, rate limit), backoff esponenziale, `max_attempts` |
| Limiti di spesa | budget del workflow, budget mensile dell'organizzazione e dell'agente, massimo per esecuzione (`budget.ts`) |
| Interruzione | RPC `ai_workflow_request_cancel`; verificata a ogni checkpoint |
| Operazioni non autorizzate | Tool Gateway (sotto) + RPC con controllo di ruolo |
| Risultati verificabili | `ai_agent_runs`, `ai_agent_tool_calls`, `ai_research_evidence`, `ai_agent_costs`, `audit_logs` |
| Report finale | `ai_workflows.report` (solo conteggi e riferimenti; nessun testo libero generato) |

## 2. Agenti

| Agente | Cosa fa | AI | Funzione di piano | Strumenti (allowlist) |
| --- | --- | --- | --- | --- |
| Orchestrator | piano, budget, salvataggio CRM **dopo approvazione** | no | — | `crm.save_leads`, `candidates.read` |
| Discovery | ricerca su provider autorizzato con licenza di memorizzazione, normalizza, deduplica, provenienza, dati mancanti | no | `lead_finder` | `provider.search`, `candidates.read` |
| Research | Analyzer esistente (sito pubblico con robots/SSRF) → evidenze FACT / INFERENCE / UNKNOWN | sì (economico) | `ai_analyzer` | `candidates.read`, `ai.analyze_company`, `evidence.write` |
| Lead Scoring | indice 0–100 + priorità, motivazione, evidenze, dati mancanti, suggerimento; storico commerciale opzionale | no | `lead_finder` | `candidates.read`, `profile.read`, `crm.history.read`, `scores.write`, `leads.read` |
| Sales Strategy | opportunità, servizio, valore, obiezioni, approccio, CTA, **bozza** (`message_drafts`, mai inviata) | sì (avanzato) | `ai_sales_agent` | `leads.read`, `profile.read`, `memory.read`, `evidence.read`, `ai.generate_strategy`, `drafts.write` |
| Follow-up | trattative ferme, scadenze, opportunità senza aggiornamenti → promemoria interni / blocco contatti (approvazione), bozze facoltative | facoltativa | `ai_sales_agent` | `crm.read`, `followups.create`, `followups.block`, `ai.follow_up_suggestion`, `drafts.write` |
| Growth Analyst | metriche reali (SQL), confronti solo con campione ≥ 30 e z-test p < 0,05 | no | `crm_advanced` | `metrics.read` |

Note di onestà:
- **Google Places** non è usato nei workflow: la licenza non consente la memorizzazione necessaria ai passi successivi.
- **Dimensione aziendale**: nessun provider attuale la fornisce; il filtro è segnalato come non supportato e il dato come mancante.
- Il punteggio è un **indice di compatibilità**, non una probabilità di acquisto (nessun modello validato su dati reali).
- Lo storico commerciale entra nel punteggio solo se l'amministratore imposta `history_weight` (0–30) e con almeno
  `min_history_sample` trattative chiuse nel settore (default 10).

## 3. Sicurezza dei tool (Fase 10)

- **Allowlist nel codice** (`catalog.ts`): né utenti né agenti possono ampliarla; la configurazione in DB può solo
  disattivare un agente, cambiare livello di modello o ridurre il budget.
- **Strumenti vietati** a qualsiasi agente (pattern): segreti/env/credenziali, ruoli/membri/permessi, billing/pagamenti/Stripe/prezzi,
  invio/attivazione di messaggi e campagne, cancellazioni massive, accesso ad altre organizzazioni, configurazione degli agenti.
- **Alto impatto** (`crm.save_leads`, `followups.create`, `followups.block`): solo con approvazione `approved` letta dal
  database e legata a quel passo e workflow; il riepilogo approvato (non l'output del passo) definisce cosa viene eseguito.
- **Tenant isolation**: argomenti con `organization_id`/`org_id` diversi sono negati (`cross_tenant`); store e RLS filtrano per organizzazione.
- **Validazione**: zod sugli input delle API e sui parametri, JSON Schema strict + zod sull'output AI, vincoli CHECK nel DB
  (un FACT senza fonte ed estratto è rifiutato dal database).
- **Prompt injection**: contenuti esterni sanificati (`sanitize.ts`), dati solo nel blocco `<dati_non_attendibili>`,
  regole solo nel messaggio di sistema, postcheck (email inventate rimosse, URL/telefoni/importi non presenti segnalati,
  promesse di risultato segnalate), deduzioni su intenzioni di acquisto scartate.
- **Chiamate esterne**: solo tramite i moduli esistenti (provider registry, Analyzer con SSRF/robots, Responses API).
- **Limiti**: 400 tool call per esecuzione, timeout, budget, `max_attempts`.
- **Audit**: ogni tool call (anche negata) con argomenti riassunti e oscurati; cambi di stato e decisioni in `audit_logs`.
- **Credenziali**: i moduli AI ricevono un ambiente ridotto (`envForTier`); nessun segreto nei prompt o nei registri (test).

## 4. Memoria aziendale (Fase 8)

`ai_company_memory`: categorie autorizzate, versionamento (`active`/`superseded`), scadenza obbligatoria (1–1095 giorni,
la memoria scaduta non è più leggibile), RPC `ai_memory_upsert` (membri: solo feedback; amministratori: il resto),
`ai_memory_delete` (amministratori, tutte le versioni), audit senza contenuto. "Strategie approvate" = salvataggio
esplicito di un amministratore dalla pagina del workflow. La rimozione fisica della memoria scaduta
(`ai_memory_purge_expired`, solo service role) **non è pianificata**: decisione del titolare, come REL-9.
I dati di un cliente non sono mai usati per altri clienti: memoria, cache e evidenze sono filtrate per organizzazione e
nessun dato viene usato per addestrare modelli (Responses API con `store: false`).

## 5. Costi (Fase 11)

- Modelli per livello da variabili (`OPENAI_MODEL`, `_ECONOMY`, `_ADVANCED`); prezzi per livello da variabili; senza
  prezzi il costo resta `NULL` ("non configurato"). Nessun prezzo nel codice.
- Crediti per operazione letti da `ai_credit_costs`: analisi (`business_analysis`) 1, strategia (`sales_strategy`) **2 — valore
  provvisorio** (REL-29), suggerimento di follow-up 1.
- Cache per organizzazione: analisi recenti (default 30 giorni) e strategie con lo stesso input (default 14 giorni) riusate senza crediti.
- Limiti di output: strategia 3.000 token; analisi come l'Analyzer esistente.

Stima per l'esempio "Trova 30 aziende alberghiere a Roma, analizzale e prepara proposte per le 10 più compatibili":
massimo **30 × 1 + 10 × 2 = 50 crediti** (meno se in cache). Costo in USD = token effettivi × prezzi configurati
(registrato per chiamata in `ai_agent_costs` e `ai_jobs.cost_usd`); non è stimabile senza i prezzi del modello scelto.

## 6. Endpoint

| Metodo e percorso | Ruolo | Descrizione |
| --- | --- | --- |
| `GET /api/ai-agents/status?organization_id=` | membro | flag, catalogo agenti, configurazioni mancanti (variabili solo agli admin), spesa del mese |
| `POST /api/ai-workflows/plan` | membro | interpretazione dell'obiettivo e piano (passi, approvazioni, stima, mancanze) |
| `POST /api/ai-workflows/start` | membro | crea il workflow (idempotente) e lo avvia; 409 `plan_blocked` se manca configurazione |
| `POST /api/ai-workflows/control` | admin (approva/rifiuta), autore o admin (interrompi) | decisioni tramite RPC con il JWT dell'utente |
| `POST /api/ai-agents/rescore` | membro | ricalcolo del punteggio di candidati e lead (nessun credito) |
| `POST /api/ai-workflows/run` (background) | segreto interno | esecuzione/ripresa |
| `ai-workflows-tick` (ogni 5 min) | pianificata | scadenza approvazioni (72 h) e ripresa dei workflow interrotti |

RPC usate dal browser (RLS + controllo ruolo): `ai_agent_configure`, `ai_memory_upsert`, `ai_memory_delete`,
`ai_agent_spend`, `ai_growth_metrics`. Solo service role: `ai_memory_record`, `ai_memory_purge_expired`.

## 7. Feature flag

| Variabile | Effetto |
| --- | --- |
| `AI_AGENTS_ENABLED=true` | abilita le API e la function pianificata (spento: 404 `feature_disabled`, i workflow non vengono eseguiti) |
| `AI_AGENTS_PILOT_ORGS=<uuid,...>` | limita la beta a queste organizzazioni |
| `VITE_FEATURE_AI_AGENTS=true` | mostra le pagine nel menu (solo visibilità; route non registrate se spento) |

Il sito pubblico e `src/config/features.ts` **non** menzionano il motore multi-agent.

## 8. Test

- SQL: `supabase/tests/rls_tests_zy_ai_agents.sql` (89 asserzioni) + audit di schema esteso.
- Vitest (mock di provider e AI, **non** integrazioni reali): `netlify/functions/_shared/agents/__tests__/` (61 test) e
  `src/features/ai-agents/aiAgents.test.tsx` (5 test).

## 9. Prompt 9 — collaborazione, routing, qualità, osservabilità, resilienza

Stato: implementato e testato con servizi **simulati**; **mai eseguito su Supabase, OpenAI, Overpass o Netlify reali**
(nessuna credenziale nella sandbox di sviluppo). Vedi `RELEASE_READINESS.md` (REL-28, REL-35).

### 9.1 Agent Collaboration Engine (`envelope.ts`)

- Ogni esecuzione salva in `ai_agent_runs.output` un **envelope JSON validato con zod**: `workflow_id`, `organization_id`,
  `run_id`, `agent_key`, `action`, posizione e tentativo, `input` (parametri strutturati, dipendenze, approvazione),
  `output`, `output_valid`, `evidence` (FACT/INFERENCE/UNKNOWN, elementi con evidenza), `errors` (solo codici),
  `usage` (token, crediti, costo USD della singola esecuzione), `routing` (modello, livello, fallback), `items`,
  `duration_ms`, `started_at`, `completed_at`.
- L'output di ogni azione è validato **prima** di essere passato agli agenti successivi (`ACTION_OUTPUT_SCHEMAS`). Un output
  non conforme ferma il passo con `invalid_agent_output`: errore permanente, **nessun retry** (nessun credito speso due
  volte), passi dipendenti saltati.
- Gli agenti si scambiano solo strutture tipizzate (id dei candidati, classifiche, id dei lead approvati); i testi generati
  restano campi di bozza, mai istruzioni per altri agenti.
- Il costo USD per esecuzione (`ai_agent_runs.cost_usd`) ora è registrato (prima restava NULL e il costo era solo per chiamata).

### 9.2 Intelligent Agent Routing (`models.ts`)

| Compito | Preferito | Minimo | Fallback ammessi | Usato da |
| --- | --- | --- | --- | --- |
| `classification` | economy | economy | standard | (predisposto; lo scoring è deterministico) |
| `summary` | economy | economy | standard | (predisposto) |
| `company_analysis` | economy | economy | standard, advanced | Research Agent |
| `sales_strategy` | advanced | **standard** | standard | Sales Strategy Agent |
| `follow_up_draft` | economy | economy | standard | Follow-up Agent |

Nomi dei modelli e prezzi solo da variabili server-side (`OPENAI_MODEL`, `_ECONOMY`, `_ADVANCED`, `OPENAI_PRICE_*`).
La configurazione dell'organizzazione e l'override `AI_ROUTE_<COMPITO>` non scendono mai sotto il minimo. Il fallback avviene
solo se il modello del livello richiesto **non è configurato**, mai dopo un errore del modello (eviterebbe doppie chiamate).
`npm run integrations:preflight` con `PREFLIGHT_NETWORK=1` verifica che i modelli configurati esistano per la chiave.

### 9.3 AI Quality Evaluation (`eval/`)

- Dataset **sintetici** ed etichettati in `netlify/functions/_shared/agents/eval/datasets/` (`"synthetic": true`, domini
  `.example`), separati dai dati dei clienti e mai letti dalle functions.
- `npm run ai:eval`: concordanza dello Scoring Agent con etichette manuali (matrice di confusione), recall e falsi positivi dei
  controlli sull'output AI, misure di prestazione in processo. Con `AI_EVAL_LIVE=1` e credenziali: percentuale di JSON validi,
  fatti con evidenza, avvisi di informazioni non supportate, token e durata **del modello reale** sui contesti sintetici.
- Le metriche sulle esecuzioni reali (JSON validi, copertura delle evidenze, errori per elemento, fallback, costo, durata) sono
  calcolate da `sa_ai_monitoring` sugli envelope.

### 9.4 Osservabilità — `/super-admin/ai-monitoring`

RPC `sa_ai_monitoring(from, to, org, agent, status)` (migrazione 0013, solo super admin, accesso registrato): workflow per stato
e modello, attivi ora, durata e latenza di avvio, agenti (esecuzioni, in corso, fallite, tasso errori, media e p95, token,
crediti, costo, esecuzioni senza prezzo), qualità, errori più frequenti, costi per tipo, serie giornaliera, per organizzazione
(solo id, nome e conteggi). Provider e routing mostrano solo la **presenza** della configurazione. Nessun obiettivo, output o
nome di azienda dei clienti viene restituito (verificato dai test SQL).

### 9.5 Resilienza

| Requisito | Implementazione |
| --- | --- |
| Retry con backoff | esponenziale con jitter, rispetto di `retry_after`, tetto 30 s (`retryDelayMs`) |
| Esecuzioni concorrenti | lease per workflow (Prompt 8) + **massimo 2 workflow `pending/running` per organizzazione** (trigger con advisory lock, migrazione 0013); il replay con la stessa chiave idempotente non è bloccato |
| Nessuna ripetizione rischiosa | errori permanenti e output non validi non vengono ritentati; il salvataggio nel CRM ha `max_attempts = 1` |
| Catene di dipendenze | corretto un difetto: due o più passi dipendenti da un passo fallito chiudevano il workflow con `dependency_deadlock` invece di saltarli |

Timeout, idempotenza, ripresa, annullamento, budget e registro degli errori: invariati rispetto al Prompt 8 (§1).

### 9.6 Interfaccia

`/dashboard/ai-workflows` (alias di `/app/ai-workflows`): polling ogni 4 s durante l'esecuzione, durata e crediti per passo,
elementi già elaborati, avviso di risultati parziali, esportazione JSON del workflow e CSV della classifica (solo a workflow
concluso, solo dati dell'organizzazione corrente, CSV protetto dalla formula injection), errori leggibili per i nuovi codici.

## 10. Prompt 10 — collegamento reale ai provider

- **Verifica delle connessioni** (`connections.ts`, `POST /api/ai-agents/connections-check`, tabella `integration_checks`):
  GET di sola lettura su `/v1/models/<modello>` per ogni livello e su Overpass `/status`. La console mostra
  `PROVIDER_NOT_CONFIGURED`, "Configurato, non verificato", "Verificato" (esito reale < 24 h), "Verifica scaduta" o
  "Verifica fallita": un provider non è mai mostrato come connesso senza verifica.
- **OpenAI**: 429 con `Retry-After` propagato al backoff del motore; token di risposte troncate o rifiutate registrati in
  `ai_agent_costs` con 0 crediti (prima andavano persi nel costo); 401/403 errore permanente.
- **Log**: oscuramento anche dei valori (chiavi Stripe, OpenAI, Resend, Google, GitHub, JWT, Bearer) oltre ai nomi dei campi.
- **Misura**: `ai_workflows.report.perf_last_invocation` e il log `ai_workflow.finished` riportano le chiamate allo store
  (≈ query) per invocazione, per confermare o smentire in staging il costo dei checkpoint (REL-37) prima di ottimizzare.
- **Avvisi**: `ai_monitoring_evaluate` (workflow falliti > 30% con almeno 3, workflow fermi, verifica fallita).
- **Strumenti di staging**: `npm run staging:e2e` (5 aziende, 3 proposte, si ferma all'approvazione), `npm run staging:isolation`
  (due organizzazioni, RLS reali), `npm run integrations:preflight`, workflow GitHub "Staging checks".
