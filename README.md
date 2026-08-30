# Codex OAuth Proxy

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center"><strong>Cloudflare native · One Worker · Zero application servers</strong></p>

A production-oriented, OpenAI-compatible gateway for ChatGPT Codex OAuth accounts, rebuilt around Cloudflare's native platform. A single Worker bundles the API gateway, multi-account control plane, admin UI, automatic token refresh, failover, streaming, and the Go/Wasm transformation core.

> **No application server to provision or maintain.** Workers handles compute, Durable Objects handles coordinated state, Access protects administration, and Custom Domains expose the service. The optional controlled-egress setup needs only the official `cloudflared` connector on an exit node—no copy of this application and no custom relay service runs there.

> [!IMPORTANT]
> This project integrates with ChatGPT Codex's internal backend. That interface is not a documented public OpenAI API and may change when the official Codex client changes. Use it only with accounts you control and in accordance with the applicable terms.

## Deploy on Cloudflare

The Cloudflare edition is the primary deployment target. It ships the TypeScript edge layer, administration UI, Durable Object, and Go/Wasm core as one Worker:

```bash
cd edge
npm install
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler deploy
```

Before deploying, connect the Cloudflare Tunnel used for egress and replace `tunnel_id` in `edge/wrangler.toml`. `ADMIN_API_KEY` is optional when Cloudflare Access protects the administration hostname. See [Cloudflare multi-account deployment](#cloudflare-multi-account-deployment) for the complete domain, Access, and egress setup.

## What you get

| Capability | What you gain |
| --- | --- |
| Multi-account pool | Import, rename, enable, disable, and remove multiple Codex accounts—even when several users share the same Team workspace. JWT user identity prevents `account_id` collisions, while email makes each member recognizable in the dashboard. |
| Automatic refresh without races | A Durable Object serializes account selection and OAuth refreshes, preventing concurrent refresh-token rotation. |
| Round-robin and failover | Healthy accounts rotate automatically; `401`, `403`, `429`, and `5xx` responses trigger cooldown and retry on another account. |
| OpenAI-compatible API | Existing clients can use `/v1/models`, `/v1/chat/completions`, and `/v1/responses`, including SSE streaming. |
| Live models and quotas | The dashboard reads live model entitlements, groups models by family, and shows each enabled account's remaining primary and secondary usage windows. |
| Request analytics | A dedicated dashboard groups request counts and input/output/total/cached tokens by model, with status, duration, endpoint, and streaming mode for the latest 200 requests. Prompts and response bodies are never stored. |
| Fluent light and dark UI | The dashboard supports system, light, and dark themes and remembers the browser's choice. |
| Editable runtime policy | Change selection strategy, retry count, token refresh window, and status-specific cooldowns from the dashboard; settings persist in the coordinated Durable Object. |
| Multiple client keys | Generate, review, copy, and revoke independent API keys without exposing OAuth credentials to clients. |
| Cloudflare-native security | Admin sessions, same-origin checks, secure headers, encrypted recoverable keys, and metadata-only account responses. |
| One Worker deployment | The TypeScript edge, admin UI, Durable Object, and Go/Wasm transformation core deploy together. |
| Controlled network egress | A direct Workers VPC Tunnel binding sends the allowed OpenAI hosts through an official `cloudflared` connector and a chosen exit IP. |

## Cloudflare-native by design

This fork is designed to run as a single Cloudflare Worker rather than as a collection of custom relay services:

| Cloudflare layer | Responsibility |
| --- | --- |
| **Workers** | Serve the OpenAI-compatible API and management UI globally, run authentication and failover, and host the Go/Wasm transformation core. |
| **Durable Objects** | Persist the account pool and serialize selection, OAuth refresh, cooldown, policy, analytics, and client-key operations. |
| **Cloudflare Access** | Protect the administration hostname through an existing identity provider without forcing interactive login on API clients. |
| **Workers VPC + Tunnel** | Optionally provide controlled egress through a selected Tunnel using only the official `cloudflare/cloudflared` connector. |
| **Custom Domains** | Separate machine API traffic from browser administration while keeping a single Worker deployment. |

No OAuth token is returned to the browser. No custom application code needs to run on the egress machine.

## Cloudflare architecture

```text
OpenAI client
     │  Bearer key / X-API-Key
     ▼
┌──────────────────────────────────────────────┐
│ codex-oauth-proxy Worker                     │
│ Admin UI · client auth · failover · Go/Wasm │
└───────────────────┬──────────────────────────┘
                    │ serialized selection / refresh
                    ▼
           ┌──────────────────┐
           │ AccountPool DO   │
           │ accounts + keys  │
           │ settings + stats │
           └────────┬─────────┘
                    │ NATIVE_EGRESS (selected Tunnel)
                    ▼
          Direct Workers VPC Tunnel binding
                    │
                    ▼
       official cloudflare/cloudflared only
                    │
                    ▼
          ChatGPT Codex / OAuth endpoints
```

OAuth access tokens, refresh tokens, and account IDs stay on the server side. Model and quota lookups also run server-side through the selected Tunnel; the browser receives only model metadata, remaining percentages, reset times, and redacted account metadata.

Request analytics are also coordinated in the Durable Object. The Worker tees each successful upstream response so the client keeps the original JSON or SSE stream while a bounded parser reads only usage metadata. Per-model aggregates are retained, and the recent-request list is capped at 200 entries. Records contain time, endpoint, model, status, duration, streaming mode, internal account reference, and token counts only—never prompts, response bodies, access tokens, or refresh tokens. Token totals are available when the upstream response emits an OpenAI-compatible `usage` object; requests without usage remain counted and are marked unmetered.

Accounts are uniquely keyed by both the Team workspace ID and a stable user principal extracted from the OAuth JWT. The workspace `account_id` is used for upstream routing and quota requests, while the user's email is display metadata—not the sole workspace identifier. Imports without a user principal or email are rejected instead of risking an overwrite.

## Recommended domain and Access layout

Use separate hostnames for machine API traffic and browser administration:

| Hostname | Protection | Purpose |
| --- | --- | --- |
| `api.example.com` | Managed proxy API keys | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| `admin.example.com` | Cloudflare Access + admin session | Dashboard and `/admin/api/*` |

Do **not** enable Worker-level Access when ordinary OpenAI clients need to call the API hostname. Worker-level Access covers every route, Custom Domain, and `workers.dev` hostname attached to the Worker, so clients would be redirected to an interactive Access login before the project's API-key authentication runs. Instead, create a hostname-based Access application for the administration hostname only. See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

For a private deployment where every client can send Cloudflare Access service-token headers, Worker-level Access is also supported.

## Deployment modes

- **Cloudflare native mode (recommended)** — one edge deployment with no application server, a web UI, centralized account pool, and automatic failover.
- **Local Go mode (optional)** — for one-machine workflows, local MCP support, and independent XDG/keychain credential storage.

The Cloudflare edition deploys directly from this repository. The package-manager commands below install only the optional local Go proxy.

## Optional local installation

Option 1 (recommended): install a prebuilt binary via npm (macOS, Linux, Windows):

```bash
npm install -g codex-oauth-proxy
```

Option 2: install with mise:

```bash
mise use -g go:github.com/dvcrn/codex-oauth-proxy/cmd/codex-oauth-proxy@latest
```

Option 3: install from source with Go:

```bash
go install github.com/dvcrn/codex-oauth-proxy/cmd/codex-oauth-proxy@latest
```

## Setup

### Credentials Storage & Migration

The proxy now uses **independent credential storage** to avoid token collisions with the system Codex CLI.

**Default behavior (`--creds-store=auto`)**:

- Stores credentials in `~/.config/codex-oauth-proxy/auth.json` (XDG config directory)
- On first launch, automatically migrates from:
  1. Legacy file (`~/.codex/auth.json`) if it exists
  2. System Keychain if no legacy file found
- After migration, immediately refreshes tokens to establish an independent token chain
- All subsequent token refreshes are stored in the new location

**Credential store modes**:

```bash
# Auto migration (default) - uses XDG config directory
./codex-oauth-proxy --creds-store=auto

# Explicit XDG path
./codex-oauth-proxy --creds-store=xdg

# Custom path
./codex-oauth-proxy --creds-store=xdg --creds-path=/custom/path/auth.json

# Legacy mode (shares with system CLI)
./codex-oauth-proxy --creds-store=legacy --creds-path=~/.codex/auth.json

# Keychain mode (macOS only)
./codex-oauth-proxy --creds-store=keychain

# Environment variables mode
./codex-oauth-proxy --creds-store=env
```

**Migration flags**:

```bash
# Skip immediate token refresh after migration (not recommended)
./codex-oauth-proxy --disable-migrate-refresh
```

**Environment variables** (for `--creds-store=env` mode):

```bash
export ACCESS_TOKEN="your-access-token"
export ACCOUNT_ID="your-account-id"
```

**Server config**:

```bash
export PORT="3000"  # default: 9879
export ENV="production"  # default: development (console logs)
export DISABLE_HEALTH_LOGS="true"  # default: false; disables request logging for /health
```

**Migration logs**:
The server provides detailed logging during migration:

- `🔍` - Checking for existing credentials
- `📄` - Reading from legacy file or keychain
- `💾` - Writing credentials to new location
- `🔄` - Performing token refresh
- `✅` - Success indicators
- `⚠️` - Warnings (e.g., refresh failures)
- `❌` - Errors

**Troubleshooting**:

- If migration fails, the server will continue with existing credentials if available
- Check logs for detailed error messages
- Use `--creds-store=legacy` to temporarily revert to old behavior
- Manually inspect `~/.config/codex-oauth-proxy/auth.json` for credential status

## Usage

```bash
just build  # Build binary
just run    # Run server
just test   # Run tests
```

## Cloudflare multi-account deployment

The Cloudflare deployment uses one Worker, `codex-oauth-proxy`. The TypeScript edge and Go/Wasm Core are bundled into the same Worker. It authenticates clients, serves the admin UI at `/`, selects accounts, applies failover and cooldown, preserves OpenAI-compatible transformations and streaming, and owns the `AccountPool` Durable Object.

OAuth credentials live only in Durable Object storage. Account list responses contain metadata only. Refreshes happen inside the Durable Object before expiry, so concurrent Worker isolates cannot rotate the same refresh token at the same time.

### Native egress routing

The Worker uses a direct Workers VPC Network binding to one selected Cloudflare Tunnel (`tunnel_id`). This avoids ambiguous Mesh or Hostname Route selection and ensures model traffic, device login, and token refresh use that tunnel's exit node. The connector runs only the official `cloudflare/cloudflared` image; no custom relay application is required. Worker code also enforces the `chatgpt.com` and `auth.openai.com` allowlist.

Only two secrets are used:

- `KEY_ENCRYPTION_SECRET` — required application secret for recoverable client-key encryption, admin-session signing, and the embedded Core trust boundary.
- `ADMIN_API_KEY` — optional fallback for admin login without Cloudflare Access.

Client API keys are generated and managed in the UI, so no per-client environment variables are needed. The failover attempt limit is a safe code default rather than a deployment variable.

Connect the named Cloudflare Tunnel, replace `tunnel_id` in `edge/wrangler.toml` with its UUID, then deploy the single Worker. `ADMIN_API_KEY` is optional and can be omitted when Cloudflare Access is used exclusively:

```bash
cd edge
npm install
npx wrangler secret put KEY_ENCRYPTION_SECRET
# Optional fallback login without Cloudflare Access:
npx wrangler secret put ADMIN_API_KEY
npx wrangler deploy
```

Then attach the API and administration Custom Domains to the same Worker. In Zero Trust, create a self-hosted Access application for the administration hostname only; leave the API hostname outside interactive Access and rely on the managed proxy keys generated by this project.

Open `/`, authenticate through Cloudflare Access (or the optional `ADMIN_API_KEY` fallback), and add accounts with any of the three supported methods: device-code login, PKCE browser login by pasting the resulting `http://localhost:1455/auth/callback?...` URL, or manual credential JSON import. The callback-paste flow verifies the one-time OAuth `state` and keeps the PKCE verifier in Durable Object storage. Generate a proxy API key in the UI; proxy endpoints accept it as a bearer token or `X-API-Key`.

The Cloudflare build returns `501 Not Implemented` for `/mcp` to stay within the Worker bundle limit. The local Go binary retains full MCP support.

### Account routing

Enabled accounts are selected round-robin. Accounts returning `429`, `401`/`403`, or `5xx` enter an exponential cooldown (respecting `Retry-After` for rate limits) and the request is retried on another account before a response body is streamed. Successful requests clear the account failure state. Mid-stream upstream failures cannot be retried after bytes have reached the client.

## Endpoints

- `POST /v1/chat/completions` - OpenAI chat completions-compatible endpoint
- `POST /v1/responses` - OpenAI Responses-compatible endpoint (Codex)
- `GET /health` - Health check
- `/mcp` - local Go mode only; exposes `ask_codex` and `ask_codex_models` as MCP tools

## MCP clients

The proxy also speaks MCP over streamable HTTP at `/mcp`, so any MCP client can ask
Codex models a question without going through the chat completions or responses
endpoints. The session is stateless and authenticates with the same `ADMIN_API_KEY`
as everything else, sent as a bearer token.

```json
{
  "mcpServers": {
    "ask-codex": {
      "type": "http",
      "url": "http://localhost:9879/mcp",
      "headers": {
        "Authorization": "Bearer xxxx"
      }
    }
  }
}
```

Two tools are exposed:

- `ask_codex(model, prompt)` - ask a model a single self-contained question and get
  the answer back as text. There is no conversation history, so the prompt needs to
  carry all the context. Reasoning effort suffixes work here too, so `gpt-5.5-high`
  is a valid model.
- `ask_codex_models()` - list the model IDs that can be passed to `ask_codex`, with the
  reasoning effort levels each one accepts.

## Models and reasoning

`/v1/models` is entitlement-aware: it fetches the live model catalog for the selected Codex account instead of presenting a permanently hard-coded list. Newly launched upstream models can therefore appear without waiting for a proxy release.

The current normalization layer recognizes `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-daybreak-blue-latest`. Retired or unknown GPT-5 aliases fall back to a currently served model so older clients fail gracefully.

Reasoning effort can be supplied as `reasoning_effort`, `reasoning.effort`, or a model suffix such as `-low`, `-medium`, `-high`, `-xhigh`, or `-max`. The proxy normalizes and clamps the value to the levels supported by the selected model. The generated effort variants are also discoverable through `/v1/models`.

## Example

```bash
curl -X POST https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```
