import type { IncomingMessage } from 'node:http'

import type { NewsDepth, NewsScope, NewsSearchRequest, NewsSort, NewsTimeRange, NewsType } from './types.js'

export function normalizeMarketCode(value: unknown) {
  const code = String(value ?? '').trim().toUpperCase()
  if (!/^(?:SH|SZ|HK)\d{6}$/.test(code) && !/^US[A-Z0-9._-]{1,16}$/.test(code)) {
    throw new RequestValidationError('证券代码格式不受支持')
  }
  return code
}

export function normalizeAshareCode(value: unknown) {
  const code = normalizeMarketCode(value)
  if (!/^(?:SH|SZ)\d{6}$/.test(code)) throw new RequestValidationError('该接口只支持 SH/SZ 加 6 位数字')
  return code
}

export function parseCodes(value: unknown, maxCodes: number) {
  if (!Array.isArray(value) || value.length > maxCodes) {
    throw new RequestValidationError(`codes 必须是最多 ${maxCodes} 个证券代码的数组`)
  }

  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const code = normalizeMarketCode(item)
    if (!seen.has(code)) {
      seen.add(code)
      result.push(code)
    }
  }
  return result
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('请求正文必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

export function parseSearchQuery(value: unknown) {
  const query = String(value ?? '').trim()
  if (query.length === 0 || query.length > 64) throw new RequestValidationError('query 长度必须为 1～64 个字符')
  return query
}

export function parseDays(value: unknown): 1 | 5 {
  if (value === 1 || value === 5 || value === '1' || value === '5') return Number(value) as 1 | 5
  throw new RequestValidationError('days 只能是 1 或 5')
}

export function parseCount(value: unknown) {
  const count = Number(value ?? 30)
  if (!Number.isInteger(count) || count < 1 || count > 120) {
    throw new RequestValidationError('count 必须是 1～120 的整数')
  }
  return count
}

export function parseSource(value: unknown) {
  const source = value === undefined ? 'auto' : String(value).toLowerCase()
  if (source === 'auto' || source === 'tencent' || source === 'sina' || source === 'eastmoney') return source
  throw new RequestValidationError('source 只能是 auto、tencent、sina 或 eastmoney')
}

export function parsePeriod(value: unknown) {
  const period = value === undefined ? 'day' : String(value).toLowerCase()
  if (period === 'day' || period === 'week' || period === 'month') return period
  throw new RequestValidationError('period 只能是 day、week 或 month')
}

export function parseAdjust(value: unknown) {
  const adjust = value === undefined ? 'none' : String(value).toLowerCase()
  if (adjust === 'none' || adjust === 'qfq' || adjust === 'hfq') return adjust
  throw new RequestValidationError('adjust 只能是 none、qfq 或 hfq')
}

function oneOf<T extends string>(value: unknown, fallback: T, values: readonly T[], label: string): T {
  const candidate = value === undefined ? fallback : String(value).toLowerCase()
  if (values.includes(candidate as T)) return candidate as T
  throw new RequestValidationError(`${label} 只能是 ${values.join('、')}`)
}

function optionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  if (text.length > maxLength) throw new RequestValidationError(`${label} 长度不能超过 ${maxLength} 个字符`)
  return text
}

export function parseNewsRequest(body: Record<string, unknown>): NewsSearchRequest {
  const scope = oneOf<NewsScope>(body.scope, 'market', ['market', 'briefing', 'security'], 'scope')
  const timeRange = oneOf<NewsTimeRange>(body.timeRange, '1d', ['1d', '3d', '7d', 'all'], 'timeRange')
  const sort = oneOf<NewsSort>(body.sort, 'default', ['default', 'newest', 'oldest'], 'sort')
  const depth = oneOf<NewsDepth>(body.depth, 'standard', ['compact', 'standard', 'extended'], 'depth')
  const preset = optionalText(body.preset, 'preset', 32) ?? (scope === 'briefing' ? 'auto' : scope === 'security' ? 'latest' : 'overview')
  const query = optionalText(body.query, 'query', 300)

  let security: { code: string, name: string } | undefined
  if (scope === 'security') {
    const raw = parseObject(body.security)
    const code = optionalText(raw.code, 'security.code', 24)
    const name = optionalText(raw.name, 'security.name', 40)
    if (!code || !name) throw new RequestValidationError('个股资讯必须提供 security.code 和 security.name')
    security = { code, name }
  }

  const allowedTypes: readonly NewsType[] = ['news', 'announcement', 'report', 'external']
  let types: NewsType[] = [...allowedTypes]
  if (body.types !== undefined) {
    if (!Array.isArray(body.types) || body.types.length === 0) throw new RequestValidationError('types 必须是非空数组')
    types = [...new Set(body.types.map(value => oneOf<NewsType>(value, 'news', allowedTypes, 'types')))]
  }

  return {
    scope,
    preset,
    ...(query ? { query } : {}),
    ...(security ? { security } : {}),
    timeRange,
    sort,
    depth,
    types,
  }
}

export function clientAddress(request: IncomingMessage, trustProxy: boolean) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]!.trim()
  }
  return request.socket.remoteAddress ?? 'unknown'
}

export class RequestValidationError extends Error {
  readonly statusCode = 400
}
