# Codex OAuth Proxy

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

A production-oriented, OpenAI-compatible gateway for ChatGPT Codex OAuth accounts. It keeps the original local proxy mode and adds a Cloudflare-native multi-account control plane with automatic token refresh, failover, streaming, secure key management, and an admin UI.

> [!IMPORTANT]
> This project integrates with ChatGPT Codex's internal backend. That interface is not a documented public OpenAI API and may change when the official Codex client changes. Use it only with accounts you control and in accordance with the applicable terms.

## Why this fork

| Capability | What you gain |
| --- | --- |
| Multi-account pool | Import, rename, enable, disable, and remove multiple Codex accounts from one Fluent-style dashboard. |
| Automatic refresh without races | A Durable Object serializes account selection and OAuth refreshes, preventing concurrent refresh-token rotation. |
| Round-robin and failover | Healthy accounts rotate automatically; `401`, `403`, `429`, and `5xx` responses trigger cooldown and retry on another account. |
| OpenAI-compatible API | Existing clients can use `/v1/models`, `/v1/chat/completions`, and `/v1/responses`, including SSE streaming. |
| Multiple client keys | Generate, review, copy, and revoke independent API keys without exposing OAuth credentials to clients. |
| Cloudflare-native security | Admin sessions, same-origin checks, secure headers, encrypted recoverable keys, and metadata-only account responses. |
| One Worker deployment | The TypeScript edge, admin UI, Durable Object, and Go/Wasm transformation core deploy together. |
| Controlled network egress | Workers VPC hostname routes can send only the allowed OpenAI hosts through an official `cloudflared` connector and a chosen exit IP. |

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
           └────────┬─────────┘
                    │ NATIVE_EGRESS (cf1:network)
                    ▼
      Tunnel Hostname routes for allowed hosts
                    │
                    ▼
       official cloudflare/cloudflared only
                    │
                    ▼
          ChatGPT Codex / OAuth endpoints
```

OAuth access tokens, refresh tokens, and account IDs stay on the server side. Clients receive only OpenAI-compatible responses and redacted account metadata.

## Deployment choices

- **Cloudflare multi-account mode** — recommended for a shared, highly available gateway with a web UI and centralized account pool.
- **Local Go mode** — useful for one-machine workflows, local MCP support, and independent XDG/keychain credential storage.

The Cloudflare multi-account edition is deployed from this repository. The package-manager commands below install the original local Go proxy mode.

## Install

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

The Worker uses the account-wide Workers VPC Network (`network_id = "cf1:network"`). Tunnel Hostname routes for `chatgpt.com` and `auth.openai.com` point to a named Cloudflare Tunnel. The tunnel connector runs only the official `cloudflare/cloudflared` image on the selected exit node, so model traffic, device login, and token refresh leave through that node without a custom relay application. Worker code also enforces the same two-host allowlist.

Required and optional secrets:

- `INTERNAL_PROXY_KEY` — required internal trust boundary between the TypeScript edge and embedded Go/Wasm Core.
- `KEY_ENCRYPTION_SECRET` — strongly recommended as a dedicated key-encryption secret; otherwise `INTERNAL_PROXY_KEY` is used as the fallback.
- `ADMIN_EMAIL` — recommended when the dashboard is protected by Cloudflare Access.
- `ADMIN_API_KEY` — optional fallback for admin login without an Access identity header.
- `PROXY_API_KEY` — optional legacy client key; new deployments should generate multiple managed keys in the UI.

Connect the named Cloudflare Tunnel, add both Tunnel Hostname routes, then deploy the single Worker:

```bash
cd edge
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put INTERNAL_PROXY_KEY
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler deploy
```

Open `/`, authenticate through Cloudflare Access (or the optional `ADMIN_API_KEY` fallback), generate a proxy API key, and paste a Codex `auth.json`, the legacy Cloudflare credential JSON, or a flat credential object. The proxy endpoints accept the generated key as a bearer token or `X-API-Key`.

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
curl -X POST http://localhost:9879/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```
