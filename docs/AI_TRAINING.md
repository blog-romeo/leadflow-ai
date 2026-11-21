# AI Training, valutazione e miglioramento controllato (Prompt 12)

**Nessun agente è stato "addestrato"** nel senso di un aggiornamento dei pesi di un modello. Questo documento descrive un
framework di **valutazione e miglioramento controllato** e i benchmark realmente eseguiti, tutti su dataset **sintetici**.

## 1. Le cinque tecniche, distinte

| Tecnica | Cosa significa qui | Stato |
| --- | --- | --- |
| A. Prompt optimization (e regole) | modifica versionata di prompt o regole deterministiche (es. codici bloccanti del Quality Reviewer, sinonimi dei settori, pesi di default) | **implementata** come versioni di configurazione `kind = prompt | rules`; applicata dal motore solo per `quality_reviewer.blocking_codes` |
| B. Retrieval e memoria | il contesto della singola organizzazione (memoria aziendale isolata, evidenze, strategie approvate) recuperato al momento dell'esecuzione | **esistente** (Prompt 8) + nuove categorie `target_sectors`, `approved_feedback` |
| C. Few-shot learning | esempi approvati inclusi nel contesto | **predisposto**: i feedback validati "come esempio" entrano in `approved_feedback` della sola organizzazione; il loro uso nei prompt NON è attivo (richiede una versione di prompt approvata e un benchmark con modello reale) |
| D. Fine-tuning reale | addestramento di un modello con pesi nuovi presso il provider | **non implementato, mai avviato**. Possibile solo la *registrazione* manuale di un modello già addestrato (`kind = fine_tuned_model`, con `model_id` e `cost_approval_reference` obbligatori) |
| E. Model evaluation | benchmark ripetibili con metriche | **implementata** (`training/benchmark.ts`); i compiti che richiedono un modello risultano `not_executed` senza credenziali |

## 2. Ciclo di miglioramento controllato

1. L'agente produce un risultato (envelope validato, Prompt 9).
2. Il **Quality Reviewer** lo valuta (regole deterministiche, nessun modello).
3. L'utente può segnalarlo come utile o da correggere (`ai_feedback_submit`, con correzione strutturata).
4. L'amministratore dell'organizzazione **valida o rifiuta** (`ai_feedback_review`).
5. Solo con il suo consenso il feedback diventa un **esempio nella memoria della stessa organizzazione** (scadenza 365 giorni).
   Le configurazioni di **piattaforma** non usano mai i feedback dei clienti: si valutano solo su dataset sintetici o autorizzati.
6. Una configurazione **candidata** viene valutata offline (`POST /api/super-admin/ai-benchmark-run`, dal server).
7. Il confronto avviene con la versione attiva sullo **split di test**, mai usato per derivare il candidato.
8. Solo con gate superato **e** approvazione motivata del Super Admin la versione diventa attiva
   (`sa_ai_config_activate`); **rollback** immediato con `sa_ai_config_rollback`. Tutto in `admin_audit_logs`.

Nessun aggiornamento automatico di pesi, nessuna modifica autonoma dei prompt di produzione.

## 3. Dataset (versionati, sintetici, split separati)

| Dataset | Versione | Train / Val / Test | Compito |
| --- | --- | --- | --- |
| `sector_classification` | 1.0.0 | 20 / 20 / 20 | classificazione settori, astensione per settori non coperti |
| `lead_scoring` | 2.0.0 | 10 / 10 / 10 | priorità di compatibilità |
| `output_review` | 1.0.0 | 8 / 8 / 8 | difetti degli output, dati insufficienti |
| `prompt_injection` | 1.0.0 | 12 / 12 / 12 | resistenza alle injection |
| `discovery_normalization` | 1.0.0 | 2 / 2 / 2 | normalizzazione, deduplicazione, fonti |
| `provider_errors` | 1.0.0 | 4 / 4 / 4 | gestione errori del provider |
| `support_chat` | 1.0.0 | 20 / 20 / 20 | chatbot di assistenza: articolo giusto o astensione (Prompt 13) |
| `llm_strategy` | 1.0.0 | 1 / 1 / 2 | strategia con modello reale (**non eseguito**) |

La contaminazione è verificata a ogni esecuzione (`checkContamination`): nessun id e nessun input ripetuto tra split.
La prima esecuzione ha **trovato** un caso duplicato tra train e test (`output_review`), corretto prima dei risultati qui sotto.

## 4. Risultati realmente eseguiti (21/11/2026, report in `docs/ai-training/benchmark-2026-11-21.json`)

Confronto sullo **split di test** (candidati derivati solo da train, scelti su validation):

| Suite | Metrica | Baseline | Candidato | Δ | Gate | Nota |
| --- | --- | --- | --- | --- | --- | --- |
| Classificazione settori | F1 macro | 0,863 | 1,000 | +0,137 | superato | candidato = 6 sinonimi ricavati dagli errori di train. **Non applicato in produzione** (chiave non ancora collegata al motore). Ottimistico: alcune radici (es. "odontoiatric-") compaiono anche nel test |
| Lead scoring | F1 macro | 1,000 | 1,000 | 0 | superato | nessun miglioramento: **non promuovere**. Su validation entrambi 0,806 |
| Controllo output | F1 (difetti) | 0,000 | 1,000 | +1,000 | superato | candidato = Quality Reviewer. Ottimistico: dataset e regole scritti dallo stesso team |
| Blocchi del Reviewer (con candidato `unsourced_fact`) | blocchi su output difettosi | 0,333 | 0,500 | +0,167 | superato | 0 output corretti bloccati |

Altre suite (test): injection P = R = F1 = 1,000 (6 positivi); normalizzazione discovery corrispondenza esatta 1,000 e copertura
fonti 1,000; errori del provider accuratezza 1,000; `llm_strategy` **non eseguita**.

**Come leggerli**: verificano che i componenti deterministici facciano ciò che dichiarano su casi noti. Non sono accuratezze
commerciali, non riguardano modelli AI e non autorizzano a dichiarare miglioramenti per i clienti.

### Aggiornamento Prompt 13 (21/11/2026)

- **Sinonimi dei settori applicati** al catalogo usato in produzione (`lead-finder/sectors.ts`): odontoiatrico/odontoiatrica,
  parrucchiera, concessionario, termoidraulico, autoriparazioni, "bed breakfast". Baseline dopo l'applicazione: F1 macro
  train 1,000, validation 0,921 (errore residuo: `sc-va-10`), test 1,000. Il test resta **ottimistico** per lo stesso
  motivo indicato sopra (radici in comune tra split); il candidato derivato da train ora è vuoto.
- **Chatbot di assistenza** (`support_retrieval`, nessun modello AI): soglia scelta su train/validation, test eseguito
  una sola volta dopo la scelta. Test: precisione@1 0,889 (16/18), recall@3 0,944, astensione corretta 4/4, 0 risposte
  date a domande fuori tema. Errori sul test: `sq-te-06` (crediti → Business Analyzer), `sq-te-08` (privacy → Lead Finder).
  Dettagli in `docs/SUPPORT_CHATBOT.md`.

## 5. Prestazioni (misurate in processo)

| Misura | Prima | Dopo | Come |
| --- | --- | --- | --- |
| Chiamate allo store, workflow da 30 aziende | 476 | **394** (−82, −17%) | punto di controllo in una sola UPDATE condizionata al lease (`heartbeat`) al posto di 3 chiamate |

Il conteggio delle chiamate è deterministico e attendibile (ogni chiamata è un round trip verso Supabase in produzione); la
latenza reale va misurata in staging (`report.perf_last_invocation`, log `ai_workflow.finished`). Non ottimizzati, perché non
dimostrati come colli di bottiglia: i 137 registri delle chiamate ai tool (audit, da non perdere) e le 30 scritture di evidenze.

## 6. Comandi

- `npm run ai:benchmark` — esegue i benchmark (Vitest) e scrive `benchmark-report.json`.
- `npm run ai:eval` — valutazione del Prompt 9 (resta disponibile).
- Dashboard: `/super-admin/ai-training` (esecuzione dal server, versioni, gate, approvazione, rollback).
