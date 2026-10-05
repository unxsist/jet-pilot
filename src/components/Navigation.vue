<script setup lang="ts">
import ContextSwitcher from "./ContextSwitcher.vue";
import WorkspaceSwitcher from "./WorkspaceSwitcher.vue";
import PortForwardingManager from "./PortForwardingManager.vue";
import NavigationGroup from "./NavigationGroup.vue";
import NavigationItem from "./NavigationItem.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Kbd } from "@/components/ui/kbd";
import NavigationSkeleton from "@/components/skeletons/NavigationSkeleton.vue";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import {
  SettingsContextStateKey,
  SettingsContextFlushKey,
} from "@/providers/SettingsContextProvider";
import {
  GlobalShortcutRegisterShortcutsKey,
  PINNED_SHORTCUT_COUNT,
  resourceRoute,
} from "@/providers/GlobalShortcutProvider";
import { OpenCommandPaletteKey } from "@/providers/CommandPaletteProvider";
import { Minus, Search, Square, X } from "lucide-vue-next";
import { injectStrict } from "@/lib/utils";
import { useDiscovery, type DiscoveredResource } from "@/lib/discovery";
import { isSameContext } from "@/lib/contextKey";
import { onRecovered, report } from "@/lib/auth/center";
import { perfMark } from "@/lib/perf";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { getCurrentWebviewWindow as getWindow } from "@tauri-apps/api/webviewWindow";
import { exit } from "@tauri-apps/plugin-process";
import { formatResourceKind } from "@/lib/utils";
import { ref } from "vue";

const targetOs = ref<string>(getOsType());
const { context, kubeConfig } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const flushSettings = injectStrict(SettingsContextFlushKey);
const refreshShortcuts = injectStrict(GlobalShortcutRegisterShortcutsKey);
const openCommandPalette = injectStrict(OpenCommandPaletteKey);
const isMac = computed(() => targetOs.value === "macos");

const windowButtonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring focus-visible:ring-offset-sidebar";

interface NavigationGroup {
  title: string;
  coreResourceKinds: string[];
  apiGroupResources: string[];
}

/* App destinations above the resource groups. */
const appLinks = [
  { title: "Clusters", to: { name: "ClustersHub" }, icon: "clustershub" },
  { title: "Resource Graph", to: { name: "ClusterOverview" }, icon: "diagram" },
];

const navigationGroups: NavigationGroup[] = [
  {
    title: "Cluster",
    coreResourceKinds: [
      "Event",
      "Namespace",
      "Node",
      "CustomResourceDefinition",
    ],
    apiGroupResources: ["events.k8s.io*"],
  },
  {
    title: "Workloads",
    coreResourceKinds: ["Pod", "ReplicationController"],
    apiGroupResources: ["apps", "batch"],
  },
  {
    title: "Config",
    coreResourceKinds: ["ConfigMap", "ResourceQuota", "Secret"],
    apiGroupResources: [],
  },
  {
    title: "Network",
    coreResourceKinds: ["Endpoints", "Service"],
    apiGroupResources: ["networking.*"],
  },
  {
    title: "Storage",
    coreResourceKinds: ["PersistentVolume", "PersistentVolumeClaim"],
    apiGroupResources: ["storage.*"],
  },
  {
    title: "Scaling",
    coreResourceKinds: [],
    apiGroupResources: ["autoscaling.*"],
  },
  {
    title: "Policies",
    coreResourceKinds: ["LimitRange"],
    apiGroupResources: ["policy.*", "policies.*"],
  },
  {
    title: "Access Control",
    coreResourceKinds: [
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "ClusterRoleBinding",
      "ClusterRole",
    ],
    apiGroupResources: [".*authorization.*"],
  },
];

/*
 * API discovery of the primary context through the shared discovery
 * service: rendered straight from the (disk) cache, revalidated in the
 * background.
 */
const discovery = useDiscovery(context, kubeConfig);

const clusterResources = computed(
  () =>
    new Map<string, DiscoveredResource[]>(
      Object.entries(discovery.snapshot.value?.groups ?? {})
    )
);

/* Nothing to show yet: first discovery of this context is running. */
const discovering = computed(
  () =>
    clusterResources.value.size === 0 &&
    context.value !== "" &&
    discovery.status.value === "loading"
);

watch(
  () => clusterResources.value.size > 0,
  (ready) => ready && perfMark("nav:ready"),
  { immediate: true }
);

const getResourceByName = (resource: string) => {
  return Array.from(clusterResources.value.values())
    .flat()
    .find((r) => r.name === resource);
};

/*
 * Everyday kinds lead their group; legacy and plumbing kinds
 * (ReplicationControllers, Endpoints, LimitRanges, ...) sink to the end.
 * Everything else sorts alphabetically in between.
 */
const FIRST = [
  "Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob",
  "Service", "Ingress", "ConfigMap", "Secret", "PersistentVolumeClaim",
  "PersistentVolume", "StorageClass", "Event", "Namespace", "Node",
  "ServiceAccount", "Role", "RoleBinding", "ClusterRole",
];
const LAST = [
  "ReplicaSet", "ReplicationController", "Endpoints", "EndpointSlice",
  "IngressClass", "GatewayClass", "LimitRange", "CSIDriver", "CSINode",
  "CSIStorageCapacity", "VolumeAttachment", "CustomResourceDefinition",
];
const rank = (kind: string) => {
  const first = FIRST.indexOf(kind);
  if (first >= 0) return first;
  const last = LAST.indexOf(kind);
  return last >= 0 ? 200 + last : 100;
};
const byUsefulness = (a: DiscoveredResource, b: DiscoveredResource) =>
  rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind);

/* Top-level resources, one entry per kind, pinned ones left out. */
const visible = (resources: DiscoveredResource[]) => {
  const kinds = new Set<string>();
  return resources
    .filter((r) => !r.name.includes("/"))
    .filter((r) => !kinds.has(r.kind) && !!kinds.add(r.kind))
    .filter((r) => !isPinned(r.name))
    .sort(byUsefulness);
};

const matches = (key: string, patterns: string[]) =>
  patterns.some((pattern) => key.match(pattern));

const coreKinds = navigationGroups.flatMap((group) => group.coreResourceKinds);

const sections = computed(() => {
  const groups = [...clusterResources.value];
  const all = groups.flatMap(([, resources]) => resources);
  const builtIn = navigationGroups.map((group) => ({
    title: group.title,
    items: visible([
      ...all.filter((r) => group.coreResourceKinds.includes(r.kind)),
      ...groups
        .filter(([key]) => matches(key, group.apiGroupResources))
        .flatMap(([, resources]) => resources)
        .filter((r) => !coreKinds.includes(r.kind)),
    ]),
  }));
  /* Every other API group (CRDs, metrics, ...) gets a section of its own. */
  const other = groups
    .filter(
      ([key]) =>
        key !== "v1" &&
        key !== "apps" &&
        !navigationGroups.some((group) => matches(key, group.apiGroupResources))
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, resources]) => ({
      title: key,
      items: visible(resources.filter((r) => !coreKinds.includes(r.kind))),
    }));
  const filled = (list: typeof builtIn) => list.filter((s) => s.items.length);
  return { builtIn: filled(builtIn), other: filled(other) };
});

/* Route of a resource list. */
const listRoute = (resource: DiscoveredResource) => {
  const plural = formatResourceKind(resource.kind).toLowerCase();
  return { path: `/${plural}`, query: { resource: plural, kind: resource.kind } };
};

const maxOrUnmaximize = () => {
  const window = getWindow();

  window.isMaximized().then((maximized) => {
    if (maximized) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
};

const minimize = () => {
  const window = getWindow();
  window.minimize();
};

const quit = async () => {
  await flushSettings();
  exit(0);
};

const isPinned = (resource: string) => {
  return settings.value.pinnedResources.some((r) => r.name === resource);
};

const pinResource = async (resource: { name: string; kind: string }) => {
  settings.value.pinnedResources.push(resource);
  refreshShortcuts();
};

const unpinResource = (resource: { name: string; kind: string }) => {
  settings.value.pinnedResources = settings.value.pinnedResources.filter(
    (r) => r.name !== resource.name
  );
  refreshShortcuts();
};

/*
 * Discovery failing because the cluster needs a sign-in goes to the auth
 * center; once signed in, discover again.
 */
watch(discovery.error, (message) => {
  if (message && context.value) {
    report({ context: context.value, kubeConfig: kubeConfig.value }, message, "api");
  }
});
const stopRecovered = onRecovered("*", (target) => {
  if (isSameContext(target, { context: context.value, kubeConfig: kubeConfig.value })) {
    discovery.refresh();
  }
});
onUnmounted(stopRecovered);
</script>

<template>
  <nav
    aria-label="Main navigation"
    class="relative flex w-[224px] min-w-[224px] max-w-[224px] shrink-0 flex-col"
  >
    <!-- Title bar: window controls on Windows / Linux, traffic lights space on macOS -->
    <div
      v-if="!isMac"
      class="flex h-10 shrink-0 items-center justify-between pl-4 pr-2"
      data-tauri-drag-region
    >
      <span
        class="text-xs font-semibold tracking-tight text-muted-foreground"
        data-tauri-drag-region
        >JET Pilot</span
      >
      <!-- Windows / Linux order: minimize, maximize, close -->
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          :class="windowButtonClass"
          aria-label="Minimize window"
          title="Minimize"
          @click="minimize"
        >
          <Minus class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          :class="windowButtonClass"
          aria-label="Maximize or restore window"
          title="Maximize / restore"
          @click="maxOrUnmaximize"
        >
          <Square class="h-3 w-3" />
        </button>
        <button
          type="button"
          :class="[
            windowButtonClass,
            'hover:bg-destructive/15 hover:text-destructive',
          ]"
          aria-label="Quit JET Pilot"
          title="Quit"
          @click="quit"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <div v-else class="h-10 shrink-0" data-tauri-drag-region></div>

    <div class="flex min-h-0 flex-1 flex-col">
      <div class="space-y-1.5 px-2 pb-3">
        <ContextSwitcher />
        <WorkspaceSwitcher />
        <button
          type="button"
          class="flex h-8 w-full items-center gap-2 rounded-md border bg-background/60 px-2.5 text-sm text-muted-foreground shadow-xs transition-colors duration-fast ease-out hover:border-border-strong hover:bg-background hover:text-foreground focus-ring focus-visible:ring-offset-sidebar"
          :aria-keyshortcuts="isMac ? 'Meta+K' : 'Control+K'"
          @click="openCommandPalette()"
        >
          <Search class="h-3.5 w-3.5 shrink-0" />
          <span class="flex-1 truncate text-left">Search or run…</span>
          <Kbd :keys="isMac ? ['⌘', 'K'] : ['Ctrl', 'K']" size="sm" />
        </button>
      </div>
      <div class="flex min-h-0 w-full flex-1 overflow-hidden">
        <ScrollArea class="w-full">
          <NavigationSkeleton v-if="discovering" />
          <div v-else class="px-2 pb-2">
            <div class="mb-4 space-y-px">
              <NavigationItem
                v-for="link in appLinks"
                :key="link.title"
                :icon="link.icon"
                :title="link.title"
                :to="link.to"
                :can-pin="false"
              />
            </div>
            <NavigationGroup
              v-if="
                settings.pinnedResources.some((resource) =>
                  getResourceByName(resource.name)
                )
              "
              title="Pinned"
            >
              <template v-for="(resource, index) in settings.pinnedResources">
                <NavigationItem
                  v-if="getResourceByName(resource.name)"
                  :key="`pin-${resource.name}`"
                  :icon="formatResourceKind(resource.kind).toLowerCase()"
                  :pinned="true"
                  :title="formatResourceKind(resource.kind)"
                  :shortcut="
                    index < PINNED_SHORTCUT_COUNT ? index + 1 : undefined
                  "
                  :to="resourceRoute(resource.kind)"
                  @unpinned="unpinResource(resource)"
                />
              </template>
            </NavigationGroup>
            <NavigationGroup
              v-for="section in sections.builtIn"
              :key="section.title"
              :title="section.title"
            >
              <NavigationItem
                v-for="resource in section.items"
                :key="resource.name"
                :icon="formatResourceKind(resource.kind).toLowerCase()"
                :title="formatResourceKind(resource.kind)"
                :to="listRoute(resource)"
                @pinned="pinResource(resource)"
              />
            </NavigationGroup>
            <NavigationGroup title="Helm">
              <NavigationItem
                icon="helm"
                title="Charts"
                custom-command-title="Helm Charts"
                :to="{
                  path: '/helm-charts',
                  query: { resource: 'chart', kind: 'Chart' },
                }"
                :can-pin="false"
              />
              <NavigationItem
                icon="helm"
                title="Releases"
                custom-command-title="Helm Releases"
                :to="{
                  path: '/helm-releases',
                  query: { resource: 'release', kind: 'Release' },
                }"
                :can-pin="false"
              />
            </NavigationGroup>
            <NavigationGroup
              v-for="section in sections.other"
              :key="section.title"
              :title="section.title"
            >
              <NavigationItem
                v-for="resource in section.items"
                :key="resource.name"
                :icon="formatResourceKind(resource.kind).toLowerCase()"
                :title="formatResourceKind(resource.kind)"
                :to="listRoute(resource)"
                @pinned="pinResource(resource)"
              />
            </NavigationGroup>
          </div>
        </ScrollArea>
      </div>
      <!-- Footer: live port forwards, settings -->
      <div class="shrink-0 space-y-px border-t border-border-subtle p-2">
        <PortForwardingManager />
        <NavigationItem
          icon="settings"
          title="Settings"
          :can-pin="false"
          :to="{ name: 'Settings' }"
        />
      </div>
    </div>
  </nav>
</template>
