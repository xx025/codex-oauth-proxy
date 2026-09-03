import { DurableObject } from "cloudflare:workers";
import { AccountPoolCore, AccountProvider, PoolError, PoolSettings, PoolState, RequestRecordInput, parseImportPayload } from "./pool";
import {
  BrowserLoginSession,
  DeviceLoginSession,
  beginBrowserLogin,
  beginDeviceLogin,
  completeBrowserLogin,
  pollDeviceLogin,
  publicBrowserLogin,
  publicDeviceLogin,
} from "./oauth";
import { ADMIN_ASSETS, ADMIN_HTML, FAVICON_SVG } from "./ui";
import { createUpstreamFetch } from "./egress";
import { RequestMetadata, emptyTokenUsage, readTokenUsage } from "./metrics";
import { antigravityModelCatalog, finalizeUpstreamResponse, prepareProxyRequest, prepareSelectedUpstreamRequest, readRequestBody, SelectedUpstreamAccount } from "./api";
import { handleMcp } from "./mcp";
import {
  AntigravityLoginSession,
  beginAntigravityLogin,
  completeAntigravityLogin,
  publicAntigravityLogin,
} from "./antigravity-auth";

interface Env {
  ACCOUNT_POOL: DurableObjectNamespace<AccountPool>;
  PROXY_EXECUTOR: DurableObjectNamespace<ProxyExecutor>;
  NATIVE_EGRESS: Fetcher;
  ADMIN_API_KEY?: string;
  KEY_ENCRYPTION_SECRET: string;
}

const SESSION_COOKIE = "codex_admin";
const SESSION_MAX_AGE = 8 * 60 * 60;
const MODEL_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const MODEL_CATALOG_CACHE_KEY = "model-catalog-cache";
const MAX_RETRY_RESPONSE_BYTES = 64 * 1024;
const PROXY_EXECUTOR_SHARDS = 32;
const encoder = new TextEncoder();

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;

interface ModelCatalogCache {
  status: number;
  body: string;
  contentType?: string;
  createdAt: number;
  expiresAt: number;
}

export class AccountPool extends DurableObject<Env> {
  private readonly core: AccountPoolCore;
  private upstreamFetch?: typeof fetch;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.core = new AccountPoolCore({
      get: () => this.ctx.storage.get<PoolState>("pool"),
      put: (value) => this.ctx.storage.put("pool", value),
    }, (input, init) => this.fetchUpstream(input, init), Date.now, env.KEY_ENCRYPTION_SECRET);
  }

  private fetchUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.upstreamFetch ??= createUpstreamFetch(this.env);
    return this.upstreamFetch(input, init);
  }

  fetch(request: Request): Promise<Response> {
    const operation = this.tail.then(() => this.handle(request));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/accounts" && request.method === "GET") {
        return json({ accounts: await this.core.list() });
      }
      if (url.pathname === "/accounts" && request.method === "POST") {
        const account = await this.core.importAccount(parseImportPayload(await request.json()));
        return json({ account }, 201);
      }
      if (url.pathname === "/accounts/usage" && request.method === "POST") {
        return json({ accounts: await this.core.refreshUsage() });
      }
      if (url.pathname === "/settings" && request.method === "GET") {
        return json({ settings: await this.core.getSettings() });
      }
      if (url.pathname === "/settings" && request.method === "PATCH") {
        return json({ settings: await this.core.updateSettings(await request.json()) });
      }
      if (url.pathname === "/request-stats" && request.method === "GET") {
        return json(await this.core.requestStats());
      }
      if (url.pathname === "/request-records" && request.method === "POST") {
        await this.core.recordRequest(await request.json());
        return json({ ok: true }, 201);
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "GET") {
        const cache = await this.ctx.storage.get<ModelCatalogCache>(MODEL_CATALOG_CACHE_KEY);
        if (!cache || (cache.expiresAt > 0 && cache.expiresAt <= Date.now())) {
          if (cache) await this.ctx.storage.delete(MODEL_CATALOG_CACHE_KEY);
          return new Response(null, { status: 204 });
        }
        const headers = new Headers({
          "content-type": cache.contentType || "application/json; charset=utf-8",
          "cache-control": cache.expiresAt > 0
            ? `private, max-age=${Math.max(0, Math.floor((cache.expiresAt - Date.now()) / 1000))}`
            : "private, max-age=86400",
          "x-codex-model-cache": "hit",
          "x-codex-model-cache-created-at": String(cache.createdAt),
        });
        return new Response(cache.body, { status: cache.status, headers });
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "PUT") {
        const payload = await request.json() as Partial<ModelCatalogCache>;
        const status = payload.status;
        if (typeof payload.body !== "string" || typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 299) {
          throw new PoolError(400, "Invalid model catalog cache payload");
        }
        const now = Date.now();
        await this.ctx.storage.put(MODEL_CATALOG_CACHE_KEY, {
          status,
          body: payload.body,
          contentType: payload.contentType || "application/json; charset=utf-8",
          createdAt: now,
          expiresAt: 0,
        } satisfies ModelCatalogCache);
        return json({ ok: true }, 201);
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "DELETE") {
        await this.ctx.storage.delete(MODEL_CATALOG_CACHE_KEY);
        return json({ ok: true });
      }
      if (url.pathname === "/oauth/device/start" && request.method === "POST") {
        const { name } = await request.json() as { name?: string };
        await this.pruneDeviceLogins();
        const session = await beginDeviceLogin((input, init) => this.fetchUpstream(input, init), Date.now, name);
        await this.ctx.storage.put(this.deviceLoginKey(session.id), session);
        return json({ login: publicDeviceLogin(session) }, 201);
      }
      if (url.pathname === "/oauth/browser/start" && request.method === "POST") {
        const { name } = await request.json() as { name?: string };
        await this.pruneBrowserLogins();
        const session = await beginBrowserLogin(Date.now, name);
        await this.ctx.storage.put(this.browserLoginKey(session.id), session);
        return json({ login: publicBrowserLogin(session) }, 201);
      }
      if (url.pathname === "/oauth/antigravity/start" && request.method === "POST") {
        const { name } = await request.json() as { name?: string };
        await this.pruneAntigravityLogins();
        const session = beginAntigravityLogin(Date.now, name);
        await this.ctx.storage.put(this.antigravityLoginKey(session.id), session);
        return json({ login: publicAntigravityLogin(session) }, 201);
      }
      const browserMatch = url.pathname.match(/^\/oauth\/browser\/([0-9a-f-]+)$/i);
      if (browserMatch && request.method === "POST") {
        const key = this.browserLoginKey(browserMatch[1]);
        const session = await this.ctx.storage.get<BrowserLoginSession>(key);
        if (!session) throw new PoolError(404, "Browser login session not found");
        const { callbackUrl } = await request.json() as { callbackUrl?: string };
        const credentials = await completeBrowserLogin(
          session,
          callbackUrl ?? "",
          (input, init) => this.fetchUpstream(input, init),
        );
        const account = await this.core.importAccount(credentials);
        await this.ctx.storage.delete(key);
        return json({ status: "complete", account });
      }
      if (browserMatch && request.method === "DELETE") {
        await this.ctx.storage.delete(this.browserLoginKey(browserMatch[1]));
        return json({ ok: true });
      }
      const deviceMatch = url.pathname.match(/^\/oauth\/device\/([0-9a-f-]+)$/i);
      if (deviceMatch && request.method === "POST") {
        const key = this.deviceLoginKey(deviceMatch[1]);
        const session = await this.ctx.storage.get<DeviceLoginSession>(key);
        if (!session) throw new PoolError(404, "Device login session not found");
        const result = await pollDeviceLogin(
          session,
          (input, init) => this.fetchUpstream(input, init),
        );
        if (result.pending) return json({ status: "pending" }, 202);
        const account = await this.core.importAccount(result.credentials);
        await this.ctx.storage.delete(key);
        return json({ status: "complete", account });
      }
      if (deviceMatch && request.method === "DELETE") {
        await this.ctx.storage.delete(this.deviceLoginKey(deviceMatch[1]));
        return json({ ok: true });
      }
      const antigravityMatch = url.pathname.match(/^\/oauth\/antigravity\/([0-9a-f-]+)$/i);
      if (antigravityMatch && request.method === "POST") {
        const key = this.antigravityLoginKey(antigravityMatch[1]);
        const session = await this.ctx.storage.get<AntigravityLoginSession>(key);
        if (!session) throw new PoolError(404, "Antigravity login session not found");
        const { callbackUrl = "" } = await request.json() as { callbackUrl?: string };
        const credentials = await completeAntigravityLogin(
          session,
          callbackUrl,
          (input, init) => this.fetchUpstream(input, init),
        );
        const account = await this.core.importAccount(credentials).catch(async (error) => {
          await this.ctx.storage.delete(key);
          const detail = error instanceof Error ? error.message : "Antigravity setup failed";
          throw new PoolError(
            error instanceof PoolError ? error.status : 502,
            `${detail}. The authorization code has already been consumed; start Antigravity sign-in again before retrying`,
          );
        });
        await this.ctx.storage.delete(key);
        return json({ status: "complete", account });
      }
      if (antigravityMatch && request.method === "DELETE") {
        await this.ctx.storage.delete(this.antigravityLoginKey(antigravityMatch[1]));
        return json({ ok: true });
      }
      const resetMatch = url.pathname.match(/^\/accounts\/([^/]+)\/reset$/);
      if (resetMatch && request.method === "POST") {
        return json({ account: await this.core.reset(resetMatch[1]) });
      }
      const match = url.pathname.match(/^\/accounts\/([^/]+)$/);
      if (match && request.method === "PATCH") {
        const patch = await request.json() as { name?: string; enabled?: boolean };
        return json({ account: await this.core.update(match[1], patch) });
      }
      if (match && request.method === "DELETE") {
        await this.core.remove(match[1]);
        return json({ ok: true });
      }
      if (url.pathname === "/select" && request.method === "POST") {
        const { excluded = [], provider = "codex" } = await request.json() as {
          excluded?: string[];
          provider?: AccountProvider;
        };
        return json({ account: await this.core.select(excluded, provider) });
      }
      if (url.pathname === "/report" && request.method === "POST") {
        const report = await request.json() as { id: string; status: number; retryAfterSeconds?: number };
        await this.core.report(report.id, report.status, report.retryAfterSeconds);
        return json({ ok: true });
      }
      if (url.pathname === "/proxy-keys" && request.method === "GET") {
        return json({ keys: await this.core.listProxyKeys() });
      }
      if (url.pathname === "/proxy-keys" && request.method === "POST") {
        const { name } = await request.json() as { name?: string };
        return json(await this.core.generateProxyKey(name), 201);
      }
      const keyMatch = url.pathname.match(/^\/proxy-keys\/([^/]+)$/);
      if (keyMatch && request.method === "DELETE") {
        return json({ key: await this.core.revokeProxyKey(keyMatch[1]) });
      }
      if (keyMatch && request.method === "PATCH") {
        const { name = "" } = await request.json() as { name?: string };
        return json({ key: await this.core.renameProxyKey(keyMatch[1], name) });
      }
      const revealMatch = url.pathname.match(/^\/proxy-keys\/([^/]+)\/reveal$/);
      if (revealMatch && request.method === "GET") {
        return json({ key: await this.core.revealProxyKey(revealMatch[1]) });
      }
      if (url.pathname === "/proxy-key" && request.method === "POST") {
        const generated = await this.core.generateProxyKey("Legacy client key");
        return json({ key: generated.key }, 201);
      }
      if (url.pathname === "/verify-proxy" && request.method === "POST") {
        const { key = "" } = await request.json() as { key?: string };
        return json({ valid: await this.core.verifyProxyKey(key) });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private deviceLoginKey(id: string): string {
    return `device-login:${id}`;
  }

  private browserLoginKey(id: string): string {
    return `browser-login:${id}`;
  }

  private antigravityLoginKey(id: string): string {
    return `antigravity-login:${id}`;
  }

  private async pruneDeviceLogins(): Promise<void> {
    const sessions = await this.ctx.storage.list<DeviceLoginSession>({ prefix: "device-login:" });
    const expired = [...sessions.entries()]
      .filter(([, session]) => session.expiresAt <= Date.now())
      .map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
  }

  private async pruneBrowserLogins(): Promise<void> {
    const sessions = await this.ctx.storage.list<BrowserLoginSession>({ prefix: "browser-login:" });
    const expired = [...sessions.entries()]
      .filter(([, session]) => session.expiresAt <= Date.now())
      .map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
  }

  private async pruneAntigravityLogins(): Promise<void> {
    const sessions = await this.ctx.storage.list<AntigravityLoginSession>({
      prefix: "antigravity-login:",
    });
    const expired = [...sessions.entries()]
      .filter(([, session]) => session.expiresAt <= Date.now())
      .map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
  }
}

export class ProxyExecutor extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (!isProxyRoute(pathname)) return json({ error: "Not found" }, 404);
      if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
        return await handleMcp(request, (apiRequest) => proxyWithFailover(apiRequest, this.env, this.ctx));
      }
      return await proxyWithFailover(request, this.env, this.ctx);
    } catch (error) {
      return errorResponse(error);
    }
  }
}

export const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ status: "ok" });
      }
      if ((url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") && request.method === "GET") {
        const headers = secureHeaders("image/svg+xml; charset=utf-8");
        headers.set("cache-control", "public, max-age=86400");
        return new Response(FAVICON_SVG, { headers });
      }
      const adminAsset = ADMIN_ASSETS[url.pathname];
      if (adminAsset && request.method === "GET") {
        const headers = secureHeaders(adminAsset.contentType);
        headers.set("cache-control", "no-cache");
        return new Response(adminAsset.body, { headers });
      }
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(ADMIN_HTML, { headers: secureHeaders("text/html; charset=utf-8") });
      }
      if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
        return redirect("/");
      }
      if (url.pathname.startsWith("/admin/api/")) {
        return await handleAdmin(request, env, ctx);
      }
      if (!isProxyRoute(url.pathname)) return json({ error: "Not found" }, 404);
      if (!await validProxyAuth(request, env)) return json({ error: "Unauthorized" }, 401);
      return await proxyExecutorStub(env, request).fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export default worker;

async function handleAdmin(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/api/session" && request.method === "POST") {
    enforceSameOrigin(request);
    const { key } = await request.json() as { key?: string };
    const accessIdentity = await validAccessIdentity(request);
    const keyIdentity = Boolean(key && env.ADMIN_API_KEY && await constantTimeEqual(key, env.ADMIN_API_KEY));
    if (!accessIdentity && !keyIdentity) return json({ error: "Unauthorized" }, 401);
    const cookie = await createSessionCookie(env.KEY_ENCRYPTION_SECRET);
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }
  if (url.pathname === "/admin/api/session" && request.method === "DELETE") {
    enforceSameOrigin(request);
    return json({ ok: true }, 200, {
      "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`,
    });
  }
  if (!await validAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "GET") enforceSameOrigin(request);

  if (url.pathname === "/admin/api/models" && request.method === "GET") {
    const upstreamURL = new URL("/v1/models", request.url);
    if (url.searchParams.get("refresh") === "1") upstreamURL.searchParams.set("refresh", "1");
    const upstreamRequest = new Request(upstreamURL, {
      headers: copySessionAffinityHeaders(request),
    });
    return cloneWithSecurityHeaders(await proxyExecutorStub(env, upstreamRequest).fetch(upstreamRequest));
  }

  const stub = accountPoolStub(env);
  const upstreamPath = url.pathname.replace("/admin/api", "") || "/";
  const response = await stub.fetch(new Request(`https://account-pool${upstreamPath}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  }));
  if (response.ok && request.method === "POST" && (upstreamPath === "/accounts" || upstreamPath.startsWith("/oauth/"))) {
    ctx.waitUntil((async () => {
      try {
        const refreshReq = new Request("https://internal/v1/models?refresh=1");
        await proxyExecutorStub(env, refreshReq).fetch(refreshReq);
      } catch {}
    })());
  }
  return cloneWithSecurityHeaders(response);
}

async function proxyWithFailover(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const modelCatalogRequest = request.method === "GET" && url.pathname === "/v1/models";
  if (url.pathname === "/v1/models" && request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (url.pathname !== "/v1/models" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const refreshModelCatalog = modelCatalogRequest && url.searchParams.get("refresh") === "1";
  if (modelCatalogRequest && !refreshModelCatalog) {
    const cached = await getModelCatalogCache(env);
    if (cached) return cloneWithSecurityHeaders(cached);
  }

  const settings = await loadPoolSettings(env);
  const requestBody = request.method === "GET" || request.method === "HEAD" ? undefined : await readRequestBody(request);
  let prepared = prepareProxyRequest(url.pathname, requestBody, { serviceTier: settings.serviceTier });
  const metadata: RequestMetadata = { model: prepared.model, endpoint: url.pathname.slice(0, 80), streaming: prepared.streaming };
  const excluded: string[] = [];
  let lastAttempt: { response: Response; accountId: string } | undefined;
  const upstreamFetch = createUpstreamFetch(env);

  for (let attempt = 0; attempt < settings.maxAccountAttempts; attempt += 1) {
    let account: SelectedUpstreamAccount & { id: string };
    try {
      account = await selectAccount(env, excluded, prepared.provider);
    } catch (error) {
      if (lastAttempt) return trackRequestResponse(
        stripInternalHeaders(lastAttempt.response), env, ctx, metadata, lastAttempt.accountId, startedAt,
      );
      if (modelCatalogRequest && error instanceof PoolError && error.status === 503) {
        const catalogResponse = Response.json(antigravityModelCatalog());
        const cachedBody = JSON.stringify(antigravityModelCatalog());
        ctx.waitUntil(putModelCatalogCache(env, catalogResponse, cachedBody));
        return trackRequestResponse(catalogResponse, env, ctx, metadata, "antigravity-catalog", startedAt);
      }
      throw error;
    }
    excluded.push(account.id);
    const upstreamRequest = prepareSelectedUpstreamRequest(request, prepared, account);
    const response = await upstreamFetch(upstreamRequest.url, upstreamRequest.init);
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    const shouldFailover = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
    const report = reportAccount(env, account.id, response.status, retryAfterSeconds);
    if (!shouldFailover || attempt === settings.maxAccountAttempts - 1) {
      ctx.waitUntil(report);
      const finalResponse = stripInternalHeaders(await finalizeUpstreamResponse(prepared, response));
      if (modelCatalogRequest && finalResponse.status >= 200 && finalResponse.status < 300) {
        const cachedBody = await finalResponse.clone().text();
        ctx.waitUntil(putModelCatalogCache(env, finalResponse, cachedBody));
      }
      return trackRequestResponse(finalResponse, env, ctx, metadata, account.id, startedAt);
    }
    await report;
    lastAttempt = { response: await snapshotRetryResponse(response), accountId: account.id };
  }
  return lastAttempt
    ? trackRequestResponse(stripInternalHeaders(lastAttempt.response), env, ctx, metadata, lastAttempt.accountId, startedAt)
    : json({ error: "No healthy accounts available" }, 503);
}

async function snapshotRetryResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  if (!response.body) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }

  const reader = response.body.getReader();
  const buffered = new Uint8Array(MAX_RETRY_RESPONSE_BYTES);
  let length = 0;
  let truncated = false;
  try {
    while (length < MAX_RETRY_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const available = MAX_RETRY_RESPONSE_BYTES - length;
      const retained = value.subarray(0, available);
      buffered.set(retained, length);
      length += retained.byteLength;
      if (retained.byteLength < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    if (length === MAX_RETRY_RESPONSE_BYTES && !truncated) {
      const { done } = await reader.read();
      if (!done) {
        truncated = true;
        await reader.cancel();
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (truncated) headers.delete("content-length");
  return new Response(buffered.subarray(0, length), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


async function getModelCatalogCache(env: Env): Promise<Response | undefined> {
  const response = await accountPoolStub(env).fetch("https://account-pool/model-catalog-cache");
  if (response.status === 204) return undefined;
  if (!response.ok) throw new PoolError(response.status, "Model catalog cache could not be loaded");
  return response;
}

async function putModelCatalogCache(env: Env, response: Response, body: string): Promise<void> {
  const stored = await accountPoolStub(env).fetch("https://account-pool/model-catalog-cache", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: response.status,
      contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
      body,
    }),
  });
  if (!stored.ok) throw new Error(`Model catalog cache storage failed (${stored.status})`);
}

function trackRequestResponse(
  response: Response,
  env: Env,
  ctx: WaitUntilContext,
  metadata: RequestMetadata,
  accountId: string,
  startedAt: number,
): Response {
  const contentType = response.headers.get("content-type") || "";
  const streaming = metadata.streaming || contentType.toLowerCase().includes("text/event-stream");
  if (!response.body) {
    ctx.waitUntil(recordCompletedRequest(env, {
      ...metadata,
      streaming,
      accountId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      usage: emptyTokenUsage(),
    }));
    return response;
  }

  const [clientBody, metricsBody] = response.body.tee();
  ctx.waitUntil(readTokenUsage(metricsBody, contentType).then((usage) => recordCompletedRequest(env, {
    ...metadata,
    streaming,
    accountId,
    status: response.status,
    durationMs: Date.now() - startedAt,
    usage,
  })));
  return new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function recordCompletedRequest(env: Env, record: RequestRecordInput): Promise<void> {
  const response = await accountPoolStub(env).fetch("https://account-pool/request-records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!response.ok) throw new Error(`Request metrics storage failed (${response.status})`);
}

async function loadPoolSettings(env: Env): Promise<PoolSettings> {
  const response = await accountPoolStub(env).fetch("https://account-pool/settings");
  const result = await response.json() as { settings?: PoolSettings; error?: string };
  if (!response.ok || !result.settings) {
    throw new PoolError(response.status, result.error || "Pool settings could not be loaded");
  }
  return result.settings;
}

async function selectAccount(
  env: Env,
  excluded: string[],
  provider: AccountProvider,
): Promise<SelectedUpstreamAccount & { id: string }> {
  const response = await accountPoolStub(env).fetch("https://account-pool/select", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excluded, provider }),
  });
  const result = await response.json() as {
    account?: SelectedUpstreamAccount & { id: string };
    error?: string;
  };
  if (!response.ok || !result.account) throw new PoolError(response.status, result.error || "Account selection failed", parseRetryAfter(response.headers.get("retry-after")));
  return result.account;
}

async function reportAccount(env: Env, id: string, status: number, retryAfterSeconds?: number): Promise<void> {
  await accountPoolStub(env).fetch("https://account-pool/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, status, retryAfterSeconds }),
  });
}

function accountPoolStub(env: Env): DurableObjectStub {
  return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("global"));
}

function proxyExecutorStub(env: Env, request: Request): DurableObjectStub<ProxyExecutor> {
  const affinity = request.headers.get("x-session-affinity") ||
    request.headers.get("x-session-id") || request.headers.get("session-id");
  const shard = affinity
    ? stableShard(affinity.slice(0, 256), PROXY_EXECUTOR_SHARDS)
    : crypto.getRandomValues(new Uint8Array(1))[0] % PROXY_EXECUTOR_SHARDS;
  return env.PROXY_EXECUTOR.getByName(`proxy-${shard}`);
}

function stableShard(value: string, shardCount: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % shardCount;
}

function copySessionAffinityHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["x-session-affinity", "x-session-id", "session-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function isProxyRoute(pathname: string): boolean {
  return pathname === "/v1/chat/completions" || pathname === "/v1/responses" ||
    pathname === "/v1/models" || pathname === "/mcp" || pathname.startsWith("/mcp/");
}

async function validAdmin(request: Request, env: Env): Promise<boolean> {
  if (await validAccessIdentity(request)) return true;
  const auth = request.headers.get("authorization");
  if (env.ADMIN_API_KEY && auth?.toLowerCase().startsWith("bearer ") && await constantTimeEqual(auth.slice(7), env.ADMIN_API_KEY)) return true;
  const cookie = parseCookies(request.headers.get("cookie") || "")[SESSION_COOKIE];
  return cookie ? verifySessionCookie(cookie, env.KEY_ENCRYPTION_SECRET) : false;
}

async function validProxyAuth(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("authorization");
  const candidate = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : request.headers.get("x-api-key") || "";
  if (!candidate) return false;
  const response = await accountPoolStub(env).fetch("https://account-pool/verify-proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: candidate }),
  });
  const result = await response.json() as { valid?: boolean };
  return response.ok && result.valid === true;
}

async function validAccessIdentity(request: Request): Promise<boolean> {
  const email = request.headers.get("cf-access-authenticated-user-email") || "";
  const assertion = request.headers.get("cf-access-jwt-assertion") || "";
  return email !== "" && assertion !== "";
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

async function createSessionCookie(secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const signature = await sign(String(expires), secret);
  return `${SESSION_COOKIE}=${expires}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MAX_AGE}`;
}

async function verifySessionCookie(value: string, secret: string): Promise<boolean> {
  const [expiresText, signature] = value.split(".");
  const expires = Number(expiresText);
  if (!expires || expires < Date.now() / 1000 || !signature) return false;
  return constantTimeEqual(signature, await sign(expiresText, secret));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function enforceSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new PoolError(403, "Invalid origin");
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=", 2)).filter(([key, value]) => key && value));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(1, Math.ceil((date - Date.now()) / 1000));
}

function stripInternalHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("x-codex-account-id");
  headers.delete("x-codex-access-token");
  headers.delete("x-codex-internal-key");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function cloneWithSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of secureHeaders().entries()) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function secureHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' https://st2.ai55.cc; frame-ancestors 'none'; base-uri 'none'; navigate-to 'self' https://github.com",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

function redirect(location: string, cookie?: string): Response {
  const headers = secureHeaders();
  headers.set("location", location);
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers = secureHeaders("application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof PoolError) {
    return json({ error: error.message }, error.status, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
  }
  return json({ error: "Internal server error" }, 500);
}
