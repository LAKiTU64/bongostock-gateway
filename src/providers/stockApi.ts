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

const INDEX_CODE = /^(?:SH000|SZ399)\d{3}$/

function isIndexCode(value: string) {
  return INDEX_CODE.test(value)
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
    // Indices are only served reliably through Tencent's raw fqkline endpoint:
    // stock-api's kline providers return nothing for indices (tencent/sina),
    // and eastmoney is unreliable from some hosts. Route indices there directly.
    if (isIndexCode(code)) {
      return this.getIndexKlines(code, count, period, adjust)
    }
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

  private async getIndexKlines(code: string, count: number, period: KlinePeriod, adjust: KlineAdjust): Promise<Kline[]> {
    const lower = code.toLowerCase()
    const adjustParam = adjust === 'none' ? '' : adjust
    const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${lower},${period},,,${count},${adjustParam}`
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
    })
    if (!response.ok) throw new Error(`腾讯指数K线请求失败 HTTP ${response.status}`)
    const payload = await response.json() as {
      data?: Record<string, { day?: unknown[]; qfqday?: unknown[]; hfqday?: unknown[] }>
    }
    const node = payload.data?.[lower]
    if (!node) throw new Error('腾讯指数K线返回格式异常')
    const series = (adjust === 'qfq' && Array.isArray(node.qfqday) ? node.qfqday
      : adjust === 'hfq' && Array.isArray(node.hfqday) ? node.hfqday
      : node.day) as unknown[] | undefined
    if (!Array.isArray(series) || series.length === 0) throw new Error('腾讯指数K线暂无数据')
    return series.slice(-count).map((raw) => {
      const [date, open, close, high, low, volume] = Array.isArray(raw) ? raw : []
      const result: Kline = {
        date: String(date ?? ''),
        open: finite(open),
        close: finite(close),
        high: finite(high),
        low: finite(low),
      }
      if (volume !== undefined) result.volume = finite(volume)
      result.source = 'fqkline'
      return result
    })
  }
}
