import { PoolError, type ImportPayload } from "./pool";

export const ANTIGRAVITY_OAUTH_CLIENT_ID =
  String.fromCharCode(49,48,55,49,48,48,54,48,54,48,53,57,49,45,116,109,104,115,115,105,110,50,104,50,49,108,99,114,101,50,51,53,118,116,111,108,111,106,104,52,103,52,48,51,101,112,46,97,112,112,115,46,103,111,111,103,108,101,117,115,101,114,99,111,110,116,101,110,116,46,99,111,109);
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET =
  String.fromCharCode(71,79,67,83,80,88,45,75,53,56,70,87,82,52,56,54,76,100,76,74,49,109,76,66,56,115,88,67,52,122,54,113,68,65,102);
export const ANTIGRAVITY_OAUTH_REDIRECT_URI =
  "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;
export const ANTIGRAVITY_LOGIN_TTL_MS = 10 * 60 * 1000;
export const ANTIGRAVITY_USER_AGENT = "antigravity/hub/2.9.1 darwin/arm64";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const PROD_API = "https://cloudcode-pa.googleapis.com/v1internal";
const DAILY_API = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const POLL_LIMIT = 10;

export interface AntigravityLoginSession {
  id: string;
  name?: string;
  state: string;
  authorizationUrl: string;
  createdAt: number;
  expiresAt: number;
}

export interface AntigravityLoginPublic {
  id: string;
  authorizationUrl: string;
  expiresAt: number;
}

export interface AntigravityTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function beginAntigravityLogin(
  now: () => number = Date.now,
  name?: string,
): AntigravityLoginSession {
  const normalizedName = normalizeName(name);
  const state = randomBase64Url(32);
  const authorization = new URL(AUTHORIZATION_URL);
  authorization.search = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    redirect_uri: ANTIGRAVITY_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: ANTIGRAVITY_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  const createdAt = now();
  return {
    id: crypto.randomUUID(),
    name: normalizedName,
    state,
    authorizationUrl: authorization.toString(),
    createdAt,
    expiresAt: createdAt + ANTIGRAVITY_LOGIN_TTL_MS,
  };
}

export function publicAntigravityLogin(
  session: AntigravityLoginSession,
): AntigravityLoginPublic {
  return {
    id: session.id,
    authorizationUrl: session.authorizationUrl,
    expiresAt: session.expiresAt,
  };
}

export async function completeAntigravityLogin(
  session: AntigravityLoginSession,
  callbackUrl: string,
  upstreamFetch: typeof fetch,
  now: () => number = Date.now,
): Promise<ImportPayload> {
  if (session.expiresAt <= now())
    throw new PoolError(410, "Antigravity login expired; start again");
  const code = parseCallbackUrl(callbackUrl, session.state);
  const response = await upstreamFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: ANTIGRAVITY_OAUTH_REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!response.ok) {
    const detail = await safeOAuthError(response);
    throw new PoolError(
      502,
      `Antigravity OAuth token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const tokens = await tokenResponse(response, "Antigravity OAuth");
  if (!tokens.refreshToken)
    throw new PoolError(502, "Antigravity OAuth did not return a refresh token; authorize again with consent");
  const identity = await fetchAntigravityUserInfo(tokens.accessToken, upstreamFetch);
  const projectId = await discoverAntigravityProject(tokens.accessToken, upstreamFetch);
  return {
    provider: "antigravity",
    name: session.name,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now() + tokens.expiresIn * 1_000,
    email: identity.email,
    principalId: identity.principalId,
    projectId,
  };
}

export async function refreshAntigravityTokens(
  tokens: AntigravityTokens,
  upstreamFetch: typeof fetch,
  now: () => number,
): Promise<AntigravityTokens> {
  const response = await upstreamFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }).toString(),
  });
  if (!response.ok)
    throw new Error(`Antigravity OAuth refresh failed (${response.status})`);
  const result = await tokenResponse(response, "Antigravity OAuth refresh");
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken || tokens.refreshToken,
    expiresAt: now() + result.expiresIn * 1_000,
  };
}

export async function fetchAntigravityUserInfo(
  accessToken: string,
  upstreamFetch: typeof fetch,
): Promise<{ email: string; principalId: string }> {
  const response = await upstreamFetch(USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": ANTIGRAVITY_USER_AGENT,
    },
  });
  if (!response.ok)
    throw new Error(`Antigravity userinfo failed (${response.status})`);
  const result = objectValue(await response.json());
  const email = stringValue(result?.email).toLowerCase();
  const principalId = stringValue(result?.id) || email;
  if (!email || !principalId)
    throw new Error("Antigravity userinfo response was incomplete");
  return { email, principalId };
}

export async function discoverAntigravityProject(
  accessToken: string,
  upstreamFetch: typeof fetch,
): Promise<string> {
  const load = await apiRequest(
    `${PROD_API}:loadCodeAssist`,
    "POST",
    accessToken,
    upstreamFetch,
    { metadata: { ideType: "ANTIGRAVITY" } },
  );
  const loaded = projectFrom(load);
  if (loaded) return loaded;
  const tierId = defaultTierId(load);
  let operation = await apiRequest(
    `${DAILY_API}:onboardUser`,
    "POST",
    accessToken,
    upstreamFetch,
    {
      tier_id: tierId,
      metadata: {
        ide_type: "ANTIGRAVITY",
        ide_name: "antigravity",
        ide_version: "2.9.1",
      },
    },
  );
  for (let attempt = 0; operation.done !== true; attempt += 1) {
    const name = stringValue(operation.name);
    if (!name) throw new Error("Antigravity onboarding returned an unnamed operation");
    if (attempt >= POLL_LIMIT)
      throw new Error("Antigravity onboarding did not complete within the polling limit");
    operation = await apiRequest(
      `${DAILY_API}/${name.replace(/^\/+/, "")}`,
      "GET",
      accessToken,
      upstreamFetch,
    );
  }
  const projectId = projectFrom(objectValue(operation.response));
  if (!projectId)
    throw new Error("Antigravity onboarding completed without a project");
  return projectId;
}

function parseCallbackUrl(value: string, expectedState: string): string {
  if (!value || value.length > 8_192)
    throw new PoolError(400, "Paste the complete Antigravity localhost callback URL");
  try {
    const callback = new URL(value);
    if (
      callback.protocol !== "http:" ||
      callback.hostname !== "localhost" ||
      callback.port !== "51121" ||
      callback.pathname !== "/oauth-callback" ||
      callback.username ||
      callback.password ||
      callback.searchParams.get("state") !== expectedState
    ) throw new Error("invalid callback");
    const code = stringValue(callback.searchParams.get("code"));
    if (!code) throw new Error("missing code");
    return code;
  } catch {
    throw new PoolError(400, "Invalid Antigravity callback URL or OAuth state");
  }
}

async function apiRequest(
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
      "user-agent": ANTIGRAVITY_USER_AGENT,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`Antigravity Code Assist returned HTTP ${response.status}`);
  const result = objectValue(await response.json());
  if (!result) throw new Error("Antigravity Code Assist returned an invalid response");
  return result;
}

async function tokenResponse(response: Response, label: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  let result: Record<string, unknown> | undefined;
  try {
    result = objectValue(await response.json());
  } catch {
    throw new PoolError(502, `${label} returned an invalid response`);
  }
  const accessToken = stringValue(result?.access_token);
  const refreshToken = stringValue(result?.refresh_token);
  const expiresIn = numberValue(result?.expires_in);
  if (!accessToken || expiresIn <= 0)
    throw new PoolError(502, `${label} returned incomplete credentials`);
  return { accessToken, refreshToken, expiresIn };
}

function projectFrom(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = input[key];
    const project = stringValue(value) || stringValue(objectValue(value)?.id);
    if (project) return project;
  }
  return "";
}

function defaultTierId(load: Record<string, unknown>): string {
  const tiers = Array.isArray(load.allowedTiers) ? load.allowedTiers : [];
  for (const value of tiers) {
    const tier = objectValue(value);
    if (tier?.isDefault === true && stringValue(tier.id)) return stringValue(tier.id);
  }
  return stringValue(objectValue(load.currentTier)?.id) || "free-tier";
}

function normalizeName(name?: string): string | undefined {
  const normalized = name?.trim();
  if (normalized && normalized.length > 80)
    throw new PoolError(400, "Account name is too long");
  return normalized || undefined;
}

function randomBase64Url(length: number): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(length)))
    binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function safeOAuthError(response: Response): Promise<string> {
  try {
    const body = await response.json() as Record<string, unknown>;
    const code = stringValue(body.error).slice(0, 80);
    const description = stringValue(body.error_description).slice(0, 300);
    return [code, description].filter(Boolean).join(": ");
  } catch {
    return "";
  }
}
