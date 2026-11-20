import type { campaignsIt } from './campaigns.it'

type Widen<T> = T extends string ? string : T extends readonly string[] ? readonly string[] : { [K in keyof T]: Widen<T[K]> }
export type CampaignsDictionary = Widen<typeof campaignsIt>
