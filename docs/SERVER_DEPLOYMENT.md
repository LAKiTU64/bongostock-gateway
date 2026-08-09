# BongoStock Gateway 服务端部署

本文给出一套从空白 Ubuntu 24.04 服务器部署 `bongostock-gateway` 的完整流程。目标结构为：Nginx 对公网提供 HTTP/HTTPS，Node.js 仅监听 `127.0.0.1:8787`，systemd 使用无登录权限的 `bongostock` 用户运行服务。

文中的 `<PUBLIC_IP_OR_DOMAIN>`、`<PUBLIC_IP>` 和 Token 都是占位符。不要把真实 Token、证书私钥、服务器地址或 `/etc/bongostock-gateway.env` 提交到 Git。

## 1. 架构和端口

```text
BongoStock 客户端
        │ HTTPS 443
        ▼
      Nginx ───── HTTP 80（ACME 验证和跳转）
        │ HTTP 127.0.0.1:8787
        ▼
bongostock-gateway ───── 上游公开行情源 / 可选妙想资讯
```

云防火墙只开放：

- TCP 22：SSH，建议限制为自己的公网出口 IP；
- TCP 80：Let's Encrypt HTTP-01 验证和 HTTPS 跳转；
- TCP 443：客户端 API。

不要向公网开放 8787。

## 2. 前置条件

以下命令默认通过具有 `sudo` 权限的管理账号执行。推荐 Ubuntu 24.04、Git、Nginx、Python venv、OpenSSL、Node.js 22 LTS 和 pnpm；项目最低支持 Node.js 18。

```bash
sudo apt update
sudo apt install -y git nginx ca-certificates curl openssl python3 python3-venv
node --version
```

如果 Node.js 低于 18，先通过可信的软件源安装 Node.js 22 LTS，再继续。启用 pnpm：

```bash
sudo corepack enable
pnpm --version
```

## 3. 创建低权限运行用户

管理员负责安装、更新和构建；应用进程不需要 root 权限：

```bash
sudo useradd --system --home /var/lib/bongostock-gateway --create-home --shell /usr/sbin/nologin bongostock
sudo install -d -o bongostock -g bongostock -m 750 /var/lib/bongostock-gateway
```

`bongostock` 不能交互登录，也不能修改系统、Nginx 或证书。即使 Node 进程出现漏洞，影响面也比直接以 root 运行小。

## 4. 克隆、测试并构建

```bash
sudo git clone https://github.com/LAKiTU64/bongostock-gateway.git /opt/bongostock-gateway
cd /opt/bongostock-gateway
sudo corepack pnpm install --frozen-lockfile
sudo corepack pnpm typecheck
sudo corepack pnpm test
sudo corepack pnpm build
sudo chown -R root:root /opt/bongostock-gateway
sudo chmod -R a+rX /opt/bongostock-gateway
```

代码由 root 所有，运行用户只读。这样服务不能自行覆盖可执行代码。

## 5. 创建 Token 和环境文件

生成随机 Token，并创建只有 root 可读的 systemd 环境文件：

```bash
TOKEN_VALUE="$(openssl rand -hex 32)"
sudo install -m 600 -o root -g root /dev/null /etc/bongostock-gateway.env
sudo sh -c "cat > /etc/bongostock-gateway.env" <<EOF
BONGOSTOCK_TOKEN=${TOKEN_VALUE}
BONGOSTOCK_HOST=127.0.0.1
BONGOSTOCK_PORT=8787
BONGOSTOCK_REQUEST_TIMEOUT_MS=8000
BONGOSTOCK_TRUST_PROXY=true
BONGOSTOCK_RATE_LIMIT_PER_MINUTE=120
MX_APIKEY=
BONGOSTOCK_NEWS_TIMEOUT_MS=15000
BONGOSTOCK_NEWS_CACHE_MS=300000
EOF
unset TOKEN_VALUE
```

查看当前 Token：

```bash
sudo sed -n 's/^BONGOSTOCK_TOKEN=//p' /etc/bongostock-gateway.env
```

不要把这条命令的输出发到聊天、Issue、日志或截图中。

不使用资讯中心时保持 `MX_APIKEY` 为空。需要资讯时，把妙想页面生成的 Key 填在等号后；服务端代码部署并完成首次冒烟测试后应立即重置测试 Key，再替换此值并重启服务。客户端不保存妙想 Key，也不需要因 Key 轮换而修改代码。

## 6. 安装并启动 systemd 服务

```bash
sudo install -m 644 deploy/bongostock-gateway.service /etc/systemd/system/bongostock-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now bongostock-gateway
sudo systemctl status bongostock-gateway --no-pager
```

本机验证：

```bash
curl --fail http://127.0.0.1:8787/healthz
TOKEN_VALUE="$(sudo sed -n 's/^BONGOSTOCK_TOKEN=//p' /etc/bongostock-gateway.env)"
curl --fail -H "Authorization: Bearer ${TOKEN_VALUE}" http://127.0.0.1:8787/v1/capabilities
unset TOKEN_VALUE
```

配置资讯后，`capabilities.news.enabled` 应为 `true`。真实检索验证示例：

```bash
TOKEN_VALUE="$(sudo sed -n 's/^BONGOSTOCK_TOKEN=//p' /etc/bongostock-gateway.env)"
curl --fail -X POST http://127.0.0.1:8787/v1/news/search \
  -H "Authorization: Bearer ${TOKEN_VALUE}" \
  -H "Content-Type: application/json" \
  -d '{"scope":"market","preset":"overview","timeRange":"1d","sort":"default","depth":"compact"}'
unset TOKEN_VALUE
```

确认只监听回环地址：

```bash
sudo ss -ltnp | grep 8787
```

结果应包含 `127.0.0.1:8787`，不应出现 `0.0.0.0:8787`。

## 7. 配置 Nginx 和 HTTPS

### 7.1 有域名

先把域名 A 记录指向服务器公网 IP。安装 Certbot 后，用标准 HTTP-01 流程签发证书，再将 `deploy/nginx.conf` 中的 `api.example.com` 全部替换为域名。

### 7.2 只有固定公网 IPv4

Let's Encrypt 的 IP 证书使用 `shortlived` profile，有效期约 160 小时，因此必须配置自动续期。以下流程要求 Certbot 5.4 或更高版本：

```bash
sudo python3 -m venv /opt/certbot
sudo /opt/certbot/bin/pip install --upgrade pip certbot
/opt/certbot/bin/certbot --version
sudo install -d -o www-data -g www-data -m 755 /var/www/certbot
```

先创建仅 HTTP 的临时站点，以便完成首次验证。把 `<PUBLIC_IP>` 替换为服务器公网 IPv4：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name <PUBLIC_IP>;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
        try_files $uri =404;
    }

    location / {
        return 404;
    }
}
```

保存为 `/etc/nginx/sites-available/bongostock-gateway`，然后：

```bash
sudo ln -sfn /etc/nginx/sites-available/bongostock-gateway /etc/nginx/sites-enabled/bongostock-gateway
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

申请 IP 证书：

```bash
PUBLIC_IP="<PUBLIC_IP>"
sudo /opt/certbot/bin/certbot certonly \
  --preferred-profile shortlived \
  --ip-address "$PUBLIC_IP" \
  --webroot --webroot-path /var/www/certbot \
  --cert-name "$PUBLIC_IP"
```

随后将 `deploy/nginx.conf` 复制到 `/etc/nginx/sites-available/bongostock-gateway`，把其中所有 `api.example.com` 替换为公网 IP，再检查和重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail "https://${PUBLIC_IP}/healthz"
```

## 8. 配置证书自动续期

仓库已提供续期 service、timer 和成功续期后的 Nginx reload hook：

```bash
sudo install -m 755 deploy/bongostock-certbot-deploy.sh /usr/local/sbin/bongostock-certbot-deploy
sudo install -m 644 deploy/bongostock-certbot-renew.service /etc/systemd/system/bongostock-certbot-renew.service
sudo install -m 644 deploy/bongostock-certbot-renew.timer /etc/systemd/system/bongostock-certbot-renew.timer
sudo systemctl daemon-reload
sudo systemctl enable --now bongostock-certbot-renew.timer
sudo systemctl list-timers bongostock-certbot-renew.timer --all
```

手动演练续期流程：

```bash
sudo systemctl start bongostock-certbot-renew.service
sudo systemctl status bongostock-certbot-renew.service --no-pager
sudo journalctl -u bongostock-certbot-renew.service -n 50 --no-pager
```

timer 每天检查四次；只有证书真正续期成功时，deploy hook 才 reload Nginx。证书更新不会改变客户端 URL、Token 或代码。

## 9. 客户端接入

在 BongoStock 的“偏好设置 → 行情”中选择“外接行情服务”：

```text
服务地址：https://<PUBLIC_IP_OR_DOMAIN>
Bearer Token：/etc/bongostock-gateway.env 中的 BONGOSTOCK_TOKEN
超时：8000 ms
```

“测试连接”只访问 `/v1/capabilities`。成功后 Token 会保存在客户端本机应用数据中，重启无需重新输入。

## 10. 日常更新

先在仓库完成测试和推送，再在服务器执行：

```bash
cd /opt/bongostock-gateway
sudo git fetch origin
sudo git pull --ff-only origin main
sudo corepack pnpm install --frozen-lockfile
sudo corepack pnpm typecheck
sudo corepack pnpm test
sudo corepack pnpm build
sudo chown -R root:root /opt/bongostock-gateway
sudo chmod -R a+rX /opt/bongostock-gateway
sudo systemctl restart bongostock-gateway
sudo systemctl status bongostock-gateway --no-pager
curl --fail http://127.0.0.1:8787/healthz
```

更新不应覆盖 `/etc/bongostock-gateway.env`、Nginx 站点或证书目录。

## 11. Token 轮换

```bash
NEW_TOKEN="$(openssl rand -hex 32)"
sudo sed -i "s/^BONGOSTOCK_TOKEN=.*/BONGOSTOCK_TOKEN=${NEW_TOKEN}/" /etc/bongostock-gateway.env
sudo systemctl restart bongostock-gateway
printf '%s\n' "$NEW_TOKEN"
unset NEW_TOKEN
```

轮换后必须在每台客户端更新 Token。证书自动续期与 Token 无关。

## 12. 运维检查与排错

```bash
systemctl is-active bongostock-gateway nginx bongostock-certbot-renew.timer
systemctl is-enabled bongostock-gateway bongostock-certbot-renew.timer
sudo journalctl -u bongostock-gateway -n 100 --no-pager
sudo journalctl -u nginx -n 100 --no-pager
sudo nginx -t
sudo ss -ltnp
curl --fail http://127.0.0.1:8787/healthz
curl --fail https://<PUBLIC_IP_OR_DOMAIN>/healthz
```

常见问题：

- `401`：客户端 Token 与服务端不一致；
- `429`：超过 `BONGOSTOCK_RATE_LIMIT_PER_MINUTE`；
- `502`：Node 服务未启动或上游行情暂时不可用；
- 证书错误：检查公网 IP/域名、80/443 防火墙、证书路径和续期 timer；
- `8787` 对公网可达：立刻关闭云防火墙规则，并确认 `BONGOSTOCK_HOST=127.0.0.1`。

网关日志按设计只记录方法、路径、状态码和耗时，不记录请求正文或 Authorization。HTTPS 能保护客户端到网关的传输，但网关及上游数据源仍能看到所请求的证券代码。
