import type { Dataset } from './types'

/** Normalizzazione e deduplicazione di risultati del provider (elementi OSM sintetici). */
export interface DiscoveryCase { id: string; elements: { type: 'node' | 'way'; id: number; tags?: Record<string, string> }[]; expected: { kept: number; duplicates: number; missingWebsite: number; missingPhone: number } }
const n = (id: number, tags: Record<string, string>) => ({ type: 'node' as const, id, tags })

export const discoveryV1: Dataset<DiscoveryCase> = {
  id: 'discovery_normalization',
  version: '1.0.0',
  task: 'company_search_normalization',
  synthetic: true,
  notice: 'Elementi OSM inventati (domini .example). Attesi = conteggi che una persona otterrebbe a mano.',
  splits: {
    train: [
      { id: 'dn-tr-01', elements: [n(1, { tourism: 'hotel', name: 'Hotel Uno', website: 'https://uno.example' }), n(2, { tourism: 'hotel', name: 'Hotel Uno Annex', website: 'https://www.uno.example/' }), n(3, { tourism: 'hotel' })], expected: { kept: 1, duplicates: 1, missingWebsite: 0, missingPhone: 1 } },
      { id: 'dn-tr-02', elements: [n(4, { tourism: 'hotel', name: 'Hotel Due', phone: '+39 06 1234567' }), n(5, { tourism: 'hotel', name: 'Hotel Tre' })], expected: { kept: 2, duplicates: 0, missingWebsite: 2, missingPhone: 1 } },
    ],
    validation: [
      { id: 'dn-va-01', elements: [n(6, { tourism: 'guest_house', name: 'B&B Quattro', website: 'http://quattro.example' }), n(6, { tourism: 'guest_house', name: 'B&B Quattro', website: 'http://quattro.example' })], expected: { kept: 1, duplicates: 1, missingWebsite: 0, missingPhone: 1 } },
      { id: 'dn-va-02', elements: [n(7, { tourism: 'hotel', name: 'Hotel Cinque', website: 'https://cinque.example', phone: '06 7654321' })], expected: { kept: 1, duplicates: 0, missingWebsite: 0, missingPhone: 0 } },
    ],
    test: [
      { id: 'dn-te-01', elements: [n(8, { tourism: 'hotel', name: 'Hotel Sei', website: 'https://sei.example' }), n(9, { tourism: 'hotel', name: 'Hotel Sette', website: 'https://sette.example' }), n(10, { tourism: 'hotel', name: 'Sei Dependance', website: 'https://sei.example/camere' })], expected: { kept: 2, duplicates: 1, missingWebsite: 0, missingPhone: 2 } },
      { id: 'dn-te-02', elements: [n(11, { name: 'Senza tag' }), n(12, { tourism: 'hotel', name: 'Hotel Otto', 'contact:phone': '+39 06 1112223' })], expected: { kept: 2, duplicates: 0, missingWebsite: 2, missingPhone: 1 } },
    ],
  },
}
