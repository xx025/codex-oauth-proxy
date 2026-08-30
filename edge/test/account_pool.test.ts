import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPool } from "../src/index";

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
  it("persists a device login server-side, imports tokens, then removes the session", async () => {
    const idToken = jwt({ chatgpt_account_id: "account-device", exp: 4_000 });
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
    expect(JSON.stringify(result)).not.toContain("refresh-token");
    expect([...values.keys()].some((key) => key.startsWith("device-login:"))).toBe(false);
    expect(JSON.stringify(values.get("pool"))).toContain("refresh-token");
  });
});
