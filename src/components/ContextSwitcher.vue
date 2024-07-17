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

const {
  context,
  namespace,
  authenticated: clusterAuthenticated,
} = injectStrict(KubeContextStateKey);
const setContext = injectStrict(KubeContextSetContextKey);
const setNamespace = injectStrict(KubeContextSetNamespaceKey);
const { settings } = injectStrict(SettingsContextStateKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);

const needsMarquee = ref(false);
const marqueeContainer = ref<HTMLDivElement | null>();
const marqueeText = ref<HTMLDivElement | null>();

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
                context.kubeConfig,
                e.message
              );

              if (authErrorHandler.canHandle) {
                clusterAuthenticated.value = false;
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
                          clusterAuthenticated.value = true;
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

  setInterval(() => {
    if (
      marqueeContainer.value &&
      marqueeText.value &&
      marqueeText.value.offsetWidth > marqueeContainer.value.offsetWidth
    ) {
      needsMarquee.value = true;
    } else {
      needsMarquee.value = false;
    }
  }, 1000);
});
</script>
<template>
  <div class="w-full mt-2 mb-4 pr-2">
    <button
      class="flex flex-col w-full text-xs border rounded-lg p-2 text-left hover:bg-background"
      @click="showSingleCommand('switch-context')"
    >
      <div
        ref="marqueeContainer"
        class="overflow-hidden whitespace-nowrap uppercase font-bold mb-1 w-full"
        :title="context"
      >
        <div
          ref="marqueeText"
          class="inline-block"
          :class="{ marquee: needsMarquee }"
        >
          {{ context || "No context" }}
        </div>
      </div>
      <span v-if="context">{{
        namespace == "" ? "All namespaces" : namespace
      }}</span>
      <span v-else>Click here to set context</span>
    </button>
  </div>
</template>

<style scoped>
.marquee-container {
  overflow: hidden;
  white-space: nowrap;
  /* width: 100%; */
}

.marquee {
  display: inline-block;
  /* transform: translateX(0%);
  margin-left: 0%; */
  animation: marquee 30s linear infinite;
  animation-delay: 0s, 5;
}

@keyframes marquee {
  0% {
    transform: translateX(0%);
    margin-left: 0%;
  }
  25% {
    transform: translateX(-100%);
    margin-left: 100%;
  }
  50% {
    transform: translateX(-100%);
    margin-left: 100%;
  }
  75% {
    transform: translateX(0%);
    margin-left: 0%;
  }
  100% {
    transform: translateX(0%);
    margin-left: 0%;
  }
}
</style>
