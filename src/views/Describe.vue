<script setup lang="ts">
import Loading from "@/components/Loading.vue";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RefreshCw, TriangleAlert } from "lucide-vue-next";
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

/*
 * Light syntax colouring of `kubectl describe` output: top-level sections
 * stand out, nested keys are muted, Warning events are tinted.
 */
const describeLines = computed(() =>
  describeContents.value.replace(/\n$/, "").split("\n").map((line) => {
    const match = /^(\s*)([A-Za-z][\w .\-/()]{0,48}?:)(\s.*|$)/.exec(line);
    const indent = match ? match[1] : "";

    if (/^\s+Warning\s/.test(line)) {
      return { indent: "", key: "", rest: line, class: "text-warning", keyClass: "" };
    }

    if (!match) {
      return { indent: "", key: "", rest: line, class: "", keyClass: "" };
    }

    const topLevel = indent.length === 0;
    const section = topLevel && match[3].trim() === "";
    return {
      indent,
      key: match[2],
      rest: match[3],
      class: section ? "mt-1" : "",
      keyClass: section
        ? "font-semibold text-foreground"
        : "text-muted-foreground",
    };
  })
);
</script>
<template>
  <Loading :label="`Describing ${type}/${name}…`" v-if="loading" />
  <div
    v-else-if="describeError"
    role="alert"
    class="flex h-full items-center justify-center p-4"
  >
    <EmptyState
      :icon="TriangleAlert"
      :title="`Failed to describe ${type}/${name}`"
      class="max-w-xl"
    >
      <pre
        class="whitespace-pre-wrap break-words font-mono text-xs select-text"
        >{{ describeError }}</pre
      >
      <template #action>
        <Button variant="outline" size="sm" @click="describe">
          <RefreshCw class="h-3.5 w-3.5" />
          Retry
        </Button>
      </template>
    </EmptyState>
  </div>
  <div v-else class="flex h-full flex-col bg-background">
    <div
      class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
    >
      <span class="truncate font-mono text-xs text-muted-foreground"
        >kubectl describe {{ type }}/{{ name }}</span
      >
      <Button
        variant="ghost"
        size="icon-xs"
        class="ml-auto text-muted-foreground"
        aria-label="Refresh"
        title="Refresh"
        @click="describe"
      >
        <RefreshCw class="h-3.5 w-3.5" />
      </Button>
    </div>
    <pre
      class="min-h-0 flex-1 cursor-text overflow-auto px-4 py-3 font-mono text-xs leading-5 text-foreground select-text"
    ><div
        v-for="(line, index) in describeLines"
        :key="index"
        class="min-h-5"
        :class="line.class"
      >{{ line.indent }}<span v-if="line.key" :class="line.keyClass">{{ line.key }}</span>{{ line.rest }}</div></pre>
  </div>
</template>
