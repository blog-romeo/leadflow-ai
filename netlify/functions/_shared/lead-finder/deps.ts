import { supabaseAdmin } from '../supabaseAdmin'
import { createBillingGate } from '../billing/supabaseStore'
import { createSupabaseStore } from './supabaseStore'
import { createRegistry } from './providers/registry'
import type { ProviderId } from './types'

export function leadFinderDeps() {
  const db = supabaseAdmin()
  // billing: quote commerciali del piano (nuovi lead, costi provider) applicate lato server.
  return { store: createSupabaseStore(db), registry: createRegistry(), billing: createBillingGate(db) }
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  osm_overpass: 'OpenStreetMap (Overpass)',
  google_places: 'Google Places',
  csv_import: 'Importazione CSV',
}
