import { Command } from "@/command-palette";
import { SwitchContext } from "@/command-palette/SwitchContext";
import { injectStrict } from "@/lib/utils";
import {
  KubeContextSetContextKey,
  KubeContextSetNamespaceKey,
} from "@/providers/KubeContextProvider";
import { provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";

export const RegisterCommandStateKey: InjectionKey<(command: Command) => void> =
  Symbol("RegisterComand");
export const CommandPaletteStateKey: InjectionKey<ToRefs<CommandPaletteState>> =
  Symbol("CommandPaletteState");
export const OpenCommandPaletteKey: InjectionKey<() => void> =
  Symbol("OpenCommandPalette");
export const CloseCommandPaletteKey: InjectionKey<() => void> = Symbol(
  "CloseCommandPalette"
);
export const PushCommandKey: InjectionKey<
  (command: Command, options: Command[]) => void
> = Symbol("PushCommand");
export const ClearCommandCallStackKey: InjectionKey<() => void> = Symbol(
  "ClearCommandCallStack"
);
export const ShowSingleCommandKey: InjectionKey<(id: string) => void> =
  Symbol("ShowSingleCommand");

export interface CommandPaletteState {
  open: boolean;
  callStack: Map<Command, Command[]>;
  commands: Command[];
}

export default {
  setup() {
    const singleCommand = ref(false);

    const state: CommandPaletteState = reactive({
      open: false,
      callStack: new Map<Command, Command[]>(),
      commands: [
        SwitchContext(
          injectStrict(KubeContextSetContextKey),
          injectStrict(KubeContextSetNamespaceKey)
        ),
      ],
    });

    provide(CommandPaletteStateKey, toRefs(state));

    const open = () => {
      state.open = true;
    };

    const close = () => {
      if (singleCommand.value && state.callStack.size === 1) {
        singleCommand.value = false;
        clearStack();
      }

      if (state.callStack.size > 0) {
        pop();
        return;
      }

      state.open = false;
    };

    const push = (command: Command, options: Command[]) => {
      state.callStack.set(command, options);
    };

    const pop = () => {
      const lastCommand = Array.from(state.callStack.keys())[
        state.callStack.size - 1
      ];
      state.callStack.delete(lastCommand);
    };

    const clearStack = () => {
      state.callStack.clear();
    };

    const showSingleCommand = (id: string) => {
      const command = state.commands.find((command) => command.id === id);

      if (!command) {
        return;
      }

      if (command.commands) {
        command.commands().then((commands: Command[]) => {
          push(command, commands);
          singleCommand.value = true;
          open();
        });
      }
    };

    const registerCommand = (command: Command) => {
      state.commands.push(command);
    };

    provide(OpenCommandPaletteKey, open);
    provide(CloseCommandPaletteKey, close);
    provide(PushCommandKey, push);
    provide(ClearCommandCallStackKey, clearStack);
    provide(ShowSingleCommandKey, showSingleCommand);
    provide(RegisterCommandStateKey, registerCommand);
  },
  render(): any {
    return this.$slots.default();
  },
};
