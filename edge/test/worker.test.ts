import { describe, expect, it, vi } from "vitest";
import { worker } from "../src/index";
import { ADMIN_HTML } from "../src/ui";

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
      PROXY_API_KEY: "proxy-secret",
      INTERNAL_PROXY_KEY: "internal-secret",
      MAX_ACCOUNT_ATTEMPTS: "3",
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

  it("provides four navigable management sections", () => {
    for (const view of ["home", "accounts", "keys", "settings"]) {
      expect(ADMIN_HTML).toContain(`data-view="${view}"`);
      expect(ADMIN_HTML).toContain(`data-page="${view}"`);
    }
    expect(ADMIN_HTML).toContain("function switchView(view)");
  });

  it("offers ChatGPT device login without exposing OAuth tokens to browser code", () => {
    expect(ADMIN_HTML).toContain("使用 ChatGPT 登录");
    expect(ADMIN_HTML).toContain("/admin/api/oauth/device/start");
    expect(ADMIN_HTML).toContain("一次性代码");
    expect(ADMIN_HTML).not.toContain("deviceAuthId");
    expect(ADMIN_HTML).not.toContain("/oauth/token");
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
