import {
  BrainCircuit,
  Network,
  Bot,
  Building2,
  ChartLine,
  CreditCard,
  Gauge,
  Inbox,
  Send,
  Workflow,
  Kanban,
  LayoutDashboard,
  Megaphone,
  Radar,
  Repeat,
  ScanSearch,
  ShieldCheck,
  LifeBuoy,
  type LucideIcon,
} from 'lucide-react'
import { env } from '../lib/env'

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
  { key: 'salesAgent', path: '/app/sales-agent', labelKey: 'nav.salesAgent', icon: Bot, group: 'ai', status: 'available', access: 'member' },
  { key: 'crm', path: '/app/crm', labelKey: 'nav.crm', icon: Kanban, group: 'sales', status: 'available', access: 'member' },
  { key: 'campaigns', path: '/app/campaigns', labelKey: 'nav.campaigns', icon: Megaphone, group: 'sales', status: 'available', access: 'member' },
  { key: 'followUp', path: '/app/follow-up', labelKey: 'nav.followUp', icon: Repeat, group: 'sales', status: 'available', access: 'member' },
  { key: 'analytics', path: '/app/analytics', labelKey: 'nav.analytics', icon: ChartLine, group: 'sales', status: 'available', access: 'member' },
  { key: 'billing', path: '/app/billing', labelKey: 'nav.billing', icon: CreditCard, group: 'account', status: 'available', access: 'member', previewKey: 'billing' },
  { key: 'settings', path: '/app/settings', labelKey: 'nav.settings', icon: Building2, group: 'account', status: 'available', access: 'member' },
  { key: 'admin', path: '/super-admin', labelKey: 'nav.admin', icon: ShieldCheck, group: 'account', status: 'available', access: 'super_admin' },
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

/**
 * Pagine operative collegate ai moduli (non sono moduli di prodotto a sé):
 * Comunicazioni e Automazioni del Campaign Manager, Canali email nelle impostazioni.
 */
export const NAV_EXTRAS: ModuleDef[] = [
  { key: 'inbox', path: '/app/inbox', labelKey: 'nav.inbox', icon: Inbox, group: 'sales', status: 'available', access: 'member' },
  { key: 'automations', path: '/app/automations', labelKey: 'nav.automations', icon: Workflow, group: 'sales', status: 'available', access: 'member' },
  { key: 'channels', path: '/app/settings/channels', labelKey: 'nav.channels', icon: Send, group: 'account', status: 'available', access: 'member' },
  { key: 'support', path: '/app/support', labelKey: 'nav.support', icon: LifeBuoy, group: 'account', status: 'available', access: 'member' },
]

/**
 * Prompt 8 — pagine del motore multi-agent, visibili solo con VITE_FEATURE_AI_AGENTS=true (beta privata).
 * Non sono moduli di prodotto pubblicizzati: il sito pubblico non le menziona finché non sono verificate.
 */
export const AI_AGENT_PAGES: ModuleDef[] = [
  { key: 'aiAgents', path: '/app/ai-agents', labelKey: 'nav.aiAgents', icon: BrainCircuit, group: 'ai', status: 'available', access: 'member' },
  { key: 'aiWorkflows', path: '/app/ai-workflows', labelKey: 'nav.aiWorkflows', icon: Network, group: 'ai', status: 'available', access: 'member' },
]

const NAV_ORDER = ['dashboard', 'leadFinder', 'analyzer', 'scoring', 'salesAgent', 'aiAgents', 'aiWorkflows', 'crm', 'campaigns', 'inbox', 'followUp', 'automations', 'analytics', 'billing', 'settings', 'channels', 'support', 'admin']

/** Voci della barra laterale: moduli visibili + pagine operative, in ordine di lavoro. */
export function navItems(isSuperAdmin: boolean, aiAgents = env.featureAiAgents): ModuleDef[] {
  return [...visibleModules(isSuperAdmin), ...NAV_EXTRAS, ...(aiAgents ? AI_AGENT_PAGES : [])].sort((a, b) => NAV_ORDER.indexOf(a.key) - NAV_ORDER.indexOf(b.key))
}
