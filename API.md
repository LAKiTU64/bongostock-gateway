# HTTP API

所有 `/v1/` 请求都需要：

```http
Authorization: Bearer <BONGOSTOCK_TOKEN>
Content-Type: application/json
```

服务不会记录请求正文或 Authorization。证券代码统一使用 `SH`、`SZ`、`HK` 前缀加 6 位数字，或 `US` 加 1～16 位大写字母/数字/`.`/`_`/`-`；分时和 5 日接口只支持 A 股 `SH`/`SZ`。

## 兼容 BongoStock 的接口

### `GET /v1/capabilities`

返回协议和扩展能力：

```json
{
  "protocol": "bongostock-market-v1",
  "quotes": true,
  "search": true,
  "trends": ["intraday", "five-day"],
  "klines": ["day"],
  "news": {
    "enabled": true,
    "provider": "mx-news-search",
    "scopes": ["market", "briefing", "security"],
    "sorts": ["default", "newest", "oldest"],
    "timeRanges": ["1d", "3d", "7d", "all"],
    "depths": ["compact", "standard", "extended"]
  },
  "stockApi": {
    "sources": ["auto", "tencent", "sina", "eastmoney"],
    "methods": ["getStock", "getStocks", "searchStocks", "getKlines", "inspectStock"],
    "periods": ["day", "week", "month"],
    "adjusts": ["none", "qfq", "hfq"]
  }
}
```

未配置 `MX_APIKEY` 时 `news.enabled=false`，其他行情能力不受影响。

### `POST /v1/news/search`

资讯只通过 Gateway 服务端调用东方财富妙想，客户端不直连上游。请求示例：

```json
{
  "scope": "market",
  "preset": "overview",
  "timeRange": "3d",
  "sort": "default",
  "depth": "standard",
  "types": ["news", "announcement", "report", "external"]
}
```

个股资讯增加：

```json
{
  "scope": "security",
  "preset": "latest",
  "security": { "code": "SZ000858", "name": "五粮液" },
  "timeRange": "7d",
  "sort": "newest",
  "depth": "extended"
}
```

也可以传入最长300字符的完整 `query`。服务端负责检索词补全、扩展检索、严格时间过滤、默认/最新/最旧排序、类型过滤、去重和缓存。响应包含 `items`、`outOfRangeItems`、`stats` 和 `meta`。完整约定见 [`docs/NEWS_SEARCH_INTEGRATION.md`](docs/NEWS_SEARCH_INTEGRATION.md)。

### `POST /v1/quotes`

BongoStock 批量报价接口，固定使用自动数据源：

```json
{ "codes": ["SH000001", "SZ399001"] }
```

响应：`{ "quotes": [...] }`。

### `POST /v1/search`

请求：`{ "query": "588170" }`。响应：`{ "candidates": [{ "code": "SH588170", "name": "..." }] }`。

### `POST /v1/trends`

请求：`{ "code": "SH000001", "days": 1 }`，`days` 可为 `1` 或 `5`。响应：`{ "data": { "code", "name", "preClose", "points", "source" } }`。

### `POST /v1/klines`

请求：

```json
{
  "code": "SH000001",
  "period": "day",
  "count": 30,
  "adjust": "none"
}
```

响应：`{ "klines": [...] }`。BongoStock 当前只使用 `period=day`，扩展接口支持 `day`、`week`、`month`。

## stock-api 风格扩展

### `POST /v1/stock`

对应 `stocks.<source>.getStock`：

```json
{ "code": "SH600519", "source": "auto" }
```

响应：`{ "stock": { "code", "name", "percent", "now", "low", "high", "yesterday", "source" } }`。

### `POST /v1/stocks`

对应 `stocks.<source>.getStocks`：

```json
{ "codes": ["SH600519", "SZ000651"], "source": "tencent" }
```

响应：`{ "stocks": [...] }`。

### `POST /v1/inspect`

对应 `stocks.<source>.inspectStock`：

```json
{ "code": "SH600519", "source": "auto" }
```

`source=auto` 会返回自动兜底过程及各数据源状态；指定单一数据源时只检查该源。

### `source`

所有扩展接口的 `source` 默认为 `auto`，可选：

- `auto`：按 `tencent → sina → eastmoney` 兜底；
- `tencent`；
- `sina`；
- `eastmoney`。

服务端缓存键包含数据源、代码、周期、复权方式和数量，避免不同请求互相污染。

## 运维接口

### `GET /healthz`

无鉴权，仅供 Nginx、systemd 或监控探活使用：

```json
{ "ok": true }
```

## 错误状态

| 状态 | 含义 |
| --- | --- |
| 400 | JSON、代码、周期或参数无效 |
| 401 | Bearer Token 缺失或错误 |
| 404 | 路径不存在 |
| 405 | HTTP 方法不支持 |
| 413 | 请求正文超过 64 KiB |
| 429 | 超过每客户端每分钟请求限制 |
| 501 | 资讯服务未配置 |
| 502 | 上游行情源不可用或返回无效数据 |
| 504 | 资讯上游请求超时 |
