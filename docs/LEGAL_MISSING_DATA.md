# Dati legali mancanti (estratti dai segnaposto)

Generato da `src/content/legal.ts` (Prompt 7). Ogni voce va compilata dal titolare e i testi completi vanno
**revisionati da un professionista** prima della pubblicazione definitiva. Le pagine restano `noindex` con l'avviso
di bozza finché questo elenco non è vuoto (il test `src/test/launch.test.ts` verifica che i segnaposto siano visibili).

## Dati societari comuni

| Segnaposto | Dove compare |
| --- | --- |
| [DA COMPLETARE: ragione sociale del fornitore] | Informativa privacy, Termini di servizio, Informazioni societarie |
| [DA COMPLETARE: indirizzo della sede legale] | Informativa privacy, Termini di servizio, Informazioni societarie, Contatti |
| [DA COMPLETARE: partita IVA / codice fiscale] | Informativa privacy, Termini di servizio, Informazioni societarie |
| [DA COMPLETARE: email per le richieste privacy] | Informativa privacy, Contatti |
| [DA COMPLETARE: data di pubblicazione] | Informativa privacy, Cookie policy, Termini di servizio, Condizioni di abbonamento, Politica di cancellazione, recesso e cessazione, Informazioni societarie, Contatti |

## Per documento

### Informativa privacy (`/legal/privacy`)
- [DA COMPLETARE: base giuridica — es. legittimo interesse del cliente a consentire l’accesso ai propri collaboratori; ruolo di LeadFlow AI per questi dati]
- [DA COMPLETARE: elenco dei fornitori con sede o trattamento fuori dallo SEE e garanzie applicate (decisione di adeguatezza / clausole contrattuali standard)]
- [DA COMPLETARE: eventuale DPO / referente privacy]
- [DA COMPLETARE: eventuali comunicazioni commerciali al cliente e relativa base giuridica — oggi la piattaforma non invia newsletter]
- [DA COMPLETARE: periodo di conservazione degli errori]
- [DA COMPLETARE: periodo di conservazione degli inviti]
- [DA COMPLETARE: periodo di conservazione delle richieste demo]
- [DA COMPLETARE: periodo di conservazione dopo la cessazione]

### Cookie policy (`/legal/cookie`)
- [DA COMPLETARE: verificare prima del lancio che nessun altro strumento sia stato aggiunto]

### Termini di servizio (`/legal/termini`)
- [DA COMPLETARE: legge applicabile e foro competente]
- [DA COMPLETARE: limitazioni di responsabilità, da redigere con un legale]
- [DA COMPLETARE: livello di servizio, finestre di manutenzione, tempi di risposta dell’assistenza per piano]
- [DA COMPLETARE: verifica legale della clausola B2B]

### Condizioni di abbonamento (`/legal/condizioni-abbonamento`)
- [DA COMPLETARE: modalità di emissione della fattura elettronica (SDI), codice destinatario / PEC del cliente]
- [DA COMPLETARE: periodo di tolleranza]
- [DA COMPLETARE: politica di rimborso]

### Politica di cancellazione, recesso e cessazione (`/legal/cancellazione`)
- [DA COMPLETARE: altre esportazioni offerte su richiesta]
- [DA COMPLETARE: casi di sospensione o risoluzione da parte del fornitore (es. uso illecito, mancato pagamento) e preavviso]
- [DA COMPLETARE: numero di tentativi e durata, come configurati in Stripe]
- [DA COMPLETARE: politica di rimborso — es. nessun rimborso per periodi parziali salvo obblighi di legge o inadempimento del fornitore]
- [DA COMPLETARE: procedura, tempi e conferma scritta]

### Informazioni societarie (`/legal/informazioni-societarie`)
- [DA COMPLETARE: allegato tecnico delle misure]
- [DA COMPLETARE: capitale sociale]
- [DA COMPLETARE: indirizzo PEC]
- [DA COMPLETARE: modalità di sottoscrizione del DPA (allegato ai termini o documento separato)]
- [DA COMPLETARE: modalità e preavviso]
- [DA COMPLETARE: modalità]
- [DA COMPLETARE: numero REA]
- [DA COMPLETARE: ore per la notifica di violazione]
- [DA COMPLETARE: procedura e tempi]

### Contatti (`/legal/contatti`)
- [DA COMPLETARE: indirizzo email di contatto]

## Altri punti fuori dal testo

- Footer del sito: ragione sociale e partita IVA (`src/components/public/PublicLayout.tsx`).
- Decisioni fiscali: `docs/FISCALE_CHECKLIST.md`.
- Contratti con i sub-responsabili (Supabase, Netlify, Stripe, OpenAI, Resend, fonti dati): riferimenti DPA e regioni dei dati.
- Registro dei trattamenti e valutazione del legittimo interesse per i dati B2B dei lead.
- Testo dell'informativa che il cliente (titolare) fornisce ai collaboratori invitati e ai referenti dei lead.
