import { describe, expect, it, vi } from "vitest";
import { createUpstreamFetch } from "../src/egress";

describe("native Cloudflare egress", () => {
  it("uses the VPC binding without adding credentials", async () => {
    const binding = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.url).toBe("https://auth.openai.com/oauth/token");
        expect(request.headers.has("x-codex-internal-key")).toBe(false);
        expect(request.headers.has("x-codex-egress-url")).toBe(false);
        return Response.json({ ok: true });
      }),
    } as unknown as Fetcher;
    const upstreamFetch = createUpstreamFetch({ NATIVE_EGRESS: binding });
    const response = await upstreamFetch("https://auth.openai.com/oauth/token", { method: "POST" });
    expect(response.status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    await expect(upstreamFetch("https://example.com/private")).rejects.toMatchObject({ status: 502 });
  });

  it("fails closed when the VPC binding is missing", () => {
    expect(() => createUpstreamFetch({})).toThrow("Native egress binding is not configured");
  });
});
