<script setup lang="ts">
/**
 * Renders the guardrails' typed confirmation (lib/guardrails/guard.ts).
 * Mounted once in App.vue, inside the providers.
 */
import { pendingConfirm, registerHost, settle } from "@/lib/guardrails/host";

const TypedConfirmDialog = defineAsyncComponent(
  () => import("./TypedConfirmDialog.vue")
);

const request = computed(() => pendingConfirm.value);

const unregister = registerHost();
onUnmounted(unregister);
</script>

<template>
  <TypedConfirmDialog
    v-if="request"
    :key="request.id"
    :request="request"
    @settle="settle"
  />
</template>
