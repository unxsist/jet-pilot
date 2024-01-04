import { stat } from "fs";
import {
  provide,
  reactive,
  InjectionKey,
  toRefs,
  ToRefs,
  shallowRef,
} from "vue";

export const TabProviderStateKey: InjectionKey<ToRefs<TabProviderState>> =
  Symbol("TabProviderState");
export const TabProviderAddTabKey: InjectionKey<
  (id: string, title: string, component: any, props?: any) => void
> = Symbol("TabProviderAddTab");
export const TabProviderCloseTabKey: InjectionKey<(id: string) => void> =
  Symbol("TabProviderCloseTab");

export interface Tab {
  id: string;
  title: string;
  component: any;
  props?: any;
}

export interface TabProviderState {
  tabs: Tab[];
  activeTabId: string | null;
}

export default {
  setup() {
    const state: TabProviderState = reactive({
      tabs: [],
      activeTabId: null,
    });

    provide(TabProviderStateKey, toRefs(state));

    const addTab = (id: string, title: string, component: any, props?: any) => {
      if (state.tabs.find((tab) => tab.id === id)) {
        state.activeTabId = id;
        return;
      }

      state.tabs.push({
        id,
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

    provide(TabProviderAddTabKey, addTab);
    provide(TabProviderCloseTabKey, closeTab);
  },
  render(): any {
    return this.$slots.default();
  },
};
