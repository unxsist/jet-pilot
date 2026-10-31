<script setup lang="ts">
/*
 * Opens jetpilot:// links (src/lib/deepLink.ts) handed over by the backend:
 * the one the app was started with, and every later one (the window is
 * brought to the front first). A link only navigates: it activates its
 * cluster when needed (a cluster JET Pilot already knows), goes to the
 * list, and opens the object in the side panel. Anything it can't find is
 * a calm notice. Also "Copy link to this view" in the palette. Mounted
 * once in App.vue.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useRoute, useRouter } from "vue-router";
import { toast } from "@/components/ui/toast";
import { parseLink, matchContext, type DeepLink, type KnownContext } from "@/lib/deepLink";
import { homePath } from "@/lib/kubeconfigSources";
import { inventory, loadInventory } from "@/lib/clusters/inventory";
import { resolveClusterNow } from "@/lib/clusters/useClusters";
import { flattenResources, getDiscoveryService, type DiscoveredResource } from "@/lib/discovery";
import { fetchRef, openInPanel } from "@/lib/resources/open";
import { formatResourceKind, injectStrict } from "@/lib/utils";
import { warn } from "@/lib/logger";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  KubeContextIsContextActiveKey,
  KubeContextIsNamespaceActiveKey,
  KubeContextSetActiveNamespacesKey,
  KubeContextStateKey,
} from "@/providers/KubeContextProvider";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { RegisterCommandStateKey } from "@/providers/CommandPaletteProvider";

const router = useRouter();
const route = useRoute();
const { settings } = injectStrict(SettingsContextStateKey);
const { contexts, context: primaryContext, kubeConfig: primaryKubeConfig, namespace: primaryNamespace } =
  injectStrict(KubeContextStateKey);
const isContextActive = injectStrict(KubeContextIsContextActiveKey);
const isNamespaceActive = injectStrict(KubeContextIsNamespaceActiveKey);
const setActiveNamespaces = injectStrict(KubeContextSetActiveNamespacesKey);
const setSidePanel = injectStrict(PanelProviderSetSidePanelComponentKey);

const notice = (title: string, description?: string) => toast({ title, description, variant: "info" });
const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

/* The cluster stays as the user set it up; only its namespace becomes visible. */
function activate(target: KnownContext, namespace?: string) {
  if (!isContextActive(target.context, target.kubeConfig)) {
    setActiveNamespaces(target.context, target.kubeConfig, [namespace ?? "all"]);
  } else if (namespace && !isNamespaceActive(target.context, namespace, target.kubeConfig)) {
    setActiveNamespaces(target.context, target.kubeConfig, [...(contexts.value.get(target.context) ?? []), namespace]);
  }
}

/* Route of a resource list, like the sidebar's (`plural.group` where another group has the plural). */
async function listRoute(resource: DiscoveredResource, all: DiscoveredResource[]) {
  const { listResourceName } = await import("@/lib/apiGroups");
  const plural = formatResourceKind(resource.kind).toLowerCase();
  const name = listResourceName(resource, all, plural);
  return { path: `/${name}`, query: { resource: name, kind: resource.kind } };
}

/* The served resource of a kind (in the link's API group when it has one). */
async function servedKind(target: KnownContext, kind: string, apiVersion?: string) {
  const snapshot = await getDiscoveryService().load(target.context, target.kubeConfig);
  const all = flattenResources(snapshot);
  const group = apiVersion?.includes("/") ? apiVersion.split("/")[0] : apiVersion ? "" : undefined;
  const resource = all.find((r) => r.kind === kind && (group === undefined || r.group === group));
  return { resource, all };
}

/* Navigating closes the side panel: open it once the new view is in. */
async function go(route: Parameters<typeof router.push>[0]) {
  await router.push(route);
  await nextTick();
}

async function knownContexts(): Promise<KnownContext[]> {
  const entries = inventory.value ?? (await loadInventory(settings.value));
  return entries.map((entry) => ({ context: entry.context, kubeConfig: entry.kubeConfig }));
}

async function openHealth(tab?: string) {
  const resolved = router.resolve("/health");
  if (resolved.name === "GenericResource") {
    notice("Health isn't in this version of JET Pilot", "Update JET Pilot to open this link.");
    return;
  }
  await go({ path: "/health", query: tab ? { tab } : {} });
}

async function openInCluster(link: Exclude<DeepLink, { type: "health" }>, target: KnownContext) {
  const cluster = resolveClusterNow(target.context, target.kubeConfig).displayName;

  if (link.type === "helm") {
    const [{ listReleases }, { releaseRow }, { openHelmReleasePanel }] = await Promise.all([
      import("@/lib/helmApi"),
      import("@/lib/helm"),
      import("@/views/helm/panel"),
    ]);
    const releases = await listReleases(target, [link.namespace]);
    const release = releases.find((r) => r.name === link.name && r.namespace === link.namespace);
    if (!release) {
      notice(`${link.name} isn't in ${cluster}`, `No Helm release of that name in ${link.namespace} (anymore).`);
      return;
    }
    activate(target, link.namespace);
    await go({ path: "/helm-releases", query: { resource: "release", kind: "Release" } });
    openHelmReleasePanel(setSidePanel, releaseRow(release, target.context, target.kubeConfig));
    return;
  }

  const { resource, all } = await servedKind(target, link.kind, link.apiVersion);
  if (!resource) {
    notice(`${cluster} has no ${formatResourceKind(link.kind)}`, "The cluster doesn't serve this kind (or not anymore).");
    return;
  }

  if (link.type === "list") {
    activate(target, resource.namespaced ? link.namespace : undefined);
    await go(await listRoute(resource, all));
    return;
  }

  const namespace = resource.namespaced ? link.namespace : undefined;
  const object = await fetchRef(target, {
    kind: link.kind,
    apiVersion: link.apiVersion,
    namespace,
    name: link.name,
  });
  if (!object) {
    notice(
      `${link.name} isn't in ${cluster}`,
      namespace ? `No ${link.kind} of that name in ${namespace} (anymore).` : `No ${link.kind} of that name (anymore).`
    );
    return;
  }
  activate(target, namespace);
  await go(await listRoute(resource, all));
  openInPanel(setSidePanel, null, object);
}

async function open(url: string) {
  const parsed = parseLink(url);
  if (!parsed.ok) {
    notice("Couldn't open the link", parsed.reason);
    return;
  }
  const link = parsed.link;
  if (link.type === "health") return openHealth(link.tab);

  const target = matchContext(link, await knownContexts(), await homePath());
  if (!target) {
    notice(`${link.context} isn't in JET Pilot`, "Add the cluster, then open the link again.");
    return;
  }
  try {
    await openInCluster(link, target);
  } catch (e) {
    warn(`Opening ${url} failed: ${message(e)}`);
    notice(`Couldn't open the link`, message(e));
  }
}

/*
 * The link to what's on screen: a resource list (the primary cluster, and
 * its namespace when one is selected) or a Health tab.
 */
async function copyViewLink() {
  const { copyLink } = await import("@/lib/deepLinkCopy");
  if (route.path === "/health") {
    const tab = typeof route.query.tab === "string" ? route.query.tab : undefined;
    await copyLink({ type: "health", tab }, "Health");
    return;
  }
  const kind = typeof route.query.kind === "string" ? route.query.kind : "";
  const listed = typeof route.query.resource === "string" ? route.query.resource : "";
  if (!kind || !listed || kind === "Release" || !primaryContext.value) {
    notice("This view has no link", "Links open objects, resource lists, Helm releases and Health.");
    return;
  }
  const target = { context: primaryContext.value, kubeConfig: primaryKubeConfig.value };
  // `plural.group` names the group; else the kind's usual one.
  const group = listed.includes(".") ? listed.slice(listed.indexOf(".") + 1) : undefined;
  const all = flattenResources(await getDiscoveryService().load(target.context, target.kubeConfig).catch(() => null));
  const served = all.find((r) => r.kind === kind && (group === undefined || r.group === group));
  const namespace = primaryNamespace.value && primaryNamespace.value !== "all" ? primaryNamespace.value : undefined;
  await copyLink(
    {
      type: "list",
      context: target.context,
      kubeConfig: target.kubeConfig || undefined,
      kind,
      apiVersion: served ? (served.group ? `${served.group}/${served.version}` : served.version) : undefined,
      namespace: served?.namespaced === false ? undefined : namespace,
    },
    `${formatResourceKind(kind)} in ${resolveClusterNow(target.context, target.kubeConfig).displayName}`
  );
}

injectStrict(RegisterCommandStateKey)({
  id: "copy-view-link",
  name: "Copy link to this view",
  description: "A jetpilot:// link to this list or Health tab, for chat or a runbook",
  keywords: ["link", "share", "url", "deep link", "copy"],
  execute: () => void copyViewLink(),
});

/* One at a time, in order (a burst of clicks while starting). */
let queue = Promise.resolve();
const enqueue = (urls: string[]) => {
  for (const url of urls) queue = queue.then(() => open(url));
};

let unlisten: UnlistenFn | undefined;
onMounted(async () => {
  try {
    unlisten = await listen<string[]>("deep-link://open", (event) => enqueue(event.payload));
    enqueue(await invoke<string[]>("deep_link_ready"));
  } catch {
    /* no event bridge (unit tests) */
  }
});
onBeforeUnmount(() => unlisten?.());
</script>

<template>
  <slot />
</template>
