<script setup lang="ts">
import { Command } from "@/command-palette";
import { injectStrict } from "@/lib/utils";
import {
  ShowSingleCommandKey,
  RegisterCommandStateKey,
  CloseCommandPaletteKey,
  RerunLastCommandKey,
} from "@/providers/CommandPaletteProvider";
import {
  KubeContextSetContextKey,
  KubeContextSetNamespaceKey,
} from "@/providers/KubeContextProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { Kubernetes } from "@/services/Kubernetes";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";

const showSingleCommand = injectStrict(ShowSingleCommandKey);
const registerCommand = injectStrict(RegisterCommandStateKey);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const rerunLastCommand = injectStrict(RerunLastCommandKey);
const { context, namespace } = injectStrict(KubeContextStateKey);
const setContext = injectStrict(KubeContextSetContextKey);
const setNamespace = injectStrict(KubeContextSetNamespaceKey);
const { settings } = injectStrict(SettingsContextStateKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

onMounted(() => {
  registerCommand({
    id: "switch-context",
    name: "Switch context",
    description: "Switch the current context",
    keywords: ["ctx", "context"],
    commands: async (): Promise<Command[]> => {
      const contexts: { context: string; kubeConfig: string }[] = [];
      for (const kubeConfig of settings.value.kubeConfigs) {
        await Kubernetes.setCurrentKubeConfig(kubeConfig);
        const ctx = await Kubernetes.getContexts();
        contexts.push(
          ...ctx.map((ctx) => {
            return { context: ctx, kubeConfig: kubeConfig };
          })
        );
      }

      return contexts.map((context) => ({
        id: context.context,
        name: context.context,
        description: "Switch to " + context,
        commands: async (): Promise<Command[]> => {
          const clusterSettings = settings.value.contextSettings.find(
            (c) => c.context === context.context
          );

          let namespaces: string[] = [];

          if (
            clusterSettings &&
            clusterSettings.namespaces &&
            clusterSettings.namespaces.length > 0
          ) {
            namespaces = clusterSettings.namespaces;
          } else {
            try {
              const contextNamespaces = await Kubernetes.getNamespaces(
                context.context,
                context.kubeConfig
              );
              namespaces = contextNamespaces.map(
                (ns) => ns.metadata?.name || ""
              );
            } catch (e: any) {
              const authErrorHandler = await Kubernetes.getAuthErrorHandler(
                context.context,
                e.message
              );

              if (authErrorHandler.canHandle) {
                spawnDialog({
                  title: "SSO Session expired",
                  message:
                    "Failed to authenticate as the SSO session has expired. Please login again.",
                  buttons: [
                    {
                      label: "Close",
                      variant: "ghost",
                      handler: (dialog) => {
                        dialog.close();
                        closeCommandPalette();
                      },
                    },
                    {
                      label: "Login with SSO",
                      handler: (dialog) => {
                        dialog.buttons = [];
                        dialog.title = "Awaiting SSO login";
                        dialog.message = "Please wait while we redirect you.";
                        authErrorHandler.callback(() => {
                          dialog.close();
                          rerunLastCommand();
                        });
                      },
                    },
                  ],
                });
              } else {
                throw e;
              }
            }
          }

          return [
            {
              id: "all-namespaces",
              name: "All namespaces",
              description: "Show all namespaces",
              execute: async () => {
                await Kubernetes.setCurrentKubeConfig(context.kubeConfig);
                setContext(context);
                setNamespace("");
              },
            } as Command,
          ].concat(
            namespaces.map((namespace) => ({
              id: namespace || "",
              name: namespace || "",
              description: "Switch to " + namespace,
              execute: async () => {
                await Kubernetes.setCurrentKubeConfig(context.kubeConfig);
                setContext(context);
                setNamespace(namespace || "");
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
      const clusterSettings = settings.value.contextSettings.find(
        (c) => c.context === context.value
      );

      let namespaces = [];

      if (
        clusterSettings &&
        clusterSettings.namespaces &&
        clusterSettings.namespaces.length > 0
      ) {
        namespaces = clusterSettings.namespaces;
      } else {
        namespaces = await (
          await Kubernetes.getNamespaces(context.value)
        ).map((ns) => ns.metadata?.name || "");
      }

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
          id: namespace || "",
          name: namespace || "",
          description: "Switch to " + namespace,
          execute: () => {
            setNamespace(namespace || "");
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
