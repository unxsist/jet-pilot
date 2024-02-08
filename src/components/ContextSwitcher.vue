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
    keywords: ["ctx", "context"],
    commands: async (): Promise<Command[]> => {
      const contexts = await Kubernetes.getContexts();

      return contexts.map((context) => ({
        id: context,
        name: context,
        description: "Switch to " + context,
        commands: async (): Promise<Command[]> => {
          const namespaces = await Kubernetes.getNamespaces(context);

          return [
            {
              id: "all-namespaces",
              name: "All namespaces",
              description: "Show all namespaces",
              execute: () => {
                setContext(context);
                setNamespace("");
              },
            } as Command,
          ].concat(
            namespaces.map((namespace) => ({
              id: namespace.metadata?.name || "",
              name: namespace.metadata?.name || "",
              description: "Switch to " + namespace,
              execute: () => {
                setContext(context);
                setNamespace(namespace.metadata?.name || "");
              },
            }))
          );
        },
      }));
    },
  });

  registerCommand({
    name: "Switch namespace",
    description: "Switch the current namespace",
    id: "switch-namespace",
    keywords: ["ns", "namespace"],
    commands: async (): Promise<Command[]> => {
      const namespaces = await Kubernetes.getNamespaces(context.value);

      return [
        {
          id: "all-namespaces",
          name: "All namespaces",
          description: "Show all namespaces",
          execute: () => {
            setNamespace("");
          },
        } as Command,
      ].concat(
        namespaces.map((namespace) => ({
          id: namespace.metadata?.name || "",
          name: namespace.metadata?.name || "",
          description: "Switch to " + namespace,
          execute: () => {
            setNamespace(namespace.metadata?.name || "");
          },
        }))
      );
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
      <span class="uppercase font-bold mb-1">{{
        context || "No context"
      }}</span>
      <span v-if="context">{{
        namespace == "" ? "All namespaces" : namespace
      }}</span>
      <span v-else>Click here to set context</span>
    </button>
  </div>
</template>
