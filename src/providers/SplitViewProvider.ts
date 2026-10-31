import {
  computed,
  provide,
  shallowRef,
  watch,
  onUnmounted,
  type ComputedRef,
  type InjectionKey,
  type Ref,
  type SetupContext,
} from "vue";
import { useRouter, type RouteLocationRaw, type Router } from "vue-router";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { injectStrict } from "@/lib/utils";
import { whenIdle } from "@/lib/perf";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { RegisterCommandStateKey } from "@/providers/CommandPaletteProvider";
import { isInOverlay } from "@/components/tables/keyboard";
import {
  clampSplitSize,
  focusPane,
  followRoute,
  isFullWidthPath,
  isSplit,
  singlePane,
  snapshotSplit,
  type SplitLayout,
  type SplitSnapshot,
} from "@/lib/splitView";

export interface SplitView {
  layout: Readonly<Ref<SplitLayout>>;
  isSplit: ComputedRef<boolean>;
  /** A full-width page (Settings) is open: the panes are put away. */
  suspended: ComputedRef<boolean>;
  /** Width of the left pane in percent (stored in state.json). */
  size: ComputedRef<number>;
  setSize(size: number): void;
  /** Shows a route next to the current view (Alt / middle-click). */
  openToSide(to: RouteLocationRaw): void;
  focus(index: number): void;
  close(index: number): void;
  /** Mod+\: splits (the previous view opens beside) or closes the other pane. */
  toggle(): void;
  swap(): void;
  /** For workspaces: the panes, or null without a split. */
  snapshot(): SplitSnapshot | null;
  /** Applies a workspace's split (null: one pane, the focused view stays). */
  restore(snapshot: SplitSnapshot | null): Promise<void>;
}

export const SplitViewKey: InjectionKey<SplitView> = Symbol("SplitView");

/* What the layout operations (@/lib/splitViewOps) work on. */
export interface SplitViewState {
  layout: Ref<SplitLayout>;
  router: Router;
  suspended: Readonly<Ref<boolean>>;
  /** The view shown before the current one (Mod+\\ opens it beside). */
  previousPath(): string | null;
  /** Navigates the router (the focused pane) unless it is there already. */
  navigate(path: string, replace: boolean): void;
}

/**
 * Split view (see @/lib/splitView): one or two panes in the main area. The
 * router follows the focused pane; this provider keeps the layout in step
 * with it and offers the commands and the Mod+\ shortcut.
 */
export default {
  name: "SplitViewProvider",
  setup(_props: unknown, { slots }: SetupContext) {
    const router = useRouter();
    const { settings } = injectStrict(SettingsContextStateKey);
    const registerCommand = injectStrict(RegisterCommandStateKey);

    // The first navigation may still be running: the pane fills in below.
    const layout = shallowRef<SplitLayout>(singlePane(""));
    const current = () => router.currentRoute.value;
    const suspended = computed(() => isFullWidthPath(current().fullPath));

    /* The last view shown before the current one: what Mod+\ opens beside. */
    let previousPath: string | null = null;

    watch(
      () => current().fullPath,
      (path, oldPath) => {
        if (current().matched.length === 0 || isFullWidthPath(path)) return;
        if (oldPath && oldPath !== path && !isFullWidthPath(oldPath) && oldPath !== "/") {
          previousPath = oldPath;
        }
        layout.value = followRoute(layout.value, path);
      },
      { immediate: true }
    );

    const navigate = (path: string, replace: boolean) => {
      if (path === current().fullPath) return;
      (replace ? router.replace(path) : router.push(path)).catch(() => {});
    };

    const focus = (index: number) => {
      if (suspended.value) return;
      const next = focusPane(layout.value, index);
      if (next === layout.value) return;
      layout.value = next;
      // The pane's view is cached: replacing the location is instant.
      navigate(next.panes[index].path, true);
    };

    const size = computed(() => clampSplitSize(settings.value.splitView?.size));
    const setSize = (value: number) => {
      settings.value.splitView = { size: clampSplitSize(Math.round(value * 10) / 10) };
    };

    /* Opening, closing and swapping panes: loaded on first use (or when idle). */
    const ops = () => import("@/lib/splitViewOps");
    const state: SplitViewState = {
      layout,
      router,
      suspended,
      previousPath: () => previousPath,
      navigate,
    };

    const api: SplitView = {
      layout,
      isSplit: computed(() => isSplit(layout.value)),
      suspended,
      size,
      setSize,
      openToSide: (to) => ops().then((m) => m.openBeside(state, to)),
      focus,
      close: (index) => ops().then((m) => m.close(state, index)),
      toggle: () => ops().then((m) => m.toggle(state)),
      swap: () => ops().then((m) => m.swap(state)),
      snapshot: () => snapshotSplit(layout.value),
      restore: (value) => ops().then((m) => m.restore(state, value)),
    };
    provide(SplitViewKey, api);

    /* Palette commands: not needed for the first frame. */
    whenIdle(() => void ops().then((m) => m.registerCommands(registerCommand, api)));

    /* -------------------------------------------------------- shortcut -- */

    const isMac = getOsType() === "macos";
    const onKeydown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey || event.repeat) return;
      if (event.code !== "Backslash") return;
      const target = event.target as Element | null;
      // Ctrl+\ is SIGQUIT in a shell; editors and dialogs keep their keys.
      if (target?.closest?.(".xterm, .monaco-editor") || isInOverlay(event.target)) return;
      event.preventDefault();
      void api.toggle();
    };
    window.addEventListener("keydown", onKeydown);
    onUnmounted(() => window.removeEventListener("keydown", onKeydown));

    return () => slots.default?.();
  },
};
