export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const body = await response.json().catch(() => ({ error: "请求失败" })) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

export const formatNumber = (value: unknown) => new Intl.NumberFormat("zh-CN", { notation: Number(value) >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value) || 0);
export const formatDate = (value: unknown) => value ? new Date(value as string | number).toLocaleString("zh-CN") : "—";
