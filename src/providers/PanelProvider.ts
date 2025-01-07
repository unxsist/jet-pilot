import {
  provide,
  reactive,
  InjectionKey,
  toRefs,
  ToRefs,
  shallowRef,
} from "vue";

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
  (component: any, props: any) => void
> = Symbol("PanelProviderSetSidePanelComponent");

export type TabClosedEvent = {
  id: string;
};

export interface Tab {
  id: string;
  icon: string;
  title: string;
  component: any;
  props?: any;
}

export interface PanelProviderState {
  tabs: Tab[];
  activeTabId: string | null;
  sidePanelComponent: any;
  sidePanelComponentProps: any;
}

export default {
  name: "PanelProvider",
  setup() {
    const state: PanelProviderState = reactive({
      tabs: [],
      activeTabId: null,
      sidePanelComponent: null,
      sidePanelComponentProps: null,
    });

    provide(PanelProviderStateKey, toRefs(state));

    const addTab = (
      id: string,
      title: string,
      component: any,
      props?: any,
      icon = "tab"
    ) => {
      if (state.tabs.find((tab) => tab.id === id)) {
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

    const setSidePanelComponent = (component: any, props: any) => {
      state.sidePanelComponent = shallowRef(component);
      state.sidePanelComponentProps = props;
    };

    provide(PanelProviderAddTabKey, addTab);
    provide(PanelProviderCloseTabKey, closeTab);
    provide(PanelProviderSetSidePanelComponentKey, setSidePanelComponent);
  },
  render(): any {
    return this.$slots.default();
  },
};
