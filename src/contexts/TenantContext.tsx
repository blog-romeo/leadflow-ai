import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { themeCss } from '../lib/theme'

export { inkFor } from '../lib/theme'

/**
 * Branding White Label risolto dal SERVER in base all'hostname (GET /api/tenant).
 * Il frontend non sceglie il tenant: applica solo valori pubblici già validati.
 * Nessun permesso deriva da qui: autorizzazioni sempre verificate da API e database.
 */
export interface TenantBranding {
  reseller_id: string
  platform_name: string | null
  logo_url: string | null
  login_logo_url: string | null
  favicon_url: string | null
  primary_color: string | null
  secondary_color: string | null
  theme: 'light' | 'dark' | 'system'
  welcome_title: string | null
  welcome_text: string | null
  support_email: string | null
  privacy_url: string | null
  terms_url: string | null
}

const TenantContext = createContext<TenantBranding | null>(null)
const STYLE_ID = 'lf-tenant-theme'

function applyBranding(t: TenantBranding) {
  const css = themeCss(t.primary_color, t.secondary_color)
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (css) {
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    style.textContent = css
  }
  if (t.platform_name) document.title = t.platform_name
  if (t.favicon_url?.startsWith('https://')) {
    const link = (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null) ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }))
    link.href = t.favicon_url
  }
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<TenantBranding | null>(null)
  useEffect(() => {
    let active = true
    fetch('/api/tenant', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('application/json') ? r.json() : { tenant: null }))
      .then((d: { tenant: TenantBranding | null }) => {
        if (!active || !d?.tenant) return
        setTenant(d.tenant)
        applyBranding(d.tenant)
      })
      .catch(() => undefined) // Senza tenant: marchio predefinito.
    return () => {
      active = false
    }
  }, [])
  return <TenantContext.Provider value={tenant}>{children}</TenantContext.Provider>
}

export function useTenant(): TenantBranding | null {
  return useContext(TenantContext)
}

/** Link solo https (difesa in profondità: i valori sono già validati dal server). */
export function safeHttps(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s<>"]+$/.test(url) ? url : null
}
