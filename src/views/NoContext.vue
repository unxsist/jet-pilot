<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ShowSingleCommandKey } from "@/providers/CommandPaletteProvider";
import { injectStrict } from "@/lib/utils";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { ArrowLeftRight, Settings2, Telescope } from "lucide-vue-next";

const showSingleCommand = injectStrict(ShowSingleCommandKey);
const isMac = getOsType() === "macos";
</script>

<template>
  <div
    class="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-6 text-center"
  >
    <!-- soft accent glow behind the hero -->
    <div
      class="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-[60%] rounded-full bg-primary/10 blur-3xl"
      aria-hidden="true"
    />
    <div
      class="relative mb-5 flex h-12 w-12 items-center justify-center rounded-xl border bg-card text-primary shadow-sm"
    >
      <Telescope class="h-6 w-6" :stroke-width="1.75" />
    </div>
    <h1 class="relative text-xl font-semibold tracking-tight text-foreground">
      Select a context to get started
    </h1>
    <p class="relative mt-2 max-w-sm text-balance text-sm text-muted-foreground">
      Pick one or more clusters and namespaces in the context switcher at the
      top of the sidebar, or switch from the command palette.
    </p>
    <div class="relative mt-6 flex items-center gap-2">
      <Button size="sm" @click="showSingleCommand('switch-context')">
        <ArrowLeftRight class="h-3.5 w-3.5" />
        Switch context
      </Button>
      <Button as-child size="sm" variant="outline">
        <router-link :to="{ name: 'SettingsGeneral' }">
          <Settings2 class="h-3.5 w-3.5" />
          Manage kubeconfigs
        </router-link>
      </Button>
    </div>
    <p class="relative mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
      Press <Kbd :keys="isMac ? ['⌘', 'K'] : ['Ctrl', 'K']" size="sm" /> anytime
      to search
    </p>
  </div>
</template>
