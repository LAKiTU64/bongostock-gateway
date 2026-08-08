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
  "stockApi": {
    "sources": ["auto", "tencent", "sina", "eastmoney"],
    "methods": ["getStock", "getStocks", "searchStocks", "getKlines", "inspectStock"],
    "periods": ["day", "week", "month"],
    "adjusts": ["none", "qfq", "hfq"]
  }
}
```

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
| 502 | 上游行情源不可用或返回无效数据 |
