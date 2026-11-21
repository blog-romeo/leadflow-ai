# Matrice delle funzionalità (Prompt 12, 21/11/2026)

Legenda: **TESTED** = test realmente eseguiti in sviluppo (SQL su PostgreSQL 16; logica TS con runner di compatibilità, **non**
Vitest) · **IMPLEMENTED** = codice presente, non testato in modo automatico · **BLOCKED** = richiede servizi o decisioni esterne
per essere verificato · **NOT IMPLEMENTED**. Nessuna voce è verificata su Supabase, Netlify, Stripe o OpenAI reali.

| Area | Stato | Note |
| --- | --- | --- |
| Frontend React (pagine, routing, i18n IT/EN) | IMPLEMENTED · BLOCKED | mai compilato con `tsc -b`/`vite build` (npm non raggiungibile); 8 file di test React non eseguibili qui |
| Netlify Functions (49) | TESTED (bundle esbuild) · BLOCKED | esbuild non equivale alla build; deploy mai eseguito |
| Supabase: schema, migrazioni 0001–0015 | TESTED | 765 asserzioni su PostgreSQL 16 locale |
| Autenticazione (registrazione, login, recupero password) | IMPLEMENTED · BLOCKED | Supabase Auth reale non verificato |
| Autorizzazioni, ruoli, RLS, multi-tenancy | TESTED (locale) · BLOCKED (reale) | isolamento A/B testato in SQL; `staging:isolation` pronto |
| Stripe (checkout, webhook, portale) | TESTED (simulato) · BLOCKED | REL-2 |
| Crediti e concorrenza | TESTED | test di concorrenza su PostgreSQL 16 |
| CRM, pipeline, campagne (solo bozze) | TESTED (logica) | invii esterni disattivati |
| AI Orchestrator (piano, dipendenze, retry, timeout, annullamento, idempotenza, costi, audit) | TESTED | Prompt 8–12 |
| Envelope JSON validati tra agenti | TESTED | Prompt 9 |
| **Quality Reviewer** (fase logica) | TESTED | Prompt 12: 8 codici, blocchi configurabili con versione approvata |
| Discovery Agent: settore, area, deduplicazione, fonti, normalizzazione, dati mancanti | TESTED | filtro dimensionale: **NOT IMPLEMENTED** (nessun provider fornisce il dato; segnalato come non supportato) |
| Research Agent: sito, servizi, segnali, FACT/INFERENCE/UNKNOWN, fonti, data | TESTED (mock AI) · BLOCKED (modello reale) | confidenza motivata = classificazione FACT/INFERENCE/UNKNOWN con estratto; nessun punteggio numerico di confidenza |
| Scoring Agent spiegabile | TESTED | dettaglio per criterio; indice di compatibilità, non probabilità |
| Strategy Agent (fatti vs ipotesi, obiezioni, approccio, bozza) | TESTED (mock AI) · BLOCKED | |
| Follow-up Agent (promemoria, duplicati, preferenze di contatto, bozze) | TESTED | sequenze multi-step automatiche: NOT IMPLEMENTED (per scelta: nessun invio automatico) |
| Growth Analyst (funnel, segmenti, z-test con campione minimo) | TESTED | ROI: solo ricavi attribuiti e costi registrati, nessuna attribuzione causale |
| Memoria aziendale (versioni, scadenza, correzione, cancellazione, audit, accessi, minimizzazione) | TESTED | Prompt 12: minimizzazione email/telefoni, nuove categorie |
| Feedback umano validato | TESTED | Prompt 12, isolato per organizzazione |
| Framework di valutazione, benchmark, versioni, gate, rollback | TESTED | Prompt 12 |
| Fine-tuning | NOT IMPLEMENTED | per scelta; solo registrazione manuale con approvazione dei costi |
| Valutazione con modello reale | BLOCKED | nessuna credenziale |
| Logging sicuro, avvisi, monitoraggio AI | TESTED | Prompt 9–10 |
| Super Admin: monitoraggio AI, AI Training | TESTED (SQL) · IMPLEMENTED (UI) | |
| Inviti, supporto, audit | TESTED (SQL) | |
| Retention automatica | IMPLEMENTED (spenta) | decisione del titolare (REL-9) |
| Backup | BLOCKED | dipende dal piano Supabase (REL-15) |
| Rate limiting | TESTED | `check_rate_limit`, `public_rate_limit`, limite feedback |
| Cancellazione account / organizzazione self-service | IMPLEMENTED, NOT VERIFIED IN PRODUCTION | Prompt 13: Impostazioni → Cancellazione; SQL testato; eliminazione definitiva dopo 30 giorni con `RETENTION_PURGE_ENABLED=true` (REL-50) |
| Chatbot di assistenza (sito + app) | IMPLEMENTED, NOT VERIFIED IN PRODUCTION | Prompt 13: `/api/support-chat`, risposte dalla documentazione, ticket con conferma; AI solo in app e solo se configurata (`docs/SUPPORT_CHATBOT.md`) |
| Beta gratuita (piano a costo zero) | IMPLEMENTED, DISABLED BY DEFAULT | Prompt 13: `sa_set_free_beta` + `VITE_FREE_BETA`; nessun pagamento, tetti di 100 lead / 200 crediti / 3 utenti al mese |
| Accessibilità e responsive | IMPLEMENTED | controllo visivo solo con dati simulati (Prompt 8); nessun Lighthouse |

## Note dell'audit del codice

- Nessun file sorgente inutilizzato (nessun modulo senza import).
- Duplicazioni minori volute (piccoli helper `obj/arr/num`, tipo `Widen` nei dizionari): non rifattorizzate per non toccare
  codice funzionante.
- Due strumenti di valutazione coesistono: `agents/eval/` (Prompt 9) e `agents/training/` (Prompt 12). Il secondo è quello di
  riferimento; il primo resta per continuità dei report.
- `chooseModel` (Prompt 8) è usata solo per lo stato in console; il motore usa `routeModel` (Prompt 9).
- Errore trovato e corretto: tipo nullo di `sourceUrl` nel benchmark (controllo dei tipi parziale).
