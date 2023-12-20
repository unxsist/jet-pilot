<script setup lang="ts">
import { Command } from "@/command-palette";
import { useMagicKeys } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";

import {
  CommandPaletteStateKey,
  OpenCommandPaletteKey,
  CloseCommandPaletteKey,
  ClearCommandCallStackKey,
  PushCommandKey,
} from "@/providers/CommandPaletteProvider";

import {
  CommandDialog,
  CommandInput,
  CommandEmpty,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

const keys = useMagicKeys();
const cmdK = keys["Cmd+K"];

const { open, commands, callStack } = injectStrict(CommandPaletteStateKey);
const openCommandPalette = injectStrict(OpenCommandPaletteKey);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const clearCallStack = injectStrict(ClearCommandCallStackKey);
const pushCommand = injectStrict(PushCommandKey);

watch(cmdK, (value) => {
  if (value) {
    if (!open.value) {
      openCommandPalette();
    } else {
      closeCommandPalette();
    }
  }
});

const handleEscapeKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    closeCommandPalette();
  }
};

watchEffect(() => {
  if (open.value) {
    window.addEventListener("keydown", handleEscapeKey);
  } else {
    window.removeEventListener("keydown", handleEscapeKey);
  }
});

const executeCommand = (command: Command) => {
  if (command.commands) {
    command.commands().then((commands: Command[]) => {
      pushCommand(command, commands);
    });
  } else {
    command.execute();
    clearCallStack();
    closeCommandPalette();
  }
};
</script>
<template>
  <div
    v-show="open"
    class="fixed w-full h-full py-10 backdrop-blur-xxs"
    @click.self="closeCommandPalette"
  >
    <CommandDialog :open="open">
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup v-if="callStack.size === 0">
          <template v-for="(command, index) in commands" :key="index">
            <CommandItem
              :value="command.name"
              @select="executeCommand(command)"
              >{{ command.name }}</CommandItem
            >
          </template>
        </CommandGroup>
        <CommandGroup title="Command" v-else>
          <template
            v-for="(command, index) in callStack.get(
              Array.from(callStack.keys())[callStack.size - 1]
            )"
            :key="index"
          >
            <CommandItem
              :value="command.name"
              @select="executeCommand(command)"
              >{{ command.name }}</CommandItem
            >
          </template>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  </div>
</template>
