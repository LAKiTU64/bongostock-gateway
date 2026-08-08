import type { IncomingMessage } from 'node:http'

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
