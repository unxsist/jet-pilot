/*
 * Command-line tools JET Pilot uses (Settings › Advanced › Command-line
 * tools): detection and managed downloads run in src-tauri/src/tools.rs;
 * what each tool is for and how to install it lives here.
 */
import { Channel, invoke } from "@tauri-apps/api/core";

export type ToolId =
  | "kubectl"
  | "helm"
  | "aws"
  | "gcloud"
  | "az"
  | "kubelogin"
  | "gke-gcloud-auth-plugin"
  | "doctl";

/** `tools_detect` (src-tauri). */
export interface ToolStatus {
  id: ToolId;
  name: string;
  found: boolean;
  path?: string | null;
  version?: string | null;
  /** "managed": downloaded by JET Pilot (~/.kube/jet-pilot/bin). */
  source: "path" | "managed" | "missing";
  /** JET Pilot can download it. */
  installable: boolean;
  /** Version a download installs. */
  installVersion?: string | null;
  problem?: string | null;
}

export type DownloadEvent =
  | { type: "started"; url: string; version: string }
  | { type: "progress"; received: number; total?: number | null }
  | { type: "verifying" }
  | { type: "done"; path: string }
  | { type: "failed"; message: string };

export interface ToolInfo {
  /** What JET Pilot uses it for. */
  purpose: string;
  /** Needed for every cluster (not just some providers). */
  essential?: boolean;
  url: string;
  install?: { macos?: string; linux?: string; windows?: string };
}

export const TOOL_INFO: Record<ToolId, ToolInfo> = {
  kubectl: {
    purpose: "Shells, logs, port forwards, applying YAML and most actions",
    essential: true,
    url: "https://kubernetes.io/docs/tasks/tools/",
    install: {
      macos: "brew install kubectl",
      windows: "winget install -e --id Kubernetes.kubectl",
    },
  },
  helm: {
    purpose: "Helm releases, upgrades and rollbacks",
    url: "https://helm.sh/docs/intro/install/",
    install: { macos: "brew install helm", windows: "winget install -e --id Helm.Helm" },
  },
  aws: {
    purpose: "Signing in to Amazon EKS clusters",
    url: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
    install: { macos: "brew install awscli", windows: "winget install -e --id Amazon.AWSCLI" },
  },
  gcloud: {
    purpose: "Google Kubernetes Engine clusters",
    url: "https://cloud.google.com/sdk/docs/install",
    install: {
      macos: "brew install --cask google-cloud-sdk",
      windows: "winget install -e --id Google.CloudSDK",
    },
  },
  "gke-gcloud-auth-plugin": {
    purpose: "Signing in to GKE clusters",
    url: "https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin",
    install: {
      macos: "gcloud components install gke-gcloud-auth-plugin",
      linux: "gcloud components install gke-gcloud-auth-plugin",
      windows: "gcloud components install gke-gcloud-auth-plugin",
    },
  },
  az: {
    purpose: "Azure Kubernetes Service clusters",
    url: "https://learn.microsoft.com/cli/azure/install-azure-cli",
    install: { macos: "brew install azure-cli", windows: "winget install -e --id Microsoft.AzureCLI" },
  },
  kubelogin: {
    purpose: "Microsoft Entra ID sign-in for AKS clusters",
    url: "https://azure.github.io/kubelogin/install.html",
    install: {
      macos: "brew install Azure/kubelogin/kubelogin",
      windows: "winget install -e --id Microsoft.Azure.Kubelogin",
    },
  },
  doctl: {
    purpose: "DigitalOcean Kubernetes clusters",
    url: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
    install: { macos: "brew install doctl" },
  },
};

export function detectTools(force = false): Promise<ToolStatus[]> {
  return invoke<ToolStatus[]>("tools_detect", { force });
}

export function installTool(
  tool: ToolId,
  onEvent: (event: DownloadEvent) => void,
  version?: string
): Promise<ToolStatus> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  return invoke<ToolStatus>("tools_install", { tool, version: version ?? null, onEvent: channel });
}

export function uninstallTool(tool: ToolId): Promise<void> {
  return invoke("tools_uninstall", { tool });
}

export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
