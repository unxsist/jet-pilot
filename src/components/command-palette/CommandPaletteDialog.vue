<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import type { Component } from "vue";
import type { Command } from "@/command-palette";
import { Kbd } from "@/components/ui/kbd";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { kindIcon } from "@/lib/kindIcons";
import {
  ArrowLeftRight,
  ChevronRight,
  CornerDownLeft,
  CornerDownRight,
  FolderTree,
  Loader2,
  SearchX,
  SquareTerminal,
  Sparkles,
  TriangleAlert,
} from "lucide-vue-next";

import {
  CommandPaletteStateKey,
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

/* Navigation commands are registered by the sidebar items. */
const isNavigation = (command: Command) =>
  command.description?.startsWith("Navigate to") ?? false;

const { open, commands, callStack, loading, executionError } = injectStrict(
  CommandPaletteStateKey
);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const clearCallStack = injectStrict(ClearCommandCallStackKey);
const executeCommand = injectStrict(ExecuteCommandKey);

const actionCommands = computed(() =>
  commands.value.filter((command) => !isNavigation(command))
);
const navigationCommands = computed(() =>
  commands.value.filter((command) => isNavigation(command))
);

/* Names of the commands drilled into, e.g. Switch context › prod. */
const breadcrumbs = computed(() =>
  Array.from(callStack.value.keys()).map((command) => command.name)
);

/* Options of "Switch context" are contexts: show their monogram. */
const isContextList = computed(() => {
  const keys = Array.from(callStack.value.keys());
  return keys.length === 1 && keys[0].id === "switch-context";
});

const ACTION_ICONS: Record<string, Component> = {
  "switch-context": ArrowLeftRight,
  "switch-namespace": FolderTree,
  "open-terminal": SquareTerminal,
};

const commandIcon = (command: Command): Component => {
  if (isNavigation(command)) {
    const name = command.name.toLowerCase();
    if (name.startsWith("helm")) return kindIcon("helm");
    if (name === "resource graph") return kindIcon("diagram");
    return kindIcon(name.replace(/\s+/g, ""));
  }
  return ACTION_ICONS[command.id] ?? Sparkles;
};

/* Options below a context / "Switch namespace" are namespaces. */
const subCommandIcon = (command: Command): Component =>
  command.id === "all-namespaces" ||
  Array.from(callStack.value.keys()).some((c) =>
    ["switch-context", "switch-namespace"].includes(c.id)
  )
    ? FolderTree
    : CornerDownRight;

</script>
<template>
  <div
    v-show="open"
    class="fixed inset-0 z-40"
    @click.self="closeCommandPalette"
  >
    <CommandDialog
      :open="open"
      ref="commandDialog"
      @update:open="
        () => {
          clearCallStack();
          closeCommandPalette();
        }
      "
    >
      <div
        v-if="breadcrumbs.length > 0"
        class="flex items-center gap-1 border-b px-4 py-2 text-xs text-muted-foreground"
        aria-label="Command path"
      >
        <template v-for="(crumb, index) in breadcrumbs" :key="index">
          <ChevronRight v-if="index > 0" class="h-3 w-3" aria-hidden="true" />
          <span
            class="rounded-md border bg-surface-2 px-1.5 py-0.5 font-medium text-foreground"
            >{{ crumb }}</span
          >
        </template>
        <span class="ml-auto flex items-center gap-1.5">
          <Kbd size="sm">esc</Kbd> back
        </span>
      </div>
      <div class="relative">
        <CommandInput
          :placeholder="
            breadcrumbs.length > 0
              ? `Search ${breadcrumbs[breadcrumbs.length - 1].toLowerCase()}…`
              : 'Type a command or search…'
          "
        />
        <Loader2
          v-if="loading"
          class="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-label="Loading"
        />
      </div>
      <CommandList>
        <CommandEmpty>
          <div class="flex flex-col items-center gap-2">
            <SearchX class="h-5 w-5 text-muted-foreground" />
            No results found.
          </div>
        </CommandEmpty>
        <template v-if="callStack.size === 0">
          <CommandGroup v-if="actionCommands.length > 0" heading="Actions">
            <CommandItem
              v-for="command in actionCommands"
              :key="command.id"
              :value="command"
              @select="executeCommand(command)"
            >
              <component :is="commandIcon(command)" class="h-4 w-4" />
              <span class="truncate">{{ command.name }}</span>
              <span class="ml-1 truncate text-xs text-muted-foreground">{{
                command.description
              }}</span>
              <ChevronRight
                v-if="command.commands"
                class="ml-auto h-3.5 w-3.5"
              />
            </CommandItem>
          </CommandGroup>
          <CommandGroup v-if="navigationCommands.length > 0" heading="Go to">
            <CommandItem
              v-for="command in navigationCommands"
              :key="command.id"
              :value="command"
              @select="executeCommand(command)"
            >
              <component :is="commandIcon(command)" class="h-4 w-4" />
              <span class="truncate">{{ command.name }}</span>
              <CornerDownLeft
                class="ml-auto h-3.5 w-3.5 opacity-0 transition-opacity [[data-highlighted]_&]:opacity-100"
              />
            </CommandItem>
          </CommandGroup>
        </template>
        <CommandGroup v-else :heading="breadcrumbs[breadcrumbs.length - 1]">
          <template
            v-for="(command, index) in callStack.get(
              Array.from(callStack.keys())[callStack.size - 1]
            )"
            :key="index"
          >
            <CommandItem :value="command" @select="executeCommand(command)">
              <ContextAvatar
                v-if="isContextList"
                :name="command.name"
                size="sm"
              />
              <component :is="subCommandIcon(command)" v-else class="h-4 w-4" />
              <span class="truncate">{{ command.name }}</span>
              <ChevronRight
                v-if="command.commands"
                class="ml-auto h-3.5 w-3.5"
              />
            </CommandItem>
          </template>
        </CommandGroup>
      </CommandList>
      <div
        v-if="executionError"
        role="alert"
        class="flex items-start gap-2.5 border-t border-destructive/20 bg-destructive/[0.06] px-4 py-2.5"
      >
        <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div class="min-w-0">
          <div class="text-sm font-medium text-foreground">
            Something went wrong
          </div>
          <div
            class="truncate text-xs text-muted-foreground"
            :title="executionError"
          >
            {{ executionError }}
          </div>
        </div>
      </div>
    </CommandDialog>
  </div>
</template>
