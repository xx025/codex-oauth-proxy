# ChatGPT OAuth API 代理

[English](README.md) | 简体中文

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

点击上方按钮即可在浏览器里部署，不需要下载代码，也不需要在本地运行 npm。

把 ChatGPT OAuth 账号转换成兼容 OpenAI API 的服务。项目完整运行在 Cloudflare Workers 和 Durable Objects 上，内置管理面板，可添加账号、生成客户端 API Key、查看请求统计。

适合需要让客户端调用 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 或 `/mcp`，但上游凭据通过 ChatGPT OAuth 账号统一管理的场景。

> 上游接口不是公开稳定 API，可能随官方客户端变化。请只使用自己有权控制的账号，并遵守相关条款。

## 截图

![管理面板](docs/image.png)

## 功能

- 兼容 OpenAI Models、Chat Completions 和 Responses API
- 支持 ChatGPT OAuth 账号导入、设备码登录、浏览器 PKCE 登录
- 多账号轮询、冷却、自动刷新和故障转移
- 支持 SSE 流式响应和非流式聚合响应
- 客户端 API Key 与管理员登录分离
- 内置管理面板和请求统计
- 支持无状态 MCP JSON-RPC 接口
- 强制通过 Cloudflare `NATIVE_EGRESS` VPC 出口访问上游

## 工作方式

```text
客户端 / 管理员
      |
      v
Cloudflare Worker
      |
      +-- 管理面板和设置 --> AccountPool Durable Object
      |
      +-- API 请求 --------> ProxyExecutor Durable Objects
                              |
                              v
                        NATIVE_EGRESS VPC
                              |
                              v
                    chatgpt.com / auth.openai.com
```

OAuth Token、账号、客户端密钥、设置和统计信息保存在 Durable Object Storage。提示词和响应内容不会写入持久存储。

所有上游请求都必须通过 `NATIVE_EGRESS` VPC 绑定。缺少该绑定时，Worker 会直接失败，不会回退到普通 Worker 出口。

## 部署

完整部署步骤见 [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md)。

推荐点击上方 Deploy to Cloudflare 按钮，在浏览器里完成部署。用户不需要克隆仓库，不需要安装 Node.js，也不需要在本地运行 npm。

在 Cloudflare 部署页面里，只需要填写两个必填项：

- `CLOUDFLARE_TUNNEL_ID`：构建变量，你自己的 Cloudflare Tunnel/VPC 出口 ID
- `KEY_ENCRYPTION_SECRET`：Worker Secret，随机长字符串，例如 `openssl rand -hex 32`

如果管理域名没有用 Cloudflare Access 保护，再把 `ADMIN_API_KEY` 设置为 Worker Secret。

也可以使用命令行部署。无需修改 `wrangler.jsonc`，部署脚本会根据 `CLOUDFLARE_TUNNEL_ID` 生成临时 Wrangler 配置：

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

如果管理域名没有使用 Cloudflare Access 保护，还需要设置：

```bash
npx wrangler secret put ADMIN_API_KEY
```

检查部署：

```bash
curl https://YOUR_WORKER_DOMAIN/health
```

打开 Worker 地址，添加 ChatGPT OAuth 账号，然后创建客户端 API Key。客户端可使用任一请求头：

```text
Authorization: Bearer YOUR_CLIENT_KEY
X-API-Key: YOUR_CLIENT_KEY
```

## API 示例

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 开发

```bash
npm run typecheck
npm test
npm run build
```

主要文件：

- `src/index.ts`：Worker 路由和 Durable Objects
- `src/api.ts`：OpenAI 兼容请求和响应处理
- `src/pool.ts`：账号池、客户端密钥、设置和统计
- `src/oauth.ts`：OAuth 登录和 Token 刷新
- `src/egress.ts`：强制 VPC 出口和上游域名白名单
- `src/mcp.ts`：MCP 适配
- `src/ui.ts`：内置管理面板
- `wrangler.jsonc`：Cloudflare Worker 配置

## 许可证

[MIT](LICENSE)
