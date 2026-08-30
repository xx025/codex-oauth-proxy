import { ImportPayload, PoolError } from "./pool";

export const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;

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
}

export async function beginDeviceLogin(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  name?: string,
): Promise<DeviceLoginSession> {
  const normalizedName = name?.trim();
  if (normalizedName && normalizedName.length > 80) throw new PoolError(400, "Account name is too long");
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

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`,
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
  const claims = decodeJwt(idToken);
  const accountId = requiredString(claims.chatgpt_account_id);
  const expiresAt = jwtExpiry(accessToken) || jwtExpiry(idToken);
  if (!idToken || !accessToken || !refreshToken || !accountId || !expiresAt) {
    throw new PoolError(502, "OpenAI returned incomplete account credentials");
  }
  return {
    pending: false,
    credentials: { name: session.name, accessToken, refreshToken, accountId, expiresAt },
  };
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
