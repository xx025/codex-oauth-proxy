import { describe, expect, it } from "vitest";
import { aggregateModelDistribution, aggregateRequestTrend } from "../frontend/charts";
import { parseLanguagePreference, resolveLocale, translate } from "../frontend/i18n";

describe("frontend i18n helpers", () => {
  it("defaults invalid or missing preferences to system", () => {
    expect(parseLanguagePreference(null)).toBe("system");
    expect(parseLanguagePreference("fr")).toBe("system");
    expect(parseLanguagePreference("zh-CN")).toBe("zh-CN");
  });

  it("resolves any Chinese browser language to Chinese and otherwise English", () => {
    expect(resolveLocale("system", ["zh-Hant-TW", "en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["en-US", "zh-Hant-TW"])).toBe("en");
    expect(resolveLocale("system", ["en-GB", "fr"])).toBe("en");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
  });

  it("interpolates translated values", () => {
    expect(translate("en", "modelsCount", { count: 3 })).toBe("3 available models");
    expect(translate("zh-CN", "modelsCount", { count: 3 })).toBe("3 个可用模型");
  });
});

describe("frontend chart aggregation", () => {
  it("creates chronological request buckets with success and token totals", () => {
    const buckets = aggregateRequestTrend([
      { createdAt: 120_000, status: 500, usage: { available: true, totalTokens: 7 } },
      { createdAt: 60_000, status: 200, usage: { available: true, totalTokens: 5 } },
      { createdAt: 120_000, status: 302, usage: { available: false, totalTokens: 99 } },
    ], 2);
    expect(buckets).toHaveLength(2);
    expect(buckets.map(({ requests, successful, tokens }) => ({ requests, successful, tokens }))).toEqual([
      { requests: 1, successful: 1, tokens: 5 },
      { requests: 2, successful: 1, tokens: 7 },
    ]);
    expect(buckets[0].start).toBeLessThan(buckets[1].start);
  });

  it("sorts models and combines the remainder into Other", () => {
    expect(aggregateModelDistribution([
      { model: "small", requests: 2 },
      { model: "large", requests: 10 },
      { model: "medium", requests: 5 },
      { model: "small", requests: 1 },
    ], 2)).toEqual([
      { model: "large", requests: 10 },
      { model: "medium", requests: 5 },
      { model: "Other", requests: 3 },
    ]);
  });

  it("handles empty and invalid chart data", () => {
    expect(aggregateRequestTrend([{ createdAt: "invalid", status: 200 }])).toEqual([]);
    expect(aggregateModelDistribution([{ model: "unused", requests: 0 }])).toEqual([]);
  });
});
