import { describe, expect, it, vi } from "vitest";
import { worker } from "../src/index";
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
  accountIds?: string[];
  coreOrigin?: string;
}) {
  const accountIds = options.accountIds ?? ["a"];
  const reports: Array<{ id: string; status: number }> = [];
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
      if (url.pathname === "/verify-proxy") {
        const { key } = await request.json() as { key?: string };
        return Response.json({ valid: key === "proxy-secret" });
      }
      if (url.pathname === "/accounts") return Response.json({ accounts: [{ id: "a", name: "A", accountId: "upstream-a" }] });
      return Response.json({ ok: true });
    },
  };
  return {
    reports,
    env: {
      ACCOUNT_POOL: { idFromName: () => ({}) as DurableObjectId, get: () => stub as unknown as DurableObjectStub },
      PROXY_SERVICE: options.service ? { fetch: options.service } : undefined,
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

  it("provides navigable account, model, key, and settings sections", () => {
    for (const view of ["home", "accounts", "models", "keys", "settings"]) {
      expect(ADMIN_HTML).toContain(`data-view="${view}"`);
      expect(ADMIN_HTML).toContain(`data-page="${view}"`);
    }
    expect(ADMIN_HTML).toContain("function switchView(view)");
  });

  it("renders quota refresh and live model catalog controls", () => {
    expect(ADMIN_HTML).toContain("/admin/api/accounts/usage");
    expect(ADMIN_HTML).toContain("剩余额度");
    expect(ADMIN_HTML).toContain("/admin/api/models");
    expect(ADMIN_HTML).toContain("可用模型");
    expect(ADMIN_HTML).toContain("Workspace · ");
    expect(ADMIN_HTML).toContain("a.email||a.principalId");
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

  it("fails over after a rate limit and reports cooldown outcomes", async () => {
    const service = vi.fn(async (request: Request) => {
      const account = request.headers.get("x-codex-account-id");
      return account === "upstream-a"
        ? new Response("limited", { status: 429, headers: { "retry-after": "30" } })
        : Response.json({ ok: true });
    });
    const { env, reports } = environment({ service, accountIds: ["a", "b"] });
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
    expect(await response.json()).toEqual({ ok: true });
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

  it("preserves streaming bodies", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const { env } = environment({ service: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
    const { ctx, waits } = context();
    const response = await worker.fetch(new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer proxy-secret", "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    }), env as never, ctx);
    await Promise.all(waits);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\ndata: [DONE]\n\n");
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
