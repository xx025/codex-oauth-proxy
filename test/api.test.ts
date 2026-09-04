import { describe, expect, it } from "vitest";
import {
  bufferChatCompletion,
  bufferResponses,
  antigravityMissingThoughtSignatureIds,
  finalizeUpstreamResponse,
  mergeCustomModelCatalog,
  modelsFromUpstream,
  prepareCustomUpstreamRequest,
  prepareProxyRequest,
  prepareSelectedUpstreamRequest,
  restoreAntigravityThoughtSignatures,
  transformChatStream,
} from "../src/api";
import {
  bufferGeminiChat,
  bufferGeminiResponses,
  transformGeminiChatStream,
  transformGeminiResponsesStream,
} from "../src/gemini-api";

const encoder = new TextEncoder();

function body(value: unknown): ArrayBuffer {
  return encoder.encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function upstreamEvents(): string {
  return [
    'data: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    'data: {"type":"response.output_text.delta","delta":" world"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
}

function geminiEvents(): string {
  return [
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"thinking","thought":true},{"text":"hello "}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"thoughtsTokenCount":2,"totalTokenCount":8,"cachedContentTokenCount":3}}}\n\n',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"world"},{"functionCall":{"id":"call_1","name":"lookup","args":{"city":"Paris"}},"thoughtSignature":"signed-thought"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":2,"totalTokenCount":9,"cachedContentTokenCount":3}}}\n\n',
  ].join("");
}

describe("Cloudflare-native API proxy", () => {
  it("prepares custom OpenAI requests without forwarding client credentials", () => {
    const payload = body({ model: "custom-model", messages: [{ role: "user", content: "Hello" }], stream: true });
    const result = prepareCustomUpstreamRequest("/v1/chat/completions", payload, {
      id: "custom-1",
      name: "Custom",
      baseUrl: "https://chatgpt.com/proxy/v1",
      apiKey: "upstream-key",
      priority: 1,
      fallback: true,
    });
    expect(result.url).toBe("https://chatgpt.com/proxy/v1/chat/completions");
    expect(result.init.body).toBe(payload);
    expect(result.init.redirect).toBe("manual");
    const headers = new Headers(result.init.headers);
    expect(headers.get("authorization")).toBe("Bearer upstream-key");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
  });

  it("merges enabled custom models without overriding built-in entries", () => {
    const result = mergeCustomModelCatalog({ object: "list", data: [{ id: "shared", object: "model" }] }, [{
      id: "custom-1",
      name: "Custom",
      baseUrl: "https://chatgpt.com/v1",
      enabled: true,
      fallback: true,
      priority: 1,
      models: [{ id: "shared" }, { id: "custom-only", ownedBy: "vendor" }],
      createdAt: 1_000,
      updatedAt: 1_000,
      validatedAt: 1_000,
      hasApiKey: true,
    }]);
    expect((result.data as Array<{ id: string }>).map((model) => model.id)).toEqual(["shared", "custom-only"]);
  });

  it("prepares Responses input as a Gemini Code Assist GenerateContent request", () => {
    const prepared = prepareProxyRequest(
      "/v1/responses",
      body({
        model: "gemini-2.5-pro",
        instructions: "Be concise",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,YWJj" }] },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"temperature":20}' },
          { role: "user", content: [{ type: "input_image", image_url: "https://example.com/photo.jpg" }] },
        ],
        tools: [{ type: "function", function: { name: "lookup", description: "Weather", parameters: { type: "object" } } }],
        tool_choice: "required",
        max_output_tokens: 100,
        temperature: 0.2,
      }),
    );
    expect(prepared).toMatchObject({
      provider: "antigravity",
      kind: "responses",
      model: "gemini-2.5-pro",
      streaming: false,
      upstreamUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    });
    const request = JSON.parse(new TextDecoder().decode(prepared.body));
    expect(request).toMatchObject({
      systemInstruction: { parts: [{ text: "Be concise" }] },
      tools: [{ functionDeclarations: [{ name: "lookup", description: "Weather" }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: { maxOutputTokens: 100, temperature: 0.2 },
    });
    expect(request.contents).toEqual([
      { role: "user", parts: [{ text: "Look" }, { inlineData: { mimeType: "image/png", data: "YWJj" } }] },
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "lookup", args: { city: "Paris" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "call_1", name: "lookup", response: { temperature: 20 } } }] },
      { role: "user", parts: [{ fileData: { fileUri: "https://example.com/photo.jpg" } }] },
    ]);

    const selected = prepareSelectedUpstreamRequest(
      new Request("https://relay/v1/responses", {
        headers: { "x-session-id": "session-from-header" },
      }),
      prepared,
      { accessToken: "Bearer token", projectId: "project-1" },
    );
    expect(selected.url).toBe(prepared.upstreamUrl);
    expect(new Headers(selected.init.headers).get("authorization")).toBe("Bearer token");
    const selectedHeaders = new Headers(selected.init.headers);
    expect(selectedHeaders.get("user-agent")).toBe("antigravity/hub/2.9.1 darwin/arm64");
    expect(selectedHeaders.has("x-goog-api-client")).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(selected.init.body as Uint8Array))).toMatchObject({
      requestId: expect.stringMatching(/^agent-[0-9a-f-]+$/),
      requestType: "agent",
      userAgent: "antigravity",
      project: "project-1",
      model: "gemini-2.5-pro",
      request: { ...request, sessionId: "session-from-header" },
    });
  });

  it("keeps Chat message and tool result order in Gemini requests", () => {
    const prepared = prepareProxyRequest("/v1/chat/completions", body({
      model: "gemini-2.5-flash",
      stream: true,
      messages: [
        { role: "system", content: "Help" },
        { role: "user", content: "Weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
      ],
    }));
    const request = JSON.parse(new TextDecoder().decode(prepared.body));
    expect(prepared).toMatchObject({
      provider: "antigravity",
      kind: "chat",
      streaming: true,
    });
    expect(request.contents.map((content: { role: string }) => content.role)).toEqual(["user", "model", "user"]);
    expect(request.contents[2]).toMatchObject({
      parts: [{ functionResponse: { id: "c1", name: "weather", response: { output: "sunny" } } }],
    });
  });

  it("restores cached Gemini thought signatures and only bypasses the first unsigned parallel call", () => {
    const prepared = prepareProxyRequest("/v1/chat/completions", body({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "Run tools" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "one", arguments: "{}" },
              extra_content: { google: { thought_signature: "client-signature" } },
            },
            { id: "c2", type: "function", function: { name: "two", arguments: "{}" } },
          ],
        },
      ],
    }));
    expect(antigravityMissingThoughtSignatureIds(prepared)).toEqual(["c2"]);
    restoreAntigravityThoughtSignatures(prepared, {
      c1: "stale-cache",
      c2: "cached-signature",
    });
    const request = JSON.parse(new TextDecoder().decode(prepared.body));
    expect(request.contents[1].parts).toEqual([
      { functionCall: { id: "c1", name: "one", args: {} }, thoughtSignature: "client-signature" },
      { functionCall: { id: "c2", name: "two", args: {} }, thoughtSignature: "cached-signature" },
    ]);

    const unsigned = prepareProxyRequest("/v1/chat/completions", body({
      model: "gemini-2.5-flash",
      messages: [
        { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "one", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "two", arguments: "{}" } },
        ] },
      ],
    }));
    restoreAntigravityThoughtSignatures(unsigned, {});
    const unsignedRequest = JSON.parse(new TextDecoder().decode(unsigned.body));
    expect(unsignedRequest.contents[0].parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(unsignedRequest.contents[0].parts[1]).not.toHaveProperty("thoughtSignature");
  });

  it("cleans unsupported JSON schema keywords like $schema and exclusiveMinimum from tool parameters", () => {
    const prepared = prepareProxyRequest("/v1/chat/completions", body({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "read" }],
      tools: [{
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              path: { type: "string" },
              offset: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      }],
    }));
    const request = JSON.parse(new TextDecoder().decode(prepared.body));
    const toolParams = request.tools[0].functionDeclarations[0].parameters;
    expect(toolParams).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
      },
      required: ["path"],
    });
    expect(toolParams).not.toHaveProperty("$schema");
    expect(toolParams.properties.offset).not.toHaveProperty("exclusiveMinimum");
  });

  it("rejects unsupported Gemini request fields instead of falling through to Codex", () => {
    expect(() => prepareProxyRequest("/v1/chat/completions", body({
      model: "gemini-2.5-pro",
      messages: [],
      n: 2,
    }))).toThrow("Gemini CLI only supports n=1");
  });

  it("returns Gemini upstream errors unchanged for account failover", async () => {
    const prepared = prepareProxyRequest("/v1/responses", body({
      model: "gemini-2.5-pro",
      input: "Hello",
    }));
    const upstream = new Response('{"error":"quota"}', {
      status: 429,
      headers: { "retry-after": "10" },
    });
    const result = await finalizeUpstreamResponse(prepared, upstream);
    expect(result).toBe(upstream);
    expect(result.headers.get("retry-after")).toBe("10");
    expect(await result.text()).toBe('{"error":"quota"}');
  });

  it("transforms Gemini SSE into Responses and Chat streams", async () => {
    const responsesText = await new Response(
      transformGeminiResponsesStream(stream(geminiEvents().slice(0, 90), geminiEvents().slice(90)), "gemini-2.5-pro"),
    ).text();
    expect(responsesText).toContain('"type":"response.reasoning_summary_text.delta"');
    expect(responsesText).toContain('"delta":"thinking"');
    expect(responsesText).toContain('"type":"response.output_text.delta"');
    expect(responsesText).toContain('"item_id":"msg_resp_');
    expect(responsesText).toContain('"delta":"world"');
    expect(responsesText).toContain('"type":"response.function_call_arguments.delta"');
    expect(responsesText).toContain('"input_tokens":5,"output_tokens":4,"total_tokens":9');
    expect(responsesText.endsWith("data: [DONE]\n\n")).toBe(true);

    const chatText = await new Response(
      transformGeminiChatStream(stream(geminiEvents()), "gemini-2.5-pro"),
    ).text();
    expect(chatText).toContain('"reasoning_content":"thinking"');
    expect(chatText).toContain('"content":"hello "');
    expect(chatText).toContain('"tool_calls":[{"index":0,"id":"call_1"');
    expect(chatText).toContain('"finish_reason":"tool_calls"');
    expect(chatText).toContain('"prompt_tokens_details":{"cached_tokens":3}');
  });

  it("buffers Gemini SSE for non-streaming Responses and Chat clients", async () => {
    const saved: unknown[] = [];
    const responses = await bufferGeminiResponses(
      stream(geminiEvents()),
      "gemini-2.5-pro",
      (signatures) => { saved.push(...signatures); },
    );
    expect(responses).toMatchObject({
      object: "response",
      status: "completed",
      model: "gemini-2.5-pro",
      usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
      output: [
        { type: "reasoning", summary: [{ text: "thinking" }] },
        { type: "message", content: [{ text: "hello world" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"city":"Paris"}', thought_signature: "signed-thought" },
      ],
    });
    expect(saved).toEqual([{ functionCallId: "call_1", signature: "signed-thought" }]);
    const chat = await bufferGeminiChat(stream(geminiEvents()), "gemini-2.5-pro");
    expect(chat).toMatchObject({
      object: "chat.completion",
      choices: [{
        message: {
          content: "hello world",
          reasoning_content: "thinking",
          tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: '{"city":"Paris"}' }, thought_signature: "signed-thought" }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
  });

  it("converts chat completions requests into Responses requests", () => {
    const prepared = prepareProxyRequest(
      "/v1/chat/completions",
      body({
        model: "gpt-5.6-sol-high",
        stream: true,
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: "Calling",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "done" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }),
    );
    const upstream = JSON.parse(
      new TextDecoder().decode(prepared.body),
    ) as Record<string, unknown>;
    expect(prepared).toMatchObject({
      kind: "chat",
      model: "gpt-5.6-sol",
      streaming: true,
      method: "POST",
    });
    expect(upstream).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "Be concise",
      stream: true,
      store: false,
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(upstream.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Calling" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);
  });

  it("preserves model-suffix reasoning effort for native Responses requests", () => {
    const prepared = prepareProxyRequest(
      "/v1/responses",
      body({
        model: "gpt-5.6-terra-max",
        input: "Hello",
        stream: true,
      }),
    );
    const upstream = JSON.parse(
      new TextDecoder().decode(prepared.body),
    ) as Record<string, unknown>;
    expect(prepared).toMatchObject({
      kind: "responses",
      model: "gpt-5.6-terra",
      streaming: true,
    });
    expect(upstream).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "max", summary: "auto" },
    });
  });

  it("maps global fast service tier to Codex priority requests", () => {
    const responses = prepareProxyRequest(
      "/v1/responses",
      body({ model: "gpt-5.5", input: "Hello", service_tier: "standard" }),
      { serviceTier: "fast" },
    );
    expect(JSON.parse(new TextDecoder().decode(responses.body)).service_tier).toBe("priority");

    const chat = prepareProxyRequest(
      "/v1/chat/completions",
      body({ model: "gpt-5.5", messages: [{ role: "user", content: "Hi" }] }),
      { serviceTier: "fast" },
    );
    expect(JSON.parse(new TextDecoder().decode(chat.body)).service_tier).toBe("priority");
  });

  it("omits service tier by default", () => {
    const prepared = prepareProxyRequest(
      "/v1/responses",
      body({ model: "gpt-5.5", input: "Hello", service_tier: "fast" }),
    );
    const upstream = JSON.parse(
      new TextDecoder().decode(prepared.body),
    ) as Record<string, unknown>;
    expect(upstream.service_tier).toBeUndefined();
  });

  it("transforms upstream Responses events into streaming chat chunks", async () => {
    const transformed = transformChatStream(
      stream(upstreamEvents().slice(0, 80), upstreamEvents().slice(80)),
      "gpt-5.6-sol",
    );
    const text = await new Response(transformed).text();
    const payloads = text
      .split("\n\n")
      .filter(Boolean)
      .map((event) => event.slice(6));
    expect(payloads.at(-1)).toBe("[DONE]");
    const chunks = payloads
      .slice(0, -1)
      .map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(
      chunks.some((chunk) =>
        JSON.stringify(chunk).includes('"content":"hello"'),
      ),
    ).toBe(true);
    expect(
      chunks.some((chunk) =>
        JSON.stringify(chunk).includes('"content":" world"'),
      ),
    ).toBe(true);
    expect(chunks.at(-1)).toMatchObject({
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      choices: [{ finish_reason: "stop" }],
    });
  });

  it("buffers upstream events for non-streaming chat and Responses clients", async () => {
    const chat = await bufferChatCompletion(
      stream(upstreamEvents()),
      "gpt-5.6-sol",
    );
    expect(chat).toMatchObject({
      id: "chatcmpl-resp_123",
      object: "chat.completion",
      model: "gpt-5.6-sol",
      choices: [
        {
          message: { role: "assistant", content: "hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });

    const responses = await bufferResponses(
      stream(
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"ok"}]}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"total_tokens":4}}}\n\n',
      ),
    );
    expect(responses).toMatchObject({
      id: "resp_1",
      output: [{ type: "message" }],
      usage: { total_tokens: 4 },
    });
  });

  it("converts the live entitlement catalog into OpenAI-compatible model entries", () => {
    expect(
      modelsFromUpstream({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            context_window: 200_000,
            max_output_tokens: 32_000,
            max_input_tokens: 180_000,
            provider: "OpenAI",
            model_version: "2026-08-01",
            is_preview: true,
            endpoints: ["/v1/responses", "/v1/responses"],
            supports: { reasoning: true, tools: true },
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "max" },
              { effort: "low" },
              { effort: "ultra" },
            ],
          },
          {
            slug: "hidden",
            visibility: "hide",
          },
        ],
      }),
    ).toEqual({
      object: "list",
      data: [
        expect.objectContaining({
          id: "gpt-5.6-sol",
          base_model: "gpt-5.6-sol",
          vendor: "OpenAI",
          version: "2026-08-01",
          preview: true,
          supported_endpoints: ["/v1/responses"],
          capabilities: {
            limits: {
              max_context_window_tokens: 200_000,
              max_output_tokens: 32_000,
              max_prompt_tokens: 180_000,
            },
            supports: { reasoning: true, tools: true },
          },
        }),
        expect.objectContaining({
          id: "gpt-5.6-sol-low",
          reasoning_effort: "low",
          capabilities: expect.any(Object),
        }),
        expect.objectContaining({
          id: "gpt-5.6-sol-max",
          reasoning_effort: "max",
          vendor: "OpenAI",
        }),
      ],
    });
  });

  it("extracts token limits from mixed upstream metadata locations", () => {
    const result = modelsFromUpstream({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          visibility: "list",
          context_window: 128_000,
          service_tiers: [{ id: "priority", name: "Fast" }],
          metadata: { output: { maxOutputTokens: 16_000 } },
        },
      ],
    }) as { data: unknown[] };
    expect(result.data[0]).toMatchObject({
      id: "gpt-5.4",
      capabilities: {
        limits: {
          max_context_window_tokens: 128_000,
          max_output_tokens: 16_000,
        },
        supports: { fast_mode: true },
      },
      service_tiers: ["priority"],
    });
  });

  it("keeps unknown listed models minimal and never copies unapproved metadata", () => {
    const result = modelsFromUpstream({
      models: [
        {
          slug: "new-model",
          visibility: "list",
          access_token: "secret",
          arbitrary: { credential: "secret" },
        },
      ],
    });
    expect(result.data).toEqual([
      expect.objectContaining({ id: "new-model", base_model: "new-model" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
