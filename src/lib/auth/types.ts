/*
 * The auth center's IPC contract (src-tauri/src/auth): credential status,
 * login sessions and the `auth://*` events. Types only.
 */

/** A context, identified by its kubeconfig file and name. */
export interface AuthTarget {
  kubeConfig: string;
  context: string;
}

export type CredentialKind =
  | "token"
  | "clientCert"
  | "exec"
  | "authProvider"
  | "basic"
  | "none";

/** Whether getting a credential may need the user (browser, device code). */
export type InteractiveClass = "nonInteractive" | "interactive" | "unknown";

export type CredentialState =
  | "valid"
  | "expiringSoon"
  | "expired"
  | "needsLogin"
  | "unknown";

/** `auth_credential_status`: one per context. */
export interface CredentialStatus extends AuthTarget {
  kind: CredentialKind;
  command?: string | null;
  /** AWS profile of `aws eks get-token` users, when known. */
  awsProfile?: string | null;
  interactive: InteractiveClass;
  state: CredentialState;
  /** Unix ms. */
  expiresAt?: number | null;
  canSignIn: boolean;
  /** How signing in works, e.g. "Microsoft sign-in (kubelogin)". */
  signInLabel?: string | null;
}

export type AuthIssueKind =
  | "interactionRequired"
  | "expired"
  | "unauthorized"
  | "execFailed"
  | "execMissing"
  | "timeout";

export type AuthSource =
  | "api"
  | "watch"
  | "metrics"
  | "logs"
  | "portForward"
  | "kubectl";

/** `auth://issue` payload (also what `report()` records). */
export interface AuthIssue extends AuthTarget {
  kind: AuthIssueKind;
  source: AuthSource;
  message: string;
  command?: string | null;
}

/** `auth://resolved` payload. */
export interface AuthResolved {
  contexts: AuthTarget[];
}

/** `auth` of an API error (SerializableKubeError). */
export interface AuthErrorInfo extends AuthTarget {
  kind: AuthIssueKind;
  command?: string | null;
}

/** Events of `auth_login_start` (tag `type`). */
export type LoginEvent =
  | { type: "started"; command: string }
  | { type: "line"; stream: "stdout" | "stderr"; text: string }
  | {
      type: "deviceCode";
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string | null;
    }
  | { type: "url"; url: string }
  | { type: "succeeded"; expiresAt?: number | null }
  | { type: "failed"; message: string }
  | { type: "cancelled" };
