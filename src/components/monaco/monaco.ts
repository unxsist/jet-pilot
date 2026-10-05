/*
 * The Monaco runtime, bundled locally (no CDN). Never import this module
 * statically: go through `loadMonaco()` (./index.ts) so the editor, its CSS
 * and workers are only fetched when an editor surface opens.
 *
 * - Core editor + all editor contributions (find, folding, hover, suggest,
 *   diff...), without the ~80 bundled languages: only YAML and JSON (the
 *   theme editor) are registered. JSON's language mode is a further lazy
 *   chunk, loaded when the first JSON model is created.
 * - Workers are emitted by Vite (`?worker`) as same-origin files, so they run
 *   under the CSP's `worker-src 'self'`.
 * - monaco-yaml provides validation, completion and hover from per-model
 *   JSON schemas (see setModelSchema); JSON models get the same from
 *   setJsonSchema.
 * - Colours: applyMonacoTheme() paints the active app theme. The fixed
 *   "light"/"dark" JET themes and setColorMode() remain until every editor
 *   follows the theme runtime.
 */
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import { configureMonacoYaml, type SchemasSettings } from "monaco-yaml";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import YamlWorker from "./yaml.worker?worker";
import { JetDark, JetLight } from "./themes/jet";
import type { MonacoThemeData } from "@/lib/themes/types";
import "./monaco.css";

self.MonacoEnvironment = {
  ...self.MonacoEnvironment,
  getWorker(_moduleId: string, label: string) {
    if (label === "yaml") return new YamlWorker();
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  },
};

monaco.editor.defineTheme("light", JetLight);
monaco.editor.defineTheme("dark", JetDark);

// Monaco measures glyphs on first use; the bundled JetBrains Mono may still
// be loading at that point.
document.fonts?.ready.then(() => monaco.editor.remeasureFonts());

const monacoYaml = configureMonacoYaml(monaco, {
  enableSchemaRequest: false,
  validate: true,
  completion: true,
  hover: true,
  schemas: [],
});

/* Schemas by model URI: monaco-yaml takes one list for all models. */
const schemas = new Map<string, SchemasSettings>();
const publishSchemas = () => monacoYaml.update({ schemas: [...schemas.values()] });

/**
 * Validates / completes `model` against `schema` (null removes it). `id`
 * identifies the schema (shown as the hover source).
 */
export function setModelSchema(
  model: monaco.editor.ITextModel,
  id: string | null,
  schema: object | null
) {
  const key = model.uri.toString();
  if (!schema || !id) {
    if (schemas.delete(key)) publishSchemas();
    return;
  }
  if (schemas.get(key)?.uri === id) return;
  schemas.set(key, { uri: id, fileMatch: [key], schema: schema as any });
  publishSchemas();
}

/*
 * JSON: strict (theme files must stay T3 Code compatible), schemas by model
 * URI like YAML above. Colour swatches come from the JSON language service,
 * for strings whose schema has `"format": "color-hex"`.
 */
type JsonSchemaSettings = {
  uri: string;
  fileMatch: string[];
  schema: object;
};
const jsonSchemas = new Map<string, JsonSchemaSettings>();
const publishJsonSchemas = () =>
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: "error",
    enableSchemaRequest: false,
    schemaValidation: "error",
    schemas: [...jsonSchemas.values()],
  });
publishJsonSchemas();

/**
 * Validates / completes / hovers the JSON `model` against `schema` (null
 * removes it). `uri` identifies the schema, e.g. THEME_SCHEMA_URI.
 */
export function setJsonSchema(
  model: monaco.editor.ITextModel,
  uri: string,
  schema: object | null
) {
  const key = model.uri.toString();
  if (!schema) {
    if (jsonSchemas.delete(key)) publishJsonSchemas();
    return;
  }
  const current = jsonSchemas.get(key);
  if (current?.uri === uri && current.schema === schema) return;
  jsonSchemas.set(key, { uri, fileMatch: [key], schema });
  publishJsonSchemas();
}

export type ColorMode = "light" | "dark" | string;

/** @deprecated Use applyMonacoTheme() with the active theme. */
export function setColorMode(mode: ColorMode) {
  monaco.editor.setTheme(mode === "light" ? "light" : "dark");
}

/**
 * Paints every editor with `theme` (Monaco themes are global). Re-defining
 * "jet-active" and setting it again restyles open editors in place.
 */
export function applyMonacoTheme(theme: MonacoThemeData) {
  monaco.editor.defineTheme("jet-active", theme);
  monaco.editor.setTheme("jet-active");
}

let modelCounter = 0;
const uniqueUri = (hint: string, extension: string) => {
  const safe = hint.replace(/[^\w.-]+/g, "-").slice(0, 80) || "object";
  return monaco.Uri.parse(
    `inmemory://jet-pilot/${++modelCounter}/${safe}.${extension}`
  );
};

/** A unique in-memory URI for a YAML model (schemas are matched by URI). */
export function modelUri(hint: string) {
  return uniqueUri(hint, "yaml");
}

/** A unique in-memory URI for a JSON model (see setJsonSchema). */
export function jsonModelUri(hint: string) {
  return uniqueUri(hint, "json");
}

export { monaco };
export type Monaco = typeof monaco;
