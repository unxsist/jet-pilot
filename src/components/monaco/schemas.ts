/*
 * Kubernetes JSON schemas for the YAML editor, from the cluster's own
 * OpenAPI v3 endpoint (so CRDs are covered too).
 *
 * The backend (`get_openapi_v3_schema`, src-tauri/src/manifest.rs) fetches
 * through the cached kube client and keeps the raw documents; here only the
 * small per-kind schemas are cached, per kubeconfig + context.
 */
import { Kubernetes } from "@/services/Kubernetes";
import {
  buildKindSchema,
  parseApiVersion,
  type OpenApiDocument,
} from "./kubernetesSchema";

export interface KindSchema {
  /** Stable id (also shown as the source of hover docs). */
  id: string;
  label: string;
  schema: object;
}

const built = new Map<string, Promise<KindSchema | null>>();
const documents = new Map<string, Promise<OpenApiDocument>>();

const decode = (raw: unknown): OpenApiDocument => {
  if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw));
  if (ArrayBuffer.isView(raw)) return JSON.parse(new TextDecoder().decode(raw));
  if (Array.isArray(raw)) return JSON.parse(new TextDecoder().decode(new Uint8Array(raw)));
  if (typeof raw === "string") return JSON.parse(raw);
  return raw as OpenApiDocument;
};

function fetchDocument(context: string, kubeConfig: string, apiVersion: string) {
  const key = `${kubeConfig}\u0000${context}\u0000${apiVersion}`;
  let document = documents.get(key);
  if (!document) {
    document = Kubernetes.getOpenApiV3Schema(context, apiVersion, kubeConfig).then(decode);
    documents.set(key, document);
    // The parsed document is large; the backend keeps the bytes, so only
    // share it between concurrent callers.
    const forget = () => documents.delete(key);
    document.then(forget, forget);
  }
  return document;
}

export const errorMessage = (e: unknown): string =>
  (e as { message?: string })?.message ?? String(e);

/**
 * The schema of `kind` in `apiVersion` on the cluster of `context`. Resolves
 * to null when the cluster does not publish one; rejects on API errors.
 */
export function kindSchema(
  context: string,
  kubeConfig: string,
  apiVersion: string,
  kind: string
): Promise<KindSchema | null> {
  const gv = parseApiVersion(apiVersion);
  if (!gv || !kind) return Promise.resolve(null);

  const key = `${kubeConfig}\u0000${context}\u0000${apiVersion}\u0000${kind}`;
  let schema = built.get(key);
  if (!schema) {
    schema = fetchDocument(context, kubeConfig, apiVersion).then((document) => {
      const json = buildKindSchema(document, { ...gv, kind });
      return json
        ? {
            id: `kubernetes://${encodeURIComponent(context)}/${apiVersion}/${kind}`,
            label: `${kind} · ${apiVersion}`,
            schema: json,
          }
        : null;
    });
    built.set(key, schema);
    // Retry failures (cluster unreachable, login pending) next time.
    schema.catch(() => built.delete(key));
  }
  return schema;
}
