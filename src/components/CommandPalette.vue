<script setup lang="ts">
import { useMagicKeys } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";
import Loading from "@/assets/icons/loading.svg";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import Error from "@/assets/icons/error.svg";

import {
  CommandPaletteStateKey,
  OpenCommandPaletteKey,
  CloseCommandPaletteKey,
  ClearCommandCallStackKey,
  ExecuteCommandKey,
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

const { open, commands, callStack, loading, executionError } = injectStrict(
  CommandPaletteStateKey
);
const openCommandPalette = injectStrict(OpenCommandPaletteKey);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const clearCallStack = injectStrict(ClearCommandCallStackKey);
const executeCommand = injectStrict(ExecuteCommandKey);

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
</script>
<template>
  <div
    v-show="open"
    class="fixed w-full h-full py-10 backdrop-blur-xxs"
    @click.self="closeCommandPalette"
  >
    <CommandDialog
      :open="open"
      @update:open="
        () => {
          clearCallStack();
          closeCommandPalette();
        }
      "
    >
      <CommandInput placeholder="Type a command or search..." />
      <div v-if="loading" class="absolute top-1.5 right-1.5 z-50 bg-background">
        <Loading class="z-50 w-7 h-7 animate-spin-fast" />
      </div>
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
      <Alert
        variant="destructive"
        class="absolute top-full mt-2 bg-background"
        v-if="executionError"
      >
        <Error class="w-4 h-4" />
        <AlertTitle>Something went wrong!</AlertTitle>
        <AlertDescription class="text-xs truncate" :title="executionError">{{
          executionError
        }}</AlertDescription>
      </Alert>
    </CommandDialog>
  </div>
</template>
