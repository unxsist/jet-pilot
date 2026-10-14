import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileNameFor, parseActionFile, shortcutProblem } from "../../src/lib/customActions/schema";
import {
  actionMutates,
  containerChoices,
  customActionKind,
  planAction,
  planItem,
  sequenceInTerminal,
} from "../../src/lib/customActions/plan";
import { draftFromAction, draftToYaml, joinArgs } from "../../src/lib/customActions/draft";
import { matchesShortcut, shortcutKeys } from "../../src/lib/customActions/shortcut";
import { ACTION_EXAMPLES } from "../../src/lib/customActions/examples";
import { ACTION_JSON_SCHEMA } from "../../src/lib/customActions/jsonSchema";
import { ACTION_ICON_NAMES } from "../../src/lib/customActions/icons";
import {
  compileShell,
  displayArgv,
  isWebUrl,
  parseTemplate,
  quotePosix,
  quotePowerShell,
  renderArgs,
  renderText,
  renderUrl,
  resolveTyped,
  splitArgs,
  placeholders,
} from "../../src/lib/customActions/template";
import {
  describeScope,
  kindWords,
  matchesAll,
  matchesGlobs,
  matchesKind,
  matchesScope,
  matchesSelector,
  parseSelector,
} from "../../src/lib/customActions/scope";
import type { CustomAction, TemplateContext } from "../../src/lib/customActions/types";

const pod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "payments-api-7f9c",
    namespace: "shop",
    uid: "u-1",
    labels: { app: "payments", "app.kubernetes.io/name": "payments-api" },
    annotations: { "example.com/dashboard": "https://grafana.example.com/d/abc?x=1" },
    context: "prod",
    kubeConfig: "/home/me/.kube/config",
  },
  spec: {
    replicas: 3,
    containers: [
      { name: "api", image: "ghcr.io/acme/payments:1.2" },
      { name: "sidecar", image: "envoy:1.30" },
    ],
  },
};

const ctx = (object: any = pod, extra: Partial<TemplateContext> = {}): TemplateContext => ({
  object,
  context: "prod",
  kubeConfig: "/home/me/.kube/config",
  inputs: {},
  ...extra,
});

const parse = (text: string) => parseActionFile("test.yaml", text);
const action = (text: string) => {
  const result = parse(text);
  if (!result.action) throw new Error(result.error?.message);
  return result.action;
};

describe("action files", () => {
  it("parses every example", () => {
    for (const example of ACTION_EXAMPLES) {
      const result = parseActionFile(example.file, example.text);
      expect(result.error, example.file).toBeNull();
      expect(result.action!.id).toBe(example.file.replace(/\.yaml$/, ""));
    }
  });

  it("fills defaults", () => {
    const a = action("name: Copy name\nrun:\n  copy: '{{name}}'\n");
    expect(a).toMatchObject({
      icon: "zap",
      shortcut: "",
      confirm: "",
      mutates: false,
      inputs: [],
      scope: { kinds: [], namespaces: [], contexts: [], labels: "", multiple: false },
      run: { type: "copy", template: "{{name}}" },
    });
  });

  it("reads scope lists, single values and *", () => {
    const a = action(
      "name: x\nscope:\n  kinds: Pod\n  namespaces: [prod-*, '!prod-tmp']\n  contexts: prod\n  labels: app=web\n  multiple: true\nrun:\n  copy: x\n"
    );
    expect(a.scope).toEqual({ kinds: ["Pod"], namespaces: ["prod-*", "!prod-tmp"], contexts: ["prod"], labels: "app=web", multiple: true });
    expect(action("name: x\nscope:\n  kinds: '*'\nrun:\n  copy: x\n").scope.kinds).toEqual([]);
  });

  it("splits kubectl strings and drops a leading kubectl", () => {
    const a = action("name: x\nrun:\n  kubectl: kubectl logs -f {{name}} --since '{{input.since}}'\ninputs:\n  - name: since\n");
    expect(a.run).toEqual({ type: "kubectl", args: ["logs", "-f", "{{name}}", "--since", "{{input.since}}"], background: false });
  });

  it("patches always mutate", () => {
    expect(action("name: x\nrun:\n  patch:\n    spec:\n      paused: true\n").mutates).toBe(true);
  });

  it("confirm: true asks a standard question", () => {
    expect(action("name: Restart\nconfirm: true\nrun:\n  copy: x\n").confirm).toBe("Restart on {{name}}?".replace("Restart on", "Run Restart on"));
  });

  it("reports problems with their line", () => {
    const cases: [string, RegExp, number][] = [
      ["name: x\nrun:\n  open: https://x\n  command: ls\n", /an action does one thing/, 4],
      ["name: x\nscop:\n  kinds: Pod\nrun:\n  copy: x\n", /Unknown key "scop"/, 2],
      ["name: x\nrun:\n  copy: 'hello {{nmae}}'\n", /Unknown variable "nmae": did you mean "name"\?/, 3],
      ["name: x\nrun:\n  copy: '{{lables.app}}'\n", /did you mean "labels.app"\?/, 3],
      ["name: x\nrun:\n  copy: '{{whatever}}'\n", /Unknown variable "whatever"\. Try/, 3],
      ["name: x\nrun:\n  command: |\n    echo one\n    echo {{input.who}}\n", /input named "who"/, 5],
      ["name: x\nrun:\n  open: file:///etc/passwd\n", /http/, 3],
      ["name: x\nrun:\n  command: echo {{name | raw}}\n", /raw only works/, 3],
      ["name: x\nscope:\n  labels: '=web'\nrun:\n  copy: x\n", /label/, 3],
      ["name: x\nicon: unicorn\nrun:\n  copy: x\n", /Unknown icon "unicorn"/, 2],
      ["name: x\nshortcut: g\nrun:\n  copy: x\n", /needs Mod/, 2],
      ["name: x\n", /Say what the action does/, 1],
      ["name: x\nrun:\n  copy: [a\n", /Not valid YAML/, 3],
      ["", /empty/, 1],
      ["name: x\ninputs:\n  - name: a\n  - name: a\nrun:\n  copy: x\n", /Two inputs/, 4],
    ];
    for (const [text, message, line] of cases) {
      const result = parse(text);
      expect(result.action, text).toBeNull();
      expect(result.error!.message, text).toMatch(message);
      expect(result.error!.line, text).toBe(line);
    }
  });

  it("documents the same format in the editor's JSON schema", () => {
    expect(Object.keys(ACTION_JSON_SCHEMA.properties).sort()).toEqual(
      ["confirm", "description", "icon", "inputs", "mutates", "name", "run", "scope", "shortcut"]
    );
    expect(Object.keys(ACTION_JSON_SCHEMA.properties.run.properties).sort()).toEqual(
      ["command", "container", "copy", "exec", "in", "kubectl", "open", "patch"]
    );
    expect(ACTION_JSON_SCHEMA.properties.icon.enum).toEqual(ACTION_ICON_NAMES);
  });

  it("checks shortcuts", () => {
    expect(shortcutProblem("Mod+Shift+G")).toBeNull();
    expect(shortcutProblem("Alt+1")).toBeNull();
    expect(shortcutProblem("Shift+G")).toMatch(/needs Mod/);
    expect(shortcutProblem("Mod+Hyper+G")).toMatch(/modifier/);
    expect(shortcutProblem("Mod+Enter")).toMatch(/shortcut key/);
  });
});

describe("scope", () => {
  const scoped = (scope: Partial<CustomAction["scope"]>, run: CustomAction["run"] = { type: "copy", template: "" }) => ({
    scope: { kinds: [], namespaces: [], contexts: [], labels: "", multiple: false, ...scope },
    run,
  });

  it("matches kinds by name, case-insensitively, or with their group", () => {
    expect(matchesKind([], pod)).toBe(true);
    expect(matchesKind(["pod"], pod)).toBe(true);
    expect(matchesKind(["Deployment"], pod)).toBe(false);
    const app = { kind: "Application", apiVersion: "argoproj.io/v1alpha1" };
    expect(matchesKind(["Application.argoproj.io"], app)).toBe(true);
    expect(matchesKind(["Application.app.k8s.io"], app)).toBe(false);
  });

  it("matches globs with exclusions", () => {
    expect(matchesGlobs(["prod-*"], "prod-eu")).toBe(true);
    expect(matchesGlobs(["prod-*"], "staging")).toBe(false);
    expect(matchesGlobs(["prod-*", "!prod-tmp"], "prod-tmp")).toBe(false);
    expect(matchesGlobs(["!kube-system"], "shop")).toBe(true);
    expect(matchesGlobs(["!kube-*"], "kube-public")).toBe(false);
    expect(matchesGlobs(["a.b"], "aXb")).toBe(false);
  });

  it("parses and matches label selectors", () => {
    const selector = parseSelector("app=payments, tier in (api,worker), !canary, app.kubernetes.io/name");
    expect(typeof selector).not.toBe("string");
    const labels = { app: "payments", tier: "api", "app.kubernetes.io/name": "x" };
    expect(matchesSelector(selector as any, labels)).toBe(true);
    expect(matchesSelector(selector as any, { ...labels, canary: "true" })).toBe(false);
    expect(matchesSelector(selector as any, { ...labels, tier: "db" })).toBe(false);
    expect(matchesSelector(parseSelector("env notin (prod)") as any, {})).toBe(true);
    expect(matchesSelector(parseSelector("env!=prod") as any, { env: "prod" })).toBe(false);
    expect(typeof parseSelector("app in (a b)")).toBe("string");
  });

  it("matches the whole scope", () => {
    expect(matchesScope(scoped({ kinds: ["Pod"], namespaces: ["shop"], contexts: ["prod*"], labels: "app=payments" }), pod)).toBe(true);
    expect(matchesScope(scoped({ contexts: ["staging"] }), pod)).toBe(false);
    expect(matchesScope(scoped({ labels: "app=web" }), pod)).toBe(false);
    // exec only applies to kinds with containers kubectl exec can reach
    const exec = { type: "exec", command: "", container: "" } as const;
    expect(matchesScope(scoped({}, exec), pod)).toBe(true);
    expect(matchesScope(scoped({}, exec), { kind: "ConfigMap", metadata: { name: "x" } })).toBe(false);
    expect(matchesScope(scoped({}), { kind: "Pod" } as any)).toBe(false);
  });

  it("runs on several objects only when multiple", () => {
    expect(matchesAll(scoped({}), [pod, pod])).toBe(false);
    expect(matchesAll(scoped({ multiple: true }), [pod, pod])).toBe(true);
    expect(matchesAll(scoped({ multiple: true }), [])).toBe(false);
  });

  it("describes the scope in words", () => {
    expect(kindWords("StatefulSet")).toBe("stateful sets");
    expect(kindWords("Ingress")).toBe("ingresses");
    expect(describeScope(scoped({ kinds: ["Pod", "Deployment"] }).scope)).toBe("Pods and deployments");
    expect(describeScope(scoped({}).scope)).toBe("Any object");
    expect(
      describeScope(scoped({ kinds: ["Deployment"], namespaces: ["prod-*", "!prod-tmp"], labels: "app=web", contexts: ["eks-*"], multiple: true }).scope)
    ).toBe("Deployments in prod-*, not in prod-tmp with app=web · on eks-* · several at once");
  });
});

describe("templates", () => {
  it("renders fields, labels, annotations and paths", () => {
    expect(renderText("{{kind}}/{{name}} in {{namespace}} on {{context}}", ctx())).toBe("Pod/payments-api-7f9c in shop on prod");
    expect(renderText("{{labels.app}} {{labels['app.kubernetes.io/name']}} {{labels.app.kubernetes.io/name}}", ctx())).toBe(
      "payments payments-api payments-api"
    );
    expect(renderText(`{{annotations["example.com/dashboard"]}}`, ctx())).toBe("https://grafana.example.com/d/abc?x=1");
    expect(renderText("{{.spec.replicas}} {{.spec.containers[1].name}} {{.spec.containers[*].image}}", ctx())).toBe(
      "3 sidecar ghcr.io/acme/payments:1.2 envoy:1.30"
    );
    expect(renderText("{{.metadata.labels}}", ctx())).toBe(JSON.stringify(pod.metadata.labels));
    expect(renderText("{{kubeconfig}} {{uid}} {{apiVersion}}", ctx())).toBe("/home/me/.kube/config u-1 v1");
  });

  it("applies filters", () => {
    expect(renderText('{{labels.tier | default "all"}} {{kind | lower}} {{name | upper}}', ctx())).toBe("all pod PAYMENTS-API-7F9C");
    expect(renderText("{{labels.missing}}", ctx())).toBe("");
  });

  it("resolves the container and its image (first one unless chosen)", () => {
    expect(renderText("{{container}} {{image}}", ctx())).toBe("api ghcr.io/acme/payments:1.2");
    expect(renderText("{{container}} {{image}}", ctx(pod, { container: "sidecar" }))).toBe("sidecar envoy:1.30");
    const deployment = { kind: "Deployment", metadata: { name: "d" }, spec: { template: { spec: { containers: [{ name: "web", image: "nginx" }] } } } };
    expect(renderText("{{image}}", ctx(deployment))).toBe("nginx");
  });

  it("renders inputs", () => {
    expect(renderText("--since={{input.since}}", ctx(pod, { inputs: { since: "1h" } }))).toBe("--since=1h");
    const [placeholder] = placeholders("{{input.replicas}}");
    expect(resolveTyped(placeholder!, ctx(pod, { inputs: { replicas: "4" } }), new Set(["replicas"]))).toBe(4);
    expect(resolveTyped(placeholder!, ctx(pod, { inputs: { replicas: "4" } }), new Set())).toBe("4");
    const [path] = placeholders("{{.spec.replicas}}");
    expect(resolveTyped(path!, ctx(), new Set())).toBe(3);
  });

  it("reports syntax problems with their offset", () => {
    expect(parseTemplate("a {{name").issues[0]).toMatchObject({ offset: 2 });
    expect(parseTemplate("{{ }}").issues[0]!.message).toMatch(/empty/);
    expect(parseTemplate("{{name | shout}}").issues[0]!.message).toMatch(/Unknown filter/);
    expect(parseTemplate("{{.spec[}}").issues[0]!.message).toMatch(/path/);
  });

  it("URL-encodes values unless raw", () => {
    const weird = ctx({ ...pod, metadata: { ...pod.metadata, name: "a b&c=d/é?#" } });
    expect(renderUrl("https://g.example.com/d?pod={{name}}", weird)).toBe("https://g.example.com/d?pod=a%20b%26c%3Dd%2F%C3%A9%3F%23");
    expect(renderUrl(`{{annotations['example.com/dashboard'] | raw}}&from=now-1h`, ctx())).toBe(
      "https://grafana.example.com/d/abc?x=1&from=now-1h"
    );
    expect(isWebUrl("https://grafana.example.com/x")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });
});

/* Runs a compiled POSIX script for real: values must come out as data. */
const runPosix = (template: string, object: any) => {
  const compiled = compileShell(template, ctx(object), "posix");
  return execFileSync("/bin/sh", ["-c", compiled.script, "sh", ...compiled.values], { encoding: "utf8" });
};

const ADVERSARIAL = [
  "x; touch /tmp/jp-pwned",
  "$(touch /tmp/jp-pwned)",
  "`touch /tmp/jp-pwned`",
  "a'b\"c\\d",
  "' ; touch /tmp/jp-pwned ; '",
  '" ; touch /tmp/jp-pwned ; "',
  "-n",
  "*",
  "line1\nline2",
  "$HOME ${PATH}",
];

describe("shell quoting", () => {
  it("quotes words for reading", () => {
    expect(quotePosix("payments-api")).toBe("payments-api");
    expect(quotePosix("a b")).toBe("'a b'");
    expect(quotePosix("it's")).toBe(`'it'\\''s'`);
    expect(quotePosix("")).toBe("''");
    expect(quotePowerShell("it’s")).toBe("'it’’s'");
    expect(displayArgv(["kubectl", "--context", "prod", "logs", "a b"])).toBe("kubectl --context prod logs 'a b'");
  });

  it("never runs values as code, wherever they land in the script", () => {
    for (const value of ADVERSARIAL) {
      const object = { ...pod, metadata: { ...pod.metadata, name: value } };
      expect(runPosix("printf '%s|' {{name}}", object)).toBe(`${value}|`);
      expect(runPosix('printf \'%s|\' "pre-{{name}}-post"', object)).toBe(`pre-${value}-post|`);
      expect(runPosix("printf '%s|' 'pre-{{name}}-post'", object)).toBe(`pre-${value}-post|`);
      expect(runPosix('printf \'%s|\' "$(printf %s {{name}})"', object)).toBe(`${value.replace(/\n+$/, "")}|`);
    }
    expect(() => execFileSync("/bin/sh", ["-c", "test ! -e /tmp/jp-pwned"])).not.toThrow();
  });

  it("passes values as positional parameters (POSIX) and variables (PowerShell)", () => {
    const posix = compileShell("stern {{name}} -n '{{namespace}}' --context \"{{context}}\"", ctx(), "posix");
    expect(posix.script).toBe(`stern "$1" -n ''"$2"'' --context "$3"`);
    expect(posix.values).toEqual(["payments-api-7f9c", "shop", "prod"]);
    expect(posix.display).toBe(`stern payments-api-7f9c -n 'shop' --context "prod"`);
    const ps = compileShell("echo {{name}} '{{namespace}}'", ctx(), "powershell");
    expect(ps.script).toBe("echo ${env:JP_ARG_1} ''${env:JP_ARG_2}''");
    const many = compileShell(Array.from({ length: 11 }, () => "{{name}}").join(" "), ctx(), "posix");
    expect(many.script.endsWith(`"\${10}" "\${11}"`)).toBe(true);
  });
});

describe("kubectl arguments", () => {
  it("splits before rendering, so values never add arguments", () => {
    const { args } = splitArgs(`logs -f {{name}} --since "{{input.since}}" -l 'app in (a, b)' {{ labels['x y'] | default "a b" }}`);
    expect(args).toEqual(["logs", "-f", "{{name}}", "--since", "{{input.since}}", "-l", "app in (a, b)", `{{ labels['x y'] | default "a b" }}`]);
    const object = { ...pod, metadata: { ...pod.metadata, name: "x --kubeconfig=/evil; rm -rf /" } };
    expect(renderArgs(args, ctx(object, { inputs: { since: "1h" } }))).toEqual([
      "logs",
      "-f",
      "x --kubeconfig=/evil; rm -rf /",
      "--since",
      "1h",
      "-l",
      "app in (a, b)",
      "a b",
    ]);
    expect(splitArgs("get 'pods").issue).toMatch(/closing/);
  });
});

describe("plans", () => {
  const item = { object: pod, context: "prod", kubeConfig: "/home/me/.kube/config" };
  const options = { inputs: {}, dialect: "posix" as const, containerShell: "/bin/bash" };

  it("adds --context, --kubeconfig and --namespace to kubectl", () => {
    const planned = planItem(action("name: x\nrun:\n  kubectl: logs -f {{name}}\n"), item, options);
    expect(planned.step).toEqual({
      type: "process",
      argv: ["kubectl", "--context", "prod", "--kubeconfig", "/home/me/.kube/config", "--namespace", "shop", "logs", "-f", "payments-api-7f9c"],
      env: {},
    });
    expect(planned.display).toBe("kubectl --context prod --kubeconfig /home/me/.kube/config --namespace shop logs -f payments-api-7f9c");
    // The user's own namespace flag wins.
    const own = planItem(action("name: x\nrun:\n  kubectl: get pods -A\n"), item, options);
    expect((own.step as { argv: string[] }).argv).not.toContain("--namespace");
  });

  it("runs commands in sh with the values as parameters and KUBECONFIG set", () => {
    const planned = planItem(action("name: x\nrun:\n  command: stern {{name}}\n"), item, options);
    expect(planned.step).toEqual({
      type: "process",
      argv: ["/bin/sh", "-c", 'stern "$1"', "sh", "payments-api-7f9c"],
      env: { KUBECONFIG: "/home/me/.kube/config" },
    });
    const ps = planItem(action("name: x\nrun:\n  command: stern {{name}}\n"), item, { ...options, dialect: "powershell" });
    expect(ps.step).toMatchObject({
      argv: ["powershell.exe", "-NoProfile", "-Command", "stern ${env:JP_ARG_1}"],
      env: { JP_ARG_1: "payments-api-7f9c" },
    });
  });

  it("execs into the chosen container, with the values as parameters", () => {
    const shell = planItem(action("name: x\nrun:\n  exec: true\n"), item, { ...options, container: "sidecar" });
    expect(shell.step).toEqual({ type: "exec", argv: null, container: "sidecar" });
    const psql = planItem(
      action("name: x\ninputs:\n  - name: user\n    default: postgres\nrun:\n  exec: psql -U {{input.user}}\n"),
      item,
      { ...options, inputs: { user: "app; rm -rf /" } }
    );
    const argv = (psql.step as { argv: string[] }).argv;
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "sh", "-c", 'psql -U "$1"', "sh", "app; rm -rf /"]);
    const deployment = { kind: "Deployment", metadata: { name: "web", namespace: "shop" }, spec: { template: { spec: { containers: [{ name: "web" }] } } } };
    const onWorkload = planItem(action("name: x\nrun:\n  exec: true\n"), { ...item, object: deployment }, options);
    expect((onWorkload.step as { argv: string[] }).argv).toContain("deployment/web");
    expect((onWorkload.step as { argv: string[] }).argv.at(-1)).toBe("/bin/bash");
  });

  it("renders patches with typed values", () => {
    const a = action(
      "name: x\ninputs:\n  - name: replicas\n    type: number\nrun:\n  patch:\n    spec:\n      replicas: '{{input.replicas}}'\n    metadata:\n      annotations:\n        by: 'jet {{name}}'\n"
    );
    const planned = planItem(a, item, { ...options, inputs: { replicas: "5" } });
    expect(planned.step).toEqual({
      type: "patch",
      patch: { spec: { replicas: 5 }, metadata: { annotations: { by: "jet payments-api-7f9c" } } },
    });
  });

  it("asks for the container only when there is a choice", () => {
    const copyImage = action("name: x\nrun:\n  copy: '{{image}}'\n");
    expect(containerChoices(copyImage, [pod])).toEqual(["api", "sidecar"]);
    expect(containerChoices(action("name: x\nrun:\n  copy: '{{name}}'\n"), [pod])).toEqual([]);
    expect(containerChoices(copyImage, [{ ...pod, spec: { containers: [pod.spec.containers[0]] } }])).toEqual([]);
  });

  it("detects kubectl commands that change the cluster", () => {
    const restart = action("name: x\nrun:\n  kubectl: rollout restart deployment/{{name}}\n");
    expect(actionMutates(restart, planAction(restart, [item], options))).toBe(true);
    expect(customActionKind(restart)).toBe("custom-action");
    const logs = action("name: x\nrun:\n  kubectl: logs {{name}}\n");
    expect(actionMutates(logs, planAction(logs, [item], options))).toBe(false);
    expect(customActionKind(logs)).toBe("view");
    expect(customActionKind(action("name: x\nrun:\n  exec: true\n"))).toBe("exec");
  });

  it("runs several objects one after another in one terminal", () => {
    const other = { ...pod, metadata: { ...pod.metadata, name: "b'c" } };
    const items = [item, { ...item, object: other }];
    const a = action("name: x\nscope:\n  multiple: true\nrun:\n  command: echo {{name}}\n");
    const run = sequenceInTerminal(a, items, options);
    expect(run.argv).toEqual(["/bin/sh", "-c", 'echo "$1"\necho "$2"', "sh", "payments-api-7f9c", "b'c"]);
    expect(run.display).toBe(`echo payments-api-7f9c\necho 'b'\\''c'`);
    const k = action("name: x\nscope:\n  multiple: true\nrun:\n  kubectl: delete pod {{name}}\n");
    const kubectl = sequenceInTerminal(k, items, options);
    const [first, second] = kubectl.argv[2]!.split("\n");
    expect(first).toBe(Array.from({ length: 10 }, (_, i) => `"\${${i + 1}}"`).join(" "));
    expect(second!.startsWith(`"\${11}"`)).toBe(true);
    expect(kubectl.argv.slice(4, 14)).toEqual(planItem(k, item, options).step.type === "process" ? (planItem(k, item, options).step as { argv: string[] }).argv : []);
  });
});

describe("drafts", () => {
  it("round-trips an action through the form", () => {
    for (const example of ACTION_EXAMPLES) {
      const original = parseActionFile(example.file, example.text).action!;
      const text = draftToYaml(draftFromAction(original));
      const again = parseActionFile(example.file, text);
      expect(again.error, `${example.file}\n${text}`).toBeNull();
      expect(again.action).toEqual(original);
    }
  });

  it("keeps comments and untouched keys when saving a file", () => {
    const text = "# Team action\nname: Logs\n# where\nscope:\n  kinds: [Pod]\nrun:\n  kubectl: logs {{name}} # follow\n";
    const draft = draftFromAction(parseActionFile("logs.yaml", text).action!);
    draft.description = "Read the logs";
    const saved = draftToYaml(draft, text);
    expect(saved).toContain("# Team action");
    expect(saved).toContain("# where");
    expect(saved).toContain("# follow");
    expect(saved).toContain("description: Read the logs");
    expect(draftToYaml(draftFromAction(parseActionFile("logs.yaml", text).action!), text)).toBe(text);
  });

  it("writes short lists on one line", () => {
    const draft = draftFromAction(parseActionFile("x.yaml", ACTION_EXAMPLES[1]!.text).action!);
    expect(draftToYaml(draft)).toContain("kinds: [Deployment, StatefulSet, DaemonSet]");
  });

  it("joins kubectl arguments so they split the same way again", () => {
    expect(joinArgs(["logs", "-l", "app in (a, b)", "{{ labels['x y'] }}", ""])).toBe(`logs -l 'app in (a, b)' {{ labels['x y'] }} ''`);
    expect(splitArgs(joinArgs(["a b", "it's", "{{name}}"])).args).toEqual(["a b", "it's", "{{name}}"]);
  });

  it("names new files after the action", () => {
    expect(fileNameFor("Open in Grafana", [])).toBe("open-in-grafana.yaml");
    expect(fileNameFor("Open in Grafana", ["open-in-grafana.yaml", "open-in-grafana-2.yml"])).toBe("open-in-grafana-3.yaml");
    expect(fileNameFor("…", [])).toBe("action.yaml");
  });
});

describe("shortcuts", () => {
  const event = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  it("shows and matches Mod per platform", () => {
    expect(shortcutKeys("Mod+Shift+G", true)).toEqual(["⇧", "⌘", "G"]);
    expect(shortcutKeys("Mod+Shift+G", false)).toEqual(["Ctrl", "Shift", "G"]);
    expect(matchesShortcut("Mod+Shift+G", event("KeyG", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesShortcut("Mod+Shift+G", event("KeyG", { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(matchesShortcut("Mod+Shift+G", event("KeyG", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchesShortcut("Alt+1", event("Digit1", { altKey: true }), false)).toBe(true);
    expect(matchesShortcut("Alt+1", event("Digit1", { altKey: true, shiftKey: true }), false)).toBe(false);
  });
});
