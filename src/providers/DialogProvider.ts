import { ToRefs } from "vue";

export const DialogProviderStateKey: InjectionKey<ToRefs<DialogProviderState>> =
  Symbol("DialogProviderState");

export const DialogProviderSpawnDialogKey: InjectionKey<
  (dialog: DialogInterface) => void
> = Symbol("DialogProviderSpawnDialog");

export interface DialogButtonInterface {
  label: string;
  handler: (dialog: DialogInterface) => void;
}

export interface BaseDialogInterface {
  title: string;
  message: string;
  buttons: DialogButtonInterface[];
}

export interface DialogInterface extends BaseDialogInterface {
  close: () => void;
}

export interface DialogProviderState {
  dialog: DialogInterface | null;
}

export default {
  setup() {
    const state: DialogProviderState = reactive({
      dialog: null,
    });

    provide(DialogProviderStateKey, toRefs(state));

    const spawnDialog = (dialog: BaseDialogInterface) => {
      state.dialog = { ...dialog, close: () => (state.dialog = null) };
    };

    provide(DialogProviderSpawnDialogKey, spawnDialog);
  },
  render(): any {
    return this.$slots.default();
  },
};
