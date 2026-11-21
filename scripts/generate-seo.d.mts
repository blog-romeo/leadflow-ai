/** Tipi dello script di build scripts/generate-seo.mjs (usati dai test). */
export interface PublicRoutes {
  indexable: { path: string; changefreq: string; priority: string }[]
  disallow: string[]
}
export function siteUrl(env?: Record<string, string | undefined>): string
export function robotsTxt(routes: PublicRoutes, base: string, production?: boolean): string
export function sitemapXml(routes: PublicRoutes, base: string, today?: string): string
