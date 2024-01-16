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
  coreResources: string[];
  apiGroupResources: string[];
}

const navigationGroups: NavigationGroup[] = [
  {
    title: "Workloads",
    coreResources: ["pods"],
    apiGroupResources: ["apps", "batch"],
  },
  {
    title: "Config",
    coreResources: ["configmaps", "resourcequotas", "secrets"],
    apiGroupResources: [""],
  },
  {
    title: "Network",
    coreResources: ["endpoints", "services", "endpointslices"],
    apiGroupResources: ["networking.k8s.io"],
  },
  {
    title: "Storage",
    coreResources: ["persistentvolumeclaims"],
    apiGroupResources: ["storage.k8s.io"],
  },
  {
    title: "Scaling",
    coreResources: [],
    apiGroupResources: ["autoscaling"],
  },
  {
    title: "Policies",
    coreResources: ["poddisruptionbudgets", "limitranges"],
    apiGroupResources: [],
  },
  {
    title: "Access Control",
    coreResources: ["serviceaccounts"],
    apiGroupResources: ["rbac.authorization.k8s.io"],
  },
];

const clusterResources = ref<Map<string, V1APIResource[]>>(new Map());

const getCoreResourcesForGroup = (group: NavigationGroup) => {
  return Array.from(clusterResources.value.values())
    .flat()
    .filter((resource) => group.coreResources.includes(resource.name));
};

const getApiResourcesForGroup = (group: NavigationGroup) => {
  return Array.from(clusterResources.value.keys())
    .filter((key) => group.apiGroupResources.includes(key))
    .map((key) => clusterResources.value.get(key)!)
    .flat()
    .filter((resource) => resource.singularName !== "");
};

const formatResourceKind = (kind: string) => {
  return pluralize(kind);
};

onMounted(() => {
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
});
</script>

<template>
  <div class="flex flex-col flex-shrink-0 relative min-w-[200px] max-w-[200px]">
    <div class="absolute w-full h-[40px]" data-tauri-drag-region></div>
    <div class="flex flex-col flex-grow min-h-screen max-h-screen p-2 pr-0">
      <ContextSwitcher class="mt-[30px]" />
      <div class="flex w-full flex-grow flex-shrink overflow-hidden">
        <ScrollArea class="w-full mt-0 mb-0">
          <!-- <NavigationGroup title="Workloads">
            <NavigationItem icon="pods" title="Pods" :to="{ name: 'Pods' }" />
            <NavigationItem
              icon="deployments"
              title="Deployments"
              :to="{ name: 'Deployments' }"
            />
            <NavigationItem icon="jobs" title="Jobs" :to="{ name: 'Jobs' }" />
            <NavigationItem
              icon="cronjobs"
              title="Cron Jobs"
              :to="{ name: 'CronJobs' }"
            />
          </NavigationGroup>
          <NavigationGroup title="Configuration">
            <NavigationItem
              icon="configmaps"
              title="Config Maps"
              :to="{ name: 'ConfigMaps' }"
            />
            <NavigationItem
              icon="secrets"
              title="Secrets"
              :to="{ name: 'Secrets' }"
            />
          </NavigationGroup>
          <NavigationGroup title="Network">
            <NavigationItem
              icon="services"
              title="Services"
              :to="{ name: 'Services' }"
            />
            <NavigationItem
              icon="virtualservices"
              title="Virtual Services"
              :to="{ name: 'VirtualServices' }"
            />
            <NavigationItem
              icon="ingresses"
              title="Ingresses"
              :to="{ name: 'Ingresses' }"
            />
          </NavigationGroup>
          <NavigationGroup title="Storage">
            <NavigationItem
              icon="persistentvolumeclaims"
              title="Persistent Volume Claims"
              :to="{ name: 'PersistentVolumeClaims' }"
            />
          </NavigationGroup>
          <NavigationGroup title="Custom Resources"> </NavigationGroup> -->
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
