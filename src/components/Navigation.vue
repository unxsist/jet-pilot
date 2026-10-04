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
import { perfMark } from "@/lib/perf";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { getCurrentWebviewWindow as getWindow } from "@tauri-apps/api/webviewWindow";
import { exit } from "@tauri-apps/plugin-process";
import { formatResourceKind } from "@/lib/utils";
import { ref } from "vue";
import { RouteLocationRaw } from "vue-router";

const targetOs = ref<string>(getOsType());
const {
  context,
  kubeConfig,
  authenticated: clusterAuthenticated,
} = injectStrict(KubeContextStateKey);
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
  customLinks?: { title: string; to: RouteLocationRaw; icon: string }[];
}

const navigationGroups: NavigationGroup[] = [
  {
    title: "",
    coreResourceKinds: [],
    apiGroupResources: [],
    customLinks: [
      {
        title: "Resource Graph",
        to: {
          name: "ClusterOverview",
        },
        icon: "diagram",
      },
    ],
  },
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

const getCoreResourcesForGroup = (group: NavigationGroup) => {
  return Array.from(clusterResources.value.values())
    .flat()
    .filter((resource) => group.coreResourceKinds.includes(resource.kind))
    .filter((resource) => !resource.name.includes("/"))
    .filter(
      (resource, index, self) =>
        index ===
        self.findIndex(
          (t) => t.kind === resource.kind && t.name === resource.name
        )
    );
};

const getApiResourcesForGroup = (group: NavigationGroup) => {
  return Array.from(clusterResources.value.keys())
    .filter((key) => {
      return group.apiGroupResources.some((group) => {
        return key.match(group);
      });
    })
    .map((key) => clusterResources.value.get(key)!)
    .flat()
    .filter((resource) => !group.coreResourceKinds.includes(resource.kind))
    .filter((resource) => !resource.name.includes("/"))
    .sort((a, b) => a.kind.localeCompare(b.kind));
};

const getApiResourcesForNonDefaultGroup = (group: string) => {
  return (
    clusterResources.value
      .get(group)
      ?.filter((resource) => !resource.name.includes("/"))
      .sort((a, b) => a.kind.localeCompare(b.kind)) ?? []
  );
};

const getNonDefaultApiGroups = () => {
  return Array.from(clusterResources.value.keys())
    .filter((key) => {
      return (
        !navigationGroups.some((group) => {
          return group.apiGroupResources.some((group) => {
            return key.match(group);
          });
        }) &&
        key !== "v1" &&
        key !== "apps"
      );
    })
    .sort((a, b) => a.localeCompare(b));
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

// Re-discover after a successful re-authentication.
watch(clusterAuthenticated, (authenticated, wasAuthenticated) => {
  if (authenticated && !wasAuthenticated) {
    discovery.refresh();
  }
});
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
          class="group flex h-8 w-full items-center gap-2 rounded-md border bg-background/60 px-2.5 text-sm text-muted-foreground shadow-xs transition-colors duration-fast ease-out hover:border-border-strong hover:bg-background hover:text-foreground focus-ring focus-visible:ring-offset-sidebar"
          :aria-keyshortcuts="isMac ? 'Meta+K' : 'Control+K'"
          @click="openCommandPalette()"
        >
          <Search class="h-3.5 w-3.5 shrink-0" />
          <span class="flex-1 truncate text-left">Search or run…</span>
          <Kbd :keys="isMac ? ['⌘', 'K'] : ['Ctrl', 'K']" size="sm" />
        </button>
        <PortForwardingManager />
      </div>
      <div class="flex min-h-0 w-full flex-1 overflow-hidden">
        <ScrollArea class="w-full">
          <NavigationSkeleton v-if="discovering" />
          <div v-else class="px-2 pb-2">
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
            <template v-for="(group, index) in navigationGroups" :key="index">
              <NavigationGroup
                :key="index"
                :title="group.title"
                v-if="
                  getCoreResourcesForGroup(group).length > 0 ||
                  getApiResourcesForGroup(group).length > 0 ||
                  (group.customLinks && group.customLinks.length > 0)
                "
              >
                <template v-for="link in group.customLinks" :key="link.title">
                  <NavigationItem
                    :icon="link.icon"
                    :title="link.title"
                    :to="link.to"
                    :can-pin="false"
                  />
                </template>
                <template
                  v-for="resource in getCoreResourcesForGroup(group)"
                  :key="`core-${resource.name}`"
                >
                  <NavigationItem
                    v-if="!isPinned(resource.name)"
                    :icon="formatResourceKind(resource.kind).toLowerCase()"
                    :title="formatResourceKind(resource.kind)"
                    :to="{
                      path: `/${formatResourceKind(resource.kind).toLowerCase()}`,
                      query: {
                        resource: formatResourceKind(resource.kind).toLowerCase(),
                        kind: resource.kind,
                      },
                    }"
                    @pinned="pinResource(resource)"
                    @unpinned="unpinResource(resource)"
                  />
                </template>
                <template
                  v-for="resource in getApiResourcesForGroup(group)"
                  :key="`api-${resource.name}`"
                >
                  <NavigationItem
                    v-if="!isPinned(resource.name)"
                    :icon="formatResourceKind(resource.kind).toLowerCase()"
                    :title="formatResourceKind(resource.kind)"
                    :to="{
                      path: `/${formatResourceKind(resource.kind).toLowerCase()}`,
                      query: {
                        resource: formatResourceKind(resource.kind).toLowerCase(),
                        kind: resource.kind,
                      },
                    }"
                    @pinned="pinResource(resource)"
                    @unpinned="unpinResource(resource)"
                  />
                </template>
              </NavigationGroup>
            </template>
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
            <template
              v-for="nonDefaultApiGroup in getNonDefaultApiGroups()"
              :key="`non-default-group-${nonDefaultApiGroup}`"
            >
              <NavigationGroup
                :title="nonDefaultApiGroup"
                v-if="
                  getApiResourcesForNonDefaultGroup(nonDefaultApiGroup).length >
                  0
                "
              >
                <template
                  v-for="resource in getApiResourcesForNonDefaultGroup(
                    nonDefaultApiGroup
                  )"
                  :key="`non-default-${resource.name}`"
                >
                  <NavigationItem
                    v-if="!isPinned(resource.name)"
                    :icon="formatResourceKind(resource.kind).toLowerCase()"
                    :title="formatResourceKind(resource.kind)"
                    :to="{
                      path: `/${formatResourceKind(resource.kind).toLowerCase()}`,
                      query: {
                        resource: formatResourceKind(resource.kind).toLowerCase(),
                        kind: resource.kind,
                      },
                    }"
                    @pinned="pinResource(resource)"
                    @unpinned="unpinResource(resource)"
                  />
                </template>
              </NavigationGroup>
            </template>
          </div>
        </ScrollArea>
      </div>
      <div
        navigation-settings
        class="shrink-0 border-t border-border-subtle px-2 pb-2 pt-2"
      >
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
