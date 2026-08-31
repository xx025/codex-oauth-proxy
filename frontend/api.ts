export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const body = await response.json().catch(() => ({ error: "Request failed" })) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}
