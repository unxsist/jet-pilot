/*
 * Turns a cluster OpenAPI v3 document (GET /openapi/v3/apis/<group>/<version>)
 * into a self-contained JSON Schema for one kind, for monaco-yaml.
 *
 * Pure (no Monaco / Tauri imports) so it is unit-testable and cheap to load.
 *
 * - Only the schemas reachable from the kind are kept (a core/v1 document
 *   holds every core type; a Pod needs a fraction of them), which keeps the
 *   payload posted to the YAML worker small.
 * - Kubernetes OpenAPI quirks are mapped to JSON Schema: `nullable`,
 *   int-or-string and quantity formats.
 * - Objects with declared properties reject unknown fields (like the API
 *   server's strict field validation), unless they preserve unknown fields.
 * - `apiVersion` / `kind` are pinned so a typo is flagged.
 */

type JsonSchema = Record<string, any>;

export interface OpenApiDocument {
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface GroupVersionKind {
  group: string;
  version: string;
  kind: string;
}

const REF_PREFIX = "#/components/schemas/";

/** Splits an `apiVersion` (`v1`, `apps/v1`) into group and version. */
export function parseApiVersion(
  apiVersion: string
): { group: string; version: string } | null {
  const value = apiVersion.trim();
  if (!value) return null;
  const parts = value.split("/");
  if (parts.length === 1) return { group: "", version: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { group: parts[0], version: parts[1] };
  }
  return null;
}

/**
 * Reads `apiVersion` and `kind` from the first YAML document without a full
 * parse (it runs on every edit, debounced). Only top-level, unindented keys
 * count.
 */
export function readTypeMeta(
  text: string
): { apiVersion: string; kind: string } | null {
  let apiVersion = "";
  let kind = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("---") && (apiVersion || kind)) break;
    const match = /^(apiVersion|kind):[ \t]*(["']?)([^"'#\s]*)\2[ \t]*(#.*)?$/.exec(
      line.replace(/\r$/, "")
    );
    if (!match) continue;
    if (match[1] === "apiVersion") apiVersion = match[3];
    else kind = match[3];
    if (apiVersion && kind) break;
  }
  return apiVersion && kind ? { apiVersion, kind } : null;
}

/** Name of the component schema declaring `gvk`, if any. */
export function findSchemaName(
  document: OpenApiDocument,
  gvk: GroupVersionKind
): string | null {
  const schemas = document.components?.schemas || {};
  for (const [name, schema] of Object.entries(schemas)) {
    const gvks = schema?.["x-kubernetes-group-version-kind"];
    if (
      Array.isArray(gvks) &&
      gvks.some(
        (entry: GroupVersionKind) =>
          (entry.group || "") === gvk.group &&
          entry.version === gvk.version &&
          entry.kind === gvk.kind
      )
    ) {
      return name;
    }
  }
  return null;
}

const refName = (ref: unknown) =>
  typeof ref === "string" && ref.startsWith(REF_PREFIX)
    ? ref.slice(REF_PREFIX.length)
    : null;

/** Names of all component schemas reachable from `root`. */
export function reachableSchemas(
  schemas: Record<string, JsonSchema>,
  root: string
): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name) || !schemas[name]) continue;
    seen.add(name);
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref") {
            const target = refName(value);
            if (target && !seen.has(target)) queue.push(target);
          } else {
            walk(value);
          }
        }
      }
    };
    walk(schemas[name]);
  }
  return seen;
}

const withNull = (type: unknown) =>
  Array.isArray(type)
    ? type.includes("null")
      ? type
      : [...type, "null"]
    : typeof type === "string"
      ? [type, "null"]
      : type;

/** Maps Kubernetes OpenAPI extensions onto plain JSON Schema (copying). */
export function normalizeSchema(node: unknown, strict = true): any {
  if (Array.isArray(node)) return node.map((n) => normalizeSchema(n, strict));
  if (!node || typeof node !== "object") return node;

  const source = node as JsonSchema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    // Descend into sub-schemas only; leave `default`, `example`, `enum`
    // and extension values untouched.
    if (
      key === "properties" ||
      key === "patternProperties" ||
      key === "definitions"
    ) {
      out[key] = Object.fromEntries(
        Object.entries(value as JsonSchema).map(([k, v]) => [
          k,
          normalizeSchema(v, strict),
        ])
      );
    } else if (
      key === "items" ||
      key === "additionalProperties" ||
      key === "not" ||
      key === "allOf" ||
      key === "anyOf" ||
      key === "oneOf"
    ) {
      out[key] =
        typeof value === "boolean" ? value : normalizeSchema(value, strict);
    } else {
      out[key] = value;
    }
  }

  const intOrString =
    out["x-kubernetes-int-or-string"] === true ||
    out.format === "int-or-string";
  if (intOrString) {
    delete out.oneOf;
    delete out.anyOf;
    out.type = ["integer", "string"];
  } else if (out.format === "quantity") {
    delete out.oneOf;
    delete out.anyOf;
    out.type = ["string", "number"];
  }

  if (out.nullable === true) {
    if (out.type) {
      out.type = withNull(out.type);
    } else if (Array.isArray(out.allOf) && out.allOf.length === 1) {
      // `{ allOf: [{ $ref }], nullable: true }`
      out.anyOf = [{ allOf: out.allOf }, { type: "null" }];
      delete out.allOf;
    }
  }
  // kubectl prints unset timestamps as `null` (creationTimestamp: null).
  if (out.format === "date-time" && out.type) {
    out.type = withNull(out.type);
  }

  if (
    strict &&
    out.properties &&
    out.additionalProperties === undefined &&
    out["x-kubernetes-preserve-unknown-fields"] !== true
  ) {
    out.additionalProperties = false;
  }

  return out;
}

/**
 * The JSON Schema for `gvk` from a cluster OpenAPI v3 document, or null when
 * the document does not declare the kind.
 */
export function buildKindSchema(
  document: OpenApiDocument,
  gvk: GroupVersionKind,
  options: { strict?: boolean } = {}
): JsonSchema | null {
  const schemas = document.components?.schemas;
  if (!schemas) return null;
  const root = findSchemaName(document, gvk);
  if (!root) return null;

  const strict = options.strict ?? true;
  const components: Record<string, JsonSchema> = {};
  for (const name of reachableSchemas(schemas, root)) {
    components[name] = normalizeSchema(schemas[name], strict);
  }

  const apiVersion = gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
  const rootSchema: JsonSchema = { ...components[root] };
  rootSchema.properties = { ...(rootSchema.properties || {}) };
  rootSchema.properties.apiVersion = {
    ...(rootSchema.properties.apiVersion || { type: "string" }),
    enum: [apiVersion],
  };
  rootSchema.properties.kind = {
    ...(rootSchema.properties.kind || { type: "string" }),
    enum: [gvk.kind],
  };
  rootSchema.required = Array.from(
    new Set([...(rootSchema.required || []), "apiVersion", "kind"])
  );

  return {
    ...rootSchema,
    title: `${gvk.kind} (${apiVersion})`,
    components: { schemas: components },
  };
}
