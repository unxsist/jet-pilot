<script setup lang="ts">
import ContextSwitcher from "./ContextSwitcher.vue";
import NavigationGroup from "./NavigationGroup.vue";
import NavigationItem from "./NavigationItem.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Kubernetes } from "@/services/Kubernetes";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { V1APIResource } from "@kubernetes/client-node";
import pluralize from "pluralize";

const { context } = injectStrict(KubeContextStateKey);

interface NavigationGroup {
  title: string;
  coreResourceKinds: string[];
  apiGroupResources: string[];
}

const navigationGroups: NavigationGroup[] = [
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
    coreResourceKinds: ["ServiceAccount", "Role", "RoleBinding"],
    apiGroupResources: [".*authorization.*"],
  },
];

const clusterResources = ref<Map<string, V1APIResource[]>>(new Map());

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

const fetchResources = () => {
  clusterResources.value.clear();
  Kubernetes.getCoreApiVersions(context.value).then((results) => {
    results.forEach((version) => {
      Kubernetes.getCoreApiResources(context.value, version).then(
        (resources) => {
          clusterResources.value.set(
            version,
            resources.filter((r) => r.namespaced)
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
              resources.filter((r) => r.namespaced)
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

onMounted(() => {
  fetchResources();
});

watch(context, () => {
  fetchResources();
});
</script>

<template>
  <div class="flex flex-col flex-shrink-0 relative min-w-[200px] max-w-[200px]">
    <div class="absolute w-full h-[40px]" data-tauri-drag-region></div>
    <div class="flex flex-col flex-grow min-h-screen max-h-screen p-2 pr-0">
      <ContextSwitcher class="mt-[30px]" />
      <div class="flex w-full flex-grow flex-shrink overflow-hidden">
        <ScrollArea class="w-full mt-0 mb-0">
          <NavigationGroup
            v-for="group in navigationGroups"
            :key="group.title"
            :title="group.title"
          >
            <NavigationItem
              icon="pods"
              :title="formatResourceKind(resource.kind)"
              v-for="resource in getCoreResourcesForGroup(group)"
              :key="resource.name"
              :to="{
                path: `/${resource.name}`,
                query: { resource: resource.name },
              }"
            />
            <NavigationItem
              icon="pods"
              :title="formatResourceKind(resource.kind)"
              v-for="resource in getApiResourcesForGroup(group)"
              :key="resource.name"
              :to="{
                path: `/${resource.name}`,
                query: { resource: resource.name },
              }"
            />
          </NavigationGroup>
          <NavigationGroup title="Other">
            <NavigationItem
              icon="pods"
              :title="formatResourceKind(resource.kind)"
              v-for="resource in getOtherResources()"
              :key="resource.name"
              :to="{
                path: `/${resource.name}`,
                query: { resource: resource.name },
              }"
            />
          </NavigationGroup>
        </ScrollArea>
      </div>
      <div class="flex-shrink-0 border-t -ml-2 pl-2 pt-2 mb-0">
        <NavigationItem
          icon="settings"
          title="Settings"
          :to="{ name: 'Settings' }"
        />
      </div>
    </div>
  </div>
</template>
