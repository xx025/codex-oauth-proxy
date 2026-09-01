# 部署到 Cloudflare

本项目部署在 Cloudflare Workers，状态保存在 Durable Objects，上游请求必须通过 `NATIVE_EGRESS` VPC 出口。

## 一键部署

点击按钮，按 Cloudflare 页面引导部署：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

部署页需要你填写或确认：

- Worker 名称
- `KEY_ENCRYPTION_SECRET`
- `ADMIN_API_KEY`，如果不用 Cloudflare Access 保护管理面板
- `NATIVE_EGRESS`，选择你自己的 Tunnel/VPC 出口

`KEY_ENCRYPTION_SECRET` 建议使用随机长字符串，例如：

```bash
openssl rand -hex 32
```

## 命令行部署

准备条件：

- Node.js 24 或更高版本
- 已登录 Wrangler
- 已创建可用的 Cloudflare Tunnel/VPC 出口
- 出口公网 IP 能访问 `chatgpt.com` 和 `auth.openai.com`

部署命令：

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

如果不用 Cloudflare Access 保护管理面板，再设置管理员密钥：

```bash
npx wrangler secret put ADMIN_API_KEY
```

检查是否部署成功：

```bash
curl https://YOUR_WORKER_DOMAIN/health
```

## VPC 出口 ID

公开仓库里的 `wrangler.jsonc` 使用占位 ID：

```jsonc
"tunnel_id": "00000000-0000-4000-8000-000000000000"
```

不要把自己的真实 Tunnel/VPC ID 提交到公开仓库。

推荐部署时通过环境变量传入：

```bash
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

部署脚本会生成临时配置：

```text
.wrangler/generated-wrangler.jsonc
```

这个临时文件不会提交到 Git。

## 部署后

打开 Worker 根地址：

```text
https://YOUR_WORKER_DOMAIN/
```

然后完成：

- 登录管理面板
- 添加 ChatGPT OAuth 账号
- 生成客户端 API Key
- 使用 API Key 调用 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 或 `/mcp`

请求示例：

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 常见问题

`NATIVE_EGRESS` 能不能删除？

不能。上游请求必须走 VPC 出口，代码会在缺少该绑定时失败。

可以不设置 `ADMIN_API_KEY` 吗？

可以，但管理面板域名必须使用 Cloudflare Access 保护。

可以直接用占位 Tunnel ID 部署吗？

不可以。占位 ID 只用于公开仓库模板，部署时必须换成自己的 Tunnel/VPC 出口 ID。
