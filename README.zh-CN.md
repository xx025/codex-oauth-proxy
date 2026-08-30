# Codex OAuth Proxy

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center"><strong>Cloudflare 原生 · 单 Worker 部署 · 零应用服务器</strong></p>

一个面向生产环境、兼容 OpenAI API 的 ChatGPT Codex OAuth 网关，基于 Cloudflare 原生能力重新实现。单个 Worker 集成 API 网关、多账号控制面、管理界面、Token 自动刷新、故障转移、流式响应和 Go/Wasm 转换核心。

> **无需购买、部署或维护应用服务器。** Workers 承载计算，Durable Objects 协调状态，Access 保护管理端，Custom Domains 对外提供服务。可选的受控出口只需在出口节点运行官方 `cloudflared`，不需要在那里部署本项目或任何自定义中转服务。

> [!IMPORTANT]
> 本项目对接的是 ChatGPT Codex 内部后端，而不是公开且稳定的 OpenAI API。该接口可能随着官方 Codex 客户端更新而变化。请仅使用你有权管理的账号，并遵守相关服务条款。

## 部署到 Cloudflare

Cloudflare 版本是本项目的主要部署方式。TypeScript 边缘层、管理界面、Durable Object 和 Go/Wasm Core 会作为一个 Worker 一次部署：

```bash
cd edge
npm install
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler deploy
```

部署前，需要连接用于网络出口的 Cloudflare Tunnel，并替换 `edge/wrangler.toml` 中的 `tunnel_id`。如果管理域名已使用 Cloudflare Access，`ADMIN_API_KEY` 可以不配置。域名、Access 和出口的完整配置参见[Cloudflare 多账号部署](#cloudflare-多账号部署)。

## 核心能力

| 能力 | 带来的价值 |
| --- | --- |
| 多账号池 | 在 Fluent 风格面板中管理多个 Codex 账号；即使多人属于同一个 Team 工作区，也会通过 JWT 用户身份避免 `account_id` 冲突，并用邮箱清晰区分成员。 |
| 无竞争自动刷新 | Durable Object 串行化账号选择和 OAuth 刷新，避免并发请求重复轮换 Refresh Token。 |
| 轮询与故障转移 | 健康账号自动轮询；遇到 `401`、`403`、`429` 和 `5xx` 时进入冷却并尝试其他账号。 |
| OpenAI API 兼容 | 支持 `/v1/models`、`/v1/chat/completions` 和 `/v1/responses`，包括 SSE 流式响应。 |
| 实时模型与额度 | 管理面板读取账号实际可用的模型、按系列分组，并显示每个启用账号主、次窗口的剩余额度和重置时间。 |
| 请求与 Token 统计 | 独立面板按模型汇总请求量及 Input、Output、Total、Cached Token，并展示最近 200 次请求的状态、耗时、接口和流式模式；不会保存提示词或响应正文。 |
| Fluent 明暗主题 | 管理界面支持跟随系统、浅色和深色三种主题，并在浏览器中记住选择。 |
| 可编辑运行策略 | 可在面板修改账户选择策略、重试次数、Token 刷新窗口和不同错误的冷却时间，配置持久化在协调同一账户池的 Durable Object 中。 |
| 多客户端密钥 | 可以生成、复看、复制和注销多个独立 API 密钥，无需向客户端暴露 OAuth 凭据。 |
| Cloudflare 原生安全 | 提供管理会话、同源校验、安全响应头、可恢复密钥加密和账号元数据脱敏。 |
| 单 Worker 部署 | TypeScript 边缘层、管理 UI、Durable Object 和 Go/Wasm 转换核心部署在同一个 Worker。 |
| 可控网络出口 | Workers VPC 直接绑定选定 Tunnel，让允许的 OpenAI 域名经过官方 `cloudflared` 和指定出口 IP。 |

## Cloudflare 原生架构

本 Fork 的主要目标是在 Cloudflare 上以单 Worker 运行，而不是维护一组自定义中转服务：

| Cloudflare 层 | 职责 |
| --- | --- |
| **Workers** | 在全球边缘节点提供 OpenAI 兼容 API 和管理界面，执行鉴权、故障转移，并承载 Go/Wasm 转换核心。 |
| **Durable Objects** | 持久化账号池，并串行处理账号选择、OAuth 刷新、冷却策略、请求统计和客户端密钥操作。 |
| **Cloudflare Access** | 通过现有身份提供商保护管理域名，同时避免普通 API 客户端被重定向至交互式登录。 |
| **Workers VPC + Tunnel** | 可选提供受控网络出口，通过选定 Tunnel 和官方 `cloudflare/cloudflared` 连接器转发允许的上游流量。 |
| **Custom Domains** | 分离机器 API 流量和浏览器管理流量，同时保持单 Worker 部署。 |

OAuth Token 不会返回浏览器，出口机器也不需要运行本项目或任何自定义中转代码。

## Cloudflare 架构

```text
OpenAI 兼容客户端
       │  Bearer Key / X-API-Key
       ▼
┌──────────────────────────────────────────┐
│ codex-oauth-proxy Worker                 │
│ 管理 UI · 客户端鉴权 · 故障转移 · Go/Wasm │
└──────────────────┬───────────────────────┘
                   │ 串行化账号选择与刷新
                   ▼
          ┌──────────────────┐
          │ AccountPool DO   │
          │ 账号池、密钥     │
          │ 设置与请求统计   │
          └────────┬─────────┘
                   │ NATIVE_EGRESS（选定 Tunnel）
                   ▼
           Workers VPC 直接绑定 Tunnel
                   │
                   ▼
       仅运行官方 cloudflare/cloudflared
                   │
                   ▼
          ChatGPT Codex / OAuth 后端
```

OAuth Access Token、Refresh Token 和账号 ID 始终保留在服务端。模型与额度查询同样由服务端经选定 Tunnel 完成；浏览器只能获得模型元数据、剩余百分比、重置时间和经过脱敏的账号元数据。

请求统计也由 Durable Object 串行协调。Worker 会对上游响应做流分支：客户端继续收到原始 JSON 或 SSE 数据，另一分支仅使用有界解析器读取 `usage` 元数据。按模型汇总长期保留，最近请求列表最多 200 条；每条只包含时间、接口、模型、状态码、耗时、流式模式、内部账号引用和 Token 数，不保存提示词、响应正文、Access Token 或 Refresh Token。只有上游响应提供 OpenAI 兼容 `usage` 时才会统计 Token；没有用量字段的请求仍计入请求量，并标记为未计量。

每个账号以“Team 工作区 ID + OAuth JWT 中的稳定用户标识”作为唯一身份。工作区 `account_id` 只负责上游路由和额度查询，邮箱用于管理界面辨认用户；无法取得用户 ID 或邮箱的凭据会被拒绝，避免误覆盖同一 Team 下的其他成员。

## 推荐的域名与 Access 布局

建议为机器调用和浏览器管理分别使用两个域名：

| 域名 | 保护方式 | 用途 |
| --- | --- | --- |
| `api.example.com` | 本项目生成的 Proxy API Key | `/v1/models`、`/v1/chat/completions`、`/v1/responses` |
| `admin.example.com` | Cloudflare Access + 管理会话 | 管理面板和 `/admin/api/*` |

如果普通 OpenAI 客户端需要访问 API 域名，请**不要启用 Worker-level Access**。Worker-level Access 会覆盖该 Worker 关联的所有 Route、Custom Domain 和 `workers.dev` 域名，客户端会在项目 API Key 鉴权之前被重定向到交互式登录页面。正确做法是只为管理域名创建基于 hostname 的 Access Application。参见 [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) 和 [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

如果所有 API 客户端都能额外携带 Cloudflare Access Service Token，也可以选择 Worker-level Access。

## Cloudflare 多账号部署

Cloudflare 版本只使用一个 `codex-oauth-proxy` Worker。TypeScript 边缘层和 Go/Wasm Core 会打包到一起，由它完成客户端鉴权、根目录管理界面、账号选择、故障转移、冷却、OpenAI 格式转换和流式响应，并持有 `AccountPool` Durable Object。

OAuth 凭据只保存在 Durable Object 中。账号列表接口仅返回脱敏元数据。Token 在过期前由 Durable Object 刷新，因此多个 Worker 实例不会同时轮换同一个 Refresh Token。

### 原生网络出口

Worker 通过 Workers VPC Network 直接绑定一个选定的 Cloudflare Tunnel（`tunnel_id`），避免 Mesh 或 Hostname Route 选择不明确，确保模型请求、设备码登录和 Token 刷新均从该 Tunnel 的节点出站。出口节点只需要运行官方 `cloudflare/cloudflared` 镜像，不需要部署自定义中转代码。

Worker 代码还会执行相同的双域名白名单，拒绝访问其他目标。

只使用两个 Secret：

- `KEY_ENCRYPTION_SECRET`：必需，统一用于可恢复客户端密钥加密、管理员会话签名和内嵌 Core 信任边界。
- `ADMIN_API_KEY`：可选，在没有 Cloudflare Access 时作为管理员登录备用方式。

客户端 API 密钥直接在 UI 中生成和管理，不需要为每个客户端配置环境变量。故障转移次数使用代码中的安全默认值，也不再暴露为部署变量。

连接命名 Tunnel，将 `edge/wrangler.toml` 中的 `tunnel_id` 替换成它的 UUID，然后部署。`ADMIN_API_KEY` 是可选项；完全使用 Cloudflare Access 时可以省略：

```bash
cd edge
npm install
npx wrangler secret put KEY_ENCRYPTION_SECRET
# 可选：不使用 Cloudflare Access 时的备用登录方式
npx wrangler secret put ADMIN_API_KEY
npx wrangler deploy
```

部署后，将 API 域名和管理域名都作为 Custom Domain 绑定到同一个 Worker。在 Zero Trust 中，仅为管理域名创建 Self-hosted Access Application；API 域名不要启用交互式 Access，而是使用本项目生成的 Proxy API Key 保护。

打开 Worker 根目录 `/`，通过 Cloudflare Access 或 `ADMIN_API_KEY` 登录。账号支持三种添加方式：设备码登录；使用 PKCE 浏览器授权并粘贴最终的 `http://localhost:1455/auth/callback?...` URL；手动导入凭据 JSON。复制回调 URL 模式会校验一次性 OAuth `state`，PKCE verifier 仅保存在 Durable Object。之后可在 UI 中生成客户端 API 密钥，客户端通过 Bearer Token 或 `X-API-Key` 使用。

### 账号路由策略

启用的账号按照轮询策略选择。遇到 `429`、`401`、`403` 或 `5xx` 时，账号会进入指数退避冷却；`429` 会优先遵循 `Retry-After`。在响应体开始向客户端传输前，系统会尝试其他健康账号。流式响应一旦已经发送字节，就无法再安全切换账号。

## API 端点

- `POST /v1/chat/completions`：OpenAI Chat Completions 兼容端点。
- `POST /v1/responses`：OpenAI Responses 兼容端点。
- `GET /v1/models`：返回当前账号有权使用的模型及推理强度变体。
- `GET /health`：健康检查。

## 模型与推理强度

`/v1/models` 会根据选中 Codex 账号的实际权限请求实时模型目录，而不是返回永久硬编码的列表。因此，上游新模型可以在无需等待代理发布新版本的情况下出现。

当前标准化层识别 `gpt-5.4`、`gpt-5.4-mini`、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-daybreak-blue-latest`。已退役或无法识别的 GPT-5 别名会回退到当前可用模型，提高旧客户端兼容性。

推理强度可以通过 `reasoning_effort`、`reasoning.effort` 或模型名后缀 `-low`、`-medium`、`-high`、`-xhigh`、`-max` 提供。代理会根据目标模型支持的范围进行标准化和限制，并通过 `/v1/models` 暴露对应的后缀变体。

## 调用示例

```bash
curl -X POST https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好！"}],"stream":true}'
```
