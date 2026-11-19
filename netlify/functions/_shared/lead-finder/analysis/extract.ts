/** Estrae testo leggibile da HTML, rimuovendo script, stili e indirizzi email (minimizzazione dei dati). */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì' }

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
}
function safeChar(code: number): string {
  return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ' '
}

export interface ExtractedPage {
  title: string | null
  description: string | null
  text: string
}

export function extractPage(html: string, maxChars = 12_000): ExtractedPage {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ??
    null
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const clean = (s: string) =>
    decodeEntities(s)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email rimossa]')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim()
  return {
    title: title ? clean(title).slice(0, 300) : null,
    description: description ? clean(description).slice(0, 500) : null,
    text: clean(body).slice(0, maxChars),
  }
}

/** Normalizzazione per verificare che una citazione compaia davvero nel testo sorgente. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”«»"'’‘`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function quoteFound(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote)
  return q.length >= 8 && normalizeForMatch(source).includes(q)
}
