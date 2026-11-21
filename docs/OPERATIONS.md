# Operazioni: monitoraggio, log, backup e ripristino

## Monitoraggio integrato (Prompt 6)

Tutto è consultabile in **Console Super Admin → Sistema** (`/super-admin/system`).

| Cosa | Fonte dati | Soglia di avviso (`monitoring_evaluate`) |
| --- | --- | --- |
| Webhook Stripe falliti | `stripe_webhook_events.status = 'failed'` (24 h) | ≥ 1 → **critical** |
| Webhook Stripe bloccati | `status = 'processing'` con lock scaduto da > 10 min | ≥ 1 → **critical** |
| Errori API (500) | `app_errors` sorgente `function` (24 h) | ≥ 20 → **critical** |
| Errori browser | `app_errors` sorgente `client` (24 h) | ≥ 50 → warning |
| Job AI fermi | `ai_jobs` in coda/esecuzione da > 20 min | ≥ 1 → warning |
| Job AI falliti | `ai_jobs.status = 'failed'` (24 h) | ≥ 10 e > 20% dei completati → warning |
| Automazioni fallite | `automation_jobs.status = 'dead'` (24 h) | ≥ 10 → warning |
| Costo AI del mese | somma `ai_jobs.cost_usd` | ≥ soglia % del budget (Control Center) → warning |
| Stato integrazioni | presenza delle variabili d'ambiente | informativo |

- La function pianificata `monitoring-tick` (ogni 15 minuti) registra gli avvisi in `monitoring_alerts`,
  **uno per tipo al giorno**, e invia un'email interna se `PLATFORM_NOTIFY_*` è configurato. Senza
  configurazione gli avvisi restano visibili solo nella console (esito "non notificato").
- I costi AI sono stimati solo se `OPENAI_PRICE_INPUT_PER_MTOK` / `OUTPUT` sono impostati.

### Tracciamento errori

- **Functions**: ogni risposta 500 (errore non gestito o `HttpError` 5xx diverso da 503) viene registrata in
  `app_errors` con codice, messaggio sanificato (email, UUID, numeri, token e query rimossi), percorso e
  release (`COMMIT_REF`). Gli errori sono aggregati per impronta e giorno (contatore `occurrences`).
  L'invio è *best effort* (timeout 2,5 s, mai bloccante): un errore può non essere registrato se la function
  termina prima della scrittura.
- **Browser**: `window.onerror` e `unhandledrejection` → `/api/monitoring/client-error` (max 5 per pagina,
  30/ora per IP-hash). Disattivato in sviluppo.
- **Nessun servizio esterno** (Sentry, Datadog…) è integrato. Si può aggiungere in seguito.

### Log strutturati

- `log(level, event, fields)` in `netlify/functions/_shared/log.ts` scrive JSON su stdout/stderr (visibili in
  *Netlify → Logs → Functions*). Le chiavi che possono contenere segreti o dati personali (key, token, secret,
  authorization, password, email, phone, name, body, input, output…) vengono sempre oscurate.
- Non registrare mai: corpo delle richieste, credenziali, contenuto di email o ticket.
- La conservazione dei log dipende dal piano Netlify: per conservarli più a lungo serve un *Log Drain* (piani a pagamento).

### Monitoraggio esterno consigliato (da configurare)

- Uptime check esterno su `https://<dominio>/api/health` (es. ogni 5 minuti) con avviso via email/SMS.
- Stripe Dashboard → Webhook: avvisi sugli endpoint in errore.
- Supabase → Reports: utilizzo database, connessioni, Auth.

## Backup

| Dato | Dove | Backup | Da verificare |
| --- | --- | --- | --- |
| Database (tutti i dati applicativi) | Supabase Postgres | automatico secondo il piano Supabase (giornaliero sui piani a pagamento; PITR come add-on) | piano attivo, retention, prova di ripristino |
| File di branding | Supabase Storage (`branding`) | **non** inclusi nei backup del database | copia periodica del bucket se necessaria |
| Pagamenti, fatture | Stripe | gestiti da Stripe (fonte di verità) | — |
| Codice e configurazione | GitHub + Netlify | storico Git + deploy immutabili Netlify | variabili d'ambiente annotate in un gestore di segreti |

- Esportazione logica periodica consigliata: `pg_dump` (schema + dati) su storage cifrato esterno, con
  conservazione definita nell'informativa privacy.
- Le variabili d'ambiente (chiavi Stripe, OpenAI, `LEADFLOW_CREDENTIALS_KEY`…) vanno conservate in un gestore di
  segreti: **se `LEADFLOW_CREDENTIALS_KEY` viene persa, le credenziali dei provider email salvate non sono più leggibili**.

## Ripristino

1. **Deploy difettoso** → Netlify *Deploys → Publish deploy* sul deploy precedente (rollback immediato del frontend e delle functions).
2. **Dati danneggiati** → ripristino Supabase (backup giornaliero o PITR) in un nuovo progetto, verifica, poi switch delle variabili `SUPABASE_*` / `VITE_SUPABASE_*`.
3. **Stato abbonamenti disallineato** → lo stato viene sempre riletto da Stripe: rinviare gli eventi dal Dashboard Stripe (*Webhook → Resend*); l'elaborazione è idempotente per `event.id`.
4. **Webhook falliti** → correggere la causa (log `stripe.webhook_*`), poi rinviare gli eventi da Stripe.
5. **Costi AI anomali** → Console → Utilizzo e costi → *Sospendi AI* (pausa immediata) o tetto per organizzazione.
6. **Abuso del modulo demo** → limiti già attivi (5/ora per IP-hash, 200/ora globali); in emergenza rimuovere `LEADFLOW_INTERNAL_SECRET` disattiva il modulo (risposta 503), oppure bloccare l'IP con le regole di Netlify.

## Manutenzione periodica

- `public_rate_limits`: pulizia automatica delle finestre > 2 giorni.
- `app_errors`, `monitoring_alerts`, `funnel_events`: definire la conservazione (es. 12 mesi) e una pulizia periodica — **non ancora automatizzata**.
- Revisione mensile: avvisi, costi AI per organizzazione, ticket aperti, richieste demo non gestite.
