/*
 * Pop-out windows in the harness (src/lib/windows.ts).
 *
 *   ?window=pop-demo          this page is a pop-out window (default: main)
 *   ?popout=view|tabs|shell   what the "main window" sends it:
 *                             view  = Deployments with its own side panel,
 *                             tabs  = a log tail and a describe tab,
 *                             shell = a running shell that moved here
 *
 * A pop-out asks the main window for its payload (`window://ready` with
 * emitTo); there is no main window here, so the request is answered with a
 * demo payload. window_open / window_focus / tty_release are no-ops.
 */
import { emit } from "@tauri-apps/api/event";
import { CONTEXTS, KUBECONFIG } from "./fixtures";

const params = new URLSearchParams(location.search);

export const windowLabel = /^pop-[a-z0-9-]+$/.test(params.get("window") ?? "")
  ? (params.get("window") as string)
  : "main";

const context = CONTEXTS[0].name;
const target = (namespace: string) => ({ context, namespace, kubeConfig: KUBECONFIG });
const contexts = [{ context, kubeConfig: KUBECONFIG, namespaces: ["all"] }];

const LOGS = {
  id: `logs_${context}_checkout_Deployment_checkout-api`,
  title: "checkout-api",
  icon: "logs",
  type: "logs",
  props: { ...target("checkout"), object: "deployment/checkout-api" },
};
const DESCRIBE = {
  id: `describe_${context}_checkout_Pod_checkout-api-rqmxcfxbp-bq7vj`,
  title: "checkout-api-rqmxcfxbp-bq7vj",
  icon: "describe",
  type: "describe",
  props: { ...target("checkout"), type: "Pod", name: "checkout-api-rqmxcfxbp-bq7vj" },
};
const SHELL = {
  id: `shell_${context}_payments_payments-api-7qjjhld4s-974t2`,
  title: "payments-api-7qjjhld4s-974t2",
  icon: "shell",
  type: "shell",
  props: {
    ...target("payments"),
    pod: {
      metadata: { name: "payments-api-7qjjhld4s-974t2", namespace: "payments" },
      spec: { containers: [{ name: "api" }] },
    },
  },
};

function payload() {
  switch (params.get("popout")) {
    case "tabs":
      return {
        kind: "tabs",
        route: null,
        contexts,
        tabs: { tabs: [LOGS, DESCRIBE], activeTabId: LOGS.id },
      };
    case "shell":
      return {
        kind: "tabs",
        route: null,
        contexts,
        tabs: { tabs: [SHELL, LOGS], activeTabId: SHELL.id },
        attach: { [SHELL.id]: "pty-moved" },
      };
    default:
      return {
        kind: "view",
        route: "/deployments?resource=deployments&kind=Deployment",
        contexts,
        tabs: { tabs: [], activeTabId: null },
      };
  }
}

/** The recent output of the shell that "moved" here (replayed on attach). */
export const MOVED_SHELL_OUTPUT = [
  "\x1b[38;5;111mpayments-api-7qjjhld4s-974t2\x1b[0m:\x1b[38;5;150m/app\x1b[0m$ ls",
  "config  main  migrations  static",
  "\x1b[38;5;111mpayments-api-7qjjhld4s-974t2\x1b[0m:\x1b[38;5;150m/app\x1b[0m$ env | grep DB_",
  "DB_HOST=payments-db.payments.svc",
  "DB_POOL_SIZE=20",
  "\x1b[38;5;111mpayments-api-7qjjhld4s-974t2\x1b[0m:\x1b[38;5;150m/app\x1b[0m$ ",
].join("\r\n");

/** Handles the window commands; undefined when `cmd` isn't one. */
export function handleWindowCommand(cmd: string): Promise<unknown> | undefined {
  switch (cmd) {
    case "window_open":
    case "window_focus":
    case "tty_release":
    case "plugin:window|set_title":
      return Promise.resolve(null);
    case "plugin:window|scale_factor":
      return Promise.resolve(1);
    case "plugin:window|outer_position":
      return Promise.resolve({ x: 0, y: 0 });
    case "plugin:window|inner_size":
      return Promise.resolve({ width: innerWidth, height: innerHeight });
    default:
      return undefined;
  }
}

/*
 * The event mocks of @tauri-apps/api/mocks swallow emitTo (only listen,
 * emit and unlisten are mocked): answer the pop-out's request for its
 * payload, deliver everything else to this page's listeners. Call after
 * mockIPC.
 */
export function installEmitToMock() {
  const internals = (window as any).__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = (cmd: string, args: any, options: unknown) => {
    if (cmd !== "plugin:event|emit_to") return invoke(cmd, args, options);
    if (args?.event === "window://ready") {
      setTimeout(() => void emit("window://payload", payload()), 30);
      return Promise.resolve(null);
    }
    return invoke("plugin:event|emit", { event: args?.event, payload: args?.payload }, options);
  };
}
