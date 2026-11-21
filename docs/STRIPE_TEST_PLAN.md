# Piano di test Stripe (solo Test Mode)

Nessun test di questo documento è stato eseguito: richiede un account Stripe in **modalità test**, il sito
pubblicato su Netlify (staging) e un progetto Supabase di test. Non usare mai chiavi `sk_live_`.

## Cosa serve

| Elemento | Dove si ottiene |
| --- | --- |
| `STRIPE_SECRET_KEY` = `sk_test_…` (o chiave ristretta `rk_test_…`) | Dashboard Stripe → Developers → API keys (Test mode) |
| Price ricorrenti mensili EUR: Starter 14900, Business 34900, Enterprise 79900 (centesimi), `tax_behavior=exclusive` | Product catalog |
| Price White Label: Agency 39900/mese + 299000 one-time, Premium 79900/mese + 599000 one-time | Product catalog |
| Endpoint webhook `https://<staging>/.netlify/functions/stripe-webhook` con i 6 eventi gestiti, `STRIPE_WEBHOOK_SECRET` | Developers → Webhooks |
| Customer Portal configurato (storico fatture, metodo di pagamento, disdetta **a fine periodo**) | Settings → Billing → Customer portal |
| Stripe CLI (facoltativo, per `stripe trigger` e test clock) | https://docs.stripe.com/stripe-cli |

## 1. Preflight (sola lettura)

```bash
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
STRIPE_PRICE_STARTER=price_... STRIPE_PRICE_BUSINESS=price_... STRIPE_PRICE_ENTERPRISE=price_... \
SITE_URL=https://<staging> npm run stripe:preflight
```

Deve terminare con "Nessun errore bloccante". Controlla importi, valuta, ricorrenza, `tax_behavior`, webhook,
portale e Stripe Tax. Rifiuta le chiavi live.

## 2. Scenari (eseguire in ordine, annotando l'esito in RELEASE_READINESS.md)

| # | Scenario | Come | Esito atteso | Dove verificare |
| --- | --- | --- | --- | --- |
| S1 | Creazione Customer | Onboarding → Pagamento → "Vai al pagamento" | 1 Customer con `metadata.organization_id`; un secondo clic non ne crea un altro | Stripe → Customers; `stripe_customers` |
| S2 | Checkout Session | stesso passo | redirect a `checkout.stripe.com`, piano e prezzo corretti, richiesta P.IVA e indirizzo | Checkout |
| S3 | Pagamento riuscito | carta `4242 4242 4242 4242`, data futura, CVC qualsiasi | ritorno su `/onboarding?checkout=success`, attesa conferma, poi piano attivo | Console → Sistema (webhook elaborati); `organization_subscriptions.status=active` |
| S4 | Ricezione e firma webhook | automatico dopo S3 | eventi `checkout.session.completed`, `customer.subscription.created`, `invoice.paid` → `processed` | Stripe → Webhooks (risposte 200); `stripe_webhook_events` |
| S5 | Firma non valida | `curl -X POST https://<staging>/.netlify/functions/stripe-webhook -d '{}' -H 'stripe-signature: t=1,v1=00'` | HTTP 400, nessuna scrittura | log function `stripe_webhook.rejected` |
| S6 | Replay | Dashboard → Webhook → evento già elaborato → *Resend* | `duplicate`, nessuna seconda scrittura | `stripe_webhook_events.attempts` invariato |
| S7 | Redirect senza webhook | disabilitare temporaneamente l'endpoint, pagare, tornare | il piano **non** si attiva; dopo la riattivazione e il *Resend* si attiva | onboarding resta in attesa |
| S8 | Autenticazione 3DS | carta `4000 0025 0000 3155` | attivazione solo dopo autenticazione completata | stato `active` |
| S9 | Pagamento rifiutato al checkout | carta `4000 0000 0000 9995` | nessun abbonamento attivo | — |
| S10 | Rinnovo | Test clock: cliente + abbonamento su test clock, avanzare di 1 mese | `invoice.paid`, nuovo periodo, quote crediti/lead azzerate per il periodo | `organization_subscriptions.current_period_*`, `usage_quotas` |
| S11 | Pagamento fallito al rinnovo | test clock con carta `4000 0000 0000 0341`, avanzare di 1 mese | `invoice.payment_failed`, stato `past_due` (accesso mantenuto nel periodo di tolleranza), fattura aperta | `billing_invoices`, Console → Sistema |
| S12 | Cambio piano | Abbonamento → passa a Business | upgrade con pro-rata immediato | fattura Stripe, nuovo piano |
| S13 | Cancellazione | Abbonamento → Disdici | `cancel_at_period_end=true`, accesso fino a fine periodo; a scadenza `customer.subscription.deleted` → `canceled` | stato e accesso |
| S14 | Customer Portal | Abbonamento → Gestisci pagamenti | apertura portale, storico fatture, cambio carta, ritorno a `/dashboard/billing` | portale |
| S15 | White Label | Portale rivenditore → abbonamento Agency | prima fattura con canone + attivazione; seconda sottoscrizione senza attivazione | fatture rivenditore |

Comandi utili con Stripe CLI (solo test):

```bash
stripe login                     # account di test
stripe trigger invoice.payment_failed
stripe test_helpers test_clocks create --frozen-time $(date +%s)
stripe test_helpers test_clocks advance <clock_id> --frozen-time <timestamp + 31 giorni>
```

## Criterio di superamento

S1–S14 superati (S15 se si vende il White Label), nessun webhook `failed` in Console → Sistema, nessun errore 500.
Solo dopo, e con approvazione esplicita, si valuta il passaggio a Live (`STRIPE_LIVE_MODE_APPROVED`).
