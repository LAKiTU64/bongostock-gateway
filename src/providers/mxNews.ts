import { createHash } from 'node:crypto'

import { TtlCache } from '../cache.js'
import type {
  NewsDepth,
  NewsItem,
  NewsProvider,
  NewsScope,
  NewsSearchRequest,
  NewsSearchResult,
  NewsTimeRange,
  NewsType,
} from '../types.js'

const MX_NEWS_URL = 'https://mkapi2.dfcfs.com/finskillshub/api/claw/news-search'
const ALL_TYPES: readonly NewsType[] = ['news', 'announcement', 'report', 'external']

interface MxNewsRecord {
  code?: unknown
  title?: unknown
  content?: unknown
  trunk?: unknown
  date?: unknown
  publishDate?: unknown
  informationType?: unknown
  source?: unknown
  insName?: unknown
  jumpUrl?: unknown
}

interface NormalizedRecord {
  item: NewsItem
  dedupeKeys: string[]
  publishedAtMs?: number
}

export class NewsServiceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanText(value: unknown) {
  return text(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeUrl(value: unknown) {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
  } catch {
    // Upstream also returns empty and non-web links. They are intentionally omitted.
  }
  return undefined
}

function newsType(value: unknown): NewsType {
  switch (text(value).toUpperCase()) {
    case 'NOTICE':
    case 'ANNOUNCEMENT':
      return 'announcement'
    case 'REPORT':
      return 'report'
    case 'INV_NEWS':
    case 'WECHAT':
      return 'external'
    default:
      return 'news'
  }
}

function parseShanghaiTime(value: unknown) {
  const raw = text(value)
  if (!raw) return undefined
  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return undefined
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
  const iso = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+08:00`
  const millis = Date.parse(iso)
  return Number.isFinite(millis) ? millis : undefined
}

function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

function normalizeTitle(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value
  }
}

function normalizeRecord(record: MxNewsRecord): NormalizedRecord | undefined {
  const title = cleanText(record.title)
  if (!title) return undefined
  const url = safeUrl(record.jumpUrl)
  const upstreamCode = text(record.code)
  const rawPublishedAt = text(record.publishDate) || text(record.date)
  const publishedAtMs = parseShanghaiTime(rawPublishedAt)
  const normalizedTitle = normalizeTitle(title)
  const dedupeKeys = [
    `title:${normalizedTitle}`,
    ...(url ? [`url:${normalizeUrl(url)}`] : []),
    ...(upstreamCode ? [`upstream:${upstreamCode}`] : []),
  ]
  const idSeed = `${dedupeKeys[0]}|${rawPublishedAt}`
  const item: NewsItem = {
    id: stableId(idSeed),
    title,
    summary: cleanText(record.content || record.trunk),
    ...(publishedAtMs !== undefined ? { publishedAt: new Date(publishedAtMs).toISOString() } : {}),
    source: cleanText(record.source || record.insName) || '来源暂不可用',
    type: newsType(record.informationType),
    ...(url ? { url } : {}),
  }
  return {
    item,
    dedupeKeys,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
  }
}

function timePhrase(range: NewsTimeRange) {
  if (range === '1d') return '最近24小时'
  if (range === '3d') return '最近3日'
  if (range === '7d') return '最近7日'
  return ''
}

function briefingPreset(preset: string, now: number) {
  if (preset !== 'auto') return preset
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now))
  const weekday = parts.find(part => part.type === 'weekday')?.value
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend'
  if (hour < 12) return 'morning'
  if (hour < 15) return 'noon'
  return 'evening'
}

function presetQueries(scope: NewsScope, preset: string, security?: { code: string, name: string }) {
  if (scope === 'security' && security) {
    const subject = `${security.name}（${security.code}）`
    const map: Record<string, [string, string]> = {
      latest: [`${subject}的重要新闻和公司动态`, `${subject}的公告、研报、机构观点和行业影响`],
      announcement: [`${subject}的最新公司公告`, `${subject}公告相关的市场解读和重要新闻`],
      report: [`${subject}的最新研报和机构观点`, `${subject}的行业研究、评级和目标价变化`],
      earnings: [`${subject}的业绩、财报和经营数据新闻`, `${subject}业绩相关公告、研报和机构解读`],
      risk: [`${subject}的风险事件、监管信息和负面新闻`, `${subject}的风险提示公告和机构风险观点`],
      industry: [`${subject}相关行业的重要动态`, `${subject}受产业政策和上下游变化影响的新闻`],
    }
    return map[preset] ?? map.latest!
  }

  if (scope === 'briefing') {
    const map: Record<string, [string, string]> = {
      morning: ['A股早报：隔夜全球市场、宏观政策和今日重要事件', 'A股早报：上市公司重要公告、行业动态和财经日历'],
      noon: ['A股午间综述：上午大盘、主要指数、行业板块和资金动向', 'A股午间重要公司新闻、公告和行业事件'],
      evening: ['A股晚报：全天市场表现、主要指数、行业板块和资金动向', 'A股盘后重要公告、公司新闻和机构观点'],
      weekend: ['A股周末重要宏观政策和市场新闻', 'A股周末行业动态、公司公告和下周关注事件'],
    }
    return map[preset] ?? map.morning!
  }

  const map: Record<string, [string, string]> = {
    overview: ['A股全市场重要新闻：宏观政策和市场行情', 'A股全市场重要新闻：行业动态、上市公司和重要公告'],
    macro: ['影响A股的重要宏观政策和经济新闻', '全球市场、国内政策和宏观数据对A股的影响'],
    market: ['A股主要指数、盘面和资金动向的重要新闻', 'A股市场热点、交易情绪和市场综述'],
    industry: ['A股重要行业和产业动态', 'A股行业政策、产业链变化和板块新闻'],
    company: ['A股上市公司重要新闻', 'A股公司经营、并购、风险和重大事项'],
    announcement: ['A股上市公司重要公告', 'A股业绩、股东、并购和风险提示公告'],
    report: ['A股最新机构研报和投资观点', 'A股行业研究、公司评级和策略观点'],
  }
  return map[preset] ?? map.overview!
}

export function buildNewsQueries(request: NewsSearchRequest, now: number) {
  const preset = request.scope === 'briefing' ? briefingPreset(request.preset, now) : request.preset
  const [presetPrimary, presetSecondary] = presetQueries(request.scope, preset, request.security)
  const primary = request.query || presetPrimary
  const secondary = request.query
    ? `${request.query}，补充不同来源的公告、研报、行业影响和相关重要事件`
    : presetSecondary
  const phrase = timePhrase(request.timeRange)
  const withTime = (query: string) => phrase ? `${phrase}${query}` : query
  const queries = [withTime(primary)]
  if (request.depth === 'extended' && secondary !== primary) queries.push(withTime(secondary))
  return queries
}

function interleave<T>(groups: readonly T[][]) {
  if (groups.length <= 1) return groups[0] ? [...groups[0]] : []
  const rows: T[] = []
  const maxLength = Math.max(...groups.map(group => group.length))
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const row = group[index]
      if (row !== undefined) rows.push(row)
    }
  }
  return rows
}

function sorted(records: NormalizedRecord[], sort: NewsSearchRequest['sort']) {
  if (sort === 'default') return records
  const direction = sort === 'newest' ? -1 : 1
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftTime = left.record.publishedAtMs
      const rightTime = right.record.publishedAtMs
      if (leftTime === undefined && rightTime === undefined) return left.index - right.index
      if (leftTime === undefined) return 1
      if (rightTime === undefined) return -1
      return (leftTime - rightTime) * direction || left.index - right.index
    })
    .map(row => row.record)
}

function cutoff(range: NewsTimeRange, now: number) {
  if (range === 'all') return undefined
  const days = range === '1d' ? 1 : range === '3d' ? 3 : 7
  return now - days * 24 * 60 * 60_000
}

function resultLimit(depth: NewsDepth) {
  if (depth === 'compact') return 5
  if (depth === 'standard') return 10
  return 20
}

function cacheKey(request: NewsSearchRequest) {
  return JSON.stringify({ ...request, types: [...request.types].sort() })
}

export class MxNewsProvider implements NewsProvider {
  readonly enabled: boolean
  private readonly cache = new TtlCache<NewsSearchResult>()

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly cacheMs: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled = Boolean(apiKey)
  }

  async search(request: NewsSearchRequest): Promise<NewsSearchResult> {
    if (!this.enabled) throw new NewsServiceError('资讯服务未配置', 501)
    const key = cacheKey(request)
    const cached = this.cache.get(key)
    if (cached) return { ...cached, meta: { ...cached.meta, cached: true } }

    const now = this.now()
    const queries = buildNewsQueries(request, now)
    const groups = await Promise.all(queries.map(query => this.fetchQuery(query)))
    const upstreamCount = groups.reduce((sum, group) => sum + group.length, 0)
    const normalizedGroups = groups.map(group => group.map(normalizeRecord).filter((item): item is NormalizedRecord => Boolean(item)))
    const combined = interleave(normalizedGroups)
    const seen = new Set<string>()
    const unique: NormalizedRecord[] = []
    let duplicateCount = 0
    for (const record of combined) {
      if (record.dedupeKeys.some(key => seen.has(key))) {
        duplicateCount += 1
        continue
      }
      record.dedupeKeys.forEach(key => seen.add(key))
      unique.push(record)
    }

    const allowedTypes = new Set(request.types.length ? request.types : ALL_TYPES)
    const threshold = cutoff(request.timeRange, now)
    const inRange: NormalizedRecord[] = []
    const outOfRange: NormalizedRecord[] = []
    let filteredTypeCount = 0
    for (const record of unique) {
      if (!allowedTypes.has(record.item.type)) {
        filteredTypeCount += 1
        continue
      }
      if (threshold !== undefined && (record.publishedAtMs === undefined || record.publishedAtMs < threshold)) {
        outOfRange.push(record)
      } else {
        inRange.push(record)
      }
    }

    const items = sorted(inRange, request.sort).slice(0, resultLimit(request.depth)).map(record => record.item)
    const outOfRangeItems = sorted(outOfRange, request.sort).slice(0, 20).map(record => record.item)
    const result: NewsSearchResult = {
      items,
      outOfRangeItems,
      stats: {
        upstreamCount,
        duplicateCount,
        outOfRangeCount: outOfRange.length,
        filteredTypeCount,
        returnedCount: items.length,
      },
      meta: {
        provider: 'mx-news-search',
        sort: request.sort,
        timeRange: request.timeRange,
        depth: request.depth,
        retrievedAt: new Date(now).toISOString(),
        cached: false,
      },
    }
    this.cache.set(key, result, this.cacheMs)
    return result
  }

  private async fetchQuery(query: string): Promise<MxNewsRecord[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(MX_NEWS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      })
      if (!response.ok) throw new NewsServiceError('妙想资讯上游请求失败', response.status === 429 ? 429 : 502)
      const payload = await response.json() as Record<string, unknown>
      const status = Number(payload.status ?? -1)
      const code = Number(payload.code ?? status)
      if (status !== 0 || code !== 0) {
        throw new NewsServiceError(code === 113 ? '妙想资讯今日额度已用尽' : '妙想资讯上游返回失败', code === 113 ? 429 : 502)
      }
      const data = payload.data as Record<string, unknown> | undefined
      const inner = data?.data as Record<string, unknown> | undefined
      const searchResponse = inner?.llmSearchResponse as Record<string, unknown> | undefined
      return Array.isArray(searchResponse?.data) ? searchResponse.data as MxNewsRecord[] : []
    } catch (error) {
      if (error instanceof NewsServiceError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new NewsServiceError('妙想资讯请求超时', 504)
      throw new NewsServiceError('妙想资讯上游暂时不可用', 502)
    } finally {
      clearTimeout(timer)
    }
  }
}
