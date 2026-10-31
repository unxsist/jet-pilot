<script setup lang="ts">
/**
 * One cluster on the Upgrades tab: its version and whether that's still
 * supported where it runs, then what stands between it and the next minor
 * (APIs that go away, add-ons out of support, nodes too old to follow).
 * Each line says it in words; the lists open on click.
 */
import { ChevronRight, CircleAlert, Sparkles } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, statusTextClass, type StatusTone } from "@/components/ui/status";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { useAskAi } from "@/lib/ai/askAi";
import { PLATFORM_LABELS } from "@/lib/upgrades/support";
import { addonsSummary, apiFindingWords, apiGroups, apisSummary, nodesSummary } from "@/lib/upgrades/words";
import { listWords } from "@/lib/resources/format";
import type { CheckState } from "@/lib/health/checks/session";
import type { UpgradeReport } from "@/lib/upgrades/check";
import type { HealthTarget } from "@/lib/health/tabs";

const props = defineProps<{ target: HealthTarget; name: string; state: CheckState<UpgradeReport> | undefined }>();

const report = computed(() => props.state?.result ?? null);
const support = computed(() => report.value?.support ?? null);
const subtitle = computed(() => {
  const r = report.value;
  if (!r) return "";
  const version = r.version?.replace(/^v/, "").split(/[-+]/)[0];
  return [PLATFORM_LABELS[r.platform], version && `Kubernetes ${version}`].filter(Boolean).join(" · ");
});

const apis = computed(() => (report.value ? apisSummary(report.value.apis) : null));
const addons = computed(() => (report.value ? addonsSummary(report.value.addons) : null));
const nodes = computed(() => (report.value?.nodes ? nodesSummary(report.value.nodes, report.value.next) : null));
const apiLines = computed(() => apiGroups(report.value?.apis ?? []));
const notable = computed(() => (report.value?.addons ?? []).filter((a) => a.headline));
const quietAddons = computed(() => (report.value?.addons ?? []).filter((a) => !a.headline));

const open = reactive(new Set<"apis" | "addons">());
const toggle = (row: "apis" | "addons") => (open.has(row) ? open.delete(row) : open.add(row));

const toneText = (tone: StatusTone) =>
  tone === "destructive" || tone === "warning" ? statusTextClass[tone] : "text-muted-foreground";

const supportTitle = computed(() => {
  const s = support.value;
  if (!s) return "";
  return s.phase === "supported" && s.behind ? `${s.headline} · ${s.latest} is the newest` : s.headline;
});

/* Ask AI: the agent can read the cluster and plan the upgrade. */
const askAi = useAskAi();
function askAboutUpgrade() {
  const r = report.value;
  if (!r) return;
  const evidence = [
    support.value && `${PLATFORM_LABELS[r.platform]} ${support.value.minor}: ${support.value.headline}.`,
    ...r.apis.map((f) => `${f.kind} ${f.name}: ${apiFindingWords(f).when}. ${apiFindingWords(f).detail}`),
    ...notable.value.map((a) => `${a.label} ${a.version ?? ""}: ${a.headline}.`),
    nodes.value?.text,
  ].filter((line): line is string => !!line);
  askAi.ask({
    context: props.target.context,
    kubeConfig: props.target.kubeConfig,
    subject: `${props.name} upgrade`,
    question: r.next
      ? `What do I need to do before upgrading this cluster to Kubernetes ${r.next}, and in what order?`
      : "Is this cluster ready for its next Kubernetes upgrade?",
    evidence,
  });
}
</script>

<template>
  <article class="rounded-xl border bg-card shadow-sm" :aria-label="`Upgrades of ${name}`">
    <header class="flex items-start gap-3 px-5 pb-4 pt-5">
      <ContextAvatar :name="target.context" :kube-config="target.kubeConfig" />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-base font-semibold">{{ name }}</h2>
        <p class="truncate text-xs text-muted-foreground">
          <template v-if="subtitle">{{ subtitle }}</template>
          <Skeleton v-else-if="state?.running" class="mt-1 h-3 w-40" />
        </p>
      </div>
      <Button
        v-if="askAi.available.value && report"
        variant="ghost"
        size="sm"
        class="-mr-2 text-muted-foreground"
        @click="askAboutUpgrade"
      >
        <Sparkles class="h-3.5 w-3.5" />
        Ask AI
      </Button>
    </header>

    <div v-if="state?.error && !report" class="flex items-start gap-2 border-t px-5 py-4 text-xs text-destructive" role="alert">
      <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
      <span>Couldn't check it: {{ state.error }}</span>
    </div>

    <div v-else-if="!report" class="space-y-3 border-t px-5 py-4" aria-label="Checking">
      <Skeleton class="h-4 w-64" />
      <Skeleton class="h-3 w-80" />
      <Skeleton class="h-3 w-80" />
    </div>

    <template v-else>
      <div v-if="support" class="flex items-start gap-3 border-t px-5 py-4">
        <span class="flex h-5 w-4 shrink-0 items-center justify-center"><StatusDot :tone="support.tone" /></span>
        <div class="min-w-0">
          <p class="text-sm font-medium" :class="support.tone === 'success' ? 'text-foreground' : toneText(support.tone)">
            {{ supportTitle }}
          </p>
          <p v-if="support.detail" class="text-xs text-muted-foreground">{{ support.detail }}</p>
        </div>
      </div>

      <div class="border-t px-5 py-4">
        <p class="mb-2.5 text-xs font-medium text-muted-foreground">
          {{ report.next ? `Before ${report.next}` : "Before the next version" }}
        </p>
        <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
          <dt class="text-muted-foreground">APIs</dt>
          <dd class="min-w-0">
            <button
              v-if="report.apis.length"
              type="button"
              class="-mx-1 flex max-w-full items-center gap-2 rounded px-1 text-left focus-ring"
              :aria-expanded="open.has('apis')"
              @click="toggle('apis')"
            >
              <StatusDot :tone="apis!.tone" />
              <span class="truncate">{{ apis!.text }}</span>
              <ChevronRight
                class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-fast"
                :class="open.has('apis') && 'rotate-90'"
              />
            </button>
            <span v-else class="flex items-center gap-2 text-muted-foreground"><StatusDot tone="success" /> {{ apis!.text }}</span>
            <ul v-if="open.has('apis')" class="mt-2 space-y-2.5">
              <li v-for="line in apiLines" :key="line.key" class="min-w-0">
                <p class="flex min-w-0 items-baseline gap-2">
                  <span class="truncate" :title="line.title">{{ line.title }}</span>
                  <span class="ml-auto shrink-0 text-xs" :class="toneText(line.tone)">{{ line.when }}</span>
                </p>
                <p class="text-xs text-muted-foreground">{{ line.detail }}</p>
              </li>
            </ul>
          </dd>

          <dt class="text-muted-foreground">Add-ons</dt>
          <dd class="min-w-0">
            <button
              v-if="report.addons.length"
              type="button"
              class="-mx-1 flex max-w-full items-center gap-2 rounded px-1 text-left focus-ring"
              :aria-expanded="open.has('addons')"
              @click="toggle('addons')"
            >
              <StatusDot :tone="addons!.tone" />
              <span class="truncate">{{ addons!.text }}</span>
              <ChevronRight
                class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-fast"
                :class="open.has('addons') && 'rotate-90'"
              />
            </button>
            <span v-else class="text-muted-foreground">{{ addons!.text }}</span>
            <ul v-if="open.has('addons')" class="mt-2 space-y-2.5">
              <li v-for="addon in notable" :key="addon.id" class="min-w-0" :title="addon.where">
                <p class="flex min-w-0 items-baseline gap-2">
                  <span class="truncate">{{ addon.label }} <span class="tabular-nums text-muted-foreground">{{ addon.version }}</span></span>
                  <span class="ml-auto shrink-0 text-xs" :class="toneText(addon.tone)">{{ addon.headline }}</span>
                </p>
                <p v-if="addon.detail" class="text-xs text-muted-foreground">{{ addon.detail }}</p>
              </li>
              <li v-if="quietAddons.length" class="text-xs text-muted-foreground">
                Also found: {{ listWords(quietAddons.map((a) => (a.version ? `${a.label} ${a.version}` : a.label))) }}
              </li>
            </ul>
          </dd>

          <template v-if="nodes">
            <dt class="text-muted-foreground">Nodes</dt>
            <dd class="flex min-w-0 items-center gap-2" :class="nodes.tone === 'warning' ? '' : 'text-muted-foreground'">
              <StatusDot :tone="nodes.tone" />
              <span class="truncate">{{ nodes.text }}</span>
            </dd>
          </template>
        </dl>
      </div>

      <p v-if="report.skipped.length || report.namespaces" class="border-t px-5 py-3 text-xs text-muted-foreground/80">
        <template v-if="report.namespaces">Read in {{ listWords(report.namespaces) }} only: there's no cluster-wide access. </template>
        <template v-if="report.skipped.length">Couldn't read {{ listWords(report.skipped) }}, so they aren't checked.</template>
      </p>
    </template>
  </article>
</template>
