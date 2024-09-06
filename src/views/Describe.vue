<script setup lang="ts">
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/api/shell";

const props = defineProps<{
  context: string;
  namespace?: string;
  kubeConfig: string;
  type: string;
  name: string;
}>();

const describeContents = ref<string>("");

onMounted(() => {
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

  const command = new Command("kubectl", args);

  let stdOutData = "";
  command.stdout.on("data", (data) => {
    stdOutData += data;
  });

  command.on("close", ({ code }) => {
    if (code === 0) {
      describeContents.value = stdOutData;
    }
  });

  command.spawn();
});
</script>
<template>
  <Loading label="loading..." v-if="describeContents.length === 0" />
  <pre class="cursor-text select-text w-full h-full overflow-auto">{{
    describeContents
  }}</pre>
</template>
