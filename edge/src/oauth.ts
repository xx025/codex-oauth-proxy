import { ImportPayload, PoolError } from "./pool";

export const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
export const BROWSER_LOGIN_TTL_MS = 10 * 60 * 1000;
export const BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";

export interface BrowserLoginSession {
  id: string;
  name?: string;
  state: string;
  codeVerifier: string;
  authorizationUrl: string;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserLoginPublic {
  id: string;
  authorizationUrl: string;
  expiresAt: number;
}

export interface DeviceLoginSession {
  id: string;
  name?: string;
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  createdAt: number;
  expiresAt: number;
}

export interface DeviceLoginPublic {
  id: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
}

interface DeviceCodeResponse {
  device_auth_id?: unknown;
  user_code?: unknown;
  usercode?: unknown;
  interval?: unknown;
}

interface AuthorizationCodeResponse {
  authorization_code?: unknown;
  code_challenge?: unknown;
  code_verifier?: unknown;
}

interface OAuthTokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export async function beginBrowserLogin(
  now: () => number = Date.now,
  name?: string,
): Promise<BrowserLoginSession> {
  const normalizedName = normalizeName(name);
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(96);
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const codeChallenge = base64Url(challengeBytes);
  const authorization = new URL(`${OPENAI_AUTH_BASE_URL}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    client_id: CODEX_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: BROWSER_REDIRECT_URI,
    scope: "openid email profile offline_access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }).toString();
  const createdAt = now();
  return {
    id: crypto.randomUUID(),
    name: normalizedName,
    state,
    codeVerifier,
    authorizationUrl: authorization.toString(),
    createdAt,
    expiresAt: createdAt + BROWSER_LOGIN_TTL_MS,
  };
}

export async function completeBrowserLogin(
  session: BrowserLoginSession,
  callbackUrl: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ImportPayload> {
  if (session.expiresAt <= now()) throw new PoolError(410, "Browser login expired; start again");
  const callback = parseBrowserCallback(callbackUrl);
  if (callback.searchParams.get("state") !== session.state) throw new PoolError(400, "OAuth state did not match");
  if (callback.searchParams.get("error")) throw new PoolError(400, "OpenAI authorization was denied");
  const code = requiredString(callback.searchParams.get("code"));
  if (!code) throw new PoolError(400, "Callback URL does not contain an authorization code");
  return exchangeAuthorizationCode(code, session.codeVerifier, BROWSER_REDIRECT_URI, session.name, fetcher, now);
}

export function publicBrowserLogin(session: BrowserLoginSession): BrowserLoginPublic {
  return { id: session.id, authorizationUrl: session.authorizationUrl, expiresAt: session.expiresAt };
}

export async function beginDeviceLogin(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  name?: string,
): Promise<DeviceLoginSession> {
  const normalizedName = normalizeName(name);
  const response = await fetcher(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
  });
  if (response.status === 404) {
    throw new PoolError(409, "Device code login is not enabled in ChatGPT security settings");
  }
  if (!response.ok) throw new PoolError(502, `OpenAI device login could not start (${response.status})`);
  const result = await safeJson<DeviceCodeResponse>(response);
  const deviceAuthId = requiredString(result.device_auth_id);
  const userCode = requiredString(result.user_code) || requiredString(result.usercode);
  const intervalSeconds = clampInterval(result.interval);
  if (!deviceAuthId || !userCode) throw new PoolError(502, "OpenAI returned an incomplete device login response");
  const createdAt = now();
  return {
    id: crypto.randomUUID(),
    name: normalizedName || undefined,
    deviceAuthId,
    userCode,
    verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    intervalSeconds,
    createdAt,
    expiresAt: createdAt + DEVICE_LOGIN_TTL_MS,
  };
}

export async function pollDeviceLogin(
  session: DeviceLoginSession,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ pending: true } | { pending: false; credentials: ImportPayload }> {
  if (session.expiresAt <= now()) throw new PoolError(410, "Device login expired; start again");
  const response = await fetcher(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
  });
  if (response.status === 403 || response.status === 404) return { pending: true };
  if (!response.ok) throw new PoolError(502, `OpenAI device login failed (${response.status})`);

  const authorization = await safeJson<AuthorizationCodeResponse>(response);
  const code = requiredString(authorization.authorization_code);
  const codeVerifier = requiredString(authorization.code_verifier);
  if (!code || !codeVerifier || !requiredString(authorization.code_challenge)) {
    throw new PoolError(502, "OpenAI returned an incomplete authorization response");
  }

  const credentials = await exchangeAuthorizationCode(
    code,
    codeVerifier,
    `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`,
    session.name,
    fetcher,
    now,
  );
  return { pending: false, credentials };
}

async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  name: string | undefined,
  fetcher: typeof fetch,
  now: () => number,
): Promise<ImportPayload> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const tokenResponse = await fetcher(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!tokenResponse.ok) throw new PoolError(502, `OpenAI token exchange failed (${tokenResponse.status})`);
  const tokens = await safeJson<OAuthTokenResponse>(tokenResponse);
  const idToken = requiredString(tokens.id_token);
  const accessToken = requiredString(tokens.access_token);
  const refreshToken = requiredString(tokens.refresh_token);
  const accountId = accountIdFromClaims(decodeJwt(idToken)) || accountIdFromClaims(decodeJwt(accessToken));
  const expiresIn = numberValue(tokens.expires_in);
  const expiresAt = jwtExpiry(accessToken) || jwtExpiry(idToken) || (expiresIn > 0 ? now() + expiresIn * 1000 : 0);
  if (!idToken || !accessToken || !refreshToken || !accountId || !expiresAt) {
    throw new PoolError(502, "OpenAI returned incomplete account credentials");
  }
  return { name, accessToken, refreshToken, accountId, expiresAt };
}

export function publicDeviceLogin(session: DeviceLoginSession): DeviceLoginPublic {
  return {
    id: session.id,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl,
    intervalSeconds: session.intervalSeconds,
    expiresAt: session.expiresAt,
  };
}

function clampInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : 5;
  return Number.isFinite(parsed) ? Math.max(3, Math.min(30, Math.ceil(parsed))) : 5;
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeName(name?: string): string | undefined {
  const normalized = name?.trim();
  if (normalized && normalized.length > 80) throw new PoolError(400, "Account name is too long");
  return normalized || undefined;
}

function parseBrowserCallback(value: string): URL {
  const input = value.trim();
  if (!input || input.length > 8_192) throw new PoolError(400, "Invalid callback URL");
  try {
    const parsed = new URL(input);
    const expected = new URL(BROWSER_REDIRECT_URI);
    if (parsed.protocol !== expected.protocol || parsed.hostname !== expected.hostname || parsed.port !== expected.port || parsed.pathname !== expected.pathname || parsed.username || parsed.password) {
      throw new Error("unexpected callback target");
    }
    return parsed;
  } catch {
    throw new PoolError(400, "Invalid callback URL");
  }
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountIdFromClaims(claims: Record<string, unknown>): string {
  const direct = requiredString(claims.chatgpt_account_id);
  if (direct) return direct;
  const auth = claims["https://api.openai.com/auth"];
  return auth && typeof auth === "object"
    ? requiredString((auth as Record<string, unknown>).chatgpt_account_id)
    : "";
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new PoolError(502, "OpenAI returned an invalid authentication response");
  }
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(normalized));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function jwtExpiry(token: string): number {
  const exp = decodeJwt(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : 0;
}
