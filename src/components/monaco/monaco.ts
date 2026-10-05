/*
 * The Monaco runtime, bundled locally (no CDN). Never import this module
 * statically: go through `loadMonaco()` (./index.ts) so the editor, its CSS
 * and workers are only fetched when an editor surface opens.
 *
 * - Core editor + all editor contributions (find, folding, hover, suggest,
 *   diff...), without the ~80 bundled languages: only YAML is registered.
 * - Workers are emitted by Vite (`?worker`) as same-origin files, so they run
 *   under the CSP's `worker-src 'self'`.
 * - monaco-yaml provides validation, completion and hover from per-model
 *   JSON schemas (see setModelSchema).
 */
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import { configureMonacoYaml, type SchemasSettings } from "monaco-yaml";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import YamlWorker from "./yaml.worker?worker";
import { JetDark, JetLight } from "./themes/jet";
import "./monaco.css";

self.MonacoEnvironment = {
  ...self.MonacoEnvironment,
  getWorker(_moduleId: string, label: string) {
    return label === "yaml" ? new YamlWorker() : new EditorWorker();
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

export type ColorMode = "light" | "dark" | string;

export function setColorMode(mode: ColorMode) {
  monaco.editor.setTheme(mode === "light" ? "light" : "dark");
}

let modelCounter = 0;
/** A unique in-memory URI for a model (schemas are matched by URI). */
export function modelUri(hint: string) {
  const safe = hint.replace(/[^\w.-]+/g, "-").slice(0, 80) || "object";
  return monaco.Uri.parse(`inmemory://jet-pilot/${++modelCounter}/${safe}.yaml`);
}

export { monaco };
export type Monaco = typeof monaco;
