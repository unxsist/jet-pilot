<script setup lang="ts">
/*
 * The main area: one view, or two side by side (split view, see
 * @/lib/splitView). Panes are keyed by id, so the first pane (and its
 * cached views) stays mounted when a second one opens or closes. With two
 * panes each gets a slim header like a bottom-panel tab; clicking into a
 * pane focuses it, and the router (sidebar, palette, links) follows it.
 */
import SplitPaneView from "@/components/SplitPaneView.vue";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { injectStrict } from "@/lib/utils";
import { SplitViewKey } from "@/providers/SplitViewProvider";
import { MIN_PANE_SIZE } from "@/lib/splitView";

/* Only needed once the view is split. */
const SplitPaneHeader = defineAsyncComponent(() => import("@/components/SplitPaneHeader.vue"));

const split = injectStrict(SplitViewKey);

const defaultSize = (index: number) =>
  !split.isSplit.value ? 100 : index === 0 ? split.size.value : 100 - split.size.value;

const onLayout = (sizes: number[]) => {
  if (sizes.length === 2) split.setSize(sizes[0]);
};

/*
 * A pane added to (or removed from) the group re-lays it out from its
 * panels' default sizes, which the group normalizes; set the stored split
 * explicitly once both panels are there.
 */
type PanelHandle = { resize: (size: number) => void };
const panelRefs = new Map<string, PanelHandle>();
const setPanelRef = (id: string, el: unknown) => {
  if (el) panelRefs.set(id, el as PanelHandle);
  else panelRefs.delete(id);
};
watch(
  () => split.isSplit.value,
  (isSplit) => {
    if (!isSplit) return;
    void nextTick(() => {
      const first = split.layout.value.panes[0];
      if (first) panelRefs.get(first.id)?.resize(split.size.value);
    });
  }
);
</script>

<template>
  <ResizablePanelGroup direction="horizontal" @layout="onLayout">
    <template v-for="(pane, index) in split.layout.value.panes" :key="pane.id">
      <ResizableHandle v-if="index > 0" />
      <ResizablePanel
        :id="pane.id"
        :ref="(el) => setPanelRef(pane.id, el)"
        :order="index"
        :default-size="defaultSize(index)"
        :min-size="split.isSplit.value ? MIN_PANE_SIZE : undefined"
      >
        <section
          class="flex h-full min-w-0 flex-col"
          :data-pane="split.isSplit.value ? index : undefined"
          :data-pane-focused="split.isSplit.value ? index === split.layout.value.focused : undefined"
          @pointerdown.capture="split.focus(index)"
        >
          <SplitPaneHeader
            v-if="split.isSplit.value"
            :index="index"
            :path="pane.path"
            :focused="index === split.layout.value.focused"
          />
          <div class="relative min-h-0 flex-1">
            <SplitPaneView :path="pane.path" :suspended="split.suspended.value" />
          </div>
        </section>
      </ResizablePanel>
    </template>
  </ResizablePanelGroup>
</template>
