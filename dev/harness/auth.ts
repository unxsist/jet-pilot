/*
 * Auth center mocks (src/lib/auth, src-tauri/src/auth): credential status,
 * streamed sign-ins (`auth_login_*` + LoginEvents) and the `auth://issue` /
 * `auth://resolved` events. Installed by setup.ts on top of its mocked IPC
 * (like its plugin-fs wrapper), so it can also make the data commands of a
 * cluster whose credential expired fail the way the backend does.
 *
 *   ?scenario=auth-expired  the first context's kubelogin credential has
 *                           expired: its watches report `unauthorized` (and
 *                           emit auth://issue), as do namespaces, kubectl,
 *                           logs, shells and port forwards. Signing in
 *                           streams the device code ABCD-EFGH for
 *                           https://microsoft.com/devicelogin, succeeds after
 *                           ~3 s, emits auth://resolved and the watches
 *                           recover.
 *   ?authfail=1             sign-ins fail instead (the failure state).
 *   __harnessExpireCredential("prod-eu-west-1")  (devtools) expires a
 *                           credential now: its running watches turn
 *                           `unauthorized`, new shells / log streams / port
 *                           forwards fail.
 *
 * Every other scenario gets plausible statuses (badges) and working
 * sign-ins too.
 */
import { emit } from "@tauri-apps/api/event";

type Auth = { kind: string; command?: string | null; awsProfile?: string | null; interactive?: string };
type Target = { kubeConfig: string; context: string };
/** A Tauri channel as the mocked IPC sees it. */
type Channel = { id: number };
interface WatchRequest extends Target {
  resource: string;
  namespaces: string[];
}
interface Subscription {
  id: number;
  scopes: string[];
}
interface Watch {
  request: WatchRequest;
  channel: Channel;
  scopes: string[];
}
/** The payload fields of the commands this mock looks at. */
interface IpcArgs {
  request?: WatchRequest;
  onEvent?: Channel;
  id?: number;
  contexts?: Target[];
  target?: Target;
  sessionId?: string;
  url?: string;
  context?: string;
  kubeConfig?: string;
  args?: string[];
  spec?: Target & Record<string, unknown>;
  initCommand?: string[];
}
type Invoke = (cmd: string, args?: IpcArgs, ...rest: unknown[]) => Promise<unknown>;
interface Internals {
  invoke: Invoke;
  transformCallback: (callback: () => void) => number;
}

export interface AuthMockOptions {
  scenario: string;
  /** setup.ts's channel sender (the mock keys callbacks by channel id). */
  sendToChannel: (channel: Channel, message: unknown) => void;
  firstContext: string;
  kubeConfig: string;
  /** Kubeconfig fixtures with each context's auth (dev/harness/clusters.ts). */
  files: Record<string, { contexts: { name: string; auth: Auth }[] }>;
}

const EXPIRED_MESSAGES: Record<string, string> = {
  kubelogin:
    "getting credentials: exec: executable kubelogin failed with exit code 1: AADSTS700082: The refresh token has expired due to inactivity.",
  aws: "getting credentials: exec: executable aws failed with exit code 255: Error when retrieving token from sso: Token has expired and refresh failed",
  "gke-gcloud-auth-plugin":
    "getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1: Reauthentication required.",
};
const KUBELOGIN: Auth = { kind: "exec", command: "kubelogin", interactive: "interactive" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const basename = (command: string) => command.split(/[\\/]/).pop() || command;

const SIGN_IN_LABELS: Record<string, (auth: Auth) => string> = {
  kubelogin: () => "Microsoft Entra ID · device code (kubelogin)",
  aws: (auth) => `AWS IAM Identity Center · profile ${auth.awsProfile ?? "default"}`,
  "gke-gcloud-auth-plugin": () => "Google Cloud · browser sign-in (gcloud)",
  doctl: () => "DigitalOcean · doctl",
};

/* Minutes until expiry per context (stable, from the name). */
const expiryMinutes = (context: string) => {
  let hash = 0;
  for (const char of context) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return [9, 47, 180, 600, 25][hash % 5]!;
};

export function installAuthMocks(options: AuthMockOptions): void {
  const { scenario, sendToChannel, firstContext, kubeConfig, files } = options;
  const params = new URLSearchParams(location.search);
  if (params.get("authfail")) localStorage.setItem("harness-authfail", params.get("authfail")!);
  const failSignIn = localStorage.getItem("harness-authfail") === "1";
  const win = window as unknown as {
    __TAURI_INTERNALS__: Internals;
    __harnessExpireCredential?: (context?: string) => void;
  };
  const internals = win.__TAURI_INTERNALS__;
  const next = internals.invoke;
  const subscribe = (args: IpcArgs, rest: unknown[] = []) =>
    next("watch_subscribe", args, ...rest) as Promise<Subscription>;

  /* Contexts (by name) whose credential expired; signed in until then. */
  const expired = new Set<string>(scenario === "auth-expired" ? [firstContext] : []);
  const expiresAt = new Map<string, number>();

  const authOf = (target: Target): Auth => {
    if (scenario === "auth-expired" && target.context === firstContext) return KUBELOGIN;
    const byPath = new Map(Object.entries(files));
    const file = byPath.get(target.kubeConfig) ?? byPath.get(kubeConfig);
    return file?.contexts.find((c) => c.name === target.context)?.auth ?? KUBELOGIN;
  };

  const statusOf = (target: Target) => {
    const auth = authOf(target);
    const command = auth.command ?? null;
    const label = command ? SIGN_IN_LABELS[basename(command)]?.(auth) ?? null : null;
    const base = {
      kubeConfig: target.kubeConfig,
      context: target.context,
      kind: auth.kind,
      command,
      awsProfile: auth.awsProfile ?? null,
      interactive: auth.interactive ?? "unknown",
      canSignIn: auth.kind === "exec" || auth.kind === "authProvider",
      signInLabel: label,
    };
    if (expired.has(target.context)) {
      return { ...base, state: "expired", expiresAt: Date.now() - 20 * 60_000 };
    }
    // Clusters added from a cloud account sign in through it (cloud.ts).
    const cloud = (window as any).__harnessCloudCredential?.(target.context);
    if (cloud) return { ...base, canSignIn: true, ...cloud };
    if (auth.kind !== "exec") return { ...base, state: "valid", expiresAt: null };
    const at = expiresAt.get(target.context) ?? Date.now() + expiryMinutes(target.context) * 60_000;
    expiresAt.set(target.context, at);
    return { ...base, state: at - Date.now() < 15 * 60_000 ? "expiringSoon" : "valid", expiresAt: at };
  };

  const commandOf = (context: string) => basename(authOf({ kubeConfig, context }).command ?? "kubelogin");
  const expiredMessage = (context?: string) =>
    EXPIRED_MESSAGES[commandOf(context ?? firstContext)] ?? EXPIRED_MESSAGES.kubelogin!;

  const issue = (target: Target, source: string) =>
    void emit("auth://issue", {
      kubeConfig: target.kubeConfig,
      context: target.context,
      kind: "expired",
      source,
      message: expiredMessage(target.context),
      command: commandOf(target.context),
    });

  /* ------------------------------------------------------------ watches -- */

  /* Watches of expired contexts: the real (mocked) subscription runs into a sink. */
  const blocked = new Map<number, Watch>();
  /* Every other watch, so a credential can expire while it runs. */
  const live = new Map<number, Watch>();
  /* Metrics of expired contexts: the backend restarts them after a sign-in. */
  const blockedMetrics: { request: IpcArgs["request"]; channel: Channel }[] = [];
  const sink = (): Channel => ({ id: internals.transformCallback(() => undefined) });

  const reportUnauthorized = (channel: Channel, scopes: string[], context: string) => {
    for (const scope of scopes) {
      sendToChannel(channel, { type: "status", scope, state: "unauthorized", message: expiredMessage(context), code: 401 });
    }
  };

  async function blockedWatch(request: WatchRequest, channel: Channel, rest: unknown[]) {
    const subscription = await subscribe({ request, onEvent: sink() }, rest);
    const scopes = subscription.scopes;
    blocked.set(subscription.id, { request, channel, scopes });
    for (const scope of scopes) sendToChannel(channel, { type: "status", scope, state: "syncing" });
    setTimeout(() => {
      if (!blocked.has(subscription.id)) return;
      reportUnauthorized(channel, scopes, request.context);
      issue(request, "watch");
    }, 80);
    return subscription;
  }

  /* Like the backend after a sign-in: restart the watches that failed. */
  function resumeWatch(id: number) {
    const watch = blocked.get(id);
    if (!watch) return;
    blocked.delete(id);
    void subscribe({ request: watch.request, onEvent: watch.channel }).then((subscription) =>
      live.set(subscription.id, { ...watch, scopes: subscription.scopes })
    );
  }

  /* ------------------------------------------------------------ sign in -- */

  const sessions = new Map<string, { timers: ReturnType<typeof setTimeout>[]; channel: Channel }>();
  let sessionIds = 0;

  function signedIn(target: Target) {
    const command = authOf(target).command;
    // Every expired context of the same kubeconfig + command shares it.
    const affected = [...expired]
      .map((context) => ({ kubeConfig: target.kubeConfig, context }))
      .filter((t) => t.context === target.context || authOf(t).command === command);
    if (!affected.some((t) => t.context === target.context)) affected.push(target);
    for (const t of affected) {
      expired.delete(t.context);
      expiresAt.set(t.context, Date.now() + 60 * 60_000);
    }
    for (const [id, watch] of blocked) {
      if (affected.some((t) => t.context === watch.request.context)) resumeWatch(id);
    }
    for (const metrics of blockedMetrics.splice(0)) {
      void next("metrics_subscribe", { request: metrics.request, onEvent: metrics.channel });
    }
    void emit("auth://resolved", { contexts: affected });
  }

  function startLogin(target: Target, channel: Channel): string {
    const id = `login-${++sessionIds}`;
    const auth = authOf(target);
    const tool = basename(auth.command ?? "kubelogin");
    const session = { timers: [] as ReturnType<typeof setTimeout>[], channel };
    sessions.set(id, session);
    const at = (ms: number, fn: () => void) => session.timers.push(setTimeout(fn, ms));
    const send = (message: unknown) => sendToChannel(channel, message);

    if (tool === "aws") {
      at(80, () => send({ type: "started", command: `aws sso login --profile ${auth.awsProfile ?? "default"}` }));
      at(400, () =>
        send({
          type: "deviceCode",
          userCode: "WDKS-QMZT",
          verificationUri: "https://device.sso.eu-west-1.amazonaws.com/",
          verificationUriComplete: "https://device.sso.eu-west-1.amazonaws.com/?user_code=WDKS-QMZT",
        })
      );
    } else if (tool === "gke-gcloud-auth-plugin") {
      at(80, () => send({ type: "started", command: "gcloud auth login --brief" }));
      at(300, () => send({ type: "line", stream: "stderr", text: "Your browser has been opened to visit:" }));
      at(350, () => send({ type: "url", url: "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com" }));
    } else {
      at(80, () => send({ type: "started", command: "kubelogin get-token --login devicecode --server-id 6dae42f8-4368-4678-94ff-3960e28e3630" }));
      at(300, () =>
        send({
          type: "line",
          stream: "stderr",
          text: "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.",
        })
      );
      at(320, () => send({ type: "deviceCode", userCode: "ABCD-EFGH", verificationUri: "https://microsoft.com/devicelogin" }));
    }
    at(3300, () => {
      sessions.delete(id);
      if (failSignIn) {
        send({ type: "line", stream: "stderr", text: "error: failed to get token: AADSTS70016: OAuth 2.0 device flow error. Authorization is pending." });
        send({ type: "failed", message: "AADSTS70016: The sign-in wasn't completed in time. Start it again and enter the code within 15 minutes." });
        return;
      }
      send({ type: "line", stream: "stderr", text: "Authentication complete. access_token=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI2ZGFl.c2lnbmF0dXJl" });
      send({ type: "succeeded", expiresAt: Date.now() + 60 * 60_000 });
      signedIn(target);
    });
    return id;
  }

  /* ---------------------------------------------------------- dispatch -- */

  const expiredTarget = (context?: string) => !!context && expired.has(context);
  const argValue = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  };

  /* Devtools / QA: the credential of `context` expires now. */
  win.__harnessExpireCredential = (context = firstContext) => {
    expired.add(context);
    for (const [id, watch] of live) {
      if (watch.request.context !== context) continue;
      live.delete(id);
      blocked.set(id, watch);
      reportUnauthorized(watch.channel, watch.scopes, context);
    }
    issue({ kubeConfig, context }, "watch");
  };

  internals.invoke = async (cmd: string, args: IpcArgs = {}, ...rest: unknown[]) => {
    const { request, onEvent, spec } = args;
    switch (cmd) {
      case "auth_credential_status":
        await sleep(60);
        return (args.contexts ?? []).map(statusOf);
      case "auth_login_start":
        return startLogin(args.target!, onEvent!);
      case "auth_login_cancel": {
        const session = sessions.get(args.sessionId!);
        if (session) {
          session.timers.forEach(clearTimeout);
          sessions.delete(args.sessionId!);
          sendToChannel(session.channel, { type: "cancelled" });
        }
        return null;
      }
      case "auth_login_open_url":
        console.info("[harness] would open", args.url);
        return null;

      case "watch_subscribe": {
        if (!request || !onEvent) break;
        if (expiredTarget(request.context)) return blockedWatch(request, onEvent, rest);
        const subscription = await subscribe(args, rest);
        live.set(subscription.id, { request, channel: onEvent, scopes: subscription.scopes });
        return subscription;
      }
      case "watch_restart": {
        const watch = blocked.get(args.id!);
        if (!watch) break;
        if (expiredTarget(watch.request.context)) {
          reportUnauthorized(watch.channel, watch.scopes, watch.request.context);
        } else {
          resumeWatch(args.id!);
        }
        return null;
      }
      case "watch_unsubscribe":
        blocked.delete(args.id!);
        live.delete(args.id!);
        break;
      case "metrics_subscribe":
        if (request && onEvent && expiredTarget(request.context)) {
          blockedMetrics.push({ request, channel: onEvent });
          const message = expiredMessage(request.context);
          setTimeout(() => sendToChannel(onEvent, { type: "status", state: "unauthorized", message }), 60);
          return next(cmd, { ...args, onEvent: sink() }, ...rest);
        }
        break;
      case "list_namespaces":
        if (args.context && expiredTarget(args.context)) {
          await sleep(150);
          throw {
            message: expiredMessage(args.context),
            code: null,
            reason: "CredentialExpired",
            details: null,
            auth: {
              kubeConfig: args.kubeConfig ?? kubeConfig,
              context: args.context,
              kind: "expired",
              command: commandOf(args.context),
            },
          };
        }
        break;
      case "run_kubectl": {
        const context = argValue(args.args ?? [], "--context");
        if (expiredTarget(context)) {
          await sleep(120);
          throw `error: ${expiredMessage(context)}`;
        }
        break;
      }
      case "start_log_stream":
        if (spec && onEvent && expiredTarget(spec.context)) {
          setTimeout(() => {
            sendToChannel(onEvent, { type: "notice", level: "error", message: expiredMessage(spec.context) });
            sendToChannel(onEvent, { type: "ended" });
          }, 120);
          return null;
        }
        break;
      case "create_tty_session": {
        const argv = args.initCommand ?? [];
        const context = argValue(argv, "--context");
        if (onEvent && argv[1] === "exec" && expiredTarget(context)) {
          const text =
            `E1005 12:04:31.512 memcache.go:265] couldn't get current server API group list: ${expiredMessage(context)}\r\n` +
            "error: You must be logged in to the server (the server has asked for the client to provide credentials)\r\n";
          setTimeout(() => {
            sendToChannel(onEvent, new TextEncoder().encode(text).buffer);
            sendToChannel(onEvent, { type: "exit", exitCode: 1, error: null });
          }, 200);
          return `pty-${Math.random().toString(36).slice(2)}`;
        }
        break;
      }
      case "start_port_forward":
        if (spec && expiredTarget(spec.context)) {
          const forward = {
            ...spec,
            id: `pf-${Date.now()}`,
            status: "error",
            error: expiredMessage(spec.context),
            startedAtMs: Date.now(),
            expiresAtMs: null,
          };
          setTimeout(() => void emit("port_forward_error", forward), 50);
          return forward;
        }
        break;
    }
    return next(cmd, args, ...rest);
  };
}
