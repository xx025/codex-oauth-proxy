import { describe, expect, it, vi } from "vitest";
import { createUpstreamFetch } from "../src/egress";

describe("native Cloudflare egress", () => {
  it("uses the VPC binding without adding credentials", async () => {
    const binding = {
      fetch: vi.fn(async (request: Request) => {
        expect([
          "https://auth.openai.com/oauth/token",
          "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=100",
          "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        ]).toContain(request.url);
        expect(request.headers.has("x-codex-internal-key")).toBe(false);
        expect(request.headers.has("x-codex-egress-url")).toBe(false);
        return Response.json({ ok: true });
      }),
    } as unknown as Fetcher;
    const upstreamFetch = createUpstreamFetch({ NATIVE_EGRESS: binding });
    const response = await upstreamFetch("https://auth.openai.com/oauth/token", { method: "POST" });
    expect(response.status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    await upstreamFetch(
      "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=100",
    );
    expect(binding.fetch).toHaveBeenCalledTimes(2);
    await upstreamFetch(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      { method: "POST" },
    );
    expect(binding.fetch).toHaveBeenCalledTimes(3);
    await expect(upstreamFetch("https://example.com/private")).rejects.toMatchObject({ status: 502 });
  });

  it("fails closed when the VPC binding is missing", () => {
    expect(() => createUpstreamFetch({})).toThrow("Native egress binding is not configured");
  });
});
