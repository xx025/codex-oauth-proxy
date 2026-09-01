# Deploy to Cloudflare

English | [简体中文](deployment.zh-CN.md)

Browser deployment is recommended. You do not need to download the repository or run npm locally.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/cloud-router)

## Requirements

- A Cloudflare account
- A Cloudflare Tunnel/VPC egress ID
- A random encryption secret, for example `openssl rand -hex 32`

Durable Objects are created automatically during a successful Wrangler deployment. You do not need to create them manually.

## VPC Egress Connector Reference

CloudRouter requires Cloudflare VPC egress through `NATIVE_EGRESS`. If you need a minimal tunnel connector, use [cloudflared](https://github.com/xx025/cloudflared) as a reference implementation. It focuses on `cloudflared` only and includes a Railway quick deploy shortcut.

Cloudflare's official `cloudflared` service documentation: [Run cloudflared as a service](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/).

## Steps

Click the button above to create the Worker project in Cloudflare.

Cloudflare's Deploy button does not currently show a Tunnel/VPC ID input during initial setup. The first deployment can create a Worker without VPC egress. After the project is created, add the settings below and redeploy.

Add a build variable:

- `CLOUDFLARE_TUNNEL_ID`: your Tunnel/VPC egress ID

Location: **Worker > Settings > Build > Build variables and secrets**

Add Worker secrets:

- `KEY_ENCRYPTION_SECRET`: the random encryption secret
- `ADMIN_API_KEY`: optional; set it if the admin domain is not protected by Cloudflare Access

Location: **Worker > Settings > Variables and Secrets**

Then return to the deployment page and click **Retry deployment**. API requests will not reach the upstream until the redeployment includes `NATIVE_EGRESS`.

Cloudflare will pull the repository, install dependencies, build the frontend, deploy the Worker, and create Durable Objects.

## After Deployment

Open the Worker URL:

```text
https://YOUR_WORKER_DOMAIN/
```

Then use the admin UI to:

- Add a ChatGPT OAuth account
- Create a client API key
- Call `/v1/models`, `/v1/chat/completions`, `/v1/responses`, or `/mcp`

Example:

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Command Line

Use the command line only for local development or custom deployment flows:

```bash
npm ci
npx wrangler login
npx wrangler secret put KEY_ENCRYPTION_SECRET
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run deploy
```

For development against Cloudflare's remote runtime and bindings:

```bash
CLOUDFLARE_TUNNEL_ID=YOUR_TUNNEL_ID npm run dev:remote
```
