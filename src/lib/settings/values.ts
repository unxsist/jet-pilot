/*
 * Validation and display of preference values against their definitions.
 */
import type { SettingDefinition } from "./types";

export type Validated<T = unknown> = { ok: true; value: T } | { ok: false; message: string };

const round = (value: number, step: number) => {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(value.toFixed(Math.min(decimals, 6)));
};

/**
 * Checks (and gently coerces) `value` for `def`: numbers given as strings
 * are parsed and clamped into range, enum and list values must match.
 */
export function validateSetting(def: SettingDefinition, value: unknown): Validated {
  switch (def.type) {
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, message: "Expected true or false" };
    case "number": {
      const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return { ok: false, message: `Expected a number between ${def.min} and ${def.max}` };
      }
      let next = Math.min(def.max, Math.max(def.min, parsed));
      if (def.integer) next = Math.round(next);
      else if (def.step) next = round(next, def.step);
      return { ok: true, value: next };
    }
    case "string":
      if (typeof value !== "string") return { ok: false, message: "Expected text" };
      if (def.maxLength && value.length > def.maxLength) {
        return { ok: false, message: `At most ${def.maxLength} characters` };
      }
      return { ok: true, value };
    case "enum":
      return typeof value === "string" && def.options.some((option) => option.value === value)
        ? { ok: true, value }
        : {
            ok: false,
            message: `Expected one of ${def.options.map((option) => `"${option.value}"`).join(", ")}`,
          };
    case "string[]":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return { ok: false, message: "Expected a list of text values" };
      }
      return { ok: true, value: [...value] };
  }
}

/** A short, human-readable value, e.g. for palette badges. */
export function formatSettingValue(def: SettingDefinition, value: unknown): string {
  switch (def.type) {
    case "boolean":
      return value ? "On" : "Off";
    case "number":
      return def.unit ? `${value} ${def.unit}` : String(value);
    case "enum":
      return def.options.find((option) => option.value === value)?.label ?? String(value);
    case "string[]":
      return Array.isArray(value) ? `${value.length} ${value.length === 1 ? "item" : "items"}` : "";
    case "string":
      return typeof value === "string" && value !== "" ? value : (def.placeholder ?? "Default");
  }
}
