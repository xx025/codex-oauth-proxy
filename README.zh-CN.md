# CloudRouter

[English](README.md) | 简体中文

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/cloud-router)

把 ChatGPT OAuth 账号路由为运行在 Cloudflare Workers 上的 OpenAI 兼容 API。

可用于对外提供 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 和 `/mcp`，上游访问由 ChatGPT OAuth 账号统一管理。

> 本项目使用非官方上游接口。请只使用自己有权控制的账号，并遵守相关条款。

## 测试站点

- 地址：<https://cloud-router.vktest.workers.dev/>
- 密码：`admin`

请不要在公开测试站点输入私人信息、个人 Token、生产 API Key 或重要账号。

## 功能

- OpenAI 兼容 API
- ChatGPT OAuth 登录和账号导入
- 多账号轮询、刷新、冷却和故障转移
- 支持流式和非流式响应
- 内置管理面板、客户端 API Key 和请求统计
- 仅使用 Cloudflare Workers + Durable Objects
- 强制通过 Cloudflare `NATIVE_EGRESS` VPC 出口访问上游

## 截图

![管理面板](docs/image.png)

## 部署

点击上方按钮即可在浏览器创建 Worker，不需要下载代码，不需要安装 Node.js，也不需要本地运行 npm。

首次重新部署前，在 Cloudflare 后台添加：

- 构建变量 `CLOUDFLARE_TUNNEL_ID`：Cloudflare Tunnel/VPC 出口 ID
- Worker Secret `KEY_ENCRYPTION_SECRET`：随机长字符串，可用 `openssl rand -hex 32` 生成
- 可选 Worker Secret `ADMIN_API_KEY`：仅在管理域名没有使用 Cloudflare Access 时需要

Durable Objects 会在 Wrangler 成功部署时自动创建，不需要手动创建。

Cloudflare 的 Deploy 按钮目前不会在首次引导页显示 Tunnel ID 输入框。首次部署可以先创建不带 VPC 出口的 Worker；之后进入 **Settings > Build > Build variables and secrets** 添加 `CLOUDFLARE_TUNNEL_ID`，再重新部署后使用 API。

需要 VPC 出口连接器时，可以参考 [cloudflared](https://github.com/xx025/cloudflared)：这是一个最小化的 `cloudflared` 参考实现，并标注了 Railway 快速部署入口。Cloudflare 官方 tunnel connector 文档见 [Run cloudflared as a service](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/)。

中文部署说明见 [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md)。

## 使用

部署后打开 Worker 地址，添加 ChatGPT OAuth 账号，然后创建客户端 API Key。

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 本地开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

命令行部署：

```bash
npx wrangler secret put KEY_ENCRYPTION_SECRET
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

## 许可证

[MIT](LICENSE)
