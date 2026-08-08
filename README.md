# bongostock-gateway

一个供 BongoStock 使用的轻量行情网关。它不保存账号、不做交易，也不把 Token 写入 Git。服务端内部调用 `stock-api@2.7.3`，并为分时和 5 日补充东方财富→腾讯备用数据源。

## 当前接口

实现 BongoStock 外接行情协议 v1，并额外提供接近 `stock-api` Node API 的服务端接口：

- `GET /healthz`：无鉴权健康检查；
- `GET /v1/capabilities`；
- `POST /v1/quotes`；
- `POST /v1/search`；
- `POST /v1/trends`；
- `POST /v1/klines`。

扩展接口：

- `POST /v1/stock`：单只报价；
- `POST /v1/stocks`：批量报价；
- `POST /v1/inspect`：单只诊断；
- `source` 可选 `auto`、`tencent`、`sina`、`eastmoney`；
- K 线支持 `day`、`week`、`month` 及 `none`、`qfq`、`hfq` 复权参数。

`/v1/quotes`、`/v1/search`、`/v1/klines` 和 `/v1/trends` 保持 BongoStock 客户端现有调用方式不变。客户端是否使用扩展接口由客户端自行决定。

`/v1/` 请求需要 `Authorization: Bearer <token>`。证券代码位于 POST JSON 正文中；服务日志只记录方法、路径、状态码和耗时，不记录正文或 Token。

协议字段和示例见 [BongoStock 外接行情协议](https://github.com/LAKiTU64/bongostock/blob/main/docs/EXTERNAL_MARKET_API_V1.md)。
完整 HTTP 路由、扩展参数和错误状态见 [API.md](API.md)。

## 本地开发

需要 Node.js 18 或更高版本。项目不依赖数据库或原生编译扩展：

```bash
pnpm install
copy .env.example .env   # PowerShell；macOS/Linux 使用 cp
# 在 .env 中设置至少 16 位的 BONGOSTOCK_TOKEN
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

本地测试：

```bash
curl http://127.0.0.1:8787/healthz
curl -H "Authorization: Bearer $BONGOSTOCK_TOKEN" http://127.0.0.1:8787/v1/capabilities
```

扩展接口示例：

```bash
curl -X POST http://127.0.0.1:8787/v1/stocks \
  -H "Authorization: Bearer $BONGOSTOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"codes":["SH000001","SZ399001"],"source":"auto"}'

curl -X POST http://127.0.0.1:8787/v1/klines \
  -H "Authorization: Bearer $BONGOSTOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"SH000001","period":"week","count":30,"adjust":"none","source":"tencent"}'
```

## 生产部署概览

推荐 Ubuntu 24.04、systemd、Nginx 和 HTTPS：

从空服务器安装、首次签发 IP HTTPS 证书、自动续期、更新和 Token 轮换的完整步骤见 [`docs/SERVER_DEPLOYMENT.md`](docs/SERVER_DEPLOYMENT.md)。

1. 代码放在 `/opt/bongostock-gateway`；
2. 由管理员安装依赖和构建；
3. 运行用户使用无登录权限的 `bongostock`；
4. Node 只监听 `127.0.0.1:8787`；
5. Nginx 对外提供 443 并反代到 Node；
6. Token 放在 `/etc/bongostock-gateway.env`，权限设为 `600`；
7. 阿里云防火墙只需开放 80/443，8787 不对公网开放。

模板：

- `deploy/bongostock-gateway.service`
- `deploy/nginx.conf`

## 限制与隐私

- 报价最多 50 个代码；
- 请求正文最大 64 KiB；
- 默认每个客户端每分钟最多 120 个请求；
- 报价缓存约 5 秒，趋势缓存约 30 秒，日 K 缓存约 5 分钟；
- HTTP 会暴露请求正文，跨设备部署应使用 HTTPS；
- HTTPS 可以保护传输内容，但服务器和上游行情源仍能看到请求的证券代码；
- 上游行情接口的准确性、稳定性和使用许可由使用者自行确认；
- 不要提交真实 `.env`、证书、私钥、日志、服务器地址或本地皮肤包。

## 许可证

本项目代码使用 MIT License。`stock-api` 及上游行情数据源保留各自的许可证和使用条款，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 部署文档

- 完整服务端部署：[`docs/SERVER_DEPLOYMENT.md`](docs/SERVER_DEPLOYMENT.md)
- HTTP API：[`API.md`](API.md)
- 客户端外接协议：[`bongostock/docs/EXTERNAL_MARKET_API_V1.md`](https://github.com/LAKiTU64/bongostock/blob/main/docs/EXTERNAL_MARKET_API_V1.md)
