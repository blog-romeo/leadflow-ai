/** SOLO TEST: dati e risposte OpenAI simulate. */
import type { LeadRaw, SalesProfile } from '../context'

export const ORG = '11111111-1111-4111-8111-111111111111'
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
export const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const LEAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const AI_ENV = { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model', LEADFLOW_INTERNAL_SECRET: 'x'.repeat(40), OPENAI_PRICE_INPUT_PER_MTOK: '2', OPENAI_PRICE_OUTPUT_PER_MTOK: '8' } as NodeJS.ProcessEnv

export const profile: SalesProfile = {
  organizationId: ORG,
  commercialName: 'Epsilon Web',
  sector: 'Web agency',
  offerDescription: 'Siti web e prenotazioni dirette per hotel indipendenti',
  services: [
    { id: 'sito', name: 'Sito web', description: 'Sito responsive multilingua', price_from: 2500, price_to: 4000, price_unit: 'una tantum' },
    { id: 'booking', name: 'Booking engine', description: 'Prenotazione diretta senza commissioni OTA', price_from: 49, price_to: null, price_unit: '/mese' },
  ],
  priceRange: '2.500–4.000 €',
  currency: 'EUR',
  servedAreas: ['Lazio'],
  idealCustomer: 'Hotel indipendenti 3-4 stelle',
  differentiators: ['Supporto in italiano'],
  website: 'https://epsilonweb.example',
  language: 'it',
  tone: 'consultative',
  callToAction: 'Prenota una call di 20 minuti',
  bookingUrl: 'https://cal.example/epsilon',
  commercialTerms: 'Pagamento 50% all’ordine, 50% alla consegna.',
  followUpDays: [3, 7, 14],
}

export function leadRaw(over: Partial<LeadRaw['lead']> = {}, extra: Partial<LeadRaw> = {}): LeadRaw {
  return {
    lead: {
      id: LEAD,
      company_name: 'Hotel Aurora',
      website: 'https://hotelaurora.example',
      phone: '+39 06 1234567',
      industry: 'hotel',
      city: 'Roma',
      region: 'Lazio',
      country: 'IT',
      status: 'qualified',
      contact_status: 'active',
      score: 72,
      priority: 'medium',
      score_breakdown: [{ key: 'sector', points: 30, max: 30 }],
      last_activity_at: null,
      created_at: '2026-11-01T10:00:00Z',
      deleted_at: null,
      ...over,
    },
    source: { name: 'OpenStreetMap (Overpass)', type: 'api', legal_basis: 'legitimate_interest', provider: 'osm_overpass' },
    // Analisi prodotta dall'AI Business Analyzer del Lead Finder.
    businessAnalysis: {
      sector: { value: 'Ospitalità', basis: 'verified', evidence: 'Hotel a conduzione familiare' },
      activity_description: { value: 'Hotel familiare nel centro di Roma', basis: 'verified', evidence: '' },
      verified_facts: [{ statement: 'Le prenotazioni avvengono via email', source: 'website', evidence: 'Per prenotare scrivete una email' }],
      digital_needs: [{ need: 'Booking engine', rationale: 'prenotazioni via email', basis: 'hypothesis' }],
      qualification_reason: 'Struttura indipendente senza prenotazione online',
      contact_name: 'Mario Rossi',
    },
    intelligence: null,
    activities: [{ type: 'status_change', subject: 'Stato: new → qualified', occurred_at: '2026-11-10T10:00:00Z' }],
    opportunity: null,
    proposals: [],
    openTasks: [],
    ...extra,
  }
}

export function openAiResponse(json: unknown, usage = { input_tokens: 1200, output_tokens: 600 }) {
  return new Response(
    JSON.stringify({ status: 'completed', model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }], usage }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
  return { fn, calls }
}

export const messagesOutput = {
  variants: [
    { variant: 'professional', subject: 'Prenotazioni dirette per Hotel Aurora', body: 'Buongiorno, ho visto che le prenotazioni avvengono via email. Un booking engine potrebbe essere utile. Prenota una call di 20 minuti: https://cal.example/epsilon', personalization: [{ fact: 'Le prenotazioni avvengono via email', source: 'lead.business_analysis.verified_facts' }] },
    { variant: 'direct', subject: 'Booking engine da 49 € al mese', body: 'Buongiorno, il nostro booking engine costa 49 € al mese. Garantiamo il raddoppio delle prenotazioni! Scrivete a info@epsilonweb.example o visitate https://truffa.example', personalization: [{ fact: 'Hotel con 120 camere', source: 'lead.industry' }] },
    { variant: 'consultative', subject: 'Una domanda sulle prenotazioni', body: 'Buongiorno [Nome], come gestite oggi le richieste di prenotazione? Prenota una call di 20 minuti.', personalization: [] },
  ],
  hypotheses_used: ['Il booking engine potrebbe ridurre il lavoro manuale'],
}

export const proposalOutput = {
  title: 'Proposta per Hotel Aurora',
  company_presentation: 'Epsilon Web realizza siti e prenotazioni dirette per hotel indipendenti.',
  opportunity: { statement: 'Le prenotazioni avvengono via email', basis: 'verified', evidence: 'Le prenotazioni avvengono via email' },
  solution: 'Un booking engine integrato nel sito attuale, per un costo di 1.999 €.',
  selected_service_ids: ['booking', 'inesistente'],
  services_included: ['Prenotazione diretta senza commissioni OTA'],
  benefits: ['Potrebbe ridurre il tempo dedicato alle email'],
  call_to_action: 'Prenota una call di 20 minuti',
  facts_used: [{ fact: 'Hotel nel centro di Roma', source: 'lead.business_analysis.activity_description' }],
  assumptions: ['Il volume di richieste non è noto'],
}
