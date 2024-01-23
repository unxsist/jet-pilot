<script setup lang="ts">
import NavigationItemIcon from "@/components/NavigationItemIcon.vue";
import { RouteLocationRaw, useRouter } from "vue-router";
import { injectStrict } from "@/lib/utils";
import {
  RegisterCommandStateKey,
  UnregisterCommandStateKey,
} from "@/providers/CommandPaletteProvider";

const router = useRouter();

const props = defineProps<{
  icon: string;
  title: string;
  to: RouteLocationRaw;
}>();

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

onUnmounted(() => {
  unregisterCommand(commandId);
});
</script>
<template>
  <router-link
    :to="props.to"
    active-class="bg-background border !border-border text-primary"
    class="border border-transparent flex items-center font-semibold rounded-l-lg border-r-0 px-2 py-1 text-[#7a7a7a] cursor-pointer transition-all hover:bg-background hover:text-primary"
  >
    <NavigationItemIcon :name="props.icon" />
    <span class="w-[135px] mx-3 truncate" :title="title">{{ title }}</span>
  </router-link>
</template>
