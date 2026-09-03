import { describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  ANTIGRAVITY_OAUTH_REDIRECT_URI,
  ANTIGRAVITY_OAUTH_SCOPES,
  beginAntigravityLogin,
  completeAntigravityLogin,
  discoverAntigravityProject,
  refreshAntigravityTokens,
} from "../src/antigravity-auth";

describe("Antigravity authentication", () => {
  it("builds the installed-app authorization URL without PKCE", () => {
    const login = beginAntigravityLogin(() => 1_000, "Work");
    const url = new URL(login.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(ANTIGRAVITY_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(ANTIGRAVITY_OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(login.expiresAt).toBe(601_000);
  });

  it("strictly validates callback state and exchanges tokens without leaking the secret", async () => {
    const session = beginAntigravityLogin(() => 1_000);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_secret")).toBe(ANTIGRAVITY_OAUTH_CLIENT_SECRET);
        expect(body.has("code_verifier")).toBe(false);
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      }
      if (url.includes("userinfo")) return Response.json({ id: "google-id", email: "User@Example.com" });
      return Response.json({ cloudaicompanionProject: { id: "project-id" } });
    });
    const result = await completeAntigravityLogin(
      session,
      `http://localhost:51121/oauth-callback?state=${session.state}&code=secret-code`,
      fetcher,
      () => 2_000,
    );
    expect(result).toMatchObject({
      provider: "antigravity",
      projectId: "project-id",
      principalId: "google-id",
      email: "user@example.com",
    });
    for (const invalid of [
      `https://localhost:51121/oauth-callback?state=${session.state}&code=x`,
      `http://127.0.0.1:51121/oauth-callback?state=${session.state}&code=x`,
      `http://localhost:51122/oauth-callback?state=${session.state}&code=x`,
      `http://localhost:51121/wrong?state=${session.state}&code=x`,
      "http://localhost:51121/oauth-callback?state=wrong&code=x",
    ]) {
      await expect(completeAntigravityLogin(session, invalid, fetcher, () => 2_000))
        .rejects.toMatchObject({ status: 400 });
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ANTIGRAVITY_OAUTH_CLIENT_SECRET);
  });

  it("onboards on daily and polls a standard operation with GET", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("loadCodeAssist")) {
        expect(JSON.parse(String(init?.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
        return Response.json({ allowedTiers: [{ id: "free-tier", isDefault: true }] });
      }
      if (url.endsWith(":onboardUser")) return Response.json({ name: "operations/setup" });
      expect(init?.method).toBe("GET");
      expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal/operations/setup");
      return Response.json({ done: true, response: { cloudaicompanionProject: "daily-project" } });
    });
    await expect(discoverAntigravityProject("access", fetcher)).resolves.toBe("daily-project");
  });

  it("retains the old refresh token when Google omits a replacement", async () => {
    const refreshed = await refreshAntigravityTokens(
      { accessToken: "old", refreshToken: "keep-me", expiresAt: 0 },
      vi.fn(async () => Response.json({ access_token: "new", expires_in: 3600 })),
      () => 1_000,
    );
    expect(refreshed).toEqual({ accessToken: "new", refreshToken: "keep-me", expiresAt: 3_601_000 });
  });
});
