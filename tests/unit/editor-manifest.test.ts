import { describe, expect, test } from "vitest";
import {
  classifyError,
  diffObjects,
  formatPath,
  lineDelta,
  locatePath,
  locateProblems,
  parseApplyErrors,
  parseFieldPath,
  readResourceVersion,
  rebaseEdits,
  stripServerFields,
  withResourceVersion,
} from "@/components/monaco/manifest";

const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  resourceVersion: "100"
  labels:
    app.kubernetes.io/name: web
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
        ports:
        - containerPort: 80
status:
  readyReplicas: 2
`;

describe("field paths", () => {
  test("parse and format round-trip", () => {
    const path = parseFieldPath("spec.template.spec.containers[0].image");
    expect(path).toEqual(["spec", "template", "spec", "containers", 0, "image"]);
    expect(formatPath(path)).toBe("spec.template.spec.containers[0].image");
  });

  test("bracketed map keys keep their dots", () => {
    expect(parseFieldPath("metadata.labels[app.kubernetes.io/name]")).toEqual([
      "metadata",
      "labels",
      "app.kubernetes.io/name",
    ]);
  });
});

describe("diffObjects", () => {
  test("reports leaf changes and ignores server-owned fields", () => {
    const changes = diffObjects(
      { metadata: { resourceVersion: "1", name: "a" }, spec: { replicas: 1 }, status: { x: 1 } },
      { metadata: { resourceVersion: "2", name: "a" }, spec: { replicas: 3, paused: true }, status: { x: 2 } }
    );
    expect(changes).toEqual([
      { path: ["spec", "replicas"], type: "changed", before: 1, after: 3 },
      { path: ["spec", "paused"], type: "added", after: true },
    ]);
  });

  test("resized arrays are one change", () => {
    const changes = diffObjects({ a: [1, 2] }, { a: [1, 2, 3] });
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toEqual(["a"]);
  });

  test("same-length arrays diff per index", () => {
    expect(
      diffObjects({ a: [{ x: 1 }, { x: 2 }] }, { a: [{ x: 1 }, { x: 5 }] })[0].path
    ).toEqual(["a", 1, "x"]);
  });
});

test("lineDelta counts added and removed lines", () => {
  expect(lineDelta("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
  expect(lineDelta("same", "same")).toEqual({ added: 0, removed: 0 });
});

describe("rebaseEdits", () => {
  test("replays edits onto the newer object and keeps its resourceVersion", () => {
    const mine = deployment.replace("replicas: 2", "replicas: 5");
    const theirs = deployment
      .replace('resourceVersion: "100"', 'resourceVersion: "140"')
      .replace("nginx:1.25", "nginx:1.27");
    const result = rebaseEdits(deployment, mine, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.text).toContain("replicas: 5");
    expect(result.text).toContain("nginx:1.27");
    expect(result.text).toContain('resourceVersion: "140"');
  });

  test("flags paths both sides changed (user wins)", () => {
    const mine = deployment.replace("replicas: 2", "replicas: 5");
    const theirs = deployment.replace("replicas: 2", "replicas: 3");
    const result = rebaseEdits(deployment, mine, theirs);
    expect(result.conflicts).toEqual([["spec", "replicas"]]);
    expect(result.text).toContain("replicas: 5");
  });

  test("removals are replayed", () => {
    const mine = deployment.replace("    app.kubernetes.io/name: web\n", "");
    const result = rebaseEdits(deployment, mine, deployment);
    expect(result.text).not.toContain("app.kubernetes.io/name");
  });
});

test("resourceVersion helpers", () => {
  expect(readResourceVersion(deployment)).toBe("100");
  expect(readResourceVersion(withResourceVersion(deployment, "222"))).toBe("222");
  expect(readResourceVersion("kind: X\n")).toBeNull();
});

describe("parseApplyErrors", () => {
  test("aggregated field errors", () => {
    const problems = parseApplyErrors(
      'The Deployment "web" is invalid: [spec.replicas: Invalid value: -1: must be greater than or equal to 0, spec.template.spec.containers[0].image: Required value]'
    );
    expect(problems.map((p) => p.path)).toEqual([
      ["spec", "replicas"],
      ["spec", "template", "spec", "containers", 0, "image"],
    ]);
    expect(problems[0].message).toContain("must be greater than or equal to 0");
  });

  test("strict decoding unknown fields", () => {
    const problems = parseApplyErrors(
      'Error from server (BadRequest): error when creating "STDIN": Deployment in version "v1" cannot be handled as a Deployment: strict decoding error: unknown field "spec.replicass", unknown field "spec.template.spec.containers[0].imagee"'
    );
    expect(problems.map((p) => formatPath(p.path!))).toEqual([
      "spec.replicass",
      "spec.template.spec.containers[0].imagee",
    ]);
  });

  test("YAML syntax errors carry the line", () => {
    const [problem] = parseApplyErrors(
      "error: error parsing STDIN: error converting YAML to JSON: yaml: line 12: mapping values are not allowed in this context"
    );
    expect(problem.line).toBe(12);
  });

  test("type errors and webhook denials", () => {
    const problems = parseApplyErrors(
      'Error from server (BadRequest): error when replacing "STDIN": json: cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas of type int32\nError from server (Forbidden): admission webhook "validate.kyverno.svc" denied the request: image tag latest is not allowed\nWarning: spec.foo is deprecated'
    );
    expect(problems[0].path).toEqual(["spec", "replicas"]);
    expect(problems[1].path).toBeUndefined();
    expect(problems[1].message).toMatch(/^Forbidden: admission webhook/);
    expect(problems).toHaveLength(2);
  });

  test("classifies conflicts", () => {
    expect(
      classifyError(
        'Error from server (Conflict): error when replacing "STDIN": Operation cannot be fulfilled on deployments.apps "web": the object has been modified; please apply your changes to the latest version and try again'
      )
    ).toBe("conflict");
    expect(classifyError("boom")).toBeNull();
  });
});

describe("locatePath", () => {
  test("finds keys and sequence items", () => {
    expect(locatePath(deployment, ["spec", "replicas"])).toMatchObject({ line: 10, exact: true });
    expect(
      locatePath(deployment, ["spec", "template", "spec", "containers", 0, "image"])
    ).toMatchObject({ line: 15, exact: true });
    expect(
      locatePath(deployment, ["metadata", "labels", "app.kubernetes.io/name"])
    ).toMatchObject({ line: 8 });
  });

  test("missing fields point at the deepest parent", () => {
    expect(
      locatePath(deployment, ["spec", "template", "spec", "containers", 0, "resources"])
    ).toMatchObject({ line: 14, exact: false });
  });

  test("locateProblems fills in lines", () => {
    const [problem] = locateProblems(deployment, [
      { message: "x", path: ["spec", "replicas"] },
    ]);
    expect(problem.line).toBe(10);
  });
});

test("stripServerFields keeps declared state only", () => {
  const stripped = stripServerFields({
    metadata: {
      name: "a",
      uid: "u",
      resourceVersion: "1",
      managedFields: [],
      annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" },
    },
    spec: { a: 1 },
    status: { b: 2 },
  });
  expect(stripped).toEqual({ metadata: { name: "a" }, spec: { a: 1 } });
});
