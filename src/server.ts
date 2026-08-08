import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'

import type { GatewayConfig } from './config.js'
import type { MarketProvider } from './types.js'
import {
  clientAddress,
  parseCodes,
  parseCount,
  parseDays,
  parseAdjust,
  parseObject,
  parsePeriod,
  parseSearchQuery,
  parseSource,
  normalizeAshareCode,
  normalizeMarketCode,
  RequestValidationError,
} from './validation.js'

interface RateWindow { startedAt: number, count: number }

function json(response: ServerResponse, statusCode: number, value: unknown) {
  const body = JSON.stringify(value)
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(body)
}

function bearerMatches(request: IncomingMessage, expected: string) {
  const header = request.headers.authorization ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const actual = Buffer.from(header.slice(prefix.length))
  const target = Buffer.from(expected)
  return actual.length === target.length && timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(target).digest())
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw Object.assign(new Error('请求正文过大'), { statusCode: 413 })
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestValidationError('请求正文不是有效 JSON')
  }
}

async function withinTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('行情服务请求超时')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requestError(error: unknown) {
  if (error instanceof RequestValidationError) return { statusCode: error.statusCode, message: error.message }
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') {
    return { statusCode: error.statusCode, message: error instanceof Error ? error.message : '请求失败' }
  }
  return { statusCode: 502, message: '行情上游暂时不可用' }
}

export function createGatewayServer(config: GatewayConfig, provider: MarketProvider): Server {
  const rateWindows = new Map<string, RateWindow>()

  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    const finish = () => {
      // Deliberately log only method/path/status. Never log bodies, query values or Authorization.
      process.stdout.write(`${new Date().toISOString()} ${method} ${path} ${response.statusCode} ${Date.now() - startedAt}ms\n`)
    }
    response.once('finish', finish)

    try {
      if (path === '/healthz' && method === 'GET') {
        json(response, 200, { ok: true })
        return
      }

      if (!path.startsWith('/v1/')) {
        json(response, 404, { error: 'not_found' })
        return
      }

      if (!bearerMatches(request, config.token)) {
        json(response, 401, { error: 'unauthorized' })
        return
      }

      const address = clientAddress(request, config.trustProxy)
      const now = Date.now()
      const window = rateWindows.get(address)
      if (!window || now - window.startedAt >= 60_000) {
        rateWindows.set(address, { startedAt: now, count: 1 })
      } else {
        window.count += 1
        if (window.count > config.rateLimitPerMinute) {
          json(response, 429, { error: 'rate_limited' })
          return
        }
      }

      if (path === '/v1/capabilities' && method === 'GET') {
        json(response, 200, {
          protocol: 'bongostock-market-v1',
          quotes: true,
          search: true,
          trends: ['intraday', 'five-day'],
          klines: ['day'],
          stockApi: {
            sources: ['auto', 'tencent', 'sina', 'eastmoney'],
            methods: ['getStock', 'getStocks', 'searchStocks', 'getKlines', 'inspectStock'],
            periods: ['day', 'week', 'month'],
            adjusts: ['none', 'qfq', 'hfq'],
          },
        })
        return
      }

      if (method !== 'POST') {
        json(response, 405, { error: 'method_not_allowed' })
        return
      }

      const body = parseObject(await readJson(request, config.maxBodyBytes))

      if (path === '/v1/quotes') {
        const rows = await withinTimeout(provider.getStocks(parseCodes(body.codes, config.maxCodes), 'auto'), config.requestTimeoutMs)
        json(response, 200, { quotes: rows })
        return
      }

      if (path === '/v1/stock') {
        const row = await withinTimeout(provider.getStock(normalizeMarketCode(body.code), parseSource(body.source)), config.requestTimeoutMs)
        json(response, 200, { stock: row })
        return
      }

      if (path === '/v1/stocks') {
        const rows = await withinTimeout(provider.getStocks(parseCodes(body.codes, config.maxCodes), parseSource(body.source)), config.requestTimeoutMs)
        json(response, 200, { stocks: rows })
        return
      }

      if (path === '/v1/search') {
        const rows = await withinTimeout(provider.search(parseSearchQuery(body.query), parseSource(body.source)), config.requestTimeoutMs)
        json(response, 200, { candidates: rows })
        return
      }

      if (path === '/v1/trends') {
        const code = normalizeAshareCode(body.code)
        const days = parseDays(body.days)
        const row = await withinTimeout(provider.getTrends(code, days), config.requestTimeoutMs)
        json(response, 200, { data: row })
        return
      }

      if (path === '/v1/klines') {
        const code = normalizeMarketCode(body.code)
        const period = parsePeriod(body.period)
        const adjust = parseAdjust(body.adjust)
        const rows = await withinTimeout(provider.getKlines(code, parseCount(body.count), period, adjust, parseSource(body.source)), config.requestTimeoutMs)
        json(response, 200, { klines: rows })
        return
      }

      if (path === '/v1/inspect') {
        const row = await withinTimeout(provider.inspect(normalizeMarketCode(body.code), parseSource(body.source)), config.requestTimeoutMs)
        json(response, 200, row)
        return
      }

      json(response, 404, { error: 'not_found' })
    } catch (error) {
      const detail = requestError(error)
      json(response, detail.statusCode, { error: detail.message })
    }
  })

  server.requestTimeout = config.requestTimeoutMs + 2_000
  server.headersTimeout = config.requestTimeoutMs + 5_000
  return server
}
