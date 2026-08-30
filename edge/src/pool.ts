export interface AccountRecord {
  id: string;
  name: string;
  enabled: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  createdAt: number;
  updatedAt: number;
  cooldownUntil: number;
  failureCount: number;
  lastStatus?: number;
}

export interface AccountMetadata {
  id: string;
  name: string;
  enabled: boolean;
  accountId: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  cooldownUntil: number;
  failureCount: number;
  lastStatus?: number;
}

export interface PoolState {
  accounts: AccountRecord[];
  cursor: number;
  proxyKeyHash?: string;
  proxyKeys?: ProxyKeyRecord[];
}

export interface ProxyKeyRecord {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  encryptedKey: string;
  createdAt: number;
  revokedAt?: number;
}

export type ProxyKeyMetadata = Omit<ProxyKeyRecord, "keyHash" | "encryptedKey">;

export interface PoolStorage {
  get(): Promise<PoolState | undefined>;
  put(state: PoolState): Promise<void>;
}

export interface ImportPayload {
  name?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

const TOKEN_EXPIRY_BUFFER_MS = 60 * 60 * 1000;
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export class PoolError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

export class AccountPoolCore {
  constructor(
    private readonly storage: PoolStorage,
    private readonly oauthFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly encryptionSecret: string = "local-test-encryption-secret",
  ) {}

  async list(): Promise<AccountMetadata[]> {
    const state = await this.load();
    return state.accounts.map(redactAccount);
  }

  async importAccount(payload: ImportPayload): Promise<AccountMetadata> {
    validateImport(payload);
    const state = await this.load();
    const now = this.now();
    const existing = state.accounts.find((account) => account.accountId === payload.accountId);
    if (existing) {
      existing.name = payload.name?.trim() || existing.name;
      existing.accessToken = payload.accessToken;
      existing.refreshToken = payload.refreshToken;
      existing.expiresAt = payload.expiresAt;
      existing.enabled = true;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.updatedAt = now;
      delete existing.lastStatus;
      await this.storage.put(state);
      return redactAccount(existing);
    }

    const account: AccountRecord = {
      id: crypto.randomUUID(),
      name: payload.name?.trim() || `Account ${state.accounts.length + 1}`,
      enabled: true,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt,
      accountId: payload.accountId,
      createdAt: now,
      updatedAt: now,
      cooldownUntil: 0,
      failureCount: 0,
    };
    state.accounts.push(account);
    await this.storage.put(state);
    return redactAccount(account);
  }

  async update(id: string, patch: { name?: string; enabled?: boolean }): Promise<AccountMetadata> {
    const state = await this.load();
    const account = requiredAccount(state, id);
    if (typeof patch.name === "string") {
      const name = patch.name.trim();
      if (!name || name.length > 80) throw new PoolError(400, "Invalid account name");
      account.name = name;
    }
    if (typeof patch.enabled === "boolean") {
      account.enabled = patch.enabled;
      if (patch.enabled) account.cooldownUntil = 0;
    }
    account.updatedAt = this.now();
    await this.storage.put(state);
    return redactAccount(account);
  }

  async remove(id: string): Promise<void> {
    const state = await this.load();
    const index = state.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new PoolError(404, "Account not found");
    state.accounts.splice(index, 1);
    state.cursor = state.accounts.length === 0 ? 0 : state.cursor % state.accounts.length;
    await this.storage.put(state);
  }

  async select(excluded: string[] = []): Promise<AccountRecord> {
    const state = await this.load();
    const now = this.now();
    const excludedSet = new Set(excluded);
    if (state.accounts.length === 0) throw new PoolError(503, "No accounts configured");

    for (let offset = 0; offset < state.accounts.length; offset += 1) {
      const index = (state.cursor + offset) % state.accounts.length;
      const account = state.accounts[index];
      if (!account.enabled || account.cooldownUntil > now || excludedSet.has(account.id)) continue;
      try {
        await this.refreshIfNeeded(account);
      } catch {
        account.failureCount += 1;
        account.cooldownUntil = now + cooldownFor(account.failureCount, 60);
        account.lastStatus = 401;
        account.updatedAt = now;
        continue;
      }
      state.cursor = (index + 1) % state.accounts.length;
      await this.storage.put(state);
      return { ...account };
    }

    await this.storage.put(state);
    const futureCooldowns = state.accounts
      .filter((account) => account.enabled && account.cooldownUntil > now && !excludedSet.has(account.id))
      .map((account) => account.cooldownUntil);
    const retryAfter = futureCooldowns.length
      ? Math.max(1, Math.ceil((Math.min(...futureCooldowns) - now) / 1000))
      : undefined;
    throw new PoolError(503, "No healthy accounts available", retryAfter);
  }

  async report(id: string, status: number, retryAfterSeconds?: number): Promise<void> {
    const state = await this.load();
    const account = requiredAccount(state, id);
    const now = this.now();
    account.lastStatus = status;
    account.updatedAt = now;
    if (status >= 200 && status < 400) {
      account.failureCount = 0;
      account.cooldownUntil = 0;
    } else if (status === 429) {
      account.failureCount += 1;
      account.cooldownUntil = now + cooldownFor(account.failureCount, retryAfterSeconds ?? 60);
    } else if (status === 401 || status === 403) {
      account.failureCount += 1;
      account.cooldownUntil = now + cooldownFor(account.failureCount, 300);
    } else if (status >= 500) {
      account.failureCount += 1;
      account.cooldownUntil = now + cooldownFor(account.failureCount, 15);
    }
    await this.storage.put(state);
  }

  async listProxyKeys(): Promise<ProxyKeyMetadata[]> {
    const state = await this.load();
    return (state.proxyKeys ?? []).map(redactProxyKey);
  }

  async generateProxyKey(name = "Client key"): Promise<{ key: string; metadata: ProxyKeyMetadata }> {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) throw new PoolError(400, "Invalid key name");
    const state = await this.load();
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    const key = `cp_${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const record: ProxyKeyRecord = {
      id: crypto.randomUUID(),
      name: normalizedName,
      prefix: `${key.slice(0, 10)}…${key.slice(-4)}`,
      keyHash: await sha256(key),
      encryptedKey: await encryptValue(key, this.encryptionSecret),
      createdAt: this.now(),
    };
    (state.proxyKeys ??= []).push(record);
    await this.storage.put(state);
    return { key, metadata: redactProxyKey(record) };
  }

  async revealProxyKey(id: string): Promise<string> {
    const state = await this.load();
    const record = requiredProxyKey(state, id);
    if (record.revokedAt) throw new PoolError(410, "Key is revoked");
    return decryptValue(record.encryptedKey, this.encryptionSecret);
  }

  async revokeProxyKey(id: string): Promise<ProxyKeyMetadata> {
    const state = await this.load();
    const record = requiredProxyKey(state, id);
    record.revokedAt ??= this.now();
    await this.storage.put(state);
    return redactProxyKey(record);
  }

  async verifyProxyKey(key: string): Promise<boolean> {
    if (!key) return false;
    const state = await this.load();
    const candidateHash = await sha256(key);
    const activeMatch = (state.proxyKeys ?? []).some((record) => !record.revokedAt && constantTimeStringEqual(candidateHash, record.keyHash));
    return activeMatch || Boolean(state.proxyKeyHash && constantTimeStringEqual(candidateHash, state.proxyKeyHash));
  }

  private async refreshIfNeeded(account: AccountRecord): Promise<void> {
    if (account.expiresAt > this.now() + TOKEN_EXPIRY_BUFFER_MS) return;
    const response = await this.oauthFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: "openid profile email",
      }),
    });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`);
    const refreshed = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_in) {
      throw new Error("OAuth refresh response was incomplete");
    }
    account.accessToken = refreshed.access_token;
    account.refreshToken = refreshed.refresh_token;
    account.expiresAt = this.now() + refreshed.expires_in * 1000;
    account.updatedAt = this.now();
    account.failureCount = 0;
    account.cooldownUntil = 0;
  }

  private async load(): Promise<PoolState> {
    return await this.storage.get() ?? { accounts: [], cursor: 0 };
  }
}

export function parseImportPayload(input: unknown): ImportPayload {
  if (!input || typeof input !== "object") throw new PoolError(400, "Invalid JSON payload");
  const root = input as Record<string, unknown>;
  const tokens = objectValue(root.tokens);
  const claude = objectValue(root.claudeAiOauth);
  const source = tokens ?? claude ?? root;
  const accessToken = stringValue(source.access_token) || stringValue(source.accessToken) || stringValue(source.id_token);
  const refreshToken = stringValue(source.refresh_token) || stringValue(source.refreshToken);
  const accountId = stringValue(source.account_id) || stringValue(source.accountId) ||
    stringValue(root.userID) || stringValue(root.accountId);
  const expiresAt = numberValue(source.expiresAt) || numberValue(source.expires_at) || jwtExpiry(accessToken);
  return {
    name: stringValue(root.name),
    accessToken,
    refreshToken,
    accountId,
    expiresAt,
  };
}

function validateImport(payload: ImportPayload): void {
  if (!payload.accessToken || !payload.refreshToken || !payload.accountId || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= 0) {
    throw new PoolError(400, "Credentials require access token, refresh token, account ID, and expiry");
  }
  if (payload.name && payload.name.length > 80) throw new PoolError(400, "Account name is too long");
}

function redactAccount(account: AccountRecord): AccountMetadata {
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...metadata } = account;
  return metadata;
}

function requiredAccount(state: PoolState, id: string): AccountRecord {
  const account = state.accounts.find((candidate) => candidate.id === id);
  if (!account) throw new PoolError(404, "Account not found");
  return account;
}

function requiredProxyKey(state: PoolState, id: string): ProxyKeyRecord {
  const record = (state.proxyKeys ?? []).find((candidate) => candidate.id === id);
  if (!record) throw new PoolError(404, "Key not found");
  return record;
}

function redactProxyKey(record: ProxyKeyRecord): ProxyKeyMetadata {
  const { keyHash: _keyHash, encryptedKey: _encryptedKey, ...metadata } = record;
  return metadata;
}

function cooldownFor(failureCount: number, baseSeconds: number): number {
  return Math.min(15 * 60, baseSeconds * 2 ** Math.min(4, Math.max(0, failureCount - 1))) * 1000;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
}

function jwtExpiry(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return 0;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(normalized)) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`codex-proxy-key:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptValue(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(value),
  ));
  return `${base64Url(iv)}.${base64Url(encrypted)}`;
}

async function decryptValue(value: string, secret: string): Promise<string> {
  const [ivText, encryptedText] = value.split(".");
  if (!ivText || !encryptedText) throw new PoolError(500, "Stored key is invalid");
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivText) },
      await encryptionKey(secret),
      fromBase64Url(encryptedText),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new PoolError(500, "Stored key could not be decrypted");
  }
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
