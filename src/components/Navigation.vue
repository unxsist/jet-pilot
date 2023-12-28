<script setup lang="ts">
import ContextSwitcher from "./ContextSwitcher.vue";
import NavigationGroup from "./NavigationGroup.vue";
import NavigationItem from "./NavigationItem.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
</script>

<template>
  <div class="flex flex-col flex-shrink-0 relative min-w-[200px] max-w-[200px]">
    <div class="absolute w-full h-[40px]" data-tauri-drag-region></div>
    <div class="flex flex-col flex-grow min-h-screen max-h-screen p-2 pr-0">
      <ContextSwitcher class="mt-[30px]" />
      <div class="flex w-full flex-grow flex-shrink overflow-hidden">
        <ScrollArea class="w-full mt-0 mb-0">
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
