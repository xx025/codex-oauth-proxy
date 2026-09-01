import { describe, expect, it } from "vitest";
import {
  bufferChatCompletion,
  bufferResponses,
  modelsFromUpstream,
  prepareProxyRequest,
  transformChatStream,
} from "../src/api";

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

describe("Cloudflare-native API proxy", () => {
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

  it("applies global fast service tier to upstream requests", () => {
    const responses = prepareProxyRequest(
      "/v1/responses",
      body({ model: "gpt-5.5", input: "Hello", service_tier: "standard" }),
      { serviceTier: "fast" },
    );
    expect(JSON.parse(new TextDecoder().decode(responses.body))).toMatchObject({
      service_tier: "fast",
    });

    const chat = prepareProxyRequest(
      "/v1/chat/completions",
      body({ model: "gpt-5.5", messages: [{ role: "user", content: "Hi" }] }),
      { serviceTier: "fast" },
    );
    expect(JSON.parse(new TextDecoder().decode(chat.body))).toMatchObject({
      service_tier: "fast",
    });
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
