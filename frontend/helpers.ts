import type { Locale } from "./i18n";

export type ModelMetadata = {
  id: string;
  name?: string;
  base_model?: string;
  reasoning_effort?: string;
  family?: string;
  vendor?: string;
  version?: string;
  category?: string;
  preview?: boolean;
  supported_endpoints?: string[];
  service_tiers?: string[];
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
    };
    supports?: Record<string, boolean>;
  };
};

type ModelFamily = "codex" | "gpt" | "reasoning" | "other";
type ModelGroup = {
  family: ModelFamily;
  models: Array<ModelMetadata & { reasoning_efforts: string[] }>;
};

export function maskIdentity(value: string): string {
  const identity = value.trim();
  const at = identity.indexOf("@");
  if (at > 0 && at === identity.lastIndexOf("@") && at < identity.length - 1) {
    return `${maskPart(identity.slice(0, at))}@${identity.slice(at + 1)}`;
  }
  return maskPart(identity);
}

function maskPart(value: string): string {
  if (!value) return "***";
  if (value.length === 1) return "*";
  if (value.length === 2) return `${value[0]}*`;
  return `${value[0]}${"*".repeat(Math.min(6, value.length - 2))}${value[value.length - 1]}`;
}

export function formatDuration(locale: Locale, seconds: number): string {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts: string[] = [];
  let remainder = safe;
  for (const [unit, size] of units) {
    const value = Math.floor(remainder / size);
    if (value && parts.length < 2) {
      parts.push(
        new Intl.NumberFormat(locale, {
          style: "unit",
          unit,
          unitDisplay: "long",
        }).format(value),
      );
      remainder %= size;
    }
  }
  return (
    parts.join(" ") ||
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "long",
    }).format(0)
  );
}

export function formatUntilReset(
  locale: Locale,
  resetsAtSeconds: number,
  nowMs = Date.now(),
): string {
  const seconds = Math.max(
    0,
    Math.ceil(Number(resetsAtSeconds) - nowMs / 1000),
  );
  return formatDuration(locale, seconds);
}

export function groupModels(models: ModelMetadata[]): ModelGroup[] {
  const merged = new Map<
    string,
    ModelMetadata & { reasoning_efforts: string[] }
  >();
  for (const model of models) {
    if (!model?.id) continue;
    const base = model.base_model || model.id;
    const current = merged.get(base);
    if (!current) {
      merged.set(base, {
        ...model,
        id: base,
        base_model: base,
        reasoning_efforts: model.reasoning_effort
          ? [model.reasoning_effort]
          : [],
      });
      continue;
    }
    if (
      model.reasoning_effort &&
      !current.reasoning_efforts.includes(model.reasoning_effort)
    )
      current.reasoning_efforts.push(model.reasoning_effort);
    if ((!current.name || current.name.includes("reasoning)")) && model.name)
      current.name = model.name;
    current.capabilities ||= model.capabilities;
    current.supported_endpoints ||= model.supported_endpoints;
    current.family ||= model.family;
    current.vendor ||= model.vendor;
    current.version ||= model.version;
    current.category ||= model.category;
    if (current.preview === undefined) current.preview = model.preview;
  }
  const families = new Map<
    ModelFamily,
    Array<ModelMetadata & { reasoning_efforts: string[] }>
  >();
  for (const model of merged.values()) {
    model.reasoning_efforts.sort();
    const family = inferModelFamily(model);
    families.set(family, [...(families.get(family) || []), model]);
  }
  const order: ModelFamily[] = ["codex", "gpt", "reasoning", "other"];
  return order
    .filter((family) => families.has(family))
    .map((family) => ({
      family,
      models: families
        .get(family)!
        .sort((left, right) => left.id.localeCompare(right.id)),
    }));
}

export function modelVariantId(model: Pick<ModelMetadata, "id" | "base_model">, effort: string): string {
  return `${model.base_model || model.id}-${effort}`;
}

function inferModelFamily(model: ModelMetadata): ModelFamily {
  const value =
    `${model.family || ""} ${model.category || ""} ${model.base_model || ""} ${model.id}`.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (/\bgpt[- ]?\d/.test(value)) return "gpt";
  if (/\b(?:o1|o3|o4)(?:\b|-)/.test(value) || value.includes("reasoning"))
    return "reasoning";
  return "other";
}
