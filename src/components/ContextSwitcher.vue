<script setup lang="ts">
import { Command } from "@/command-palette";
import { injectStrict } from "@/lib/utils";
import {
  ShowSingleCommandKey,
  RegisterCommandStateKey,
} from "@/providers/CommandPaletteProvider";
import {
  KubeContextSetContextKey,
  KubeContextSetNamespaceKey,
} from "@/providers/KubeContextProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { Kubernetes } from "@/services/Kubernetes";

const showSingleCommand = injectStrict(ShowSingleCommandKey);
const registerCommand = injectStrict(RegisterCommandStateKey);
const { context, namespace } = injectStrict(KubeContextStateKey);
const setContext = injectStrict(KubeContextSetContextKey);
const setNamespace = injectStrict(KubeContextSetNamespaceKey);

onMounted(() => {
  registerCommand({
    id: "switch-context",
    name: "Switch context",
    description: "Switch the current context",
    commands: async (): Promise<Command[]> => {
      const contexts = await Kubernetes.getContexts();

      return contexts.map((context) => ({
        id: context,
        name: context,
        description: "Switch to " + context,
        commands: async (): Promise<Command[]> => {
          const namespaces = await Kubernetes.getNamespaces(context);

          return namespaces.map(
            (namespace): Command => ({
              id: namespace.metadata?.name || "",
              name: namespace.metadata?.name || "",
              description: "Switch to " + namespace,
              execute: () => {
                setContext(context);
                setNamespace(namespace.metadata?.name || "");
              },
            })
          );
        },
      }));
    },
  });
});
</script>
<template>
  <div class="w-full mt-2 mb-4 pr-2">
    <button
      class="flex flex-col w-full text-xs border rounded-lg p-2 text-left hover:bg-background"
      @click="showSingleCommand('switch-context')"
    >
      <span class="uppercase font-bold mb-1">{{ context }}</span>
      <span>{{ namespace == "all" ? "All namespaces" : namespace }}</span>
    </button>
  </div>
</template>
