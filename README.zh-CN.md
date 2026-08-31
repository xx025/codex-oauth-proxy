# Cloudflare OAuth API 网关

[English](README.md) | 简体中文

兼容 OpenAI API 的多账号 OAuth 网关。应用由 TypeScript 单语言实现，API、管理面板、OAuth、账号调度与流式转换均部署在一个 Cloudflare Worker 中；持久状态由 Durable Object 管理。

本仓库不包含本地应用服务、容器、原生二进制或 WebAssembly。由于上游拒绝普通 Worker 出口 IP，上游请求必须通过 `NATIVE_EGRESS` Cloudflare VPC 绑定转发，绑定缺失时会直接失败，不会回退到普通出口。

> 上游接口并非公开、稳定的正式 API，可能随官方客户端变化。请只使用自己有权控制的账号，并遵守相关条款。

## 主要功能

- OpenAI 兼容的 Models、Chat Completions 和 Responses API
- SSE 流式转发与非流式聚合
- 多账号轮询、自动刷新、冷却和故障转移
- 设备码、浏览器 PKCE 和手动凭据导入
- 独立客户端 API 密钥、管理面板和请求统计
- 无状态 MCP JSON-RPC 接口
- 出口域名白名单、凭据脱敏和有界请求/响应缓冲

## 架构

```text
API 客户端 / 管理员
          │
          ▼
Cloudflare Worker（TypeScript）
          │
          ├── AccountPool Durable Object
          │     账号、OAuth、密钥、统计、冷却状态
          │
          └── NATIVE_EGRESS VPC Network
                    │
                    ▼
          chatgpt.com / auth.openai.com
```

VPC/Tunnel 只承担固定网络出口；本项目本身没有需要在出口节点运行的应用或容器。

## 部署前提

- Node.js 24 或更高版本
- 已登录 Wrangler 的 Cloudflare 账号
- 已创建且在线的 Cloudflare Tunnel/VPC 出口
- 该出口的公网 IP 可以访问 ChatGPT 上游

确认 `wrangler.jsonc` 中的 Tunnel ID 属于目标出口：

```jsonc
"vpc_networks": [
  {
    "binding": "NATIVE_EGRESS",
    "tunnel_id": "63f25b3f-89c9-428b-9516-afd65c748b37",
    "remote": true
  }
]
```

## 部署

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
npm run check
npm run deploy
```

`KEY_ENCRYPTION_SECRET` 必须是足够长的随机值，用于加密可恢复的客户端密钥并签名管理员会话。

如果管理域名未使用 Cloudflare Access，再设置管理员登录密钥：

```bash
npx wrangler secret put ADMIN_API_KEY
```

部署完成后先检查健康状态：

```bash
curl https://YOUR_WORKER_DOMAIN/health
```

然后打开 Worker 根地址，通过 Cloudflare Access 或 `ADMIN_API_KEY` 登录，添加 OAuth 账号并生成客户端 API 密钥。客户端可使用 `Authorization: Bearer <密钥>` 或 `X-API-Key: <密钥>`。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | Worker 健康检查 |
| `GET` | `/v1/models` | 当前账号可用模型与推理强度 |
| `POST` | `/v1/chat/completions` | Chat Completions 兼容接口 |
| `POST` | `/v1/responses` | Responses 兼容接口 |
| `POST` | `/mcp` | MCP JSON-RPC 接口 |
| `GET` | `/` | 管理面板 |

调用示例：

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

生产环境建议分别绑定 API 域名和管理域名，只对管理域名启用 Cloudflare Access，避免 API 客户端被重定向到交互式登录。

## 开发与验证

```bash
npm run types       # 根据 wrangler.jsonc 重新生成 Worker 类型
npm run typecheck
npm test
npm run build       # wrangler deploy --dry-run
npm run check       # 执行全部校验
```

核心文件：

- `src/index.ts`：Worker 路由、管理认证、故障转移和 Durable Object
- `src/api.ts`：OpenAI 兼容转换与 SSE 处理
- `src/pool.ts`：账号池、客户端密钥、设置与统计
- `src/oauth.ts`：OAuth 登录、刷新与账号身份
- `src/egress.ts`：VPC 出口白名单和强制绑定
- `src/mcp.ts`：MCP JSON-RPC 适配
- `src/ui.ts`：内嵌管理界面
- `wrangler.jsonc`：Cloudflare 部署配置

OAuth 凭据和刷新令牌只保存在 Durable Object 中，对外账号响应会脱敏。出口白名单只允许 `chatgpt.com` 和 `auth.openai.com`。

## 许可证

[MIT](LICENSE)
