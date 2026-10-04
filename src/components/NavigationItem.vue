<script setup lang="ts">
import NavigationItemIcon from "@/components/NavigationItemIcon.vue";
import { RouteLocationRaw, useRouter } from "vue-router";
import { injectStrict } from "@/lib/utils";
import {
  RegisterCommandStateKey,
  UnregisterCommandStateKey,
} from "@/providers/CommandPaletteProvider";
import { Pin, PinOff } from "lucide-vue-next";
import { type } from "@tauri-apps/plugin-os";

const router = useRouter();

const os = ref(type());
const props = withDefaults(
  defineProps<{
    icon: string;
    title: string;
    to: RouteLocationRaw;
    pinned?: boolean;
    canPin?: boolean;
    shortcut?: number | undefined;
    customCommandTitle?: string;
  }>(),
  {
    pinned: false,
    canPin: true,
    shortcut: undefined,
    customCommandTitle: undefined,
  }
);

const registerCommand = injectStrict(RegisterCommandStateKey);
const unregisterCommand = injectStrict(UnregisterCommandStateKey);

const commandId = crypto.randomUUID();
registerCommand({
  id: commandId,
  name: props.customCommandTitle ? props.customCommandTitle : props.title,
  description:
    "Navigate to " +
    (props.customCommandTitle ? props.customCommandTitle : props.title),
  execute: () => {
    router.push(props.to);
  },
});

onUnmounted(() => {
  unregisterCommand(commandId);
});
</script>
<template>
  <router-link
    :to="props.to"
    class="group/main relative flex h-7 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground transition-colors duration-fast ease-out hover:bg-accent/70 hover:text-foreground focus-ring focus-visible:ring-offset-sidebar before:absolute before:-left-2 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-primary before:opacity-0 before:transition-opacity before:duration-base [&.router-link-active]:bg-accent [&.router-link-active]:font-medium [&.router-link-active]:text-foreground [&.router-link-active]:before:opacity-100"
  >
    <NavigationItemIcon
      :name="props.icon"
      class="h-4 w-4 text-muted-foreground transition-colors duration-fast group-hover/main:text-foreground [.router-link-active_&]:text-primary"
    />
    <span class="min-w-0 flex-1 truncate" :title="title">{{ title }}</span>
    <span
      v-if="props.shortcut"
      class="whitespace-nowrap text-2xs font-medium tabular-nums text-muted-foreground/70"
      :class="{ 'group-hover/main:hidden': canPin }"
    >
      {{ os === "macos" ? "⌘" : "Ctrl+" }}{{ props.shortcut }}
    </span>
    <span
      v-if="canPin"
      class="-mr-1 hidden h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover/main:flex"
      role="button"
      :aria-label="pinned ? `Unpin ${title}` : `Pin ${title}`"
      :title="pinned ? 'Unpin' : 'Pin'"
      @click.prevent="$emit(pinned ? 'unpinned' : 'pinned')"
    >
      <PinOff v-if="pinned" class="h-3.5 w-3.5" />
      <Pin v-else class="h-3.5 w-3.5" />
    </span>
  </router-link>
</template>
