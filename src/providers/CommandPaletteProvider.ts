import { Command } from "@/command-palette";
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
export const ExecuteCommandKey: InjectionKey<(command: Command) => void> =
  Symbol("ExecuteCommand");
export const ClearCommandCallStackKey: InjectionKey<() => void> = Symbol(
  "ClearCommandCallStack"
);
export const ShowSingleCommandKey: InjectionKey<(id: string) => void> =
  Symbol("ShowSingleCommand");

export interface CommandPaletteState {
  open: boolean;
  callStack: Map<Command, Command[]>;
  commands: Command[];
  commandCache: Map<string, Command[]>;
  loading: boolean;
  executionError: string | null;
}

export default {
  setup() {
    const singleCommand = ref(false);

    const state: CommandPaletteState = reactive({
      open: false,
      callStack: new Map<Command, Command[]>(),
      commands: [],
      commandCache: new Map<string, Command[]>(),
      loading: false,
      executionError: null,
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

      singleCommand.value = true;
      executeCommand(command);
      open();
    };

    const registerCommand = (command: Command) => {
      state.commands.push(command);
    };

    const executeCommand = (command: Command) => {
      if (command.commands) {
        state.loading = true;

        if (state.commandCache.has(command.id)) {
          push(command, state.commandCache.get(command.id) as Command[]);
        }

        command
          .commands()
          .then((commands: Command[]) => {
            state.commandCache.set(command.id, commands);

            if (state.callStack.has(command)) {
              state.callStack.delete(command);
            }

            push(command, commands);

            state.loading = false;
          })
          .catch((error) => {
            state.loading = false;
            state.executionError = error.message;
            setTimeout(() => {
              state.executionError = null;
            }, 2500);
          });
      } else {
        command.execute();
        clearStack();
        close();
      }
    };

    provide(OpenCommandPaletteKey, open);
    provide(CloseCommandPaletteKey, close);
    provide(ExecuteCommandKey, executeCommand);
    provide(ClearCommandCallStackKey, clearStack);
    provide(ShowSingleCommandKey, showSingleCommand);
    provide(RegisterCommandStateKey, registerCommand);
  },
  render(): any {
    return this.$slots.default();
  },
};
