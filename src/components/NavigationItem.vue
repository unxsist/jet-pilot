<script setup lang="ts">
import NavigationItemIcon from "@/components/NavigationItemIcon.vue";
import { RouteLocationRaw, useRouter } from "vue-router";
import { injectStrict } from "@/lib/utils";
import {
  RegisterCommandStateKey,
  UnregisterCommandStateKey,
} from "@/providers/CommandPaletteProvider";
import PinIcon from "@/assets/icons/pin.svg";
import PinLineIcon from "@/assets/icons/pin-line.svg";
import { type } from "@tauri-apps/api/os";

const router = useRouter();

const os = ref("");
const props = withDefaults(
  defineProps<{
    icon: string;
    title: string;
    to: RouteLocationRaw;
    pinned?: boolean;
    shortcut?: number | undefined;
  }>(),
  {
    pinned: false,
    shortcut: undefined,
  }
);

const registerCommand = injectStrict(RegisterCommandStateKey);
const unregisterCommand = injectStrict(UnregisterCommandStateKey);

const commandId = crypto.randomUUID();
registerCommand({
  id: commandId,
  name: props.title,
  description: "Navigate to " + props.title,
  execute: () => {
    router.push(props.to);
  },
});

onMounted(async () => {
  os.value = await type();
});

onUnmounted(() => {
  unregisterCommand(commandId);
});
</script>
<template>
  <router-link
    :to="props.to"
    active-class="bg-background border !border-border text-primary"
    class="group/main border border-transparent flex items-center font-semibold rounded-l-lg border-r-0 px-2 py-1 text-[#7a7a7a] cursor-pointer transition-all hover:bg-background hover:text-primary"
  >
    <NavigationItemIcon :name="props.icon" />
    <span class="w-[135px] mx-3 truncate" :title="title">{{ title }}</span>
    <div class="block h-full group-hover/main:hidden">
      <span
        v-if="props.shortcut"
        class="text-xxs text-[#7a7a7a] whitespace-nowrap"
      >
        <span>
          {{ os === "Darwin" ? "⌘" : "Ctrl" }}{{ os === "Windows_NT" ? "+" : ""
          }}{{ props.shortcut }}
        </span>
      </span>
    </div>
    <div class="hidden group-hover/main:block">
      <div
        class="group/pin"
        @click.prevent="$emit(pinned ? 'unpinned' : 'pinned')"
      >
        <PinLineIcon
          class="h-4"
          :class="{
            'block group-hover/pin:hidden': !pinned,
            'hidden group-hover/pin:block': pinned,
          }"
        />
        <PinIcon
          class="h-4"
          :class="{
            'hidden group-hover/pin:block': !pinned,
            'block group-hover/pin:hidden': pinned,
          }"
        />
      </div>
    </div>
  </router-link>
</template>
