# Valutazione del provider dati aziendali (Prompt 10)

Provider usato dai workflow: **OpenStreetMap tramite Overpass API** (`osm_overpass`). Google Places resta escluso dai
workflow (la licenza non consente la memorizzazione necessaria ai passi successivi). Nessuno scraping: il sito di
un'azienda viene letto solo dall'Analyzer (pagina pubblica, rispetto di robots.txt, protezione SSRF).

Fonti verificate il 21/11/2026 (wiki OpenStreetMap, manuale Overpass, OSM Foundation). Questa valutazione **non è un
parere legale**: i punti GDPR vanno confermati con il consulente privacy.

| Criterio | Valutazione | Conseguenza per LeadFlow AI |
| --- | --- | --- |
| Copertura geografica | Mondiale, ma la completezza dipende dalle mappature volontarie: sito web, telefono e indirizzo mancano spesso | i dati mancanti sono già segnalati (`missing_data`) e penalizzati nella completezza; nessun riempimento inventato |
| Licenza | ODbL 1.0: uso commerciale ammesso, attribuzione obbligatoria a "OpenStreetMap" con riferimento alla licenza ODbL; obblighi di condivisione per database derivati distribuiti | l'attribuzione `© OpenStreetMap contributors, ODbL 1.0` è salvata con ogni risultato e mostrata nel workflow; il CRM non viene distribuito a terzi. Da verificare con il legale se l'export CSV/JSON verso clienti configura una distribuzione |
| Condizioni API (istanza pubblica `overpass-api.de`) | La policy indica circa 10.000 richieste e 1 GB al giorno per un uso occasionale, da ridurre di 100 volte per un uso regolare da un'applicazione; l'uso commerciale dovrebbe passare da server propri o a pagamento | **REL-41**: per la beta privata a basso volume si può usare un'istanza pubblica con contatto e cache; per il lancio a pagamento serve un'istanza Overpass self-hosted o un servizio a pagamento (`OVERPASS_API_URL` + `OVERPASS_API_KEY` sono già supportati) |
| Rate limit | Per IP; le richieste oltre il limite ricevono HTTP 429; nessun parallelismo | l'adapter mappa 429/406 su `provider_rate_limited` (retry con attesa), un solo dispatch di ricerca per workflow, User-Agent con contatto (`OVERPASS_CONTACT`) |
| Provenienza | Ogni elemento ha un URL OSM stabile (`https://www.openstreetmap.org/<tipo>/<id>`) e la data di acquisizione | salvati come fonte del candidato; le evidenze FACT del Research Agent richiedono fonte ed estratto (vincolo del database) |
| Costi | Istanze pubbliche gratuite (senza garanzia di disponibilità); istanze a pagamento con prezzi del fornitore scelto | nessun costo nel codice; `provider_call` registrato in `ai_agent_costs` con costo NULL finché non configurato |
| Disponibilità | Istanze pubbliche soggette a sovraccarico e abusi documentati, nessuna garanzia | verifica di connessione reale (`/api/ai-agents/connections-check`), avviso `integration_check_failed`, piano bloccato se non configurato |
| GDPR | I dati OSM sono per lo più di attività; per ditte individuali e liberi professionisti nome, indirizzo e telefono possono essere **dati personali** | da confermare con il consulente: base giuridica (legittimo interesse con bilanciamento documentato), informativa ex art. 14 GDPR ai soggetti contattati, registro delle opposizioni per il contatto telefonico in Italia, conservazione limitata. Il prodotto non invia comunicazioni in autonomia e conserva la base giuridica del lead |

Se nessun provider è configurato, il piano del workflow è bloccato con `provider_not_configured`; la console mostra
`PROVIDER_NOT_CONFIGURED` e nessuna ricerca viene simulata.
