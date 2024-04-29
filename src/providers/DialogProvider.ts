import { ToRefs } from "vue";
import { buttonVariants } from "@/components/ui/button";

export const DialogProviderStateKey: InjectionKey<ToRefs<DialogProviderState>> =
  Symbol("DialogProviderState");

export const DialogProviderSpawnDialogKey: InjectionKey<
  (dialog: BaseDialogInterface) => void
> = Symbol("DialogProviderSpawnDialog");

export interface DialogButtonInterface {
  label: string;
  variant?: NonNullable<Parameters<typeof buttonVariants>[0]>["variant"];
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
  name: "DialogProvider",
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
