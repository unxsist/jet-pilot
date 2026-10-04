<script setup lang="ts">
defineOptions({ inheritAttrs: false });
import { getBezierPath, Position } from "@vue-flow/core";
import { injectStrict } from "@/lib/utils";
import type { EdgeType } from "@/lib/clusterGraph";
import { GraphViewStateKey } from "./graphState";

/*
 * A typed relationship: owns / routes / selects / mounts / scales, styled
 * per type (see the legend). Traffic edges carry a subtle animated flow
 * (off with reduced motion). Dimmed outside the selected neighbourhood.
 */
const props = defineProps<{
  id: string;
  source: string;
  target: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data: {
    type: EdgeType;
    missing?: boolean;
    crossGroup?: boolean;
    /** An endpoint has a problem (stays visible in problems mode). */
    problem?: boolean;
    /** Into a shared group: faint unless highlighted. */
    faint?: boolean;
    /** Endpoints from the layout (cards have no handles). */
    points: { sx: number; sy: number; tx: number; ty: number };
  };
}>();

const state = injectStrict(GraphViewStateKey);

const path = computed(
  () =>
    getBezierPath({
      sourceX: props.data.points.sx,
      sourceY: props.data.points.sy,
      sourcePosition: Position.Right,
      targetX: props.data.points.tx,
      targetY: props.data.points.ty,
      targetPosition: Position.Left,
      curvature: 0.35,
    })[0]
);

const lit = computed(() => !!state.lit.value?.edges.has(props.id));
const hovered = computed(
  () =>
    state.hovered.value !== null &&
    (state.hovered.value === props.source ||
      state.hovered.value === props.target)
);
const dimmed = computed(() => {
  if (state.lit.value) return !lit.value;
  if (state.matches.value) {
    return !(
      state.matches.value.has(props.source) ||
      state.matches.value.has(props.target)
    );
  }
  return state.problems.value && !props.data.problem;
});
</script>

<template>
  <path
    :d="path"
    fill="none"
    :class="
      [
        'graph-edge',
        `graph-edge--${data.type}`,
        data.missing && 'graph-edge--missing',
        (lit || hovered) && 'graph-edge--lit',
        dimmed && !hovered && 'graph-edge--dim',
        data.crossGroup && 'graph-edge--cross',
        data.faint && !lit && !hovered && 'graph-edge--faint',
      ]
    "
  />
  <circle
    :cx="data.points.tx"
    :cy="data.points.ty"
    r="2.5"
    :class="
      [
        'graph-edge-end',
        `graph-edge-end--${data.type}`,
        data.missing && 'graph-edge-end--missing',
        dimmed && !hovered && 'graph-edge--dim',
        data.faint && !lit && !hovered && 'graph-edge--faint',
      ]
    "
  />
</template>
