import { stocks } from 'stock-api'

import type { Candidate, Kline, KlineAdjust, KlinePeriod, ProviderSource, Quote } from '../types.js'
import { TtlCache } from '../cache.js'
import { normalizeMarketCode } from '../validation.js'

const QUOTE_BATCH_SIZE = 25

function finite(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function availableName(value: unknown) {
  const name = String(value ?? '').trim()
  return name && name !== '---' ? name : '---'
}

export class StockApiProvider {
  private readonly searchCache = new TtlCache<Candidate[]>()

  private api(source: ProviderSource) {
    return source === 'auto' ? stocks.auto : stocks[source]
  }

  private mapQuote(row: Awaited<ReturnType<typeof stocks.auto.getStock>>): Quote {
    const code = String(row.code ?? '').toUpperCase()
    const result: Quote = {
      code: code || 'UNKNOWN',
      name: availableName(row.name),
      now: finite(row.now),
      low: finite(row.low),
      high: finite(row.high),
      percent: finite(row.percent),
      yesterday: finite(row.yesterday),
    }
    if (row.source !== undefined) result.source = row.source
    return result
  }

  async getStock(code: string, source: ProviderSource): Promise<Quote> {
    return this.mapQuote(await this.api(source).getStock(code))
  }

  async getStocks(codes: readonly string[], source: ProviderSource): Promise<Quote[]> {
    const batches: string[][] = []
    for (let index = 0; index < codes.length; index += QUOTE_BATCH_SIZE) {
      batches.push(codes.slice(index, index + QUOTE_BATCH_SIZE))
    }

    const rows = (await Promise.all(batches.map(batch => this.api(source).getStocks(batch)))).flat()
    return rows.map(row => this.mapQuote(row))
  }

  async search(query: string, source: ProviderSource): Promise<Candidate[]> {
    const cacheKey = `${source}:${query.toUpperCase()}`
    const cached = this.searchCache.get(cacheKey)
    if (cached) return cached

    const rows = await this.api(source).searchStocks(query)
    const candidates = rows
      .map(row => ({ code: String(row.code ?? '').toUpperCase(), name: availableName(row.name) }))
      .filter(row => (/^(?:SH|SZ|HK)\d{6}$/.test(row.code) || /^US[A-Z0-9._-]{1,16}$/.test(row.code)) && row.name !== '---')

    this.searchCache.set(cacheKey, candidates, 60 * 60_000)
    return candidates
  }

  async inspect(code: string, source: ProviderSource) {
    return this.api(source).inspectStock(code)
  }

  async getKlines(code: string, count: number, period: KlinePeriod, adjust: KlineAdjust, source: ProviderSource): Promise<Kline[]> {
    const rows = await this.api(source).getKlines(code, { period, count, adjust })
    return rows.map((row) => {
      const result: Kline = {
        date: String(row.date),
        open: finite(row.open),
        close: finite(row.close),
        high: finite(row.high),
        low: finite(row.low),
      }
      if (row.volume !== undefined) result.volume = finite(row.volume)
      if (row.source !== undefined) result.source = row.source
      return result
    })
  }
}
