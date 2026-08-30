import { describe, expect, it, vi } from "vitest";
import { worker } from "../src/index";
import { RequestRecordInput } from "../src/pool";
import { ADMIN_HTML, FAVICON_SVG } from "../src/ui";

function context() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

function environment(options: {
  service?: (request: Request) => Promise<Response>;
  nativeEgress?: (request: Request) => Promise<Response>;
  accountIds?: string[];
  coreOrigin?: string;
  settings?: Partial<{
    selectionStrategy: "round_robin" | "least_failures";
    maxAccountAttempts: number;
    tokenExpiryBufferMinutes: number;
    rateLimitCooldownSeconds: number;
    authCooldownSeconds: number;
    serverErrorCooldownSeconds: number;
  }>;
}) {
  const accountIds = options.accountIds ?? ["a"];
  const reports: Array<{ id: string; status: number }> = [];
  const records: RequestRecordInput[] = [];
  let modelCatalogCache: { status: number; body: string; contentType?: string; expiresAt: number; createdAt: number } | undefined;
  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/select") {
        const { excluded } = await request.json() as { excluded: string[] };
        const id = accountIds.find((candidate) => !excluded.includes(candidate));
        if (!id) return Response.json({ error: "No healthy accounts available" }, { status: 503 });
        return Response.json({ account: { id, accountId: `upstream-${id}`, accessToken: `token-${id}` } });
      }
      if (url.pathname === "/report") {
        reports.push(await request.json() as { id: string; status: number });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/request-records") {
        records.push(await request.json() as RequestRecordInput);
        return Response.json({ ok: true }, { status: 201 });
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "GET") {
        if (!modelCatalogCache || modelCatalogCache.expiresAt <= Date.now()) return new Response(null, { status: 204 });
        return new Response(modelCatalogCache.body, {
          status: modelCatalogCache.status,
          headers: {
            "content-type": modelCatalogCache.contentType || "application/json; charset=utf-8",
            "x-codex-model-cache": "hit",
          },
        });
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "PUT") {
        const payload = await request.json() as { status: number; body: string; contentType?: string };
        modelCatalogCache = { ...payload, createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000 };
        return Response.json({ ok: true }, { status: 201 });
      }
      if (url.pathname === "/model-catalog-cache" && request.method === "DELETE") {
        modelCatalogCache = undefined;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/request-stats") return Response.json({
        totals: { requests: records.length, successfulRequests: records.filter((item) => item.status < 400).length, failedRequests: records.filter((item) => item.status >= 400).length, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, meteredRequests: 0 },
        models: [],
        recent: records,
        retentionLimit: 200,
      });
      if (url.pathname === "/verify-proxy") {
        const { key } = await request.json() as { key?: string };
        return Response.json({ valid: key === "proxy-secret" });
      }
      if (url.pathname === "/settings") return Response.json({ settings: {
        selectionStrategy: "round_robin",
        maxAccountAttempts: 3,
        tokenExpiryBufferMinutes: 60,
        rateLimitCooldownSeconds: 60,
        authCooldownSeconds: 300,
        serverErrorCooldownSeconds: 15,
        ...options.settings,
      } });
      if (url.pathname === "/accounts") return Response.json({ accounts: [{ id: "a", name: "A", accountId: "upstream-a" }] });
      return Response.json({ ok: true });
    },
  };
  return {
    reports,
    records,
    env: {
      ACCOUNT_POOL: { idFromName: () => ({}) as DurableObjectId, get: () => stub as unknown as DurableObjectStub },
      PROXY_SERVICE: options.service ? { fetch: options.service } : undefined,
      NATIVE_EGRESS: options.nativeEgress ? { fetch: options.nativeEgress } : undefined,
      CORE_ORIGIN: options.coreOrigin,
      ADMIN_API_KEY: "admin-secret",
      KEY_ENCRYPTION_SECRET: "app-secret",
    },
  };
}

describe("edge worker", () => {
  it("boots Access from the root and returns the UI to the root path", async () => {
    const { env } = environment({ service: async () => new Response("unused") });
    const first = await worker.fetch(new Request("https://example.test/"), env as never, context().ctx);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/admin?return=%2F");

    const callback = await worker.fetch(new Request("https://example.test/admin?return=%2F"), env as never, context().ctx);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    expect(callback.headers.get("set-cookie")).toContain("codex_ui=1");

    const root = await worker.fetch(new Request("https://example.test/", {
      headers: { cookie: "codex_ui=1" },
    }), env as never, context().ctx);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("运行概览");
  });

  it("uses delegated account actions without interpolating inline handlers", () => {
    expect(ADMIN_HTML).toContain('data-action="toggle"');
    expect(ADMIN_HTML).toContain('button[data-action]');
    expect(ADMIN_HTML).not.toContain("onclick=\"toggleAccount(");
  });

  it("contains syntactically valid browser JavaScript", () => {
    const scripts = [...ADMIN_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, source] of scripts) expect(() => new Function(source)).not.toThrow();
  });

  it("renders the Fluent split-shell navigation and custom logo", () => {
    expect(ADMIN_HTML).toContain('class="app-frame hidden"');
    expect(ADMIN_HTML).toContain('class="sidebar"');
    expect(ADMIN_HTML).toContain('class="workspace"');
    expect(ADMIN_HTML).toContain('class="logo-mark"');
    expect(ADMIN_HTML).not.toContain('class="topbar"');
  });

  it("serves the branded SVG favicon with explicit caching", async () => {
    expect(ADMIN_HTML).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(FAVICON_SVG).toContain('viewBox="0 0 64 64"');
    const { env } = environment({ service: async () => new Response("unused") });
    const response = await worker.fetch(new Request("https://example.test/favicon.svg"), env as never, context().ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await response.text()).toContain("#0f6cbd");
  });

  it("provides navigable account, model, usage, key, and settings sections", () => {
    for (const view of ["home", "accounts", "models", "usage", "keys", "settings"]) {
      expect(ADMIN_HTML).toContain(`data-view="${view}"`);
      expect(ADMIN_HTML).toContain(`data-page="${view}"`);
    }
    expect(ADMIN_HTML).toContain("function switchView(view)");
  });

  it("orders the menu by workflow and mirrors every section on the home page", () => {
    expect(ADMIN_HTML).toContain("['home','accounts','keys','models','usage','settings']");
    for (const view of ["accounts", "keys", "models", "usage", "settings"]) {
      expect(ADMIN_HTML).toContain(`data-view-target="${view}"`);
    }
    for (const id of ["homeAccountsValue", "homeKeysValue", "homeModelsValue", "homeRequestsValue", "homeSettingsValue"]) {
      expect(ADMIN_HTML).toContain(`id="${id}"`);
    }
  });

  it("provides a remembered system, light, and dark theme without a server secret", () => {
    expect(ADMIN_HTML).toContain('id="themeSelect"');
    expect(ADMIN_HTML).toContain('<option value="system">跟随系统</option>');
    expect(ADMIN_HTML).toContain('<option value="dark">深色</option>');
    expect(ADMIN_HTML).toContain("localStorage.setItem('codex-theme',value)");
    expect(ADMIN_HTML).toContain('[data-theme=dark]');
  });

  it("uses dark-aware Fluent hover colors for interactive surfaces", () => {
    expect(ADMIN_HTML).toContain("--surface-hover:#303030");
    expect(ADMIN_HTML).toContain(".btn:hover{background:var(--surface-hover)");
    expect(ADMIN_HTML).toContain(".nav-item.active,.nav-item.active:hover");
    expect(ADMIN_HTML).toContain(".info-card:hover,.model-card:hover");
    expect(ADMIN_HTML).toContain(".account-row:hover,.key-row:hover,.data-table tbody tr:hover{background:var(--surface-hover)}");
  });

  it("renders request and token analytics without prompt or response content fields", () => {
    expect(ADMIN_HTML).toContain("/admin/api/request-stats");
    expect(ADMIN_HTML).toContain("按模型汇总");
    expect(ADMIN_HTML).toContain("最近请求");
    expect(ADMIN_HTML).toContain("Total Tokens");
    expect(ADMIN_HTML).not.toContain('item.prompt');
    expect(ADMIN_HTML).not.toContain('item.responseBody');
  });

  it("renders quota refresh and live model catalog controls", () => {
    expect(ADMIN_HTML).toContain("/admin/api/accounts/usage");
    expect(ADMIN_HTML).toContain("剩余额度");
    expect(ADMIN_HTML).toContain("/admin/api/models");
    expect(ADMIN_HTML).toContain("可用模型");
    expect(ADMIN_HTML).toContain("Workspace · ");
    expect(ADMIN_HTML).toContain("a.email||a.principalId");
    expect(ADMIN_HTML).toContain("modelFamily(model)");
    expect(ADMIN_HTML).toContain('class="model-group"');
  });

  it("provides editable persisted runtime settings without exposing secrets", () => {
    expect(ADMIN_HTML).toContain("/admin/api/settings");
    expect(ADMIN_HTML).toContain("saveSettings()");
    expect(ADMIN_HTML).toContain('id="selectionStrategy"');
    expect(ADMIN_HTML).toContain('id="maxAccountAttempts"');
    expect(ADMIN_HTML).not.toContain('id="keyEncryptionSecret"');
  });

  it("offers ChatGPT device login without exposing OAuth tokens to browser code", () => {
    expect(ADMIN_HTML).toContain("使用 ChatGPT 登录");
    expect(ADMIN_HTML).toContain("/admin/api/oauth/device/start");
    expect(ADMIN_HTML).toContain("一次性代码");
    expect(ADMIN_HTML).not.toContain("deviceAuthId");
    expect(ADMIN_HTML).not.toContain("/oauth/token");
  });

  it("offers PKCE callback URL login as a device-code fallback", () => {
    expect(ADMIN_HTML).toContain("复制链接登录");
    expect(ADMIN_HTML).toContain("/admin/api/oauth/browser/start");
    expect(ADMIN_HTML).toContain("http://localhost:1455/auth/callback?code=");
    expect(ADMIN_HTML).toContain("完成导入");
    expect(ADMIN_HTML).not.toContain("codeVerifier");
  });
  it("rejects unauthenticated proxy and admin API requests", async () => {
    const { env } = environment({ service: async () => new Response("unused") });
    const proxyResponse = await worker.fetch(new Request("https://example.test/v1/models"), env as never, context().ctx);
    const adminResponse = await worker.fetch(new Request("https://example.test/admin/api/accounts"), env as never, context().ctx);
    expect(proxyResponse.status).toBe(401);
    expect(adminResponse.status).toBe(401);
  });

  it("returns admin metadata without stored tokens", async () => {
    const { env } = environment({ service: async () => new Response("unused") });
    const response = await worker.fetch(new Request("https://example.test/admin/api/accounts", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, context().ctx);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("upstream-a");
    expect(text).not.toContain("token-a");
  });

  it("accepts identities already authorized by Cloudflare Access", async () => {
    const { env } = environment({ service: async () => new Response("unused") });
    const response = await worker.fetch(new Request("https://example.test/admin/api/accounts", {
      headers: {
        "cf-access-authenticated-user-email": "admin@example.test",
        "cf-access-jwt-assertion": "header.payload.signature",
      },
    }), env as never, context().ctx);
    expect(response.status).toBe(200);
  });

  it("returns the live model catalog through the protected admin API", async () => {
    const service = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/v1/models");
      expect(request.headers.get("x-codex-account-id")).toBe("upstream-a");
      return Response.json({ data: [{ id: "gpt-5.6-sol", object: "model" }] });
    });
    const { env } = environment({ service });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/admin/api/models", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, ctx);
    await Promise.all(waits);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "gpt-5.6-sol", object: "model" }] });
  });

  it("caches successful model catalogs and refreshes them on demand", async () => {
    let upstreamCalls = 0;
    const service = vi.fn(async () => {
      upstreamCalls += 1;
      return Response.json({ data: [{ id: `model-${upstreamCalls}`, object: "model" }] });
    });
    const { env } = environment({ service });

    const firstContext = context();
    const first = await worker.fetch(new Request("https://example.test/admin/api/models", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, firstContext.ctx);
    await Promise.all(firstContext.waits);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: [{ id: "model-1", object: "model" }] });

    const second = await worker.fetch(new Request("https://example.test/admin/api/models", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, context().ctx);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-codex-model-cache")).toBe("hit");
    expect(await second.json()).toEqual({ data: [{ id: "model-1", object: "model" }] });
    expect(service).toHaveBeenCalledTimes(1);

    const refreshContext = context();
    const refreshed = await worker.fetch(new Request("https://example.test/admin/api/models?refresh=1", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, refreshContext.ctx);
    await Promise.all(refreshContext.waits);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual({ data: [{ id: "model-2", object: "model" }] });
    expect(service).toHaveBeenCalledTimes(2);
  });

  it("fails over after a rate limit and reports cooldown outcomes", async () => {
    const service = vi.fn(async (request: Request) => {
      const account = request.headers.get("x-codex-account-id");
      return account === "upstream-a"
        ? new Response("limited", { status: 429, headers: { "retry-after": "30" } })
        : Response.json({ ok: true });
    });
    const { env, reports, records } = environment({ service, accountIds: ["a", "b"] });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: "{}",
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([{ id: "a", status: 429, retryAfterSeconds: 30 }, { id: "b", status: 200 }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: "unknown", endpoint: "/v1/responses", status: 200, accountId: "b" });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("bypasses the embedded core for large Codex responses requests", async () => {
    const core = vi.fn(async () => new Response("core should not be called", { status: 500 }));
    const nativeEgress = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(request.headers.get("authorization")).toBe("Bearer token-a");
      expect(request.headers.get("chatgpt-account-id")).toBe("upstream-a");
      expect(request.headers.get("version")).toBe("0.151.0-alpha.7.2");
      const body = await request.json() as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
      expect(body.max_output_tokens).toBeUndefined();
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const { env, records } = environment({ service: core, nativeEgress });
    delete (env as { PROXY_SERVICE?: Fetcher }).PROXY_SERVICE;
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-secret",
        "content-type": "application/json",
        "x-openai-internal-codex-responses-lite": "true",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        stream: false,
        max_output_tokens: 1000,
        input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(70 * 1024) }] }],
      }),
    }), env as never, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: [DONE]\n\n");
    await Promise.all(waits);
    expect(core).not.toHaveBeenCalled();
    expect(nativeEgress).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ endpoint: "/v1/responses", accountId: "a", status: 200 });
  });

  it("honors the configured maximum number of account attempts", async () => {
    const service = vi.fn(async () => new Response("limited", { status: 429 }));
    const { env, reports } = environment({
      service,
      accountIds: ["a", "b"],
      settings: { maxAccountAttempts: 1 },
    });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: "{}",
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.status).toBe(429);
    expect(service).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
  });

  it("preserves the last upstream error when no failover account remains", async () => {
    const { env, reports } = environment({ service: async () => new Response("upstream unavailable", { status: 502 }) });
    const response = await worker.fetch(new Request("https://example.test/v1/models", {
      headers: { authorization: "Bearer proxy-secret" },
    }), env as never, context().ctx);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("upstream unavailable");
    expect(reports).toEqual([{ id: "a", status: 502, retryAfterSeconds: undefined }]);
  });

  it("preserves streaming bodies and records response usage", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4,"total_tokens":15,"input_tokens_details":{"cached_tokens":2}}}}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const { env, records } = environment({ service: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe('data: one\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4,"total_tokens":15,"input_tokens_details":{"cached_tokens":2}}}}\n\ndata: [DONE]\n\n');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: "gpt-5.6-sol",
      endpoint: "/v1/chat/completions",
      status: 200,
      streaming: true,
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15, cachedTokens: 2, available: true },
    });
  });

  it("records non-streaming JSON token usage", async () => {
    const { env, records } = environment({ service: async () => Response.json({
      id: "response-id",
      usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
    }) });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", input: "not retained" }),
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.status).toBe(200);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: "gpt-5.6-terra",
      status: 200,
      usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30, available: true },
    });
    expect(JSON.stringify(records)).not.toContain("not retained");
  });

  it("passes public API requests to the in-process Core interface", async () => {
    const service = vi.fn(async (request: Request) => Response.json({ target: request.url }));
    const { env } = environment({ service, coreOrigin: "https://relay.example.test/" });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://public.example.test/v1/models", {
      headers: { authorization: "Bearer proxy-secret" },
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ target: "https://public.example.test/v1/models" });
  });
});
