export type RecentRequest = { createdAt?: unknown; status?: unknown; usage?: { available?: boolean; totalTokens?: unknown } };
export type TrendBucket = { start: number; end: number; requests: number; successful: number; tokens: number };
export type ModelCount = { model: string; requests: number };

export function aggregateRequestTrend(records: readonly RecentRequest[], bucketCount = 12): TrendBucket[] {
  const valid = records.map((record) => ({ record, time: Number(record.createdAt) })).filter(({ time }) => Number.isFinite(time) && time > 0).sort((a, b) => a.time - b.time);
  if (!valid.length) return [];
  const count = Math.max(1, Math.min(24, Math.floor(bucketCount)));
  const first = valid[0].time;
  const last = valid[valid.length - 1].time;
  const span = Math.max(60_000, last - first);
  const width = Math.max(1, Math.ceil(span / count));
  const start = last - width * count;
  const buckets = Array.from({ length: count }, (_, index) => ({ start: start + index * width, end: start + (index + 1) * width, requests: 0, successful: 0, tokens: 0 }));
  for (const { record, time } of valid) {
    const index = Math.max(0, Math.min(count - 1, Math.floor((time - start) / width)));
    const bucket = buckets[index];
    bucket.requests++;
    const status = Number(record.status);
    if (status >= 200 && status < 400) bucket.successful++;
    if (record.usage?.available) bucket.tokens += Math.max(0, Number(record.usage.totalTokens) || 0);
  }
  return buckets;
}

export function aggregateModelDistribution(models: readonly Record<string, unknown>[], top = 5, otherLabel = "Other"): ModelCount[] {
  const counts = new Map<string, number>();
  for (const item of models) {
    const model = typeof item.model === "string" && item.model ? item.model : otherLabel;
    const requests = Math.max(0, Number(item.requests) || 0);
    if (requests) counts.set(model, (counts.get(model) || 0) + requests);
  }
  const sorted = [...counts].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  const limit = Math.max(1, Math.floor(top));
  if (sorted.length <= limit) return sorted;
  return [...sorted.slice(0, limit), { model: otherLabel, requests: sorted.slice(limit).reduce((sum, item) => sum + item.requests, 0) }];
}
