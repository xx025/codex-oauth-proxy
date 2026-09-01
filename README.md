# Cloudflare OAuth API Gateway

English | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

An OpenAI-compatible, multi-account OAuth gateway implemented entirely in TypeScript. The API, administration UI, OAuth flows, account routing, and streaming conversion run on Cloudflare Workers; durable state and CPU-intensive proxy execution use Durable Objects.

This repository contains no local application service, container, native binary, or WebAssembly runtime. Because the upstream rejects ordinary Worker egress IPs, every upstream request must use the `NATIVE_EGRESS` Cloudflare VPC binding. Requests fail closed if that binding is unavailable.

> The upstream interface is not a documented, stable public API and may change with the official client. Use only accounts you control and follow the applicable terms.

## Screenshot

![Administration UI](docs/image.png)

## Features

- OpenAI-compatible Models, Chat Completions, and Responses APIs
- Streaming SSE forwarding and buffered responses
- Multi-account rotation, token refresh, cooldown, and failover
- Device-code login, browser PKCE, and manual credential import
- Independent client API keys, administration UI, and request statistics
- Stateless MCP JSON-RPC endpoint
- Egress host allowlisting, credential redaction, and bounded buffering

## Architecture

```text
API clients / administrators
             │
             ▼
Entry Worker (routing and authentication)
             │
             ├── Administration ────────► AccountPool Durable Object
             │                            accounts, OAuth, keys, policy, metrics
             │
             └── OpenAI API / MCP ─────► ProxyExecutor Durable Objects
                                          32 execution shards
                                             │             │
                                             │             └──► AccountPool
                                             │                  account selection and outcomes
                                             ▼
                                      NATIVE_EGRESS VPC Network
                                             │
                                             ▼
                                  chatgpt.com / auth.openai.com
```

The gateway separates its control plane from its data plane. `AccountPool` is the control plane for durable account state, OAuth credentials, client keys, routing policy, cooldowns, and aggregate metrics. Sharded `ProxyExecutor` objects are the data plane: they transform requests, select accounts through `AccountPool`, fail over between accounts, and stream responses back to the original client connection.

Long-running requests remain on this same streaming path; they are not converted into background jobs. Execution shards isolate request processing and scale horizontally, while the centralized account pool preserves consistent routing decisions. Prompts and responses are never written to Durable Object storage. The VPC/Tunnel is only the network egress plane, with no application service or container running on the egress node.

## Prerequisites

- Node.js 24 or newer
- A Cloudflare account authenticated with Wrangler
- An online Cloudflare Tunnel/VPC egress
- An egress public IP accepted by the ChatGPT upstream

Set your Cloudflare Tunnel/VPC egress ID with `CLOUDFLARE_TUNNEL_ID`, or replace the placeholder Tunnel ID in `wrangler.jsonc`:

```jsonc
"vpc_networks": [
  {
    "binding": "NATIVE_EGRESS",
    "tunnel_id": "YOUR_TUNNEL_ID",
    "remote": true
  }
]
```

## Deploy

For detailed Cloudflare deployment notes, renaming guidance, and one-command deployment requirements, see [Cloudflare Deployment](docs/deployment.zh-CN.md) (Chinese).

You can also use the Deploy to Cloudflare button above. During the guided setup, keep the `NATIVE_EGRESS` binding name unchanged, select your own Tunnel/VPC egress, and provide `KEY_ENCRYPTION_SECRET`.

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
npm run check
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

Use a long random value for `KEY_ENCRYPTION_SECRET`; it encrypts recoverable client keys and signs administrator sessions.

If Cloudflare Access does not protect the administration hostname, also set:

```bash
npx wrangler secret put ADMIN_API_KEY
```

Verify the deployment:

```bash
curl https://YOUR_WORKER_DOMAIN/health
```

Then open the Worker root URL, sign in through Cloudflare Access or `ADMIN_API_KEY`, add an OAuth account, and generate a client API key. API clients can use `Authorization: Bearer <key>` or `X-API-Key: <key>`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Worker health check |
| `GET` | `/v1/models` | Available models and reasoning levels |
| `POST` | `/v1/chat/completions` | Chat Completions compatibility |
| `POST` | `/v1/responses` | Responses compatibility |
| `POST` | `/mcp` | MCP JSON-RPC endpoint |
| `GET` | `/` | Administration UI |

Example:

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

For production, use separate Custom Domains for the API and administration UI. Protect only the administration hostname with Cloudflare Access so API clients are not redirected to an interactive login.

## Development

```bash
npm run types       # regenerate Worker types from wrangler.jsonc
npm run typecheck
npm test
npm run build       # wrangler deploy --dry-run
npm run check       # run every validation
```

Key files:

- `src/index.ts`: Worker routing, admin authentication, failover, and Durable Object
- `src/api.ts`: OpenAI-compatible conversion and SSE handling
- `src/pool.ts`: account pool, client keys, settings, and statistics
- `src/oauth.ts`: OAuth login, refresh, and account identity
- `src/egress.ts`: mandatory VPC binding and egress allowlist
- `src/mcp.ts`: MCP JSON-RPC adapter
- `src/ui.ts`: embedded administration interface
- `wrangler.jsonc`: Cloudflare deployment configuration

OAuth credentials and refresh tokens are stored only in the Durable Object, and public account responses are redacted. The egress allowlist permits only `chatgpt.com` and `auth.openai.com`.

## License

[MIT](LICENSE)
