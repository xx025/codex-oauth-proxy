# ECRelay

English | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/ecrelay)

> **100% Cloudflare Serverless AI Gateway**: Zero VPS, zero Docker, zero external database. Runs entirely on Cloudflare Workers and Durable Objects.

Route ChatGPT OAuth, Antigravity accounts, and custom OpenAI-compatible upstreams through a single API on Cloudflare Workers.

Use it to expose `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/mcp` while managing built-in accounts and custom upstreams from one unified serverless administration UI.

> This project uses an unofficial upstream interface. Use only accounts you control and follow the applicable terms.

## Cloudflare Serverless Architecture

- **100% Serverless Runtime**: No traditional servers, VPS, or containers to maintain. Deploys seamlessly to Cloudflare's global edge network.
- **Durable Objects Native Storage**: Distributed state persistence, multi-account rotation, quota tracking, and concurrency coordination without external Redis or SQL databases.
- **Zero Cost & Instant Scale**: Fits within Cloudflare's free plan limits while providing auto-scaling and ultra-low latency worldwide.
- **Isolated VPC Egress**: Enforces secure outbound routing via Cloudflare VPC / Tunnel (`NATIVE_EGRESS`) to bypass IP blocking and protect upstream credentials.

## Demo

- Test site: <https://ecrelay.vktest.workers.dev/>
- Password: `admin`

Do not enter private information, personal tokens, production API keys, or accounts you care about on the public demo site.

## Deploy

Click the button below to deploy the Worker directly to Cloudflare. No local download, Node.js installation, or CLI command is required.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/ecrelay)

### Quick Setup

1. Click **Deploy to Cloudflare** above to create the Worker.
2. In Cloudflare Dashboard, configure:
   - **Build variable** `CLOUDFLARE_TUNNEL_ID`: your Cloudflare Tunnel/VPC egress ID under **Settings > Build > Build variables and secrets**.
   - **Worker secret** `KEY_ENCRYPTION_SECRET`: a random secret, e.g. `openssl rand -hex 32` under **Settings > Variables and Secrets**.
   - **Worker secret** `ADMIN_API_KEY`: optional admin password if not using Cloudflare Access.
3. Retry the deployment. Durable Objects and VPC egress will be configured automatically.

For GitHub Actions CI/CD and detailed instructions, see the [full deployment guide](docs/deployment.md).

## Features

- OpenAI-compatible `/v1/models`, `/v1/chat/completions`, and `/v1/responses`
- ChatGPT OAuth and Antigravity account management
- Custom OpenAI-compatible APIs with model discovery and fallback
- Multi-account rotation, token refresh, cooldown, and failover
- Streaming responses, client API keys, statistics, and model tests
- 100% Cloudflare Workers + Durable Objects with mandatory VPC egress

## Screenshot

![Administration UI](docs/image.png)

## Use

Open the admin UI to add ChatGPT or Antigravity accounts, connect a custom OpenAI-compatible API, and create a client API key. Built-in providers are preferred; enabled custom APIs can serve exclusive models or act as priority-ordered fallbacks. The **Models** page supports single-model and batch availability tests.

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Local Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Acknowledgements

This project was built with reference and inspiration from the following open-source projects:

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)
- [dvcrn/codex-oauth-proxy](https://github.com/dvcrn/codex-oauth-proxy)

Special thanks to **Cloudflare** for providing generous free tier services and developer platform capabilities.

## License

[MIT](LICENSE)
