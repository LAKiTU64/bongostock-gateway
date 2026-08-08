import { TtlCache } from '../cache.js'
import type { TrendPoint, TrendSeries } from '../types.js'

const EASTMONEY_HISTORY = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
const EASTMONEY_LIVE = [
  'https://push2.eastmoney.com/api/qt/stock/trends2/get',
  'https://push2delay.eastmoney.com/api/qt/stock/trends2/get',
] as const
const EASTMONEY_HISTORY_HOSTS = [
  'push2his.eastmoney.com',
  '7.push2his.eastmoney.com',
  '33.push2his.eastmoney.com',
  '63.push2his.eastmoney.com',
  '91.push2his.eastmoney.com',
] as const
const TENCENT_MINUTE = 'https://ifzq.gtimg.cn/appstock/app/minute/query'
const TENCENT_FIVE_DAY = 'https://ifzq.gtimg.cn/appstock/app/day/query'
const EASTMONEY_FIELDS = 'f51,f52,f53,f54,f55,f56,f57,f58'

interface EastmoneyPayload {
  data?: { name?: string, preClose?: number | string, trends?: string[] }
}

interface TencentPayload {
  data?: Record<string, {
    data?: { date?: string, data?: string[] } | Array<{ date?: string, data?: string[] }>
    qt?: Record<string, string[]>
  }>
}

function finite(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function positive(value: unknown, fallback: number) {
  const number = finite(value)
  return number > 0 ? number : fallback
}

function eastmoneyPoint(raw: string): TrendPoint[] {
  const [timestamp, open, close, high, low, volume, amount, average] = raw.split(',')
  if (!timestamp) return []
  const [date = timestamp, time = ''] = timestamp.split(' ')
  const closeValue = finite(close)
  if (!Number.isFinite(closeValue) || closeValue <= 0) return []
  return [{
    timestamp,
    date,
    time,
    open: positive(open, closeValue),
    close: closeValue,
    high: positive(high, closeValue),
    low: positive(low, closeValue),
    volume: finite(volume),
    amount: finite(amount),
    average: positive(average, closeValue),
  }]
}

function tencentPoint(date: string, raw: string): TrendPoint[] {
  const [rawTime, price, volume, amount] = raw.trim().split(/\s+/)
  const close = finite(price)
  if (!date || !rawTime || close <= 0) return []
  const normalizedDate = date.length === 8
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date
  const time = rawTime.length === 4 ? `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}` : rawTime
  const volumeValue = finite(volume)
  const amountValue = finite(amount)
  return [{
    timestamp: `${normalizedDate} ${time}`,
    date: normalizedDate,
    time,
    open: close,
    close,
    high: close,
    low: close,
    volume: volumeValue,
    amount: amountValue,
    average: volumeValue > 0 ? amountValue / (volumeValue * 100) : close,
  }]
}

async function fetchText(url: URL, deadline: number) {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('上游行情请求超时')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw new Error(`上游行情返回 HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt === 1) break
      await new Promise(resolve => setTimeout(resolve, 160))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('上游行情请求失败')
}

function eastmoneyUrls(days: 1 | 5, query: URLSearchParams) {
  const endpoints: string[] = days === 1
    ? [...EASTMONEY_LIVE]
    : EASTMONEY_HISTORY_HOSTS.map(host => {
        const url = new URL(EASTMONEY_HISTORY)
        url.hostname = host
        return url.toString()
      })
  return endpoints.map(endpoint => {
    const url = new URL(endpoint)
    url.search = query.toString()
    return url
  })
}

async function fetchEastmoney(code: string, days: 1 | 5, deadline: number): Promise<TrendSeries> {
  const market = code.startsWith('SH') ? '1' : '0'
  const numberCode = code.slice(2)
  const query = new URLSearchParams({
    secid: `${market}.${numberCode}`,
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
    fields2: EASTMONEY_FIELDS,
    iscr: '0',
    iscca: '0',
    ndays: String(days),
    ut: '7eea3edcaed734bea9cbfc24409ed989',
    _: String(Date.now()),
  })
  let lastError: unknown
  for (const url of eastmoneyUrls(days, query)) {
    try {
      const payload = JSON.parse(await fetchText(url, deadline)) as EastmoneyPayload
      const points = (payload.data?.trends ?? []).flatMap(eastmoneyPoint)
      if (!points.length) throw new Error('东方财富暂无分时数据')
      return {
        code,
        name: payload.data?.name || code,
        preClose: finite(payload.data?.preClose),
        points,
        source: 'eastmoney',
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('东方财富请求失败')
}

function parseTencentPayload(text: string) {
  const separator = text.indexOf('=')
  if (separator < 0) throw new Error('腾讯行情返回格式异常')
  return JSON.parse(text.slice(separator + 1)) as TencentPayload
}

async function fetchTencent(code: string, days: 1 | 5, deadline: number): Promise<TrendSeries> {
  const apiCode = code.toLowerCase()
  const url = new URL(days === 1 ? TENCENT_MINUTE : TENCENT_FIVE_DAY)
  url.search = new URLSearchParams(days === 1
    ? { code: apiCode, r: String(Math.random()) }
    : { _var: `fdays_data_${apiCode}`, code: apiCode, r: String(Math.random()) }).toString()
  const payload = parseTencentPayload(await fetchText(url, deadline))
  const security = payload.data?.[apiCode]
  if (!security) throw new Error('腾讯行情暂无分时数据')
  const data = security.data
  const points = days === 1
    ? (data && !Array.isArray(data) ? (data.data ?? []).flatMap(row => tencentPoint(data.date ?? '', row)) : [])
    : (data && Array.isArray(data)
        ? data.flatMap(day => (day.data ?? []).flatMap(row => tencentPoint(day.date ?? '', row)))
        : []).sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  if (!points.length) throw new Error('腾讯行情暂无分时数据')
  const quote = security.qt?.[apiCode]
  // Tencent has no real average price for indices: its volume/amount cover the
  // whole market, so amount/(volume*100) yields a per-share market average
  // (~17 CNY) instead of the index level. Pinning average to close keeps the
  // chart scale correct; the average line simply overlaps the price line.
  const isIndex = /^(?:SH000|SZ399)\d{3}$/.test(code)
  const normalizedPoints = isIndex
    ? points.map(point => ({ ...point, average: point.close }))
    : points
  return {
    code,
    name: quote?.[1] || code,
    preClose: finite(quote?.[4]),
    points: normalizedPoints,
    source: 'tencent',
  }
}

export class TrendProvider {
  private readonly cache = new TtlCache<TrendSeries>()

  constructor(private readonly timeoutMs: number, private readonly ttlMs: number) {}

  async get(code: string, days: 1 | 5) {
    const key = `${code}:${days}`
    const cached = this.cache.get(key)
    if (cached) return cached
    let result: TrendSeries
    const deadline = Date.now() + this.timeoutMs
    try {
      result = await fetchEastmoney(code, days, deadline)
    } catch (primaryError) {
      try {
        result = await fetchTencent(code, days, deadline)
      } catch {
        throw primaryError
      }
    }
    this.cache.set(key, result, this.ttlMs)
    return result
  }
}
