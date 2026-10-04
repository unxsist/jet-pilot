import {
  KubernetesObject,
  PodMetric,
  V1APIGroup,
  V1APIResource,
  V1ConfigMap,
  V1CronJob,
  V1Deployment,
  V1Ingress,
  V1Job,
  V1Namespace,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Secret,
  V1Service,
} from "@kubernetes/client-node";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";

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
          kubeConfig: kubeConfig,
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
        kubeConfig: kubeConfig,
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
              kubeConfig: kubeConfig,
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

  static async getDeployments(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1Deployment[]> {
    return invoke("list_deployments", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async restartDeployment(
    context: string,
    namespace: string,
    name: string,
    kubeConfig?: string
  ): Promise<boolean> {
    return invoke("restart_deployment", {
      context: context,
      namespace: namespace,
      name: name,
      kubeConfig: kubeConfig,
    });
  }

  static async restartStatefulset(
    context: string,
    namespace: string,
    name: string,
    kubeConfig?: string
  ): Promise<boolean> {
    return invoke("restart_statefulset", {
      context: context,
      namespace: namespace,
      name: name,
      kubeConfig: kubeConfig,
    });
  }

  static async getJobs(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1Job[]> {
    return invoke("list_jobs", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async getCronJobs(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1CronJob[]> {
    return invoke("list_cronjobs", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async getConfigMaps(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1ConfigMap[]> {
    return invoke("list_configmaps", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async getSecrets(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1Secret[]> {
    return invoke("list_secrets", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async getServices(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1Service[]> {
    return invoke("list_services", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async getIngresses(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1Ingress[]> {
    return invoke("list_ingresses", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async getPersistentVolumeClaims(
    context: string,
    namespace: string,
    kubeConfig?: string
  ): Promise<V1PersistentVolumeClaim[]> {
    return invoke("list_persistentvolumeclaims", {
      context: context,
      namespace: namespace,
      kubeConfig: kubeConfig,
    });
  }

  static async triggerCronJob(
    context: string,
    namespace: string,
    name: string,
    kubeConfig?: string
  ): Promise<boolean> {
    return invoke("trigger_cronjob", {
      context: context,
      namespace: namespace,
      name: name,
      kubeConfig: kubeConfig,
    });
  }
}
