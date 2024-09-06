<script setup lang="ts">
import ContextSwitcher from "./ContextSwitcher.vue";
import PortForwardingManager from "./PortForwardingManager.vue";
import NavigationGroup from "./NavigationGroup.vue";
import NavigationItem from "./NavigationItem.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Kubernetes } from "@/services/Kubernetes";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { GlobalShortcutRegisterShortcutsKey } from "@/providers/GlobalShortcutProvider";
import { injectStrict } from "@/lib/utils";
import { V1APIResource } from "@kubernetes/client-node";
import pluralize from "pluralize";
import { type as getOsType } from "@tauri-apps/api/os";
import { getCurrent as getWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/api/process";
import CloseIcon from "@/assets/icons/close.svg";
import FullScreenIcon from "@/assets/icons/full_screen.svg";
import MinimizeIcon from "@/assets/icons/minimize.svg";

const targetOs = ref<string>("");
const {
  context,
  namespace,
  authenticated: clusterAuthenticated,
} = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const refreshShortcuts = injectStrict(GlobalShortcutRegisterShortcutsKey);

interface NavigationGroup {
  title: string;
  coreResourceKinds: string[];
  apiGroupResources: string[];
}

const navigationGroups: NavigationGroup[] = [
  {
    title: "Cluster",
    coreResourceKinds: ["Namespace", "Node", "CustomResourceDefinition"],
    apiGroupResources: [],
  },
  {
    title: "Workloads",
    coreResourceKinds: ["Pod"],
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
    coreResourceKinds: ["PersistentVolumeClaim"],
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

const clusterResources = ref<Map<string, V1APIResource[]>>(new Map());

const getResourceByName = (resource: string) => {
  return Array.from(clusterResources.value.values())
    .flat()
    .find((r) => r.name === resource);
};

const getCoreResourcesForGroup = (group: NavigationGroup) => {
  return Array.from(clusterResources.value.values())
    .flat()
    .filter((resource) => group.coreResourceKinds.includes(resource.kind))
    .filter((resource) => !resource.name.includes("/"));
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
    .filter((resource) => !resource.name.includes("/"));
};

const getOtherResources = () => {
  return Array.from(clusterResources.value.keys())
    .filter((key) => {
      return !navigationGroups.some((group) => {
        return group.apiGroupResources.some((group) => {
          return key.match(group);
        });
      });
    })
    .map((key) => clusterResources.value.get(key)!)
    .flat()
    .filter((resource) => !resource.name.includes("/"))
    .filter(
      (resource) =>
        !navigationGroups.some((group) => {
          return group.coreResourceKinds.includes(resource.kind);
        })
    )
    .filter(
      (resource, index, self) =>
        index ===
        self.findIndex(
          (t) => t.kind === resource.kind && t.name === resource.name
        )
    );
};

const formatResourceKind = (kind: string) => {
  return pluralize(kind);
};

const filterNamespaced = (resource: V1APIResource) => {
  if (namespace.value === "") {
    return true;
  }

  return resource.namespaced;
};

const fetchResources = () => {
  if (context.value === "") {
    return;
  }

  clusterResources.value.clear();
  Kubernetes.getCoreApiVersions(context.value).then((results) => {
    results.forEach((version) => {
      Kubernetes.getCoreApiResources(context.value, version).then(
        (resources) => {
          clusterResources.value.set(
            version,
            resources.filter(filterNamespaced)
          );
        }
      );
    });
  });

  Kubernetes.getApiGroups(context.value)
    .then((results) => {
      results.forEach((group) => {
        Kubernetes.getApiGroupResources(
          context.value,
          group.preferredVersion?.groupVersion ?? ""
        )
          .then((resources) => {
            clusterResources.value.set(
              group.name,
              resources.filter(filterNamespaced)
            );
          })
          .catch((error) => {
            console.error(error);
          });
      });
    })
    .catch((error) => {
      console.error(error);
    });
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

const quit = () => {
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

onMounted(() => {
  fetchResources();

  getOsType().then((os) => {
    targetOs.value = os;
  });
});

watch([context, namespace, clusterAuthenticated], () => {
  fetchResources();
});
</script>

<template>
  <div class="flex flex-col flex-shrink-0 relative min-w-[200px] max-w-[200px]">
    <div
      v-if="targetOs !== 'Darwin'"
      class="p-2 pb-0 -mb-1 space-x-2"
      data-tauri-drag-region
    >
      <Button size="xs" @click="quit">
        <CloseIcon class="h-3 text-white" />
      </Button>
      <Button size="xs" @click="maxOrUnmaximize">
        <FullScreenIcon class="h-3 text-white" />
      </Button>
      <Button size="xs" @click="minimize">
        <MinimizeIcon class="h-3 text-white" />
      </Button>
    </div>
    <div class="absolute w-full h-[40px]" v-else data-tauri-drag-region></div>
    <div class="flex flex-col flex-grow min-h-screen max-h-screen p-2 pr-0">
      <ContextSwitcher :class="{ 'mt-[30px]': targetOs === 'Darwin' }" />
      <PortForwardingManager />
      <div class="flex w-full flex-grow flex-shrink overflow-hidden">
        <ScrollArea class="w-full mt-0 mb-0">
          <div><!-- Empty div to fix width and truncation --></div>
          <NavigationGroup
            v-if="settings.pinnedResources.length > 0"
            title="Pinned"
          >
            <template v-for="(resource, index) in settings.pinnedResources">
              <NavigationItem
                v-if="getResourceByName(resource.name)"
                :key="resource.name"
                :icon="formatResourceKind(resource.kind).toLowerCase()"
                :pinned="true"
                :title="formatResourceKind(resource.kind)"
                :shortcut="index > 8 ? undefined : index + 1"
                :to="{
                  path: `/${resource.name}`,
                  query: { resource: resource.name },
                }"
                @unpinned="unpinResource(resource)"
              />
            </template>
          </NavigationGroup>
          <template v-for="group in navigationGroups" :key="group.title">
            <NavigationGroup
              :title="group.title"
              v-if="
                getCoreResourcesForGroup(group).length > 0 ||
                getApiResourcesForGroup(group).length > 0
              "
            >
              <template
                v-for="resource in getCoreResourcesForGroup(group)"
                :key="resource.name"
              >
                <NavigationItem
                  v-if="!isPinned(resource.name)"
                  :icon="formatResourceKind(resource.kind).toLowerCase()"
                  :title="formatResourceKind(resource.kind)"
                  :to="{
                    path: `/${resource.name}`,
                    query: { resource: resource.name },
                  }"
                  @pinned="pinResource(resource)"
                  @unpinned="unpinResource(resource)"
                />
              </template>
              <template
                v-for="resource in getApiResourcesForGroup(group)"
                :key="resource.name"
              >
                <NavigationItem
                  v-if="!isPinned(resource.name)"
                  :icon="formatResourceKind(resource.kind).toLowerCase()"
                  :title="formatResourceKind(resource.kind)"
                  :to="{
                    path: `/${resource.name}`,
                    query: { resource: resource.name },
                  }"
                  @pinned="pinResource(resource)"
                  @unpinned="unpinResource(resource)"
                />
              </template>
            </NavigationGroup>
          </template>
          <NavigationGroup title="Other">
            <template
              v-for="resource in getOtherResources()"
              :key="resource.name"
            >
              <NavigationItem
                v-if="!isPinned(resource.name)"
                :icon="formatResourceKind(resource.kind).toLowerCase()"
                :title="formatResourceKind(resource.kind)"
                :to="{
                  path: `/${resource.name}`,
                  query: { resource: resource.kind },
                }"
                @pinned="pinResource(resource)"
                @unpinned="unpinResource(resource)"
              />
            </template>
          </NavigationGroup>
        </ScrollArea>
      </div>
      <div
        navigation-settings
        class="flex-shrink-0 border-t -ml-2 pl-2 pt-2 mb-0"
      >
        <NavigationItem
          icon="settings"
          title="Settings"
          :can-pin="false"
          :to="{ name: 'Settings' }"
        />
      </div>
    </div>
  </div>
</template>
