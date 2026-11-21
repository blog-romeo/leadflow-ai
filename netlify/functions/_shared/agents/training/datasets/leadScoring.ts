import type { Dataset } from './types'

/**
 * Lead scoring: priorità attesa (high/medium/low) per un'agenzia che vende siti e booking engine a strutture
 * ricettive indipendenti di Roma. Analisi sintetica compatta: fit [settore, cliente ideale] 0–10 e numero di
 * segnali verificati. Etichette scritte a mano PRIMA di eseguire il benchmark; diverse dal dataset del Prompt 9.
 */
export interface ScoringCase {
  id: string
  company: { name: string; sector: string | null; tags?: string[]; city: string | null; country: string | null; website: boolean; phone: boolean; address: boolean }
  analysis: { fit: [number, number]; verified: number; unverified?: number } | null
  expected: 'high' | 'medium' | 'low'
}
const k = (id: string, name: string, sector: string | null, city: string | null, country: string | null, data: [boolean, boolean, boolean], analysis: ScoringCase['analysis'], expected: ScoringCase['expected'], tags?: string[]): ScoringCase => ({
  id, company: { name, sector, tags, city, country, website: data[0], phone: data[1], address: data[2] }, analysis, expected,
})
const A = (s: number, i: number, verified: number, unverified = 0) => ({ fit: [s, i] as [number, number], verified, unverified })

export const ICP_PROFILE = {
  servicesDescription: 'Siti web e booking engine per strutture ricettive',
  idealCustomer: 'Hotel e B&B indipendenti senza prenotazione diretta',
  targetSectors: ['hotel', 'bed and breakfast'],
  targetRegions: ['Roma'],
  targetCountries: ['IT'],
  weights: { sector: 30, geography: 20, icp: 25, signals: 15, completeness: 10 },
}

export const leadScoringV2: Dataset<ScoringCase> = {
  id: 'lead_scoring',
  version: '2.0.0',
  task: 'lead_scoring_priority',
  synthetic: true,
  notice: 'Aziende inventate. Etichette = giudizio commerciale scritto a mano; non sono esiti di vendita verificati.',
  splits: {
    train: [
      k('ls-tr-01', 'Hotel Sintetico Alfa', 'hotel', 'Roma', 'IT', [true, true, true], A(9, 9, 3), 'high'),
      k('ls-tr-02', 'B&B Sintetico Beta', 'bed and breakfast', 'Roma', 'IT', [true, true, false], A(9, 8, 2), 'high'),
      k('ls-tr-03', 'Hotel Sintetico Gamma', 'hotel', 'Roma', 'IT', [true, true, true], null, 'medium'),
      k('ls-tr-04', 'Hotel Sintetico Delta', 'hotel', 'Torino', 'IT', [true, true, true], A(9, 9, 2), 'medium'),
      k('ls-tr-05', 'Pizzeria Sintetica', 'pizzeria', 'Roma', 'IT', [true, false, false], A(2, 1, 0), 'low'),
      k('ls-tr-06', 'Hotel Catena Sintetica', 'hotel', 'Roma', 'IT', [true, true, true], A(9, 3, 0), 'medium'),
      k('ls-tr-07', 'Studio Sintetico', 'commercialista', 'Milano', 'IT', [false, true, false], null, 'low'),
      k('ls-tr-08', 'Albergo Sintetico Eta', null, 'Roma', 'IT', [true, true, true], A(9, 9, 3), 'high', ['tourism=hotel']),
      k('ls-tr-09', 'Hotel Sintetico Theta', 'hotel', 'Roma', 'IT', [false, false, false], null, 'medium'),
      k('ls-tr-10', 'Officina Sintetica', 'officina', 'Bari', 'IT', [false, false, false], null, 'low'),
    ],
    validation: [
      k('ls-va-01', 'Hotel Sintetico Iota', 'hotel', 'Roma', 'IT', [true, true, true], A(8, 9, 2), 'high'),
      k('ls-va-02', 'B&B Sintetico Kappa', 'bed and breakfast', 'Roma', 'IT', [true, false, false], A(8, 7, 1), 'medium'),
      k('ls-va-03', 'Hotel Sintetico Lambda', 'hotel', 'Napoli', 'IT', [true, true, true], null, 'low'),
      k('ls-va-04', 'Ristorante Sintetico', 'ristorante', 'Roma', 'IT', [true, true, true], A(3, 2, 1), 'low'),
      k('ls-va-05', 'Hotel Sintetico Mu', 'hotel', 'Roma', 'IT', [true, true, true], A(9, 5, 1), 'medium'),
      k('ls-va-06', 'Hôtel Synthétique', 'hotel', 'Lyon', 'FR', [true, true, true], A(9, 9, 3), 'medium'),
      k('ls-va-07', 'Palestra Sintetica', 'palestra', 'Roma', 'IT', [false, false, false], null, 'low'),
      k('ls-va-08', 'Hotel Sintetico Nu', 'hotel', null, 'IT', [true, true, false], A(9, 9, 2), 'medium'),
      k('ls-va-09', 'Hotel Sintetico Xi', 'hotel', 'Roma', 'IT', [true, true, true], A(10, 10, 3), 'high'),
      k('ls-va-10', 'Affittacamere Sintetico', 'affittacamere', 'Roma', 'IT', [false, true, false], A(7, 8, 1), 'medium'),
    ],
    test: [
      k('ls-te-01', 'Hotel Sintetico Omicron', 'hotel', 'Roma', 'IT', [true, true, true], A(9, 8, 3), 'high'),
      k('ls-te-02', 'B&B Sintetico Pi', 'bed and breakfast', 'Roma', 'IT', [true, true, true], A(8, 9, 2), 'high'),
      k('ls-te-03', 'Hotel Sintetico Rho', 'hotel', 'Roma', 'IT', [true, false, true], null, 'medium'),
      k('ls-te-04', 'Hotel Sintetico Sigma', 'hotel', 'Firenze', 'IT', [true, true, true], A(9, 8, 2), 'medium'),
      k('ls-te-05', 'Bar Sintetico', 'bar', 'Roma', 'IT', [false, true, false], null, 'low'),
      k('ls-te-06', 'Hotel Sintetico Tau', 'hotel', 'Roma', 'IT', [true, true, true], A(8, 4, 0), 'medium'),
      k('ls-te-07', 'Studio Legale Sintetico', 'avvocato', 'Roma', 'IT', [true, true, true], A(2, 2, 0), 'low'),
      k('ls-te-08', 'Albergo Sintetico Upsilon', null, 'Roma', 'IT', [true, true, false], A(9, 9, 2), 'high', ['tourism=hotel']),
      k('ls-te-09', 'Hotel Sintetico Phi', 'hotel', 'Roma', 'IT', [false, false, true], A(7, 6, 0), 'medium'),
      k('ls-te-10', 'Ferramenta Sintetica', 'ferramenta', 'Genova', 'IT', [false, false, false], null, 'low'),
    ],
  },
}
