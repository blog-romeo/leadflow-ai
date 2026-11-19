import { DEFAULT_WEIGHTS, type IcpProfile } from './types'

export interface ProfileRowDb {
  services_description: string | null
  ideal_customer: string | null
  target_sectors: string[] | null
  target_regions: string[] | null
  target_countries: string[] | null
  weight_sector: number
  weight_geography: number
  weight_icp: number
  weight_signals: number
  weight_completeness: number
}

export function profileFromRow(row: ProfileRowDb | null): IcpProfile {
  if (!row) return { servicesDescription: null, idealCustomer: null, targetSectors: [], targetRegions: [], targetCountries: [], weights: DEFAULT_WEIGHTS }
  return {
    servicesDescription: row.services_description?.trim() || null,
    idealCustomer: row.ideal_customer?.trim() || null,
    targetSectors: row.target_sectors ?? [],
    targetRegions: row.target_regions ?? [],
    targetCountries: row.target_countries ?? [],
    weights: {
      sector: row.weight_sector,
      geography: row.weight_geography,
      icp: row.weight_icp,
      signals: row.weight_signals,
      completeness: row.weight_completeness,
    },
  }
}
