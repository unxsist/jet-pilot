<script setup lang="ts">
/**
 * Where a cluster's usage history comes from: found automatically (the
 * default), a service the user picks (from what was found, or typed in,
 * with a test), or off (metrics-server's last minutes only). Saved with
 * the cluster's metadata.
 */
import { ChartSpline, Check, Loader2, RotateCw } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG } from "@/components/wizard/wizard";
import { useClusters } from "@/lib/clusters/useClusters";
import type { MetricsSetting } from "@/lib/clusters/meta";
import { discoverCached, forgetDiscovery, type Discovery } from "@/lib/metrics/discovery";
import {
  KIND_LABELS,
  describeSource,
  ping,
  sameSource,
  toPrometheusError,
  type PromSource,
} from "@/lib/metrics/prometheus";

const props = defineProps<{ context: string; kubeConfig: string }>();
const open = defineModel<boolean>("open", { required: true });

const clusters = useClusters();
const cluster = computed(() => clusters.resolve(props.context, props.kubeConfig));

type Mode = "auto" | "service" | "off";
const mode = ref<Mode>("auto");
/** The picked service: a found candidate, or `custom`. */
const picked = ref<string>("custom");
const custom = reactive({ namespace: "", service: "", port: "", pathPrefix: "" });

const discovery = shallowRef<Discovery | null>(null);
const discovering = ref(false);
const target = computed(() => ({ context: props.context, kubeConfig: props.kubeConfig }));

const look = async (again = false) => {
  if (again) forgetDiscovery(target.value);
  discovering.value = true;
  try {
    discovery.value = await discoverCached(target.value);
  } catch {
    discovery.value = { found: null, candidates: [], limited: true };
  } finally {
    discovering.value = false;
  }
};

const candidates = computed(() => discovery.value?.candidates.filter((c) => c.ok) ?? []);

/* Testing the typed-in service. */
const test = ref<{ state: "running" | "ok" | "failed"; message?: string; detail?: string } | null>(null);
const keyOf = (s: PromSource) => `${s.namespace}/${s.service}:${s.port}${s.pathPrefix ?? ""}`;

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    const setting = cluster.value.metrics;
    mode.value = setting?.mode === "off" ? "off" : setting?.mode === "service" ? "service" : "auto";
    picked.value = "custom";
    Object.assign(custom, { namespace: "", service: "", port: "", pathPrefix: "" });
    test.value = null;
    if (setting?.mode === "service") {
      Object.assign(custom, {
        namespace: setting.namespace,
        service: setting.service,
        port: String(setting.port),
        pathPrefix: setting.pathPrefix ?? "",
      });
    }
    look().then(() => {
      // A saved service that is one of the found ones is shown as that row.
      if (setting?.mode === "service") {
        const match = candidates.value.find((c) => sameSource(c.source, setting));
        if (match) picked.value = keyOf(match.source);
      } else if (!candidates.value.length) {
        picked.value = "custom";
      } else {
        picked.value = keyOf(candidates.value[0]!.source);
      }
    });
  },
  { immediate: true }
);

const customSource = computed<PromSource | null>(() => {
  const port = custom.port.trim();
  if (!custom.namespace.trim() || !custom.service.trim() || !port) return null;
  const prefix = custom.pathPrefix.trim();
  return {
    namespace: custom.namespace.trim(),
    service: custom.service.trim(),
    port: /^\d+$/.test(port) ? Number(port) : port,
    // The proxy speaks TLS to the service only when told to; a port named https or 443 needs it.
    ...(/https/.test(port) || port === "443" ? { scheme: "https" as const } : {}),
    ...(prefix ? { pathPrefix: prefix.startsWith("/") ? prefix : `/${prefix}` } : {}),
  };
});

const chosenSource = computed<PromSource | null>(() => {
  if (picked.value === "custom") return customSource.value;
  return candidates.value.find((c) => keyOf(c.source) === picked.value)?.source ?? null;
});

watch(customSource, () => (test.value = null));
const runTest = async () => {
  const source = customSource.value;
  if (!source) return;
  test.value = { state: "running" };
  try {
    await ping(target.value, source);
    if (customSource.value === source) test.value = { state: "ok" };
  } catch (error) {
    const e = toPrometheusError(error, source);
    if (customSource.value === source) test.value = { state: "failed", message: e.summary, detail: e.detail };
  }
};

const canSave = computed(() => mode.value !== "service" || !!chosenSource.value);

const save = () => {
  let metrics: MetricsSetting | undefined;
  if (mode.value === "off") metrics = { mode: "off" };
  else if (mode.value === "service" && chosenSource.value) metrics = { mode: "service", ...chosenSource.value };
  clusters.update(props.context, props.kubeConfig, { metrics });
  open.value = false;
};

const found = computed(() => discovery.value?.found ?? null);

const OPTIONS: { value: Mode; title: string }[] = [
  { value: "auto", title: "Automatic" },
  { value: "service", title: "A service I choose" },
  { value: "off", title: "Off" },
];

const LABEL = "text-xs text-muted-foreground";
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="[WIZARD_DIALOG, 'max-w-lg']">
      <WizardHeader title="Metrics history">
        <template #icon><ChartSpline class="h-[18px] w-[18px]" /></template>
        <template #description>
          Where JET Pilot reads usage over time for
          <span class="font-medium text-foreground">{{ cluster.displayName }}</span>.
        </template>
      </WizardHeader>

      <div :class="[WIZARD_BODY, 'space-y-1']" role="radiogroup" aria-label="Metrics history">
        <div v-for="option in OPTIONS" :key="option.value" class="-mx-3">
          <button
            type="button"
            role="radio"
            :aria-checked="mode === option.value"
            class="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-fast hover:bg-accent/50 focus-ring"
            @click="mode = option.value"
          >
            <span
              class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-fast"
              :class="mode === option.value ? 'border-primary bg-primary' : 'border-border-strong'"
            >
              <span v-if="mode === option.value" class="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{{ option.title }}</span>
              <span class="block text-xs text-muted-foreground">
                <template v-if="option.value === 'auto'">
                  <span v-if="discovering" class="flex items-center gap-1.5">
                    <Loader2 class="h-3 w-3 animate-spin" /> Looking for Prometheus…
                  </span>
                  <span v-else-if="found" class="flex min-w-0 items-center gap-1.5">
                    <StatusDot tone="success" size="sm" />
                    <span class="truncate">Uses {{ KIND_LABELS[found.kind] }}: {{ describeSource(found.source) }}</span>
                  </span>
                  <template v-else>
                    Finds Prometheus, Thanos or VictoriaMetrics. None found, so charts show the last 15 minutes from
                    metrics-server.
                  </template>
                </template>
                <template v-else-if="option.value === 'service'">For a setup JET Pilot can't find, or to pick another one.</template>
                <template v-else>Charts show the last 15 minutes from metrics-server.</template>
              </span>
            </span>
          </button>

          <!-- Choosing a service -->
          <div v-if="option.value === 'service' && mode === 'service'" class="mb-2 ml-10 mr-3 mt-1 space-y-3">
            <div v-if="candidates.length" class="space-y-0.5" role="radiogroup" aria-label="Services">
              <button
                v-for="candidate in candidates"
                :key="keyOf(candidate.source)"
                type="button"
                role="radio"
                :aria-checked="picked === keyOf(candidate.source)"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent/50 focus-ring"
                @click="picked = keyOf(candidate.source)"
              >
                <Check class="h-3.5 w-3.5 shrink-0" :class="picked === keyOf(candidate.source) ? 'text-primary' : 'invisible'" />
                <span class="min-w-0 flex-1 truncate">{{ candidate.source.service }}</span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ candidate.source.namespace }} · {{ candidate.source.port }}</span>
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="picked === 'custom'"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent/50 focus-ring"
                @click="picked = 'custom'"
              >
                <Check class="h-3.5 w-3.5 shrink-0" :class="picked === 'custom' ? 'text-primary' : 'invisible'" />
                Another service…
              </button>
            </div>

            <div v-if="picked === 'custom'" class="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <label class="space-y-1">
                <span :class="LABEL">Namespace</span>
                <Input v-model="custom.namespace" placeholder="monitoring" spellcheck="false" class="h-8" />
              </label>
              <label class="space-y-1">
                <span :class="LABEL">Service</span>
                <Input v-model="custom.service" placeholder="prometheus-k8s" spellcheck="false" class="h-8" />
              </label>
              <label class="space-y-1">
                <span :class="LABEL">Port</span>
                <Input v-model="custom.port" placeholder="9090 or web" spellcheck="false" class="h-8" />
              </label>
              <label class="space-y-1">
                <span :class="LABEL">Path prefix <span class="opacity-70">(optional)</span></span>
                <Input v-model="custom.pathPrefix" placeholder="/select/0/prometheus" spellcheck="false" class="h-8" />
              </label>
              <div class="col-span-2 flex min-h-7 items-center gap-3">
                <Button variant="outline" size="xs" :disabled="!customSource || test?.state === 'running'" @click="runTest">
                  <Loader2 v-if="test?.state === 'running'" class="h-3 w-3 animate-spin" />
                  Test
                </Button>
                <span v-if="test?.state === 'ok'" class="flex items-center gap-1.5 text-xs text-success">
                  <Check class="h-3.5 w-3.5" /> Answers like Prometheus
                </span>
                <span v-else-if="test?.state === 'failed'" class="min-w-0 truncate text-xs text-destructive" :title="test.detail">
                  {{ test.message }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <WizardFooter>
        <template #start>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring disabled:opacity-50"
            :disabled="discovering"
            @click="look(true)"
          >
            <RotateCw class="h-3 w-3" :class="discovering && 'animate-spin'" /> Look again
          </button>
        </template>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button :disabled="!canSave" @click="save">Save</Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>
