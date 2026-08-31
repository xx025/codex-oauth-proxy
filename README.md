# Cloudflare OAuth API Gateway

English | [简体中文](README.zh-CN.md)

An OpenAI-compatible, multi-account OAuth gateway implemented entirely in TypeScript. The API, administration UI, OAuth flows, account routing, and streaming conversion run in one Cloudflare Worker; durable state lives in a Durable Object.

This repository contains no local application service, container, native binary, or WebAssembly runtime. Because the upstream rejects ordinary Worker egress IPs, every upstream request must use the `NATIVE_EGRESS` Cloudflare VPC binding. Requests fail closed if that binding is unavailable.

> The upstream interface is not a documented, stable public API and may change with the official client. Use only accounts you control and follow the applicable terms.

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
Cloudflare Worker (TypeScript)
             │
             ├── AccountPool Durable Object
             │     accounts, OAuth, keys, metrics, cooldowns
             │
             └── NATIVE_EGRESS VPC Network
                       │
                       ▼
             chatgpt.com / auth.openai.com
```

The VPC/Tunnel supplies only the accepted network egress. This project does not run an application process or container on the egress node.

## Prerequisites

- Node.js 24 or newer
- A Cloudflare account authenticated with Wrangler
- An online Cloudflare Tunnel/VPC egress
- An egress public IP accepted by the ChatGPT upstream

Confirm that the Tunnel ID in `wrangler.jsonc` belongs to the intended egress:

```jsonc
"vpc_networks": [
  {
    "binding": "NATIVE_EGRESS",
    "tunnel_id": "63f25b3f-89c9-428b-9516-afd65c748b37",
    "remote": true
  }
]
```

## Deploy

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
npm run check
npm run deploy
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
