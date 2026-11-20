import type { CampaignRecipientRow } from '../../lib/database.types'

export type RecipientView = CampaignRecipientRow & {
  lead: { company_name: string; industry: string | null; city: string | null; country: string | null; contact_name: string | null }
}
