<script setup lang="ts">
/**
 * The auth center's UI: the sign-in dialog (requestSignIn(), loaded on
 * demand) and the "Sign-in needed" toasts. Mounted once in App.vue, inside
 * the providers, as an async component (after the first paint): issues
 * reported before that are toasted when it mounts.
 */
import { closeSignIn, registerAuthHost, signInRequest } from "@/lib/auth/center";
import { startIssueToasts } from "@/lib/auth/notify";

const SignInDialog = defineAsyncComponent(() => import("./SignInDialog.vue"));

const request = computed(() => signInRequest.value);

const unregister = registerAuthHost();
const stopToasts = startIssueToasts();
onUnmounted(() => {
  unregister();
  stopToasts();
});
</script>

<template>
  <SignInDialog v-if="request" :key="request.id" :request="request" @close="closeSignIn" />
</template>
