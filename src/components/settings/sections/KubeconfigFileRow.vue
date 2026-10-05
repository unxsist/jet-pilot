<script setup lang="ts">
/**
 * A kubeconfig file in Settings › Clusters, as a calm list row: its path,
 * where it comes from and how many contexts it has, and on the right only a
 * problem (it can't be read). Clicking it lists the contexts with their
 * credentials type and problems (a missing exec plugin, a missing
 * certificate file, ...), or the full read error.
 */
import { AlertTriangle, ChevronRight, CircleAlert, FileKey2, Loader2, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { settingsTile } from "@/components/settings/styles";
import { cn } from "@/lib/utils";
import { AUTH_LABELS, describeKubeconfig, type KubeconfigReport } from "@/lib/kubeconfigSources";

const props = defineProps<{
  path: string;
  /** The home directory: shown as ~. */
  home?: string;
  /** Where it was found, e.g. "From $KUBECONFIG". */
  origin?: string;
  /** null: still checking. */
  contextCount: number | null;
  error?: string | null;
  /** Listed again below (also added by the user): dimmed. */
  duplicate?: boolean;
  removable?: boolean;
}>();
const emit = defineEmits<{ remove: [] }>();

const shownPath = computed(() =>
  props.home && props.path.startsWith(`${props.home}/`) ? `~${props.path.slice(props.home.length)}` : props.path
);
const subtitle = computed(() => {
  const parts = props.origin ? [props.origin] : [];
  if (props.duplicate) parts.push("also added by you");
  else if (!props.error && props.contextCount !== null) {
    parts.push(`${props.contextCount} ${props.contextCount === 1 ? "context" : "contexts"}`);
  }
  return parts.join(" · ");
});

const open = ref(false);
const report = ref<KubeconfigReport | null>(null);
const reportError = ref<string | null>(null);
const loading = ref(false);

const toggle = async () => {
  open.value = !open.value;
  if (!open.value || props.error || report.value || loading.value) return;
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
  <div class="group/file" :class="duplicate ? 'opacity-60' : ''">
    <div
      :class="
        cn(
          'flex h-14 items-center gap-3 rounded-lg px-3 transition-colors duration-fast hover:bg-accent/50',
          open && 'bg-accent/50'
        )
      "
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md text-left focus-ring"
        :aria-expanded="open"
        :aria-label="open ? `Hide the contexts of ${path}` : `Show the contexts of ${path}`"
        @click="toggle"
      >
        <span :class="settingsTile">
          <FileKey2 class="h-4 w-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-mono text-xs text-foreground" :title="path">{{ shownPath }}</span>
          <span v-if="subtitle" class="block truncate text-xs text-muted-foreground">{{ subtitle }}</span>
        </span>
        <span v-if="error && !duplicate" class="flex shrink-0 items-center gap-1.5 text-xs text-destructive" :title="error">
          <span class="h-1.5 w-1.5 rounded-full bg-current" />
          Can't be read
        </span>
        <Loader2 v-else-if="contextCount === null && !duplicate" class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        <ChevronRight
          class="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast"
          :class="open ? 'rotate-90' : ''"
        />
      </button>
      <Button
        v-if="removable"
        variant="ghost"
        size="icon-sm"
        class="-mr-1 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/file:opacity-100"
        :aria-label="`Remove ${path}`"
        title="Remove"
        @click="emit('remove')"
      >
        <Trash2 class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div v-if="open" class="space-y-2 pb-3 pl-14 pr-3 pt-2">
      <p v-if="error" class="flex items-start gap-1.5 break-words text-xs text-destructive">
        <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
        <span class="min-w-0">{{ error }}</span>
      </p>
      <div v-else-if="loading" class="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 class="h-3.5 w-3.5 animate-spin" /> Reading contexts…
      </div>
      <p v-else-if="reportError" class="text-xs text-destructive">{{ reportError }}</p>
      <template v-else-if="report">
        <p v-if="report.contexts.length === 0" class="text-xs text-muted-foreground">This file has no contexts.</p>
        <p v-else-if="problemCount === 0" class="text-xs text-muted-foreground">Every context looks ready to use.</p>
        <div v-for="context in report.contexts" :key="context.name" class="space-y-0.5">
          <p class="flex min-w-0 items-baseline gap-2 text-xs">
            <span class="shrink-0 font-medium text-foreground">{{ context.name }}</span>
            <span v-if="report.currentContext === context.name" class="shrink-0 text-link">current</span>
            <span class="truncate text-muted-foreground">
              {{ AUTH_LABELS[context.auth.kind] ?? context.auth.kind
              }}<template v-if="context.auth.command"> · {{ context.auth.command }}</template
              ><template v-if="context.auth.awsProfile"> · profile {{ context.auth.awsProfile }}</template>
            </span>
          </p>
          <p v-if="context.server" class="truncate font-mono text-2xs text-muted-foreground" :title="context.server">
            {{ context.server }}
          </p>
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
