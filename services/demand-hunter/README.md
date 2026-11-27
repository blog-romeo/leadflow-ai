# Demand Hunter — servizio Python (BuyerML «La caccia»)

Servizio separato che esegue il motore originale di BuyerML (`hunt.py`, `demand.py`, `learning.py`,
`areas.py`, tassonomia IT e albero delle aree commerciali) dietro API autenticate. **Non gira su Netlify**:
va installato su un server dedicato con Docker. Il frontend Netlify lo raggiunge solo tramite il gateway
delle Netlify Functions (`/api/demand-hunter/*`), che firma ogni richiesta.

```
browser ──JWT──▶ Netlify Functions (gateway) ──HMAC──▶ servizio Python (questo) ──▶ SerpApi (Google)
                  │ auth, org, piano, token monouso,                │ una SQLite per organizzazione
                  │ limiti mensili, Supabase (RLS)                  │ job persistenti, idempotenza
```

## Contenuto

| Cartella | Che cosa |
|---|---|
| `buyerml/` | file **originali** di BuyerML, non modificati (impronte in `BUYERML_SHA256SUMS`), più `seed/` e `fixtures/` |
| `app/` | API FastAPI, autenticazione HMAC, job persistenti, modalità simulata |
| `tests/` | test del servizio + test originali di BuyerML sui moduli integrati |

Moduli BuyerML inclusi (chiusura delle dipendenze di `hunt.py`): `hunt`, `demand`, `learning`, `areas`,
`autocomplete_dorking`, `buyerml_store`, `dorking`, `label_demand`, `demand_queries`, `prefilter`,
`dork_runner`, `buyerml_seo_aeo_workflow`, `markets`, `map_model`, `eval_demand`. Non inclusi: chiamate
Bland, Clara, ATECO, Trends, Winning Workflow Generator, interfaccia React di BuyerML (vedi
`docs/DEMAND_HUNTER.md`, «Funzionalità future»).

Verifica dell'integrità dei file originali:

```bash
cd services/demand-hunter/buyerml && sha256sum -c ../BUYERML_SHA256SUMS
```

## API (tutte firmate, tranne `/healthz`)

| Metodo | Percorso | Costo |
|---|---|---|
| GET | `/healthz` | — (pubblico, non dice nulla) |
| GET | `/v1/status` | gratis |
| GET | `/v1/areas/{goal}` | gratis |
| POST | `/v1/areas/{goal}/plan` | gratis |
| POST | `/v1/areas/{goal}/expand` | 2 chiamate SerpApi (autocomplete), idempotente |
| GET | `/v1/hunts/suggestions` | gratis |
| POST | `/v1/hunts/plan` | gratis |
| POST | `/v1/hunts` | fino a `budget` chiamate SerpApi, idempotente |
| GET | `/v1/hunts/{id}` | gratis |
| POST | `/v1/hunts/{id}/stop` | gratis |
| GET/POST | `/v1/learning/{goal}`, `/v1/learning/{goal}/feedback` | gratis |
| POST | `/v1/classify` | gratis (regole di `demand.py`) |

Firma: `HMAC-SHA256(DEMAND_HUNTER_SERVICE_SECRET, ts \n nonce \n METODO \n path?query \n org \n user \n sha256(body))`
negli header `x-dh-timestamp`, `x-dh-nonce`, `x-dh-org`, `x-dh-user`, `x-dh-signature`. Finestra di 5 minuti,
nonce monouso. L'organizzazione arriva **solo** dagli header firmati.

## Variabili d'ambiente

| Variabile | Obbligatoria | Note |
|---|---|---|
| `DEMAND_HUNTER_SERVICE_SECRET` | sì | ≥ 32 caratteri, uguale a quella su Netlify (`openssl rand -hex 32`) |
| `DH_SIMULATED` | no (default `true`) | `false` = ricerche reali |
| `MOCK_MODE` | no (default `true`) | letta dal codice BuyerML: `false` per le ricerche reali |
| `SERPAPI_KEY` | solo in modalità reale | chiave SerpApi |
| `DH_MAX_BUDGET_PER_HUNT` | no (default 100) | tetto del servizio, oltre ai limiti per organizzazione |
| `DH_MAX_CONCURRENT_PER_ORG` | no (default 1) | cacce contemporanee per organizzazione |
| `DH_SIGNATURE_WINDOW_S` | no (default 300) | validità della firma |
| `DH_DATA_DIR` | no (default `/data`) | volume persistente |

## Installazione su un server dedicato

Requisiti: Linux con Docker e Docker Compose, un nome DNS (es. `demand-hunter.tuodominio.it`) che punta al
server, porte 80/443 aperte.

```bash
# 1. Copia la cartella services/demand-hunter sul server, poi:
cd demand-hunter
cp .env.example .env
openssl rand -hex 32          # → DEMAND_HUNTER_SERVICE_SECRET in .env (e su Netlify)
chmod 600 .env

# 2. Prima prova in modalità SIMULATA (default): nessuna spesa
export DH_DOMAIN=demand-hunter.tuodominio.it
docker compose up -d --build
curl https://$DH_DOMAIN/healthz          # {"ok":true}

# 3. Test dentro il container
docker compose exec demand-hunter python -m unittest discover -s tests -t .

# 4. Su Netlify (contesto Deploy Preview / branch, NON production finché non è verificato):
#    DEMAND_HUNTER_SERVICE_URL=https://demand-hunter.tuodominio.it
#    DEMAND_HUNTER_SERVICE_SECRET=<stesso valore>

# 5. Solo dopo la verifica, ricerche reali: in .env
#    DH_SIMULATED=false
#    MOCK_MODE=false
#    SERPAPI_KEY=<chiave>
docker compose up -d
```

Sicurezza del server: il container gira come utente non root con filesystem in sola lettura (dati solo nel
volume `/data`); Caddy fornisce HTTPS automatico. Facoltativo ma consigliato: firewall che accetta il traffico
sulla 443 solo dagli IP di uscita delle Netlify Functions, backup giornaliero del volume `dh-data`.

Un solo worker uvicorn: la protezione dai replay (nonce) e i thread delle cacce vivono nel processo. Un job in
corso durante un riavvio viene marcato «interrotta» (quello che ha trovato resta) e non riparte da solo.

## Test

```bash
cd services/demand-hunter
python -m venv .venv && .venv/bin/pip install -r requirements.txt
MOCK_MODE=true .venv/bin/python -m unittest discover -s tests -t .
```

86 test: 28 del servizio (autenticazione, replay, isolamento, budget, idempotenza, classificazione,
deduplicazione, feedback, aree) e 58 originali di BuyerML (le tre classi `*Api` sono escluse perché
verificano `api.py` di BuyerML, non incluso). Solo dati simulati, nessuna rete.
