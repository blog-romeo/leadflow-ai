# Chatbot di assistenza clienti (Prompt 13)

## Cosa fa

Un assistente in chat, disponibile:

- **sul sito pubblico** (pulsante "Assistente" in basso a destra, tutte le pagine con `PublicLayout`);
- **nell'app** (stesso pulsante in tutte le pagine, e nel Centro assistenza).

Risponde alle domande sul prodotto usando **solo** gli articoli della documentazione (`src/content/help.ts`, 24 articoli
IT/EN). Ogni risposta cita gli articoli usati. Se la documentazione non copre la domanda, **lo dice** e propone una persona.

Non esegue azioni, non legge i dati dell'account, non chiede password o chiavi, non invia comunicazioni.

## Come risponde

1. **Intenti semplici** (saluto, ringraziamento, "voglio parlare con una persona") → risposta fissa; la richiesta di una
   persona apre subito il passaggio al supporto.
2. **Ricerca negli articoli** (`retrieve` in `netlify/functions/_shared/assistant/chat.ts`): parole chiave, titolo e testo
   con radici e sinonimi; per le domande brevi di seguito ("e il rimborso?") usa anche la domanda precedente.
3. **Soglia di pertinenza** `MIN_SCORE = 2.2`: sotto la soglia il bot si astiene (`no_match`) e propone una persona.
4. **Risposta**:
   - senza AI → frasi estratte dall'articolo più pertinente (modalità `docs`: testo scritto dal team, nessuna invenzione);
   - con AI (solo **in app**, se `OPENAI_API_KEY` e `OPENAI_MODEL` sono configurati) → il modello riceve solo gli articoli
     trovati, deve citarli; citazioni non valide o errore del provider → si torna alla modalità `docs`. Ogni chiamata è un
     job `support_assistant` (pausa AI e tetti di spesa del Control Center).

Sul **sito pubblico l'AI non viene mai usata** (costo zero, nessun abuso possibile dei crediti) e gli articoli riservati
agli utenti (`audience: 'app'`) non vengono mostrati.

## Passaggio a una persona

- **App**: il bot propone di inviare la conversazione al supporto. Il ticket (`support_create_ticket`, categoria "altro")
  viene creato **solo se l'utente conferma**, con la trascrizione e una nota facoltativa. La risposta arriva nel Centro
  assistenza → Ticket (gestione dalla console `/super-admin/support`).
- **Sito**: link al modulo di contatto `/demo`.

## Limiti e sicurezza

- `POST /api/support-chat`: pubblico 30 messaggi/ora per IP (hash, IP mai salvato) + 1.000/ora globali; app 30/ora per utente.
- Domanda max 600 caratteri, ultimi 6 turni come contesto; tag e markup nella domanda vengono neutralizzati prima del prompt.
- Le conversazioni **non vengono salvate** (solo log tecnici senza testo: modalità, intento, numero di fonti).
- Flag: `VITE_FEATURE_SUPPORT_CHAT=false` nasconde il pulsante.

## Qualità misurata (dataset sintetico `support_chat` 1.0.0)

60 domande scritte dal team (IT/EN, visitatori e utenti), split separati senza duplicati. Etichette scritte prima della
valutazione. Sinonimi e soglia regolati su train/validation; il test è stato eseguito **una sola volta** dopo la scelta.

| Split | Precisione@1 | Recall@3 | Astensione corretta | Risposte a domande fuori tema |
| --- | --- | --- | --- | --- |
| Train | 0,944 | 1,000 | 1,000 | 0 |
| Validation | 1,000 | 1,000 | 1,000 | 0 |
| **Test** | **0,889** (16/18) | 0,944 | 1,000 (4/4) | 0 |

Errori sul test: domanda sui crediti consumati da un'analisi → articolo Business Analyzer (pertinente ma non il migliore);
"Altre aziende possono vedere i miei lead?" → Lead Finder invece di Privacy. Sono domande **inventate**: la qualità con
clienti reali va misurata in staging leggendo i ticket aperti dopo la chat. Il test è in `npm run ai:benchmark` (suite
`support_retrieval`) e come regressione in `assistant/__tests__/chat.test.ts`.

## Come migliorarlo

1. Aggiungere o correggere un articolo in `src/content/help.ts` (IT ed EN, `audience` se riservato all'app).
2. Aggiungere le domande reali che non hanno trovato risposta al dataset (nuova versione, split separati).
3. Rieseguire i test; cambiare sinonimi/soglia solo guardando train e validation.
