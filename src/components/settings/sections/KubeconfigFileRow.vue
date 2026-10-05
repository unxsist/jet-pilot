<script setup lang="ts">
/**
 * A kubeconfig file in Settings › Clusters: its path, where it comes from,
 * how many contexts it has (or why it can't be read). Expanding it lists the
 * contexts with their credentials type and problems (a missing exec plugin,
 * a missing certificate file, ...).
 */
import {
  AlertTriangle,
  ChevronRight,
  CircleAlert,
  FileKey2,
  Loader2,
  Trash2,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AUTH_LABELS,
  describeKubeconfig,
  type KubeconfigReport,
} from "@/lib/kubeconfigSources";

const props = defineProps<{
  path: string;
  /** Origin badge, e.g. "$KUBECONFIG". */
  origin?: string;
  /** null: still checking. */
  contextCount: number | null;
  error?: string | null;
  /** Listed again below (also added by the user): dimmed. */
  duplicate?: boolean;
  removable?: boolean;
}>();
const emit = defineEmits<{ remove: [] }>();

const open = ref(false);
const report = ref<KubeconfigReport | null>(null);
const reportError = ref<string | null>(null);
const loading = ref(false);

const toggle = async () => {
  open.value = !open.value;
  if (!open.value || report.value || loading.value) return;
  loading.value = true;
  reportError.value = null;
  try {
    report.value = await describeKubeconfig(props.path);
  } catch (e) {
    reportError.value = (e as { message?: string })?.message ?? String(e);
  } finally {
    loading.value = false;
  }
};
watch(
  () => props.path,
  () => {
    report.value = null;
    open.value = false;
  }
);

const problemCount = computed(
  () => report.value?.contexts.reduce((count, context) => count + context.problems.length, 0) ?? 0
);
</script>

<template>
  <div class="group/file border-b border-border-subtle last:border-b-0" :class="duplicate ? 'opacity-60' : ''">
    <div class="flex min-h-10 items-center gap-2.5 bg-background pl-2 pr-3">
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-ring"
        :aria-expanded="open"
        :aria-label="open ? `Hide the contexts of ${path}` : `Show the contexts of ${path}`"
        :disabled="!!error"
        @click="toggle"
      >
        <ChevronRight class="h-3.5 w-3.5 transition-transform duration-fast" :class="open ? 'rotate-90' : ''" />
      </button>
      <FileKey2 class="h-4 w-4 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="path">{{ path }}</span>
      <Badge v-if="origin" variant="muted" size="sm">{{ origin }}</Badge>
      <span v-if="duplicate" class="text-2xs text-muted-foreground">Also added above</span>
      <span
        v-else-if="error"
        class="flex max-w-[45%] items-center gap-1 truncate text-xs text-destructive"
        :title="error"
      >
        <CircleAlert class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ error }}</span>
      </span>
      <Loader2 v-else-if="contextCount === null" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      <span v-else class="shrink-0 text-xs tabular-nums text-muted-foreground">
        {{ contextCount }} {{ contextCount === 1 ? "context" : "contexts" }}
      </span>
      <Button
        v-if="removable"
        variant="ghost"
        size="icon-sm"
        class="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        :aria-label="`Remove ${path}`"
        title="Remove"
        @click="emit('remove')"
      >
        <Trash2 class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div v-if="open" class="space-y-1 bg-surface-1/60 px-10 py-2.5">
      <div v-if="loading" class="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <Loader2 class="h-3.5 w-3.5 animate-spin" /> Reading contexts…
      </div>
      <p v-else-if="reportError" class="py-1 text-xs text-destructive">{{ reportError }}</p>
      <template v-else-if="report">
        <p v-if="report.contexts.length === 0" class="py-1 text-xs text-muted-foreground">
          This file has no contexts.
        </p>
        <p v-else-if="problemCount === 0" class="pb-1 text-xs text-muted-foreground">
          Every context looks ready to use.
        </p>
        <div v-for="context in report.contexts" :key="context.name" class="space-y-1 py-1">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="font-medium">{{ context.name }}</span>
            <Badge v-if="report.currentContext === context.name" variant="accent" size="sm">current</Badge>
            <span class="text-muted-foreground">
              {{ AUTH_LABELS[context.auth.kind] ?? context.auth.kind
              }}<template v-if="context.auth.command"> · {{ context.auth.command }}</template
              ><template v-if="context.auth.awsProfile"> · profile {{ context.auth.awsProfile }}</template>
            </span>
            <span v-if="context.server" class="truncate font-mono text-2xs text-muted-foreground" :title="context.server">
              {{ context.server }}
            </span>
          </div>
          <p
            v-for="problem in context.problems"
            :key="problem.code + problem.message"
            class="flex items-start gap-1.5 text-xs"
            :class="problem.severity === 'error' ? 'text-destructive' : 'text-warning'"
          >
            <CircleAlert v-if="problem.severity === 'error'" class="mt-px h-3.5 w-3.5 shrink-0" />
            <AlertTriangle v-else class="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{{ problem.message }}</span>
          </p>
        </div>
      </template>
    </div>
  </div>
</template>
