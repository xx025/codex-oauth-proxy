# 部署到 Cloudflare

本项目部署在 Cloudflare Workers，状态保存在 Durable Objects，上游请求必须通过 `NATIVE_EGRESS` VPC 出口。

## 浏览器部署

点击按钮，按 Cloudflare 页面引导部署：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

这个方式可以做到用户不下载代码、不安装 Node.js、不运行 npm。Cloudflare 会在自己的 Workers Builds 环境里拉取仓库、安装依赖、构建并部署 Worker。

用户需要在部署页面填写：

- Worker 名称
- 构建变量 `CLOUDFLARE_TUNNEL_ID`：你的 Tunnel/VPC 出口 ID
- Worker Secret `KEY_ENCRYPTION_SECRET`：加密密钥
- Worker Secret `ADMIN_API_KEY`：管理员密钥，如果不用 Cloudflare Access 保护管理面板

`CLOUDFLARE_TUNNEL_ID` 是给部署脚本用的构建变量，不是 Worker 运行时变量。它用于生成临时 Wrangler 配置，把 `NATIVE_EGRESS` 绑定到你的 Tunnel/VPC 出口。

`KEY_ENCRYPTION_SECRET` 建议使用随机长字符串，例如：

```bash
openssl rand -hex 32
```

如果 Cloudflare 部署页面没有显示构建变量输入框，先完成创建流程。第一次部署可能会因为缺少 `CLOUDFLARE_TUNNEL_ID` 失败，然后在 Worker 的 **Settings > Build > Build variables and secrets** 中添加 `CLOUDFLARE_TUNNEL_ID`，再重新部署。整个过程仍然不需要下载代码。

## 命令行部署

只有需要本地开发、调试或自己控制部署流程时，才需要使用命令行。

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

公开仓库里的 `wrangler.jsonc` 不写死任何 Tunnel/VPC ID。不要把自己的真实 Tunnel/VPC ID 提交到公开仓库。

部署时通过环境变量传入：

```bash
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

部署脚本会生成包含 `NATIVE_EGRESS` 绑定的临时配置：

```text
.wrangler/generated-wrangler.jsonc
```

这个临时文件不会提交到 Git。

为什么不直接在 Cloudflare Worker Secrets 里设置？

因为 `tunnel_id` 是部署时绑定配置，不是 Worker 运行时变量。Worker Secrets 适合 `KEY_ENCRYPTION_SECRET`、`ADMIN_API_KEY` 这种代码运行时读取的值；VPC 绑定必须在 Wrangler 部署配置里生成。所以浏览器部署时要把 `CLOUDFLARE_TUNNEL_ID` 放在 Workers Builds 的构建变量里。

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

需要修改 `wrangler.jsonc` 吗？

不需要。正常部署只要设置 `CLOUDFLARE_TUNNEL_ID`。

为什么 `wrangler.jsonc` 里看不到 `NATIVE_EGRESS`？

公开配置不写死个人 Tunnel/VPC ID。部署时脚本会根据 `CLOUDFLARE_TUNNEL_ID` 生成临时配置，并把 `NATIVE_EGRESS` 加进去。
