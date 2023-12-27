<script setup lang="ts">
import ContextSwitcher from "./ContextSwitcher.vue";
import NavigationGroup from "./NavigationGroup.vue";
import NavigationItem from "./NavigationItem.vue";
</script>

<template>
  <div class="flex-shrink-0 relative min-w-[200px] max-w-[200px]">
    <div class="block w-full h-[20px]" data-tauri-drag-region></div>
    <div class="flex flex-col p-2 pr-0">
      <ContextSwitcher />
      <NavigationGroup title="Workloads">
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
    </div>
  </div>
</template>
