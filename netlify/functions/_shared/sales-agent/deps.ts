import { supabaseAdmin } from '../supabaseAdmin'
import { createSalesStore } from './supabaseStore'

export function salesDeps() {
  return { store: createSalesStore(supabaseAdmin()) }
}
