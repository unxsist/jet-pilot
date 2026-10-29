<script setup lang="ts">
/*
 * The header of a split view pane, like a bottom-panel tab: the view's
 * title, and (on hover, or always for the focused pane) swap, open in new
 * window and close. Only rendered while the view is split.
 */
import { ArrowLeftRight, SquareArrowOutUpRight, X } from "lucide-vue-next";
import { useRouter } from "vue-router";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { Button } from "@/components/ui/button";
import KindIcon from "@/components/KindIcon.vue";
import { injectStrict } from "@/lib/utils";
import { viewTitle } from "@/lib/viewTitle";
import { WindowsKey } from "@/lib/windows";
import { SplitViewKey } from "@/providers/SplitViewProvider";

const props = defineProps<{
  index: number;
  path: string;
  focused: boolean;
}>();

const split = injectStrict(SplitViewKey);
/* Pop-out windows (main window only). */
const windows = inject(WindowsKey, null);
const router = useRouter();
const isMac = getOsType() === "macos";

const view = computed(() => viewTitle(router.resolve(props.path || "/")));
</script>

<template>
  <header
    class="group relative flex h-9 shrink-0 items-center gap-2 border-b bg-surface-1 pl-3 pr-1.5 text-xs transition-colors duration-fast"
    :class="
      focused
        ? 'text-foreground before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-primary'
        : 'text-muted-foreground'
    "
  >
    <KindIcon
      :name="view.icon"
      class="h-3.5 w-3.5"
      :class="focused ? 'text-primary' : 'text-muted-foreground'"
    />
    <span class="truncate" :class="{ 'font-medium': focused }">{{ view.title }}</span>
    <div
      class="ml-auto flex items-center gap-0.5 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100"
      :class="focused ? 'opacity-100' : 'opacity-0'"
    >
      <Button
        v-if="index === 0"
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        aria-label="Swap the panes"
        title="Swap the panes"
        @click="split.swap()"
      >
        <ArrowLeftRight class="h-3.5 w-3.5" />
      </Button>
      <Button
        v-if="windows"
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        :aria-label="`Open ${view.title} in a new window`"
        title="Open in new window"
        @click.stop="windows.openView(path, { closePane: index })"
      >
        <SquareArrowOutUpRight class="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-muted-foreground"
        :aria-label="`Close ${view.title} pane`"
        :title="`Close pane (${isMac ? '⌘' : 'Ctrl+'}\\ closes the other one)`"
        @click.stop="split.close(index)"
      >
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>
  </header>
</template>
