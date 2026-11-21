# Runbook di staging per il proprietario (Prompt 10)

Ordine obbligato: ogni fase usa l'esito della precedente. Tempo stimato: 1–2 giorni. Nessuna chiave va incollata in chat o nel
repository: si inseriscono solo nei pannelli di GitHub, Netlify e Supabase. Nessun passo tocca produzione, DNS o Stripe Live.

## 0. Prerequisito critico: versionare il codice (Prompt 11)

Nel repository consegnato il branch `feature/leadflow-staging-release` è **già creato** ma **senza commit**: 213 file nuovi,
55 modificati, 1 eliminato (elenco in `docs/STAGING_RELEASE_MANIFEST.md`). Il commit non è stato fatto da Claude perché il
repository non è collegato a GitHub. Sul tuo computer, nella cartella estratta dallo ZIP:

```bash
git branch --show-current          # deve stampare feature/leadflow-staging-release
npm run security:secrets           # deve stampare "Nessun segreto trovato"
git status --short | grep -E '\.env($|\.)' && echo "STOP: file .env da non versionare"
git add -A
git commit -m "LeadFlow AI: codice completo dei Prompt 5–11 per lo staging"
# Repository PRIVATO creato da te su GitHub (vuoto, senza README):
git remote add origin git@github.com:<account>/<repo>.git
git push -u origin main                                  # storia esistente (4 commit)
git push -u origin feature/leadflow-staging-release      # la CI parte su questo branch
```

Non fare merge su `main` finché la CI non è verde e non l'hai approvato tu (pull request).

## 1. GitHub CI (REL-1)

- [ ] Repository **privato**. La pipeline `.github/workflows/ci.yml` parte al push: `npm ci`, `tsc -b`, `vitest run`,
      `npm run build` (due volte: flag spento e acceso), bundle delle functions, migrazioni 0001–0014 + test RLS e concorrenza
      su PostgreSQL 16, segreti, `npm audit` (high/critical bloccanti), firme dei pacchetti, dependency review sulle PR.
- [ ] Se un passo fallisce: correggere il codice, **non** i test. Annotare in `RELEASE_READINESS.md` il link all'esecuzione verde.
- [ ] Settings → Branches: proteggere `main` (PR obbligatoria, CI verde obbligatoria).
- [ ] Settings → Environments → `staging`: Required reviewers = proprietario. Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY` (sk_test_), `STRIPE_WEBHOOK_SECRET`, `OPENAI_API_KEY`,
      `LEADFLOW_INTERNAL_SECRET`, `E2E_EMAIL`, `E2E_PASSWORD`, `ISO_A_EMAIL`, `ISO_A_PASSWORD`, `ISO_B_EMAIL`, `ISO_B_PASSWORD`. Variables: `ISO_A_ORG`, `ISO_B_ORG`, `STAGING_APP_URL`, `OPENAI_MODEL[_ECONOMY|_ADVANCED]`,
      `OPENAI_PRICE_*`, `OVERPASS_API_URL`, `OVERPASS_CONTACT`, `E2E_ORG_ID`.

## 2. Supabase di staging (REL-6)

- [ ] Nuovo progetto separato dalla produzione (regione UE). Migrazioni **0001–0014** in ordine (`supabase db push` o SQL Editor).
- [ ] Auth: conferma email attiva, Site URL = URL di staging, Redirect URL `/auth/callback` e `/reset-password`.
- [ ] Storage: dopo la migrazione 0008 deve esistere il bucket dei loghi White Label (le sue policy non sono testabili in locale).
- [ ] Nominare il super admin (`private.set_platform_role`, SQL Editor).
- [ ] Creare **due utenti di test** con email di prova e due organizzazioni (A, B). Nessun dato personale reale.
- [ ] `npm run staging:isolation` con le variabili `ISO_*` (vedi lo script): 0 controlli falliti.

## 3. Netlify di staging (REL-1, REL-6, REL-39)

- [ ] **Nuovo** sito Netlify (non uno esistente) collegato al repository, branch di produzione del sito = `feature/leadflow-staging-release` (o `staging`). Nessun dominio personalizzato.
- [ ] Build command `npm run build`, publish `dist`, functions `netlify/functions` (già in `netlify.toml`), Node 22.
- [ ] Variabili da `docs/DEPLOY_NETLIFY.md` §3 con chiavi **test**; `AI_AGENTS_ENABLED=true`, `AI_AGENTS_PILOT_ORGS=<A>,<B>`, `VITE_FEATURE_AI_AGENTS=true`.
- [ ] HTTPS attivo sull'URL `*.netlify.app`; nessun dominio personalizzato (nessuna modifica DNS).
- [ ] Pannello Functions: `ai-workflows-run` risulta **background**; `ai-workflows-tick`, `monitoring-tick` risultano **scheduled**.
- [ ] `GET https://<staging>/api/health` → 200; una rotta SPA profonda (es. `/app/ai-workflows`) si apre senza 404.

## 4. Verifiche dei provider

- [ ] Actions → "Staging checks" → Run (senza e2e): il preflight con `PREFLIGHT_NETWORK=1` non deve avere errori bloccanti.
- [ ] App → AI Agents → "Verifica connessioni" (utente admin di A): OpenAI e Overpass **Verificato**. Nessun token consumato.
- [ ] Leggere `docs/PROVIDER_ASSESSMENT.md`: per la beta usare un'istanza Overpass con policy adeguata al volume.

## 5. Test reale limitato (REL-28, REL-35)

- [ ] Actions → "Staging checks" → `run_e2e=true`, `approve_crm_write=false`, budget 15: il workflow deve fermarsi
      all'approvazione. Scaricare l'artifact `e2e-report` (aziende trovate, fonti, analisi, score, token, durate, errori).
- [ ] Controllare il report: se il provider non ha restituito aziende, il report lo dice (nessun dato inventato).
- [ ] Approvare dall'interfaccia **oppure** rilanciare con `approve_crm_write=true`: ≤ 3 proposte, bozze "draft", nessuna email.
- [ ] Super Admin → Monitoraggio AI: durata per agente, token, costo stimato (con `OPENAI_PRICE_*`).
- [ ] Log Netlify `ai_workflow.finished`: annotare `store_calls` (Prompt 9: 476 in processo per 30 aziende; REL-37).

## 6. Stripe Test Mode (REL-2)

- [ ] `npm run stripe:preflight` con le chiavi test, poi gli scenari S1–S14 di `docs/STRIPE_TEST_PLAN.md`.
- [ ] Il piano si attiva solo dopo l'evento webhook verificato, mai dal redirect di Checkout.

## 7. Smoke test e controlli manuali dell'interfaccia (Prompt 11)

- [ ] Actions → "Staging checks" → `run_smoke=true` (o `npm run staging:smoke` con le variabili `SMOKE_*`): homepage, prezzi,
      header di sicurezza, HTTPS, `/api/health`, `/api/pricing`, API protette (401), login, organizzazione, pagine dashboard,
      API agenti, organizzazione estranea negata, Super Admin negato. Con `ISO_*` configurate: isolamento completo A/B.
- [ ] A mano, desktop e mobile: registrazione con email di prova → conferma → login → onboarding (creazione organizzazione)
      → dashboard → AI Agents (pannello "Stato provider e connessioni") → AI Workflows (piano di un workflow, senza avviarlo).
- [ ] Supabase Auth → URL Configuration: Site URL = URL di staging; Redirect URLs = `<staging>/auth/callback`, `<staging>/reset-password`.
- [ ] Nessun pagamento: la pagina Abbonamento in staging usa solo chiavi `sk_test_`.

## 8. Esito

Riportare in `RELEASE_READINESS.md`: link alla CI verde, esito isolamento, report e2e, stato provider, misure.
La beta privata richiede REL-1 e REL-6 chiusi; il lancio a pagamento anche REL-2, REL-3, REL-5 e REL-41.
