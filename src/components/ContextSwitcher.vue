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
import { Search } from "lucide-vue-next";
import {
  contextKey,
  matchesFilter,
  toggleNamespaceSelection,
} from "@/lib/contextKey";

import {
  KubeContextSetActiveNamespacesKey,
  KubeContextSwitchContextKey,
  KubeContextIsContextActiveKey,
  KubeContextIsNamespaceActiveKey,
  KubeContextStateKey,
} from "@/providers/KubeContextProvider";

const {
  contexts: activeContexts,
  contextKubeConfigMapping: activeKubeConfigs,
  context: primaryContext,
  namespace: primaryNamespace,
  kubeConfig: primaryKubeConfig,
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

/* Context names are only unique per kubeconfig: always look up by both. */
const findContext = (context: string, kubeConfig: string) =>
  contexts.value.find(
    (ctx) => ctx.context === context && ctx.kubeConfig === kubeConfig
  );

/* Active namespaces of a context, scoped to its kubeconfig. */
const activeNamespacesOf = (context: string, kubeConfig: string) =>
  isContextActive(context, kubeConfig)
    ? activeContexts.value.get(context) || []
    : [];

const toggleActiveNamespace = (
  context: string,
  kubeConfig: string,
  namespace: string
) => {
  const ctx = findContext(context, kubeConfig);

  if (!ctx) return;

  setActiveNamespaces(
    context,
    kubeConfig,
    toggleNamespaceSelection(
      activeNamespacesOf(context, kubeConfig),
      ctx.namespaces,
      namespace
    )
  );
};

/* Deactivate every other context, keeping this one's namespace selection. */
const onlyThisContext = (ctx: ContextEntry) => {
  const namespaces = activeNamespacesOf(ctx.context, ctx.kubeConfig);
  switchContext(ctx.context, ctx.kubeConfig, "");
  if (namespaces.length > 0) {
    setActiveNamespaces(ctx.context, ctx.kubeConfig, [...namespaces]);
  }
};

const clearSelection = () => {
  for (const context of [...activeContexts.value.keys()]) {
    setActiveNamespaces(context, activeKubeConfigs.value.get(context) || "", []);
  }
};

const fetchContexts = async () => {
  const entries: ContextEntry[] = [];
  for (const kubeConfig of settings.value.kubeConfigs) {
    try {
      const ctx = await Kubernetes.getContexts(kubeConfig);
      entries.push(
        ...ctx.map((ctx) => {
          // Keep namespaces / connection state that were already fetched.
          const existing = findContext(ctx.name, kubeConfig);
          return (
            existing ?? {
              context: ctx.name,
              defaultNamespace: ctx.context?.namespace,
              namespaces: [],
              kubeConfig: kubeConfig,
            }
          );
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
        id: contextKey(context.context, context.kubeConfig),
        name: context.context,
        description: duplicateContextNames.value.has(context.context)
          ? `Switch to ${context.context} (${kubeConfigLabel(
              context.kubeConfig
            )})`
          : "Switch to " + context.context,
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
    // The options capture the primary context: never show options that were
    // cached while another context was primary.
    cacheKey: () => contextKey(primaryContext.value, primaryKubeConfig.value),
    commands: async (): Promise<Command[]> => {
      const context = primaryContext.value;
      const kubeConfig = primaryKubeConfig.value;

      return namespaceCommands(
        await listNamespaces(context, kubeConfig),
        (namespace) =>
          setActiveNamespaces(context, kubeConfig, [namespace || "all"])
      );
    },
  });
});

const pluralize = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const selectionSummary = computed(() => {
  if (!primaryContext.value) {
    return "Click here to select contexts";
  }

  const namespaces = activeContexts.value.get(primaryContext.value) || [];
  const namespaceSummary =
    namespaces.length > 1
      ? pluralize(namespaces.length, "namespace")
      : primaryNamespace.value || "All namespaces";

  if (activeContexts.value.size > 1) {
    return `${namespaceSummary} · + ${pluralize(
      activeContexts.value.size - 1,
      "more context"
    )}`;
  }

  return namespaceSummary;
});

const contextFilter = ref("");
const namespaceFilters = ref<Record<string, string>>({});
const menuOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

/* Only offer the namespace search when the list is long. */
const NAMESPACE_SEARCH_THRESHOLD = 8;

const filteredContexts = computed(() =>
  contexts.value.filter((ctx) => matchesFilter(ctx.context, contextFilter.value))
);

/* Context names defined in more than one kubeconfig need disambiguation. */
const duplicateContextNames = computed(() => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const ctx of contexts.value) {
    if (seen.has(ctx.context)) duplicates.add(ctx.context);
    seen.add(ctx.context);
  }
  return duplicates;
});

const kubeConfigLabel = (kubeConfig: string) =>
  kubeConfig.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

const filteredNamespaces = (ctx: ContextEntry) =>
  ctx.namespaces.filter((ns) =>
    matchesFilter(
      ns,
      namespaceFilters.value[contextKey(ctx.context, ctx.kubeConfig)] || ""
    )
  );

/*
 * Keys typed into the search inputs must not reach the menu: its typeahead
 * would move focus to a matching item. Escape still closes the menu and
 * ArrowDown moves into the list.
 */
const onSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    return;
  }

  event.stopPropagation();

  if (event.key === "ArrowDown") {
    event.preventDefault();
    const menu = (event.target as HTMLElement).closest('[role="menu"]');
    menu
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
      ?.focus();
  }
};

/* Focus the search input instead of the first item when the menu opens. */
const onMenuOpenAutoFocus = (event: Event) => {
  event.preventDefault();
  nextTick(() => searchInput.value?.focus());
};

watch(menuOpen, (open) => {
  if (!open) {
    contextFilter.value = "";
    namespaceFilters.value = {};
  }
});

const fetchNamespaces = async (entry: ContextEntry) => {
  // Mutate the reactive entry so the template updates.
  const ctx = findContext(entry.context, entry.kubeConfig);

  if (!ctx) return;
  if (ctx.namespaces.length > 0 || ctx.isFetching) return;

  ctx.isFetching = true;

  try {
    ctx.namespaces = await listNamespaces(ctx.context, ctx.kubeConfig);
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
        fetchNamespaces(ctx);
      });
    };
  } finally {
    ctx.isFetching = false;
  }
};

const retryNamespaces = (ctx: ContextEntry) => {
  ctx.canConnect = undefined;
  ctx.canHandleAuth = false;
  ctx.namespaces = [];
  fetchNamespaces(ctx);
};
</script>
<template>
  <div class="w-full mt-2 mb-2 pr-2">
    <DropdownMenu v-model:open="menuOpen">
      <DropdownMenuTrigger
        class="w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
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
        class="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg max-h-[80vh] overflow-y-auto"
        align="start"
        side="right"
        :side-offset="4"
        @open-auto-focus="onMenuOpenAutoFocus"
      >
        <div class="flex items-center gap-2 px-2 py-1.5 border-b mb-1">
          <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref="searchInput"
            v-model="contextFilter"
            type="text"
            placeholder="Search contexts..."
            aria-label="Search contexts"
            class="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
            @keydown="onSearchKeydown"
          />
        </div>
        <DropdownMenuLabel class="text-xs text-muted-foreground">
          Contexts
        </DropdownMenuLabel>
        <DropdownMenuSub
          v-for="context in filteredContexts"
          :key="contextKey(context.context, context.kubeConfig)"
        >
          <DropdownMenuSubTrigger
            class="py-2"
            @mouseenter="fetchNamespaces(context)"
            @focus="fetchNamespaces(context)"
          >
            <div class="flex items-center gap-2 max-w-[225px] min-w-0">
              <span
                class="block shrink-0 w-2 h-2 rounded-full"
                :class="{
                  'bg-green-500': isContextActive(
                    context.context,
                    context.kubeConfig
                  ),
                  'bg-muted-foreground/50': !isContextActive(
                    context.context,
                    context.kubeConfig
                  ),
                }"
              ></span>
              <div class="flex flex-col min-w-0">
                <span class="whitespace-nowrap truncate">{{
                  context.context
                }}</span>
                <span
                  v-if="duplicateContextNames.has(context.context)"
                  class="text-xxs text-muted-foreground truncate"
                  :title="context.kubeConfig"
                  >{{ kubeConfigLabel(context.kubeConfig) }}</span
                >
              </div>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent
              class="max-h-[80vh] overflow-y-auto"
              align="start"
              side="right"
              :side-offset="4"
            >
              <div
                v-if="context.namespaces.length > NAMESPACE_SEARCH_THRESHOLD"
                class="flex items-center gap-2 px-2 py-1.5 border-b mb-1"
              >
                <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  v-model="
                    namespaceFilters[
                      contextKey(context.context, context.kubeConfig)
                    ]
                  "
                  type="text"
                  placeholder="Search namespaces..."
                  aria-label="Search namespaces"
                  class="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
                  @keydown="onSearchKeydown"
                />
              </div>
              <template
                v-if="
                  isContextActive(context.context, context.kubeConfig) &&
                  activeContexts.size > 1
                "
              >
                <DropdownMenuItem @select="onlyThisContext(context)">
                  Only this context
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </template>
              <template
                v-if="!context.isFetching && context.namespaces.length > 0"
              >
                <DropdownMenuCheckboxItem
                  :checked="
                    isNamespaceActive(context.context, 'all', context.kubeConfig)
                  "
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
                  <Spinner class="text-foreground max-w-[16px]" />
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
                Re-authenticate
              </DropdownMenuItem>
              <template
                v-if="
                  !context.isFetching &&
                  context.canConnect === false &&
                  !context.canHandleAuth
                "
              >
                <DropdownMenuLabel class="font-normal text-destructive">
                  Cannot connect to this context
                </DropdownMenuLabel>
                <DropdownMenuItem @select.prevent="retryNamespaces(context)">
                  Retry
                </DropdownMenuItem>
              </template>
              <DropdownMenuCheckboxItem
                v-for="namespace in filteredNamespaces(context)"
                :key="namespace"
                :value="namespace"
                :checked="
                  isNamespaceActive(
                    context.context,
                    namespace,
                    context.kubeConfig
                  )
                "
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
              <DropdownMenuLabel
                v-if="
                  context.namespaces.length > 0 &&
                  filteredNamespaces(context).length === 0
                "
                class="font-normal text-muted-foreground"
              >
                No matching namespaces
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuLabel
          v-if="filteredContexts.length === 0"
          class="font-normal text-muted-foreground"
        >
          {{ contexts.length === 0 ? "No contexts found" : "No matching contexts" }}
        </DropdownMenuLabel>
        <template v-if="activeContexts.size > 0">
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="clearSelection">
            Clear selection
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
