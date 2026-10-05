import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importTheme } from "@/lib/themes/import";
import type { ThemeFile } from "@/lib/themes/types";

export const fixturePath = (name: string) => join(__dirname, "fixtures", name);
export const fixture = (name: string) => readFileSync(fixturePath(name), "utf8");

/** Imports a fixture and returns its single theme (fails the test on errors). */
export function importFixture(name: string): ThemeFile {
  const result = importTheme(fixture(name), name);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result.themes[0]!;
}

export const FIXTURES = [
  "dracula-color-theme.json",
  "harbor-light-color-theme.jsonc",
  "monokai.sublime-color-scheme",
  "meadow.tmTheme",
  "nightfall.json",
  "t3-export.json",
];

/** Every built-in theme file (JSON loaded straight from disk). */
export function builtinFiles(): ThemeFile[] {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "../../../src/lib/themes/builtin/manifest.json"), "utf8")
  ) as { id: string }[];
  return manifest.map(({ id }) =>
    JSON.parse(
      readFileSync(join(__dirname, `../../../src/lib/themes/builtin/themes/${id}.json`), "utf8")
    )
  );
}

/**
 * A minimal JSON Schema (draft-07 subset) validator: type, properties,
 * required, additionalProperties, enum, const, pattern, min/maxLength.
 * Returns the error paths.
 */
interface Schema {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  required?: readonly string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
}

export function validateSchema(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum`);
  if (schema.type === "string") {
    if (typeof value !== "string") return [...errors, `${path}: not a string`];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: maxLength`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: minLength`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") errors.push(`${path}: not a boolean`);
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [...errors, `${path}: not an object`];
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) errors.push(...validateSchema(childSchema, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === "object") {
        errors.push(...validateSchema(schema.additionalProperties, child, `${path}.${key}`));
      }
    }
  }
  return errors;
}
