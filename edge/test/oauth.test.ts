import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_REDIRECT_URI,
  CODEX_OAUTH_CLIENT_ID,
  OPENAI_AUTH_BASE_URL,
  beginBrowserLogin,
  beginDeviceLogin,
  completeBrowserLogin,
  pollDeviceLogin,
  publicBrowserLogin,
  publicDeviceLogin,
} from "../src/oauth";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

describe("ChatGPT device login", () => {
  it("starts a short-lived device session without exposing the server handle", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      device_auth_id: "server-secret-handle",
      user_code: "ABCD-EFGH",
      interval: "5",
    }));
    const session = await beginDeviceLogin(fetcher as typeof fetch, () => 1_000, "备用账号");

    expect(fetcher).toHaveBeenCalledWith(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, expect.objectContaining({ method: "POST" }));
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request).toEqual({ client_id: CODEX_OAUTH_CLIENT_ID });
    expect(session.deviceAuthId).toBe("server-secret-handle");
    expect(session.expiresAt).toBe(901_000);
    expect(publicDeviceLogin(session)).not.toHaveProperty("deviceAuthId");
  });

  it("reports authorization pending without attempting a token exchange", async () => {
    const session = await beginDeviceLogin(vi.fn(async () => Response.json({
      device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: "3",
    })) as typeof fetch, () => 1_000);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 403 }));

    await expect(pollDeviceLogin(session, fetcher as typeof fetch, () => 2_000)).resolves.toEqual({ pending: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      device_auth_id: "device-id",
      user_code: "ABCD-EFGH",
    });
  });

  it("exchanges the authorization code and returns import-ready credentials", async () => {
    const session = await beginDeviceLogin(vi.fn(async () => Response.json({
      device_auth_id: "device-id", usercode: "ABCD-EFGH", interval: "5",
    })) as typeof fetch, () => 1_000, "主账号");
    const idToken = jwt({ chatgpt_account_id: "account-123", exp: 4_000 });
    const accessToken = jwt({ exp: 3_600 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        authorization_code: "authorization-secret",
        code_challenge: "challenge",
        code_verifier: "verifier-secret",
      }))
      .mockResolvedValueOnce(Response.json({
        id_token: idToken,
        access_token: accessToken,
        refresh_token: "refresh-secret",
      }));

    const result = await pollDeviceLogin(session, fetcher as typeof fetch, () => 2_000);
    expect(result).toEqual({
      pending: false,
      credentials: {
        name: "主账号",
        accessToken,
        refreshToken: "refresh-secret",
        accountId: "account-123",
        expiresAt: 3_600_000,
      },
    });
    expect(fetcher.mock.calls[1][0]).toBe(`${OPENAI_AUTH_BASE_URL}/oauth/token`);
    const form = new URLSearchParams(String(fetcher.mock.calls[1][1]?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "authorization-secret",
      redirect_uri: `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: "verifier-secret",
    });
  });

  it("explains when device login is disabled", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(beginDeviceLogin(fetcher as typeof fetch)).rejects.toMatchObject({
      status: 409,
      message: "Device code login is not enabled in ChatGPT security settings",
    });
  });
});

describe("ChatGPT callback URL login", () => {
  it("creates a PKCE authorization URL while keeping the verifier server-side", async () => {
    const session = await beginBrowserLogin(() => 1_000, "远程账号");
    const authorization = new URL(session.authorizationUrl);

    expect(authorization.origin + authorization.pathname).toBe(`${OPENAI_AUTH_BASE_URL}/oauth/authorize`);
    expect(authorization.searchParams.get("client_id")).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(authorization.searchParams.get("redirect_uri")).toBe(BROWSER_REDIRECT_URI);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("state")).toBe(session.state);
    expect(authorization.searchParams.get("code_challenge")).not.toBe(session.codeVerifier);
    expect(publicBrowserLogin(session)).not.toHaveProperty("codeVerifier");
    expect(publicBrowserLogin(session)).not.toHaveProperty("state");
  });

  it("validates the pasted callback state and exchanges its code", async () => {
    const session = await beginBrowserLogin(() => 1_000, "远程账号");
    const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-browser" }, exp: 4_000 });
    const accessToken = jwt({ exp: 3_600 });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      id_token: idToken,
      access_token: accessToken,
      refresh_token: "refresh-browser",
    }));

    const credentials = await completeBrowserLogin(
      session,
      `${BROWSER_REDIRECT_URI}?code=authorization-code&state=${encodeURIComponent(session.state)}`,
      fetcher as typeof fetch,
      () => 2_000,
    );
    expect(credentials).toEqual({
      name: "远程账号",
      accessToken,
      refreshToken: "refresh-browser",
      accountId: "account-browser",
      expiresAt: 3_600_000,
    });
    const form = new URLSearchParams(String(fetcher.mock.calls[0][1]?.body));
    expect(form.get("redirect_uri")).toBe(BROWSER_REDIRECT_URI);
    expect(form.get("code_verifier")).toBe(session.codeVerifier);
  });

  it("rejects forged state and non-localhost callback targets before token exchange", async () => {
    const session = await beginBrowserLogin(() => 1_000);
    const fetcher = vi.fn();
    await expect(completeBrowserLogin(
      session,
      `${BROWSER_REDIRECT_URI}?code=code&state=forged`,
      fetcher as typeof fetch,
      () => 2_000,
    )).rejects.toMatchObject({ status: 400, message: "OAuth state did not match" });
    await expect(completeBrowserLogin(
      session,
      `https://attacker.test/callback?code=code&state=${session.state}`,
      fetcher as typeof fetch,
      () => 2_000,
    )).rejects.toMatchObject({ status: 400, message: "Invalid callback URL" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
