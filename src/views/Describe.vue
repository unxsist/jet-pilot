<script setup lang="ts">
import Loading from "@/components/Loading.vue";
import { Button } from "@/components/ui/button";
import { error } from "@/lib/logger";
import { Command } from "@tauri-apps/plugin-shell";

const props = defineProps<{
  context: string;
  namespace?: string;
  kubeConfig: string;
  type: string;
  name: string;
}>();

const describeContents = ref<string>("");
const loading = ref(true);
const describeError = ref<string | null>(null);

const describe = async () => {
  loading.value = true;
  describeError.value = null;

  const args = [
    "describe",
    `${props.type}/${props.name}`,
    "--context",
    props.context,
    "--kubeconfig",
    props.kubeConfig,
  ];

  if (props.namespace) {
    args.push("--namespace", props.namespace);
  }

  try {
    // Only the exit code decides success: kubectl also writes warnings to
    // stderr.
    const { code, stdout, stderr } = await Command.create(
      "kubectl",
      args
    ).execute();

    if (code !== 0) {
      throw new Error(stderr.trim() || `kubectl exited with code ${code}`);
    }

    describeContents.value = stdout;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error(`Error describing ${props.type}/${props.name}: ${message}`);
    describeError.value = message;
  } finally {
    loading.value = false;
  }
};

onMounted(describe);
</script>
<template>
  <Loading label="loading..." v-if="loading" />
  <div
    v-else-if="describeError"
    role="alert"
    class="flex flex-col items-center justify-center h-full gap-3 p-4 text-center"
  >
    <span class="font-semibold text-destructive">
      Failed to describe {{ type }}/{{ name }}
    </span>
    <pre
      class="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground select-text"
      >{{ describeError }}</pre
    >
    <Button variant="secondary" size="xs" @click="describe">Retry</Button>
  </div>
  <pre v-else class="cursor-text select-text w-full h-full overflow-auto">{{
    describeContents
  }}</pre>
</template>
