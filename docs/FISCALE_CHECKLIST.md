# Checklist fiscale per il commercialista (IVA e fatturazione)

> Documento di lavoro, **non** è una consulenza fiscale. Le decisioni vanno prese e confermate per iscritto
> dal commercialista. Finché le voci marcate **[BLOCCANTE]** non sono confermate, il lancio a pagamento resta
> bloccato (RELEASE_READINESS → HIGH-2). Stripe Tax non sostituisce la fatturazione elettronica italiana (SdI).

## Situazione attuale nel software (verificata nel codice)

| Aspetto | Stato |
| --- | --- |
| Prezzi pubblicati | IVA **esclusa**: 149 / 349 / 799 € al mese; White Label 399 €/mese + 2.990 € e 799 €/mese + 5.990 € |
| Calcolo IVA in Stripe | **disattivato** (`STRIPE_AUTOMATIC_TAX` vuota): oggi Stripe addebita l'importo del Price senza aggiungere IVA |
| Dati raccolti in Checkout | ragione sociale, indirizzo di fatturazione (obbligatorio), partita IVA/Tax ID (facoltativa: il cliente può non inserirla) |
| Dati raccolti nell'onboarding | ragione sociale, partita IVA (facoltativa), paese, settore, sito |
| Fatture | emesse da **Stripe** (PDF e pagina ospitata), salvate in `billing_invoices` con imponibile e totale; **non** trasmesse allo SdI |
| Clientela | i termini dichiarano un servizio solo B2B, ma il Checkout non impedisce tecnicamente l'acquisto senza partita IVA |
| Preflight | `npm run stripe:preflight` verifica Price `tax_behavior=exclusive`, Stripe Tax attivo e registrazione IT quando `STRIPE_AUTOMATIC_TAX=true` |

## Decisioni da prendere

### A. Soggetto che fattura e regime [BLOCCANTE]

- [ ] Ragione sociale, partita IVA, regime fiscale del fornitore (ordinario / forfettario / altro) e relative conseguenze sull'IVA da applicare.
- [ ] Codice ATECO dell'attività (servizi software/SaaS) e conferma della natura del servizio ai fini IVA (servizio elettronico / prestazione di servizi generica).

### B. Trattamento IVA per tipologia e paese del cliente [BLOCCANTE]

Da confermare caso per caso (il software non deve applicare aliquote non confermate):

| Cliente | Domanda per il commercialista |
| --- | --- |
| Impresa italiana con partita IVA | aliquota da applicare e diciture in fattura |
| Impresa UE con partita IVA valida (VIES) | regime applicabile (es. inversione contabile) e verifica VIES richiesta |
| Impresa UE senza partita IVA valida | trattamento e se accettarla |
| Impresa extra UE | trattamento e documentazione |
| Privato / consumatore (anche UE) | accettarlo o bloccarlo? Se accettato: regole OSS per i servizi elettronici |
| Rivenditori White Label (canone + attivazione) | stesso trattamento dei piani o diverso? |

- [ ] Rendere **obbligatoria** la partita IVA in Checkout per vendere solo a imprese? (modifica tecnica semplice, da decidere)

### C. Calcolo in Stripe [BLOCCANTE]

Scegliere **una** delle due strade:

1. **Stripe Tax** (`STRIPE_AUTOMATIC_TAX=true`):
   - [ ] Stripe Tax attivato con indirizzo della sede (*Settings → Tax*).
   - [ ] Registrazioni fiscali inserite in Stripe (Italia; eventuale OSS se richiesto dal punto B).
   - [ ] Codice prodotto fiscale (tax code) dei Prodotti confermato.
   - [ ] Price con `tax_behavior=exclusive`.
   - [ ] `npm run stripe:preflight` senza errori con `STRIPE_AUTOMATIC_TAX=true`.
2. **Aliquote manuali** (Tax Rates configurati in Stripe e applicati alle sottoscrizioni):
   - [ ] Richiede una modifica del codice (oggi non supportata): da pianificare solo se scelta.

### D. Fatturazione elettronica italiana (SdI) [BLOCCANTE per clienti italiani]

- [ ] Chi emette la fattura elettronica: gestionale del commercialista, software di fatturazione esterno o integrazione futura.
- [ ] Dati necessari dal cliente: codice destinatario SDI o PEC — **oggi non raccolti dal software**.
- [ ] Ruolo dei documenti Stripe (ricevuta/pro forma vs fattura) e dicitura da mostrare al cliente.
- [ ] Tempi di emissione rispetto all'incasso Stripe e riconciliazione (export mensile da Stripe o da `billing_invoices`).
- [ ] Conservazione sostitutiva.

### E. Incassi e rimborsi

- [ ] Trattamento delle commissioni Stripe e delle note di credito (cambio piano con pro-rata, rimborsi).
- [ ] Politica di rimborso da inserire nelle condizioni di abbonamento (oggi `[DA COMPLETARE]`).
- [ ] Gestione dei pagamenti falliti (oggi: accesso mantenuto in `past_due` durante i tentativi di Stripe).

## Cosa fare nel software dopo le decisioni

| Decisione | Intervento |
| --- | --- |
| Stripe Tax confermato | configurare Stripe, impostare `STRIPE_AUTOMATIC_TAX=true`, eseguire il preflight e i test S1–S14 di `docs/STRIPE_TEST_PLAN.md` |
| Solo clienti con partita IVA | rendere obbligatorio il Tax ID in Checkout e la partita IVA nell'onboarding |
| SdI tramite gestionale esterno | procedura mensile documentata in `docs/OPERATIONS.md` |
| Raccolta codice SDI/PEC | aggiungere i campi all'organizzazione (piccola migrazione additiva) |
| Prezzi IVA inclusa (alternativa) | aggiornare `src/config/plans.ts`, `billing_plans`, Price Stripe e testi |
