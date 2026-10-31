/*
 * Desktop integration (src-tauri/src/deep_link.rs, src-tauri/src/connection):
 * - ?link=<jetpilot:// url> is handed over like the link the app was
 *   started with;
 * - per-cluster connections: the settings the frontend pushes, and the
 *   tunnel states of the hub fixtures' jump hosts (dev/harness/clusters.ts).
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* What each fixture bastion is doing. */
const TUNNELS: Record<string, unknown> = {
  "bastion.example.com": { state: "connected", since: Date.now() - 42 * 60_000 },
  "bastion-dr.example.com": { state: "failed", error: "SSH asked for a password; add your key to ssh-agent" },
};

/* A proxy-url in the kubeconfig itself (no setting in JET Pilot). */
const KUBECONFIG_PROXIES: Record<string, string> = {
  "gke_acme-prod_europe-west4_checkout": "proxy.acme.internal:3128",
};

interface Entry {
  kubeConfig: string;
  context: string;
  connection: { mode: "proxy"; url: string } | { mode: "ssh"; host: string };
}

const proxyHost = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
};

export function createDesktopMocks(params: URLSearchParams) {
  const link = params.get("link");
  const pending = link ? [link] : [];
  let entries: Entry[] = [];

  const status = (context: string, kubeConfig: string | null) => {
    const entry =
      entries.find((e) => e.context === context && e.kubeConfig === (kubeConfig ?? "")) ??
      entries.find((e) => e.context === context && e.kubeConfig === "");
    if (!entry) return { mode: "direct", kubeconfigProxy: KUBECONFIG_PROXIES[context] ?? null };
    if (entry.connection.mode === "proxy") return { mode: "proxy", via: proxyHost(entry.connection.url) };
    const host = entry.connection.host.split("@").pop()!;
    return { mode: "ssh", via: host, tunnel: TUNNELS[host] ?? null };
  };

  type Payload = { context: string; kubeConfig: string | null; entries?: Entry[]; args?: string[] };
  const handlers: Record<string, (p: Payload) => unknown> = {
    deep_link_ready: () => pending.splice(0),
    cluster_connections_set: (p) => {
      entries = p.entries ?? [];
      return null;
    },
    cluster_connections_active: () => null,
    cluster_connection_status: (p) => status(p.context, p.kubeConfig),
    cluster_connection_connect: async (p) => {
      await sleep(700);
      const tunnel = status(p.context, p.kubeConfig).tunnel as { error?: string } | null;
      if (tunnel?.error) throw tunnel.error;
      return null;
    },
    cluster_cli_args: (p) => p.args,
  };
  return { handlers };
}
