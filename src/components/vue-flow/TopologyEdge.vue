<script setup lang="ts">
defineOptions({ inheritAttrs: false });
import { getBezierPath, Position } from "@vue-flow/core";
import { injectStrict } from "@/lib/utils";
import type { EdgeType } from "@/lib/clusterGraph";
import { FLAG_HOVER, FLAG_LIT, FLAG_MATCH, GraphViewStateKey } from "./graphState";

/*
 * A typed relationship: owns / routes / selects / mounts / scales, styled
 * per type (see the legend). Traffic edges carry a subtle animated flow
 * (off with reduced motion). Dimmed outside the selected neighbourhood
 * (CSS: .graph-flow--lit etc. in ClusterOverview.vue).
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

/* Highlighting: own flags + one class on the canvas (see ObjectNode). */
const flags = state.flags.of(props.id);
</script>

<template>
  <path
    :d="path"
    fill="none"
    :class="[
      'graph-edge',
      `graph-edge--${data.type}`,
      data.missing && 'graph-edge--missing',
      data.crossGroup && 'graph-edge--cross',
      data.faint && 'graph-edge--faint',
      data.problem && 'graph-edge--problem',
      flags & FLAG_LIT && 'is-lit',
      flags & FLAG_HOVER && 'is-hover',
      flags & FLAG_MATCH && 'is-match',
    ]"
  />
  <circle
    :cx="data.points.tx"
    :cy="data.points.ty"
    r="2.5"
    :class="[
      'graph-edge-end',
      `graph-edge-end--${data.type}`,
      data.missing && 'graph-edge-end--missing',
      data.faint && 'graph-edge--faint',
      data.problem && 'graph-edge--problem',
      flags & FLAG_LIT && 'is-lit',
      flags & FLAG_HOVER && 'is-hover',
      flags & FLAG_MATCH && 'is-match',
    ]"
  />
</template>
