import { describe, expect, test } from "vitest";
import {
  buildKindSchema,
  normalizeSchema,
  parseApiVersion,
  readTypeMeta,
  reachableSchemas,
} from "@/components/monaco/kubernetesSchema";

const doc = {
  components: {
    schemas: {
      "io.k8s.api.apps.v1.Deployment": {
        type: "object",
        "x-kubernetes-group-version-kind": [
          { group: "apps", version: "v1", kind: "Deployment" },
        ],
        properties: {
          apiVersion: { type: "string" },
          kind: { type: "string" },
          metadata: {
            allOf: [{ $ref: "#/components/schemas/meta.ObjectMeta" }],
            default: {},
          },
          spec: {
            allOf: [{ $ref: "#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec" }],
          },
        },
      },
      "io.k8s.api.apps.v1.DeploymentSpec": {
        type: "object",
        properties: {
          replicas: { type: "integer", format: "int32" },
          maxSurge: { allOf: [{ $ref: "#/components/schemas/intstr.IntOrString" }] },
          cpu: { $ref: "#/components/schemas/Quantity" },
          free: {
            type: "object",
            properties: { a: { type: "string" } },
            "x-kubernetes-preserve-unknown-fields": true,
          },
          note: { type: "string", nullable: true },
        },
      },
      "meta.ObjectMeta": {
        type: "object",
        properties: {
          name: { type: "string" },
          creationTimestamp: { type: "string", format: "date-time" },
          labels: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      "intstr.IntOrString": {
        format: "int-or-string",
        oneOf: [{ type: "integer" }, { type: "string" }],
      },
      Quantity: { oneOf: [{ type: "string" }, { type: "number" }], format: "quantity" },
      "io.k8s.api.apps.v1.Unrelated": {
        type: "object",
        properties: { x: { type: "string" } },
      },
    },
  },
};

describe("type meta", () => {
  test("parseApiVersion", () => {
    expect(parseApiVersion("v1")).toEqual({ group: "", version: "v1" });
    expect(parseApiVersion("apps/v1")).toEqual({ group: "apps", version: "v1" });
    expect(parseApiVersion("a/b/c")).toBeNull();
    expect(parseApiVersion(" ")).toBeNull();
  });

  test("readTypeMeta reads top-level keys only", () => {
    expect(
      readTypeMeta("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  kind: nope\n")
    ).toEqual({ apiVersion: "apps/v1", kind: "Deployment" });
    expect(readTypeMeta('kind: "Service"  # svc\napiVersion: v1')).toEqual({
      apiVersion: "v1",
      kind: "Service",
    });
    expect(readTypeMeta("apiVersion: \nkind: Pod\n")).toBeNull();
  });
});

describe("buildKindSchema", () => {
  test("keeps only reachable schemas", () => {
    expect(
      [...reachableSchemas(doc.components.schemas, "io.k8s.api.apps.v1.Deployment")].sort()
    ).toEqual([
      "Quantity",
      "intstr.IntOrString",
      "io.k8s.api.apps.v1.Deployment",
      "io.k8s.api.apps.v1.DeploymentSpec",
      "meta.ObjectMeta",
    ]);
  });

  test("builds a strict, self-contained schema", () => {
    const schema = buildKindSchema(doc, {
      group: "apps",
      version: "v1",
      kind: "Deployment",
    })!;
    const schemas = schema.components.schemas;
    expect(schema.properties.kind.enum).toEqual(["Deployment"]);
    expect(schema.properties.apiVersion.enum).toEqual(["apps/v1"]);
    expect(schema.required).toEqual(["apiVersion", "kind"]);
    expect(schema.additionalProperties).toBe(false);
    const spec = schemas["io.k8s.api.apps.v1.DeploymentSpec"];
    expect(spec.additionalProperties).toBe(false);
    expect(spec.properties.free.additionalProperties).toBeUndefined();
    expect(spec.properties.note.type).toEqual(["string", "null"]);
    expect(schemas["intstr.IntOrString"].type).toEqual(["integer", "string"]);
    expect(schemas["Quantity"].type).toEqual(["string", "number"]);
    const meta = schemas["meta.ObjectMeta"];
    expect(meta.properties.creationTimestamp.type).toEqual(["string", "null"]);
    expect(meta.properties.labels.additionalProperties).toEqual({ type: "string" });
    expect(schemas["io.k8s.api.apps.v1.Unrelated"]).toBeUndefined();
  });

  test("unknown kinds yield null", () => {
    expect(
      buildKindSchema(doc, { group: "apps", version: "v1", kind: "Nope" })
    ).toBeNull();
  });

  test("normalizeSchema does not touch defaults or enums", () => {
    const out = normalizeSchema(
      { type: "object", properties: { a: { default: { properties: 1 } } } },
      false
    );
    expect(out.properties.a.default).toEqual({ properties: 1 });
    expect(out.additionalProperties).toBeUndefined();
  });
});
