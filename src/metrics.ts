import { TokenUsage } from "./pool";

const MAX_JSON_METRICS_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 256 * 1024;

export interface RequestMetadata {
  model: string;
  endpoint: string;
  streaming: boolean;
}

export async function readTokenUsage(
  stream: ReadableStream<Uint8Array> | null,
  contentType: string,
): Promise<TokenUsage> {
  if (!stream) return emptyTokenUsage();
  return contentType.toLowerCase().includes("text/event-stream")
    ? readSseUsage(stream)
    : readJsonUsage(stream);
}

export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, available: false };
}

function tokenUsageFromPayload(input: unknown): TokenUsage {
  const root = objectValue(input);
  const response = objectValue(root?.response);
  const usage = objectValue(root?.usage) ?? objectValue(response?.usage);
  if (!usage) return emptyTokenUsage();
  const inputTokens = tokenNumber(usage.input_tokens) ?? tokenNumber(usage.prompt_tokens) ?? 0;
  const outputTokens = tokenNumber(usage.output_tokens) ?? tokenNumber(usage.completion_tokens) ?? 0;
  const explicitTotal = tokenNumber(usage.total_tokens);
  const inputDetails = objectValue(usage.input_tokens_details) ?? objectValue(usage.prompt_tokens_details);
  const cachedTokens = tokenNumber(inputDetails?.cached_tokens) ?? 0;
  const available = explicitTotal !== undefined || inputTokens > 0 || outputTokens > 0 || cachedTokens > 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? inputTokens + outputTokens,
    cachedTokens,
    available,
  };
}

async function readJsonUsage(stream: ReadableStream<Uint8Array>): Promise<TokenUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let retainedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!truncated && value) {
        retainedBytes += value.byteLength;
        if (retainedBytes <= MAX_JSON_METRICS_BYTES) body += decoder.decode(value, { stream: true });
        else truncated = true;
      }
    }
    if (truncated) return emptyTokenUsage();
    body += decoder.decode();
    return tokenUsageFromPayload(JSON.parse(body));
  } catch {
    return emptyTokenUsage();
  } finally {
    reader.releaseLock();
  }
}

async function readSseUsage(stream: ReadableStream<Uint8Array>): Promise<TokenUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let dataLines: string[] = [];
  let eventBytes = 0;
  let best = emptyTokenUsage();

  const flush = () => {
    if (dataLines.length && eventBytes <= MAX_SSE_EVENT_BYTES) {
      const payload = dataLines.join("\n").trim();
      if (payload && payload !== "[DONE]") {
        if (!payload.includes('"usage"')) {
          dataLines = [];
          eventBytes = 0;
          return;
        }
        try {
          const candidate = tokenUsageFromPayload(JSON.parse(payload));
          if (candidate.available && (!best.available || candidate.totalTokens >= best.totalTokens)) best = candidate;
        } catch {
          // Ignore non-JSON or partial events while preserving the client stream.
        }
      }
    }
    dataLines = [];
    eventBytes = 0;
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      flush();
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).replace(/^ /, "");
    eventBytes += data.length;
    if (eventBytes <= MAX_SSE_EVENT_BYTES) dataLines.push(data);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_SSE_EVENT_BYTES) {
        eventBytes = MAX_SSE_EVENT_BYTES + 1;
        pending = pending.slice(-1024);
      }
    }
    pending += decoder.decode();
    if (pending) consumeLine(pending);
    flush();
    return best;
  } catch {
    return best;
  } finally {
    reader.releaseLock();
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
