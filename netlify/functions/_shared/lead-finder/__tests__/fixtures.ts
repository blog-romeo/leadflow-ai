/** SOLO TEST: risposte simulate dei provider, mai usate dall'applicazione. */
import type { IcpProfile } from '../types'

export const ORG_A = '11111111-1111-4111-8111-111111111111'
export const ORG_B = '22222222-2222-4222-8222-222222222222'
export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

export const OSM_ENV = { OVERPASS_API_URL: 'https://overpass.example.test/api/interpreter', OVERPASS_CONTACT: 'ops@example.test' } as NodeJS.ProcessEnv
export const GOOGLE_ENV = { GOOGLE_PLACES_API_KEY: 'test-key' } as NodeJS.ProcessEnv

export const overpassBody = {
  elements: [
    { type: 'node', id: 101, tags: { tourism: 'hotel', name: 'Hotel Aurora', 'addr:street': 'Via Nazionale', 'addr:housenumber': '10', 'addr:city': 'Roma', 'addr:postcode': '00184', website: 'https://www.hotelaurora.example/?utm_source=x', phone: '+39 06 1234567' } },
    { type: 'way', id: 202, tags: { tourism: 'hotel', name: 'Albergo del Sole', 'addr:city': 'Roma' } },
    { type: 'node', id: 303, tags: { tourism: 'hotel', name: 'Hotel Aurora (ingresso B)', website: 'https://hotelaurora.example' } },
    { type: 'node', id: 404, tags: { tourism: 'hotel' } },
  ],
}

export const googlePage1 = {
  places: [
    {
      id: 'ChIJ_one',
      displayName: { text: 'Hotel Colosseo Boutique' },
      formattedAddress: 'Via Labicana 1, 00184 Roma RM, Italia',
      addressComponents: [
        { longText: 'Roma', shortText: 'Roma', types: ['locality'] },
        { longText: 'Città Metropolitana di Roma Capitale', shortText: 'RM', types: ['administrative_area_level_2'] },
        { longText: 'Italia', shortText: 'IT', types: ['country'] },
        { longText: '00184', shortText: '00184', types: ['postal_code'] },
      ],
      primaryTypeDisplayName: { text: 'Hotel' },
      types: ['hotel', 'lodging'],
      websiteUri: 'https://colosseoboutique.example/',
      nationalPhoneNumber: '06 7654321',
      googleMapsUri: 'https://maps.google.com/?cid=1',
    },
  ],
  nextPageToken: 'page2',
}
export const googlePage2 = {
  places: [{ id: 'ChIJ_two', displayName: { text: 'Hotel Senza Sito' }, addressComponents: [{ longText: 'Roma', types: ['locality'] }, { shortText: 'IT', types: ['country'] }], types: ['hotel'] }],
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** fetch simulato che registra le chiamate. */
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
  return { fn, calls }
}

export const hotelProfile: IcpProfile = {
  servicesDescription: 'Siti web e sistemi di prenotazione diretta per strutture ricettive',
  idealCustomer: 'Hotel indipendenti 3-4 stelle senza booking engine',
  targetSectors: ['hotel'],
  targetRegions: ['Roma'],
  targetCountries: ['IT'],
  weights: { sector: 30, geography: 20, icp: 25, signals: 15, completeness: 10 },
}

export function searchInput(over: Record<string, unknown> = {}) {
  return {
    organization_id: ORG_A,
    search_id: crypto.randomUUID(),
    provider: 'osm_overpass' as const,
    sector: 'Hotel',
    location: 'Roma',
    country: 'IT',
    keywords: 'Hotel indipendenti',
    max_results: 50,
    website_filter: 'any' as const,
    ...over,
  }
}
