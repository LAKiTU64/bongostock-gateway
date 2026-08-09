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

export type NewsScope = 'market' | 'briefing' | 'security'
export type NewsSort = 'default' | 'newest' | 'oldest'
export type NewsTimeRange = '1d' | '3d' | '7d' | 'all'
export type NewsDepth = 'compact' | 'standard' | 'extended'
export type NewsType = 'news' | 'announcement' | 'report' | 'external'

export interface NewsSecurityContext {
  code: string
  name: string
}

export interface NewsSearchRequest {
  scope: NewsScope
  preset: string
  query?: string
  security?: NewsSecurityContext
  timeRange: NewsTimeRange
  sort: NewsSort
  depth: NewsDepth
  types: NewsType[]
}

export interface NewsItem {
  id: string
  title: string
  summary: string
  publishedAt?: string
  source: string
  type: NewsType
  url?: string
}

export interface NewsSearchResult {
  items: NewsItem[]
  outOfRangeItems: NewsItem[]
  stats: {
    upstreamCount: number
    duplicateCount: number
    outOfRangeCount: number
    filteredTypeCount: number
    returnedCount: number
  }
  meta: {
    provider: 'mx-news-search'
    sort: NewsSort
    timeRange: NewsTimeRange
    depth: NewsDepth
    retrievedAt: string
    cached: boolean
  }
}

export interface NewsProvider {
  readonly enabled: boolean
  search(request: NewsSearchRequest): Promise<NewsSearchResult>
}

export type ProviderSource = 'auto' | 'tencent' | 'sina' | 'eastmoney'
export type KlinePeriod = 'day' | 'week' | 'month'
export type KlineAdjust = 'none' | 'qfq' | 'hfq'
