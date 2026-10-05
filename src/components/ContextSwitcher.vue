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
import {
  credential,
  credentialView,
  onRecovered,
  report,
  requestSignIn,
} from "@/lib/auth/center";
/*
 * Unused here since sign-in moved to the auth center, but keep it:
 * evaluating DialogProvider from the sidebar lets rolldown keep merging the
 * shared chunks (kind icons, ...) into the entry chunk. Without it the
 * startup bundle grows by ~2 kB of chunk overhead (measured for 1.42).
 */
import "@/providers/DialogProvider";

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
import ContextAvatar from "./ContextAvatar.vue";
import EnvBadge from "@/components/clusters/EnvBadge.vue";
import { useClusters } from "@/lib/clusters/useClusters";
import { useRouter } from "vue-router";
import {
  ChevronsUpDown,
  KeyRound,
  Loader2,
  RefreshCw,
  LayoutGrid,
  Search,
  TriangleAlert,
  X,
} from "lucide-vue-next";
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
} = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const setActiveNamespaces = injectStrict(KubeContextSetActiveNamespacesKey);
const switchContext = injectStrict(KubeContextSwitchContextKey);
const registerCommand = injectStrict(RegisterCommandStateKey);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const rerunLastCommand = injectStrict(RerunLastCommandKey);
const isContextActive = injectStrict(KubeContextIsContextActiveKey);
const isNamespaceActive = injectStrict(KubeContextIsNamespaceActiveKey);
const clusters = useClusters();
const router = useRouter();

interface ContextEntry {
  context: string;
  defaultNamespace: string;
  namespaces: string[];
  isFetching?: boolean;
  canConnect?: boolean;
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

  const current = activeNamespacesOf(context, kubeConfig);

  // From "All namespaces", picking a namespace narrows down to just that one.
  if (namespace !== "all" && current.includes("all")) {
    setActiveNamespaces(context, kubeConfig, [namespace]);
    return;
  }

  setActiveNamespaces(
    context,
    kubeConfig,
    toggleNamespaceSelection(current, ctx.namespaces, namespace)
  );
};

/*
 * A namespace row is checked only when it is selected explicitly: with
 * "All namespaces" active only that row shows a check mark.
 */
const isNamespaceExplicitlyActive = (
  context: string,
  kubeConfig: string,
  namespace: string
) => activeNamespacesOf(context, kubeConfig).includes(namespace);

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

/* Kubeconfig sources (added + detected files): loaded after the first paint. */
let sourcesModule: Promise<typeof import("@/lib/kubeconfigSources")> | null = null;
const kubeconfigSources = () => (sourcesModule ??= import("@/lib/kubeconfigSources"));

const fetchContexts = async () => {
  const entries: ContextEntry[] = [];
  const { resolveKubeconfigPaths } = await kubeconfigSources();
  for (const kubeConfig of await resolveKubeconfigPaths(settings.value)) {
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
  // Namespaces set for the cluster (Clusters hub › details).
  const configured = clusters.resolve(context, kubeConfig).namespaces;
  if (configured.length > 0) {
    return configured;
  }

  const namespaces = await Kubernetes.getNamespaces(context, kubeConfig);
  return namespaces.map((ns) => ns.metadata?.name || "");
};

/* Whether the auth center knows `ctx` needs a sign-in (and can do it). */
const needsSignIn = (ctx: { context: string; kubeConfig: string }) => {
  const view = credentialView({ context: ctx.context, kubeConfig: ctx.kubeConfig });
  return view.needsSignIn && view.canSignIn;
};

const signIn = (ctx: ContextEntry) => {
  menuOpen.value = false;
  void requestSignIn({ context: ctx.context, kubeConfig: ctx.kubeConfig });
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
  /* Kubeconfig files added, removed or found (Settings › Clusters). */
  void kubeconfigSources().then(({ discoveredKubeconfigs }) =>
    watch(
      () => [
        settings.value.kubeconfig.sources.join("\n"),
        settings.value.kubeconfig.autoDetect,
        discoveredKubeconfigs.value,
      ],
      () => void fetchContexts()
    )
  );

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
          } catch (e: unknown) {
            const target = {
              context: context.context,
              kubeConfig: context.kubeConfig,
            };
            if (report(target, e, "api")) {
              // Picked in the palette: sign in, then show its namespaces.
              closeCommandPalette();
              void requestSignIn(target).then(
                (signedIn) => signedIn && rerunLastCommand()
              );
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
    return "Select a context";
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

/* Short namespace summary of an active context, for the context list. */
const namespaceSummaryOf = (context: string, kubeConfig: string) => {
  const namespaces = activeNamespacesOf(context, kubeConfig);
  if (namespaces.length === 0) return "";
  if (namespaces.includes("all")) return "All namespaces";
  return namespaces.length === 1
    ? namespaces[0]
    : pluralize(namespaces.length, "namespace");
};

const primaryCredential = credential(() => ({
  context: primaryContext.value,
  kubeConfig: primaryKubeConfig.value,
}));
const triggerStatus = computed(() => {
  if (!primaryContext.value) return null;
  return primaryCredential.value.needsSignIn ? "warning" : "success";
});

const contextFilter = ref("");
const namespaceFilters = ref<Record<string, string>>({});
const menuOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

/* Only offer the namespace search when the list is long. */
const NAMESPACE_SEARCH_THRESHOLD = 8;

/*
 * Favourites first; hidden clusters (Clusters hub) only while active or
 * searched for. Aliases are searchable too.
 */
const filteredContexts = computed(() =>
  contexts.value
    .map((ctx) => ({ ctx, meta: clusters.resolve(ctx.context, ctx.kubeConfig) }))
    .filter(
      ({ ctx, meta }) =>
        (matchesFilter(ctx.context, contextFilter.value) ||
          matchesFilter(meta.displayName, contextFilter.value)) &&
        (!meta.hidden || contextFilter.value !== "" || isContextActive(ctx.context, ctx.kubeConfig))
    )
    .sort((a, b) => Number(b.meta.favorite) - Number(a.meta.favorite))
    .map(({ ctx }) => ctx)
);

const primaryCluster = computed(() =>
  primaryContext.value ? clusters.resolve(primaryContext.value, primaryKubeConfig.value) : null
);
const metaOf = (ctx: ContextEntry) => clusters.resolve(ctx.context, ctx.kubeConfig);

const openHub = () => {
  menuOpen.value = false;
  router.push({ name: "ClustersHub" });
};

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
  } catch (err: unknown) {
    // Needs a sign-in: the auth center marks it, the menu offers it.
    if (report({ context: ctx.context, kubeConfig: ctx.kubeConfig }, err, "api")) {
      ctx.canConnect = false;
      return;
    }

    const code = (err as { code?: number } | null)?.code;
    if (code === 401 || code === 403) {
      // No permission to list namespaces; fall back to the context's default
      // namespace so the context can still be used.
      ctx.canConnect = true;
      ctx.namespaces = ctx.defaultNamespace ? [ctx.defaultNamespace] : [];
      return;
    }

    ctx.canConnect = false;
  } finally {
    ctx.isFetching = false;
  }
};

const retryNamespaces = (ctx: ContextEntry) => {
  ctx.canConnect = undefined;
  ctx.namespaces = [];
  fetchNamespaces(ctx);
};

/* Signed in: list the namespaces that failed to load. */
const stopRecovered = onRecovered("*", (target) => {
  const ctx = findContext(target.context, target.kubeConfig);
  if (ctx?.canConnect === false) retryNamespaces(ctx);
});
onUnmounted(stopRecovered);
</script>
<template>
  <div class="w-full">
    <DropdownMenu v-model:open="menuOpen">
      <DropdownMenuTrigger
        class="group flex w-full items-center gap-2.5 rounded-lg border bg-background/60 p-1.5 pr-2 text-left shadow-xs transition-colors duration-fast ease-out hover:border-border-strong hover:bg-background focus-ring focus-visible:ring-offset-sidebar data-[state=open]:border-border-strong data-[state=open]:bg-background"
        :title="`Connected to ${activeContexts.size} of ${contexts.length} contexts`"
      >
        <ContextAvatar
          v-if="primaryContext"
          :name="primaryContext"
          :kube-config="primaryKubeConfig"
          :status="triggerStatus"
        />
        <span
          v-else
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground"
          aria-hidden="true"
        >
          ?
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span
            class="truncate text-sm font-medium leading-5 text-foreground"
            :title="primaryContext"
          >
            {{ primaryCluster?.displayName || "No context" }}
          </span>
          <!-- The environment goes on the second line: the name keeps the width. -->
          <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <EnvBadge
              v-if="primaryCluster?.env && !primaryCluster.envInferred"
              :env="primaryCluster.env"
              quiet
            />
            <span class="truncate">{{ selectionSummary }}</span>
          </span>
        </span>
        <ChevronsUpDown
          class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="w-72 max-h-[80vh] overflow-y-auto p-1 [--avatar-ring:var(--popover)]"
        align="start"
        side="right"
        :side-offset="8"
        @open-auto-focus="onMenuOpenAutoFocus"
      >
        <div class="-mx-1 -mt-1 mb-1 flex items-center gap-2 border-b px-3">
          <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref="searchInput"
            v-model="contextFilter"
            type="text"
            placeholder="Search clusters…"
            aria-label="Search clusters"
            class="h-9 w-full bg-transparent text-sm placeholder:text-muted-foreground/80 focus:outline-none"
            @keydown="onSearchKeydown"
          />
        </div>
        <DropdownMenuLabel class="flex items-center justify-between">
          <span>Clusters</span>
          <span class="font-normal tabular-nums">{{ activeContexts.size }} active</span>
        </DropdownMenuLabel>
        <DropdownMenuSub
          v-for="context in filteredContexts"
          :key="contextKey(context.context, context.kubeConfig)"
        >
          <DropdownMenuSubTrigger
            class="gap-2.5 py-2"
            @mouseenter="fetchNamespaces(context)"
            @focus="fetchNamespaces(context)"
          >
            <ContextAvatar
              :name="context.context"
              :kube-config="context.kubeConfig"
              size="sm"
              :status="
                isContextActive(context.context, context.kubeConfig)
                  ? needsSignIn(context)
                    ? 'warning'
                    : 'success'
                  : null
              "
            />
            <div class="min-w-0 flex-1">
              <span
                class="block truncate"
                :class="{
                  'font-medium': isContextActive(
                    context.context,
                    context.kubeConfig
                  ),
                }"
                :title="context.context"
                >{{ metaOf(context).displayName }}</span
              >
              <span
                v-if="
                  duplicateContextNames.has(context.context) ||
                  isContextActive(context.context, context.kubeConfig)
                "
                class="block truncate text-xs text-muted-foreground"
                :title="context.kubeConfig"
              >
                {{
                  [
                    namespaceSummaryOf(context.context, context.kubeConfig),
                    duplicateContextNames.has(context.context)
                      ? kubeConfigLabel(context.kubeConfig)
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                }}
              </span>
            </div>
            <EnvBadge
              v-if="metaOf(context).env && !metaOf(context).envInferred"
              :env="metaOf(context).env"
              quiet
            />
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent
              class="max-h-[80vh] w-60 overflow-y-auto"
              align="start"
              side="right"
              :side-offset="6"
            >
              <div
                v-if="context.namespaces.length > NAMESPACE_SEARCH_THRESHOLD"
                class="-mx-1 -mt-1 mb-1 flex items-center gap-2 border-b px-3"
              >
                <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  v-model="
                    namespaceFilters[
                      contextKey(context.context, context.kubeConfig)
                    ]
                  "
                  type="text"
                  placeholder="Search namespaces…"
                  aria-label="Search namespaces"
                  class="h-9 w-full bg-transparent text-sm placeholder:text-muted-foreground/80 focus:outline-none"
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
                  <span class="font-medium">All namespaces</span>
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Namespaces</DropdownMenuLabel>
              </template>
              <DropdownMenuLabel
                v-if="context.isFetching"
                class="flex items-center gap-2 py-2 font-normal"
              >
                <Loader2 class="h-3.5 w-3.5 animate-spin" />
                <span>Fetching namespaces…</span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                v-if="
                  !context.isFetching &&
                  context.namespaces.length === 0 &&
                  needsSignIn(context)
                "
                @select="signIn(context)"
              >
                <KeyRound class="h-3.5 w-3.5 text-warning" />
                Sign in…
              </DropdownMenuItem>
              <template
                v-if="
                  !context.isFetching &&
                  context.canConnect === false &&
                  !needsSignIn(context)
                "
              >
                <DropdownMenuLabel
                  class="flex items-center gap-2 font-normal text-destructive"
                >
                  <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
                  Cannot connect to this context
                </DropdownMenuLabel>
                <DropdownMenuItem @select.prevent="retryNamespaces(context)">
                  <RefreshCw class="h-3.5 w-3.5 text-muted-foreground" />
                  Retry
                </DropdownMenuItem>
              </template>
              <DropdownMenuCheckboxItem
                v-for="namespace in filteredNamespaces(context)"
                :key="namespace"
                :value="namespace"
                :checked="
                  isNamespaceExplicitlyActive(
                    context.context,
                    context.kubeConfig,
                    namespace
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
                <span class="truncate">{{ namespace }}</span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuLabel
                v-if="
                  context.namespaces.length > 0 &&
                  filteredNamespaces(context).length === 0
                "
                class="py-3 text-center font-normal"
              >
                No matching namespaces
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuLabel
          v-if="filteredContexts.length === 0"
          class="py-4 text-center font-normal"
        >
          {{ contexts.length === 0 ? "No clusters found" : "No matching clusters" }}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          v-if="activeContexts.size > 0"
          class="text-muted-foreground"
          @select="clearSelection"
        >
          <X class="h-3.5 w-3.5" />
          Clear selection
        </DropdownMenuItem>
        <DropdownMenuItem @select="openHub">
          <LayoutGrid class="h-3.5 w-3.5 text-muted-foreground" />
          Manage clusters…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
