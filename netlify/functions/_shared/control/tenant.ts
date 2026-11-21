/**
 * Risoluzione del tenant White Label dall'hostname della richiesta.
 *
 * L'hostname viene dalla richiesta HTTP ricevuta dal server (URL della function), MAI da
 * parametri o header scelti dal client applicativo. Il risultato contiene solo dati pubblici
 * di branding: non concede permessi (autorizzazioni sempre verificate nelle API e nel database).
 */
export interface PublicBranding {
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

export function requestHostname(req: Request): string | null {
  try {
    const host = new URL(req.url).hostname.toLowerCase().replace(/\.$/, '')
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null
  } catch {
    return null
  }
}

const HEX = /^#[0-9a-f]{6}$/i
const httpsOnly = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\/[^\s<>"]+$/.test(u) ? u : null)
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && !/[<>]/.test(v) ? v.trim().slice(0, max) : null)
const ASSET = /^[0-9a-f-]{36}\/(logo|login_logo|favicon)-[0-9a-f]{12}\.(png|jpg|webp|ico)$/

/** URL pubblico di un asset nel bucket Storage "branding". */
export function assetUrl(supabaseUrl: string | undefined, path: unknown): string | null {
  if (!supabaseUrl || typeof path !== 'string' || !ASSET.test(path)) return null
  const base = supabaseUrl.replace(/\/+$/, '')
  if (!/^https:\/\//.test(base)) return null
  return `${base}/storage/v1/object/public/branding/${path}`
}

/** Riduce la riga del database ai soli campi pubblici, rivalidati (difesa in profondità). */
export function toPublicBranding(resellerId: string, row: Record<string, unknown> | null, supabaseUrl: string | undefined): PublicBranding {
  const r = row ?? {}
  const theme = r.theme === 'light' || r.theme === 'dark' ? r.theme : 'system'
  const email = typeof r.support_email === 'string' && /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(r.support_email) ? r.support_email : null
  return {
    reseller_id: resellerId,
    platform_name: text(r.platform_name, 60),
    logo_url: assetUrl(supabaseUrl, r.logo_path),
    login_logo_url: assetUrl(supabaseUrl, r.login_logo_path),
    favicon_url: assetUrl(supabaseUrl, r.favicon_path),
    primary_color: typeof r.primary_color === 'string' && HEX.test(r.primary_color) ? r.primary_color.toLowerCase() : null,
    secondary_color: typeof r.secondary_color === 'string' && HEX.test(r.secondary_color) ? r.secondary_color.toLowerCase() : null,
    theme,
    welcome_title: text(r.welcome_title, 120),
    welcome_text: text(r.welcome_text, 600),
    support_email: email,
    privacy_url: httpsOnly(r.privacy_url),
    terms_url: httpsOnly(r.terms_url),
  }
}
