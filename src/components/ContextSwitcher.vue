<script setup lang="ts">
import { Command } from "@/command-palette";
import { injectStrict } from "@/lib/utils";
import { error } from "@/lib/logger";
import { Kubernetes } from "@/services/Kubernetes";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  RegisterCommandStateKey,
  CloseCommandPaletteKey,
  RerunLastCommandKey,
} from "@/providers/CommandPaletteProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";

import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import DropdownMenuItem from "./ui/dropdown-menu/DropdownMenuItem.vue";
import Spinner from "./Spinner.vue";

import {
  KubeContextSetActiveNamespacesKey,
  KubeContextSwitchContextKey,
  KubeContextIsContextActiveKey,
  KubeContextIsNamespaceActiveKey,
  KubeContextStateKey,
} from "@/providers/KubeContextProvider";

const {
  contexts: activeContexts,
  context: primaryContext,
  namespace: primaryNamespace,
  authenticated: clusterAuthenticated,
} = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const setActiveNamespaces = injectStrict(KubeContextSetActiveNamespacesKey);
const switchContext = injectStrict(KubeContextSwitchContextKey);
const registerCommand = injectStrict(RegisterCommandStateKey);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const rerunLastCommand = injectStrict(RerunLastCommandKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const isContextActive = injectStrict(KubeContextIsContextActiveKey);
const isNamespaceActive = injectStrict(KubeContextIsNamespaceActiveKey);

interface ContextEntry {
  context: string;
  defaultNamespace: string;
  namespaces: string[];
  isFetching?: boolean;
  canConnect?: boolean;
  canHandleAuth?: boolean;
  handleAuthCallback?: () => void;
  kubeConfig: string;
}

const contexts = ref<ContextEntry[]>([]);

const toggleActiveNamespace = (
  context: string,
  kubeConfig: string,
  namespace: string
) => {
  const ctx = contexts.value.find((ctx) => ctx.context === context);

  if (!ctx) return;

  let namespaces = [...(activeContexts.value.get(context) || [])];

  if (namespace === "all") {
    // Toggling "all namespaces" switches between all and none.
    setActiveNamespaces(
      context,
      kubeConfig,
      namespaces.includes("all") ? [] : ["all"]
    );
    return;
  }

  if (namespaces.includes("all")) {
    // Exiting "all namespaces": fall back to the full namespace list so the
    // user can deselect individual namespaces.
    namespaces = [...ctx.namespaces];
  }

  if (namespaces.includes(namespace)) {
    namespaces = namespaces.filter((ns) => ns !== namespace);
  } else {
    namespaces = [...namespaces, namespace];
  }

  // Selecting every namespace folds back to "all".
  if (
    ctx.namespaces.length > 0 &&
    ctx.namespaces.every((ns) => namespaces.includes(ns))
  ) {
    namespaces = ["all"];
  }

  setActiveNamespaces(context, kubeConfig, namespaces);
};

const fetchContexts = async () => {
  const entries: ContextEntry[] = [];
  for (const kubeConfig of settings.value.kubeConfigs) {
    try {
      const ctx = await Kubernetes.getContexts(kubeConfig);
      entries.push(
        ...ctx.map((ctx) => {
          return {
            context: ctx.name,
            defaultNamespace: ctx.context?.namespace,
            namespaces: [],
            kubeConfig: kubeConfig,
          };
        })
      );
    } catch (e) {
      error(`Failed to list contexts of kubeconfig ${kubeConfig}: ${e}`);
    }
  }
  contexts.value = entries;
};

/*
 * Namespaces for a context, from the cluster settings when configured.
 * Throws when the namespaces cannot be listed.
 */
const listNamespaces = async (
  context: string,
  kubeConfig: string
): Promise<string[]> => {
  const clusterSettings = settings.value.contextSettings.find(
    (c) => c.context === context
  );

  if (clusterSettings?.namespaces && clusterSettings.namespaces.length > 0) {
    return clusterSettings.namespaces;
  }

  const namespaces = await Kubernetes.getNamespaces(context, kubeConfig);
  return namespaces.map((ns) => ns.metadata?.name || "");
};

/*
 * Offers the interactive login flow for contexts using exec auth plugins
 * (kubelogin / OIDC) and re-runs the palette command once logged in.
 */
const spawnAuthDialog = (authErrorHandler: {
  callback: (cb: (instructions?: string) => void) => void;
}) => {
  clusterAuthenticated.value = false;
  spawnDialog({
    title: "Authentication required",
    message:
      "Failed to authenticate with this cluster. Please log in to continue.",
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
        label: "Login",
        handler: async (dialog) => {
          dialog.buttons = [];
          dialog.title = "Awaiting login";
          dialog.message = "Please wait while we complete the login flow.";
          authErrorHandler.callback((instructions?: string) => {
            if (instructions) {
              dialog.title = "Complete login in your browser";
              // The dialog only renders plain text, and plugin output can be
              // long - keep the most useful part.
              dialog.message = instructions.slice(0, 2000);
              dialog.buttons = [
                {
                  label: "I've completed the login",
                  handler: (dialog) => {
                    dialog.close();
                    clusterAuthenticated.value = true;
                    rerunLastCommand();
                  },
                },
              ];
            } else {
              dialog.close();
              clusterAuthenticated.value = true;
              rerunLastCommand();
            }
          });
        },
      },
    ],
  });
};

const namespaceCommands = (
  namespaces: string[],
  execute: (namespace: string) => void
): Command[] => {
  return [
    {
      id: "all-namespaces",
      name: "All namespaces",
      description: "Show all namespaces",
      execute: () => execute(""),
    } as Command,
  ].concat(
    namespaces.map((namespace) => ({
      id: namespace,
      name: namespace,
      description: "Switch to " + namespace,
      execute: () => execute(namespace),
    }))
  );
};

/*
 * Command palette: single-context switching. Selecting a context + namespace
 * here replaces the whole selection (use the switcher dropdown to combine
 * multiple contexts / namespaces).
 */
onMounted(() => {
  fetchContexts();

  registerCommand({
    id: "switch-context",
    name: "Switch context",
    description: "Switch to a single context",
    keywords: ["ctx", "context"],
    commands: async (): Promise<Command[]> => {
      await fetchContexts();

      return contexts.value.map((context) => ({
        id: `${context.kubeConfig}:${context.context}`,
        name: context.context,
        description: "Switch to " + context.context,
        commands: async (): Promise<Command[]> => {
          let namespaces: string[] = [];
          try {
            namespaces = await listNamespaces(
              context.context,
              context.kubeConfig
            );
          } catch (e: any) {
            const authErrorHandler = await Kubernetes.getAuthErrorHandler(
              context.context,
              context.kubeConfig,
              e.message
            );

            if (authErrorHandler.canHandle) {
              spawnAuthDialog(authErrorHandler);
            } else if (context.defaultNamespace) {
              namespaces = [context.defaultNamespace];
            } else {
              throw e;
            }
          }

          return namespaceCommands(namespaces, (namespace) =>
            switchContext(context.context, context.kubeConfig, namespace)
          );
        },
      }));
    },
  });

  registerCommand({
    id: "switch-namespace",
    name: "Switch namespace",
    description: "Switch the namespace of the current context",
    keywords: ["ns", "namespace"],
    commands: async (): Promise<Command[]> => {
      const context = primaryContext.value;
      const kubeConfig =
        contexts.value.find((c) => c.context === context)?.kubeConfig || "";

      return namespaceCommands(
        await listNamespaces(context, kubeConfig),
        (namespace) =>
          setActiveNamespaces(context, kubeConfig, [namespace || "all"])
      );
    },
  });
});

const selectionSummary = computed(() => {
  if (!primaryContext.value) {
    return "Click here to select contexts";
  }

  if (activeContexts.value.size > 1) {
    return `+ ${activeContexts.value.size - 1} more context${
      activeContexts.value.size > 2 ? "s" : ""
    }`;
  }

  const namespaces = activeContexts.value.get(primaryContext.value) || [];
  if (namespaces.length > 1) {
    return `${namespaces.length} namespaces`;
  }

  return primaryNamespace.value || "All namespaces";
});

const fetchNamespaces = async (context: string) => {
  const ctx = contexts.value.find((ctx) => ctx.context === context);

  if (!ctx) return;
  if (ctx.namespaces.length > 0 || ctx.isFetching) return;

  ctx.isFetching = true;

  try {
    ctx.namespaces = await listNamespaces(context, ctx.kubeConfig);
    ctx.canConnect = true;
  } catch (err: any) {
    if (err.code === 401 || err.code === 403) {
      // No permission to list namespaces; fall back to the context's default
      // namespace so the context can still be used.
      ctx.canConnect = true;
      ctx.namespaces = ctx.defaultNamespace ? [ctx.defaultNamespace] : [];
      return;
    }

    ctx.canConnect = false;

    const authHandler = await Kubernetes.getAuthErrorHandler(
      ctx.context,
      ctx.kubeConfig,
      err.message
    );

    ctx.canHandleAuth = authHandler.canHandle;
    ctx.handleAuthCallback = () => {
      authHandler.callback(() => {
        ctx.canHandleAuth = false;
        fetchNamespaces(context);
      });
    };
  } finally {
    ctx.isFetching = false;
  }
};
</script>
<template>
  <div class="w-full mt-2 mb-4 pr-2">
    <DropdownMenu>
      <DropdownMenuTrigger class="w-full">
        <div
          class="flex flex-col w-full text-xs border rounded-lg p-2 text-left hover:bg-background"
          :title="`Connected to ${activeContexts.size} of ${contexts.length} contexts`"
        >
          <span class="uppercase font-bold mb-1 truncate">
            {{ primaryContext || "No context" }}
          </span>
          <span class="truncate">{{ selectionSummary }}</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="w-[--reka-dropdown-menu-trigger-width] min-w-56 rounded-lg max-h-[80vh] overflow-y-auto"
        align="start"
        side="right"
        :side-offset="4"
      >
        <DropdownMenuLabel class="text-xs text-muted-foreground">
          Contexts
        </DropdownMenuLabel>
        <DropdownMenuSub v-for="context in contexts" :key="context.context">
          <DropdownMenuSubTrigger
            class="py-2"
            @mouseenter="fetchNamespaces(context.context)"
          >
            <div class="flex items-center gap-2 max-w-[225px]">
              <span
                class="block w-2 h-2 rounded-full"
                :class="{
                  'bg-green-500': isContextActive(context.context),
                  'bg-gray-500': !isContextActive(context.context),
                }"
              ></span>
              <span class="whitespace-nowrap truncate">{{
                context.context
              }}</span>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent
              class="max-h-[80vh] overflow-y-auto"
              align="start"
              side="right"
              :side-offset="4"
            >
              <template
                v-if="!context.isFetching && context.namespaces.length > 0"
              >
                <DropdownMenuCheckboxItem
                  :checked="isNamespaceActive(context.context, 'all')"
                  @select.prevent="
                    toggleActiveNamespace(
                      context.context,
                      context.kubeConfig,
                      'all'
                    )
                  "
                >
                  <span>All namespaces</span>
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </template>
              <DropdownMenuLabel v-if="context.isFetching">
                <div class="flex flex-row items-center gap-2">
                  <Spinner class="text-white max-w-[16px]" />
                  <span>Fetching namespaces...</span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuItem
                v-if="
                  !context.isFetching &&
                  context.canHandleAuth &&
                  context.namespaces.length === 0
                "
                @select.prevent="
                  context.handleAuthCallback && context.handleAuthCallback()
                "
              >
                <button class="w-full text-left">
                  <span>Re-authenticate</span>
                </button>
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="
                  !context.isFetching &&
                  !context.canConnect &&
                  !context.canHandleAuth
                "
              >
                <span class="text-red-500">
                  Cannot connect to this context
                </span>
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                v-for="namespace in context.namespaces"
                :key="namespace"
                :value="namespace"
                :checked="isNamespaceActive(context.context, namespace)"
                @select.prevent="
                  toggleActiveNamespace(
                    context.context,
                    context.kubeConfig,
                    namespace
                  )
                "
              >
                <span>{{ namespace }}</span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
