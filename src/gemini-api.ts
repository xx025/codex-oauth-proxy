import { PoolError } from "./pool";

export const ANTIGRAVITY_GENERATE_CONTENT_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

export const ANTIGRAVITY_MODELS = [
  {
    id: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash High",
    category: "reasoning",
    vendor: "Google",
  },
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash High",
    category: "fast",
    vendor: "Google",
  },
  {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash High",
    category: "fast",
    vendor: "Google",
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    category: "fast",
    vendor: "Google",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    category: "fast",
    vendor: "Google",
  },
  {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro Low",
    category: "multimodal",
    vendor: "Google",
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    category: "fast",
    vendor: "Google",
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    category: "multimodal",
    vendor: "Google",
  },
  {
    id: "gemini-pro-agent",
    name: "Gemini Pro Agent",
    category: "multimodal",
    vendor: "Google",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    category: "multimodal",
    vendor: "Anthropic",
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking",
    category: "reasoning",
    vendor: "Anthropic",
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B Medium",
    category: "reasoning",
    vendor: "OpenAI",
  },
] as const;

export function antigravityModelEntries(): JsonObject[] {
  return ANTIGRAVITY_MODELS.map((item) => ({
    id: item.id,
    object: "model",
    created: 1725000000,
    owned_by: item.vendor.toLowerCase(),
    name: item.name,
    base_model: item.id,
    family: "antigravity",
    vendor: item.vendor,
    category: item.category,
    supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
    },
  }));
}

const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_RESPONSE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
export type GeminiClientKind = "responses" | "chat";

export interface GeminiPreparedRequest {
  model: string;
  request: JsonObject;
}

export function prepareGeminiRequest(
  kind: GeminiClientKind,
  body: JsonObject,
): GeminiPreparedRequest {
  const requestedModel = stringValue(body.model).trim();
  const model = requestedModel;
  if (!model) throw new PoolError(400, "A model is required");
  rejectUnsupported(body, kind);
  const converted =
    kind === "responses" ? responsesContents(body) : chatContents(body);
  const request: JsonObject = { contents: converted.contents };
  if (converted.system.length) {
    request.systemInstruction = {
      parts: [{ text: converted.system.join("\n\n") }],
    };
  }
  const tools = geminiTools(body.tools);
  if (tools.length) request.tools = [{ functionDeclarations: tools }];
  const toolConfig = geminiToolConfig(body.tool_choice, tools);
  if (toolConfig) request.toolConfig = toolConfig;
  const generationConfig = geminiGenerationConfig(body);
  if (Object.keys(generationConfig).length)
    request.generationConfig = generationConfig;
  return { model, request };
}

export function antigravityRequestBody(
  prepared: GeminiPreparedRequest,
  project: string,
  sessionId: string,
): Uint8Array {
  if (!project.trim())
    throw new PoolError(503, "Selected Antigravity account has no project");
  const imageModel = prepared.model.toLowerCase().includes("image");
  return encoder.encode(
    JSON.stringify({
      requestId: `agent-${crypto.randomUUID()}`,
      requestType: imageModel ? "image_gen" : "agent",
      userAgent: "antigravity",
      project: project.trim(),
      model: prepared.model,
      request: { ...prepared.request, sessionId },
    }),
  );
}

export function antigravityHeaders(accessToken: string): Headers {
  return new Headers({
    authorization: `Bearer ${stripBearer(accessToken)}`,
    "content-type": "application/json",
    "user-agent": "antigravity/hub/2.9.1 darwin/arm64",
  });
}

export async function finalizeGeminiResponse(
  kind: GeminiClientKind,
  streaming: boolean,
  model: string,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  const body = requiredBody(response);
  if (kind === "chat") {
    if (streaming)
      return new Response(transformGeminiChatStream(body, model), {
        status: response.status,
        headers: streamingHeaders(response.headers),
      });
    return Response.json(await bufferGeminiChat(body, model));
  }
  if (streaming)
    return new Response(transformGeminiResponsesStream(body, model), {
      status: response.status,
      headers: streamingHeaders(response.headers),
    });
  return Response.json(await bufferGeminiResponses(body, model));
}

export function transformGeminiChatStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const state = new GeminiState(model);
  return transformGeminiStream(
    body,
    (payload) => state.chatEvents(payload).map(sseData),
    () => state.assertFinished(),
  );
}

export function transformGeminiResponsesStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const state = new GeminiState(model);
  return transformGeminiStream(
    body,
    (payload) => state.responseEvents(payload).map(sseData),
    () => state.assertFinished(),
  );
}

export async function bufferGeminiChat(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<JsonObject> {
  const state = new GeminiState(model);
  for await (const payload of readSse(body)) state.consume(payload);
  state.assertFinished();
  return state.chatCompletion();
}

export async function bufferGeminiResponses(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<JsonObject> {
  const state = new GeminiState(model);
  for await (const payload of readSse(body)) state.consume(payload);
  state.assertFinished();
  return state.responsesCompletion();
}

function responsesContents(body: JsonObject): {
  contents: JsonObject[];
  system: string[];
} {
  const system: string[] = [];
  if (typeof body.instructions === "string" && body.instructions)
    system.push(body.instructions);
  const source =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : Array.isArray(body.input)
        ? body.input
        : [];
  const contents: JsonObject[] = [];
  const callNames = new Map<string, string>();
  for (const value of source) {
    const item = objectValue(value);
    if (!item) throw new PoolError(400, "Invalid Responses input item");
    const type = stringValue(item.type);
    const role = stringValue(item.role);
    if (role === "system" || role === "developer") {
      const text = collectText(item.content);
      if (text) system.push(text);
    } else if (type === "function_call") {
      const name = requiredString(item.name, "function_call.name");
      const id = stringValue(item.call_id) || stringValue(item.id);
      if (id) callNames.set(id, name);
      contents.push({
        role: "model",
        parts: [{ functionCall: { ...(id ? { id } : {}), name, args: parseArguments(item.arguments) } }],
      });
    } else if (type === "function_call_output") {
      const id = requiredString(item.call_id, "function_call_output.call_id");
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            id,
            name: callNames.get(id) || "unknown_function",
            response: functionResponseValue(item.output),
          },
        }],
      });
    } else if (role === "user" || role === "assistant") {
      const parts = geminiParts(item.content, role === "assistant");
      if (parts.length)
        contents.push({ role: role === "assistant" ? "model" : "user", parts });
    } else {
      throw new PoolError(400, `Unsupported Responses input item: ${type || role || "unknown"}`);
    }
  }
  return { contents, system };
}

function chatContents(body: JsonObject): {
  contents: JsonObject[];
  system: string[];
} {
  if (!Array.isArray(body.messages))
    throw new PoolError(400, "Chat messages must be an array");
  const contents: JsonObject[] = [];
  const system: string[] = [];
  const callNames = new Map<string, string>();
  for (const value of body.messages) {
    const message = objectValue(value);
    const role = stringValue(message?.role);
    if (!message || !role) throw new PoolError(400, "Invalid chat message");
    if (role === "system" || role === "developer") {
      const text = collectText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "user") {
      const parts = geminiParts(message.content, false);
      if (parts.length) contents.push({ role: "user", parts });
      continue;
    }
    if (role === "assistant") {
      const parts = geminiParts(message.content, true);
      for (const value of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const call = objectValue(value);
        const fn = objectValue(call?.function);
        const id = stringValue(call?.id);
        const name = requiredString(fn?.name, "tool_calls.function.name");
        if (id) callNames.set(id, name);
        parts.push({ functionCall: { ...(id ? { id } : {}), name, args: parseArguments(fn?.arguments) } });
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    if (role === "tool") {
      const id = requiredString(message.tool_call_id, "tool_call_id");
      contents.push({
        role: "user",
        parts: [{ functionResponse: {
          id,
          name: callNames.get(id) || stringValue(message.name) || "unknown_function",
          response: functionResponseValue(message.content),
        } }],
      });
      continue;
    }
    throw new PoolError(400, `Unsupported chat role: ${role}`);
  }
  return { contents, system };
}

function geminiParts(value: unknown, model: boolean): JsonObject[] {
  if (typeof value === "string") return value ? [{ text: value }] : [];
  if (!Array.isArray(value)) return [];
  const parts: JsonObject[] = [];
  for (const valuePart of value) {
    const part = objectValue(valuePart);
    const type = stringValue(part?.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = stringValue(part?.text);
      if (text) parts.push({ text });
    } else if (type === "input_image" || type === "image_url") {
      if (model) throw new PoolError(400, "Images are not supported in assistant content");
      const image = objectValue(part?.image_url);
      parts.push(imagePart(stringValue(part?.image_url) || stringValue(image?.url)));
    } else {
      throw new PoolError(400, `Unsupported content part: ${type || "unknown"}`);
    }
  }
  return parts;
}

function imagePart(url: string): JsonObject {
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (data)
    return { inlineData: { mimeType: data[1], data: data[2].replace(/\s/g, "") } };
  if (/^https:\/\//i.test(url)) return { fileData: { fileUri: url } };
  throw new PoolError(400, "Gemini images must use a base64 data URL or HTTPS URL");
}

function geminiTools(value: unknown): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PoolError(400, "Tools must be an array");
  return value.map((toolValue) => {
    const tool = objectValue(toolValue);
    const fn = objectValue(tool?.function) ?? tool;
    if (tool?.type !== "function" || !fn)
      throw new PoolError(400, "Gemini CLI only supports function tools");
    return {
      name: requiredString(fn.name, "tool.function.name"),
      ...(stringValue(fn.description) ? { description: stringValue(fn.description) } : {}),
      parameters: objectValue(fn.parameters) ?? { type: "object", properties: {} },
    };
  });
}

function geminiToolConfig(value: unknown, tools: JsonObject[]): JsonObject | undefined {
  if (!tools.length && value === undefined) return undefined;
  let mode = "AUTO";
  let allowedFunctionNames: string[] | undefined;
  if (value === "none") mode = "NONE";
  else if (value === "required") mode = "ANY";
  else if (value !== undefined && value !== "auto") {
    const choice = objectValue(value);
    const fn = objectValue(choice?.function);
    if (choice?.type !== "function" || !stringValue(fn?.name))
      throw new PoolError(400, "Unsupported Gemini tool_choice");
    mode = "ANY";
    allowedFunctionNames = [stringValue(fn?.name)];
  }
  return { functionCallingConfig: { mode, ...(allowedFunctionNames ? { allowedFunctionNames } : {}) } };
}

function geminiGenerationConfig(body: JsonObject): JsonObject {
  const config: JsonObject = { thinkingConfig: { includeThoughts: true } };
  const max = numberValue(body.max_output_tokens) ?? numberValue(body.max_tokens) ??
    numberValue(body.max_completion_tokens);
  if (max !== undefined) config.maxOutputTokens = max;
  if (numberValue(body.temperature) !== undefined) config.temperature = body.temperature;
  if (numberValue(body.top_p) !== undefined) config.topP = body.top_p;
  if (body.stop !== undefined) {
    if (
      typeof body.stop !== "string" &&
      (!Array.isArray(body.stop) || body.stop.some((value) => typeof value !== "string"))
    )
      throw new PoolError(400, "Gemini stop must be a string or string array");
    config.stopSequences = typeof body.stop === "string" ? [body.stop] : body.stop;
  }
  const format = objectValue(body.response_format);
  if (format?.type === "json_object") config.responseMimeType = "application/json";
  else if (format?.type === "json_schema") {
    const schema = objectValue(format.json_schema);
    config.responseMimeType = "application/json";
    config.responseSchema = schema?.schema;
  } else if (format && format.type !== "text")
    throw new PoolError(400, "Unsupported Gemini response_format");
  return config;
}

function rejectUnsupported(body: JsonObject, kind: GeminiClientKind): void {
  if (body.stream_options !== undefined && objectValue(body.stream_options)?.include_usage === false)
    throw new PoolError(400, "Gemini CLI always returns stream usage");
  if (body.n !== undefined && body.n !== 1)
    throw new PoolError(400, "Gemini CLI only supports n=1");
  for (const field of ["audio", "logit_bias", "logprobs", "top_logprobs", "prediction", "modalities"]) {
    if (body[field] !== undefined)
      throw new PoolError(400, `Gemini CLI does not support ${field}`);
  }
  if (kind === "responses" && body.background === true)
    throw new PoolError(400, "Gemini CLI does not support background responses");
}

class GeminiState {
  private readonly id = `resp_${crypto.randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private text = "";
  private thought = "";
  private calls: JsonObject[] = [];
  private finish = "stop";
  private usage?: JsonObject;
  private responseStarted = false;
  private chatRoleSent = false;
  private terminalSent = false;
  private reasoningStarted = false;
  private messageStarted = false;
  private retainedBytes = 0;
  private finished = false;

  constructor(private readonly model: string) {}

  consume(payload: string): { text: string[]; thought: string[]; calls: JsonObject[] } {
    const root = parseJsonObject(payload, "Invalid Gemini SSE event");
    const response = objectValue(root.response);
    if (!response) {
      const error = objectValue(root.error);
      throw new PoolError(
        502,
        stringValue(error?.message) || "Gemini event did not contain a response",
      );
    }
    const text: string[] = [];
    const thought: string[] = [];
    const calls: JsonObject[] = [];
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidateValue of candidates) {
      const candidate = objectValue(candidateValue);
      const content = objectValue(candidate?.content);
      for (const partValue of Array.isArray(content?.parts) ? content.parts : []) {
        const part = objectValue(partValue);
        const value = stringValue(part?.text);
        if (value) {
          if (part?.thought === true) { this.thought += value; thought.push(value); }
          else { this.text += value; text.push(value); }
          this.retain(value);
        }
        const functionCall = objectValue(part?.functionCall);
        if (functionCall) {
          const call = {
            id: stringValue(functionCall.id) || `call_${crypto.randomUUID()}`,
            name: requiredString(functionCall.name, "Gemini functionCall.name", 502),
            arguments: JSON.stringify(objectValue(functionCall.args) ?? {}),
          };
          this.retain(JSON.stringify(call));
          this.calls.push(call);
          calls.push(call);
        }
      }
      const reason = stringValue(candidate?.finishReason);
      if (reason) {
        this.finished = true;
        this.finish = finishReason(reason, this.calls.length > 0);
      }
    }
    const usage = objectValue(response.usageMetadata);
    if (usage) this.usage = usage;
    return { text, thought, calls };
  }

  chatEvents(payload: string): JsonObject[] {
    const delta = this.consume(payload);
    const events: JsonObject[] = [];
    const role = () => {
      if (this.chatRoleSent) return;
      this.chatRoleSent = true;
      events.push(this.chatChunk({ role: "assistant" }));
    };
    for (const value of delta.thought) { role(); events.push(this.chatChunk({ reasoning_content: value })); }
    for (const value of delta.text) { role(); events.push(this.chatChunk({ content: value })); }
    for (const call of delta.calls) {
      role();
      const index = this.calls.indexOf(call);
      events.push(this.chatChunk({ tool_calls: [{
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }] }));
    }
    if (this.isFinished(payload) && !this.terminalSent) {
      this.terminalSent = true;
      events.push(this.chatChunk({}, this.finish, this.chatUsage()));
    }
    return events;
  }

  responseEvents(payload: string): JsonObject[] {
    const delta = this.consume(payload);
    const events: JsonObject[] = [];
    if (!this.responseStarted) {
      this.responseStarted = true;
      events.push({ type: "response.created", response: this.responseObject("in_progress", []) });
    }
    if (delta.thought.length && !this.reasoningStarted) {
      this.reasoningStarted = true;
      events.push({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: `rs_${this.id}`, type: "reasoning", status: "in_progress", summary: [] },
      });
    }
    for (const value of delta.thought)
      events.push({ type: "response.reasoning_summary_text.delta", delta: value, output_index: 0 });
    if (delta.text.length && !this.messageStarted) {
      this.messageStarted = true;
      events.push({
        type: "response.output_item.added",
        output_index: this.thought ? 1 : 0,
        item: { id: `msg_${this.id}`, type: "message", role: "assistant", status: "in_progress", content: [] },
      });
    }
    for (const value of delta.text)
      events.push({ type: "response.output_text.delta", delta: value, output_index: this.thought ? 1 : 0, content_index: 0 });
    for (const call of delta.calls) {
      const index = this.calls.indexOf(call) + (this.thought ? 1 : 0) + (this.text ? 1 : 0);
      const item = this.responseCall(call);
      events.push({ type: "response.output_item.added", output_index: index, item });
      events.push({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: call.arguments });
    }
    if (this.isFinished(payload) && !this.terminalSent) {
      this.terminalSent = true;
      const output = this.responseOutput();
      output.forEach((item, output_index) => events.push({ type: "response.output_item.done", output_index, item }));
      events.push({ type: "response.completed", response: this.responseObject("completed", output) });
    }
    return events;
  }

  chatCompletion(): JsonObject {
    const toolCalls = this.calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    const message: JsonObject = { role: "assistant", content: this.text || (toolCalls.length ? null : "") };
    if (this.thought) message.reasoning_content = this.thought;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: `chatcmpl-${this.id}`,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finish }],
      ...(this.usage ? { usage: this.chatUsage() } : {}),
    };
  }

  responsesCompletion(): JsonObject {
    return this.responseObject("completed", this.responseOutput());
  }

  assertFinished(): void {
    if (!this.finished)
      throw new PoolError(502, "Gemini stream ended without a finish reason");
  }

  private responseOutput(): JsonObject[] {
    const output: JsonObject[] = [];
    if (this.thought)
      output.push({ id: `rs_${this.id}`, type: "reasoning", summary: [{ type: "summary_text", text: this.thought }] });
    if (this.text)
      output.push({ id: `msg_${this.id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: this.text, annotations: [] }] });
    output.push(...this.calls.map((call) => this.responseCall(call)));
    return output;
  }

  private responseCall(call: JsonObject): JsonObject {
    return { id: `fc_${call.id}`, type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" };
  }

  private responseObject(status: string, output: JsonObject[]): JsonObject {
    return {
      id: this.id,
      object: "response",
      created_at: this.created,
      status,
      model: this.model,
      output,
      ...(this.usage ? { usage: this.responsesUsage() } : {}),
    };
  }

  private chatChunk(delta: JsonObject, finish: string | null = null, usage?: JsonObject): JsonObject {
    return {
      id: `chatcmpl-${this.id}`,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    };
  }

  private chatUsage(): JsonObject {
    const input = numberValue(this.usage?.promptTokenCount) ?? 0;
    const candidates = numberValue(this.usage?.candidatesTokenCount) ?? 0;
    const thoughts = numberValue(this.usage?.thoughtsTokenCount) ?? 0;
    const output = candidates + thoughts;
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: numberValue(this.usage?.totalTokenCount) ?? input + output,
      prompt_tokens_details: { cached_tokens: numberValue(this.usage?.cachedContentTokenCount) ?? 0 },
      ...(thoughts ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {}),
    };
  }

  private responsesUsage(): JsonObject {
    const chat = this.chatUsage();
    return {
      input_tokens: chat.prompt_tokens,
      output_tokens: chat.completion_tokens,
      total_tokens: chat.total_tokens,
      input_tokens_details: chat.prompt_tokens_details,
      ...(chat.completion_tokens_details ? { output_tokens_details: chat.completion_tokens_details } : {}),
    };
  }

  private isFinished(payload: string): boolean {
    const root = parseJsonObject(payload, "Invalid Gemini SSE event");
    const response = objectValue(root.response);
    return (Array.isArray(response?.candidates) ? response.candidates : []).some(
      (value) => Boolean(stringValue(objectValue(value)?.finishReason)),
    );
  }

  private retain(value: string): void {
    this.retainedBytes += encoder.encode(value).byteLength;
    if (this.retainedBytes > MAX_BUFFERED_RESPONSE_BYTES)
      throw new PoolError(502, "Buffered response is too large");
  }
}

function transformGeminiStream(
  body: ReadableStream<Uint8Array>,
  convert: (payload: string) => string[],
  finish: () => void,
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const payload of parser.push(decoder.decode(chunk, { stream: true })))
        for (const event of convert(payload)) controller.enqueue(encoder.encode(event));
    },
    flush(controller) {
      for (const payload of parser.push(decoder.decode(), true))
        for (const event of convert(payload)) controller.enqueue(encoder.encode(event));
      finish();
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  }));
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
      this.consume(this.pending.slice(0, newline), payloads);
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    if (encoder.encode(this.pending).byteLength > MAX_SSE_EVENT_BYTES)
      throw new PoolError(502, "Upstream SSE event is too large");
    if (final) {
      if (this.pending) this.consume(this.pending, payloads);
      this.pending = "";
      this.flush(payloads);
    }
    return payloads;
  }

  private consume(raw: string, payloads: string[]): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) { this.flush(payloads); return; }
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

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) yield payload;
    }
    for (const payload of parser.push(decoder.decode(), true)) yield payload;
  } finally {
    reader.releaseLock();
  }
}

function finishReason(reason: string, calls: boolean): string {
  if (calls) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  if (["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(reason))
    return "content_filter";
  return "stop";
}

function functionResponseValue(value: unknown): JsonObject {
  const text = collectText(value);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      return objectValue(parsed) ?? { output: parsed };
    } catch {}
    return { output: text };
  }
  return objectValue(value) ?? { output: value ?? "" };
}

function parseArguments(value: unknown): JsonObject {
  if (value === undefined || value === "") return {};
  if (objectValue(value)) return objectValue(value)!;
  if (typeof value === "string") {
    try {
      const parsed = objectValue(JSON.parse(value));
      if (parsed) return parsed;
    } catch {}
  }
  throw new PoolError(400, "Function arguments must be a JSON object");
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => stringValue(objectValue(item)?.text)).filter(Boolean).join("\n");
}

function requiredString(value: unknown, field: string, status = 400): string {
  const result = stringValue(value).trim();
  if (!result) throw new PoolError(status, `${field} is required`);
  return result;
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
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new PoolError(502, "Upstream returned an empty response");
  return response.body;
}

function stripBearer(token: string): string {
  const value = token.trim();
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value;
}

function sseData(value: JsonObject): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function streamingHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return headers;
}
