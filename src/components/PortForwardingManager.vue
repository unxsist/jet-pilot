<script setup lang="ts">
/**
 * The sidebar footer entry for port forwards: how many run, and (only when
 * it matters) how many are reconnecting or failed. It opens the forward
 * manager; a forward that healed itself says so there in one muted line.
 */
import { defineAsyncComponent } from "vue";
import { Cable, Loader2, RotateCw, TriangleAlert } from "lucide-vue-next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status";
import {
  PortForwardingStateKey,
  PortForwardingProfilesKey,
  type ActivePortForwarding,
} from "@/providers/PortForwardingProvider";
import { injectStrict } from "@/lib/utils";
import { countForwards, forwardSummary } from "@/lib/portForwardSummary";

const ForwardManager = defineAsyncComponent(
  () => import("@/components/port-forwards/ForwardManager.vue")
);
const HttpTester = defineAsyncComponent(
  () => import("@/components/port-forwards/HttpTester.vue")
);

const { activePortForwardings } = injectStrict(PortForwardingStateKey);
const profiles = injectStrict(PortForwardingProfilesKey).profiles;

const counts = computed(() => countForwards(activePortForwardings.value));
const summary = computed(() => forwardSummary(counts.value, profiles.value.length));
const visible = computed(() => activePortForwardings.value.length);

const overallTone = computed(() =>
  counts.value.failed > 0
    ? "destructive"
    : counts.value.reconnecting > 0
    ? "warning"
    : counts.value.ready > 0
    ? "success"
    : "muted"
);

const open = ref(false);
const panel = ref<HTMLElement | null>(null);
// Focus lands on the panel itself, not on the first row's buttons (that
// would show its hover state as if it were selected).
const focusPanel = (event: Event) => {
  event.preventDefault();
  nextTick(() =>
    (
      panel.value?.querySelector<HTMLElement>("[data-manager-header]") ??
      panel.value
    )?.focus()
  );
};

/* The HTTP tester (stays open when the forward stops, saying so). */
const tester = ref<ActivePortForwarding | null>(null);
const testerLive = computed(
  () => activePortForwardings.value.find((pf) => pf.id === tester.value?.id) ?? null
);
const openTester = (pf: ActivePortForwarding) => {
  open.value = false;
  tester.value = pf;
};
</script>

<template>
  <div v-if="visible > 0 || profiles.length > 0" class="w-full">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          :aria-label="`Port forwards: ${summary}`"
          :title="summary"
          class="flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground transition-colors duration-fast ease-out hover:bg-accent/70 hover:text-foreground focus-ring focus-visible:ring-offset-sidebar data-[state=open]:bg-accent"
        >
          <span class="flex w-4 shrink-0 justify-center text-muted-foreground">
            <StatusDot v-if="visible > 0" :tone="overallTone" :pulse="counts.ready > 0" />
            <Cable v-else class="h-4 w-4" />
          </span>
          <span class="min-w-0 flex-1 truncate text-left">
            <template v-if="visible > 0">
              {{ visible }} port forward{{ visible === 1 ? "" : "s" }}
            </template>
            <template v-else>
              {{ profiles.length }} saved forward{{ profiles.length === 1 ? "" : "s" }}
            </template>
          </span>
          <span
            v-if="counts.starting > 0"
            class="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Loader2 class="h-3 w-3 animate-spin" />{{ counts.starting }}
          </span>
          <span
            v-if="counts.reconnecting > 0"
            class="inline-flex items-center gap-1 text-xs text-warning"
          >
            <RotateCw class="h-3 w-3" />{{ counts.reconnecting }}
          </span>
          <span
            v-if="counts.failed > 0"
            class="inline-flex items-center gap-1 text-xs text-destructive"
          >
            <TriangleAlert class="h-3 w-3" />{{ counts.failed }}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        :side-offset="16"
        class="w-[32rem] p-0"
        aria-label="Port forwards"
        @open-auto-focus="focusPanel"
      >
        <div ref="panel" tabindex="-1" class="outline-none">
          <ForwardManager :summary="summary" @test="openTester" />
        </div>
      </PopoverContent>
    </Popover>
  </div>
  <HttpTester
    v-if="tester"
    :key="tester.id"
    :forward="testerLive"
    :initial="tester"
    @close="tester = null"
  />
</template>
