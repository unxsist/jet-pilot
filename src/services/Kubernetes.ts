import {
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

export interface KubernetesError {
  message: string;
  code: number;
  reason: string;
  details: any;
}

export class Kubernetes {
  static async getCurrentContext(): Promise<string> {
    return invoke("get_current_context", {});
  }

  static async getContexts(): Promise<string[]> {
    return invoke("list_contexts", {});
  }

  static async getNamespaces(context: string): Promise<V1Namespace[]> {
    return invoke("list_namespaces", { context: context });
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

  static async getDeployments(
    context: string,
    namespace: string
  ): Promise<V1Deployment[]> {
    return invoke("list_deployments", {
      context: context,
      namespace: namespace,
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
