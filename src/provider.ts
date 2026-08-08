import { TtlCache } from './cache.js'
import type { GatewayConfig } from './config.js'
import type { KlineAdjust, KlinePeriod, MarketProvider, ProviderSource } from './types.js'
import { StockApiProvider } from './providers/stockApi.js'
import { TrendProvider } from './providers/trends.js'

export function createProvider(config: GatewayConfig): MarketProvider {
  const stockApi = new StockApiProvider()
  const trends = new TrendProvider(config.requestTimeoutMs, config.trendCacheMs)
  const quoteCache = new TtlCache<Awaited<ReturnType<StockApiProvider['getStocks']>>>()
  const klineCache = new TtlCache<Awaited<ReturnType<StockApiProvider['getKlines']>>>()

  return {
    async getQuotes(codes) {
      return this.getStocks(codes, 'auto')
    },
    async getStock(code, source: ProviderSource) {
      return stockApi.getStock(code, source)
    },
    async getStocks(codes, source: ProviderSource) {
      const key = `${source}:${[...codes].sort().join(',')}`
      const cached = quoteCache.get(key)
      if (cached) return cached
      const rows = await stockApi.getStocks(codes, source)
      quoteCache.set(key, rows, config.quoteCacheMs)
      return rows
    },
    search: (query, source) => stockApi.search(query, source),
    inspect: (code, source) => stockApi.inspect(code, source),
    getTrends: (code, days) => trends.get(code, days),
    async getKlines(code, count, period: KlinePeriod, adjust: KlineAdjust, source: ProviderSource) {
      const key = `${source}:${code}:${period}:${adjust}:${count}`
      const cached = klineCache.get(key)
      if (cached) return cached
      const rows = await stockApi.getKlines(code, count, period, adjust, source)
      klineCache.set(key, rows, config.klineCacheMs)
      return rows
    },
  }
}
