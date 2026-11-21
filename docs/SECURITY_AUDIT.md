# Audit di sicurezza per la produzione (Prompt 6)

Data: 20/11/2026 · Ambito: codice di questo repository (migrazioni 0001–0009, Netlify Functions, frontend).
Metodo: revisione del codice + test automatici **eseguiti** su PostgreSQL locale (con stub dei ruoli Supabase) e
test TypeScript con un runner Node. **Non** sono stati eseguiti test contro Supabase, Stripe o Netlify reali.

Legenda esito: ✅ verificato da test eseguiti · 🔎 verificato da revisione del codice · ⚠️ da completare/verificare in produzione.

| # | Area | Esito | Evidenza |
| --- | --- | --- | --- |
| 1 | **RLS** | ✅ | `rls_tests_zz_security_audit.sql`: RLS attiva su **tutte** le tabelle `public`; nessuna scrittura diretta di `anon`; tabelle di stato (abbonamenti, quote, ledger, webhook, audit, funnel, demo, ticket, onboarding, errori) senza INSERT/UPDATE/DELETE per `authenticated`. 543 asserzioni SQL superate (isolamento, ruoli, quote, billing, White Label, launch). |
| 2 | **Funzioni SECURITY DEFINER** | ✅ | Tutte con `search_path` fisso; schema `private` non accessibile ad `anon`; le funzioni `private` eseguibili dagli utenti sono solo predicati/validatori non volatili usati dalle policy. Le RPC solo-server (`billing_apply_subscription`, `tenant_by_hostname`, `track_public_event`, `record_app_error`, `monitoring_evaluate`, `public_rate_limit`…) non sono eseguibili da `authenticated`. |
| 3 | **Autenticazione** | 🔎 ⚠️ | Le functions verificano il JWT con `auth.getUser` (mai fidandosi del client) e l'appartenenza all'organizzazione. Ruolo `super_admin` assegnabile solo da `postgres` (trigger di protezione, test eseguito). ⚠️ Conferma email, SMTP, rate limit e CAPTCHA di Supabase Auth sono **configurazione del progetto**, da verificare. |
| 4 | **Ruoli e autorizzazione** | ✅ | Super admin, reseller_admin/member, organization_admin/member testati (accesso consentito/negato). Le feature flag non sostituiscono abbonamento e permessi (`feature_check` combina flag + piano + sospensione). |
| 5 | **Webhook Stripe** | ✅ (simulato) ⚠️ | Firma HMAC-SHA256 sul corpo grezzo, tolleranza 300 s, confronto a tempo costante, idempotenza per `event.id`, stato riletto da Stripe, protezione eventi fuori ordine — testati con gateway simulato. ⚠️ Mai eseguito con Stripe test reale. |
| 6 | **Pagamenti** | 🔎 ⚠️ | Nessun dato di carta sul server (Checkout ospitato). Attivazione solo da webhook (anche nell'onboarding: test SQL "pagamento non confermato senza webhook"). Live bloccato senza `STRIPE_LIVE_MODE_APPROVED`. ⚠️ **IVA non calcolata** se `STRIPE_AUTOMATIC_TAX` non è attivo (vedi RELEASE_READINESS HIGH-2). |
| 7 | **Segreti** | ✅ | `src/test/launch.test.ts`: nessun valore di segreto (sk_/rk_/whsec_/re_/JWT/sk-) né lettura di env server nel frontend; solo variabili `VITE_` pubbliche ammesse; il frontend non importa codice delle functions. `.env.example` senza valori. |
| 8 | **API AI** | ✅ (simulato) | Chiamate solo dal server (`store: false`), pausa AI, tetto per organizzazione e budget di piattaforma applicati anche all'assistente (test SQL). L'assistente risponde solo dalla documentazione, verifica che le fonti citate siano tra quelle recuperate, non salva la domanda, ignora istruzioni nel testo dell'utente (test TS). |
| 9 | **Provider dati** | 🔎 | Fetch verso URL esterni tramite client anti-SSRF (Prompt 2/5); Google Places solo in sessione; pausa per provider dal Control Center. |
| 10 | **Upload** | ✅ | Branding: tipo verificato dai magic byte, SVG rifiutato, limiti di dimensione (test `control.test.ts`). Import CSV: max 1000 righe, base giuridica obbligatoria. |
| 11 | **CORS** | 🔎 | Nessun header `Access-Control-Allow-*`: le API sono utilizzabili solo dallo stesso dominio dai browser. I webhook sono chiamate server-to-server autenticate dalla firma. |
| 12 | **CSP e header** | 🔎 | `script-src 'self'` + hash dello script inline (test CSP), `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. JSON-LD inserito come `application/ld+json` (non eseguibile). Nota LOW: `style-src 'unsafe-inline'`. |
| 13 | **Rate limiting** | ✅ | Utenti: `request_rate_limits` (azioni amministrative, ticket 5/min, risposte 20/min). Pubblico: `public_rate_limits` con chiave HMAC dell'IP (demo 5/ora + 200/ora globali, statistiche 120/ora, errori 30/ora), assistente 20/ora per utente. Test SQL eseguiti. ⚠️ Rate limit di Supabase Auth da configurare. |
| 14 | **Isolamento tenant** | ✅ | Test: organizzazioni diverse, rivenditori diversi, ticket (membro vede solo i propri, admin quelli dell'organizzazione), onboarding, checklist, demo (solo staff), funnel ed errori (solo super admin). Branding risolto dall'hostname lato server. |
| 15 | **Logging** | 🔎 | Log JSON con oscuramento delle chiavi sensibili; errori sanificati prima del salvataggio (test). Nessun IP in chiaro salvato (vincolo CHECK sull'hash: test). |
| 16 | **Backup** | ⚠️ | Dipende dal piano Supabase: da verificare con una prova di ripristino (vedi `docs/OPERATIONS.md`). Bucket Storage non incluso nei backup del DB. |
| 17 | **Recovery** | 🔎 | Procedure documentate (rollback deploy, ripristino DB, reinvio webhook idempotente, pausa AI). Non provate. |
| 18 | **Gestione errori** | ✅ | `handleError` non espone dettagli interni; codici stabili; 5xx registrati in `app_errors` (test di sanificazione). |
| 19 | **Privacy delle statistiche** | ✅ | Nessuna chiamata prima del consenso, rifiuto e Global Privacy Control rispettati, revoca cancella l'id anonimo (test TS); il server scarta eventi senza flag di consenso o con `Sec-GPC: 1`; eventi deduplicati (per giorno o per entità). |
| 20 | **Migrazioni** | 🔎 | 0009 è additiva (nuove tabelle/funzioni, un nuovo valore enum `support_assistant`): nessun DROP o DELETE di dati. L'aggiunta di un valore enum non è reversibile con un rollback semplice. |

## Vulnerabilità o rischi aperti

| Gravità | Rischio | Azione |
| --- | --- | --- |
| HIGH | Flussi reali (Auth, Stripe test, webhook, Netlify) mai eseguiti: possibili errori di configurazione o integrazione non visibili nei test simulati. | Eseguire i test E2E di `RELEASE_READINESS.md` in un ambiente di staging. |
| HIGH | IVA non calcolata da Stripe senza `STRIPE_AUTOMATIC_TAX` / aliquote sui Price. | Decisione fiscale + configurazione Stripe Tax prima di incassare. |
| MEDIUM | Registrazione pubblica senza CAPTCHA nel codice; dipende dai limiti di Supabase Auth. | Abilitare CAPTCHA (hCaptcha/Turnstile) in Supabase Auth e nel modulo di registrazione. |
| MEDIUM | Registrazione degli errori *best effort* (promessa non attesa). | Valutare un servizio di error tracking esterno. |
| MEDIUM | Conservazione di `app_errors`, `funnel_events`, `monitoring_alerts` non automatizzata. | Job di pulizia periodica coerente con l'informativa. |
| LOW | `style-src 'unsafe-inline'` nella CSP. | Rimuovere quando gli stili inline dinamici (tema White Label) passeranno a nonce/hash. |
| LOW | Header `X-Robots-Tag` di `netlify.toml` non applicato alle risposte delle functions. | Già coperto da `Disallow: /api` in robots.txt. |

## Aggiornamento Prompt 7 (20/11/2026)

Verifiche ripetute **realmente** in questo ambiente: 597 asserzioni SQL (incluso l'audit dello schema, ora 33 controlli),
test di concorrenza dei crediti, 287 test TypeScript con le librerie reali `zod` (v4) e `undici` presenti sul sistema.

| Area | Esito | Evidenza / correzione |
| --- | --- | --- |
| Isolamento multi-tenant | ✅ | Nuovi test inviti: un'altra organizzazione non legge, non revoca, non rimuove; un estraneo non usa il link. |
| RLS | ✅ | Audit: RLS su tutte le tabelle (inclusa `organization_invitations`); nessun INSERT diretto in `organization_members` per `authenticated`/`anon`. |
| Autorizzazione API | 🔎 | Mappa degli endpoint (41 functions): ogni endpoint privato usa `requireOrgMember`/`requireUser`+RPC con controllo di ruolo/`requireSuperAdmin`/`requireResellerMember`/firma Stripe/firma Svix/segreto interno/token HMAC; pubblici per scelta: `health`, `tenant`, `pricing`, `demo`, `events`, `client-error` (con limiti di frequenza). |
| Escalation di privilegi | ✅ | Ruolo super admin protetto (test), un membro non si promuove admin (test), un membro non invita né rimuove (test), ruolo dell'invito limitato a `member`/`organization_admin` (test). |
| Esposizione segreti | ✅ | Scansione del frontend (test); token di invito restituito una sola volta, nel DB solo hash SHA-256, colonna `token_hash` non leggibile (test); link con token nel frammento `#t=` (non inviato ai server) e `Referrer-Policy: no-referrer` su `/join`. |
| Replay webhook Stripe | ✅ (simulato) | Timestamp fuori tolleranza rifiutato, eventi duplicati ignorati per `event.id` (test billing). |
| Rate limiting | ✅ | Inviti 10/min per admin, accettazioni 10/min per utente (RPC). |
| Validazione input | ✅ | Email e ruolo validati in endpoint e database (test). |
| XSS | 🔎 | Nessun `dangerouslySetInnerHTML`/`innerHTML`/`eval` nel frontend (ricerca nel codice); JSON-LD con `<` codificato; email di invito in solo testo con oggetto senza a capo (test). |
| SSRF | ✅ | `ssrf.test.ts` (6 test) eseguito ora con `undici` reale. |
| CORS | 🔎 | Nessun header `Access-Control-Allow-*`. |
| Sessioni | 🔎 | Sessione Supabase nel `localStorage` del browser (comportamento predefinito di supabase-js): protetta dalla CSP senza script inline non autorizzati. Logout lato client; revoca lato server dipende da Supabase Auth. |
| Concorrenza crediti / quote | ✅ | `run_billing_concurrency.sh` superato; quote lead e utenti nei test SQL. Limite utenti: membri + inviti validi, stesso lock del trigger. |
| Audit log | ✅ | `invitation.created/revoked/accepted`, `member.removed_by_admin` con autore; nessun token e solo il dominio dell'email nei metadati (test). |

### Vulnerabilità corrette nel Prompt 7

| ID | Gravità | Problema | Correzione | Evidenza |
| --- | --- | --- | --- | --- |
| SEC-7-1 | MEDIUM | `verifyUnsubscribeToken` (endpoint pubblico `/api/unsubscribe`): MAC di 32 caratteri non ASCII → `timingSafeEqual` lanciava un'eccezione (risposta 500 invece del rifiuto). | Confronto sulla lunghezza in byte prima di `timingSafeEqual`. | Test `unsubscribeToken.test.ts`: fallisce sul codice del Prompt 6 ("Input buffers must have the same byte length"), passa ora. |
| SEC-7-2 | LOW | Stesso difetto nel controllo del segreto interno delle background function (`internalAuth.ts`, `lead-finder-analyze-run.ts`). | Funzione unica con confronto sui byte. | Test `internalAuth.test.ts`: fallisce sul Prompt 6, passa ora. |
| SEC-7-3 | MEDIUM (conformità) | La pulizia di conservazione dei dati (`purge_expired_data`) non era eseguita da nulla, mentre l'interfaccia la dichiarava automatica. | Wrapper solo service role + function pianificata `retention-tick` **disattivata** finché `RETENTION_PURGE_ENABLED=true`; testo dell'interfaccia corretto. | Audit SQL: non eseguibile da utenti, eseguibile dalla service role. Attivazione: decisione del titolare. |
