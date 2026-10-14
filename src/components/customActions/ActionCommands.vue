<script setup lang="ts">
/*
 * Custom actions in the command palette ("Run: Open in Grafana") and on
 * their shortcuts, for the objects you are on: the selected rows of the
 * visible table, else the row under the keyboard cursor, else the side
 * panel's object. Only actions whose scope matches are offered.
 */
import { useEventListener } from "@vueuse/core";
import { type as osType } from "@tauri-apps/plugin-os";
import { useCustomActions } from "@/lib/customActions/store";
import { focusedObjects } from "@/lib/customActions/focus";
import { matchesAll } from "@/lib/customActions/scope";
import { matchesShortcut, shortcutKeys } from "@/lib/customActions/shortcut";
import { runCustom } from "@/lib/customActions/rowActions";
import type { CustomAction } from "@/lib/customActions/types";
import {
  RegisterCommandStateKey,
  UnregisterCommandStateKey,
} from "@/providers/CommandPaletteProvider";
import { PanelProviderAddTabKey, PanelProviderStateKey } from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";

const registerCommand = injectStrict(RegisterCommandStateKey);
const unregisterCommand = injectStrict(UnregisterCommandStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);
const { context, kubeConfig } = injectStrict(KubeContextStateKey);
const { actions } = useCustomActions();
const isMac = osType() === "macos";

const host = () => ({
  addTab,
  spawnDialog,
  primary: { context: context.value, kubeConfig: kubeConfig.value },
});

/* What the actions run on right now. */
const subjects = computed<Record<string, any>[]>(() => {
  const focused = focusedObjects();
  if (focused.length) return [...focused];
  const resource = sidePanel.value?.props?.resource;
  return resource?.kind && resource?.metadata?.name ? [resource] : [];
});

const subjectWords = (objects: Record<string, any>[]) =>
  objects.length === 1 ? `On ${objects[0]!.metadata.name}` : `On ${objects.length} selected objects`;

const available = computed(() => actions.value.filter((action) => matchesAll(action, subjects.value)));

const run = (action: CustomAction) => void runCustom(action, subjects.value, host());

/* Registered commands follow the available actions (not every cursor move). */
const COMMAND_PREFIX = "custom-action:";
const registered = new Set<string>();
const signature = computed(() =>
  JSON.stringify([available.value.map((action) => [action.id, action.name, action.shortcut]), subjectWords(subjects.value)])
);
watch(
  signature,
  () => {
    for (const id of registered) unregisterCommand(id);
    registered.clear();
    if (!subjects.value.length) return;
    for (const action of available.value) {
      const id = `${COMMAND_PREFIX}${action.id}`;
      registerCommand({
        id,
        name: `Run: ${action.name}`,
        description: subjectWords(subjects.value),
        keywords: ["custom action", action.description, action.id].filter(Boolean),
        ...(action.shortcut ? { shortcut: shortcutKeys(action.shortcut, isMac) } : {}),
        execute: () => run(action),
      });
      registered.add(id);
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => registered.forEach((id) => unregisterCommand(id)));

/* Shortcuts: not while typing, not over a dialog. */
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.repeat || !event.code) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("input, textarea, select, [contenteditable=true], .monaco-editor, .xterm")) return;
  if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
  const action = available.value.find(
    (candidate) => candidate.shortcut && matchesShortcut(candidate.shortcut, event, isMac)
  );
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  run(action);
});
</script>

<template>
  <slot />
</template>
