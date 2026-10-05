import type {
  KubernetesObject,
  V1APIGroup,
  V1APIResource,
  V1Job,
  V1Namespace,
} from "@kubernetes/client-node";
import { invoke, type Channel } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import type {
  MetricsMessage,
  MetricsRequest,
  WatchMessage,
  WatchRequest,
  WatchSubscription,
} from "@/lib/watch";
import type { CliResult } from "@/actions/command";

export interface KubernetesError {
  message: string;
  code: number;
  reason: string;
  details: any;
}

export interface ExecAuthOutput {
  command: string;
  // Only non-credential plugin output; the ExecCredential is never returned.
  stdout: string;
  stderr: string;
}

/**
 * Secret-free summary of a context's auth configuration, as returned by the
 * `get_context_auth_info` command.
 */
export interface ContextAuthSummary {
  execCommand: string | null;
  awsProfile: string | null;
}

// Exec credential plugin binaries the app can trigger a login flow for.
// kubelogin (Azure AKS + generic OIDC), `kubectl oidc-login` (GKE / generic
// OIDC) and gke-gcloud-auth-plugin (GKE).
const EXEC_AUTH_PLUGINS = ["kubelogin", "oidc-login"];

function getExecCommand(authInfo: ContextAuthSummary): string | null {
  const command = authInfo.execCommand;
  if (typeof command !== "string") return null;
  const basename = command.split(/[\\/]/).pop() || command;
  return basename;
}

/** Backend log stream (src-tauri/src/log_stream.rs `LogStreamSpec`). */
export interface LogStreamSpec {
  context: string;
  namespace: string;
  kubeConfig?: string | null;
  target:
    | { kind: "pod"; name: string }
    | { kind: "selector"; selector: string }
    | { kind: "object"; name: string };
  container?: string | null;
  follow?: boolean;
  previous?: boolean;
  since?: string | null;
  tail?: number | null;
  maxPods?: number | null;
}

export interface WatchStats {
  watchers: number;
  subscriptions: number;
  objects: number;
  idle: number;
  paused: boolean;
}

/*
 * Optional kubeconfig argument: "" and undefined both mean "the selected
 * kubeconfig" to the backend; send null so the Rust Option is None.
 */
const kubeConfigArg = (kubeConfig?: string | null) => kubeConfig || null;

export class Kubernetes {
  static async getAuthErrorHandler(
    context: string,
    kubeConfig: string,
    errorMessage: string
  ): Promise<{
    canHandle: boolean;
    callback: (authCompletedCallback?: (instructions?: string) => void) => void;
  }> {
    // AWS SSO
    if (
      (errorMessage.includes("AWS_PROFILE") ||
        errorMessage.includes("executable aws failed")) &&
      (errorMessage.includes("Error loading SSO Token") ||
        errorMessage.includes("profile has expired") ||
        errorMessage.includes("Error when retrieving token from sso"))
    ) {
      const context_auth_info = await invoke<ContextAuthSummary>(
        "get_context_auth_info",
        {
          context: context,
          kubeConfig: kubeConfigArg(kubeConfig),
        }
      );

      const aws_profile = context_auth_info.awsProfile;

      return {
        canHandle: aws_profile !== null,
        callback: async (authCompletedCallback?) => {
          if (aws_profile === null) return;
          // Must match the `aws` shell scope in capabilities/migrated.json.
          const command = Command.create("aws", [
            "sso",
            "login",
            "--profile",
            aws_profile,
          ]);
          command.addListener("close", async () => {
            authCompletedCallback?.();
          });
          await command.spawn();
        },
      };
    }

    // Exec credential plugins: kubelogin / oidc-login (and similar). These are
    // used by AKS (kubelogin), GKE (gke-gcloud-auth-plugin, `kubectl
    // oidc-login`) and other OIDC-protected clusters. The plugin needs to run
    // interactively (device-code / browser flow), which can't happen in the GUI
    // app - so we surface the plugin output (the URL / code) to the user and
    // let them complete the login, then retry.
    const context_auth_info = await invoke<ContextAuthSummary>(
      "get_context_auth_info",
      {
        context: context,
        kubeConfig: kubeConfigArg(kubeConfig),
      }
    );

    const execCommand = getExecCommand(context_auth_info);
    const isExecPluginAuth =
      execCommand !== null &&
      (EXEC_AUTH_PLUGINS.includes(execCommand) ||
        Kubernetes.kubeconfigAuthFlowFailed(errorMessage));

    if (isExecPluginAuth) {
      return {
        canHandle: true,
        callback: async (
          authCompletedCallback?: (instructions?: string) => void
        ) => {
          try {
            const authOutput = (await invoke("login_exec_auth", {
              context: context,
              kubeConfig: kubeConfigArg(kubeConfig),
            })) as ExecAuthOutput;

            const instructions = [authOutput.stderr, authOutput.stdout]
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n");

            if (instructions) {
              authCompletedCallback?.(instructions);
            } else {
              authCompletedCallback?.();
            }
          } catch (e: any) {
            authCompletedCallback?.(e?.message || String(e));
          }
        },
      };
    }

    return {
      canHandle: false,
      callback: () => {
        // Do nothing
      },
    };
  }

  private static kubeconfigAuthFlowFailed(errorMessage: string): boolean {
    return (
      errorMessage.toLowerCase().includes("exec credential plugin") ||
      errorMessage.toLowerCase().includes("exec plugin") ||
      errorMessage.toLowerCase().includes("kubelogin") ||
      errorMessage.toLowerCase().includes("oidc") ||
      errorMessage.toLowerCase().includes("auth exec")
    );
  }

  /**
   * The current-context of `kubeConfig`, or of the globally selected
   * kubeconfig (falling back to kube's default resolution) when omitted.
   */
  static async getCurrentContext(kubeConfig?: string): Promise<string> {
    return invoke("get_current_context", { kubeConfig: kubeConfig });
  }

  static async setCurrentKubeConfig(kubeConfig: string): Promise<void> {
    return invoke("set_current_kubeconfig", { kubeConfig: kubeConfig });
  }

  /**
   * Lists the contexts of `kubeConfig`, or of the globally selected kubeconfig
   * when omitted.
   */
  static async getContexts(
    kubeConfig?: string
  ): Promise<{ name: string; context: { namespace: string } }[]> {
    return invoke("list_contexts", { kubeConfig: kubeConfig });
  }

  static async getNamespaces(
    context: string,
    kubeConfig: string
  ): Promise<V1Namespace[]> {
    return invoke("list_namespaces", {
      context: context,
      kubeConfig: kubeConfig,
    });
  }

  static async kubectl(args: string[]): Promise<string> {
    return invoke("run_kubectl", { args: args });
  }

  /*
   * Context-scoped commands accept an optional `kubeConfig`: the kubeconfig
   * file the context lives in. When omitted the backend falls back to the
   * globally selected kubeconfig, which is wrong for contexts from another
   * file in multi-context mode - pass it whenever it is known.
   */

  static async getCoreApiVersions(
    context: string,
    kubeConfig?: string
  ): Promise<string[]> {
    return invoke("get_core_api_versions", {
      context: context,
      kubeConfig: kubeConfig,
    });
  }

  static async getCoreApiResources(
    context: string,
    core_api_version: string,
    kubeConfig?: string
  ): Promise<V1APIResource[]> {
    return invoke("get_core_api_resources", {
      context: context,
      coreApiVersion: core_api_version,
      kubeConfig: kubeConfig,
    });
  }

  static async getApiGroups(
    context: string,
    kubeConfig?: string
  ): Promise<V1APIGroup[]> {
    return invoke("get_api_groups", {
      context: context,
      kubeConfig: kubeConfig,
    });
  }

  static async getApiGroupResources(
    context: string,
    api_group_version: string,
    kubeConfig?: string
  ): Promise<V1APIResource[]> {
    return invoke("get_api_group_resources", {
      context: context,
      apiGroupVersion: api_group_version,
      kubeConfig: kubeConfig,
    });
  }

  /**
   * Runs `kubectl apply|replace -f -` with the manifest on stdin, so edited
   * objects never touch a temp file.
   */
  static async applyManifest(
    context: string,
    namespace: string,
    manifest: string,
    mode: "apply" | "replace",
    kubeConfig?: string,
    /** `--dry-run=server`: validate + admit without persisting. */
    dryRun = false
  ): Promise<string> {
    return invoke("apply_manifest", {
      context: context,
      namespace: namespace,
      manifest: manifest,
      mode: mode,
      kubeConfig: kubeConfig,
      dryRun,
    });
  }

  static async replaceObject(
    context: string,
    namespace: string,
    type: string,
    name: string,
    object: unknown,
    kubeConfig?: string
  ): Promise<KubernetesObject> {
    return invoke(`replace_${type.toLowerCase()}`, {
      context: context,
      namespace: namespace,
      name: name,
      object,
      kubeConfig: kubeConfig,
    }) as Promise<KubernetesObject>;
  }

  static async deletePod(
    context: string,
    namespace: string,
    name: string,
    gracePeriodSeconds = 0,
    kubeConfig?: string
  ): Promise<void> {
    return invoke("delete_pod", {
      context: context,
      namespace: namespace,
      name: name,
      gracePeriodSeconds: gracePeriodSeconds,
      kubeConfig: kubeConfig,
    });
  }











  /** Creates a Job from the CronJob's template (`kubectl create job --from`). */
  static async triggerCronJob(
    context: string,
    namespace: string,
    name: string,
    kubeConfig?: string
  ): Promise<V1Job> {
    return invoke("trigger_cronjob", {
      context: context,
      namespace: namespace,
      name: name,
      kubeConfig: kubeConfig,
    });
  }

  /* --------------------------------------------- live lists (WatchHub) -- */

  /**
   * Subscribes to a live list (src-tauri/src/watch): a snapshot per scope,
   * then batched deltas and status changes on `channel`.
   */
  static async watchSubscribe<T>(
    request: WatchRequest,
    channel: Channel<WatchMessage<T>>
  ): Promise<WatchSubscription> {
    return invoke("watch_subscribe", {
      request: { ...request, kubeConfig: kubeConfigArg(request.kubeConfig) },
      onEvent: channel,
    });
  }

  static async watchUnsubscribe(id: number): Promise<void> {
    return invoke("watch_unsubscribe", { id });
  }

  /** Reconnects the watchers of a subscription that are not ready. */
  static async watchRestart(id: number): Promise<void> {
    return invoke("watch_restart", { id });
  }

  /** Drops every subscription (after a webview reload). */
  static async watchReset(): Promise<void> {
    return invoke("watch_reset");
  }

  /** Pauses (window hidden) / resumes delta delivery of every watch. */
  static async watchSetPaused(paused: boolean): Promise<void> {
    return invoke("watch_set_paused", { paused });
  }

  /** The full cached object for `uid` from a running watcher. */
  static async getWatchedObject<T = unknown>(uid: string): Promise<T> {
    return invoke("watch_get", { uid });
  }

  static async watchStats(): Promise<WatchStats> {
    return invoke("watch_stats");
  }

  /* ------------------------------------------------ metrics service -- */

  /** Pod / node metrics every 15 s (+ history on subscribe) on `channel`. */
  static async metricsSubscribe<P = unknown, N = unknown>(
    request: MetricsRequest,
    channel: Channel<MetricsMessage<P, N>>
  ): Promise<number> {
    return invoke("metrics_subscribe", {
      request: { ...request, kubeConfig: kubeConfigArg(request.kubeConfig) },
      onEvent: channel,
    });
  }

  static async metricsUnsubscribe(id: number): Promise<void> {
    return invoke("metrics_unsubscribe", { id });
  }

  static async metricsReset(): Promise<void> {
    return invoke("metrics_reset");
  }

  /* ------------------------------------------------------- manifests -- */

  /**
   * The cluster's OpenAPI v3 document of `apiVersion` (raw JSON bytes,
   * cached by the backend).
   */
  static async getOpenApiV3Schema(
    context: string,
    apiVersion: string,
    kubeConfig?: string
  ): Promise<unknown> {
    return invoke("get_openapi_v3_schema", {
      context,
      kubeConfig: kubeConfigArg(kubeConfig),
      apiVersion,
    });
  }

  /* ------------------------------------------------------------ logs -- */

  /** Streams `kubectl logs` into a structured logging session. */
  static async startLogStream<E>(
    sessionId: string,
    spec: LogStreamSpec,
    channel: Channel<E>
  ): Promise<void> {
    return invoke("start_log_stream", {
      sessionId,
      spec: { ...spec, kubeConfig: kubeConfigArg(spec.kubeConfig) },
      onEvent: channel,
    });
  }

  static async stopLogStream(sessionId: string): Promise<void> {
    return invoke("stop_log_stream", { sessionId });
  }

  /* ------------------------------------------------------- workloads -- */

  /**
   * `helm <args> --values <tmp>`: the backend writes `values` to an
   * owner-only temp file for the duration of the command.
   */
  static async runHelmWithValues(
    args: string[],
    values: string
  ): Promise<CliResult> {
    return invoke("run_helm_with_values", { args, values });
  }
}
