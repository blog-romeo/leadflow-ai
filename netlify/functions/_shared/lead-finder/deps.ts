import { supabaseAdmin } from '../supabaseAdmin'
import { createSupabaseStore } from './supabaseStore'
import { createRegistry } from './providers/registry'
import type { ProviderId } from './types'

export function leadFinderDeps() {
  return { store: createSupabaseStore(supabaseAdmin()), registry: createRegistry() }
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  osm_overpass: 'OpenStreetMap (Overpass)',
  google_places: 'Google Places',
  csv_import: 'Importazione CSV',
}
