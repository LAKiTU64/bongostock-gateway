export interface Quote {
  code: string
  name: string
  now: number
  low: number
  high: number
  percent: number
  yesterday: number
  source?: 'base' | 'tencent' | 'sina' | 'eastmoney'
}

export interface Candidate {
  code: string
  name: string
}

export interface Kline {
  date: string
  open: number
  close: number
  high: number
  low: number
  volume?: number
  source?: 'tencent' | 'sina' | 'eastmoney' | 'fqkline'
}

export interface TrendPoint {
  timestamp: string
  date: string
  time: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount: number
  average: number
}

export interface TrendSeries {
  code: string
  name: string
  preClose: number
  points: TrendPoint[]
  source: 'eastmoney' | 'tencent'
}

export interface MarketProvider {
  getQuotes(codes: readonly string[]): Promise<Quote[]>
  getStock(code: string, source: ProviderSource): Promise<Quote>
  getStocks(codes: readonly string[], source: ProviderSource): Promise<Quote[]>
  search(query: string, source: ProviderSource): Promise<Candidate[]>
  inspect(code: string, source: ProviderSource): Promise<unknown>
  getKlines(code: string, count: number, period: KlinePeriod, adjust: KlineAdjust, source: ProviderSource): Promise<Kline[]>
  getTrends(code: string, days: 1 | 5): Promise<TrendSeries>
}

export type ProviderSource = 'auto' | 'tencent' | 'sina' | 'eastmoney'
export type KlinePeriod = 'day' | 'week' | 'month'
export type KlineAdjust = 'none' | 'qfq' | 'hfq'
