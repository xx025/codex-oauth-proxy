import {
  ANTIGRAVITY_USER_AGENT,
  fetchAntigravityUserInfo,
  refreshAntigravityTokens,
} from "./antigravity-auth";

export type AccountProvider = "codex" | "antigravity";

export interface AccountRecord {
  provider: AccountProvider;
  id: string;
  name: string;
  enabled: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  projectId?: string;
  email?: string;
  principalId: string;
  createdAt: number;
  updatedAt: number;
  cooldownUntil: number;
  failureCount: number;
  lastStatus?: number;
  usage?: AccountUsage;
  lastResetAt?: number;
  resetCount?: number;
  lastResetStatus?: AccountResetStatus;
}

export interface AccountMetadata {
  provider: AccountProvider;
  id: string;
  name: string;
  enabled: boolean;
  accountId?: string;
  projectId?: string;
  email?: string;
  principalId: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  cooldownUntil: number;
  failureCount: number;
  lastStatus?: number;
  usage?: AccountUsage;
  lastResetAt?: number;
  resetCount?: number;
  lastResetStatus?: AccountResetStatus;
}

export type AccountResetStatus =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed"
  | "failed";

export interface UsageWindow {
  usedPercent: number;
  remainingPercent: number;
  windowSeconds?: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface GeminiModelUsage {
  modelId: string;
  remainingPercent: number;
  remainingAmount?: string | number;
  resetsAt?: number;
}

export interface AccountUsage {
  primary?: UsageWindow;
  secondary?: UsageWindow;
  geminiModels?: GeminiModelUsage[];
  creditsBalance?: number;
  resetCreditsAvailable?: number;
  capturedAt: number;
  error?: string;
}

export interface RateLimitResetCredits {
  availableCount: number;
}

export interface PoolState {
  accounts: AccountRecord[];
  cursor: number;
  settings?: PoolSettings;
  requestRecords?: RequestRecord[];
  modelRequestStats?: Record<string, ModelRequestStats>;
  proxyKeyHash?: string;
  proxyKeys?: ProxyKeyRecord[];
}

export type SelectionStrategy = "round_robin" | "least_failures" | "quota_weighted";
export type ServiceTier = "standard" | "fast";

export interface PoolSettings {
  selectionStrategy: SelectionStrategy;
  maxAccountAttempts: number;
  tokenExpiryBufferMinutes: number;
  rateLimitCooldownSeconds: number;
  authCooldownSeconds: number;
  serverErrorCooldownSeconds: number;
  autoResetExhaustedAccounts: boolean;
  serviceTier: ServiceTier;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  selectionStrategy: "round_robin",
  maxAccountAttempts: 3,
  tokenExpiryBufferMinutes: 60,
  rateLimitCooldownSeconds: 60,
  authCooldownSeconds: 300,
  serverErrorCooldownSeconds: 15,
  autoResetExhaustedAccounts: false,
  serviceTier: "standard",
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  available: boolean;
}

export interface RequestRecordInput {
  model: string;
  endpoint: string;
  status: number;
  durationMs: number;
  streaming: boolean;
  accountId?: string;
  usage: TokenUsage;
}

export interface RequestRecord extends RequestRecordInput {
  id: string;
  createdAt: number;
}

export interface ModelRequestStats {
  model: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  meteredRequests: number;
  lastRequestedAt: number;
}

export interface RequestStatsSnapshot {
  totals: Omit<ModelRequestStats, "model" | "lastRequestedAt">;
  models: ModelRequestStats[];
  recent: RequestRecord[];
  retentionLimit: number;
}

const REQUEST_RECORD_LIMIT = 200;
const RESET_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const QUOTA_WEIGHT_TTL_MS = 30 * 60 * 1000;

export interface ProxyKeyRecord {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  encryptedKey: string;
  createdAt: number;
  revokedAt?: number;
}

export type ProxyKeyMetadata = Omit<
  ProxyKeyRecord,
  "keyHash" | "encryptedKey"
> & { recoverable: boolean };

export interface PoolStorage {
  get(): Promise<PoolState | undefined>;
  put(state: PoolState): Promise<void>;
}

export interface ImportPayload {
  provider?: AccountProvider;
  name?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  projectId?: string;
  email?: string;
  principalId: string;
}

export interface TokenIdentity {
  accountId: string;
  email?: string;
  principalId: string;
}

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTIGRAVITY_MODELS_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CREDIT_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export class PoolError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
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

  async getSettings(): Promise<PoolSettings> {
    return settingsFor(await this.load());
  }

  async updateSettings(input: unknown): Promise<PoolSettings> {
    if (!input || typeof input !== "object")
      throw new PoolError(400, "Invalid settings payload");
    const patch = input as Record<string, unknown>;
    const current = await this.load();
    const previous = settingsFor(current);
    const selectionStrategy =
      patch.selectionStrategy === undefined
        ? previous.selectionStrategy
        : parseSelectionStrategy(patch.selectionStrategy);
    current.settings = {
      selectionStrategy,
      maxAccountAttempts: boundedInteger(
        patch.maxAccountAttempts,
        previous.maxAccountAttempts,
        1,
        10,
        "max account attempts",
      ),
      tokenExpiryBufferMinutes: boundedInteger(
        patch.tokenExpiryBufferMinutes,
        previous.tokenExpiryBufferMinutes,
        5,
        120,
        "token refresh window",
      ),
      rateLimitCooldownSeconds: boundedInteger(
        patch.rateLimitCooldownSeconds,
        previous.rateLimitCooldownSeconds,
        5,
        900,
        "rate-limit cooldown",
      ),
      authCooldownSeconds: boundedInteger(
        patch.authCooldownSeconds,
        previous.authCooldownSeconds,
        30,
        1_800,
        "authentication cooldown",
      ),
      serverErrorCooldownSeconds: boundedInteger(
        patch.serverErrorCooldownSeconds,
        previous.serverErrorCooldownSeconds,
        5,
        300,
        "server-error cooldown",
      ),
      autoResetExhaustedAccounts: booleanValue(
        patch.autoResetExhaustedAccounts,
        previous.autoResetExhaustedAccounts,
        "automatic quota reset",
      ),
      serviceTier:
        patch.serviceTier === undefined
          ? previous.serviceTier
          : parseServiceTier(patch.serviceTier),
    };
    await this.storage.put(current);
    return { ...current.settings };
  }

  async requestStats(): Promise<RequestStatsSnapshot> {
    const state = await this.load();
    const models = Object.values(state.modelRequestStats ?? {}).sort(
      (left, right) =>
        right.requests - left.requests ||
        right.lastRequestedAt - left.lastRequestedAt,
    );
    return {
      totals: models.reduce(
        (total, model) => ({
          requests: total.requests + model.requests,
          successfulRequests:
            total.successfulRequests + model.successfulRequests,
          failedRequests: total.failedRequests + model.failedRequests,
          inputTokens: total.inputTokens + model.inputTokens,
          outputTokens: total.outputTokens + model.outputTokens,
          totalTokens: total.totalTokens + model.totalTokens,
          cachedTokens: total.cachedTokens + model.cachedTokens,
          meteredRequests: total.meteredRequests + model.meteredRequests,
        }),
        emptyRequestTotals(),
      ),
      models,
      recent: [...(state.requestRecords ?? [])].sort(
        (left, right) => right.createdAt - left.createdAt,
      ),
      retentionLimit: REQUEST_RECORD_LIMIT,
    };
  }

  async recordRequest(input: unknown): Promise<void> {
    const record = validateRequestRecord(input, this.now());
    const state = await this.load();
    const records = (state.requestRecords ??= []);
    records.unshift(record);
    if (records.length > REQUEST_RECORD_LIMIT)
      records.length = REQUEST_RECORD_LIMIT;

    const stats = (state.modelRequestStats ??= {});
    const modelKey = `model:${record.model}`;
    const aggregate = (stats[modelKey] ??= {
      model: record.model,
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      meteredRequests: 0,
      lastRequestedAt: 0,
    });
    aggregate.requests += 1;
    if (record.status >= 200 && record.status < 400)
      aggregate.successfulRequests += 1;
    else aggregate.failedRequests += 1;
    aggregate.inputTokens += record.usage.inputTokens;
    aggregate.outputTokens += record.usage.outputTokens;
    aggregate.totalTokens += record.usage.totalTokens;
    aggregate.cachedTokens += record.usage.cachedTokens;
    if (record.usage.available) aggregate.meteredRequests += 1;
    aggregate.lastRequestedAt = record.createdAt;
    await this.storage.put(state);
  }

  async refreshUsage(): Promise<AccountMetadata[]> {
    const state = await this.load();
    const settings = settingsFor(state);
    await Promise.all(
      state.accounts.map(async (account) => {
        if (!account.enabled) return;
        try {
          await this.refreshUsageForAccount(account, settings);
        } catch (error) {
          account.usage = {
            ...account.usage,
            capturedAt: this.now(),
            error: safeUsageError(error),
          };
        }
        account.updatedAt = this.now();
      }),
    );
    await this.storage.put(state);
    return state.accounts.map(redactAccount);
  }

  async importAccount(payload: ImportPayload): Promise<AccountMetadata> {
    const state = await this.load();
    const provider = payload.provider ?? "codex";
    payload = { ...payload, provider };
    if (provider === "codex") validateImport(payload);
    else validateGoogleCredentials(payload);
    const settings = settingsFor(state);
    if (provider === "antigravity") {
      try {
        if (payload.expiresAt <= this.now() + settings.tokenExpiryBufferMinutes * 60_000) {
          Object.assign(payload, await refreshAntigravityTokens(payload, this.oauthFetch, this.now));
        }
        if (!payload.email || !payload.principalId) {
          const identity = await fetchAntigravityUserInfo(payload.accessToken, this.oauthFetch);
          payload.email ||= identity.email;
          payload.principalId ||= identity.principalId;
        }
      } catch (error) {
        throw new PoolError(502, error instanceof Error ? error.message : "Antigravity setup failed");
      }
      validateImport(payload);
    }
    const now = this.now();
    const existing = state.accounts.find(
      (account) =>
        account.provider === provider &&
        (provider === "codex"
          ? account.accountId === payload.accountId
          : account.projectId === payload.projectId) &&
        account.principalId === payload.principalId,
    );
    if (existing) {
      existing.name = payload.name?.trim() || existing.name;
      existing.email = payload.email;
      existing.principalId = payload.principalId;
      existing.accessToken = payload.accessToken;
      existing.refreshToken = payload.refreshToken;
      existing.expiresAt = payload.expiresAt;
      existing.provider = provider;
      existing.accountId = payload.accountId;
      existing.projectId = payload.projectId;
      existing.enabled = true;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.updatedAt = now;
      delete existing.lastStatus;
      await this.storage.put(state);
      return redactAccount(existing);
    }

    const account: AccountRecord = {
      provider,
      id: crypto.randomUUID(),
      name:
        payload.name?.trim() ||
        payload.email ||
        `Account ${state.accounts.length + 1}`,
      enabled: true,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt,
      accountId: payload.accountId,
      projectId: payload.projectId,
      email: payload.email,
      principalId: payload.principalId,
      createdAt: now,
      updatedAt: now,
      cooldownUntil: 0,
      failureCount: 0,
    };
    state.accounts.push(account);
    await this.storage.put(state);
    return redactAccount(account);
  }

  async update(
    id: string,
    patch: { name?: string; enabled?: boolean },
  ): Promise<AccountMetadata> {
    const state = await this.load();
    const account = requiredAccount(state, id);
    if (typeof patch.name === "string") {
      const name = patch.name.trim();
      if (!name || name.length > 80)
        throw new PoolError(400, "Invalid account name");
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
    state.cursor =
      state.accounts.length === 0 ? 0 : state.cursor % state.accounts.length;
    await this.storage.put(state);
  }

  async reset(id: string): Promise<AccountMetadata> {
    const state = await this.load();
    const settings = settingsFor(state);
    const account = requiredAccount(state, id);
    if (account.provider !== "codex")
      throw new PoolError(409, `${account.provider} accounts do not support quota reset`);
    try {
      await this.resetAccount(account, settings);
    } catch (error) {
      await this.storage.put(state);
      throw error;
    }
    await this.storage.put(state);
    return redactAccount(account);
  }

  async select(
    excluded: string[] = [],
    provider: AccountProvider = "codex",
  ): Promise<AccountRecord> {
    const state = await this.load();
    const settings = settingsFor(state);
    const now = this.now();
    const excludedSet = new Set(excluded);
    if (!state.accounts.some((account) => account.provider === provider))
      throw new PoolError(503, `No ${provider} accounts configured`);

    const candidateIndexes = Array.from(
      { length: state.accounts.length },
      (_, offset) => (state.cursor + offset) % state.accounts.length,
    );
    if (settings.selectionStrategy === "quota_weighted") {
      await this.refreshQuotaWeights(
        state,
        candidateIndexes,
        excludedSet,
        settings,
        now,
        provider,
      );
    }
    if (settings.selectionStrategy === "least_failures") {
      candidateIndexes.sort(
        (left, right) =>
          state.accounts[left].failureCount -
          state.accounts[right].failureCount,
      );
    } else if (settings.selectionStrategy === "quota_weighted") {
      candidateIndexes.sort(
        (left, right) =>
          quotaScore(state.accounts[right]) - quotaScore(state.accounts[left]) ||
          state.accounts[left].failureCount - state.accounts[right].failureCount,
      );
    }

    for (const index of candidateIndexes) {
      const account = state.accounts[index];
      if (
        !account.enabled ||
        account.provider !== provider ||
        account.cooldownUntil > now ||
        excludedSet.has(account.id)
      )
        continue;
      try {
        await this.refreshIfNeeded(account, settings);
        if (
          account.provider === "codex" &&
          settings.autoResetExhaustedAccounts &&
          quotaExhausted(account.usage, now) &&
          shouldAttemptAutoReset(account, now)
        ) {
          await this.resetAccount(account, settings, false);
        }
      } catch {
        account.failureCount += 1;
        account.cooldownUntil =
          now + cooldownFor(account.failureCount, settings.authCooldownSeconds);
        account.lastStatus = 401;
        account.updatedAt = now;
        continue;
      }
      if (
        account.provider === "codex" &&
        settings.autoResetExhaustedAccounts &&
        quotaExhausted(account.usage, now)
      )
        continue;
      state.cursor = (index + 1) % state.accounts.length;
      await this.storage.put(state);
      return { ...account };
    }

    await this.storage.put(state);
    const futureCooldowns = state.accounts
      .filter(
        (account) =>
          account.enabled &&
          account.provider === provider &&
          account.cooldownUntil > now &&
          !excludedSet.has(account.id),
      )
      .map((account) => account.cooldownUntil);
    const retryAfter = futureCooldowns.length
      ? Math.max(1, Math.ceil((Math.min(...futureCooldowns) - now) / 1000))
      : undefined;
    throw new PoolError(503, "No healthy accounts available", retryAfter);
  }

  async report(
    id: string,
    status: number,
    retryAfterSeconds?: number,
  ): Promise<void> {
    const state = await this.load();
    const settings = settingsFor(state);
    const account = requiredAccount(state, id);
    const now = this.now();
    account.lastStatus = status;
    account.updatedAt = now;
    if (status >= 200 && status < 400) {
      account.failureCount = 0;
      account.cooldownUntil = 0;
    } else if (status === 429) {
      if (
        account.provider === "codex" &&
        settings.autoResetExhaustedAccounts &&
        quotaExhausted(account.usage, now) &&
        shouldAttemptAutoReset(account, now)
      ) {
        await this.resetAccount(account, settings, false);
      } else {
        account.failureCount += 1;
        account.cooldownUntil =
          now +
          cooldownFor(
            account.failureCount,
            retryAfterSeconds ?? settings.rateLimitCooldownSeconds,
          );
      }
    } else if (status === 401 || status === 403) {
      account.failureCount += 1;
      account.cooldownUntil =
        now + cooldownFor(account.failureCount, settings.authCooldownSeconds);
    } else if (status >= 500) {
      account.failureCount += 1;
      account.cooldownUntil =
        now +
        cooldownFor(account.failureCount, settings.serverErrorCooldownSeconds);
    }
    await this.storage.put(state);
  }

  async listProxyKeys(): Promise<ProxyKeyMetadata[]> {
    const state = await this.load();
    const proxyKeys = state.proxyKeys ?? [];
    const activeKeys = proxyKeys.filter((record) => !record.revokedAt);
    if (activeKeys.length !== proxyKeys.length) {
      state.proxyKeys = activeKeys;
      await this.storage.put(state);
    }
    const keys = activeKeys.map(redactProxyKey);
    if (state.proxyKeyHash) keys.unshift(legacyProxyKey());
    return keys;
  }

  async generateProxyKey(
    name = "Client key",
  ): Promise<{ key: string; metadata: ProxyKeyMetadata }> {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80)
      throw new PoolError(400, "Invalid key name");
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
    if (id === "legacy")
      throw new PoolError(
        410,
        "Legacy key was stored as a hash and cannot be revealed",
      );
    const state = await this.load();
    const record = requiredProxyKey(state, id);
    if (record.revokedAt) throw new PoolError(410, "Key is revoked");
    return decryptValue(record.encryptedKey, this.encryptionSecret);
  }

  async renameProxyKey(id: string, name: string): Promise<ProxyKeyMetadata> {
    if (id === "legacy") throw new PoolError(400, "Legacy key cannot be renamed");
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80)
      throw new PoolError(400, "Invalid key name");
    const state = await this.load();
    const record = requiredProxyKey(state, id);
    if (record.revokedAt) throw new PoolError(410, "Key is revoked");
    record.name = normalizedName;
    await this.storage.put(state);
    return redactProxyKey(record);
  }

  async revokeProxyKey(id: string): Promise<ProxyKeyMetadata> {
    const state = await this.load();
    if (id === "legacy") {
      if (!state.proxyKeyHash) throw new PoolError(404, "Key not found");
      delete state.proxyKeyHash;
      await this.storage.put(state);
      return { ...legacyProxyKey(), revokedAt: this.now() };
    }
    const index = (state.proxyKeys ?? []).findIndex(
      (record) => record.id === id,
    );
    if (index < 0) throw new PoolError(404, "Key not found");
    const [record] = state.proxyKeys!.splice(index, 1);
    const revoked = { ...redactProxyKey(record), revokedAt: this.now() };
    await this.storage.put(state);
    return revoked;
  }

  async verifyProxyKey(key: string): Promise<boolean> {
    if (!key) return false;
    const state = await this.load();
    const candidateHash = await sha256(key);
    const activeMatch = (state.proxyKeys ?? []).some(
      (record) =>
        !record.revokedAt &&
        constantTimeStringEqual(candidateHash, record.keyHash),
    );
    return (
      activeMatch ||
      Boolean(
        state.proxyKeyHash &&
          constantTimeStringEqual(candidateHash, state.proxyKeyHash),
      )
    );
  }

  private async refreshIfNeeded(
    account: AccountRecord,
    settings: PoolSettings,
  ): Promise<void> {
    if (
      account.expiresAt >
      this.now() + settings.tokenExpiryBufferMinutes * 60_000
    )
      return;
    if (account.provider === "antigravity") {
      Object.assign(account, await refreshAntigravityTokens(account, this.oauthFetch, this.now));
      account.updatedAt = this.now();
      account.failureCount = 0;
      account.cooldownUntil = 0;
      return;
    }
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
    if (!response.ok)
      throw new Error(`OAuth refresh failed (${response.status})`);
    const refreshed = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (
      !refreshed.access_token ||
      !refreshed.refresh_token ||
      !refreshed.expires_in
    ) {
      throw new Error("OAuth refresh response was incomplete");
    }
    account.accessToken = refreshed.access_token;
    account.refreshToken = refreshed.refresh_token;
    account.expiresAt = this.now() + refreshed.expires_in * 1000;
    account.updatedAt = this.now();
    account.failureCount = 0;
    account.cooldownUntil = 0;
  }

  private async resetAccount(
    account: AccountRecord,
    settings: PoolSettings,
    throwOnFailure = true,
  ): Promise<void> {
    try {
      await this.refreshIfNeeded(account, settings);
      const response = await this.oauthFetch(RESET_CREDIT_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${account.accessToken}`,
          "chatgpt-account-id": account.accountId!,
        },
        body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error(`Reset endpoint returned HTTP ${response.status}`);
      const outcome = resetOutcome(await response.json());
      const now = this.now();
      account.lastResetAt = now;
      account.lastResetStatus = outcome;
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        account.resetCount = (account.resetCount ?? 0) + 1;
        account.failureCount = 0;
        account.cooldownUntil = 0;
        delete account.lastStatus;
        try {
          await this.refreshUsageForAccount(account, settings);
        } catch (error) {
          account.usage = {
            ...account.usage,
            capturedAt: this.now(),
            error: safeUsageError(error),
          };
        }
      } else if (outcome === "nothingToReset") {
        account.cooldownUntil = 0;
      } else {
        account.failureCount += 1;
        account.cooldownUntil =
          now + cooldownFor(account.failureCount, settings.rateLimitCooldownSeconds);
        account.updatedAt = now;
        if (throwOnFailure) throw new PoolError(409, resetOutcomeMessage(outcome));
        return;
      }
      account.updatedAt = this.now();
    } catch (error) {
      if (error instanceof PoolError) {
        if (!throwOnFailure) return;
        throw error;
      }
      const now = this.now();
      account.lastResetAt = now;
      account.lastResetStatus = "failed";
      account.failureCount += 1;
      account.cooldownUntil =
        now + cooldownFor(account.failureCount, settings.rateLimitCooldownSeconds);
      account.updatedAt = now;
      if (!throwOnFailure) return;
      throw new PoolError(502, safeResetError(error));
    }
  }

  private async refreshUsageForAccount(
    account: AccountRecord,
    settings: PoolSettings,
  ): Promise<void> {
    await this.refreshIfNeeded(account, settings);
    let response = await this.fetchUsage(account);
    if (response.status === 401 || response.status === 403) {
      account.expiresAt = 0;
      await this.refreshIfNeeded(account, settings);
      response = await this.fetchUsage(account);
    }
    let usage: AccountUsage;
    if (account.provider === "antigravity") {
      if (!response.ok)
        throw new Error(`Usage endpoint returned HTTP ${response.status}`);
      usage = parseGeminiAvailableModelsUsage(await response.json(), this.now());
    } else {
      if (!response.ok)
        throw new Error(`Usage endpoint returned HTTP ${response.status}`);
      usage = parseUsage(await response.json(), this.now());
    }
    if (account.provider === "codex") {
      try {
        usage.resetCreditsAvailable = await this.fetchResetCredits(account);
      } catch {
        usage.resetCreditsAvailable = usage.resetCreditsAvailable ?? undefined;
      }
    }
    account.usage = usage;
  }

  private async refreshQuotaWeights(
    state: PoolState,
    candidateIndexes: number[],
    excludedSet: Set<string>,
    settings: PoolSettings,
    now: number,
    provider: AccountProvider,
  ): Promise<void> {
    await Promise.all(
      candidateIndexes.map(async (index) => {
        const account = state.accounts[index];
        if (
          !account.enabled ||
          account.provider !== provider ||
          account.cooldownUntil > now ||
          excludedSet.has(account.id) ||
          !quotaWeightStale(account.usage, now)
        ) return;
        try {
          await this.refreshUsageForAccount(account, settings);
        } catch (error) {
          account.usage = {
            ...account.usage,
            capturedAt: now,
            error: safeUsageError(error),
          };
        }
        account.updatedAt = now;
      }),
    );
  }

  private fetchUsage(account: AccountRecord): Promise<Response> {
    if (account.provider === "antigravity") {
      return this.oauthFetch(ANTIGRAVITY_MODELS_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${account.accessToken}`,
          "content-type": "application/json",
          "user-agent": ANTIGRAVITY_USER_AGENT,
        },
        body: JSON.stringify({ project: account.projectId }),
      });
    }
    return this.oauthFetch(USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${account.accessToken}`,
        "chatgpt-account-id": account.accountId!,
      },
    });
  }

  private async fetchResetCredits(account: AccountRecord): Promise<number> {
    const response = await this.oauthFetch(RESET_CREDITS_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${account.accessToken}`,
        "chatgpt-account-id": account.accountId!,
      },
    });
    if (!response.ok)
      throw new Error(`Reset credits endpoint returned HTTP ${response.status}`);
    return parseResetCreditsAvailable(await response.json());
  }

  private async load(): Promise<PoolState> {
    const state = (await this.storage.get()) ?? { accounts: [], cursor: 0 };
    for (const account of state.accounts) account.provider ??= "codex";
    return state;
  }
}

export function parseImportPayload(input: unknown): ImportPayload {
  if (!input || typeof input !== "object")
    throw new PoolError(400, "Invalid JSON payload");
  const root = input as Record<string, unknown>;
  const provider = parseProvider(root.provider);
  const tokens = objectValue(root.tokens);
  const claude = objectValue(root.claudeAiOauth);
  const source = tokens ?? claude ?? root;
  const idToken = stringValue(source.id_token) || stringValue(source.idToken);
  const accessToken =
    stringValue(source.access_token) || stringValue(source.accessToken);
  const refreshToken =
    stringValue(source.refresh_token) || stringValue(source.refreshToken);
  const identity = tokenIdentity(idToken, accessToken);
  const accountId =
    stringValue(source.account_id) ||
    stringValue(source.accountId) ||
    identity.accountId;
  const email = normalizeEmail(
    stringValue(source.email) ||
      stringValue(root.email) ||
      identity.email ||
      "",
  );
  const principalId =
    stringValue(source.principal_id) ||
    stringValue(source.principalId) ||
    stringValue(source.chatgpt_user_id) ||
    stringValue(source.user_id) ||
    identity.principalId;
  const expiresAt =
    numberValue(source.expiry_date) ||
    numberValue(source.expiresAt) ||
    numberValue(source.expires_at) ||
    jwtExpiry(accessToken);
  return {
    provider,
    name: stringValue(root.name),
    accessToken,
    refreshToken,
    accountId: provider === "codex" ? accountId : undefined,
    projectId:
      stringValue(source.project_id) ||
      stringValue(source.projectId) ||
      stringValue(root.project_id) ||
      stringValue(root.projectId) ||
      undefined,
    email: email || undefined,
    principalId,
    expiresAt,
  };
}

export function tokenIdentity(
  idToken: string,
  accessToken: string,
): TokenIdentity {
  const claims = [decodeJwt(idToken), decodeJwt(accessToken)];
  const authClaims = claims.map((claim) =>
    objectValue(claim["https://api.openai.com/auth"]),
  );
  const profiles = claims.map((claim) =>
    objectValue(claim["https://api.openai.com/profile"]),
  );
  const accountId = firstString(
    ...claims.map((claim) => claim.chatgpt_account_id),
    ...authClaims.map((auth) => auth?.chatgpt_account_id),
  );
  const email = normalizeEmail(
    firstString(
      ...claims.map((claim) => claim.email),
      ...profiles.map((profile) => profile?.email),
      ...authClaims.map((auth) => auth?.email),
    ),
  );
  const principalId = firstString(
    ...authClaims.map((auth) => auth?.chatgpt_user_id),
    ...claims.map((claim) => claim.chatgpt_user_id),
    ...authClaims.map((auth) => auth?.user_id),
    ...claims.map((claim) => claim.user_id),
    ...authClaims.map((auth) => auth?.chatgpt_account_user_id),
    ...claims.map((claim) => claim.chatgpt_account_user_id),
    ...claims.map((claim) => claim.sub),
    email,
  );
  return { accountId, email: email || undefined, principalId };
}

function validateImport(payload: ImportPayload): void {
  const provider = payload.provider ?? "codex";
  if (provider !== "codex" && provider !== "antigravity")
    throw new PoolError(400, "Invalid account provider");
  if (
    !payload.accessToken ||
    !payload.refreshToken ||
    !payload.principalId ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= 0
  ) {
    throw new PoolError(
      400,
      "Credentials require access token, refresh token, user identity, and expiry",
    );
  }
  if (provider === "codex" && !payload.accountId)
    throw new PoolError(400, "Codex credentials require a workspace account ID");
  if (provider !== "codex" && !payload.projectId)
    throw new PoolError(400, `${provider} credentials require a Code Assist project`);
  if (payload.name && payload.name.length > 80)
    throw new PoolError(400, "Account name is too long");
  if (payload.email && payload.email.length > 320)
    throw new PoolError(400, "Account email is too long");
  if (payload.principalId.length > 512)
    throw new PoolError(400, "Account identity is too long");
}

function validateGoogleCredentials(payload: ImportPayload): void {
  if (
    !payload.accessToken ||
    !payload.refreshToken ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= 0
  ) {
    throw new PoolError(
      400,
      "Google credentials require access token, refresh token, and expiry",
    );
  }
  if (payload.name && payload.name.length > 80)
    throw new PoolError(400, "Account name is too long");
  if (payload.email && payload.email.length > 320)
    throw new PoolError(400, "Account email is too long");
}

function redactAccount(account: AccountRecord): AccountMetadata {
  const {
    accessToken: _accessToken,
    refreshToken: _refreshToken,
    ...metadata
  } = account;
  if (metadata.provider !== "codex") delete metadata.accountId;
  else delete metadata.projectId;
  return metadata;
}

function requiredAccount(state: PoolState, id: string): AccountRecord {
  const account = state.accounts.find((candidate) => candidate.id === id);
  if (!account) throw new PoolError(404, "Account not found");
  return account;
}

function requiredProxyKey(state: PoolState, id: string): ProxyKeyRecord {
  const record = (state.proxyKeys ?? []).find(
    (candidate) => candidate.id === id,
  );
  if (!record) throw new PoolError(404, "Key not found");
  return record;
}

function redactProxyKey(record: ProxyKeyRecord): ProxyKeyMetadata {
  const {
    keyHash: _keyHash,
    encryptedKey: _encryptedKey,
    ...metadata
  } = record;
  return { ...metadata, recoverable: true };
}

function legacyProxyKey(): ProxyKeyMetadata {
  return {
    id: "legacy",
    name: "旧版密钥",
    prefix: "cp_••••（仅哈希）",
    createdAt: 0,
    recoverable: false,
  };
}

function cooldownFor(failureCount: number, baseSeconds: number): number {
  return (
    Math.min(
      60 * 60,
      baseSeconds * 2 ** Math.min(4, Math.max(0, failureCount - 1)),
    ) * 1000
  );
}

function settingsFor(state: PoolState): PoolSettings {
  return { ...DEFAULT_POOL_SETTINGS, ...state.settings };
}

function parseSelectionStrategy(value: unknown): SelectionStrategy {
  if (value === "round_robin" || value === "least_failures" || value === "quota_weighted") return value;
  throw new PoolError(400, "Invalid account selection strategy");
}

function parseProvider(value: unknown): AccountProvider {
  if (value === undefined || value === null || value === "") return "codex";
  if (value === "codex" || value === "antigravity") return value;
  throw new PoolError(400, "Invalid account provider");
}

function parseServiceTier(value: unknown): ServiceTier {
  if (value === "standard" || value === "fast") return value;
  throw new PoolError(400, "Invalid service tier");
}

function quotaScore(account: AccountRecord): number {
  const windows = [account.usage?.primary, account.usage?.secondary].filter(
    (window): window is UsageWindow => Boolean(window),
  );
  if (!windows.length || account.usage?.error) return -1;
  return Math.min(
    ...windows.map((window) => Math.max(0, Math.min(100, Number(window.remainingPercent) || 0))),
  );
}

function quotaWeightStale(usage: AccountUsage | undefined, now: number): boolean {
  return !usage || !usage.capturedAt || now - usage.capturedAt > QUOTA_WEIGHT_TTL_MS;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PoolError(400, `Invalid ${label}`);
  }
  return parsed;
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new PoolError(400, `Invalid ${label}`);
}

function emptyRequestTotals(): Omit<
  ModelRequestStats,
  "model" | "lastRequestedAt"
> {
  return {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    meteredRequests: 0,
  };
}

function validateRequestRecord(
  input: unknown,
  createdAt: number,
): RequestRecord {
  const payload = objectValue(input);
  const model =
    typeof payload?.model === "string" ? payload.model.trim() || "unknown" : "";
  const endpoint =
    typeof payload?.endpoint === "string" ? payload.endpoint.trim() : "";
  if (!model || !endpoint)
    throw new PoolError(400, "Invalid request record metadata");
  if (model.length > 160 || endpoint.length > 80)
    throw new PoolError(400, "Invalid request record metadata");
  const status = typeof payload?.status === "number" ? payload.status : NaN;
  if (!Number.isInteger(status) || status < 100 || status > 599)
    throw new PoolError(400, "Invalid request status");
  if (
    typeof payload?.durationMs !== "number" ||
    !Number.isFinite(payload.durationMs) ||
    payload.durationMs < 0 ||
    payload.durationMs > 86_400_000
  )
    throw new PoolError(400, "Invalid request duration");
  const rawUsage = objectValue(payload.usage);
  const usage: TokenUsage = {
    inputTokens: safeTokenCount(rawUsage?.inputTokens),
    outputTokens: safeTokenCount(rawUsage?.outputTokens),
    totalTokens: safeTokenCount(rawUsage?.totalTokens),
    cachedTokens: safeTokenCount(rawUsage?.cachedTokens),
    available: rawUsage?.available === true,
  };
  return {
    id: crypto.randomUUID(),
    model,
    endpoint,
    status,
    durationMs: Math.round(payload.durationMs),
    streaming: payload.streaming === true,
    accountId:
      typeof payload.accountId === "string"
        ? payload.accountId.slice(0, 80)
        : undefined,
    usage,
    createdAt,
  };
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const candidate = stringValue(value);
    if (candidate) return candidate;
  }
  return "";
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function numberValue(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : 0;
}

function parseUsage(input: unknown, capturedAt: number): AccountUsage {
  const root = objectValue(input);
  const rateLimit = objectValue(root?.rate_limit);
  const primary = parseUsageWindow(rateLimit?.primary_window);
  const secondary = parseUsageWindow(rateLimit?.secondary_window);
  if (!primary && !secondary)
    throw new Error("Usage response did not contain quota windows");
  const credits = objectValue(root?.credits);
  const creditsBalance = optionalNumber(credits?.balance);
  return {
    primary,
    secondary,
    creditsBalance,
    capturedAt,
  };
}

function parseUsageWindow(input: unknown): UsageWindow | undefined {
  const window = objectValue(input);
  const usedPercent = optionalNumber(window?.used_percent);
  const windowSeconds = optionalNumber(window?.limit_window_seconds);
  const resetsAt = optionalNumber(window?.reset_at);
  if (
    usedPercent === undefined ||
    windowSeconds === undefined ||
    resetsAt === undefined
  )
    return undefined;
  return {
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    windowSeconds,
    windowMinutes: Math.ceil(windowSeconds / 60),
    resetsAt,
  };
}

function parseGeminiUsage(input: unknown, capturedAt: number): AccountUsage {
  const root = objectValue(input);
  const buckets = Array.isArray(root?.buckets) ? root.buckets : [];
  const byModel = new Map<string, GeminiModelUsage>();
  for (const inputBucket of buckets) {
    const bucket = objectValue(inputBucket);
    const modelId = stringValue(bucket?.modelId);
    const fraction = typeof bucket?.remainingFraction === "number" &&
        Number.isFinite(bucket.remainingFraction)
      ? bucket.remainingFraction
      : undefined;
    if (!modelId || fraction === undefined) continue;
    const remainingPercent = Math.round(
      Math.max(0, Math.min(100, fraction * 100)) * 10_000,
    ) / 10_000;
    const resetTime = stringValue(bucket?.resetTime);
    const resetMilliseconds = resetTime ? Date.parse(resetTime) : NaN;
    const remainingAmount =
      typeof bucket?.remainingAmount === "string" ||
        (typeof bucket?.remainingAmount === "number" &&
          Number.isFinite(bucket.remainingAmount))
        ? bucket.remainingAmount
        : undefined;
    const model: GeminiModelUsage = {
      modelId,
      remainingPercent,
      remainingAmount,
      resetsAt: Number.isFinite(resetMilliseconds)
        ? Math.floor(resetMilliseconds / 1_000)
        : undefined,
    };
    const previous = byModel.get(modelId);
    if (!previous || model.remainingPercent < previous.remainingPercent)
      byModel.set(modelId, model);
  }
  const geminiModels = [...byModel.values()].sort((a, b) =>
    a.modelId.localeCompare(b.modelId),
  );
  if (!geminiModels.length)
    throw new Error("Gemini quota response did not contain valid buckets");
  const lowest = geminiModels.reduce((minimum, model) =>
    model.remainingPercent < minimum.remainingPercent ? model : minimum,
  );
  return {
    primary: {
      usedPercent: Math.round((100 - lowest.remainingPercent) * 10_000) / 10_000,
      remainingPercent: lowest.remainingPercent,
      resetsAt: lowest.resetsAt,
    },
    geminiModels,
    capturedAt,
  };
}

function parseGeminiAvailableModelsUsage(
  input: unknown,
  capturedAt: number,
): AccountUsage {
  const root = objectValue(input);
  const models = objectValue(root?.models) ?? {};
  const buckets = Object.entries(models).map(([modelId, value]) => {
    const quota = objectValue(objectValue(value)?.quotaInfo);
    return {
      modelId,
      remainingFraction: quota?.remainingFraction,
      resetTime: quota?.resetTime,
    };
  });
  return parseGeminiUsage({ buckets }, capturedAt);
}

async function safeGoogleErrorReason(response: Response): Promise<string> {
  if (response.ok) return "";
  try {
    const root = objectValue(await response.clone().json());
    const error = objectValue(root?.error);
    const status = stringValue(error?.status).slice(0, 80);
    const details = Array.isArray(error?.details) ? error.details : [];
    const reason = details
      .map((detail) => stringValue(objectValue(detail)?.reason))
      .find(Boolean)
      ?.slice(0, 80) ?? "";
    const summary = [status, reason].filter(Boolean).join("/");
    return summary ? `(${summary})` : "";
  } catch {
    return "";
  }
}

function optionalNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeUsageError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Usage refresh failed";
  return /^(Usage endpoint returned HTTP \d{3}|Gemini quota response did not contain valid buckets)$/.test(message) ||
      /^Gemini quota diagnostics: retrieveUserQuota=\d{3}; loadCodeAssist=\d{3}(?:\([A-Z0-9_/-]+\))?; fetchAvailableModels=\d{3}(?:\([A-Z0-9_/-]+\))?$/.test(message)
    ? message
    : "Usage refresh failed";
}

function safeResetError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Quota reset failed";
  return /^Reset endpoint returned HTTP \d{3}$/.test(message)
    ? message
    : "Quota reset failed";
}

function resetOutcome(input: unknown): AccountResetStatus {
  const outcome = stringValue(objectValue(input)?.outcome);
  if (
    outcome === "reset" ||
    outcome === "nothingToReset" ||
    outcome === "noCredit" ||
    outcome === "alreadyRedeemed"
  ) {
    return outcome;
  }
  throw new Error("Reset endpoint returned an incomplete response");
}

function parseResetCreditsAvailable(input: unknown): number {
  const root = objectValue(input);
  const direct = objectValue(root?.rate_limit_reset_credits);
  const source = direct ?? root;
  const value = optionalNumber(source?.available_count) ?? optionalNumber(source?.availableCount);
  if (value === undefined) throw new Error("Reset credits response was incomplete");
  return Math.max(0, Math.floor(value));
}

function resetOutcomeMessage(outcome: AccountResetStatus): string {
  if (outcome === "nothingToReset") return "No current quota window can be reset";
  if (outcome === "noCredit") return "No quota reset credits are available";
  return "Quota reset failed";
}

function quotaExhausted(usage: AccountUsage | undefined, now: number): boolean {
  return Boolean(
    windowExhausted(usage?.primary, now) || windowExhausted(usage?.secondary, now),
  );
}

function windowExhausted(window: UsageWindow | undefined, now: number): boolean {
  if (!window || window.resetsAt === undefined || window.resetsAt * 1000 <= now)
    return false;
  return window.remainingPercent <= 0 || window.usedPercent >= 100;
}

function shouldAttemptAutoReset(account: AccountRecord, now: number): boolean {
  return !account.lastResetAt || now - account.lastResetAt >= RESET_RETRY_COOLDOWN_MS;
}

function jwtExpiry(token: string): number {
  const exp = decodeJwt(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : 0;
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const normalized = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(normalized));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`codex-proxy-key:${secret}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptValue(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(secret),
      new TextEncoder().encode(value),
    ),
  );
  return `${base64Url(iv)}.${base64Url(encrypted)}`;
}

async function decryptValue(value: string, secret: string): Promise<string> {
  const [ivText, encryptedText] = value.split(".");
  if (!ivText || !encryptedText)
    throw new PoolError(500, "Stored key is invalid");
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
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) =>
    character.charCodeAt(0),
  );
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
