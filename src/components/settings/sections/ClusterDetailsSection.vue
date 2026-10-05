<script setup lang="ts">
/* Settings › Clusters › Cluster details: they live in the Clusters hub. */
import { useRouter } from "vue-router";
import { ArrowRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsHint, settingsLabel, settingsRow } from "@/components/settings/styles";

const router = useRouter();
</script>

<template>
  <SettingsSection title="Cluster details">
    <div :class="settingsRow">
      <div class="min-w-0">
        <p :class="settingsLabel">Names, colours and guardrails</p>
        <p :class="[settingsHint, 'mt-0.5']">Environments, folders, tags and namespaces per cluster live in the hub.</p>
      </div>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="outline" @click="router.push({ name: 'ClustersHub' })">
          Open Clusters
          <ArrowRight class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  </SettingsSection>
</template>
