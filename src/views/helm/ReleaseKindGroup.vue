<script setup lang="ts">
import { ChevronRight } from "lucide-vue-next";
import KindIcon from "@/components/KindIcon.vue";
import { StatusDot } from "@/components/ui/status";
import { useWatchedList } from "@/composables/useWatchedList";
import { kubectlGetForContext, kubectlPollingForced } from "@/lib/multicontext";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  WATCHED_KINDS,
  objectHealth,
  pluralKindLabel,
  type ManifestObject,
  type ObjectHealth,
} from "@/lib/helm";

/*
 * The objects of one kind in a release. Workloads and claims follow the
 * cluster live (the app's watches), so a release says which of its parts
 * aren't ready. Healthy objects stay quiet: a small green dot.
 */
const props = defineProps<{
  kind: string;
  objects: ManifestObject[];
  context: string;
  kubeConfig: string;
  namespace: string;
}>();

const emit = defineEmits<{ open: [object: ManifestObject, live: any | null] }>();

const FOLDED = 5;
const expanded = ref(false);
const { settings } = injectStrict(SettingsContextStateKey);

const resource = WATCHED_KINDS[props.kind];
const live = resource
  ? useWatchedList<any>({
      resource: () => resource,
      kind: () => props.kind,
      targets: () => [
        { context: props.context, kubeConfig: props.kubeConfig, namespaces: [props.namespace] },
      ],
      fallback: (res, target) =>
        kubectlGetForContext<any>(res, target.context, target.kubeConfig, target.namespaces),
      forcePolling: () => kubectlPollingForced(settings.value),
    })
  : null;

const byName = computed(() => {
  const map = new Map<string, any>();
  for (const item of live?.items.value ?? []) map.set(item.metadata?.name, item);
  return map;
});

/* Health once the live list has loaded; null before (or for other kinds). */
const healthOf = (object: ManifestObject): ObjectHealth | null => {
  if (!live || (live.loading.value && !live.items.value.length) || live.error.value?.fatal) {
    return null;
  }
  return objectHealth(props.kind, byName.value.get(object.name) ?? null);
};

const unhealthy = computed(
  () => props.objects.filter((o) => {
    const health = healthOf(o);
    return health && health.tone !== "success" && health.tone !== "muted";
  }).length
);

/* Problems first, so a folded group never hides one. */
const ordered = computed(() =>
  [...props.objects].sort((a, b) => {
    const rank = (o: ManifestObject) => {
      const tone = healthOf(o)?.tone;
      return tone === "destructive" ? 0 : tone === "warning" ? 1 : 2;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  })
);

const visible = computed(() =>
  expanded.value || ordered.value.length <= FOLDED + 1 ? ordered.value : ordered.value.slice(0, FOLDED)
);

const labelClass = (health: ObjectHealth) =>
  health.tone === "destructive"
    ? "text-destructive"
    : health.tone === "warning"
      ? "text-warning"
      : "text-muted-foreground";
</script>

<template>
  <div>
    <div class="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
      <KindIcon :name="formatResourceKind(kind).toLowerCase()" class="h-3.5 w-3.5" />
      <span class="font-medium text-foreground/80">{{ pluralKindLabel(kind, objects.length) }}</span>
      <span class="tabular-nums">{{ objects.length }}</span>
      <span v-if="unhealthy" class="ml-auto text-warning">{{ unhealthy }} not ready</span>
    </div>
    <ul class="space-y-px">
      <li v-for="object in visible" :key="`${object.namespace}/${object.name}`">
        <button
          type="button"
          class="group/obj flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors duration-fast ease-out hover:bg-accent focus-ring"
          :title="object.source ? `From ${object.source}` : undefined"
          @click="emit('open', object, byName.get(object.name) ?? null)"
        >
          <span class="min-w-0 flex-1 truncate">{{ object.name }}</span>
          <span
            v-if="object.namespace && object.namespace !== namespace"
            class="shrink-0 truncate text-xs text-muted-foreground"
            >{{ object.namespace }}</span
          >
          <template v-if="healthOf(object)">
            <span
              v-if="healthOf(object)!.tone !== 'success'"
              class="shrink-0 text-xs"
              :class="labelClass(healthOf(object)!)"
              >{{ healthOf(object)!.label }}</span
            >
            <StatusDot :tone="healthOf(object)!.tone" size="sm" :label="healthOf(object)!.label" />
          </template>
          <ChevronRight
            class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/obj:opacity-100"
          />
        </button>
      </li>
    </ul>
    <button
      v-if="visible.length < ordered.length"
      type="button"
      class="ml-2 mt-0.5 rounded-sm text-xs text-link hover:underline focus-ring"
      @click="expanded = true"
    >
      Show {{ ordered.length - visible.length }} more
    </button>
  </div>
</template>
