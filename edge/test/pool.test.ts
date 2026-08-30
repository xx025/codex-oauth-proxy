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

  it("generates proxy keys and stores only their hash", async () => {
    const storage = new MemoryStorage();
    const pool = new AccountPoolCore(storage);
    const key = await pool.generateProxyKey();
    expect(key).toMatch(/^cp_[0-9a-f]{64}$/);
    expect(await pool.verifyProxyKey(key)).toBe(true);
    expect(await pool.verifyProxyKey("wrong")).toBe(false);
    expect(JSON.stringify(storage.value)).not.toContain(key);
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
