import { PoolError } from "./pool";

export interface EgressEnv {
  NATIVE_EGRESS?: Fetcher;
}

const ALLOWED_HOSTS = new Set([
  "chatgpt.com",
  "auth.openai.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "cloudresourcemanager.googleapis.com",
]);

export function createUpstreamFetch(env: EgressEnv): typeof fetch {
  if (!env.NATIVE_EGRESS) throw new PoolError(500, "Native egress binding is not configured");
  const binding = env.NATIVE_EGRESS;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.protocol !== "https:" || target.username || target.password || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
      throw new PoolError(502, "Upstream host is not allowed by the egress policy");
    }
    return binding.fetch(request);
  };
}
