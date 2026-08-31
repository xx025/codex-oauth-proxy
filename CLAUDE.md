# Repository Guide

This repository is a Cloudflare-only TypeScript application. Do not add a local application server, container deployment, native binary, WebAssembly runtime, or second implementation language. Preserve the required Cloudflare VPC egress binding.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run deploy
```

`npm run build` must remain a non-deploying Wrangler dry run.

## Architecture

- `src/index.ts` owns Worker routing and the `AccountPool` Durable Object.
- `src/api.ts` owns upstream request conversion, SSE conversion, and buffered responses.
- `src/pool.ts` owns persisted account and client-key state.
- `src/oauth.ts` owns OAuth and token refresh.
- `src/egress.ts` restricts VPC egress to approved HTTPS hosts and fails closed when the binding is missing.
- `src/mcp.ts` adapts stateless MCP requests to the public API.
- `src/ui.ts` contains the embedded administration UI.

## Constraints

- Keep production code compatible with the Workers runtime.
- Persist mutable cross-request state in Durable Object storage, not module globals.
- Keep secrets out of `wrangler.jsonc`; use Wrangler secrets.
- Keep `NATIVE_EGRESS` mandatory; never fall back to ordinary Worker egress.
- Preserve request-size and stream-event limits.
- Preserve upstream host allowlisting and credential redaction.
- Add or update Vitest coverage with behavioral changes.
