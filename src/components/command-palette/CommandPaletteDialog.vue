<script setup lang="ts">
import { injectStrict, formatResourceKind } from "@/lib/utils";
import type { Component } from "vue";
import type { Command } from "@/command-palette";
import { Kbd } from "@/components/ui/kbd";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { kindIcon } from "@/lib/kindIcons";
import { actionIcon } from "@/lib/actionIcons";
import Fuse from "fuse.js";
import { useRouter } from "vue-router";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type as getOsType } from "@tauri-apps/plugin-os";
import {
  ArrowLeftRight,
  ChevronRight,
  Copy,
  CornerDownLeft,
  CornerDownRight,
  FolderTree,
  History,
  Layers,
  Loader2,
  Palette,
  SearchX,
  SquareTerminal,
  Sparkles,
  SunMoon,
  TriangleAlert,
} from "lucide-vue-next";

import {
  CommandPaletteStateKey,
  CloseCommandPaletteKey,
  ClearCommandCallStackKey,
  ExecuteCommandKey,
} from "@/providers/CommandPaletteProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  PanelProviderAddTabKey,
  PanelProviderStateKey,
} from "@/providers/PanelProvider";
import {
  PINNED_SHORTCUT_COUNT,
  resourceRoute,
} from "@/providers/GlobalShortcutProvider";
import { useDiscovery, type DiscoveredResource } from "@/lib/discovery";
import {
  isJumpQuery,
  jumpRank,
  jumpTerm,
  matchResources,
  pushRecent,
} from "@/lib/paletteSearch";

import {
  CommandDialog,
  CommandInput,
  CommandEmpty,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

/*
 * Palette items are Commands plus a few markers used by the filter:
 *   jump      only shown for ":<resource>" queries (k9s style)
 *   recent    only shown without a query
 *   kind      a discovered resource kind (icon)
 */
type PaletteItem = Command & {
  jump?: boolean;
  recent?: boolean;
  kind?: string;
  resource?: DiscoveredResource;
};

/* Navigation commands are registered by the sidebar items. */
const isNavigation = (command: Command) =>
  command.description?.startsWith("Navigate to") ?? false;

const { open, commands, callStack, loading, executionError } = injectStrict(
  CommandPaletteStateKey
);
const closeCommandPalette = injectStrict(CloseCommandPaletteKey);
const clearCallStack = injectStrict(ClearCommandCallStackKey);
const executeCommand = injectStrict(ExecuteCommandKey);
const { context, kubeConfig } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const { sidePanel } = injectStrict(PanelProviderStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const router = useRouter();

const searchTerm = ref("");
watch(open, (isOpen) => {
  if (!isOpen) searchTerm.value = "";
});
watch(
  () => callStack.value.size,
  () => (searchTerm.value = "")
);

/* --------------------------------------------- resources (discovery) -- */

const discovery = useDiscovery(context, kubeConfig);

/* One item per kind; CRDs sharing a kind name with a built-in lose. */
const discoveredKinds = computed(() => {
  const seen = new Set<string>();
  return matchResources(discovery.resources.value, "").filter((r) => {
    const key = formatResourceKind(r.kind);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const modKey = getOsType() === "macos" ? "⌘" : "Ctrl";

/* Pinned resources open with Mod+1..9 (GlobalShortcutProvider). */
const pinnedShortcut = (resource: DiscoveredResource) => {
  const index = settings.value.pinnedResources.findIndex(
    (pinned) => pinned.name === resource.name && pinned.kind === resource.kind
  );
  return index >= 0 && index < PINNED_SHORTCUT_COUNT
    ? [modKey, String(index + 1)]
    : undefined;
};

const resourceItem = (
  resource: DiscoveredResource,
  jump: boolean
): PaletteItem => {
  const title = formatResourceKind(resource.kind);
  return {
    shortcut: pinnedShortcut(resource),
    id: `${jump ? "jump" : "goto"}:${resource.group}/${resource.name}`,
    name: title,
    description: resource.group
      ? `${resource.name}.${resource.group}`
      : resource.name,
    keywords: [
      resource.name,
      resource.kind,
      ...(resource.shortNames ?? []),
      ...(resource.singularName ? [resource.singularName] : []),
    ],
    kind: title.toLowerCase(),
    resource,
    jump,
    execute: () => router.push(resourceRoute(resource.kind)),
  };
};

/*
 * The combobox matches filtered values to rendered items by value, and only
 * re-reads its option list when the number of items changes. So the jump
 * items are stable objects, all rendered in jump mode (ranked first, the
 * filter hides non-matches) instead of a per-keystroke subset.
 */
const jumpMode = computed(() => isJumpQuery(searchTerm.value));
const jumpPool = computed(() =>
  discoveredKinds.value.map((r) => resourceItem(r, true))
);
const jumpItems = computed<PaletteItem[]>(() => {
  if (!jumpMode.value) return [];
  const term = jumpTerm(searchTerm.value);
  const byResource = new Map(jumpPool.value.map((i) => [i.resource!, i]));
  const ranked = matchResources(discoveredKinds.value, term).map(
    (r) => byResource.get(r)!
  );
  const rankedSet = new Set(ranked);
  return [...ranked, ...jumpPool.value.filter((i) => !rankedSet.has(i))];
});
const resourceItems = computed(() =>
  discoveredKinds.value.map((r) => resourceItem(r, false))
);
const resourceTitles = computed(
  () => new Set(resourceItems.value.map((item) => item.name))
);

const actionCommands = computed(() =>
  commands.value.filter((command) => !isNavigation(command))
);
/* Sidebar links that are not resource kinds (graph, Helm, settings). */
const otherNavigation = computed(() =>
  commands.value.filter(
    (command) =>
      isNavigation(command) && !resourceTitles.value.has(command.name)
  )
);

/* ------------------------------------------------------------ recent -- */

/* Sidebar commands get a new id per mount: remember them by name. */
const recentKey = (item: PaletteItem) =>
  isNavigation(item)
    ? `nav:${item.name}`
    : item.id.replace(/^(jump|goto):/, "goto:");

const recentItems = computed<PaletteItem[]>(() => {
  const pool = new Map<string, PaletteItem>();
  for (const item of [
    ...actionCommands.value,
    ...otherNavigation.value,
    ...resourceItems.value,
  ]) {
    pool.set(recentKey(item), item);
  }
  return (settings.value.recentCommands ?? [])
    .map((key) => pool.get(key))
    .filter((item): item is PaletteItem => !!item)
    .map((item) => ({ ...item, id: `recent:${item.id}`, recent: true }));
});

/* ------------------------------------------------- selected resource -- */

const LOGGABLE_KINDS = [
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
];

/* The row shown in the side panel (the "selected" row of the table). */
const selected = computed(() => {
  const object = sidePanel.value?.props?.resource;
  if (!object?.kind || !object?.metadata?.name) return null;
  const apiVersion: string = object.apiVersion || "";
  const group = apiVersion.includes("/") ? apiVersion.split("/")[0] : "";
  const kind: string = object.kind;
  return {
    kind,
    type: group ? `${kind.toLowerCase()}.${group}` : kind,
    name: object.metadata.name as string,
    namespace: (object.metadata.namespace as string) || "",
    context: (object.metadata.context as string) || context.value,
    kubeConfig: (object.metadata.kubeConfig as string) || kubeConfig.value,
  };
});

const selectedActions = computed<PaletteItem[]>(() => {
  const t = selected.value;
  if (!t) return [];
  const id = (action: string) =>
    [action, t.context, t.namespace, t.type, t.name].join("_");
  const target = {
    context: t.context,
    namespace: t.namespace,
    kubeConfig: t.kubeConfig,
  };
  const items: PaletteItem[] = [
    {
      id: "selected-describe",
      name: "Describe",
      description: `${t.kind} ${t.name}`,
      keywords: ["describe", "selected"],
      execute: () =>
        addTab(
          id("describe"),
          t.name,
          defineAsyncComponent(() => import("@/views/Describe.vue")),
          { ...target, type: t.type, name: t.name },
          "describe"
        ),
    },
    {
      id: "selected-edit",
      name: "Edit YAML",
      description: `${t.kind} ${t.name}`,
      keywords: ["edit", "yaml", "selected"],
      execute: () =>
        addTab(
          id("edit"),
          t.name,
          defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
          { ...target, type: t.type, name: t.name, useKubeCtl: true },
          "edit"
        ),
    },
  ];
  if (LOGGABLE_KINDS.includes(t.kind)) {
    items.push({
      id: "selected-logs",
      name: "Logs",
      description: `${t.kind} ${t.name}`,
      keywords: ["logs", "selected"],
      execute: () =>
        addTab(
          id("logs"),
          t.name,
          defineAsyncComponent(() => import("@/views/StructuredLogViewer.vue")),
          {
            ...target,
            object:
              t.kind === "Pod" ? t.name : `${t.kind.toLowerCase()}/${t.name}`,
          },
          "logs"
        ),
    });
  }
  items.push({
    id: "selected-copy",
    name: "Copy name",
    description: t.name,
    keywords: ["copy", "clipboard", "selected"],
    execute: () => {
      writeText(t.name).catch(() => {});
    },
  });
  return items;
});

/* ------------------------------------------------------------ filter -- */

const fuzzy = (list: PaletteItem[], query: string) =>
  new Fuse(list, {
    threshold: 0.3,
    // Match anywhere: context names are often long (EKS ARNs, #20).
    ignoreLocation: true,
    keys: [{ name: "keywords", weight: 2 }, "name", "description"],
  })
    .search(query)
    .map((result) => result.item);

const filter = (list: PaletteItem[], query: string) => {
  if (isJumpQuery(query)) {
    const term = jumpTerm(query);
    return list.filter(
      (item) => item.jump && jumpRank(item.resource!, term) !== null
    );
  }
  return fuzzy(
    list.filter((item) => !item.jump && !item.recent),
    query
  );
};

const select = (item: PaletteItem) => {
  if (callStack.value.size === 0) {
    settings.value.recentCommands = pushRecent(
      settings.value.recentCommands ?? [],
      recentKey(item)
    );
  }
  executeCommand(item);
};

/* ------------------------------------------------------------- icons -- */

/* Names of the commands drilled into, e.g. Switch context › prod. */
const breadcrumbs = computed(() =>
  Array.from(callStack.value.keys()).map((command) => command.name)
);

/* Options of "Switch context" are contexts: show their monogram. */
const isContextList = computed(() => {
  const keys = Array.from(callStack.value.keys());
  return keys.length === 1 && keys[0].id === "switch-context";
});

const isWorkspaceList = computed(() => {
  const keys = Array.from(callStack.value.keys());
  return keys.length === 1 && keys[0].id === "switch-workspace";
});

/* Palette commands by id; row actions share the table menus' icons. */
const PALETTE_ICONS: Record<string, Component> = {
  "switch-context": ArrowLeftRight,
  "switch-namespace": FolderTree,
  "open-terminal": SquareTerminal,
  "switch-workspace": Layers,
  "save-workspace": Layers,
  "selected-describe": actionIcon("describe") ?? Sparkles,
  "selected-edit": actionIcon("edit yaml") ?? Sparkles,
  "selected-logs": actionIcon("logs") ?? Sparkles,
  "selected-copy": Copy,
  "change-theme": Palette,
  "change-appearance": SunMoon,
};

const commandIcon = (command: PaletteItem): Component => {
  if (command.kind) return kindIcon(command.kind);
  if (isNavigation(command)) {
    const name = command.name.toLowerCase();
    if (name.startsWith("helm")) return kindIcon("helm");
    if (name === "resource graph") return kindIcon("diagram");
    return kindIcon(name.replace(/\s+/g, ""));
  }
  return PALETTE_ICONS[command.id.replace(/^recent:/, "")] ?? Sparkles;
};

/* Options below a context / "Switch namespace" are namespaces. */
const subCommandIcon = (command: Command): Component =>
  command.id === "all-namespaces" ||
  Array.from(callStack.value.keys()).some((c) =>
    ["switch-context", "switch-namespace"].includes(c.id)
  )
    ? FolderTree
    : command.swatches
      ? Palette
      : CornerDownRight;

/* Options of the open drill-down, grouped by `group` (in order). */
const optionGroups = computed(() => {
  const keys = Array.from(callStack.value.keys());
  const options = callStack.value.get(keys[keys.length - 1]) ?? [];
  const heading = breadcrumbs.value[breadcrumbs.value.length - 1];
  const groups = new Map<string, Command[]>();
  for (const option of options) {
    const group = option.group ?? heading;
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }
  return [...groups].map(([group, commands]) => ({ heading: group, commands }));
});

/*
 * Live previews (Change theme): an option's onHighlight runs once the user
 * moves the highlight (keys or pointer), debounced; not for the automatic
 * highlight of the first option when a list opens.
 */
const PREVIEW_DELAY_MS = 60;
let userNavigated = false;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
const cancelHighlight = () => clearTimeout(highlightTimer);
const onHighlight = (value: unknown) => {
  cancelHighlight();
  const option = value as Command | undefined;
  if (!userNavigated || !option?.onHighlight) return;
  highlightTimer = setTimeout(() => option.onHighlight?.(), PREVIEW_DELAY_MS);
};
const markNavigation = (event: Event) => {
  if (event instanceof KeyboardEvent && ["Escape", "Enter"].includes(event.key)) return;
  userNavigated = true;
};
watch([() => callStack.value.size, open], () => {
  cancelHighlight();
  userNavigated = false;
});
onBeforeUnmount(cancelHighlight);

/* Esc steps back out of a drill-down (Switch context › prod › …). */
const handleEscapeKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    closeCommandPalette();
  }
};
watchEffect((onCleanup) => {
  if (open.value) {
    window.addEventListener("keydown", handleEscapeKey);
    window.addEventListener("keydown", markNavigation, true);
    window.addEventListener("pointermove", markNavigation, true);
    onCleanup(() => {
      window.removeEventListener("keydown", handleEscapeKey);
      window.removeEventListener("keydown", markNavigation, true);
      window.removeEventListener("pointermove", markNavigation, true);
    });
  }
});
</script>
<template>
  <div
    v-show="open"
    class="fixed inset-0 z-40"
    @click.self="closeCommandPalette"
  >
    <CommandDialog
      v-model:search-term="searchTerm"
      :open="open"
      :filter="filter"
      :on-highlight="onHighlight"
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
              ? `Search ${breadcrumbs[breadcrumbs.length - 1].toLowerCase().replace(/…$/, '')}…`
              : 'Type a command, or : to jump to a resource…'
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
            <template v-if="searchTerm.trim() === ':'"
              >Type a resource: <code>:po</code>, <code>:deploy</code>,
              <code>:svc</code>…</template
            >
            <template v-else>No results found.</template>
          </div>
        </CommandEmpty>
        <template v-if="callStack.size === 0">
          <CommandGroup
            v-if="jumpItems.length > 0"
            heading="Jump to resource"
          >
            <CommandItem
              v-for="item in jumpItems"
              :key="item.id"
              :value="item"
              @select="select(item)"
            >
              <component :is="commandIcon(item)" class="h-4 w-4" />
              <span class="truncate">{{ item.name }}</span>
              <span class="ml-1 truncate text-xs text-muted-foreground">{{
                item.description
              }}</span>
              <span
                v-if="item.resource?.shortNames?.length"
                class="ml-auto shrink-0 font-mono text-2xs text-muted-foreground"
                >{{ item.resource.shortNames.join(", ") }}</span
              >
            </CommandItem>
          </CommandGroup>
          <template v-if="!searchTerm">
            <CommandGroup v-if="recentItems.length > 0" heading="Recent">
              <CommandItem
                v-for="item in recentItems"
                :key="item.id"
                :value="item"
                @select="select(item)"
              >
                <component :is="commandIcon(item)" class="h-4 w-4" />
                <span class="truncate">{{ item.name }}</span>
                <History
                  class="ml-auto h-3.5 w-3.5 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </CommandItem>
            </CommandGroup>
          </template>
          <CommandGroup
            v-if="selectedActions.length > 0 && selected"
            :heading="`Selected · ${selected.kind} ${selected.name}`"
          >
            <CommandItem
              v-for="item in selectedActions"
              :key="item.id"
              :value="item"
              @select="select(item)"
            >
              <component :is="commandIcon(item)" class="h-4 w-4" />
              <span class="truncate">{{ item.name }}</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup v-if="actionCommands.length > 0" heading="Actions">
            <CommandItem
              v-for="command in actionCommands"
              :key="command.id"
              :value="command"
              @select="select(command)"
            >
              <component :is="commandIcon(command)" class="h-4 w-4" />
              <span class="truncate">{{ command.name }}</span>
              <span class="ml-1 truncate text-xs text-muted-foreground">{{
                command.description
              }}</span>
              <Kbd
                v-if="command.shortcut"
                :keys="command.shortcut"
                size="sm"
                class="ml-auto shrink-0"
              />
              <ChevronRight
                v-if="command.commands"
                class="h-3.5 w-3.5 shrink-0"
                :class="{ 'ml-auto': !command.shortcut }"
              />
            </CommandItem>
          </CommandGroup>
          <CommandGroup
            v-if="otherNavigation.length + resourceItems.length > 0"
            heading="Go to"
          >
            <CommandItem
              v-for="command in [...otherNavigation, ...resourceItems]"
              :key="command.id"
              :value="command"
              @select="select(command)"
            >
              <component :is="commandIcon(command)" class="h-4 w-4" />
              <span class="truncate">{{ command.name }}</span>
              <Kbd
                v-if="command.shortcut"
                :keys="command.shortcut"
                size="sm"
                class="ml-auto shrink-0"
              />
              <CornerDownLeft
                v-else
                class="ml-auto h-3.5 w-3.5 opacity-0 transition-opacity [[data-highlighted]_&]:opacity-100"
              />
            </CommandItem>
          </CommandGroup>
        </template>
        <template v-else>
          <CommandGroup
            v-for="group in optionGroups"
            :key="group.heading"
            :heading="group.heading"
          >
            <CommandItem
              v-for="(command, index) in group.commands"
              :key="index"
              :value="command"
              @select="executeCommand(command)"
            >
              <ContextAvatar
                v-if="isContextList"
                :name="command.name"
                size="sm"
              />
              <component :is="subCommandIcon(command)" v-else class="h-4 w-4" />
              <span class="truncate">{{ command.name }}</span>
              <span
                v-if="command.description && (isWorkspaceList || command.group)"
                class="ml-1 truncate text-xs text-muted-foreground"
                >{{ command.description }}</span
              >
              <span
                v-if="command.badge || command.swatches?.length"
                class="ml-auto flex shrink-0 items-center gap-2"
              >
                <span v-if="command.badge" class="text-xs text-muted-foreground">{{
                  command.badge
                }}</span>
                <span
                  v-for="(swatch, swatchIndex) in command.swatches"
                  :key="swatchIndex"
                  class="h-3 w-3 rounded-full border border-border-strong"
                  :style="{ background: swatch }"
                  aria-hidden="true"
                />
              </span>
              <ChevronRight
                v-if="command.commands"
                class="h-3.5 w-3.5"
                :class="{ 'ml-auto': !command.badge && !command.swatches?.length }"
              />
            </CommandItem>
          </CommandGroup>
        </template>
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
