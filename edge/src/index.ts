import { AccountPoolCore, PoolError, PoolSettings, PoolState, RequestRecordInput, parseImportPayload } from "./pool";
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
import { ADMIN_HTML, FAVICON_SVG } from "./ui";
import { fetchEmbeddedCore } from "./core";
import { createUpstreamFetch } from "./egress";
import { RequestMetadata, emptyTokenUsage, readTokenUsage, requestMetadata } from "./metrics";

interface Env {
  ACCOUNT_POOL: DurableObjectNamespace;
  // Optional test override. Production uses the embedded Go/Wasm Core.
  PROXY_SERVICE?: Fetcher;
  NATIVE_EGRESS?: Fetcher;
  ADMIN_API_KEY?: string;
  KEY_ENCRYPTION_SECRET: string;
}

const SESSION_COOKIE = "codex_admin";
const UI_COOKIE = "codex_ui";
const SESSION_MAX_AGE = 8 * 60 * 60;
const MODEL_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const MODEL_CATALOG_CACHE_KEY = "model-catalog-cache";
const encoder = new TextEncoder();

interface ModelCatalogCache {
  status: number;
  body: string;
  contentType?: string;
  createdAt: number;
  expiresAt: number;
}

export class AccountPool implements DurableObject {
  private readonly core: AccountPoolCore;
  private readonly upstreamFetch: typeof fetch;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, env: Env) {
    this.upstreamFetch = createUpstreamFetch(env);
    this.core = new AccountPoolCore({
      get: () => this.state.storage.get<PoolState>("pool"),
      put: (value) => this.state.storage.put("pool", value),
    }, this.upstreamFetch, Date.now, env.KEY_ENCRYPTION_SECRET);
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
        const cache = await this.state.storage.get<ModelCatalogCache>(MODEL_CATALOG_CACHE_KEY);
        if (!cache || cache.expiresAt <= Date.now()) {
          if (cache) await this.state.storage.delete(MODEL_CATALOG_CACHE_KEY);
          return new Response(null, { status: 204 });
        }
        const headers = new Headers({
          "content-type": cache.contentType || "application/json; charset=utf-8",
          "cache-control": `private, max-age=${Math.max(0, Math.floor((cache.expiresAt - Date.now()) / 1000))}`,
          "x-codex-model-cache": "hit",
          "x-codex-model-cache-created-at": String(cache.createdAt),
        });
        return new Response(cache.body, { status: cache.status, headers });
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "PUT") {
        const payload = await request.json() as Partial<ModelCatalogCache>;
        if (typeof payload.body !== "string" || !Number.isInteger(payload.status) || payload.status < 200 || payload.status > 299) {
          throw new PoolError(400, "Invalid model catalog cache payload");
        }
        const now = Date.now();
        await this.state.storage.put(MODEL_CATALOG_CACHE_KEY, {
          status: payload.status,
          body: payload.body,
          contentType: payload.contentType || "application/json; charset=utf-8",
          createdAt: now,
          expiresAt: now + MODEL_CATALOG_CACHE_TTL_MS,
        } satisfies ModelCatalogCache);
        return json({ ok: true }, 201);
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "DELETE") {
        await this.state.storage.delete(MODEL_CATALOG_CACHE_KEY);
        return json({ ok: true });
      }
      if (url.pathname === "/oauth/device/start" && request.method === "POST") {
        const { name } = await request.json() as { name?: string };
        await this.pruneDeviceLogins();
        const session = await beginDeviceLogin(this.upstreamFetch, Date.now, name);
        await this.state.storage.put(this.deviceLoginKey(session.id), session);
        return json({ login: publicDeviceLogin(session) }, 201);
      }
      if (url.pathname === "/oauth/browser/start" && request.method === "POST") {
        const { name } = await request.json() as { name?: string };
        await this.pruneBrowserLogins();
        const session = await beginBrowserLogin(Date.now, name);
        await this.state.storage.put(this.browserLoginKey(session.id), session);
        return json({ login: publicBrowserLogin(session) }, 201);
      }
      const browserMatch = url.pathname.match(/^\/oauth\/browser\/([0-9a-f-]+)$/i);
      if (browserMatch && request.method === "POST") {
        const key = this.browserLoginKey(browserMatch[1]);
        const session = await this.state.storage.get<BrowserLoginSession>(key);
        if (!session) throw new PoolError(404, "Browser login session not found");
        const { callbackUrl } = await request.json() as { callbackUrl?: string };
        const credentials = await completeBrowserLogin(session, callbackUrl ?? "", this.upstreamFetch);
        const account = await this.core.importAccount(credentials);
        await this.state.storage.delete(key);
        return json({ status: "complete", account });
      }
      if (browserMatch && request.method === "DELETE") {
        await this.state.storage.delete(this.browserLoginKey(browserMatch[1]));
        return json({ ok: true });
      }
      const deviceMatch = url.pathname.match(/^\/oauth\/device\/([0-9a-f-]+)$/i);
      if (deviceMatch && request.method === "POST") {
        const key = this.deviceLoginKey(deviceMatch[1]);
        const session = await this.state.storage.get<DeviceLoginSession>(key);
        if (!session) throw new PoolError(404, "Device login session not found");
        const result = await pollDeviceLogin(session, this.upstreamFetch);
        if (result.pending) return json({ status: "pending" }, 202);
        const account = await this.core.importAccount(result.credentials);
        await this.state.storage.delete(key);
        return json({ status: "complete", account });
      }
      if (deviceMatch && request.method === "DELETE") {
        await this.state.storage.delete(this.deviceLoginKey(deviceMatch[1]));
        return json({ ok: true });
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
        const { excluded = [] } = await request.json() as { excluded?: string[] };
        return json({ account: await this.core.select(excluded) });
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

  private async pruneDeviceLogins(): Promise<void> {
    const sessions = await this.state.storage.list<DeviceLoginSession>({ prefix: "device-login:" });
    const expired = [...sessions.entries()]
      .filter(([, session]) => session.expiresAt <= Date.now())
      .map(([key]) => key);
    if (expired.length) await this.state.storage.delete(expired);
  }

  private async pruneBrowserLogins(): Promise<void> {
    const sessions = await this.state.storage.list<BrowserLoginSession>({ prefix: "browser-login:" });
    const expired = [...sessions.entries()]
      .filter(([, session]) => session.expiresAt <= Date.now())
      .map(([key]) => key);
    if (expired.length) await this.state.storage.delete(expired);
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
      if (url.pathname === "/" && request.method === "GET") {
        const hasUiCookie = parseCookies(request.headers.get("cookie") || "")[UI_COOKIE] === "1";
        if (!hasUiCookie) return redirect("/admin?return=%2F");
        return new Response(ADMIN_HTML, { headers: secureHeaders("text/html; charset=utf-8") });
      }
      if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
        return redirect("/", `${UI_COOKIE}=1; Secure; SameSite=Strict; Path=/; Max-Age=31536000`);
      }
      if (url.pathname.startsWith("/admin/api/")) {
        return await handleAdmin(request, env, ctx);
      }
      if (!isProxyRoute(url.pathname)) return json({ error: "Not found" }, 404);
      if (!await validProxyAuth(request, env)) return json({ error: "Unauthorized" }, 401);
      return await proxyWithFailover(request, env, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export default worker;

async function handleAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    return cloneWithSecurityHeaders(await proxyWithFailover(new Request(upstreamURL), env, ctx));
  }

  const stub = accountPoolStub(env);
  const upstreamPath = url.pathname.replace("/admin/api", "") || "/";
  const response = await stub.fetch(new Request(`https://account-pool${upstreamPath}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  }));
  return cloneWithSecurityHeaders(response);
}

async function proxyWithFailover(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const modelCatalogRequest = request.method === "GET" && url.pathname === "/v1/models";
  const refreshModelCatalog = modelCatalogRequest && url.searchParams.get("refresh") === "1";
  if (modelCatalogRequest && !refreshModelCatalog) {
    const cached = await getModelCatalogCache(env);
    if (cached) return cloneWithSecurityHeaders(cached);
  }

  const requestBody = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const metadata = requestMetadata(url.pathname, requestBody);
  const excluded: string[] = [];
  let lastAttempt: { response: Response; accountId: string } | undefined;
  const settings = await loadPoolSettings(env);

  for (let attempt = 0; attempt < settings.maxAccountAttempts; attempt += 1) {
    let account: { id: string; accessToken: string; accountId: string };
    try {
      account = await selectAccount(env, excluded);
    } catch (error) {
      if (lastAttempt) return trackRequestResponse(
        stripInternalHeaders(lastAttempt.response), env, ctx, metadata, lastAttempt.accountId, startedAt,
      );
      throw error;
    }
    excluded.push(account.id);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${env.KEY_ENCRYPTION_SECRET}`);
    headers.delete("x-api-key");
    headers.set("x-codex-internal-key", env.KEY_ENCRYPTION_SECRET);
    headers.set("x-codex-access-token", account.accessToken);
    headers.set("x-codex-account-id", account.accountId);

    const response = await fetchCore(env, new Request(request.url, {
      method: request.method,
      headers,
      body: requestBody ? requestBody.slice(0) : undefined,
      redirect: "manual",
    }), ctx);
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    const shouldFailover = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
    const report = reportAccount(env, account.id, response.status, retryAfterSeconds);
    if (!shouldFailover || attempt === settings.maxAccountAttempts - 1) {
      ctx.waitUntil(report);
      const finalResponse = stripInternalHeaders(response);
      if (modelCatalogRequest && finalResponse.status >= 200 && finalResponse.status < 300) {
        const cachedBody = await finalResponse.clone().text();
        ctx.waitUntil(putModelCatalogCache(env, finalResponse, cachedBody));
      }
      return trackRequestResponse(finalResponse, env, ctx, metadata, account.id, startedAt);
    }
    await report;
    lastAttempt = { response: response.clone(), accountId: account.id };
    response.body?.cancel().catch(() => undefined);
  }
  return lastAttempt
    ? trackRequestResponse(stripInternalHeaders(lastAttempt.response), env, ctx, metadata, lastAttempt.accountId, startedAt)
    : json({ error: "No healthy accounts available" }, 503);
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
  ctx: ExecutionContext,
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

function fetchCore(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  if (env.PROXY_SERVICE) return env.PROXY_SERVICE.fetch(request);
  return fetchEmbeddedCore(request, env, ctx);
}

async function selectAccount(env: Env, excluded: string[]): Promise<{
  id: string; accessToken: string; accountId: string;
}> {
  const response = await accountPoolStub(env).fetch("https://account-pool/select", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excluded }),
  });
  const result = await response.json() as { account?: { id: string; accessToken: string; accountId: string }; error?: string };
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
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
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
