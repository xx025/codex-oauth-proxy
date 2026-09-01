# Cloudflare 部署文档

本文说明如何修改项目名称、准备 Cloudflare 资源，以及如何把项目部署到 Cloudflare Workers。

## 项目名称

当前项目名是 `codex-oauth-proxy`，主要出现在这些位置：

- `package.json` 的 `name`
- `package-lock.json` 的根包 `name`
- `wrangler.jsonc` 的 `name`
- 仓库目录名、README 标题和描述
- `src/index.ts` 中的管理 Cookie 名：`codex_admin`、`codex_ui`

如果只是想改变 Cloudflare 上的 Worker 名称，最关键的是改 `wrangler.jsonc`：

```jsonc
{
  "name": "your-worker-name"
}
```

如果想统一品牌名，建议同时修改 `package.json`、`package-lock.json`、README 标题、仓库名和 Cookie 前缀。Cookie 改名会让已登录的管理会话失效，但不会删除 Durable Object 里的账号、密钥和统计数据。

注意：不要随意修改 Durable Object 的 `class_name` 和 `migrations`。它们关系到 Cloudflare 上已有的持久化状态。新部署可以保留当前类名；已有生产环境改这些字段前需要单独规划迁移。

## 一键部署的现实限制

你说的 Cloudflare 图标是官方的 Deploy to Cloudflare 按钮。这个项目可以加这个按钮，用户点击后 Cloudflare 会引导用户复制仓库、设置 Worker 名、安装依赖、创建支持的资源并部署。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

但这个项目不能做到完全零配置的一键部署，原因是部分资源和密钥必须属于部署者自己的账号：

- `KEY_ENCRYPTION_SECRET` 必须作为 Wrangler Secret 写入，不能放进仓库。
- `ADMIN_API_KEY` 建议作为 Wrangler Secret 写入，除非管理域名由 Cloudflare Access 保护。
- `NATIVE_EGRESS` 是必需绑定，必须指向部署者自己的 Cloudflare Tunnel/VPC 出口。
- 上游请求只能通过 VPC 出口发出，不能回退到普通 Worker 出口。

可以做到的是“Fork 后一条命令部署”，但部署前仍然需要准备 Tunnel ID 和 Secret。

## Deploy to Cloudflare 按钮

README 中的按钮格式是：

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)
```

Cloudflare 会读取仓库中的 `wrangler.jsonc` 和 `package.json`。为了让引导页更友好，本仓库提供了：

- `.dev.vars.example`：声明需要填写的 Secret。
- `package.json` 的 `cloudflare.bindings`：解释 `KEY_ENCRYPTION_SECRET`、`ADMIN_API_KEY` 和 `NATIVE_EGRESS` 的用途。
- `wrangler.jsonc`：声明 Worker、Durable Objects、迁移和 VPC Network 绑定。

用户点击按钮后，仍需要在 Cloudflare 引导页面里确认这些内容：

- Worker 名称，可使用默认值或改成自己的名字。
- `KEY_ENCRYPTION_SECRET`，必须填写随机长密钥。
- `ADMIN_API_KEY`，如果不用 Cloudflare Access 保护管理域名则填写。
- `NATIVE_EGRESS`，必须绑定到用户自己的 Tunnel/VPC 出口。

如果 Cloudflare 部署页无法自动创建或选择 VPC Network 出口，用户需要先在 Cloudflare 控制台创建 Tunnel/VPC 出口，然后回到部署页选择或在 `wrangler.jsonc` 中替换 `tunnel_id`。

## Cloudflare 前置资源

部署前需要：

- Cloudflare 账号
- 已安装 Node.js 24 或更高版本
- 已登录 Wrangler：`npx wrangler login`
- 已创建并在线的 Cloudflare Tunnel/VPC 出口
- 出口公网 IP 能访问 `chatgpt.com` 和 `auth.openai.com`

推荐通过环境变量传入 Tunnel/VPC 出口 ID，这样用户不用修改 `wrangler.jsonc`：

```bash
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

部署脚本会读取 `wrangler.jsonc`，把占位 ID 替换为环境变量里的值，并生成临时配置 `.wrangler/generated-wrangler.jsonc` 给 Wrangler 使用。这个临时文件在 `.wrangler/` 下，不会提交到 Git。

也可以手动把 `wrangler.jsonc` 中的占位 `tunnel_id` 换成你自己的 Tunnel/VPC 出口 ID：

```jsonc
"vpc_networks": [
  {
    "binding": "NATIVE_EGRESS",
    "tunnel_id": "YOUR_TUNNEL_ID",
    "remote": true
  }
]
```

`binding` 必须保持为 `NATIVE_EGRESS`，代码会在缺少该绑定时失败关闭。

仓库里的默认值是占位 UUID：

```jsonc
"tunnel_id": "00000000-0000-4000-8000-000000000000"
```

这个值不能直接用于生产部署。它的作用是避免把维护者自己的 Cloudflare 资源 ID 写进公开仓库，同时让部署者明确知道这里必须替换。

## 手动部署

安装依赖：

```bash
npm ci
```

登录 Cloudflare：

```bash
npx wrangler login
```

设置加密密钥：

```bash
npx wrangler secret put KEY_ENCRYPTION_SECRET
```

建议使用足够长的随机值，例如 32 字节以上随机字符串。它用于加密可恢复的客户端密钥，并签名管理员会话。

如果管理域名没有使用 Cloudflare Access，再设置管理员登录密钥：

```bash
npx wrangler secret put ADMIN_API_KEY
```

本地校验：

```bash
npm run check
```

部署：

```bash
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

检查健康状态：

```bash
curl https://YOUR_WORKER_DOMAIN/health
```

部署完成后打开 Worker 根地址，使用 Cloudflare Access 或 `ADMIN_API_KEY` 登录管理面板，添加 OAuth 账号并生成客户端 API 密钥。

## Fork 后一条命令部署

推荐新增一个脚本，把校验和部署串起来：

```json
{
  "scripts": {
    "deploy:cloudflare": "npm run check && npm run deploy"
  }
}
```

然后部署者只需要执行：

```bash
npm run deploy:cloudflare
```

这个命令仍然要求部署者已经完成：

- 修改 `wrangler.jsonc` 的 `name`
- 设置 `CLOUDFLARE_TUNNEL_ID`，或修改 `wrangler.jsonc` 的 `vpc_networks[0].tunnel_id`
- 执行 `npx wrangler login`
- 写入 `KEY_ENCRYPTION_SECRET`
- 根据需要写入 `ADMIN_API_KEY`

## GitHub Actions 部署

如果希望通过 GitHub Actions 自动部署，需要在仓库 Secrets 中配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `KEY_ENCRYPTION_SECRET`
- `ADMIN_API_KEY`，如果不用 Cloudflare Access

API Token 至少需要允许部署 Workers、读取账号信息、写入 Worker Secret，并能访问 Durable Objects 和 VPC/Tunnel 相关配置。

工作流需要做这些事：

- 安装依赖：`npm ci`
- 写入 Wrangler Secret：`npx wrangler secret put KEY_ENCRYPTION_SECRET`
- 可选写入 `ADMIN_API_KEY`
- 运行校验：`npm run check`
- 部署：`npm run deploy`

注意：`wrangler.jsonc` 里的 `vpc_networks` 仍需要提前指向目标账号中的 Tunnel ID。GitHub Actions 不能自动替你创建可用的 VPC 出口，也不能保证出口 IP 被上游接受。

## 部署后配置

部署后建议完成：

- 给 API 和管理面板绑定不同的 Custom Domain
- 只给管理域名开启 Cloudflare Access
- 不要给 API 域名开启会把客户端重定向到网页登录的 Access 策略
- 在管理面板添加 OAuth 账号
- 在管理面板生成客户端 API Key
- 使用 `Authorization: Bearer <key>` 或 `X-API-Key: <key>` 调用 API

示例请求：

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## 改成真正的一键部署需要哪些代码变化

如果要让其他人更接近“一键部署”，建议做这些改动：

- 新增 `docs/deployment.zh-CN.md` 并在 README 中链接，降低部署者理解成本。
- 新增 `deploy:cloudflare` 脚本，封装 `npm run check && npm run deploy`。
- 提供 `wrangler.example.jsonc` 或 README 模板，明确哪些字段必须替换。
- 增加 GitHub Actions 部署工作流示例。
- 在文档中明确 `KEY_ENCRYPTION_SECRET`、`ADMIN_API_KEY` 和 `NATIVE_EGRESS` 不能硬编码。
- 如果要改项目名，同步修改 `package.json`、`package-lock.json`、`wrangler.jsonc`、README 和 Cookie 前缀。

不建议为了“一键部署”移除 `NATIVE_EGRESS` 或加入普通 Worker 出口回退；这会破坏当前安全模型和上游可用性假设。
