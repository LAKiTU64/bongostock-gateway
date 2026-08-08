export interface GatewayConfig {
  host: string
  port: number
  token: string
  requestTimeoutMs: number
  trustProxy: boolean
  maxBodyBytes: number
  maxCodes: number
  rateLimitPerMinute: number
  quoteCacheMs: number
  trendCacheMs: number
  klineCacheMs: number
  searchCacheMs: number
}

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const token = env.BONGOSTOCK_TOKEN?.trim() ?? ''

  if (token.length < 16) {
    throw new Error('BONGOSTOCK_TOKEN must contain at least 16 characters')
  }

  return {
    host: env.BONGOSTOCK_HOST?.trim() || '127.0.0.1',
    port: integer(env.BONGOSTOCK_PORT, 8787, 1, 65_535),
    token,
    requestTimeoutMs: integer(env.BONGOSTOCK_REQUEST_TIMEOUT_MS, 8_000, 1_000, 30_000),
    trustProxy: env.BONGOSTOCK_TRUST_PROXY === 'true',
    maxBodyBytes: 64 * 1024,
    maxCodes: 50,
    rateLimitPerMinute: integer(env.BONGOSTOCK_RATE_LIMIT_PER_MINUTE, 120, 10, 10_000),
    quoteCacheMs: 5_000,
    trendCacheMs: 30_000,
    klineCacheMs: 5 * 60_000,
    searchCacheMs: 60 * 60_000,
  }
}
