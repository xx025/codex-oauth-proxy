import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPool } from "../src/index";
import {
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  ANTIGRAVITY_OAUTH_REDIRECT_URI,
} from "../src/antigravity-auth";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

function durableState() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((item) => values.delete(item));
      return keys.length;
    },
    list: async <T>({ prefix }: { prefix?: string } = {}) => new Map(
      [...values.entries()].filter(([key]) => !prefix || key.startsWith(prefix)),
    ) as Map<string, T>,
  };
  return { values, state: { storage } as unknown as DurableObjectState };
}

afterEach(() => vi.unstubAllGlobals());

describe("AccountPool device routes", () => {
  it("starts, completes, redacts, and deletes Antigravity login sessions", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url === "https://oauth2.googleapis.com/token")
        return Response.json({ access_token: "ag-access", refresh_token: "ag-refresh", expires_in: 3600 });
      if (request.url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo"))
        return Response.json({ id: "ag-user", email: "ag@example.com" });
      if (request.url.endsWith(":loadCodeAssist"))
        return Response.json({ cloudaicompanionProject: "ag-project" });
      return new Response(null, { status: 404 });
    });
    const { values, state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: upstream },
    } as never);
    const start = await object.fetch(new Request("https://pool/oauth/antigravity/start", {
      method: "POST",
      body: JSON.stringify({ name: "AG Account" }),
    }));
    const started = await start.json() as { login: { id: string; authorizationUrl: string } };
    const session = values.get(`antigravity-login:${started.login.id}`) as { state: string };
    expect(start.status).toBe(201);
    expect(JSON.stringify(started)).not.toContain(ANTIGRAVITY_OAUTH_CLIENT_SECRET);

    const complete = await object.fetch(new Request(`https://pool/oauth/antigravity/${started.login.id}`, {
      method: "POST",
      body: JSON.stringify({
        callbackUrl: `${ANTIGRAVITY_OAUTH_REDIRECT_URI}?state=${encodeURIComponent(session.state)}&code=ag-code`,
      }),
    }));
    const result = await complete.json() as { account: Record<string, unknown> };
    expect(complete.status).toBe(200);
    expect(result.account).toMatchObject({
      provider: "antigravity",
      name: "AG Account",
      projectId: "ag-project",
      email: "ag@example.com",
    });
    expect(JSON.stringify(result)).not.toMatch(/ag-access|ag-refresh|ag-code|GOCSPX/);
    expect(values.has(`antigravity-login:${started.login.id}`)).toBe(false);

    const second = await object.fetch(new Request("https://pool/oauth/antigravity/start", {
      method: "POST",
      body: "{}",
    }));
    const secondLogin = await second.json() as { login: { id: string } };
    const removed = await object.fetch(new Request(`https://pool/oauth/antigravity/${secondLogin.login.id}`, {
      method: "DELETE",
    }));
    expect(removed.status).toBe(200);
    expect(values.has(`antigravity-login:${secondLogin.login.id}`)).toBe(false);
  });

  it("normalizes legacy stored accounts to the Codex provider", async () => {
    const { values, state } = durableState();
    values.set("pool", {
      accounts: [
        {
          id: "legacy",
          name: "Legacy",
          enabled: true,
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: 4_000_000_000_000,
          accountId: "workspace",
          principalId: "user",
          createdAt: 1,
          updatedAt: 1,
          cooldownUntil: 0,
          failureCount: 0,
        },
      ],
      cursor: 0,
    });
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, init),
      },
    } as never);

    const response = await object.fetch(new Request("https://pool/accounts"));
    const result = (await response.json()) as {
      accounts: Array<Record<string, unknown>>;
    };

    expect(result.accounts[0]).toMatchObject({
      id: "legacy",
      provider: "codex",
      accountId: "workspace",
    });
    expect(result.accounts[0]).not.toHaveProperty("accessToken");
    expect(result.accounts[0]).not.toHaveProperty("refreshToken");
  });

  it("persists request records and exposes aggregate statistics", async () => {
    const { state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
    } as never);
    const recorded = await object.fetch(new Request("https://pool/request-records", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        endpoint: "/v1/responses",
        status: 200,
        durationMs: 9,
        streaming: false,
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedTokens: 1, available: true },
      }),
    }));
    expect(recorded.status).toBe(201);
    const response = await object.fetch(new Request("https://pool/request-stats"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totals: { requests: 1, totalTokens: 6 },
      models: [{ model: "gpt-5.6-sol", requests: 1, totalTokens: 6 }],
      recent: [{ model: "gpt-5.6-sol", endpoint: "/v1/responses", status: 200 }],
      retentionLimit: 200,
    });
  });

  it("persists runtime settings through Durable Object routes", async () => {
    const { state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
    } as never);
    const update = await object.fetch(new Request("https://pool/settings", {
      method: "PATCH",
      body: JSON.stringify({ selectionStrategy: "least_failures", maxAccountAttempts: 4, autoResetExhaustedAccounts: true }),
    }));
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ settings: { selectionStrategy: "least_failures", maxAccountAttempts: 4, autoResetExhaustedAccounts: true } });
    const read = await object.fetch(new Request("https://pool/settings"));
    expect(await read.json()).toMatchObject({ settings: { selectionStrategy: "least_failures", maxAccountAttempts: 4, autoResetExhaustedAccounts: true } });
  });

  it("renames accounts through Durable Object routes", async () => {
    const { state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
    } as never);
    const created = await object.fetch(new Request("https://pool/accounts", {
      method: "POST",
      body: JSON.stringify({
        name: "Original",
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiresAt: 10_000_000,
        accountId: "workspace",
        principalId: "user",
      }),
    }));
    const { account: imported } = await created.json() as { account: { id: string } };

    const renamed = await object.fetch(new Request(`https://pool/accounts/${imported.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    }));

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ account: { id: imported.id, name: "Renamed" } });
    const list = await object.fetch(new Request("https://pool/accounts"));
    expect(await list.json()).toMatchObject({ accounts: [{ id: imported.id, name: "Renamed" }] });
  });

  it("renames proxy keys through Durable Object routes", async () => {
    const { state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
    } as never);
    const created = await object.fetch(new Request("https://pool/proxy-keys", {
      method: "POST",
      body: JSON.stringify({ name: "Desktop" }),
    }));
    const { metadata } = await created.json() as { metadata: { id: string } };

    const renamed = await object.fetch(new Request(`https://pool/proxy-keys/${metadata.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Laptop" }),
    }));

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ key: { id: metadata.id, name: "Laptop" } });
    const list = await object.fetch(new Request("https://pool/proxy-keys"));
    expect(await list.json()).toMatchObject({ keys: [{ id: metadata.id, name: "Laptop" }] });
  });

  it("resets account quota through Durable Object routes", async () => {
    const { state } = durableState();
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: "reset", windows_reset: 1 }))
      .mockResolvedValueOnce(Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 1,
            limit_window_seconds: 18_000,
            reset_at: 4_000,
          },
          secondary_window: {
            used_percent: 1,
            limit_window_seconds: 604_800,
            reset_at: 4_000,
          },
        },
      }))
      .mockResolvedValueOnce(Response.json({ available_count: 2 }));
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: upstream },
    } as never);
    await object.fetch(new Request("https://pool/settings", {
      method: "PATCH",
      body: JSON.stringify({ tokenExpiryBufferMinutes: 5 }),
    }));
    const created = await object.fetch(new Request("https://pool/accounts", {
      method: "POST",
        body: JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiresAt: 4_000_000_000_000,
          accountId: "workspace",
          principalId: "user",
        }),
    }));
    const { account: imported } = await created.json() as { account: { id: string } };

    const reset = await object.fetch(new Request(`https://pool/accounts/${imported.id}/reset`, {
      method: "POST",
      body: "{}",
    }));

    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      account: {
        id: imported.id,
        lastResetStatus: "reset",
        resetCount: 1,
        usage: {
          primary: { remainingPercent: 99 },
          resetCreditsAvailable: 2,
        },
      },
    });
    expect((upstream.mock.calls[0][0] as Request).url).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    );
    expect((upstream.mock.calls[1][0] as Request).url).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
    expect((upstream.mock.calls[2][0] as Request).url).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    );
  });

  it("returns a successful reset when the follow-up usage refresh fails", async () => {
    const { state } = durableState();
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: "reset", windows_reset: 1 }))
      .mockResolvedValueOnce(Response.json({ rate_limit: {} }));
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: upstream },
    } as never);
    const created = await object.fetch(new Request("https://pool/accounts", {
      method: "POST",
      body: JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiresAt: 4_000_000_000_000,
        accountId: "workspace",
        principalId: "user",
      }),
    }));
    const { account } = await created.json() as { account: { id: string } };

    const reset = await object.fetch(new Request(`https://pool/accounts/${account.id}/reset`, {
      method: "POST",
      body: "{}",
    }));

    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      account: {
        lastResetStatus: "reset",
        resetCount: 1,
        usage: { error: "Usage refresh failed" },
      },
    });
  });

  it("persists a device login server-side, imports tokens, then removes the session", async () => {
    const idToken = jwt({ chatgpt_account_id: "account-device", email: "device@example.com", "https://api.openai.com/auth": { chatgpt_user_id: "user-device" }, exp: 4_000 });
    const accessToken = jwt({ exp: 3_600 });
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ device_auth_id: "private-handle", user_code: "CODE-1234", interval: "3" }))
      .mockResolvedValueOnce(Response.json({ authorization_code: "auth-code", code_challenge: "challenge", code_verifier: "verifier" }))
      .mockResolvedValueOnce(Response.json({ id_token: idToken, access_token: accessToken, refresh_token: "refresh-token" }));
    vi.stubGlobal("fetch", upstream);
    const { values, state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
    } as never);

    const start = await object.fetch(new Request("https://pool/oauth/device/start", {
      method: "POST",
      body: JSON.stringify({ name: "设备登录账号" }),
    }));
    const started = await start.json() as { login: { id: string; userCode: string } };
    expect(start.status).toBe(201);
    expect(started.login.userCode).toBe("CODE-1234");
    expect(JSON.stringify(started)).not.toContain("private-handle");
    expect([...values.keys()].some((key) => key.startsWith("device-login:"))).toBe(true);

    const complete = await object.fetch(new Request(`https://pool/oauth/device/${started.login.id}`, {
      method: "POST",
      body: "{}",
    }));
    const result = await complete.json() as { status: string; account: Record<string, unknown> };
    expect(result.status).toBe("complete");
    expect(result.account.accountId).toBe("account-device");
    expect(result.account.email).toBe("device@example.com");
    expect(result.account.principalId).toBe("user-device");
    expect(JSON.stringify(result)).not.toContain("refresh-token");
    expect([...values.keys()].some((key) => key.startsWith("device-login:"))).toBe(false);
    expect(JSON.stringify(values.get("pool"))).toContain("refresh-token");
  });

  it("persists a browser PKCE session and imports a pasted localhost callback", async () => {
    const idToken = jwt({ email: "browser@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "account-browser", chatgpt_user_id: "user-browser" }, exp: 4_000 });
    const accessToken = jwt({ exp: 3_600 });
    const upstream = vi.fn().mockResolvedValueOnce(Response.json({
      id_token: idToken,
      access_token: accessToken,
      refresh_token: "refresh-browser",
    }));
    vi.stubGlobal("fetch", upstream);
    const { values, state } = durableState();
    const object = new AccountPool(state, {
      KEY_ENCRYPTION_SECRET: "internal",
      NATIVE_EGRESS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
    } as never);

    const start = await object.fetch(new Request("https://pool/oauth/browser/start", {
      method: "POST",
      body: JSON.stringify({ name: "回调登录账号" }),
    }));
    const started = await start.json() as { login: { id: string; authorizationUrl: string } };
    const authorization = new URL(started.login.authorizationUrl);
    expect(start.status).toBe(201);
    expect(authorization.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(JSON.stringify(started)).not.toContain("codeVerifier");
    expect([...values.keys()].some((key) => key.startsWith("browser-login:"))).toBe(true);

    const callbackUrl = `http://localhost:1455/auth/callback?code=auth-code&state=${encodeURIComponent(authorization.searchParams.get("state") ?? "")}`;
    const complete = await object.fetch(new Request(`https://pool/oauth/browser/${started.login.id}`, {
      method: "POST",
      body: JSON.stringify({ callbackUrl }),
    }));
    const result = await complete.json() as { status: string; account: Record<string, unknown> };
    expect(complete.status).toBe(200);
    expect(result.account.accountId).toBe("account-browser");
    expect(result.account.email).toBe("browser@example.com");
    expect(result.account.principalId).toBe("user-browser");
    expect(JSON.stringify(result)).not.toContain("refresh-browser");
    expect([...values.keys()].some((key) => key.startsWith("browser-login:"))).toBe(false);
    expect(JSON.stringify(values.get("pool"))).toContain("refresh-browser");
  });
});
