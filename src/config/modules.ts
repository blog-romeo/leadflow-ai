import {
  Bot,
  Building2,
  ChartLine,
  CreditCard,
  Gauge,
  Kanban,
  LayoutDashboard,
  Megaphone,
  Radar,
  Repeat,
  ScanSearch,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

export type ModuleStatus = 'available' | 'preparation'
export type ModuleAccess = 'member' | 'super_admin'
export type NavGroup = 'overview' | 'ai' | 'sales' | 'account'

export interface ModuleDef {
  key: string
  path: string
  labelKey: string
  icon: LucideIcon
  group: NavGroup
  status: ModuleStatus
  access: ModuleAccess
  /** Chiave i18n della pagina descrittiva (modules.<key>). */
  previewKey?: string
  /** Pagina in cui la funzione è realmente utilizzabile, se diversa. */
  usedIn?: string
}

/**
 * Registro unico dei 12 moduli del prodotto: guida sidebar, routing e badge di stato.
 * Lo stato "preparation" è mostrato esplicitamente all'utente: nessuna funzione simulata.
 */
export const MODULES: ModuleDef[] = [
  { key: 'dashboard', path: '/app', labelKey: 'nav.dashboard', icon: LayoutDashboard, group: 'overview', status: 'available', access: 'member' },
  { key: 'leadFinder', path: '/app/lead-finder', labelKey: 'nav.leadFinder', icon: Radar, group: 'ai', status: 'available', access: 'member' },
  { key: 'analyzer', path: '/app/business-analyzer', labelKey: 'nav.analyzer', icon: ScanSearch, group: 'ai', status: 'available', access: 'member', previewKey: 'analyzer', usedIn: '/app/lead-finder' },
  { key: 'scoring', path: '/app/lead-scoring', labelKey: 'nav.scoring', icon: Gauge, group: 'ai', status: 'available', access: 'member' },
  { key: 'salesAgent', path: '/app/sales-agent', labelKey: 'nav.salesAgent', icon: Bot, group: 'ai', status: 'preparation', access: 'member', previewKey: 'salesAgent' },
  { key: 'crm', path: '/app/crm', labelKey: 'nav.crm', icon: Kanban, group: 'sales', status: 'available', access: 'member' },
  { key: 'campaigns', path: '/app/campaigns', labelKey: 'nav.campaigns', icon: Megaphone, group: 'sales', status: 'preparation', access: 'member', previewKey: 'campaigns' },
  { key: 'followUp', path: '/app/follow-up', labelKey: 'nav.followUp', icon: Repeat, group: 'sales', status: 'preparation', access: 'member', previewKey: 'followUp' },
  { key: 'analytics', path: '/app/analytics', labelKey: 'nav.analytics', icon: ChartLine, group: 'sales', status: 'preparation', access: 'member', previewKey: 'analytics' },
  { key: 'billing', path: '/app/billing', labelKey: 'nav.billing', icon: CreditCard, group: 'account', status: 'preparation', access: 'member', previewKey: 'billing' },
  { key: 'settings', path: '/app/settings', labelKey: 'nav.settings', icon: Building2, group: 'account', status: 'available', access: 'member' },
  { key: 'admin', path: '/app/admin', labelKey: 'nav.admin', icon: ShieldCheck, group: 'account', status: 'available', access: 'super_admin' },
]

export const NAV_GROUPS: { id: NavGroup; labelKey: string }[] = [
  { id: 'overview', labelKey: 'nav.groupOverview' },
  { id: 'ai', labelKey: 'nav.groupAi' },
  { id: 'sales', labelKey: 'nav.groupSales' },
  { id: 'account', labelKey: 'nav.groupAccount' },
]

export function visibleModules(isSuperAdmin: boolean): ModuleDef[] {
  return MODULES.filter((m) => m.access !== 'super_admin' || isSuperAdmin)
}
