/*
 * Custom actions in the harness (Settings › Actions, row menus, the
 * palette): a few action files in the actions folder (one of them broken),
 * the folder command, and terminal output for the processes they start.
 * Files live in the harness fs (sessionStorage), so the fs watch and the
 * editors work on them like on disk. `?scenario=no-actions` starts with an
 * empty folder, `?scenario=valid-actions` without the broken file.
 */
import { HOME, describe, logLines } from "./fixtures";

const FILES: Record<string, string> = {
  "open-in-grafana.yaml": `name: Open in Grafana
description: The pod's dashboard, filtered by namespace and app
icon: chart-line
shortcut: Mod+Shift+G
scope:
  kinds: [Pod]
run:
  open: https://grafana.acme.dev/d/k8s-pod?var-namespace={{namespace}}&var-pod={{name}}&var-app={{labels.app | default "all"}}
`,
  "tail-with-stern.yaml": `name: Tail logs with stern
description: Every pod of the workload, in a terminal tab
icon: scroll-text
scope:
  kinds: [Deployment, StatefulSet, DaemonSet]
run:
  command: stern {{kind | lower}}/{{name}} --context {{context}} --namespace {{namespace}} --tail 50
`,
  "logs-since.yaml": `name: Logs since…
description: Follow one container's logs from a point in time
icon: activity
scope:
  kinds: [Pod]
inputs:
  - name: since
    label: Since
    options: [5m, 1h, 6h, 24h]
    default: 1h
run:
  kubectl: logs -f {{name}} -c {{container}} --since {{input.since}}
`,
  "restart-deployment.yaml": `name: Restart deployment
description: Replaces its pods one by one (kubectl rollout restart)
icon: rotate-ccw
scope:
  kinds: [Deployment]
  namespaces: ["!kube-system"]
  multiple: true
run:
  kubectl: rollout restart deployment/{{name}}
  in: background
confirm: Restart {{name}}? Its pods are replaced one by one.
mutates: true
`,
  "copy-image.yaml": `name: Copy image
description: The container's image reference
icon: copy
scope:
  kinds: [Pod, Deployment, StatefulSet]
  multiple: true
run:
  copy: "{{image}}"
`,
  "psql.yaml": `name: Open psql
description: A psql session in the database container
icon: database
scope:
  kinds: [Pod, StatefulSet]
  labels: app.kubernetes.io/name in (postgresql, postgres)
inputs:
  - name: user
    label: User
    default: postgres
run:
  exec: psql -U {{input.user}}
`,
  // Broken on purpose: a typo in a variable (line 7).
  "preview-environment.yaml": `name: Open preview environment
description: The branch preview of this app
icon: globe
scope:
  kinds: [Deployment]
run:
  open: https://{{lables.app}}.preview.acme.dev
`,
};

/* The file with a typo (`lables.app`): its error shows in Settings › Actions. */
const BROKEN_FILE = "preview-environment.yaml";

/** Seeds the actions folder (once per harness session). */
export function seedActionFiles(scenario: string, fsKey: (path: string) => string): void {
  if (scenario === "no-actions" || scenario === "fresh") return;
  const prefix = fsKey("actions/");
  if (Object.keys(sessionStorage).some((key) => key.startsWith(prefix))) return;
  if (sessionStorage.getItem("harness-actions-seeded")) return;
  sessionStorage.setItem("harness-actions-seeded", "1");
  for (const [file, text] of Object.entries(FILES)) {
    if (scenario === "valid-actions" && file === BROKEN_FILE) continue;
    sessionStorage.setItem(fsKey(`actions/${file}`), text);
  }
}

const encoder = new TextEncoder();
const CRLF = (lines: string[]) => lines.join("\r\n") + "\r\n";
const COLORS = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m"];

export const actionHandlers: Record<string, (p: any) => unknown> = {
  open_actions_folder: () => `${HOME}/.config/jet-pilot/actions`,
};

/**
 * Terminal output for processes custom actions start (sh -c …, kubectl in
 * a tab); false: not one of them.
 */
export function startActionPty(
  onEvent: any,
  argv: string[],
  send: (channel: any, message: unknown) => void,
  findObject: (kind: string, name: string) => any
): boolean {
  const write = (text: string) => send(onEvent, encoder.encode(text).buffer);
  const exit = (code: number) => send(onEvent, { type: "exit", exitCode: code, error: null });
  if (argv[0] === "/bin/sh" && argv[1] === "-c") {
    const script = argv[2] ?? "";
    if (script.includes("stern")) {
      // Values follow the script: {{kind | lower}}, {{name}}, ...
      const name = argv[5] ?? "app";
      const pods = ["7qjjhld4s-974t2", "7qjjhld4s-trrmk", "7qjjhld4s-pdp99"].map((suffix) => `${name}-${suffix}`);
      const lines = logLines(18).map((line, index) => {
        const pod = pods[index % pods.length]!;
        return `${COLORS[index % pods.length]}${pod}\x1b[0m \x1b[32m${name}\x1b[0m ${line}`;
      });
      setTimeout(() => write(CRLF(lines)), 200);
      return true;
    }
    setTimeout(() => {
      write("Done.\r\n");
      exit(0);
    }, 300);
    return true;
  }
  if (argv[0] === "kubectl" && argv[1] === "--context") {
    const verb = argv.find((arg, index) => index > 1 && !arg.startsWith("-") && argv[index - 1] !== "--context" && argv[index - 1] !== "--namespace" && argv[index - 1] !== "--kubeconfig");
    if (verb === "describe") {
      const rest = argv.slice(argv.indexOf("describe") + 1);
      const object = findObject(rest[0] ?? "Pod", rest[1] ?? "");
      setTimeout(() => {
        write(describe(object?.kind ?? rest[0] ?? "Pod", object).replace(/\n/g, "\r\n"));
        exit(0);
      }, 200);
      return true;
    }
    if (verb === "logs") {
      setTimeout(() => write(CRLF(logLines(24))), 200);
      return true;
    }
    setTimeout(() => exit(0), 200);
    return true;
  }
  return false;
}
