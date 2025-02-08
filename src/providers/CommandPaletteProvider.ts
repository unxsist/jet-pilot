import { Command } from "@/command-palette";
import { error } from "@/lib/logger";
import { provide, reactive, InjectionKey, toRefs, ToRefs } from "vue";

export const RegisterCommandStateKey: InjectionKey<(command: Command) => void> =
  Symbol("RegisterComand");
export const UnregisterCommandStateKey: InjectionKey<(id: string) => void> =
  Symbol("UnregisterCommand");
export const CommandPaletteStateKey: InjectionKey<ToRefs<CommandPaletteState>> =
  Symbol("CommandPaletteState");
export const OpenCommandPaletteKey: InjectionKey<() => void> =
  Symbol("OpenCommandPalette");
export const CloseCommandPaletteKey: InjectionKey<() => void> = Symbol(
  "CloseCommandPalette"
);
export const ExecuteCommandKey: InjectionKey<(command: Command) => void> =
  Symbol("ExecuteCommand");
export const RerunLastCommandKey: InjectionKey<() => void> =
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
  name: "CommandPaletteProvider",
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

    const unregisterCommand = (commandId: string) => {
      const command = state.commands.find(
        (command) => command.id === commandId
      );

      if (!command) {
        return;
      }

      state.commands = state.commands.filter(
        (command) => command.id !== commandId
      );
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
          .catch((e) => {
            error(`Failed to execute command: ${e.message}`);
            state.loading = false;
            state.executionError = e.message;
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

    const rerunLastCommand = () => {
      const lastCommand = Array.from(state.callStack.keys())[
        state.callStack.size - 1
      ];

      if (!lastCommand) {
        return;
      }

      pop();
      executeCommand(lastCommand);
    };

    provide(OpenCommandPaletteKey, open);
    provide(CloseCommandPaletteKey, close);
    provide(ExecuteCommandKey, executeCommand);
    provide(RerunLastCommandKey, rerunLastCommand);
    provide(ClearCommandCallStackKey, clearStack);
    provide(ShowSingleCommandKey, showSingleCommand);
    provide(RegisterCommandStateKey, registerCommand);
    provide(UnregisterCommandStateKey, unregisterCommand);
  },
  render(): any {
    return this.$slots.default();
  },
};
