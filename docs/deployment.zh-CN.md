# 部署到 Cloudflare

[English](deployment.md) | 简体中文

推荐使用浏览器部署，不需要下载代码或本地运行 npm。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

## 需要准备

- Cloudflare 账号
- 可用的 Cloudflare Tunnel/VPC 出口 ID
- 一个随机加密密钥，可用 `openssl rand -hex 32` 生成

Durable Objects 会在 Wrangler 成功部署时自动创建，不需要手动创建。

## 部署步骤

点击上方按钮，先在 Cloudflare 中创建 Worker 项目。

Cloudflare 的 Deploy 按钮目前不会在首次引导页显示 Tunnel/VPC ID 输入框。首次部署可以先创建不带 VPC 出口的 Worker；项目创建后，在 Cloudflare 后台添加下面的配置，再重新部署即可。

添加构建变量：

- `CLOUDFLARE_TUNNEL_ID`：构建变量，填你的 Tunnel/VPC 出口 ID

位置：**Worker > Settings > Build > Build variables and secrets**

添加 Worker Secrets：

- `KEY_ENCRYPTION_SECRET`：Worker Secret，填随机加密密钥
- `ADMIN_API_KEY`：可选 Worker Secret；如果不用 Cloudflare Access 保护管理面板，则填写

位置：**Worker > Settings > Variables and Secrets**

最后回到部署页面，点击 **Retry deployment**。重新部署成功前，API 请求会因为缺少 `NATIVE_EGRESS` 无法访问上游。

Cloudflare 会自动拉取代码、安装依赖、构建并部署 Worker。Durable Objects 会随成功部署一起创建。

## 部署后

打开 Worker 地址：

```text
https://YOUR_WORKER_DOMAIN/
```

然后在管理面板中：

- 添加 ChatGPT OAuth 账号
- 创建客户端 API Key
- 使用 API Key 调用 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 或 `/mcp`

示例：

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 命令行部署

需要本地开发时再使用命令行：

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

如果希望开发时直接使用 Cloudflare 远程运行环境和绑定：

```bash
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run dev:remote
```
