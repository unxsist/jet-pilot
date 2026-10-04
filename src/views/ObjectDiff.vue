<script setup lang="ts">
/*
 * Cross-context diff: the same object (kind / namespace / name) in two
 * clusters, side by side. Cluster-assigned fields (uid, resourceVersion,
 * timestamps, managed fields, status) are hidden by default so the diff
 * shows what was declared differently.
 */
import { Command } from "@tauri-apps/plugin-shell";
import yaml from "js-yaml";
import Loading from "@/components/Loading.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import MonacoView from "@/components/monaco/MonacoView.vue";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeftRight, Columns2, RefreshCw, Rows2 } from "lucide-vue-next";
import { diffObjects, stripServerFields } from "@/components/monaco/manifest";
import { error } from "@/lib/logger";

interface Side {
  context: string;
  kubeConfig: string;
}

const props = defineProps<{
  type: string;
  name: string;
  namespace?: string;
  left: Side;
  right: Side;
}>();

const sides = reactive({ left: props.left, right: props.right });
const raw = reactive<{ left: unknown; right: unknown }>({ left: null, right: null });
const errors = reactive({ left: "", right: "" });
const loading = ref(true);
const hideServerFields = ref(true);
const sideBySide = ref(true);

const fetchSide = async (side: Side) => {
  const args = [
    "get",
    `${props.type}/${props.name}`,
    "-o",
    "yaml",
    "--context",
    side.context,
    "--kubeconfig",
    side.kubeConfig,
  ];
  if (props.namespace) args.push("--namespace", props.namespace);
  const { code, stdout, stderr } = await Command.create("kubectl", args).execute();
  if (code !== 0) throw new Error(stderr.trim() || `kubectl exited with code ${code}`);
  return yaml.load(stdout);
};

const load = async () => {
  loading.value = true;
  await Promise.all(
    (["left", "right"] as const).map(async (key) => {
      errors[key] = "";
      try {
        raw[key] = await fetchSide(sides[key]);
      } catch (e) {
        raw[key] = null;
        errors[key] = e instanceof Error ? e.message : String(e);
        error(`Diff: failed to fetch ${props.type}/${props.name} from ${sides[key].context}: ${errors[key]}`);
      }
    })
  );
  loading.value = false;
};

onMounted(load);

const swap = () => {
  [sides.left, sides.right] = [sides.right, sides.left];
  [raw.left, raw.right] = [raw.right, raw.left];
  [errors.left, errors.right] = [errors.right, errors.left];
};

const normalized = (value: unknown) =>
  value === null ? null : hideServerFields.value ? stripServerFields(value) : value;

const dump = (value: unknown, side: "left" | "right") =>
  value === null
    ? `# Not available in ${sides[side].context}\n# ${errors[side].split("\n")[0]}\n`
    : yaml.dump(value, { noArrayIndent: true, lineWidth: -1, sortKeys: true });

const leftText = computed(() => dump(normalized(raw.left), "left"));
const rightText = computed(() => dump(normalized(raw.right), "right"));
const differences = computed(() =>
  raw.left && raw.right
    ? diffObjects(normalized(raw.left), normalized(raw.right), {
        includeServerFields: !hideServerFields.value,
      }).length
    : null
);
</script>

<template>
  <div class="flex h-full w-full flex-col bg-background">
    <div
      class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-xs"
      role="toolbar"
      aria-label="Cross-context diff"
    >
      <span class="truncate font-mono text-muted-foreground">
        {{ type }}/{{ name }}<span v-if="namespace"> · {{ namespace }}</span>
      </span>
      <span class="flex min-w-0 items-center gap-1.5">
        <ContextAvatar :name="sides.left.context" size="sm" />
        <span class="truncate font-medium text-foreground">{{ sides.left.context }}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        title="Swap sides"
        aria-label="Swap sides"
        @click="swap"
      >
        <ArrowLeftRight class="h-3.5 w-3.5" />
      </Button>
      <span class="flex min-w-0 items-center gap-1.5">
        <ContextAvatar :name="sides.right.context" size="sm" />
        <span class="truncate font-medium text-foreground">{{ sides.right.context }}</span>
      </span>
      <span
        v-if="!loading && differences !== null"
        class="ml-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium tnum"
        :class="differences ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'"
        data-testid="diff-count"
      >
        {{ differences ? `${differences} ${differences === 1 ? "difference" : "differences"}` : "Identical" }}
      </span>
      <div class="ml-auto flex items-center gap-3">
        <div class="flex items-center gap-2">
          <Switch id="hide-server-fields" v-model:checked="hideServerFields" />
          <Label for="hide-server-fields" class="text-xs font-normal text-muted-foreground">
            Hide cluster-managed fields
          </Label>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          :title="sideBySide ? 'Inline diff' : 'Side-by-side diff'"
          :aria-label="sideBySide ? 'Inline diff' : 'Side-by-side diff'"
          @click="sideBySide = !sideBySide"
        >
          <Rows2 v-if="sideBySide" class="h-3.5 w-3.5" />
          <Columns2 v-else class="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground"
          title="Refresh"
          aria-label="Refresh"
          @click="load"
        >
          <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
        </Button>
      </div>
    </div>
    <div class="min-h-0 flex-1">
      <Loading v-if="loading && raw.left === null && raw.right === null" :label="`Fetching ${name} from both contexts…`" />
      <MonacoView
        v-else
        :original="leftText"
        :value="rightText"
        :side-by-side="sideBySide"
        hide-unchanged
      />
    </div>
  </div>
</template>
