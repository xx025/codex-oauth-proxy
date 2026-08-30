import { describe, expect, it, vi } from "vitest";
import { AccountPoolCore, PoolState, parseImportPayload } from "../src/pool";

class MemoryStorage {
  value?: PoolState;
  async get() { return this.value ? structuredClone(this.value) : undefined; }
  async put(value: PoolState) { this.value = structuredClone(value); }
}

const credential = (accountId: string, name?: string) => ({
  name,
  accessToken: `access-${accountId}`,
  refreshToken: `refresh-${accountId}`,
  expiresAt: 10_000_000,
  accountId,
});

describe("AccountPoolCore", () => {
  it("imports, persists, and never lists tokens", async () => {
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage, vi.fn(), () => 1_000);
    await pool.importAccount(credential("a", "Primary"));
    const listed = await pool.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Primary", accountId: "a", enabled: true });
    expect(listed[0]).not.toHaveProperty("accessToken");
    expect(listed[0]).not.toHaveProperty("refreshToken");
    expect((await new AccountPoolCore(storage).list())[0].accountId).toBe("a");
  });

  it("round-robins enabled healthy accounts", async () => {
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage, vi.fn(), () => 1_000);
    const first = await pool.importAccount(credential("a"));
    await pool.importAccount(credential("b"));
    expect((await pool.select()).accountId).toBe("a");
    expect((await pool.select()).accountId).toBe("b");
    await pool.update(first.id, { enabled: false });
    expect((await pool.select()).accountId).toBe("b");
  });

  it("refreshes expiring credentials and persists rotated refresh tokens", async () => {
    const storage = new MemoryStorage();
    const oauthFetch = vi.fn(async () => Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 7200,
    }));
    const pool = new AccountPoolCore(storage, oauthFetch as typeof fetch, () => 1_000_000);
    await pool.importAccount({ ...credential("a"), expiresAt: 1_000_001 });
    const selected = await pool.select();
    expect(selected.accessToken).toBe("new-access");
    expect(selected.refreshToken).toBe("new-refresh");
    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(storage.value?.accounts[0].refreshToken).toBe("new-refresh");
  });

  it("refreshes and persists redacted quota snapshots for each enabled account", async () => {
    const storage = new MemoryStorage();
    const usageFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-a");
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("a");
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 2_000 },
          secondary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: 3_000 },
        },
        credits: { balance: 12.5 },
      });
    });
    const pool = new AccountPoolCore(storage, usageFetch as typeof fetch, () => 1_000);
    await pool.importAccount(credential("a", "Primary"));

    const [account] = await pool.refreshUsage();

    expect(account.usage).toEqual({
      primary: { usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: 2_000 },
      secondary: { usedPercent: 80, remainingPercent: 20, windowMinutes: 10_080, resetsAt: 3_000 },
      creditsBalance: 12.5,
      capturedAt: 1_000,
    });
    expect(account).not.toHaveProperty("accessToken");
    expect(account).not.toHaveProperty("refreshToken");
    expect(storage.value?.accounts[0].usage?.primary?.remainingPercent).toBe(75);
  });

  it("cools down rate-limited accounts and fails over", async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage, vi.fn(), () => now);
    const first = await pool.importAccount(credential("a"));
    await pool.importAccount(credential("b"));
    expect((await pool.select()).id).toBe(first.id);
    await pool.report(first.id, 429, 120);
    expect((await pool.select()).accountId).toBe("b");
    now += 121_000;
    expect((await pool.select()).accountId).toBe("a");
  });

  it("supports enable, disable, rename, and removal", async () => {
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage, vi.fn(), () => 1_000);
    const account = await pool.importAccount(credential("a"));
    expect(await pool.update(account.id, { enabled: false, name: "Paused" })).toMatchObject({ enabled: false, name: "Paused" });
    await pool.remove(account.id);
    expect(await pool.list()).toEqual([]);
  });

  it("creates, reveals, verifies, and revokes multiple encrypted proxy keys", async () => {
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage, vi.fn(), () => 1_000, "encryption-secret");
    const first = await pool.generateProxyKey("Desktop");
    const second = await pool.generateProxyKey("Server");
    expect(first.key).toMatch(/^cp_[0-9a-f]{64}$/);
    expect(second.key).not.toBe(first.key);
    expect(await pool.listProxyKeys()).toMatchObject([
      { name: "Desktop" },
      { name: "Server" },
    ]);
    expect(await pool.revealProxyKey(first.metadata.id)).toBe(first.key);
    expect(await pool.verifyProxyKey(first.key)).toBe(true);
    expect(await pool.verifyProxyKey(second.key)).toBe(true);
    expect(await pool.verifyProxyKey("wrong")).toBe(false);
    expect(JSON.stringify(storage.value)).not.toContain(first.key);
    expect(JSON.stringify(storage.value)).not.toContain(second.key);

    await pool.revokeProxyKey(first.metadata.id);
    expect(await pool.verifyProxyKey(first.key)).toBe(false);
    expect(await pool.verifyProxyKey(second.key)).toBe(true);
    await expect(pool.revealProxyKey(first.metadata.id)).rejects.toMatchObject({ status: 410 });
  });

  it("keeps legacy hash-only keys valid and allows revoking them", async () => {
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage);
    const legacy = await pool.generateProxyKey("Temporary");
    storage.value = { accounts: [], cursor: 0, proxyKeyHash: storage.value?.proxyKeys?.[0].keyHash };
    expect(await pool.verifyProxyKey(legacy.key)).toBe(true);
    expect(await pool.listProxyKeys()).toMatchObject([{ id: "legacy", recoverable: false }]);
    await expect(pool.revealProxyKey("legacy")).rejects.toMatchObject({ status: 410 });
    await pool.revokeProxyKey("legacy");
    expect(await pool.verifyProxyKey(legacy.key)).toBe(false);
    expect(await pool.listProxyKeys()).toEqual([]);
  });
});

describe("parseImportPayload", () => {
  it("accepts Codex auth.json", () => {
    expect(parseImportPayload({ tokens: {
      access_token: "access",
      refresh_token: "refresh",
      account_id: "account",
      expiresAt: 1234,
    } })).toMatchObject({ accessToken: "access", refreshToken: "refresh", accountId: "account", expiresAt: 1234 });
  });

  it("accepts the legacy Cloudflare credential shape", () => {
    expect(parseImportPayload({ userID: "account", claudeAiOauth: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1234,
    } })).toMatchObject({ accessToken: "access", refreshToken: "refresh", accountId: "account", expiresAt: 1234 });
  });
});
