import { AccountPoolCore, PoolError, PoolState, parseImportPayload } from "./pool";
import { ADMIN_HTML } from "./ui";

interface Env {
  ACCOUNT_POOL: DurableObjectNamespace;
  PROXY_SERVICE: Fetcher;
  ADMIN_API_KEY?: string;
  PROXY_API_KEY?: string;
  ADMIN_EMAIL?: string;
  INTERNAL_PROXY_KEY: string;
  MAX_ACCOUNT_ATTEMPTS?: string;
}

const SESSION_COOKIE = "codex_admin";
const SESSION_MAX_AGE = 8 * 60 * 60;
const encoder = new TextEncoder();

export class AccountPool implements DurableObject {
  private readonly core: AccountPoolCore;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState) {
    this.core = new AccountPoolCore({
      get: () => this.state.storage.get<PoolState>("pool"),
      put: (value) => this.state.storage.put("pool", value),
    });
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
      if (url.pathname === "/proxy-key" && request.method === "POST") {
        return json({ key: await this.core.generateProxyKey() }, 201);
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
}

export const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ status: "ok" });
      }
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return new Response(ADMIN_HTML, { headers: secureHeaders("text/html; charset=utf-8") });
      }
      if (url.pathname.startsWith("/admin/api/")) {
        return await handleAdmin(request, env);
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

async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/api/session" && request.method === "POST") {
    enforceSameOrigin(request);
    const { key } = await request.json() as { key?: string };
    const accessIdentity = await validAccessIdentity(request, env.ADMIN_EMAIL);
    const keyIdentity = Boolean(key && env.ADMIN_API_KEY && await constantTimeEqual(key, env.ADMIN_API_KEY));
    if (!accessIdentity && !keyIdentity) return json({ error: "Unauthorized" }, 401);
    const cookie = await createSessionCookie(env.INTERNAL_PROXY_KEY);
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
  const maxAttempts = Math.max(1, Math.min(10, Number(env.MAX_ACCOUNT_ATTEMPTS || 3)));
  const requestBody = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const excluded: string[] = [];
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = await selectAccount(env, excluded);
    excluded.push(account.id);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${env.INTERNAL_PROXY_KEY}`);
    headers.delete("x-api-key");
    headers.set("x-codex-internal-key", env.INTERNAL_PROXY_KEY);
    headers.set("x-codex-access-token", account.accessToken);
    headers.set("x-codex-account-id", account.accountId);

    const response = await env.PROXY_SERVICE.fetch(new Request(request.url, {
      method: request.method,
      headers,
      body: requestBody ? requestBody.slice(0) : undefined,
      redirect: "manual",
    }));
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    const shouldFailover = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
    const report = reportAccount(env, account.id, response.status, retryAfterSeconds);
    if (!shouldFailover || attempt === maxAttempts - 1) {
      ctx.waitUntil(report);
      return stripInternalHeaders(response);
    }
    await report;
    response.body?.cancel().catch(() => undefined);
    lastResponse = response;
  }
  return lastResponse ? stripInternalHeaders(lastResponse) : json({ error: "No healthy accounts available" }, 503);
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
  if (await validAccessIdentity(request, env.ADMIN_EMAIL)) return true;
  const auth = request.headers.get("authorization");
  if (env.ADMIN_API_KEY && auth?.toLowerCase().startsWith("bearer ") && await constantTimeEqual(auth.slice(7), env.ADMIN_API_KEY)) return true;
  const cookie = parseCookies(request.headers.get("cookie") || "")[SESSION_COOKIE];
  return cookie ? verifySessionCookie(cookie, env.INTERNAL_PROXY_KEY) : false;
}

async function validProxyAuth(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("authorization");
  const candidate = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : request.headers.get("x-api-key") || "";
  if (!candidate) return false;
  if (env.PROXY_API_KEY && await constantTimeEqual(candidate, env.PROXY_API_KEY)) return true;
  const response = await accountPoolStub(env).fetch("https://account-pool/verify-proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: candidate }),
  });
  const result = await response.json() as { valid?: boolean };
  return response.ok && result.valid === true;
}

async function validAccessIdentity(request: Request, adminEmail?: string): Promise<boolean> {
  if (!adminEmail) return false;
  const email = request.headers.get("cf-access-authenticated-user-email") || "";
  return email !== "" && await constantTimeEqual(email.toLowerCase(), adminEmail.toLowerCase());
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
