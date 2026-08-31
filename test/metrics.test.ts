import { describe, expect, it } from "vitest";
import { readTokenUsage } from "../src/metrics";

const encoder = new TextEncoder();

function chunkedStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("request metrics", () => {
  it("reads Responses API token usage from a regular JSON response", async () => {
    const stream = chunkedStream(JSON.stringify({
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 80 },
      },
    }));
    await expect(readTokenUsage(stream, "application/json")).resolves.toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedTokens: 80,
      available: true,
    });
  });

  it("reads split streaming events and keeps the largest cumulative usage", async () => {
    const stream = chunkedStream(
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
      "data: {\"usage\":{\"input_tokens\":10,\"output_tokens\":2,\"total_tokens\":12}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,",
      "\"output_tokens\":8,\"total_tokens\":18,\"input_tokens_details\":{\"cached_tokens\":4}}}}\n\n",
      "data: [DONE]\n\n",
    );
    await expect(readTokenUsage(stream, "text/event-stream; charset=utf-8")).resolves.toEqual({
      inputTokens: 10,
      outputTokens: 8,
      totalTokens: 18,
      cachedTokens: 4,
      available: true,
    });
  });

  it("supports Chat Completions usage names and marks absent usage as unavailable", async () => {
    const metered = await readTokenUsage(chunkedStream(JSON.stringify({ usage: {
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 3 },
    } })), "application/json");
    expect(metered).toMatchObject({ inputTokens: 7, outputTokens: 5, totalTokens: 12, cachedTokens: 3, available: true });
    await expect(readTokenUsage(chunkedStream("{\"ok\":true}"), "application/json")).resolves.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      available: false,
    });
  });
});
