import {
  defineAsyncComponent,
  provide,
  reactive,
  InjectionKey,
  toRefs,
  ToRefs,
  shallowRef,
  watch,
  type Component,
} from "vue";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  describeTabs,
  parseTabSession,
  type TabDescriptor,
  type TabSession,
  type TabType,
} from "@/lib/tabDescriptors";
import { whenIdle } from "@/lib/perf";

export const PanelProviderStateKey: InjectionKey<ToRefs<PanelProviderState>> =
  Symbol("PanelProviderState");
export const PanelProviderAddTabKey: InjectionKey<
  (
    id: string,
    title: string,
    component: any,
    props?: any,
    icon?: string
  ) => void
> = Symbol("PanelProviderAddTab");
export const PanelProviderCloseTabKey: InjectionKey<(id: string) => void> =
  Symbol("PanelProviderCloseTab");
export const PanelProviderSetSidePanelComponentKey: InjectionKey<
  (sidePanel: SidePanel | null) => void
> = Symbol("PanelProviderSetSidePanelComponent");

export interface PanelSession {
  /** Serializable descriptions of the open (restorable) tabs. */
  snapshot(): TabSession;
  /**
   * Opens the tabs of `session` (lazily: a tab mounts when first shown).
   * With `replace`, open tabs are closed first; tabs that veto closing
   * (e.g. an editor with unsaved changes) stay open.
   */
  restore(session: TabSession, options?: { replace?: boolean }): void;
  /** Closes tabs, honouring vetoes (unless forced). Returns kept ids. */
  closeTabs(ids: string[], options?: { force?: boolean }): string[];
}
export const PanelProviderSessionKey: InjectionKey<PanelSession> =
  Symbol("PanelProviderSession");

export type TabClosedEvent = {
  id: string;
};

export interface Tab {
  id: string;
  icon: string;
  title: string;
  component: any;
  props?: any;
  /** Restored but not shown yet: the component mounts when first shown. */
  lazy?: boolean;
}

export interface SidePanel {
  component: any;
  props: any;
  icon: string;
  title: string;
}

export interface PanelProviderState {
  tabs: Tab[];
  activeTabId: string | null;
  sidePanel: SidePanel | null;
}

/* Components of restorable tab types (see @/lib/tabDescriptors). */
const TAB_COMPONENTS: Record<TabType, Component> = {
  logs: defineAsyncComponent(() => import("@/views/StructuredLogViewer.vue")),
  describe: defineAsyncComponent(() => import("@/views/Describe.vue")),
  edit: defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
  shell: defineAsyncComponent(() => import("@/views/Shell.vue")),
  terminal: defineAsyncComponent(() => import("@/views/Terminal.vue")),
};

export default {
  name: "PanelProvider",
  setup() {
    const { settings } = injectStrict(SettingsContextStateKey);

    const state: PanelProviderState = reactive({
      tabs: [],
      activeTabId: null,
      sidePanel: null,
    });

    provide(PanelProviderStateKey, toRefs(state));

    const addTab = (
      id: string,
      title: string,
      component: any,
      props?: any,
      icon = "tab"
    ) => {
      const existing = state.tabs.find((tab) => tab.id === id);
      if (existing) {
        existing.lazy = false;
        state.activeTabId = id;
        return;
      }

      state.tabs.push({
        id,
        icon,
        title,
        component: shallowRef(component),
        props,
      });

      state.activeTabId = id;
    };

    const closeTab = (id: string) => {
      const tabIndex = state.tabs.findIndex((tab) => tab.id === id);

      if (tabIndex !== -1) {
        state.tabs.splice(tabIndex, 1);
      }
    };

    const setSidePanelComponent = (sidePanel: SidePanel | null) => {
      state.sidePanel = sidePanel;
    };

    /* ------------------------------------------------ session restore -- */

    const openDescriptor = (descriptor: TabDescriptor) => {
      if (state.tabs.some((tab) => tab.id === descriptor.id)) return;
      state.tabs.push({
        id: descriptor.id,
        icon: descriptor.icon,
        title: descriptor.title,
        component: shallowRef(TAB_COMPONENTS[descriptor.type]),
        props: { ...descriptor.props },
        lazy: true,
      });
    };

    const closeTabs = (ids: string[], { force = false } = {}) => {
      const kept: string[] = [];
      for (const id of ids) {
        const allowed = window.dispatchEvent(
          new CustomEvent<TabClosedEvent>("TabOrchestrator_TabClosed", {
            cancelable: true,
            detail: { id },
          })
        );
        if (allowed || force) closeTab(id);
        else kept.push(id);
      }
      if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
        state.activeTabId = state.tabs[state.tabs.length - 1]?.id ?? null;
      }
      return kept;
    };

    const session: PanelSession = {
      snapshot: () => describeTabs(state.tabs, state.activeTabId),
      restore: (value, { replace = false } = {}) => {
        const parsed = parseTabSession(value);
        if (replace) {
          closeTabs(state.tabs.map((tab) => tab.id));
        }
        parsed.tabs.forEach(openDescriptor);
        if (parsed.activeTabId) {
          state.activeTabId = parsed.activeTabId;
          // Mount the visible tab once the app has settled.
          whenIdle(() => {
            const active = state.tabs.find(
              (tab) => tab.id === state.activeTabId
            );
            if (active) active.lazy = false;
          });
        }
      },
      closeTabs,
    };

    /* Restore the previous session's tabs, then keep them persisted. */
    if (settings.value.openTabs) {
      session.restore(settings.value.openTabs);
    }

    watch(
      () => [
        state.activeTabId,
        state.tabs.map((tab) => `${tab.id}\u0000${tab.title}`).join("\u0001"),
      ],
      () => {
        settings.value.openTabs = session.snapshot();
      }
    );

    provide(PanelProviderAddTabKey, addTab);
    provide(PanelProviderCloseTabKey, closeTab);
    provide(PanelProviderSetSidePanelComponentKey, setSidePanelComponent);
    provide(PanelProviderSessionKey, session);
  },
  render(): any {
    return this.$slots.default();
  },
};
