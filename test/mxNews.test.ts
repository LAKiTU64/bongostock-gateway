import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNewsQueries, MxNewsProvider } from '../src/providers/mxNews.js'
import type { NewsSearchRequest } from '../src/types.js'

const baseRequest: NewsSearchRequest = {
  scope: 'market',
  preset: 'overview',
  timeRange: '3d',
  sort: 'newest',
  depth: 'extended',
  types: ['news', 'announcement', 'report', 'external'],
}

function upstream(items: unknown[]) {
  return new Response(JSON.stringify({
    status: 0,
    code: 0,
    data: { data: { llmSearchResponse: { data: items } } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('builds two distinct time-aware queries for extended mode', () => {
  const queries = buildNewsQueries(baseRequest, Date.parse('2026-08-09T08:00:00Z'))
  assert.equal(queries.length, 2)
  assert.notEqual(queries[0], queries[1])
  assert.match(queries[0]!, /最近3日/)
})

test('normalizes, deduplicates, filters, sorts and caches news', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls += 1
    if (calls === 1) {
      return upstream([
        { code: 'a', title: '较新新闻', content: '<b>摘要</b>', publishDate: '2026-08-09 12:00:00', informationType: 'NEWS', source: '来源甲', jumpUrl: 'https://example.com/a' },
        { code: 'duplicate', title: '重复新闻', date: '2026-08-08 12:00:00', informationType: 'NOTICE', jumpUrl: 'https://example.com/shared' },
        { code: 'old', title: '超期新闻', date: '2026-08-01 12:00:00', informationType: 'NEWS' },
      ])
    }
    return upstream([
      { code: 'duplicate-2', title: '重复新闻副本', date: '2026-08-08 12:00:00', informationType: 'NOTICE', jumpUrl: 'https://example.com/shared' },
      { code: 'b', title: '最新研报', date: '2026-08-09 15:00:00', informationType: 'REPORT', insName: '机构乙' },
    ])
  }
  const provider = new MxNewsProvider('test-key', 1_000, 300_000, fetcher, () => Date.parse('2026-08-09T16:00:00+08:00'))
  const first = await provider.search(baseRequest)
  assert.deepEqual(first.items.map(item => item.title), ['最新研报', '较新新闻', '重复新闻副本'])
  assert.equal(first.stats.upstreamCount, 5)
  assert.equal(first.stats.duplicateCount, 1)
  assert.equal(first.stats.outOfRangeCount, 1)
  assert.equal(first.outOfRangeItems[0]?.title, '超期新闻')
  assert.equal(first.items[1]?.summary, '摘要')
  assert.equal(first.meta.cached, false)

  const second = await provider.search(baseRequest)
  assert.equal(calls, 2)
  assert.equal(second.meta.cached, true)
})

test('deduplicates normalized titles even when URLs and upstream codes differ', async () => {
  const request: NewsSearchRequest = {
    ...baseRequest,
    depth: 'compact',
    timeRange: 'all',
  }
  const fetcher: typeof fetch = async () => upstream([
    { code: 'first', title: 'Same headline', date: '2026-08-09 12:00:00', jumpUrl: 'https://example.com/first' },
    { code: 'second', title: ' Same headline!!! ', date: '2026-08-09 12:01:00', jumpUrl: 'https://other.example/second' },
    { code: 'third', title: 'Different headline', date: '2026-08-09 12:02:00', jumpUrl: 'https://example.com/third' },
  ])
  const provider = new MxNewsProvider('test-key', 1_000, 0, fetcher, () => Date.parse('2026-08-09T16:00:00+08:00'))
  const result = await provider.search(request)

  assert.deepEqual(result.items.map(item => item.title), ['Different headline', 'Same headline'])
  assert.equal(result.stats.duplicateCount, 1)
})
