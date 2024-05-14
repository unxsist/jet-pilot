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
import { VirtualService } from "@kubernetes-models/istio/networking.istio.io/v1beta1";
import { invoke } from "@tauri-apps/api/tauri";
import { Command } from "@tauri-apps/api/shell";

export interface KubernetesError {
  message: string;
  code: number;
  reason: string;
  details: any;
}

export class Kubernetes {
  static async getAuthErrorHandler(
    context: string,
    errorMessage: string
  ): Promise<{
    canHandle: boolean;
    callback: (authCompletedCallback?: () => void) => void;
  }> {
    // AWS SSO
    if (
      errorMessage.includes("AWS_PROFILE") &&
      (errorMessage.includes("Error loading SSO Token") ||
        errorMessage.includes("profile has expired"))
    ) {
      const context_auth_info = (await invoke("get_context_auth_info", {
        context: context,
      })) as any;

      let aws_profile = null;
      try {
        aws_profile = context_auth_info.user.exec.env.find(
          (env: any) => env.name === "AWS_PROFILE"
        ).value;
      } catch {}

      return {
        canHandle: aws_profile !== null,
        callback: async (authCompletedCallback?) => {
          const command = new Command("aws", [
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

    return {
      canHandle: false,
      callback: () => {
        console.log("void");
      },
    };
  }

  static async getCurrentContext(): Promise<string> {
    return invoke("get_current_context", {});
  }

  static async getContexts(): Promise<string[]> {
    return invoke("list_contexts", {});
  }

  static async getNamespaces(context: string): Promise<V1Namespace[]> {
    return invoke("list_namespaces", { context: context });
  }

  static async getCoreApiVersions(context: string): Promise<string[]> {
    return invoke("get_core_api_versions", { context: context });
  }

  static async getCoreApiResources(
    context: string,
    core_api_version: string
  ): Promise<V1APIResource[]> {
    return invoke("get_core_api_resources", {
      context: context,
      coreApiVersion: core_api_version,
    });
  }

  static async getApiGroups(context: string): Promise<V1APIGroup[]> {
    return invoke("get_api_groups", { context: context });
  }

  static async getApiGroupResources(
    context: string,
    api_group_version: string
  ): Promise<V1APIResource[]> {
    return invoke("get_api_group_resources", {
      context: context,
      apiGroupVersion: api_group_version,
    });
  }

  static async getPods(
    context: string,
    namespace: string,
    labelSelector = "",
    fieldSelector = ""
  ): Promise<V1Pod[]> {
    return invoke("list_pods", {
      context: context,
      namespace: namespace,
      labelSelector: labelSelector,
      fieldSelector: fieldSelector,
    });
  }

  static async getPodMetrics(
    context: string,
    namespace: string
  ): Promise<PodMetric[]> {
    return invoke("get_pod_metrics", {
      context: context,
      namespace: namespace,
    });
  }

  static async getPod(
    context: string,
    namespace: string,
    name: string
  ): Promise<V1Pod> {
    return invoke("get_pod", {
      context: context,
      namespace: namespace,
      name: name,
    });
  }

  static async replaceObject(
    context: string,
    namespace: string,
    type: string,
    name: string,
    object: unknown
  ): Promise<KubernetesObject> {
    return invoke(`replace_${type.toLowerCase()}`, {
      context: context,
      namespace: namespace,
      name: name,
      object,
    }) as Promise<KubernetesObject>;
  }

  static async deletePod(
    context: string,
    namespace: string,
    name: string,
    gracePeriodSeconds = 0
  ): Promise<void> {
    return invoke("delete_pod", {
      context: context,
      namespace: namespace,
      name: name,
      gracePeriodSeconds: gracePeriodSeconds,
    });
  }

  static async getDeployments(
    context: string,
    namespace: string
  ): Promise<V1Deployment[]> {
    return invoke("list_deployments", {
      context: context,
      namespace: namespace,
    });
  }

  static async restartDeployment(
    context: string,
    namespace: string,
    name: string
  ): Promise<boolean> {
    return invoke("restart_deployment", {
      context: context,
      namespace: namespace,
      name: name,
    });
  }

  static async getJobs(context: string, namespace: string): Promise<V1Job[]> {
    return invoke("list_jobs", {
      context: context,
      namespace: namespace,
    });
  }

  static async getCronJobs(
    context: string,
    namespace: string
  ): Promise<V1CronJob[]> {
    return invoke("list_cronjobs", {
      context: context,
      namespace: namespace,
    });
  }

  static async getConfigMaps(
    context: string,
    namespace: string
  ): Promise<V1ConfigMap[]> {
    return invoke("list_configmaps", {
      context: context,
      namespace: namespace,
    });
  }

  static async getSecrets(
    context: string,
    namespace: string
  ): Promise<V1Secret[]> {
    return invoke("list_secrets", {
      context: context,
      namespace: namespace,
    });
  }

  static async getServices(
    context: string,
    namespace: string
  ): Promise<V1Service[]> {
    return invoke("list_services", {
      context: context,
      namespace: namespace,
    });
  }

  static async getVirtualServices(
    context: string,
    namespace: string
  ): Promise<VirtualService[]> {
    return invoke("list_virtual_services", {
      context: context,
      namespace: namespace,
    });
  }

  static async getIngresses(
    context: string,
    namespace: string
  ): Promise<V1Ingress[]> {
    return invoke("list_ingresses", {
      context: context,
      namespace: namespace,
    });
  }

  static async getPersistentVolumeClaims(
    context: string,
    namespace: string
  ): Promise<V1PersistentVolumeClaim[]> {
    return invoke("list_persistentvolumeclaims", {
      context: context,
      namespace: namespace,
    });
  }
}
