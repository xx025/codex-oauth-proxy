# ChatGPT OAuth API Proxy

English | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/codex-oauth-proxy)

Turn ChatGPT OAuth accounts into an OpenAI-compatible API on Cloudflare Workers.

Use it to expose `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/mcp` while managing upstream access with ChatGPT OAuth accounts.

> This project uses an unofficial upstream interface. Use only accounts you control and follow the applicable terms.

## Features

- OpenAI-compatible API endpoints
- ChatGPT OAuth login and account import
- Multi-account rotation, refresh, cooldown, and failover
- Streaming and non-streaming responses
- Built-in admin UI, client API keys, and request statistics
- Cloudflare Workers + Durable Objects only
- Mandatory Cloudflare VPC egress through `NATIVE_EGRESS`

## Screenshot

![Administration UI](docs/image.png)

## Deploy

Click the button above to deploy in your browser. No local download, Node.js install, or npm command is required.

You need:

- `CLOUDFLARE_TUNNEL_ID`: your Cloudflare Tunnel/VPC egress ID, used as a build variable
- `KEY_ENCRYPTION_SECRET`: a Worker secret, for example a random `openssl rand -hex 32` value
- `ADMIN_API_KEY`: optional Worker secret if the admin domain is not protected by Cloudflare Access

See [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md) for the Chinese deployment guide.

## Use

After deployment, open the Worker URL, add a ChatGPT OAuth account, and create a client API key.

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

Deploy from the command line:

```bash
npx wrangler secret put KEY_ENCRYPTION_SECRET
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

## License

[MIT](LICENSE)
