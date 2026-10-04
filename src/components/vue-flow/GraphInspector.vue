<script setup lang="ts">
import { Focus, SquareTerminal, Waypoints } from "lucide-vue-next";
import KindIcon from "@/components/KindIcon.vue";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status";
import { cn, formatResourceKind, injectStrict } from "@/lib/utils";
import { isProblem, type Topology, type TopoNode } from "@/lib/clusterGraph";
import {
  PanelProviderAddTabKey,
  PanelProviderSetSidePanelComponentKey,
} from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { HEALTH_LABEL, HEALTH_TONE, nodeSubtitle } from "./nodeStatus";
import { openShell, shellTarget } from "./graphActions";

/*
 * Side panel content for a graph object: why it is (un)healthy, what it is
 * connected to (each relation jumps to that object in the graph), a shell
 * shortcut, then the regular resource details (Resource.vue). Edit YAML /
 * Describe / Logs are in the side panel header.
 */
const props = defineProps<{
  node: TopoNode;
  topology: Topology;
  /** The object (shown by the side panel header and Resource.vue). */
  resource?: TopoNode["object"];
}>();
const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "focus"): void;
}>();

const ResourcePanel = defineAsyncComponent(
  () => import("@/views/panels/Resource.vue")
);

const deps = {
  addTab: injectStrict(PanelProviderAddTabKey),
  spawnDialog: injectStrict(DialogProviderSpawnDialogKey),
  setSidePanelComponent: injectStrict(PanelProviderSetSidePanelComponentKey),
};

const RELATIONS: { type: string; out: string; in: string }[] = [
  { type: "routes", in: "Traffic from", out: "Routes to" },
  { type: "owns", in: "Owned by", out: "Owns" },
  { type: "scales", in: "Scaled by", out: "Scales" },
  { type: "selects", in: "Selected by", out: "Selects" },
  { type: "mounts", in: "Used by", out: "Uses" },
];

const relations = computed(() => {
  const groups: { label: string; nodes: TopoNode[] }[] = [];
  const id = props.node.id;
  for (const relation of RELATIONS) {
    for (const direction of ["in", "out"] as const) {
      const nodes = props.topology.edges
        .filter(
          (edge) =>
            edge.type === relation.type &&
            (direction === "in" ? edge.target === id : edge.source === id)
        )
        .map((edge) =>
          props.topology.nodes.get(
            direction === "in" ? edge.source : edge.target
          )
        )
        .filter((node): node is TopoNode => !!node)
        // Pods are summarised below.
        .filter((node) => !(relation.type === "owns" && node.kind === "Pod"));
      if (nodes.length > 0) groups.push({ label: relation[direction], nodes });
    }
  }
  return groups;
});

const pods = computed(() =>
  (props.node.pods || [])
    .map((pod) => props.topology.nodes.get(pod.metadata.uid || ""))
    .filter((pod): pod is TopoNode => !!pod)
    .sort(
      (a, b) =>
        Number(isProblem(b.health)) - Number(isProblem(a.health)) ||
        a.name.localeCompare(b.name)
    )
);

const shellPod = computed(() => shellTarget(props.node));
</script>

<template>
  <div class="bg-card">
    <section class="space-y-3 border-b px-4 py-3">
      <div class="flex items-center gap-2 text-xs">
        <StatusDot
          :tone="HEALTH_TONE[node.health]"
          :pulse="node.health === 'error'"
        />
        <span
          :class="
            cn(
              'font-medium',
              node.health === 'error' && 'text-destructive',
              node.health === 'warning' && 'text-warning'
            )
          "
          >{{ node.missing ? "Missing" : HEALTH_LABEL[node.health] }}</span
        >
        <span class="min-w-0 truncate text-muted-foreground">{{
          nodeSubtitle(node)
        }}</span>
      </div>
      <ul
        v-if="node.reasons.length > 0"
        class="space-y-1 rounded-lg border border-border-subtle bg-surface-1 p-2.5 text-xs"
      >
        <li
          v-for="reason in node.reasons"
          :key="reason"
          class="flex gap-2 text-foreground/90"
        >
          <span
            :class="
              cn(
                'mt-[7px] h-1 w-1 shrink-0 rounded-full',
                node.health === 'error' ? 'bg-destructive' : 'bg-warning'
              )
            "
          />{{ reason }}
        </li>
      </ul>
      <p v-if="node.missing" class="text-xs text-muted-foreground">
        Something references this {{ node.kind }}, but it does not exist in
        {{ node.namespace || "the cluster" }}. Create it or fix the reference.
      </p>
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-if="shellPod"
          variant="outline"
          size="xs"
          :title="
            node.kind === 'Pod'
              ? 'Open a shell'
              : `Open a shell in ${shellPod.metadata.name}`
          "
          @click="openShell(deps, shellPod)"
        >
          <SquareTerminal class="h-3 w-3" /> Shell
        </Button>
        <Button
          variant="outline"
          size="xs"
          title="Zoom to its neighbourhood (double-click)"
          @click="emit('focus')"
        >
          <Focus class="h-3 w-3" /> Focus in graph
        </Button>
      </div>
    </section>

    <section
      v-if="pods.length > 0 || relations.length > 0"
      class="space-y-3 border-b px-4 py-3"
      aria-label="Relationships"
    >
      <h3
        class="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.06em] text-foreground"
      >
        <Waypoints class="h-3.5 w-3.5" /> Relationships
      </h3>
      <div v-if="pods.length > 0">
        <div class="mb-1 text-2xs text-muted-foreground">
          Pods · {{ pods.length }}
        </div>
        <ul class="space-y-px">
          <li v-for="pod in pods.slice(0, 8)" :key="pod.id">
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-accent"
              @click="emit('select', pod.id)"
            >
              <StatusDot :tone="HEALTH_TONE[pod.health]" size="sm" />
              <span class="truncate text-foreground">{{ pod.name }}</span>
              <span
                :class="
                  cn(
                    'ml-auto shrink-0',
                    isProblem(pod.health)
                      ? pod.health === 'error'
                        ? 'text-destructive'
                        : 'text-warning'
                      : 'text-muted-foreground'
                  )
                "
                >{{ pod.reasons[0] || nodeSubtitle(pod) }}</span
              >
            </button>
          </li>
          <li
            v-if="pods.length > 8"
            class="px-1.5 text-xs text-muted-foreground"
          >
            +{{ pods.length - 8 }} more
          </li>
        </ul>
      </div>
      <div v-for="relation in relations" :key="relation.label">
        <div class="mb-1 text-2xs text-muted-foreground">
          {{ relation.label }}
        </div>
        <ul class="space-y-px">
          <li v-for="other in relation.nodes.slice(0, 8)" :key="other.id">
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-accent"
              @click="emit('select', other.id)"
            >
              <KindIcon
                :name="formatResourceKind(other.kind).toLowerCase()"
                class="h-3.5 w-3.5 text-muted-foreground"
              />
              <span
                :class="
                  cn(
                    'truncate',
                    other.missing ? 'text-destructive' : 'text-foreground'
                  )
                "
                >{{ other.name }}</span
              >
              <StatusDot
                v-if="isProblem(other.health)"
                :tone="HEALTH_TONE[other.health]"
                size="sm"
              />
              <span class="ml-auto shrink-0 text-muted-foreground">{{
                other.missing ? "missing" : other.kind
              }}</span>
            </button>
          </li>
          <li
            v-if="relation.nodes.length > 8"
            class="px-1.5 text-xs text-muted-foreground"
          >
            +{{ relation.nodes.length - 8 }} more
          </li>
        </ul>
      </div>
    </section>

    <ResourcePanel v-if="resource" :resource="resource" />
  </div>
</template>
