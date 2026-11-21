/**
 * Stato delle funzionalità mostrato sul sito pubblico.
 *
 * - 'operational': funziona solo con l'infrastruttura LeadFlow AI (database, interfaccia) ed è
 *   coperta da test automatici reali. Va confermata dopo lo smoke test di produzione.
 * - 'beta': il codice è completo e testato con servizi simulati, ma dipende da servizi esterni
 *   (OpenAI, fonti dati, Resend, Stripe, DNS) non ancora verificati in produzione.
 * - 'preparation': non ancora disponibile.
 *
 * Aggiornare questi stati SOLO dopo le verifiche descritte in RELEASE_READINESS.md.
 * Non indicare 'operational' per una funzione non verificata nell'ambiente di produzione.
 */
export type FeatureStatus = 'operational' | 'beta' | 'preparation'

export interface PublicFeature {
  key: 'leadFinder' | 'analyzer' | 'scoring' | 'salesAgent' | 'crm' | 'campaigns' | 'analytics' | 'whiteLabel'
  status: FeatureStatus
  /** Servizi esterni necessari (mostrati nella documentazione interna, non sul sito). */
  dependsOn: string[]
}

export const PUBLIC_FEATURES: PublicFeature[] = [
  { key: 'leadFinder', status: 'beta', dependsOn: ['Overpass (OpenStreetMap)', 'Google Places (facoltativo)'] },
  { key: 'analyzer', status: 'beta', dependsOn: ['OpenAI'] },
  { key: 'scoring', status: 'operational', dependsOn: [] },
  { key: 'salesAgent', status: 'beta', dependsOn: ['OpenAI'] },
  { key: 'crm', status: 'operational', dependsOn: [] },
  { key: 'campaigns', status: 'beta', dependsOn: ['Resend (account del cliente)', 'DNS del cliente'] },
  { key: 'analytics', status: 'operational', dependsOn: [] },
  { key: 'whiteLabel', status: 'beta', dependsOn: ['Stripe', 'Netlify (alias di dominio manuale)', 'DNS del rivenditore'] },
]
