import { callStructured, type AiCallResult } from './openai'
import { extractPage, quoteFound } from './extract'
import { isAllowedByRobots } from './robots'
import { safeFetchText, SsrfError } from './ssrf'
import { modelOutputJsonSchema, modelOutputSchema, type AnalysisResult, type WebsiteStatus } from './schema'
import { AiError } from './openai'
import type { IcpProfile } from '../types'
import type { ScorableCompany } from '../scoring'

/**
 * AI Business Analyzer.
 * 1. Legge la home page del sito aziendale solo se robots.txt lo consente (fetch anti-SSRF).
 * 2. Chiede al modello un'analisi strutturata separando fatti, ipotesi e lacune.
 * 3. Verifica lato server ogni citazione: ciò che non compare nel testo sorgente
 *    viene declassato a ipotesi. Le esigenze digitali sono sempre ipotesi.
 */
export const ANALYZER_UA = 'LeadFlowAI-Analyzer'

export interface WebsiteContent {
  url: string | null
  status: WebsiteStatus
  fetchedAt: string | null
  title: string | null
  description: string | null
  text: string
}

type FetchText = typeof safeFetchText

export async function readWebsite(website: string | null, fetchText: FetchText = safeFetchText): Promise<WebsiteContent> {
  const empty = (status: WebsiteStatus): WebsiteContent => ({ url: website, status, fetchedAt: null, title: null, description: null, text: '' })
  if (!website) return empty('no_website')
  try {
    const origin = new URL(website).origin
    try {
      const robots = await fetchText(`${origin}/robots.txt`, { timeoutMs: 4000, maxBytes: 100_000, accept: /^text\/plain/i, userAgent: ANALYZER_UA })
      if (robots.status === 200 && !isAllowedByRobots(robots.body, new URL(website).pathname || '/', ANALYZER_UA)) return empty('robots_disallowed')
    } catch (err) {
      if (err instanceof SsrfError && err.code === 'blocked_address') return empty('blocked_address')
      // robots.txt assente o non leggibile: si procede (RFC 9309, 4xx = nessuna restrizione).
    }
    const page = await fetchText(website, { timeoutMs: 8000, maxBytes: 600_000, userAgent: ANALYZER_UA })
    if (page.status !== 200 || !page.body) return empty('fetch_failed')
    const ex = extractPage(page.body)
    return { url: page.url, status: 'analyzed', fetchedAt: new Date().toISOString(), title: ex.title, description: ex.description, text: ex.text }
  } catch (err) {
    if (err instanceof SsrfError) {
      if (err.code === 'blocked_address' || err.code === 'invalid_url') return empty('blocked_address')
      if (err.code === 'unsupported_content') return empty('unsupported_content')
    }
    return empty('fetch_failed')
  }
}

export function providerFacts(c: ScorableCompany, providerLabel: string): AnalysisResult['verified_facts'] {
  const facts: AnalysisResult['verified_facts'] = []
  const add = (statement: string, evidence: string | null) => evidence && facts.push({ statement, source: 'provider', evidence })
  add(`Nome registrato su ${providerLabel}`, c.companyName)
  add(`Categoria su ${providerLabel}`, c.sector)
  add(`Località su ${providerLabel}`, [c.address, c.city].filter(Boolean).join(', ') || null)
  add(`Sito web indicato su ${providerLabel}`, c.website)
  add(`Telefono aziendale indicato su ${providerLabel}`, c.phone)
  return facts
}

const SYSTEM_PROMPT = `Sei un analista commerciale B2B. Analizzi un'azienda per un'altra azienda (il "cliente") che vende servizi.
Regole obbligatorie:
- Usa SOLO le informazioni fornite. Non inventare dati, persone, email, numeri o eventi.
- "verified_facts": solo affermazioni supportate da una citazione TESTUALE ESATTA presa dal testo del sito (campo evidence, max 200 caratteri, copiata parola per parola).
- Ciò che deduci va in "hypotheses" con la motivazione. Le "digital_needs" sono sempre ipotesi: NON presentarle come richieste del potenziale cliente.
- "signals": solo segnali commerciali osservabili (es. assunzioni, nuove sedi, prenotazioni online assenti, sito non aggiornato), ciascuno con citazione esatta dal sito; se non ce ne sono, lascia l'array vuoto.
- Se un'informazione manca, dichiarala in "missing_information" e usa basis "missing" con value "".
- "fit.sector_rating" e "fit.icp_rating" sono interi da 0 a 10 rispetto al profilo del cliente; se il profilo non è definito usa 0 e spiegalo.
- Non estrarre nomi di persone né contatti personali.
- Scrivi in italiano, in modo conciso e professionale.`

export function buildUserPrompt(c: ScorableCompany, site: WebsiteContent, profile: IcpProfile, keywords: string[]): string {
  const block = (title: string, body: string) => `### ${title}\n${body || '(nessun dato)'}`
  return [
    block(
      'Dati dal provider (verificati)',
      [`Nome: ${c.companyName ?? ''}`, `Categoria: ${c.sector ?? ''}`, `Indirizzo: ${c.address ?? ''}`, `Città: ${c.city ?? ''}`, `Paese: ${c.country ?? ''}`, `Sito: ${c.website ?? ''}`].join('\n'),
    ),
    block(
      `Testo del sito web (${site.status})`,
      site.status === 'analyzed' ? [site.title && `Titolo: ${site.title}`, site.description && `Descrizione: ${site.description}`, site.text].filter(Boolean).join('\n') : '',
    ),
    block(
      'Profilo del cliente che vende',
      [
        `Servizi offerti: ${profile.servicesDescription ?? 'non definito'}`,
        `Cliente ideale: ${profile.idealCustomer ?? 'non definito'}`,
        `Settori target: ${profile.targetSectors.join(', ') || 'non definiti'}`,
        `Aree target: ${[...profile.targetRegions, ...profile.targetCountries].join(', ') || 'non definite'}`,
        `Parole chiave della ricerca: ${keywords.join(', ') || 'nessuna'}`,
      ].join('\n'),
    ),
  ].join('\n\n')
}

const clamp10 = (n: number) => Math.max(0, Math.min(10, Math.round(Number.isFinite(n) ? n : 0)))
const cut = (s: string, n = 600) => s.slice(0, n)

/** Applica le regole di verifica all'output del modello. Esportata per i test. */
export function verifyOutput(raw: unknown, site: WebsiteContent, c: ScorableCompany, providerLabel: string, meta: { model: string; usage: AiCallResult['usage'] }): AnalysisResult {
  const parsed = modelOutputSchema.safeParse(raw)
  if (!parsed.success) throw new AiError('ai_bad_response')
  const o = parsed.data
  const source = [site.title, site.description, site.text].filter(Boolean).join('\n')
  const hypotheses = o.hypotheses.map((h) => ({ statement: cut(h.statement), rationale: cut(h.rationale) }))

  const websiteFacts: AnalysisResult['verified_facts'] = []
  for (const f of o.verified_facts) {
    if (quoteFound(f.evidence, source)) websiteFacts.push({ statement: cut(f.statement), source: 'website', evidence: cut(f.evidence, 200) })
    else hypotheses.push({ statement: cut(f.statement), rationale: 'Citazione non trovata nel sito: trattata come ipotesi.' })
  }
  const field = (v: { value: string; basis: 'verified' | 'hypothesis' | 'missing'; evidence: string }) => {
    if (v.basis === 'verified' && !quoteFound(v.evidence, source)) return { value: cut(v.value), basis: 'hypothesis' as const, evidence: '' }
    if (!v.value.trim()) return { value: '', basis: 'missing' as const, evidence: '' }
    return { value: cut(v.value), basis: v.basis, evidence: cut(v.evidence, 200) }
  }
  return {
    version: 1,
    model: meta.model,
    analyzed_at: new Date().toISOString(),
    website: { url: site.url, status: site.status, fetched_at: site.fetchedAt },
    sector: field(o.sector),
    activity_description: field(o.activity_description),
    verified_facts: [...providerFacts(c, providerLabel), ...websiteFacts],
    hypotheses: hypotheses.slice(0, 15),
    digital_needs: o.digital_needs.map((d) => ({ need: cut(d.need), rationale: cut(d.rationale), evidence: quoteFound(d.evidence, source) ? cut(d.evidence, 200) : '', basis: 'hypothesis' as const })),
    opportunities: o.opportunities.map((x) => ({ opportunity: cut(x.opportunity), rationale: cut(x.rationale) })),
    missing_information: [
      ...o.missing_information.map((m) => cut(m, 200)),
      ...(site.status !== 'analyzed' ? [`Sito web non analizzato (${site.status})`] : []),
    ].slice(0, 15),
    fit: { sector_rating: clamp10(o.fit.sector_rating), sector_reason: cut(o.fit.sector_reason), icp_rating: clamp10(o.fit.icp_rating), icp_reason: cut(o.fit.icp_reason) },
    signals: o.signals.map((s) => ({ signal: cut(s.signal, 200), evidence: cut(s.evidence, 200), verified: quoteFound(s.evidence, source) })),
    qualification_reason: cut(o.qualification_reason, 1200),
    usage: meta.usage,
  }
}

export async function analyzeCompany(params: {
  company: ScorableCompany
  providerLabel: string
  profile: IcpProfile
  keywords: string[]
  env?: NodeJS.ProcessEnv
  fetchText?: FetchText
  fetchImpl?: typeof fetch
}): Promise<AnalysisResult> {
  const env = params.env ?? process.env
  const apiKey = env.OPENAI_API_KEY ?? ''
  const model = env.OPENAI_MODEL ?? ''
  if (!apiKey || !model) throw new AiError('ai_not_configured')
  const site = await readWebsite(params.company.website, params.fetchText)
  const res = await callStructured({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(params.company, site, params.profile, params.keywords),
    schemaName: 'lead_analysis',
    schema: modelOutputJsonSchema,
    timeoutMs: 60_000,
    fetchImpl: params.fetchImpl,
  })
  return verifyOutput(res.json, site, params.company, params.providerLabel, { model: res.model, usage: res.usage })
}
