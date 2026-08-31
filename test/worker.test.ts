import { describe, expect, it, vi } from "vitest";
import { ProxyExecutor, worker } from "../src/index";
import { RequestRecordInput } from "../src/pool";
import { ADMIN_ASSETS, ADMIN_HTML, FAVICON_SVG } from "../src/ui";

function context() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

function responsesStream(text = "ok", usage: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
} = { input_tokens: 11, output_tokens: 4, total_tokens: 15 }): Response {
  const events = [
    'data: {"type":"response.created","response":{"id":"resp_test"}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", model: "gpt-5.6-sol", output: [], usage } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
}

function modelsPayload(slug: string) {
  return { models: [{ slug, display_name: slug, visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }] };
}

function environment(options: {
  upstream: (request: Request) => Promise<Response>;
  accountIds?: string[];
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
  let env: {
    ACCOUNT_POOL: { idFromName: () => DurableObjectId; get: () => DurableObjectStub };
    PROXY_EXECUTOR: { getByName: (name: string) => DurableObjectStub<ProxyExecutor> };
    NATIVE_EGRESS: { fetch: (request: Request) => Promise<Response> };
    ADMIN_API_KEY: string;
    KEY_ENCRYPTION_SECRET: string;
  };
  const executorShards: string[] = [];
  const proxyExecutor = {
    getByName(name: string) {
      executorShards.push(name);
      return {
        async fetch(request: Request) {
          const waits: Promise<unknown>[] = [];
          const instance = new ProxyExecutor({
            waitUntil(promise: Promise<unknown>) { waits.push(promise); },
          } as unknown as DurableObjectState, env as never);
          const response = await instance.fetch(request);
          await Promise.all(waits);
          return response;
        },
      } as unknown as DurableObjectStub<ProxyExecutor>;
    },
  };
  env = {
    ACCOUNT_POOL: { idFromName: () => ({}) as DurableObjectId, get: () => stub as unknown as DurableObjectStub },
    PROXY_EXECUTOR: proxyExecutor,
    NATIVE_EGRESS: { fetch: options.upstream },
    ADMIN_API_KEY: "admin-secret",
    KEY_ENCRYPTION_SECRET: "app-secret",
  };
  return {
    reports,
    records,
    executorShards,
    env,
  };
}

describe("edge worker", () => {
  it("boots Access from the root and returns the UI to the root path", async () => {
    const { env } = environment({ upstream: async () => new Response("unused") });
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
    const html = await root.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain('/admin/assets/app.js');
    expect(html).toContain('/admin/assets/app.css');
    expect(root.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(root.headers.get("content-security-policy")).toContain("style-src 'self'");
  });

  it("serves the locally bundled Preact application from same-origin Worker routes", async () => {
    expect(ADMIN_HTML).not.toContain("cdn");
    expect(ADMIN_ASSETS["/admin/assets/app.js"].body.length).toBeGreaterThan(10_000);
    const { env } = environment({ upstream: async () => new Response("unused") });
    const script = await worker.fetch(new Request("https://example.test/admin/assets/app.js"), env as never, context().ctx);
    const style = await worker.fetch(new Request("https://example.test/admin/assets/app.css"), env as never, context().ctx);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("no-cache");
    expect(await script.text()).toBe(ADMIN_ASSETS["/admin/assets/app.js"].body);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await style.text()).toContain(".app-shell");
  });

  it("serves the branded SVG favicon with explicit caching", async () => {
    expect(ADMIN_HTML).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(FAVICON_SVG).toContain('viewBox="0 0 64 64"');
    const { env } = environment({ upstream: async () => new Response("unused") });
    const response = await worker.fetch(new Request("https://example.test/favicon.svg"), env as never, context().ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await response.text()).toContain("#0f6cbd");
  });

  it("bundles every hash-routed page and shared shell primitive", () => {
    const source = ADMIN_ASSETS["/admin/assets/app.js"].body;
    for (const view of ["home", "accounts", "keys", "models", "usage", "settings"]) expect(source).toContain(view);
    for (const title of ["运行概览", "账户池", "密钥", "可用模型", "请求统计", "其他设置"]) expect(source).toContain(title);
    expect(source).toContain("hashchange");
    expect(source).toContain("app-shell");
    expect(source).toContain("page-header");
    expect(source).toContain("panel");
  });

  it("provides a remembered system, light, and dark theme without a server secret", () => {
    const assets = ADMIN_HTML + ADMIN_ASSETS["/admin/assets/app.js"].body + ADMIN_ASSETS["/admin/assets/app.css"].body;
    expect(assets).toContain("codex-theme");
    expect(assets).toContain("跟随系统");
    expect(assets).toContain("深色");
    expect(assets).toContain("data-theme=dark");
    expect(assets).toContain("prefers-color-scheme:dark");
  });

  it("renders request and token analytics without prompt or response content fields", () => {
    const source = ADMIN_ASSETS["/admin/assets/app.js"].body;
    expect(source).toContain("/admin/api/request-stats");
    expect(source).toContain("按模型汇总");
    expect(source).toContain("最近请求");
    expect(source).toContain("Total Tokens");
    expect(source).not.toContain("prompt");
    expect(source).not.toContain("responseBody");
  });

  it("renders quota refresh and live model catalog controls", () => {
    const source = ADMIN_ASSETS["/admin/assets/app.js"].body;
    expect(source).toContain("/admin/api/accounts/usage");
    expect(source).toContain("刷新额度");
    expect(source).toContain("/admin/api/models");
    expect(source).toContain("可用模型");
    expect(source).toContain("Workspace · ");
  });

  it("provides editable persisted runtime settings without exposing secrets", () => {
    const source = ADMIN_ASSETS["/admin/assets/app.js"].body;
    expect(source).toContain("/admin/api/settings");
    expect(source).toContain("selectionStrategy");
    expect(source).toContain("maxAccountAttempts");
    expect(source).not.toContain("keyEncryptionSecret");
  });

  it("offers ChatGPT device login without exposing OAuth tokens to browser code", () => {
    const source = ADMIN_ASSETS["/admin/assets/app.js"].body;
    expect(source).toContain("使用 ChatGPT 登录");
    expect(source).toContain("/admin/api/oauth/");
    expect(source).toContain("一次性代码");
    expect(source).not.toContain("deviceAuthId");
    expect(source).not.toContain("/oauth/token");
  });

  it("offers PKCE callback URL login as a device-code fallback", () => {
    const source = ADMIN_ASSETS["/admin/assets/app.js"].body;
    expect(source).toContain("复制链接登录");
    expect(source).toContain("http://localhost:1455/auth/callback?code=");
    expect(source).toContain("完成导入");
    expect(source).not.toContain("codeVerifier");
  });
  it("rejects unauthenticated proxy and admin API requests", async () => {
    const { env } = environment({ upstream: async () => new Response("unused") });
    const proxyResponse = await worker.fetch(new Request("https://example.test/v1/models"), env as never, context().ctx);
    const adminResponse = await worker.fetch(new Request("https://example.test/admin/api/accounts"), env as never, context().ctx);
    expect(proxyResponse.status).toBe(401);
    expect(adminResponse.status).toBe(401);
  });

  it("returns admin metadata without stored tokens", async () => {
    const { env } = environment({ upstream: async () => new Response("unused") });
    const response = await worker.fetch(new Request("https://example.test/admin/api/accounts", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, context().ctx);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("upstream-a");
    expect(text).not.toContain("token-a");
  });

  it("accepts identities already authorized by Cloudflare Access", async () => {
    const { env } = environment({ upstream: async () => new Response("unused") });
    const response = await worker.fetch(new Request("https://example.test/admin/api/accounts", {
      headers: {
        "cf-access-authenticated-user-email": "admin@example.test",
        "cf-access-jwt-assertion": "header.payload.signature",
      },
    }), env as never, context().ctx);
    expect(response.status).toBe(200);
  });

  it("returns the live model catalog through the protected admin API", async () => {
    const upstream = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/backend-api/codex/models");
      expect(request.headers.get("chatgpt-account-id")).toBe("upstream-a");
      return Response.json(modelsPayload("gpt-5.6-sol"));
    });
    const { env } = environment({ upstream });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/admin/api/models", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, ctx);
    await Promise.all(waits);

    expect(response.status).toBe(200);
    const catalog = await response.json() as { data: Array<{ id: string; object: string }> };
    expect(catalog.data[0]).toMatchObject({ id: "gpt-5.6-sol", object: "model" });
  });

  it("caches successful model catalogs and refreshes them on demand", async () => {
    let upstreamCalls = 0;
    const upstream = vi.fn(async () => {
      upstreamCalls += 1;
      return Response.json(modelsPayload(`model-${upstreamCalls}`));
    });
    const { env } = environment({ upstream });

    const firstContext = context();
    const first = await worker.fetch(new Request("https://example.test/admin/api/models", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, firstContext.ctx);
    await Promise.all(firstContext.waits);
    expect(first.status).toBe(200);
    const firstCatalog = await first.json() as { data: Array<{ id: string; object: string }> };
    expect(firstCatalog.data[0]).toMatchObject({ id: "model-1", object: "model" });

    const second = await worker.fetch(new Request("https://example.test/admin/api/models", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, context().ctx);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-codex-model-cache")).toBe("hit");
    const secondCatalog = await second.json() as { data: Array<{ id: string; object: string }> };
    expect(secondCatalog.data[0]).toMatchObject({ id: "model-1", object: "model" });
    expect(upstream).toHaveBeenCalledTimes(1);

    const refreshContext = context();
    const refreshed = await worker.fetch(new Request("https://example.test/admin/api/models?refresh=1", {
      headers: { authorization: "Bearer admin-secret" },
    }), env as never, refreshContext.ctx);
    await Promise.all(refreshContext.waits);
    expect(refreshed.status).toBe(200);
    const refreshedCatalog = await refreshed.json() as { data: Array<{ id: string; object: string }> };
    expect(refreshedCatalog.data[0]).toMatchObject({ id: "model-2", object: "model" });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("fails over after a rate limit and reports cooldown outcomes", async () => {
    const upstream = vi.fn(async (request: Request) => {
      const account = request.headers.get("chatgpt-account-id");
      return account === "upstream-a"
        ? new Response("limited", { status: 429, headers: { "retry-after": "30" } })
        : responsesStream();
    });
    const { env, reports, records } = environment({ upstream, accountIds: ["a", "b"] });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: "{}",
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([{ id: "a", status: 429, retryAfterSeconds: 30 }, { id: "b", status: 200 }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: "gpt-5.5", endpoint: "/v1/responses", status: 200, accountId: "b" });
    expect(await response.json()).toMatchObject({ id: "resp_test", output: [{ type: "message" }] });
  });

  it("handles large non-streaming Responses requests without Wasm", async () => {
    const upstream = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(request.headers.get("authorization")).toBe("Bearer token-a");
      expect(request.headers.get("chatgpt-account-id")).toBe("upstream-a");
      expect(request.headers.get("version")).toBe("0.151.0-alpha.7.2");
      const body = await request.json() as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
      expect(body.max_output_tokens).toBeUndefined();
      return responsesStream();
    });
    const { env, records, executorShards } = environment({ upstream });
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
    expect(await response.json()).toMatchObject({ id: "resp_test" });
    await Promise.all(waits);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(executorShards).toHaveLength(1);
    expect(executorShards[0]).toMatch(/^proxy-\d+$/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ endpoint: "/v1/responses", accountId: "a", status: 200 });
  });

  it("proxies ordinary streaming Responses requests without Wasm", async () => {
    const upstream = vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      expect(body.stream).toBe(true);
      expect(body.input).toEqual([{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }]);
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const { env } = environment({ upstream });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "hello" }),
    }), env as never, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: [DONE]\n\n");
    await Promise.all(waits);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reuses the transformed request body across fast-path failover attempts", async () => {
    const bodies: string[] = [];
    const upstream = vi.fn(async (request: Request) => {
      bodies.push(await request.text());
      return bodies.length === 1
        ? new Response("limited", { status: 429, headers: { "retry-after": "30" } })
        : new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const { env, reports } = environment({
      upstream,
      accountIds: ["a", "b"],
    });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "retry me" }),
    }), env as never, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: [DONE]\n\n");
    await Promise.all(waits);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(reports).toEqual([{ id: "a", status: 429, retryAfterSeconds: 30 }, { id: "b", status: 200 }]);
  });

  it("honors the configured maximum number of account attempts", async () => {
    const upstream = vi.fn(async () => new Response("limited", { status: 429 }));
    const { env, reports } = environment({
      upstream,
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
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
  });

  it("preserves the last upstream error when no failover account remains", async () => {
    const { env, reports } = environment({ upstream: async () => new Response("upstream unavailable", { status: 502 }) });
    const response = await worker.fetch(new Request("https://example.test/v1/models", {
      headers: { authorization: "Bearer proxy-secret" },
    }), env as never, context().ctx);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("upstream unavailable");
    expect(reports).toEqual([{ id: "a", status: 502, retryAfterSeconds: undefined }]);
  });

  it("preserves streaming bodies and records response usage", async () => {
    const { env, records } = environment({ upstream: async () => responsesStream("one", { input_tokens: 11, output_tokens: 4, total_tokens: 15, input_tokens_details: { cached_tokens: 2 } }) });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const responseText = await response.text();
    expect(responseText).toContain('"content":"one"');
    expect(responseText).toContain('"finish_reason":"stop"');
    expect(responseText).toContain("data: [DONE]");
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
    const { env, records } = environment({ upstream: async () => responsesStream("done", {
      input_tokens: 21,
      output_tokens: 9,
      total_tokens: 30,
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

  it("routes public API requests directly to Cloudflare egress", async () => {
    const upstream = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/backend-api/codex/models");
      return Response.json(modelsPayload("gpt-5.6-sol"));
    });
    const { env } = environment({ upstream });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://public.example.test/v1/models", {
      headers: { authorization: "Bearer proxy-secret" },
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const catalog = await response.json() as { data: Array<{ id: string }> };
    expect(catalog.data[0]).toMatchObject({ id: "gpt-5.6-sol" });
  });

  it("serves stateless MCP discovery and model calls", async () => {
    const upstream = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/backend-api/codex/responses");
      return responsesStream("mcp answer");
    });
    const { env } = environment({ upstream });
    const initialize = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    }), env as never, context().ctx);
    expect(await initialize.json()).toMatchObject({ result: { serverInfo: { name: "ask-codex" }, capabilities: { tools: {} } } });

    const callContext = context();
    const called = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ask_codex", arguments: { model: "gpt-5.6-sol", prompt: "answer" } },
      }),
    }), env as never, callContext.ctx);
    await Promise.all(callContext.waits);
    expect(await called.json()).toMatchObject({
      result: { structuredContent: { requested_model: "gpt-5.6-sol", text: "mcp answer" }, isError: false },
    });
  });
});
