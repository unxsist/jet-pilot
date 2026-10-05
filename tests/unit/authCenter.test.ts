import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  toasts: [] as { id: string; open: boolean; title?: string; [key: string]: unknown }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
  Channel: class {
    onmessage: (message: unknown) => void = () => undefined;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    h.listeners.set(event, handler);
    return () => h.listeners.delete(event);
  }),
}));
vi.mock("@/components/ui/toast", () => ({
  toast: vi.fn((props: Record<string, unknown>) => {
    const record = { ...props, id: String(h.toasts.length + 1), open: true };
    h.toasts.push(record);
    return {
      id: record.id,
      update: (next: Record<string, unknown>) => Object.assign(record, next),
      dismiss: () => (record.open = false),
    };
  }),
  useToast: () => ({ toasts: { value: h.toasts } }),
}));
vi.mock("radix-vue", () => ({ ToastAction: {} }));

import { authInfoOf, classifyAuthError, errorText, isSignInIssue } from "@/lib/auth/classify";
import {
  MAX_LOGIN_LINES,
  browserUrl,
  hostOf,
  initialLoginState,
  isFinished,
  redactLine,
  reduceLogin,
  type LoginViewState,
} from "@/lib/auth/loginSession";
import {
  closeSignIn,
  credential,
  credentialView,
  onRecovered,
  recover,
  registerAuthHost,
  report,
  reportHealthy,
  requestSignIn,
  resetAuthCenterForTests,
  setActiveClusters,
  setSigningIn,
  signInRequest,
  type CredentialView,
} from "@/lib/auth/center";
import { resetNotifyForTests, startIssueToasts } from "@/lib/auth/notify";
import { credentialBadge, formatRemaining } from "@/lib/auth/badge";
import type { AuthTarget, CredentialStatus, LoginEvent } from "@/lib/auth/types";

/* ------------------------------------------------------------ classify -- */

describe("classifyAuthError", () => {
  test("expired AWS SSO sessions", () => {
    const result = classifyAuthError(
      "exec: executable aws failed with exit code 255: Error loading SSO Token: Token for my-sso does not exist (AWS_PROFILE=prod)"
    );
    expect(result).toEqual({ kind: "expired", awsSso: true, execPlugin: true });
  });

  test("exec plugin failures", () => {
    expect(
      classifyAuthError("getting credentials: exec: executable kubelogin failed with exit code 1")
    ).toMatchObject({ kind: "execFailed", execPlugin: true, awsSso: false });
    expect(classifyAuthError("error: auth exec plugin returned an error")?.kind).toBe("execFailed");
  });

  test("device code prompts need the user", () => {
    expect(
      classifyAuthError(
        "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate."
      )?.kind
    ).toBe("interactionRequired");
  });

  test("rejected credentials", () => {
    expect(classifyAuthError("Unauthorized")?.kind).toBe("unauthorized");
    expect(
      classifyAuthError("error: You must be logged in to the server (Unauthorized)")?.kind
    ).toBe("unauthorized");
    expect(classifyAuthError("the server has asked for the client to provide credentials")?.kind).toBe(
      "unauthorized"
    );
    expect(classifyAuthError("oidc: token has expired")?.kind).toBe("expired");
  });

  test("missing plugins and plugin timeouts are not fixed by signing in", () => {
    const missing = classifyAuthError(
      'getting credentials: exec: executable kubelogin not found... exec: "kubelogin": executable file not found in $PATH'
    );
    expect(missing?.kind).toBe("execMissing");
    expect(isSignInIssue(missing!.kind)).toBe(false);
    const timeout = classifyAuthError("getting credentials: exec: kubelogin timed out after 20s");
    expect(timeout?.kind).toBe("timeout");
    expect(isSignInIssue(timeout!.kind)).toBe(false);
    expect(isSignInIssue("expired")).toBe(true);
  });

  test("other failures are not authentication failures", () => {
    expect(classifyAuthError('pods is forbidden: User "dev" cannot list resource "pods"')).toBeNull();
    expect(classifyAuthError("dial tcp 10.0.0.1:443: i/o timeout")).toBeNull();
    expect(classifyAuthError("x509: certificate has expired or is not yet valid")).toBeNull();
    expect(classifyAuthError("")).toBeNull();
  });

  test("error values", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ message: "api", code: 401 })).toBe("api");
    const auth = { kubeConfig: "/kc", context: "a", kind: "expired", command: "aws" };
    expect(authInfoOf({ message: "x", auth })).toEqual(auth);
    expect(authInfoOf({ message: "x" })).toBeNull();
    expect(authInfoOf("x")).toBeNull();
  });
});

/* -------------------------------------------------------- loginSession -- */

const run = (events: LoginEvent[], state: LoginViewState = initialLoginState()) =>
  events.reduce(reduceLogin, state);

describe("login session reducer", () => {
  test("a device-code login", () => {
    let state = run([{ type: "started", command: "kubelogin get-token --login devicecode" }]);
    expect(state.phase).toBe("waiting");
    expect(state.command).toBe("kubelogin get-token --login devicecode");

    state = run(
      [
        { type: "line", stream: "stderr", text: "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate." },
        { type: "deviceCode", userCode: "ABCD-EFGH", verificationUri: "https://microsoft.com/devicelogin" },
      ],
      state
    );
    expect(state.deviceCode).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: "https://microsoft.com/devicelogin",
      verificationUriComplete: null,
    });
    expect(state.domain).toBe("microsoft.com");
    expect(browserUrl(state)).toBe("https://microsoft.com/devicelogin");
    expect(state.lines).toHaveLength(1);

    state = run([{ type: "succeeded", expiresAt: 123 }], state);
    expect(state.phase).toBe("succeeded");
    expect(state.expiresAt).toBe(123);
    expect(isFinished(state)).toBe(true);
    // Late events change nothing.
    expect(run([{ type: "failed", message: "late" }], state)).toBe(state);
  });

  test("the domain is the host of the page Open browser opens", () => {
    const state = run([
      {
        type: "deviceCode",
        userCode: "WXYZ",
        verificationUri: "https://device.sso.eu-west-1.amazonaws.com/",
        verificationUriComplete: "https://Device.SSO.eu-west-1.amazonaws.com/?user_code=WXYZ",
      },
    ]);
    expect(browserUrl(state)).toBe("https://Device.SSO.eu-west-1.amazonaws.com/?user_code=WXYZ");
    expect(state.domain).toBe("device.sso.eu-west-1.amazonaws.com");
  });

  test("browser flows", () => {
    const state = run([{ type: "url", url: "http://localhost:8000/login" }]);
    expect(state.phase).toBe("waiting");
    expect(state.domain).toBe("localhost");
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });

  test("failures, cancellation and unknown events", () => {
    expect(run([{ type: "failed", message: "boom" }])).toMatchObject({ phase: "failed", error: "boom" });
    expect(run([{ type: "cancelled" }]).phase).toBe("cancelled");
    const state = initialLoginState();
    expect(reduceLogin(state, { type: "progress" } as unknown as LoginEvent)).toBe(state);
  });

  test("output is redacted and capped", () => {
    expect(redactLine("\u001b[31mtoken: eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl\u001b[0m")).toBe("token: [redacted]");
    expect(redactLine("access_token=abc123&x=1")).toBe("access_token=[redacted]&x=1");
    expect(redactLine("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
    expect(redactLine("key " + "A".repeat(48))).toBe("key [redacted]");
    expect(redactLine("using /usr/local/bin/kubelogin-with-a-rather-long-file-name")).toBe(
      "using /usr/local/bin/kubelogin-with-a-rather-long-file-name"
    );
    expect(redactLine("the token has expired")).toBe("the token has expired");

    const lines: LoginEvent[] = Array.from({ length: MAX_LOGIN_LINES + 5 }, (_, i) => ({
      type: "line",
      stream: "stdout",
      text: `line ${i}`,
    }));
    const state = run(lines);
    expect(state.lines).toHaveLength(MAX_LOGIN_LINES);
    expect(state.droppedLines).toBe(5);
    expect(state.lines[0]!.text).toBe("line 5");
  });
});

/* ------------------------------------------------------------- center -- */

const A: AuthTarget = { kubeConfig: "/kube/config", context: "alpha" };
const B: AuthTarget = { kubeConfig: "/kube/config", context: "beta" };
const C: AuthTarget = { kubeConfig: "/kube/other", context: "gamma" };

let statuses: Record<string, Partial<CredentialStatus>> = {};
const statusOf = (target: AuthTarget): CredentialStatus => ({
  ...target,
  kind: "exec",
  command: "kubelogin",
  interactive: "interactive",
  state: "valid",
  expiresAt: null,
  canSignIn: true,
  ...statuses[target.context],
});

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const EXPIRED = "getting credentials: exec: executable kubelogin failed with exit code 1: token has expired";

let stopToasts: () => void = () => undefined;

beforeEach(() => {
  resetAuthCenterForTests();
  resetNotifyForTests();
  stopToasts = startIssueToasts();
  setActiveClusters([A, B, C]);
  h.toasts.length = 0;
  h.listeners.clear();
  statuses = {};
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (cmd: string, args: { contexts: AuthTarget[] }) => {
    if (cmd === "auth_credential_status") return args.contexts.map(statusOf);
    if (cmd === "get_context_auth_info") return { execCommand: "aws", awsProfile: null };
    return null;
  });
});

afterEach(() => {
  stopToasts();
  vi.useRealTimers();
});

const invoked = (cmd: string) => h.invoke.mock.calls.filter(([name]) => name === cmd);

describe("auth center", () => {
  test("report marks the cluster and never opens a dialog or starts a login", async () => {
    expect(report(A, EXPIRED, "watch")).toBe(true);
    await settle();

    const view = credentialView(A);
    expect(view.needsSignIn).toBe(true);
    expect(view.state).toBe("expired");
    expect(view.lastIssue).toMatchObject({ kind: "expired", source: "watch" });
    expect(signInRequest.value).toBeNull();
    expect(invoked("auth_login_start")).toHaveLength(0);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]!.title).toBe("Sign-in needed for alpha");
  });

  test("inactive clusters only show their state (no toast)", async () => {
    setActiveClusters([B]);
    // e.g. the Clusters hub's background check of a cluster not in use
    expect(report(A, EXPIRED, "api")).toBe(true);
    await settle();
    expect(credentialView(A).needsSignIn).toBe(true);
    expect(h.toasts).toHaveLength(0);
  });

  test("issues reported before the host mounts are toasted when it does", async () => {
    stopToasts();
    resetAuthCenterForTests();
    setActiveClusters([A]);
    report(A, EXPIRED, "watch");
    await settle();
    expect(h.toasts).toHaveLength(0);
    stopToasts = startIssueToasts();
    await settle();
    expect(h.toasts).toHaveLength(1);
  });

  test("opening the sign-in dialog dismisses the toast", async () => {
    const unregister = registerAuthHost();
    report(A, EXPIRED, "watch");
    await settle();
    void requestSignIn(A);
    await settle();
    expect(h.toasts[0]!.open).toBe(false);
    closeSignIn(false);
    unregister();
  });

  test("other failures are not reported", async () => {
    expect(report(A, "dial tcp 10.0.0.1:443: connect: connection refused", "api")).toBe(false);
    expect(report(A, { message: "forbidden", code: 403 }, "api")).toBe(false);
    await settle();
    expect(credentialView(A).needsSignIn).toBe(false);
    expect(h.toasts).toHaveLength(0);
  });

  test("a missing plugin is recorded but not handled as a sign-in", async () => {
    expect(report(A, 'exec: "kubelogin": executable file not found in $PATH', "watch")).toBe(false);
    await settle();
    expect(credentialView(A).lastIssue?.kind).toBe("execMissing");
    expect(credentialView(A).needsSignIn).toBe(false);
    expect(h.toasts).toHaveLength(0);
  });

  test("API errors with auth info", () => {
    const error = { message: "nope", code: 401, auth: { ...A, kind: "interactionRequired", command: "kubelogin" } };
    expect(report(A, error, "api")).toBe(true);
    expect(credentialView(A).state).toBe("needsLogin");
  });

  test("one toast per credential per session", async () => {
    report(A, EXPIRED, "watch");
    await settle();
    report(B, EXPIRED, "watch");
    report(A, EXPIRED, "logs");
    await settle();

    // Same kubeconfig + command: one toast for both.
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]!.title).toBe("Sign-in needed for alpha (and 1 more)");

    // Another credential gets its own.
    report(C, EXPIRED, "watch");
    await settle();
    expect(h.toasts).toHaveLength(2);

    // Dismissed: not shown again this session.
    h.toasts[0]!.open = false;
    report(A, EXPIRED, "watch");
    report(B, EXPIRED, "watch");
    await settle();
    expect(h.toasts).toHaveLength(2);
  });

  test("contexts sharing an AWS profile share a toast", async () => {
    statuses = {
      alpha: { command: "aws", awsProfile: "prod" },
      gamma: { command: "/usr/bin/aws", awsProfile: "prod" },
    };
    report(A, EXPIRED, "watch");
    report(C, EXPIRED, "watch");
    await settle();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]!.title).toBe("Sign-in needed for alpha (and 1 more)");
  });

  test("credentials that can't sign in are left to the views", async () => {
    statuses = { alpha: { kind: "token", command: null, canSignIn: false } };
    await credential(A).value; // registers + fetches the status
    await settle();
    expect(report(A, "Unauthorized", "watch")).toBe(false);
    await settle();
    expect(h.toasts).toHaveLength(0);
  });

  test("no toast while signing in", async () => {
    setSigningIn(A, true);
    report(A, EXPIRED, "watch");
    await settle();
    expect(h.toasts).toHaveLength(0);
    expect(credentialView(A).signingIn).toBe(true);
  });

  test("auth://issue events are reports", async () => {
    report(C, "Unauthorized", "api"); // starts the center
    await settle();
    h.listeners.get("auth://issue")!({
      payload: { ...A, kind: "interactionRequired", source: "metrics", message: "device code", command: "kubelogin" },
    });
    expect(credentialView(A).lastIssue).toMatchObject({ source: "metrics", kind: "interactionRequired" });
  });

  test("auth://resolved fans out to every affected cluster", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    report(A, EXPIRED, "watch");
    report(B, EXPIRED, "watch");
    await settle();

    const onA = vi.fn();
    const onAny = vi.fn();
    const onC = vi.fn();
    onRecovered(A, onA);
    onRecovered("*", onAny);
    const stopC = onRecovered(C, onC);
    stopC();

    h.invoke.mockClear();
    h.listeners.get("auth://resolved")!({ payload: { contexts: [A, B] } });

    expect(onA).toHaveBeenCalledTimes(1);
    expect(onAny).toHaveBeenCalledTimes(2);
    expect(onAny.mock.calls.map(([t]) => t.context)).toEqual(["alpha", "beta"]);
    expect(onC).not.toHaveBeenCalled();
    expect(credentialView(A).needsSignIn).toBe(false);
    expect(credentialView(B).needsSignIn).toBe(false);
    // The toast went with it, and the statuses are checked again.
    expect(h.toasts[0]!.open).toBe(false);
    expect(invoked("auth_credential_status")[0]![1]).toEqual({ contexts: [A, B] });

    // A stale failure right after the sign-in is ignored...
    expect(report(A, EXPIRED, "watch")).toBe(true);
    expect(credentialView(A).needsSignIn).toBe(false);

    // ...a later one is a new problem: a new toast.
    vi.setSystemTime(1_000_000 + 10_000);
    report(A, EXPIRED, "watch");
    await settle();
    expect(credentialView(A).needsSignIn).toBe(true);
    expect(h.toasts).toHaveLength(2);
  });

  test("healthy data recovers a reported cluster", async () => {
    const onA = vi.fn();
    onRecovered(A, onA);
    reportHealthy(A);
    expect(onA).not.toHaveBeenCalled();

    report(A, EXPIRED, "watch");
    reportHealthy(A);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(credentialView(A).needsSignIn).toBe(false);
  });

  test("recovery callbacks survive a failing one", () => {
    const good = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onRecovered(A, () => {
      throw new Error("boom");
    });
    onRecovered(A, good);
    recover([A]);
    expect(good).toHaveBeenCalled();
    error.mockRestore();
  });

  test("requestSignIn opens the dialog and resolves when it closes", async () => {
    const unregister = registerAuthHost();
    const pending = requestSignIn(A);
    expect(signInRequest.value?.target).toEqual(A);
    // Asking again for the same cluster keeps the open dialog.
    expect(requestSignIn(A)).toBe(pending);
    closeSignIn(true);
    await expect(pending).resolves.toBe(true);
    expect(signInRequest.value).toBeNull();

    const first = requestSignIn(A);
    const second = requestSignIn(B);
    await expect(first).resolves.toBe(false);
    expect(signInRequest.value?.target).toEqual(B);
    closeSignIn(false);
    await expect(second).resolves.toBe(false);
    unregister();
  });

  test("statuses are fetched once per context, batched", async () => {
    credentialView(A);
    credentialView(B);
    credentialView(A);
    await settle();
    expect(invoked("auth_credential_status")).toHaveLength(1);
    expect(invoked("auth_credential_status")[0]![1]).toEqual({ contexts: [A, B] });
    expect(credentialView(A).status?.command).toBe("kubelogin");
  });
});

/* -------------------------------------------------------------- badge -- */

const view = (patch: Partial<CredentialView>): CredentialView => ({
  key: "k",
  target: A,
  status: null,
  state: "unknown",
  needsSignIn: false,
  canSignIn: true,
  signInLabel: null,
  expiresAt: null,
  signingIn: false,
  lastIssue: null,
  ...patch,
});

describe("credential badge", () => {
  const now = 1_000_000_000;

  test("states", () => {
    expect(credentialBadge(view({}), now)).toBeNull();
    expect(credentialBadge(view({ state: "valid" }), now)).toMatchObject({ text: "Signed in", tone: "success", signIn: false });
    expect(credentialBadge(view({ state: "needsLogin", needsSignIn: true }), now)).toMatchObject({
      text: "Sign-in needed",
      tone: "warning",
      signIn: true,
    });
    expect(credentialBadge(view({ state: "expired", needsSignIn: true, canSignIn: false }), now)).toMatchObject({
      text: "Expired",
      signIn: false,
    });
    expect(credentialBadge(view({ state: "valid", signingIn: true }), now)?.text).toBe("Signing in…");
  });

  test("expiry", () => {
    expect(credentialBadge(view({ state: "valid", expiresAt: now + 12 * 60_000 }), now)).toMatchObject({
      text: "Expires in 12m",
      tone: "warning",
      signIn: true,
    });
    expect(credentialBadge(view({ state: "valid", expiresAt: now + 3 * 3600_000 }), now)).toMatchObject({
      text: "Expires in 3h",
      tone: "muted",
      signIn: false,
    });
    expect(credentialBadge(view({ state: "valid", expiresAt: now - 1 }), now)?.text).toBe("Expired");
    expect(formatRemaining(30_000)).toBe("<1m");
    expect(formatRemaining(3 * 86400_000)).toBe("3d");
  });
});
