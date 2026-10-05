/*
 * JSON schema of settings.json, generated from the registry: validation,
 * completion and hovers in the settings.json editor.
 */
import { SETTINGS } from "./registry";
import type { SettingDefinition } from "./types";

export const SETTINGS_SCHEMA_URI = "https://www.jet-pilot.app/schemas/settings.json";

type Schema = Record<string, unknown> & {
  properties?: Record<string, Schema>;
};

function leaf(def: SettingDefinition): Schema {
  const description = def.description ? `${def.label}. ${def.description}` : def.label;
  const base: Schema = { description, default: def.default };
  switch (def.type) {
    case "boolean":
      return { ...base, type: "boolean" };
    case "number":
      return {
        ...base,
        type: def.integer ? "integer" : "number",
        minimum: def.min,
        maximum: def.max,
      };
    case "string":
      return { ...base, type: "string", ...(def.maxLength ? { maxLength: def.maxLength } : {}) };
    case "enum":
      return {
        ...base,
        enum: def.options.map((option) => option.value),
        enumDescriptions: def.options.map((option) => option.description ?? option.label),
      };
    case "string[]":
      return { ...base, type: "array", items: { type: "string" } };
  }
}

export function buildSettingsSchema(defs: readonly SettingDefinition[] = SETTINGS): Schema {
  const root: Schema = {
    $id: SETTINGS_SCHEMA_URI,
    title: "JET Pilot settings",
    description: "Only values that differ from their default need to be listed.",
    type: "object",
    properties: {
      version: { type: "integer", description: "Settings file format (written by JET Pilot)." },
    },
  };
  for (const def of defs) {
    const parts = def.key.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node.properties ??= {};
      // Known sections reject unknown keys: typos show up right away.
      node = node.properties[part] ??= { type: "object", properties: {}, additionalProperties: false };
    }
    node.properties ??= {};
    node.properties[parts[parts.length - 1]!] = leaf(def);
  }
  return root;
}
