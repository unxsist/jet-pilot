<script setup lang="ts">
/* Settings › Clusters › Cluster details: they live in the Clusters hub. */
import { useRouter } from "vue-router";
import { ArrowRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsRow } from "@/components/settings/styles";

const router = useRouter();
</script>

<template>
  <SettingsSection
    title="Cluster details"
    description="Names, colours, environments, guardrails, folders, tags and namespaces per cluster"
  >
    <div :class="settingsRow">
      <p class="text-xs text-muted-foreground">
        Give clusters a recognisable name and colour, mark production clusters as protected or read-only, and
        group them in folders. All of it lives in the Clusters hub.
      </p>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="outline" @click="router.push({ name: 'ClustersHub' })">
          Open the Clusters hub
          <ArrowRight class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  </SettingsSection>
</template>
