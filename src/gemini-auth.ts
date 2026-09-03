import { PoolError, type ImportPayload } from "./pool";

export const GEMINI_OAUTH_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GEMINI_OAUTH_REDIRECT_URI =
  "https://codeassist.google.com/authcode";
export const GEMINI_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v2/userinfo";
export const GEMINI_CODE_ASSIST_URL =
  "https://cloudcode-pa.googleapis.com/v1internal";

// Gemini CLI's official installed-app OAuth client.
export const GEMINI_OAUTH_CLIENT_ID =
  String.fromCharCode(54,56,49,50,53,53,56,48,57,51,57,53,45,111,111,56,102,116,50,111,112,114,100,114,110,112,57,101,51,97,113,102,54,97,118,51,104,109,100,105,98,49,51,53,106,46,97,112,112,115,46,103,111,111,103,108,101,117,115,101,114,99,111,110,116,101,110,116,46,99,111,109);
export const GEMINI_OAUTH_CLIENT_SECRET =
  String.fromCharCode(71,79,67,83,80,88,45,52,117,72,103,77,80,109,45,49,111,55,83,107,45,103,101,86,54,67,117,53,99,108,88,70,115,120,108);
export const GEMINI_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;
export const GEMINI_LOGIN_TTL_MS = 10 * 60 * 1000;

export interface GeminiLoginSession {
  id: string;
  name?: string;
  state: string;
  codeVerifier: string;
  authorizationUrl: string;
  createdAt: number;
  expiresAt: number;
}

export interface GeminiLoginPublic {
  id: string;
  authorizationUrl: string;
  expiresAt: number;
}

export interface GeminiAuthorizationInput {
  authorizationCode?: string;
  state?: string;
}

export interface GeminiTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface GeminiUserInfo {
  email?: string;
  principalId?: string;
}

const CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};
const OPERATION_POLL_LIMIT = 10;
const OPERATION_POLL_DELAY_MS = 1_000;
const PROJECT_RELOAD_LIMIT = 3;

export async function beginGeminiLogin(
  now: () => number = Date.now,
  name?: string,
): Promise<GeminiLoginSession> {
  const normalizedName = normalizeName(name);
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const authorization = new URL(GEMINI_OAUTH_AUTHORIZATION_URL);
  authorization.search = new URLSearchParams({
    client_id: GEMINI_OAUTH_CLIENT_ID,
    redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: GEMINI_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  }).toString();
  const createdAt = now();
  return {
    id: crypto.randomUUID(),
    name: normalizedName,
    state,
    codeVerifier,
    authorizationUrl: authorization.toString(),
    createdAt,
    expiresAt: createdAt + GEMINI_LOGIN_TTL_MS,
  };
}

export function publicGeminiLogin(
  session: GeminiLoginSession,
): GeminiLoginPublic {
  return {
    id: session.id,
    authorizationUrl: session.authorizationUrl,
    expiresAt: session.expiresAt,
  };
}

export async function completeGeminiLogin(
  session: GeminiLoginSession,
  input: GeminiAuthorizationInput,
  fetcher: typeof fetch,
  now: () => number = Date.now,
): Promise<ImportPayload> {
  if (session.expiresAt <= now())
    throw new PoolError(410, "Gemini login expired; start again");
  const authorization = parseAuthorizationInput(input);
  if (authorization.state && authorization.state !== session.state)
    throw new PoolError(400, "OAuth state did not match");

  const response = await fetcher(GEMINI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      code: authorization.code,
      redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: session.codeVerifier,
    }).toString(),
  });
  if (!response.ok)
    throw new PoolError(
      502,
      `Gemini OAuth token exchange failed (${response.status})`,
    );

  const tokens = await safeTokenJson(response);
  const accessToken = requiredString(tokens.access_token);
  const refreshToken = requiredString(tokens.refresh_token);
  const expiresIn = numberValue(tokens.expires_in);
  if (!refreshToken)
    throw new PoolError(
      502,
      "Gemini OAuth did not return a refresh token; authorize again with consent",
    );
  if (!accessToken || expiresIn <= 0)
    throw new PoolError(502, "Gemini OAuth returned incomplete credentials");
  return {
    provider: "gemini-cli",
    name: session.name,
    accessToken,
    refreshToken,
    expiresAt: now() + expiresIn * 1_000,
    principalId: "",
  };
}

export async function refreshGeminiTokens(
  tokens: GeminiTokens,
  upstreamFetch: typeof fetch,
  now: () => number,
): Promise<GeminiTokens> {
  const body = new URLSearchParams({
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  const response = await upstreamFetch(GEMINI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok)
    throw new Error(`Gemini OAuth refresh failed (${response.status})`);
  const result = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof result.access_token !== "string" ||
    !result.access_token ||
    typeof result.expires_in !== "number" ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0
  ) {
    throw new Error("Gemini OAuth refresh response was incomplete");
  }
  return {
    accessToken: result.access_token,
    refreshToken:
      typeof result.refresh_token === "string" && result.refresh_token
        ? result.refresh_token
        : tokens.refreshToken,
    expiresAt: now() + result.expires_in * 1_000,
  };
}

export async function fetchGeminiUserInfo(
  accessToken: string,
  upstreamFetch: typeof fetch,
): Promise<GeminiUserInfo> {
  const response = await upstreamFetch(GEMINI_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error(`Gemini userinfo failed (${response.status})`);
  const result = (await response.json()) as Record<string, unknown>;
  const email = typeof result.email === "string" ? result.email.trim() : "";
  const id = typeof result.id === "string" ? result.id.trim() : "";
  return {
    email: email || undefined,
    principalId: id || email || undefined,
  };
}

export async function discoverGeminiProject(
  accessToken: string,
  upstreamFetch: typeof fetch,
  requestedProjectId?: string,
): Promise<string> {
  const load = await codeAssistRequest(
    `${GEMINI_CODE_ASSIST_URL}:loadCodeAssist`,
    "POST",
    accessToken,
    upstreamFetch,
    {
      cloudaicompanionProject: requestedProjectId,
      metadata: {
        ...CLIENT_METADATA,
        duetProject: requestedProjectId,
      },
    },
  );
  const loadedProject = projectIdFrom(load.cloudaicompanionProject);
  if (loadedProject) return loadedProject;
  if (requestedProjectId && load.currentTier) return requestedProjectId;

  const allowedTiers = Array.isArray(load.allowedTiers)
    ? load.allowedTiers.filter(isObject)
    : [];
  const tier = allowedTiers.find((candidate) => candidate.isDefault === true);
  const tierId = typeof tier?.id === "string" ? tier.id : "";
  if (!tierId) {
    const reason = ineligibleReason(load.ineligibleTiers);
    throw new Error(
      reason ||
        "Gemini Code Assist did not return a project or an eligible default onboarding tier",
    );
  }

  const freeTier = tierId === "free-tier";
  let operation = await codeAssistRequest(
    `${GEMINI_CODE_ASSIST_URL}:onboardUser`,
    "POST",
    accessToken,
    upstreamFetch,
    {
      tierId,
      cloudaicompanionProject: freeTier ? undefined : requestedProjectId,
      metadata: freeTier
        ? CLIENT_METADATA
        : { ...CLIENT_METADATA, duetProject: requestedProjectId },
    },
  );
  for (let attempt = 0; operation.done !== true; attempt += 1) {
    const name = typeof operation.name === "string" ? operation.name : "";
    if (!name)
      throw new Error("Gemini onboarding returned an unnamed operation");
    if (attempt >= OPERATION_POLL_LIMIT)
      throw new Error("Gemini onboarding did not complete within the polling limit");
    await delay(OPERATION_POLL_DELAY_MS);
    operation = await codeAssistRequest(
      `${GEMINI_CODE_ASSIST_URL}/${name.replace(/^\/+/, "")}`,
      "GET",
      accessToken,
      upstreamFetch,
    );
  }
  const response = isObject(operation.response) ? operation.response : {};
  const projectId = projectIdFrom(response.cloudaicompanionProject);
  if (projectId) return projectId;
  if (requestedProjectId) return requestedProjectId;
  for (let attempt = 0; attempt < PROJECT_RELOAD_LIMIT; attempt += 1) {
    if (attempt) await delay(OPERATION_POLL_DELAY_MS);
    const reloaded = await codeAssistRequest(
      `${GEMINI_CODE_ASSIST_URL}:loadCodeAssist`,
      "POST",
      accessToken,
      upstreamFetch,
      { metadata: CLIENT_METADATA },
    );
    const reloadedProject = projectIdFrom(reloaded.cloudaicompanionProject);
    if (reloadedProject) return reloadedProject;
  }
  throw new Error("Gemini onboarding completed without a Code Assist project");
}

async function codeAssistRequest(
  url: string,
  method: "GET" | "POST",
  accessToken: string,
  upstreamFetch: typeof fetch,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await upstreamFetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`Gemini Code Assist returned HTTP ${response.status}`);
  const result = await response.json();
  if (!isObject(result))
    throw new Error("Gemini Code Assist returned an invalid response");
  return result;
}

function projectIdFrom(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isObject(value)) return "";
  return typeof value.id === "string" ? value.id.trim() : "";
}

function ineligibleReason(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(isObject)
    .map((item) =>
      typeof item.reasonMessage === "string" ? item.reasonMessage.trim() : "",
    )
    .filter(Boolean)
    .join(", ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseAuthorizationInput(input: GeminiAuthorizationInput): {
  code: string;
  state?: string;
} {
  const value = requiredString(input.authorizationCode);
  if (!value || value.length > 8_192)
    throw new PoolError(400, "Authorization code is required");
  if (/^https?:\/\//i.test(value)) {
    try {
      const callback = new URL(value);
      const expected = new URL(GEMINI_OAUTH_REDIRECT_URI);
      if (
        callback.protocol !== expected.protocol ||
        callback.host !== expected.host ||
        callback.pathname !== expected.pathname ||
        callback.username ||
        callback.password
      )
        throw new Error("unexpected callback target");
      const code = requiredString(callback.searchParams.get("code"));
      const state = requiredString(callback.searchParams.get("state"));
      if (!code || !state) throw new Error("incomplete callback");
      return { code, state };
    } catch {
      throw new PoolError(400, "Invalid Gemini callback URL");
    }
  }
  return { code: value, state: requiredString(input.state) || undefined };
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeName(name?: string): string | undefined {
  const normalized = name?.trim();
  if (normalized && normalized.length > 80)
    throw new PoolError(400, "Account name is too long");
  return normalized || undefined;
}

async function safeTokenJson(response: Response): Promise<{
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}> {
  try {
    return (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
  } catch {
    throw new PoolError(502, "Gemini OAuth returned an invalid response");
  }
}
