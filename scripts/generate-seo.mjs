#!/usr/bin/env node
/**
 * Post-build SEO: genera dist/robots.txt e dist/sitemap.xml da seo/public-routes.json e
 * inserisce l'URL pubblico nei meta Open Graph di dist/index.html (segnaposto __SITE_URL__).
 * URL pubblico: SITE_URL, altrimenti URL (variabile di Netlify per il sito di produzione),
 * altrimenti VITE_APP_URL. Sui Deploy Preview (CONTEXT != production) robots.txt blocca tutto.
 * Non modifica lo script inline di index.html (il suo hash è nella CSP).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function siteUrl(env = process.env) {
  const raw = (env.SITE_URL || env.URL || env.VITE_APP_URL || '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^\s/]+$/.test(raw) ? raw : ''
}

export function robotsTxt(routes, base, production = true) {
  if (!production) return 'User-agent: *\nDisallow: /\n'
  const lines = ['User-agent: *', 'Allow: /', ...routes.disallow.map((p) => `Disallow: ${p}`)]
  if (base) lines.push('', `Sitemap: ${base}/sitemap.xml`)
  return lines.join('\n') + '\n'
}

export function sitemapXml(routes, base, today = new Date().toISOString().slice(0, 10)) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const urls = routes.indexable
    .map((r) => `  <url>\n    <loc>${esc(base + (r.path === '/' ? '/' : r.path))}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dist = resolve(root, 'dist')
  if (!existsSync(dist)) {
    console.error('generate-seo: cartella dist assente (eseguire dopo vite build)')
    process.exit(1)
  }
  const routes = JSON.parse(readFileSync(resolve(root, 'seo/public-routes.json'), 'utf8'))
  const base = siteUrl()
  const production = !process.env.CONTEXT || process.env.CONTEXT === 'production'
  writeFileSync(resolve(dist, 'robots.txt'), robotsTxt(routes, base, production))
  if (base) writeFileSync(resolve(dist, 'sitemap.xml'), sitemapXml(routes, base))
  else console.warn('generate-seo: SITE_URL/URL non impostato, sitemap.xml non generata')
  const indexPath = resolve(dist, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  writeFileSync(indexPath, html.replaceAll('__SITE_URL__', base))
  console.log(`generate-seo: robots.txt${base ? ', sitemap.xml' : ''} (${base || 'URL non configurato'}, ${production ? 'production' : 'preview: noindex'})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
