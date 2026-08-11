import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import type { GatewayConfig } from '../src/config.js'
import { createGatewayServer } from '../src/server.js'
import type { KlineAdjust, KlinePeriod, MarketProvider, NewsProvider, ProviderSource } from '../src/types.js'

const config: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  token: 'test-token-that-is-long-enough',
  requestTimeoutMs: 2_000,
  trustProxy: false,
  maxBodyBytes: 64 * 1024,
  maxCodes: 300,
  rateLimitPerMinute: 20,
  quoteCacheMs: 5_000,
  trendCacheMs: 30_000,
  klineCacheMs: 300_000,
  searchCacheMs: 3_600_000,
  mxApiKey: '',
  newsTimeoutMs: 15_000,
  newsCacheMs: 300_000,
}

const provider: MarketProvider = {
  async getQuotes(codes) {
    return codes.map(code => ({ code, name: code === 'SH000001' ? '上证指数' : '测试证券', now: 100, low: 99, high: 101, percent: 0.01, yesterday: 99.99 }))
  },
  async getStock(code) {
    return (await this.getQuotes([code]))[0]!
  },
  async getStocks(codes) {
    return this.getQuotes(codes)
  },
  async search(_query, _source: ProviderSource) {
    return [{ code: 'SH588170', name: '测试基金' }]
  },
  async inspect(code) {
    return { code, source: 'tencent', status: 'success' }
  },
  async getTrends(code, days) {
    return { code, name: '测试证券', preClose: 99, source: 'eastmoney', points: [{ timestamp: '2026-01-01 09:30', date: '2026-01-01', time: '09:30', open: 100, close: 100, high: 100, low: 100, volume: 1, amount: 100, average: 100 }].slice(0, days) }
  },
  async getKlines(_code, _count, _period: KlinePeriod, _adjust: KlineAdjust, _source: ProviderSource) {
    return [{ date: '2026-01-01', open: 99, close: 100, high: 101, low: 98, volume: 1000 }]
  },
}

async function withServer(run: (baseUrl: string) => Promise<void>, newsProvider?: NewsProvider) {
  const server = createGatewayServer(config, provider, newsProvider)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

function auth() {
  return { Authorization: `Bearer ${config.token}` }
}

test('requires bearer authentication', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/v1/capabilities`)
    assert.equal(response.status, 401)
  })
})

test('serves capabilities and validated quotes', async () => {
  await withServer(async baseUrl => {
    const capabilities = await fetch(`${baseUrl}/v1/capabilities`, { headers: auth() })
    assert.equal(capabilities.status, 200)
    const body = await capabilities.json() as { klines: string[], news: { enabled: boolean } }
    assert.deepEqual(body.klines, ['day'])
    assert.equal(body.news.enabled, false)

    const quotes = await fetch(`${baseUrl}/v1/quotes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: ['SH000001'] }),
    })
    assert.equal(quotes.status, 200)
    assert.equal((await quotes.json() as { quotes: Array<{ name: string }> }).quotes[0]?.name, '上证指数')
  })
})

test('serves server-only normalized news and rejects it when unconfigured', async () => {
  await withServer(async baseUrl => {
    const unavailable = await fetch(`${baseUrl}/v1/news/search`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'market' }),
    })
    assert.equal(unavailable.status, 501)
  })

  const newsProvider: NewsProvider = {
    enabled: true,
    async search(request) {
      assert.equal(request.sort, 'newest')
      assert.equal(request.timeRange, '3d')
      return {
        items: [{ id: 'one', title: '测试资讯', summary: '', publishedAt: '2026-08-09T00:00:00.000Z', source: '测试源', type: 'news' }],
        outOfRangeItems: [],
        stats: { upstreamCount: 1, duplicateCount: 0, outOfRangeCount: 0, filteredTypeCount: 0, returnedCount: 1 },
        meta: { provider: 'mx-news-search', sort: request.sort, timeRange: request.timeRange, depth: request.depth, retrievedAt: '2026-08-09T00:00:00.000Z', cached: false },
      }
    },
  }

  await withServer(async baseUrl => {
    const capabilities = await fetch(`${baseUrl}/v1/capabilities`, { headers: auth() })
    assert.equal((await capabilities.json() as { news: { enabled: boolean } }).news.enabled, true)

    const response = await fetch(`${baseUrl}/v1/news/search`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'market', preset: 'overview', timeRange: '3d', sort: 'newest', depth: 'standard' }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { items: Array<{ title: string }> }).items[0]?.title, '测试资讯')
  }, newsProvider)
})

test('rejects malformed codes and unknown methods', async () => {
  await withServer(async baseUrl => {
    const malformed = await fetch(`${baseUrl}/v1/quotes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: ['600000'] }),
    })
    assert.equal(malformed.status, 400)

    const method = await fetch(`${baseUrl}/v1/quotes`, { headers: auth() })
    assert.equal(method.status, 405)
  })
})

test('exposes stock-api style extensions without changing the BongoStock route', async () => {
  await withServer(async baseUrl => {
    const stock = await fetch(`${baseUrl}/v1/stock`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SH000001', source: 'auto' }),
    })
    assert.equal(stock.status, 200)
    assert.equal((await stock.json() as { stock: { code: string } }).stock.code, 'SH000001')

    const klines = await fetch(`${baseUrl}/v1/klines`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SH000001', period: 'week', count: 30, adjust: 'none', source: 'tencent' }),
    })
    assert.equal(klines.status, 200)
    assert.equal((await klines.json() as { klines: unknown[] }).klines.length, 1)

    const inspection = await fetch(`${baseUrl}/v1/inspect`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SH000001' }),
    })
    assert.equal(inspection.status, 200)
    assert.equal((await inspection.json() as { status: string }).status, 'success')
  })
})
