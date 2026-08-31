import { PoolError } from "./pool";
import { readRequestBody } from "./api";

type JsonObject = Record<string, unknown>;
type ApiCall = (request: Request) => Promise<Response>;

const TOOLS = [{
  name: "ask_codex",
  description: "Ask a GPT model a self-contained question through the configured ChatGPT account.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      model: { type: "string", description: "Model ID returned by ask_codex_models." },
      prompt: { type: "string", description: "Complete question or instruction." },
    },
    required: ["model", "prompt"],
  },
}, {
  name: "ask_codex_models",
  description: "List available model IDs and reasoning effort levels.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
}];

export async function handleMcp(request: Request, callApi: ApiCall): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const body = parseBody(await readRequestBody(request));
  const id = body.id;
  const method = stringValue(body.method);
  if (!method) return rpcError(id, -32600, "Invalid Request");
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
  try {
    if (method === "initialize") {
      const params = objectValue(body.params);
      return rpcResult(id, {
        protocolVersion: stringValue(params?.protocolVersion) || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ask-codex", version: "1.0.0" },
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") return rpcResult(id, await callTool(request.url, objectValue(body.params), callApi));
    return rpcError(id, -32601, "Method not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rpcError(id, -32603, message);
  }
}

async function callTool(url: string, params: JsonObject | undefined, callApi: ApiCall): Promise<JsonObject> {
  const name = stringValue(params?.name);
  const args = objectValue(params?.arguments) ?? {};
  if (name === "ask_codex_models") {
    const response = await callApi(new Request(new URL("/v1/models", url)));
    const payload = await response.json() as { data?: JsonObject[]; error?: string };
    if (!response.ok || !Array.isArray(payload.data)) throw new PoolError(response.status, payload.error || "Failed to list models");
    const baseModels = payload.data.filter((model) => !model.reasoning_effort);
    const models = baseModels.map((model) => ({
      id: stringValue(model.id),
      display_name: stringValue(model.name),
      reasoning_efforts: payload.data
        ?.filter((candidate) => candidate.base_model === model.id && typeof candidate.reasoning_effort === "string")
        .map((candidate) => candidate.reasoning_effort),
    }));
    return toolResult({ models });
  }
  if (name === "ask_codex") {
    const model = stringValue(args.model).trim();
    const prompt = stringValue(args.prompt).trim();
    if (!model || !prompt) throw new PoolError(400, "model and prompt are required");
    const response = await callApi(new Request(new URL("/v1/chat/completions", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] }),
    }));
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new PoolError(response.status, stringValue(payload.error) || "Model request failed");
    const choice = objectValue(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
    const message = objectValue(choice?.message);
    const result = {
      requested_model: model,
      model: stringValue(payload.model) || model,
      text: stringValue(message?.content),
    };
    return toolResult(result);
  }
  throw new PoolError(404, `Unknown tool: ${name || "<missing>"}`);
}

function toolResult(structuredContent: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}

function rpcResult(id: unknown, result: JsonObject): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function parseBody(bytes: ArrayBuffer): JsonObject {
  try {
    const value = objectValue(JSON.parse(new TextDecoder().decode(bytes)));
    if (value) return value;
  } catch {
  }
  throw new PoolError(400, "Invalid JSON-RPC request");
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
