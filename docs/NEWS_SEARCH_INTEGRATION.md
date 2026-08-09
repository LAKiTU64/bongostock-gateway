# 妙想资讯服务端集成设计

## 1. 目标

为 BongoStock 资讯中心提供唯一的服务端资讯能力。所有新闻检索都由 `bongostock-gateway` 转发到东方财富妙想 `news-search`，客户端只负责提交检索条件和显示服务端结果。

```text
BongoStock 客户端
  └─ HTTPS + Bearer Token
      └─ bongostock-gateway
          └─ HTTPS + MX_APIKEY
              └─ mkapi2.dfcfs.com/finskillshub/api/claw/news-search
```

## 2. 强制边界

- 不在客户端内置妙想 Skill、API 地址或 API Key。
- 不提供客户端直连妙想的模式。
- 不提供本地资讯源或本地资讯回退。
- 不因行情选择“内置行情”而禁用资讯；资讯始终独立使用 Gateway。
- Gateway 未配置资讯能力或不可用时，客户端只显示“资讯服务不可用”。
- 检索词生成、扩展检索、时间过滤、排序、类型过滤、去重和缓存均由 Gateway 执行。
- 客户端可以保存 UI 偏好、已读、收藏和隐藏状态，但不承担资讯数据处理能力。

## 3. 上游接口边界

妙想公开 Skill 当前只发送：

```json
{
  "query": "检索词"
}
```

上游没有公开且有效的精确时间、返回数量和排序参数。Gateway 必须根据 `publishDate`，缺失时使用 `date`，完成严格时间过滤和时间排序。

上游基础请求数量通常约为12条，但实际可能少于或多于12条。扩展模式通过两条语义互补、但不相同的查询合并结果；重复调用相同查询没有意义。

## 4. 服务端配置

在 `/etc/bongostock-gateway.env` 增加：

```dotenv
# 必需；缺失时关闭资讯能力
MX_APIKEY=replace-with-a-new-key

# 可选
BONGOSTOCK_NEWS_TIMEOUT_MS=15000
BONGOSTOCK_NEWS_CACHE_MS=300000
```

要求：

- 环境文件权限为 `600`。
- 真实 Key 不得写入仓库、客户端、日志或接口响应。
- 服务器需要能够通过 HTTPS 访问 `mkapi2.dfcfs.com:443`。
- 不新增公网入站端口，继续使用 Nginx 443 反代到 `127.0.0.1:8787`。
- 服务端代码部署并完成首次冒烟测试后，立即提醒用户重置测试期间使用过的 Key；替换环境文件中的 Key、重启服务并再次验证。

`MX_APIKEY` 缺失时 Gateway 仍可提供所有行情接口，只在能力声明中关闭资讯。

## 5. 能力声明

`GET /v1/capabilities` 增加：

```json
{
  "protocol": "bongostock-market-v1",
  "news": {
    "enabled": true,
    "provider": "mx-news-search",
    "scopes": ["market", "briefing", "security"],
    "sorts": ["default", "newest", "oldest"],
    "timeRanges": ["1d", "3d", "7d", "all"],
    "depths": ["compact", "standard", "extended"]
  }
}
```

未配置 `MX_APIKEY` 时返回：

```json
{
  "news": {
    "enabled": false
  }
}
```

## 6. 客户端接口

### `POST /v1/news/search`

请求示例：

```json
{
  "scope": "market",
  "preset": "overview",
  "query": "A股重要市场新闻和宏观政策",
  "secondaryQuery": "A股行业动态、公司新闻和重要公告",
  "timeRange": "3d",
  "sort": "default",
  "depth": "extended",
  "types": ["news", "announcement", "report", "external"]
}
```

规则：

- `scope`：`market`、`briefing` 或 `security`。
- `query`：必需，去除首尾空格后长度限制为 2～300 字符。
- `secondaryQuery`：只允许扩展模式使用，长度同上；不得与主查询相同。
- `timeRange`：`1d`、`3d`、`7d` 或 `all`。
- `sort`：`default`、`newest` 或 `oldest`。
- `depth`：`compact`、`standard` 或 `extended`。
- `types`：可选的资讯类型过滤。
- 服务端拒绝未知字段值、空查询和超长请求。

结果上限：

- `compact`：一次上游调用，最多5条。
- `standard`：一次上游调用，最多10条。
- `extended`：最多两次不同的上游调用，合并去重后最多20条。

响应示例：

```json
{
  "items": [
    {
      "id": "stable-local-id",
      "title": "新闻标题",
      "summary": "简短摘要",
      "publishedAt": "2026-08-09T07:36:00.000Z",
      "source": "财联社",
      "type": "news",
      "url": "https://example.com/article"
    }
  ],
  "stats": {
    "upstreamCount": 15,
    "duplicateCount": 2,
    "outOfRangeCount": 3,
    "filteredTypeCount": 0,
    "returnedCount": 10
  },
  "meta": {
    "provider": "mx-news-search",
    "sort": "default",
    "timeRange": "3d",
    "depth": "standard",
    "retrievedAt": "2026-08-09T08:00:00.000Z",
    "cached": false
  },
  "outOfRangeItems": []
}
```

服务端可以返回 `outOfRangeItems`，供客户端点击“查看超期结果”；这部分同样经过规范化和去重。

## 7. 排序和合并

### 默认

- 单次查询保持妙想原始次序。
- 扩展查询采用 A1、B1、A2、B2……交替合并。
- 合并过程中按稳定 ID、原文链接和标准化标题去重。

### 最新

按有效发布时间倒序。时间缺失的结果排在有时间结果之后，并保持其原始相对顺序。

### 最旧

按有效发布时间正序。时间缺失的结果排在有时间结果之后，并保持其原始相对顺序。

不实现自定义综合分数，不依赖上游不稳定的 `rankScore`。

## 8. 缓存和额度

- 默认缓存5分钟。
- 缓存键包含规范化后的主查询、副查询、时间范围、排序、结果档位和类型过滤。
- 同一请求命中缓存时不消耗妙想额度。
- 扩展模式最多消耗两次 `news-search` 额度。
- 两条查询相同或第一批结果已经满足服务端策略时，不执行第二次调用。
- 不在日志中输出检索词或新闻正文。

## 9. 错误处理

| HTTP 状态 | 含义 |
|---|---|
| 400 | 查询、范围、排序或档位无效 |
| 401 | BongoStock Bearer Token 无效 |
| 404 | 路由不存在 |
| 429 | Gateway 限流或妙想额度耗尽 |
| 501 | Gateway 未配置 `MX_APIKEY` |
| 502 | 妙想返回失败或无效数据 |
| 504 | 妙想请求超时 |

上游错误不得把 API Key、内部堆栈或完整上游响应透传给客户端。

## 10. 实施计划

### Phase G0：冻结服务端协议

1. 固定 `/v1/news/search` 请求、响应和错误码。
2. 固定 capabilities 资讯能力结构。
3. 明确客户端无本地资讯 Provider、无直连和无回退。

### Phase G1：实现核心能力

1. 扩展配置类型，读取新闻 Key、超时和缓存时间。
2. 增加妙想 Provider、请求取消、错误转换和响应规范化。
3. 增加新闻请求校验、类型定义和稳定 ID。
4. 实现检索词生成、扩展查询、交替合并和去重。
5. 实现严格时间过滤、默认/最新/最旧排序和类型过滤。
6. 增加独立的5分钟新闻缓存。
7. 增加 `/v1/news/search` 和 capabilities 声明。

### Phase G2：测试、文档和推送

1. 覆盖无 Key、Key 失效、超时、额度耗尽、重复、缺失时间和扩展检索测试。
2. 使用测试 Key 做少量真实接口冒烟测试。
3. 更新 `.env.example`、`API.md`、README 和服务器部署文档。
4. 运行 TypeScript、测试、构建和差异检查。
5. 提交并推送 Gateway 仓库。

### Phase G3：服务器部署和 Key 轮换

1. 服务器拉取最新提交、安装依赖并构建。
2. 更新 `/etc/bongostock-gateway.env`，保持权限 `600`。
3. 重启 systemd，检查健康状态、capabilities 和真实新闻请求。
4. 检查 Nginx、systemd、资源占用和日志脱敏。
5. 首次冒烟测试后提醒用户重置妙想 API Key。
6. 填入新 Key、重启并复测，确认客户端无需改动。

Gateway 的 G0～G3 全部完成后，客户端才开始接入资讯 UI。

## 11. 验收标准

- 客户端不存在任何妙想 Key、直连地址或本地资讯 Provider。
- 所有资讯请求只到达 BongoStock Gateway。
- Gateway 未配置资讯时，行情接口不受影响。
- 时间过滤、默认/最新/最旧排序和结果档位完全由服务端完成。
- 扩展模式不会重复调用相同检索词。
- Gateway 和 Nginx 日志不包含 Token、API Key、检索词或新闻正文。
- 服务重启后配置仍有效，缓存失效不会影响正确性。
