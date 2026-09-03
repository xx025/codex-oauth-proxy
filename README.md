# ECRelay

English | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/ecrelay)

Route ChatGPT OAuth and Gemini CLI accounts through an OpenAI-compatible API on Cloudflare Workers.

Use it to expose `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/mcp` while managing upstream access with ChatGPT OAuth accounts.

> This project uses an unofficial upstream interface. Use only accounts you control and follow the applicable terms.

## Demo

- Test site: <https://ecrelay.vktest.workers.dev/>
- Password: `admin`

Do not enter private information, personal tokens, production API keys, or accounts you care about on the public demo site.

## Features

- OpenAI-compatible API endpoints
- ChatGPT OAuth login and account import
- Gemini CLI credential import, token refresh, and Code Assist routing
- Multi-account rotation, refresh, cooldown, and failover
- Streaming and non-streaming responses
- Built-in admin UI, client API keys, and request statistics
- Cloudflare Workers + Durable Objects only
- Mandatory Cloudflare VPC egress through `NATIVE_EGRESS`

## Screenshot

![Administration UI](docs/image.png)

## Deploy

Click the button above to create the Worker in your browser. No local download, Node.js install, or npm command is required.

Before retrying the first deployment, add these in the Cloudflare dashboard:

- Build variable `CLOUDFLARE_TUNNEL_ID`: your Cloudflare Tunnel/VPC egress ID
- Worker secret `KEY_ENCRYPTION_SECRET`: a random value, for example `openssl rand -hex 32`
- Optional Worker secret `ADMIN_API_KEY`: required only if the admin domain is not protected by Cloudflare Access

Durable Objects are created automatically during a successful Wrangler deployment. You do not need to create them manually.

Cloudflare's Deploy button does not currently show a Tunnel ID input during the initial setup. The first deployment can create the Worker without VPC egress; add `CLOUDFLARE_TUNNEL_ID` under **Settings > Build > Build variables and secrets**, then retry the deployment before using the API.

Need a VPC egress connector? See [cloudflared](https://github.com/xx025/cloudflared), a minimal `cloudflared` reference implementation that can be quickly deployed to Railway. For Cloudflare's official tunnel connector documentation, see [Run cloudflared as a service](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/).

See [docs/deployment.md](docs/deployment.md) for the full deployment guide.

## Use

After deployment, open the Worker URL, add a ChatGPT OAuth account, and create a client API key.

To add Gemini, sign in with the official Gemini CLI on a trusted computer and import the contents of `~/.gemini/oauth_creds.json` from the account import dialog. Select `Gemini CLI` as the provider. ECRelay discovers the Code Assist project and refreshes the Google token automatically.

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Gemini models use their normal Google model IDs without a custom prefix:

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Gemini CLI support uses the Code Assist `v1internal` service rather than the public Gemini API. Treat it as experimental and use only accounts you control.

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
