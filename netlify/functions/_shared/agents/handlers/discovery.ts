import { createHash } from 'node:crypto'
import { runSearch } from '../../lead-finder/services'
import { searchInputSchema } from '../../lead-finder/validation'
import { AgentError } from '../errors'
import type { StepContext, StepHandler, StepResult } from '../engine'
import type { ProspectingParams } from '../validation'

/**
 * AI Discovery Agent — potenzia il Lead Finder esistente.
 *
 * 1. riceve settore, area e cliente ideale (profilo ICP dell'organizzazione);
 * 2. seleziona un provider AUTORIZZATO e configurato la cui licenza consente la memorizzazione
 *    (necessaria per i passi successivi: Google Places è escluso per licenza);
 * 3-5. cerca aziende reali, normalizza e deduplica (runSearch: stesse quote, rate limit e costi provider);
 * 6. verifica la provenienza (fonte e attribuzione registrate per ogni candidato);
 * 7. salva i risultati idonei (candidati) e applica i filtri;
 * 8. segnala i dati mancanti.
 * Nessun dato viene inventato: email e nominativi non sono mai richiesti ai provider.
 */
function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex')
  // Formato UUID v4 valido (versione 4, variante 10xx) derivato in modo deterministico dal passo e dal tentativo.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const discoveryHandler: StepHandler = {
  agent: 'discovery',
  async run(ctx: StepContext): Promise<StepResult> {
    const p = ctx.workflow.params as unknown as ProspectingParams
    const { registry, leadFinder, billing } = ctx.services

    // Ripresa: la ricerca di questo passo è già stata completata in un tentativo precedente.
    if (typeof ctx.progress.search_id === 'string' && ctx.progress.done === true) {
      return { output: ctx.progress as Record<string, unknown>, itemsTotal: Number(ctx.progress.total ?? 0), itemsFailed: 0 }
    }

    const candidates = Object.values(registry).filter((a) => a.license.canStoreContent && (p.provider === 'auto' || a.id === p.provider))
    const adapter = candidates.find((a) => a.missingConfig().length === 0)
    if (!adapter) {
      const missing = [...new Set(candidates.flatMap((a) => a.missingConfig()))]
      throw new AgentError('provider_not_configured', { stopWorkflow: true, details: { missing } })
    }

    const searchId = stableUuid(`${ctx.step.id}:${ctx.attempt}`)
    const input = searchInputSchema.parse({
      organization_id: ctx.orgId,
      search_id: searchId,
      provider: adapter.id,
      sector: p.sector,
      location: p.location,
      country: p.country,
      keywords: p.keywords,
      max_results: p.max_results,
      website_filter: p.website_filter,
    })
    const res = await ctx.tools.call(
      'provider.search',
      { provider: adapter.id, sector: p.sector, location: p.location, country: p.country, max_results: p.max_results, website_filter: p.website_filter },
      () => runSearch({ store: leadFinder, registry, billing }, { orgId: ctx.orgId, userId: ctx.userId }, input),
      { summarizeResult: (r) => ({ found: r.counts.found, new: r.counts.new, duplicates: r.counts.duplicates_in_batch, in_crm: r.counts.in_crm }) },
    )
    await ctx.recordCost({ kind: 'provider_call', aiJobId: null, model: null, tokensInput: 0, tokensOutput: 0, credits: 0, costUsd: null, cacheHit: false })

    const ids = await ctx.store.listCandidatesBySearch(ctx.orgId, searchId, 200)
    const records = await ctx.tools.call('candidates.read', { count: ids.length }, () => leadFinder.getCandidates(ctx.orgId, ids))
    const missing = { website: 0, phone: 0, address: 0, sector: 0, company_size: records.length }
    const provenanceIssues: string[] = []
    const kept: { id: string; score: number }[] = []
    let excluded = 0
    for (const c of records) {
      if (!c.website) missing.website++
      if (!c.phone) missing.phone++
      if (!c.address && !c.city) missing.address++
      if (!c.sector) missing.sector++
      // Provenienza: provider + id esterno sempre presenti; per i provider con memorizzazione serve l'URL della fonte.
      if (!c.sourceUrl && !c.sourceId) provenanceIssues.push(c.id)
      if (c.status === 'excluded') {
        excluded++
        continue
      }
      if (!c.sourceUrl && !c.sourceId) continue
      // Ordine iniziale per punteggio a regole; il filtro di compatibilità (min_score) è applicato dallo
      // Scoring Agent dopo l'eventuale analisi, perché senza analisi il punteggio a regole è parziale.
      kept.push({ id: c.id, score: c.score ?? 0 })
    }
    kept.sort((a, b) => b.score - a.score)
    const output = {
      done: true,
      provider: adapter.id,
      search_id: searchId,
      candidate_ids: kept.map((k) => k.id),
      counts: {
        total: records.length,
        found: res.counts.found,
        new: res.counts.new,
        already_known: res.counts.already_known,
        duplicates_in_batch: res.counts.duplicates_in_batch,
        in_crm: res.counts.in_crm,
        excluded,
        provenance_missing: provenanceIssues.length,
        kept: kept.length,
      },
      missing_data: missing,
      unsupported_filters: p.company_size !== 'any' ? ['company_size'] : [],
      plan_leads: res.plan_leads ?? null,
      attribution: adapter.license.attribution,
    }
    await ctx.checkpoint(output)
    return { output, itemsTotal: records.length, itemsFailed: 0, partial: !!res.plan_leads?.partial }
  },
}
