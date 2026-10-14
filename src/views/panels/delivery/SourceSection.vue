<script setup lang="ts">
/**
 * Where a delivery comes from: repository (opens in the browser), branch or
 * tag, path or chart, the revision in the cluster. For Flux also the state
 * of its source objects: a repository that can't be fetched is a common
 * reason a delivery fails.
 */
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ArrowUpRight } from "lucide-vue-next";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import { formatDateTime } from "@/lib/utils";
import { relativeTime } from "@/lib/clusters/status";
import { browsableUrl, fluxState, type Delivery, type ObjectRef } from "@/lib/gitops/model";

const props = defineProps<{
  delivery: Delivery;
  /** The Flux source objects (repository first), as far as they exist. */
  sources: { ref: ObjectRef; object: any | undefined; loading: boolean }[];
  now: number;
}>();

const source = computed(() => props.delivery.source);
const link = computed(() => browsableUrl(source.value.url));

const facts = computed(() => {
  const s = source.value;
  const list: { label: string; value: string; mono?: boolean }[] = [];
  if (s.chart) list.push({ label: "Chart", value: s.chart });
  if (s.chart && s.version) list.push({ label: "Version", value: s.version });
  const argo = props.delivery.tool === "argo";
  if (!s.chart && s.ref) list.push({ label: argo ? "Target" : s.refKind ?? "Ref", value: s.ref });
  if (s.chart && s.ref && s.ref !== s.version) list.push({ label: "Wanted", value: s.ref });
  if (s.path) list.push({ label: "Path", value: s.path });
  if (!s.chart && s.revision) list.push({ label: argo ? "Synced" : "Applied", value: s.revision, mono: true });
  return list;
});

const sourceStates = computed(() =>
  props.sources.map(({ ref, object, loading }) => {
    const state = object ? fluxState(object, props.now) : null;
    const fetched = object?.status?.artifact?.lastUpdateTime;
    return {
      ref,
      loading,
      state,
      problem: !!state && (state.category === "failing" || state.category === "attention"),
      fetched: fetched ? { text: relativeTime(new Date(fetched).getTime(), props.now), title: formatDateTime(new Date(fetched)) } : null,
    };
  })
);
</script>

<template>
  <div class="space-y-3">
    <dl class="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
      <template v-if="source.url || source.repo">
        <dt class="text-muted-foreground">Repository</dt>
        <dd class="min-w-0">
          <button
            v-if="link"
            type="button"
            class="inline-flex max-w-full items-center gap-1 text-link hover:underline focus-ring rounded-sm"
            :title="`Open ${source.url} in the browser`"
            @click="openExternal(link)"
          >
            <span class="truncate">{{ source.repo || source.url }}</span>
            <ArrowUpRight class="h-3 w-3 shrink-0" />
          </button>
          <span v-else class="block truncate select-text" :title="source.url">{{ source.url || source.repo }}</span>
        </dd>
      </template>
      <template v-for="fact in facts" :key="fact.label">
        <dt class="text-muted-foreground">{{ fact.label }}</dt>
        <dd class="min-w-0 truncate select-text" :class="fact.mono ? 'font-mono' : ''" :title="fact.value">{{ fact.value }}</dd>
      </template>
    </dl>

    <ul v-if="sourceStates.length" class="space-y-1.5">
      <li v-for="item in sourceStates" :key="`${item.ref.kind}/${item.ref.name}`" class="rounded-lg border px-3 py-2 text-xs">
        <div class="flex items-center gap-2">
          <StatusDot :tone="item.state?.tone ?? 'muted'" size="sm" />
          <span class="min-w-0 flex-1 truncate">
            <span class="text-muted-foreground">{{ item.ref.kind }}</span>
            {{ item.ref.name }}
          </span>
          <span
            class="shrink-0"
            :class="item.problem ? statusTextClass[item.state!.tone] + ' font-medium' : 'text-muted-foreground'"
            :title="item.fetched && !item.problem ? `Fetched ${item.fetched.title}` : undefined"
          >
            {{ !item.state ? (item.loading ? "" : "Not found") : item.problem ? item.state.label : item.fetched ? `Fetched ${item.fetched.text}` : item.state.label }}
          </span>
        </div>
        <p v-if="item.problem && item.state?.message" class="mt-1.5 select-text break-words leading-relaxed text-muted-foreground">
          {{ item.state.message }}
        </p>
      </li>
    </ul>
  </div>
</template>
