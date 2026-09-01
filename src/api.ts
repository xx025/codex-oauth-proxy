import { PoolError } from "./pool";

const UPSTREAM_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const UPSTREAM_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const DEFAULT_MODEL = "gpt-5.5";
const CLIENT_VERSION = "0.151.0-alpha.7.2";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_RESPONSE_BYTES = 16 * 1024 * 1024;
const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;

export interface UpstreamAccount {
  accessToken: string;
  accountId: string;
}

export interface PreparedProxyRequest {
  kind: "responses" | "chat" | "models";
  model: string;
  streaming: boolean;
  upstreamUrl: string;
  method: "GET" | "POST";
  body?: Uint8Array;
}

export interface ProxyRequestOptions {
  serviceTier?: "standard" | "fast";
}

export async function readRequestBody(request: Request): Promise<ArrayBuffer> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new PoolError(413, "Request body is too large");
  }
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new PoolError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function prepareProxyRequest(
  pathname: string,
  bodyBytes?: ArrayBuffer,
  options: ProxyRequestOptions = {},
): PreparedProxyRequest {
  if (pathname === "/v1/models") {
    return {
      kind: "models",
      model: "model-catalog",
      streaming: false,
      upstreamUrl: `${UPSTREAM_MODELS_URL}?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
      method: "GET",
    };
  }
  const body = parseBody(bodyBytes);
  if (pathname === "/v1/responses") return prepareResponsesRequest(body, options);
  if (pathname === "/v1/chat/completions") return prepareChatRequest(body, options);
  throw new PoolError(404, "Not found");
}

export function upstreamHeaders(
  request: Request,
  account: UpstreamAccount,
  kind: PreparedProxyRequest["kind"],
): Headers {
  const headers = new Headers({
    authorization: `Bearer ${stripBearer(account.accessToken)}`,
    version: CLIENT_VERSION,
    "chatgpt-account-id": account.accountId,
    originator: "codex_cli_rs",
    "user-agent": `codex_cli_rs/${CLIENT_VERSION} (Cloudflare Workers)`,
    accept: kind === "models" ? "application/json" : "text/event-stream",
  });
  if (kind !== "models") {
    headers.set("content-type", "application/json");
    headers.set("openai-beta", "responses=v1");
    headers.set(
      "session_id",
      request.headers.get("session_id") ||
        request.headers.get("session-id") ||
        crypto.randomUUID(),
    );
    headers.set(
      "x-codex-beta-features",
      request.headers.get("x-codex-beta-features") ||
        "multi_agent,apps,prevent_idle_sleep",
    );
    copyHeader(request.headers, headers, "x-codex-turn-metadata");
    copyHeader(request.headers, headers, "x-codex-turn-state");
    copyHeader(request.headers, headers, "x-client-request-id");
    copyHeader(request.headers, headers, "thread-id");
    copyHeader(request.headers, headers, "x-codex-window-id");
  }
  return headers;
}

export async function finalizeUpstreamResponse(
  prepared: PreparedProxyRequest,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  if (prepared.kind === "models") {
    const payload = await readJsonResponse(response, 2 * 1024 * 1024);
    return Response.json(modelsFromUpstream(payload));
  }
  if (prepared.kind === "responses") {
    if (prepared.streaming) return streamResponse(response);
    return Response.json(await bufferResponses(response.body));
  }
  if (prepared.streaming) {
    return new Response(
      transformChatStream(requiredBody(response), prepared.model),
      {
        status: response.status,
        headers: streamingHeaders(response.headers),
      },
    );
  }
  return Response.json(
    await bufferChatCompletion(requiredBody(response), prepared.model),
  );
}

export function modelsFromUpstream(input: unknown): JsonObject {
  const root = objectValue(input);
  const models = Array.isArray(root?.models) ? root.models : [];
  const data: JsonObject[] = [];
  const seenModels = new Set<string>();
  for (const value of models) {
    const model = objectValue(value);
    const slug = stringValue(model?.slug);
    if (
      !slug ||
      stringValue(model?.visibility) !== "list" ||
      seenModels.has(slug)
    )
      continue;
    seenModels.add(slug);
    const displayName = stringValue(model?.display_name) || slug;
    const metadata = modelMetadata(model!);
    data.push(modelEntry(slug, displayName, slug, undefined, metadata));
    const levels = Array.isArray(model?.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : [];
    const seenEfforts = new Set<string>();
    for (const levelValue of levels) {
      const effort = stringValue(objectValue(levelValue)?.effort).toLowerCase();
      if (
        !REASONING_EFFORTS.includes(
          effort as (typeof REASONING_EFFORTS)[number],
        ) ||
        seenEfforts.has(effort)
      )
        continue;
      seenEfforts.add(effort);
      data.push(
        modelEntry(
          `${slug}-${effort}`,
          `${displayName} (${effort} reasoning)`,
          slug,
          effort,
          metadata,
        ),
      );
    }
  }
  if (!data.length)
    throw new PoolError(502, "Upstream returned no usable models");
  return { object: "list", data };
}

export function transformChatStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const transformer = new ChatEventTransformer(model);
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        emitChatPayloads(
          parser.push(decoder.decode(chunk, { stream: true })),
          transformer,
          controller,
        );
      },
      flush(controller) {
        emitChatPayloads(
          parser.push(decoder.decode(), true),
          transformer,
          controller,
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    }),
  );
}

export async function bufferResponses(
  body: ReadableStream<Uint8Array> | null,
): Promise<JsonObject> {
  if (!body) throw new PoolError(502, "Upstream returned an empty response");
  const output = new Map<number, unknown>();
  let completed: JsonObject | undefined;
  for await (const payload of readSse(body)) {
    if (payload === "[DONE]") continue;
    const event = parseJsonObject(payload, "Invalid upstream Responses event");
    const type = stringValue(event.type);
    if (type === "response.output_item.done") {
      const index = integerValue(event.output_index);
      if (index !== undefined && "item" in event) output.set(index, event.item);
    } else if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      completed = objectValue(event.response);
    } else if (type === "error") {
      const message =
        stringValue(objectValue(event.error)?.message) ||
        "Upstream Responses stream returned an error";
      throw new PoolError(502, message);
    }
  }
  if (!completed)
    throw new PoolError(
      502,
      "Responses stream ended without a terminal response",
    );
  if (output.size)
    completed.output = [...output.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  return completed;
}

export async function bufferChatCompletion(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<JsonObject> {
  const transformer = new ChatEventTransformer(model);
  let responseId = "";
  let created = Math.floor(Date.now() / 1000);
  let servedModel = model;
  let role = "assistant";
  let content = "";
  let reasoningContent = "";
  let finishReason = "stop";
  let usage: unknown;
  const toolCalls = new Map<number, JsonObject>();
  let retainedBytes = 0;
  for await (const payload of readSse(body)) {
    for (const chunk of transformer.transform(payload)) {
      responseId ||= stringValue(chunk.id);
      created = integerValue(chunk.created) ?? created;
      servedModel = stringValue(chunk.model) || servedModel;
      if (chunk.usage) usage = chunk.usage;
      const choice = objectValue(
        Array.isArray(chunk.choices) ? chunk.choices[0] : undefined,
      );
      const delta = objectValue(choice?.delta);
      role = stringValue(delta?.role) || role;
      const text = stringValue(delta?.content);
      const reasoning = stringValue(delta?.reasoning_content);
      content += text;
      reasoningContent += reasoning;
      retainedBytes +=
        encoder.encode(text).byteLength + encoder.encode(reasoning).byteLength;
      if (retainedBytes > MAX_BUFFERED_RESPONSE_BYTES)
        throw new PoolError(502, "Buffered response is too large");
      const finish = stringValue(choice?.finish_reason);
      if (finish) finishReason = finish;
      const deltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      for (const callDeltaValue of deltas)
        mergeToolCall(toolCalls, objectValue(callDeltaValue));
    }
  }
  const message: JsonObject = {
    role,
    content: content || (toolCalls.size ? null : ""),
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.size)
    message.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
  return {
    id: responseId || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created,
    model: servedModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function prepareResponsesRequest(
  body: JsonObject,
  options: ProxyRequestOptions,
): PreparedProxyRequest {
  const clientStream = body.stream === true;
  const model = normalizeModel(stringValue(body.model));
  const reasoning = reasoningSettings(body, model);
  body.model = model;
  body.store = false;
  body.stream = true;
  delete body.max_output_tokens;
  delete body.max_tokens;
  delete body.reasoning_effort;
  applyServiceTier(body, options.serviceTier);
  normalizeResponsesInput(body);
  body.include = ["reasoning.encrypted_content"];
  if (!("tool_choice" in body)) body.tool_choice = "auto";
  if (!("parallel_tool_calls" in body)) body.parallel_tool_calls = false;
  body.reasoning = reasoning;
  return {
    kind: "responses",
    model,
    streaming: clientStream,
    upstreamUrl: UPSTREAM_RESPONSES_URL,
    method: "POST",
    body: encoder.encode(JSON.stringify(body)),
  };
}

function prepareChatRequest(
  body: JsonObject,
  options: ProxyRequestOptions,
): PreparedProxyRequest {
  const model = normalizeModel(stringValue(body.model));
  const input: unknown[] = [];
  const instructions: string[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const value of messages) {
    const message = objectValue(value);
    const role = stringValue(message?.role);
    if (!message || !role) continue;
    if (role === "system" || role === "developer") {
      const text = collectText(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "user") {
      const content = userContent(message.content);
      if (content.length)
        input.push({ type: "message", role: "user", content });
      continue;
    }
    if (role === "assistant") {
      const content = outputContent(message.content);
      if (content.length)
        input.push({ type: "message", role: "assistant", content });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const callValue of calls) {
        const call = objectValue(callValue);
        const fn = objectValue(call?.function);
        const callId = stringValue(call?.id);
        const name = stringValue(fn?.name);
        if (!callId || !name) continue;
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: argumentsValue(fn?.arguments),
        });
      }
      continue;
    }
    if (role === "tool") {
      const callId = stringValue(message.tool_call_id);
      if (callId)
        input.push({
          type: "function_call_output",
          call_id: callId,
          output: collectText(message.content),
        });
    }
  }
  const upstream: JsonObject = {
    model,
    instructions: instructions.join("\n\n"),
    input,
    tools: mapTools(body.tools),
    tool_choice: body.tool_choice ?? "auto",
    parallel_tool_calls:
      typeof body.parallel_tool_calls === "boolean"
        ? body.parallel_tool_calls
        : false,
    reasoning: reasoningSettings(body, model),
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  };
  applyServiceTier(upstream, options.serviceTier);
  if (typeof body.prompt_cache_key === "string")
    upstream.prompt_cache_key = body.prompt_cache_key;
  return {
    kind: "chat",
    model,
    streaming: body.stream === true,
    upstreamUrl: UPSTREAM_RESPONSES_URL,
    method: "POST",
    body: encoder.encode(JSON.stringify(upstream)),
  };
}

function normalizeResponsesInput(body: JsonObject): void {
  if (typeof body.input === "string") {
    body.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: body.input }],
      },
    ];
    return;
  }
  if (!Array.isArray(body.input)) body.input = [];
  const instructions =
    typeof body.instructions === "string" ? body.instructions.trim() : "";
  const systemParts: string[] = [];
  const filtered: unknown[] = [];
  for (const value of body.input as unknown[]) {
    const message = objectValue(value);
    if (!message) {
      filtered.push(value);
      continue;
    }
    if (message.role === "system") {
      const text = collectText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (typeof message.id === "string" && message.id.length > 64)
      delete message.id;
    filtered.push(message);
  }
  const systemText = systemParts.join("\n\n");
  if (instructions && systemText)
    filtered.unshift({ role: "developer", content: systemText });
  body.instructions = instructions || systemText;
  body.input = filtered;
}

function applyServiceTier(body: JsonObject, serviceTier: ProxyRequestOptions["serviceTier"]): void {
  delete body.service_tier;
  void serviceTier;
}

function normalizeModel(input: string): string {
  let model = input.trim().toLowerCase();
  for (const effort of [...REASONING_EFFORTS].sort(
    (left, right) => right.length - left.length,
  )) {
    if (model.endsWith(`-${effort}`)) {
      model = model.slice(0, -(effort.length + 1));
      break;
    }
  }
  if (!model) return DEFAULT_MODEL;
  if (model.includes("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (model.includes("gpt-5.6-terra")) return "gpt-5.6-terra";
  if (model.includes("gpt-5.6-luna")) return "gpt-5.6-luna";
  if (model.includes("daybreak")) return "gpt-daybreak-blue-latest";
  if (model.includes("gpt-5.5")) return "gpt-5.5";
  if (model.includes("gpt-5.4-mini")) return "gpt-5.4-mini";
  if (model.includes("gpt-5.4")) return "gpt-5.4";
  return model;
}

function reasoningSettings(body: JsonObject, model: string): JsonObject {
  const existing = objectValue(body.reasoning);
  let effort =
    stringValue(existing?.effort) || stringValue(body.reasoning_effort);
  if (!effort) {
    const requestedModel = stringValue(body.model);
    effort =
      REASONING_EFFORTS.find((candidate) =>
        requestedModel.endsWith(`-${candidate}`),
      ) || "";
  }
  if (
    !REASONING_EFFORTS.includes(effort as (typeof REASONING_EFFORTS)[number])
  ) {
    effort =
      model.includes("5.6") || model.includes("daybreak") ? "low" : "medium";
  }
  return { effort, summary: existing?.summary ?? "auto" };
}

function userContent(value: unknown): JsonObject[] {
  if (typeof value === "string")
    return value ? [{ type: "input_text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  const result: JsonObject[] = [];
  for (const partValue of value) {
    const part = objectValue(partValue);
    const type = stringValue(part?.type);
    if (type === "text" || type === "input_text") {
      const text = stringValue(part?.text);
      if (text) result.push({ type: "input_text", text });
    } else if (type === "image_url") {
      const image = objectValue(part?.image_url);
      const url = stringValue(image?.url);
      if (url)
        result.push({
          type: "input_image",
          image_url: url,
          ...(image?.detail ? { detail: image.detail } : {}),
        });
    } else if (type === "input_image" && typeof part?.image_url === "string") {
      result.push(part);
    }
  }
  return result;
}

function outputContent(value: unknown): JsonObject[] {
  const text = collectText(value);
  return text ? [{ type: "output_text", text }] : [];
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => stringValue(objectValue(item)?.text))
    .filter(Boolean)
    .join("\n");
}

function argumentsValue(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value);
}

function mapTools(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const tools: JsonObject[] = [];
  for (const toolValue of value) {
    const tool = objectValue(toolValue);
    const fn = objectValue(tool?.function);
    const name = stringValue(fn?.name);
    if (tool?.type !== "function" || !name) continue;
    tools.push({
      type: "function",
      name,
      description: stringValue(fn?.description),
      parameters: fn?.parameters ?? { type: "object", properties: {} },
      strict: false,
    });
  }
  return tools;
}

class SseParser {
  private pending = "";
  private dataLines: string[] = [];
  private eventBytes = 0;

  push(text: string, final = false): string[] {
    this.pending += text;
    const payloads: string[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      this.consumeLine(this.pending.slice(0, newline), payloads);
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    if (this.pending.length > MAX_SSE_EVENT_BYTES)
      throw new PoolError(502, "Upstream SSE event is too large");
    if (final) {
      if (this.pending) this.consumeLine(this.pending, payloads);
      this.pending = "";
      this.flush(payloads);
    }
    return payloads;
  }

  private consumeLine(rawLine: string, payloads: string[]): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      this.flush(payloads);
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).replace(/^ /, "");
    this.eventBytes += encoder.encode(data).byteLength;
    if (this.eventBytes > MAX_SSE_EVENT_BYTES)
      throw new PoolError(502, "Upstream SSE event is too large");
    this.dataLines.push(data);
  }

  private flush(payloads: string[]): void {
    if (this.dataLines.length) payloads.push(this.dataLines.join("\n").trim());
    this.dataLines = [];
    this.eventBytes = 0;
  }
}

class ChatEventTransformer {
  private responseId = `chatcmpl-${crypto.randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private roleSent = false;
  private sawToolCalls = false;
  private nextToolIndex = 0;
  private readonly toolIndexes = new Map<string, number>();

  constructor(private readonly model: string) {}

  transform(payload: string): JsonObject[] {
    if (!payload || payload === "[DONE]") return [];
    const event = parseJsonObject(payload, "Invalid upstream chat event");
    const type = stringValue(event.type);
    if (type === "response.created") {
      const id = stringValue(objectValue(event.response)?.id);
      if (id) this.responseId = `chatcmpl-${id}`;
      return [];
    }
    if (type.startsWith("response.reasoning") && type.endsWith(".delta")) {
      if ((integerValue(event.output_index) ?? 0) > 0) return [];
      const text = reasoningText(event);
      return text
        ? [...this.roleChunk(), this.chunk({ reasoning_content: text })]
        : [];
    }
    if (type === "response.output_text.delta") {
      return [
        ...this.roleChunk(),
        this.chunk({ content: stringValue(event.delta) }),
      ];
    }
    if (type === "response.output_item.added") return this.toolStart(event);
    if (type === "response.function_call_arguments.delta")
      return this.toolArguments(event);
    if (type === "response.completed") {
      const usage = chatUsage(objectValue(objectValue(event.response)?.usage));
      return [this.chunk({}, this.sawToolCalls ? "tool_calls" : "stop", usage)];
    }
    return [];
  }

  private roleChunk(): JsonObject[] {
    if (this.roleSent) return [];
    this.roleSent = true;
    return [this.chunk({ role: "assistant" })];
  }

  private toolStart(event: JsonObject): JsonObject[] {
    const item = objectValue(event.item);
    if (item?.type !== "function_call") return [];
    const itemId = stringValue(item.id) || crypto.randomUUID();
    const index = this.nextToolIndex++;
    this.toolIndexes.set(itemId, index);
    this.sawToolCalls = true;
    return [
      ...this.roleChunk(),
      this.chunk({
        tool_calls: [
          {
            index,
            id: stringValue(item.call_id) || `call_${itemId}`,
            type: "function",
            function: { name: stringValue(item.name), arguments: "" },
          },
        ],
      }),
    ];
  }

  private toolArguments(event: JsonObject): JsonObject[] {
    const index = this.toolIndexes.get(stringValue(event.item_id));
    if (index === undefined) return [];
    return [
      ...this.roleChunk(),
      this.chunk({
        tool_calls: [
          { index, function: { arguments: stringValue(event.delta) } },
        ],
      }),
    ];
  }

  private chunk(
    delta: JsonObject,
    finishReason: string | null = null,
    usage?: JsonObject,
  ): JsonObject {
    return {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
  }
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of parser.push(
        decoder.decode(value, { stream: true }),
      ))
        yield payload;
    }
    for (const payload of parser.push(decoder.decode(), true)) yield payload;
  } finally {
    reader.releaseLock();
  }
}

function emitChatPayloads(
  payloads: string[],
  transformer: ChatEventTransformer,
  controller: TransformStreamDefaultController<Uint8Array>,
): void {
  for (const payload of payloads) {
    for (const chunk of transformer.transform(payload)) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
  }
}

function mergeToolCall(
  calls: Map<number, JsonObject>,
  delta: JsonObject | undefined,
): void {
  const index = integerValue(delta?.index);
  if (index === undefined) return;
  const current = calls.get(index) ?? {
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  };
  const currentFunction = objectValue(current.function) ?? {};
  const deltaFunction = objectValue(delta?.function);
  current.id = stringValue(delta?.id) || current.id;
  current.type = stringValue(delta?.type) || current.type;
  current.function = {
    name: stringValue(deltaFunction?.name) || stringValue(currentFunction.name),
    arguments:
      stringValue(currentFunction.arguments) +
      stringValue(deltaFunction?.arguments),
  };
  calls.set(index, current);
}

function chatUsage(usage: JsonObject | undefined): JsonObject {
  const promptTokens =
    numberValue(usage?.input_tokens) ?? numberValue(usage?.prompt_tokens) ?? 0;
  const completionTokens =
    numberValue(usage?.output_tokens) ??
    numberValue(usage?.completion_tokens) ??
    0;
  const inputDetails =
    objectValue(usage?.input_tokens_details) ??
    objectValue(usage?.prompt_tokens_details);
  const cachedTokens = numberValue(inputDetails?.cached_tokens) ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      numberValue(usage?.total_tokens) ?? promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  };
}

function reasoningText(event: JsonObject): string {
  const direct = stringValue(event.delta) || stringValue(event.text);
  if (direct) return direct;
  const part = objectValue(event.part);
  return stringValue(part?.text);
}

function modelEntry(
  id: string,
  name: string,
  baseModel: string,
  effort?: string,
  metadata: JsonObject = {},
): JsonObject {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "openai",
    name,
    base_model: baseModel,
    ...metadata,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

function modelMetadata(model: JsonObject): JsonObject {
  const sourceCapabilities = objectValue(model.capabilities);
  const sourceLimits = [
    objectValue(sourceCapabilities?.limits),
    sourceCapabilities,
    objectValue(model.limits),
    objectValue(model.usage_limits),
    model,
  ];
  const limits: JsonObject = {};
  addNumber(limits, "max_context_window_tokens", sourceLimits, model, [
    "max_context_window_tokens",
    "context_window_tokens",
    "context_window",
    "context_length",
    "max_context_length",
    "max_context_tokens",
    "max_tokens",
  ]);
  addNumber(limits, "max_output_tokens", sourceLimits, model, [
    "max_output_tokens",
    "max_completion_tokens",
    "output_token_limit",
    "output_tokens",
    "max_output",
    "max_output_length",
    "max_response_tokens",
  ]);
  addNumber(limits, "max_prompt_tokens", sourceLimits, model, [
    "max_prompt_tokens",
    "max_input_tokens",
    "prompt_token_limit",
    "input_token_limit",
    "input_tokens",
    "max_input",
    "max_input_length",
  ]);

  const supports: JsonObject = {};
  const sourceSupports = objectValue(sourceCapabilities?.supports);
  const supportAliases: Array<[string, string[]]> = [
    ["reasoning", ["reasoning", "supports_reasoning"]],
    ["tools", ["tools", "tool_calls", "function_calling", "supports_tools"]],
    ["vision", ["vision", "image_input", "supports_vision"]],
    ["streaming", ["streaming", "supports_streaming"]],
    [
      "parallel_tool_calls",
      ["parallel_tool_calls", "supports_parallel_tool_calls"],
    ],
    [
      "structured_outputs",
      ["structured_outputs", "json_schema", "supports_structured_outputs"],
    ],
  ];
  for (const [name, aliases] of supportAliases) {
    const value = firstBoolean(
      [sourceSupports, sourceCapabilities, objectValue(model.supports), model],
      aliases,
    );
    if (value !== undefined) supports[name] = value;
  }

  const capabilities: JsonObject = {};
  if (Object.keys(limits).length) capabilities.limits = limits;
  if (Object.keys(supports).length) capabilities.supports = supports;
  const metadata: JsonObject = {};
  if (Object.keys(capabilities).length) metadata.capabilities = capabilities;
  addString(metadata, "family", model, ["family", "model_family"]);
  addString(metadata, "vendor", model, ["vendor", "provider", "owned_by"]);
  addString(metadata, "version", model, ["version", "model_version"]);
  addString(metadata, "category", model, ["category", "model_category"]);
  const preview = firstBoolean([model], ["preview", "is_preview"]);
  if (preview !== undefined) metadata.preview = preview;
  const endpoints = firstStringArray(model, [
    "supported_endpoints",
    "endpoints",
    "supported_api_endpoints",
  ]);
  if (endpoints?.length) metadata.supported_endpoints = [...new Set(endpoints)];
  return metadata;
}

function addNumber(
  target: JsonObject,
  key: string,
  sources: Array<JsonObject | undefined>,
  direct: JsonObject,
  aliases: string[],
): void {
  for (const source of [...sources, direct]) {
    for (const alias of aliases) {
      const value = numberValue(source?.[alias]);
      if (value !== undefined && value >= 0) {
        target[key] = value;
        return;
      }
    }
  }
}

function addString(
  target: JsonObject,
  key: string,
  source: JsonObject,
  aliases: string[],
): void {
  for (const alias of aliases) {
    const value = stringValue(source[alias]).trim();
    if (value) {
      target[key] = value;
      return;
    }
  }
}

function firstBoolean(
  sources: Array<JsonObject | undefined>,
  aliases: string[],
): boolean | undefined {
  for (const source of sources) {
    for (const alias of aliases)
      if (typeof source?.[alias] === "boolean") return source[alias] as boolean;
  }
  return undefined;
}

function firstStringArray(
  source: JsonObject,
  aliases: string[],
): string[] | undefined {
  for (const alias of aliases) {
    const value = source[alias];
    if (Array.isArray(value))
      return value
        .map(stringValue)
        .map((item) => item.trim())
        .filter(Boolean);
  }
  return undefined;
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const body = requiredBody(response);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PoolError(502, "Upstream JSON response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PoolError(502, "Upstream returned invalid JSON");
  }
}

function streamResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: streamingHeaders(response.headers),
  });
}

function streamingHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return headers;
}

function requiredBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body)
    throw new PoolError(502, "Upstream returned an empty response");
  return response.body;
}

function parseBody(bytes?: ArrayBuffer): JsonObject {
  if (!bytes?.byteLength) throw new PoolError(400, "Request body is required");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const body = objectValue(parsed);
    if (!body) throw new Error("not an object");
    return body;
  } catch {
    throw new PoolError(400, "Invalid JSON request body");
  }
}

function parseJsonObject(value: string, message: string): JsonObject {
  try {
    const parsed = objectValue(JSON.parse(value));
    if (parsed) return parsed;
  } catch {}
  throw new PoolError(502, message);
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function stripBearer(token: string): string {
  const trimmed = token.trim();
  return trimmed.toLowerCase().startsWith("bearer ")
    ? trimmed.slice(7).trim()
    : trimmed;
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);
  if (value) target.set(name, value);
}
