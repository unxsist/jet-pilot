<script setup lang="ts">
import { exit, relaunch } from "@tauri-apps/api/process";
import { Kubernetes } from "@/services/Kubernetes";
import { onMounted, ref } from "vue";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

const checking = ref(true);
const success = ref(false);
const errorMessage = ref("");

onMounted(async () => {
  try {
    const contexts = await Kubernetes.getContexts();
    const namespaces = await Kubernetes.getNamespaces(contexts[0]);
    success.value = true;
  } catch (error: any) {
    errorMessage.value = error.message;
  } finally {
    checking.value = false;
  }
});
</script>
<template>
  <div class="dark" v-if="!checking && !success">
    <AlertDialog :open="true">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>An error occured</AlertDialogTitle>
          <AlertDialogDescription>
            Unable to start JET Pilot. For more info, please see details below.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p class="block max-w-full text-white font-mono text-xs break-all">
          {{ errorMessage }}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel @click="exit(0)">Exit</AlertDialogCancel>
          <AlertDialogAction @click="relaunch()">Retry</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
  <slot name="loading" v-if="checking" />
  <slot v-if="!checking && success" />
</template>
