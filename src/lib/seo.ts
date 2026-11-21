import { useEffect } from 'react'

/**
 * Meta tag per le pagine pubbliche (SPA): title, description, canonical, Open Graph,
 * Twitter card, robots e dati strutturati JSON-LD. Le pagine private impostano noindex
 * (anche via header X-Robots-Tag in netlify.toml). L'URL canonico usa VITE_APP_URL se
 * presente, altrimenti l'origine corrente.
 */
export interface SeoOptions {
  title: string
  description?: string
  path?: string
  noindex?: boolean
  jsonLd?: Record<string, unknown> | Record<string, unknown>[]
  locale?: 'it' | 'en'
}

const SITE = 'LeadFlow AI'

export function siteOrigin(): string {
  const configured = (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/+$/, '')
  if (configured && /^https?:\/\//.test(configured)) return configured
  return typeof location !== 'undefined' ? location.origin : ''
}

function setMeta(attr: 'name' | 'property', key: string, content: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (content === null) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function setLink(rel: string, href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (href === null) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('link')
    el.rel = rel
    document.head.appendChild(el)
  }
  el.href = href
}

export function applySeo(o: SeoOptions): void {
  document.title = o.title
  const url = o.path !== undefined ? `${siteOrigin()}${o.path}` : null
  setMeta('name', 'description', o.description ?? null)
  setMeta('name', 'robots', o.noindex ? 'noindex, nofollow' : 'index, follow')
  setLink('canonical', o.noindex ? null : url)
  setMeta('property', 'og:title', o.title)
  setMeta('property', 'og:description', o.description ?? null)
  setMeta('property', 'og:type', 'website')
  setMeta('property', 'og:site_name', SITE)
  setMeta('property', 'og:locale', o.locale === 'en' ? 'en_GB' : 'it_IT')
  setMeta('property', 'og:url', o.noindex ? null : url)
  setMeta('property', 'og:image', `${siteOrigin()}/og-image.png`)
  setMeta('name', 'twitter:card', 'summary_large_image')
  const id = 'lf-jsonld'
  document.getElementById(id)?.remove()
  if (o.jsonLd && !o.noindex) {
    // type="application/ld+json" non è eseguito dal browser: compatibile con la CSP script-src.
    const s = document.createElement('script')
    s.type = 'application/ld+json'
    s.id = id
    s.textContent = JSON.stringify(o.jsonLd).replace(/</g, '\\u003c')
    document.head.appendChild(s)
  }
}

export function useSeo(o: SeoOptions): void {
  const key = JSON.stringify(o)
  useEffect(() => {
    applySeo(o)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/** Le aree private (app, console, autenticazione) non devono essere indicizzate. */
export function useNoIndex(title: string): void {
  useSeo({ title, noindex: true })
}
