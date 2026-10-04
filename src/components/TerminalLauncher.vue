<script setup lang="ts">
import { useMagicKeys } from "@vueuse/core";
import { injectStrict } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { RegisterCommandStateKey } from "@/providers/CommandPaletteProvider";
import {
  PanelProviderAddTabKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";

/*
 * Opens local terminals with kubectl preconfigured for the current (primary)
 * context: "Open terminal" in the command palette always opens a new one,
 * Ctrl+` focuses the terminal of the current context or opens one.
 */
const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);
const { tabs } = injectStrict(PanelProviderStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const registerCommand = injectStrict(RegisterCommandStateKey);
const { toast } = useToast();

const tabIdPrefix = (ctx: string) => `terminal_${ctx}_`;

const openTerminal = (reuseExisting = false) => {
  const ctx = context.value;

  if (!ctx) {
    toast({
      title: "No context selected",
      description: "Select a context to open a terminal for.",
      variant: "destructive",
    });
    return;
  }

  if (reuseExisting) {
    const existing = tabs.value.find((tab) =>
      tab.id.startsWith(tabIdPrefix(ctx))
    );

    if (existing) {
      addTab(existing.id, existing.title, existing.component);
      return;
    }
  }

  addTab(
    `${tabIdPrefix(ctx)}${Date.now()}`,
    `Terminal: ${ctx}`,
    defineAsyncComponent(() => import("@/views/Terminal.vue")),
    {
      context: ctx,
      namespace: namespace.value,
      kubeConfig: kubeConfig.value,
    },
    "shell"
  );
};

registerCommand({
  id: "open-terminal",
  name: "Open terminal",
  description: "Open a local terminal with kubectl set to the current context",
  keywords: ["terminal", "shell", "console", "kubectl"],
  execute: () => openTerminal(),
});

const keys = useMagicKeys();
const shortcut = keys["Ctrl+Backquote"];

watch(shortcut, (pressed) => {
  if (pressed) {
    openTerminal(true);
  }
});
</script>

<template>
  <slot />
</template>
