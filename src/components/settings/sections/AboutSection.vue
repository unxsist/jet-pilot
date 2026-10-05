<script setup lang="ts">
/* Settings › General › About JET Pilot: version, links and sponsoring. */
import { getVersion } from "@tauri-apps/api/app";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ExternalLink, Heart } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { openWelcome } from "@/lib/welcome";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsRow } from "@/components/settings/styles";

const version = ref("");
onMounted(() => getVersion().then((value) => (version.value = value)));

const LINKS = [
  { label: "Website", url: "https://www.jet-pilot.app" },
  { label: "Source code", url: "https://github.com/unxsist/jet-pilot" },
  { label: "Report an issue", url: "https://github.com/unxsist/jet-pilot/issues/new" },
];
/* Set once the project's GitHub Sponsors listing is live (the row stays hidden until then). */
const SPONSOR_URL = null as string | null;
</script>

<template>
  <SettingsSection title="About JET Pilot" description="Free and open source (MIT). No account, no telemetry.">
    <div :class="settingsRow">
      <div class="space-y-1">
        <p class="text-sm font-medium">Version</p>
        <p class="text-xs text-muted-foreground">
          <template v-if="version">JET Pilot v{{ version }}</template>
        </p>
      </div>
      <div class="flex flex-wrap gap-1 sm:justify-end">
        <Button
          v-for="link in LINKS"
          :key="link.url"
          size="sm"
          variant="ghost"
          @click="openExternal(link.url)"
        >
          {{ link.label }}
          <ExternalLink class="h-3 w-3 text-muted-foreground" />
        </Button>
      </div>
    </div>
    <div :class="settingsRow">
      <div class="space-y-1">
        <p class="text-sm font-medium">Setup guide</p>
        <p class="text-xs text-muted-foreground">Walk through kubeconfig files, tools and appearance again.</p>
      </div>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="outline" @click="openWelcome">Open setup guide</Button>
      </div>
    </div>
    <div v-if="SPONSOR_URL" :class="settingsRow">
      <div class="space-y-1">
        <p class="text-sm font-medium">Support JET Pilot</p>
        <p class="text-xs text-muted-foreground">
          JET Pilot stays free for everyone. If it saves you time, sponsoring keeps it going.
        </p>
      </div>
      <div class="flex sm:justify-end">
        <Button size="sm" variant="outline" @click="openExternal(SPONSOR_URL!)">
          <Heart class="h-3.5 w-3.5 text-destructive" />
          Sponsor
        </Button>
      </div>
    </div>
  </SettingsSection>
</template>
