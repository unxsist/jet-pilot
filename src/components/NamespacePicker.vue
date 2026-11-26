<script lang="ts">
/* Last list per context (all pickers), shown at once while it refreshes. */
const known = new Map<string, string[]>();
</script>

<script setup lang="ts">
/*
 * The namespace scope of one context, where you look at its objects: a
 * resource list's toolbar, the Resource Graph. It changes the same
 * selection as the context switcher in the sidebar, so every view follows.
 *
 * Picking follows Settings › Clusters › Picking a cluster or namespace
 * ("switch" replaces the selection, "add" toggles); ⌘ (macOS) or Ctrl
 * inverts it, as in the sidebar. The last namespace can't be unticked
 * here: that would disconnect the cluster, which is the sidebar's job.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { ChevronsUpDown, Loader2, Search } from "lucide-vue-next";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { injectStrict } from "@/lib/utils";
import { contextKey, matchesFilter, toggleNamespaceSelection } from "@/lib/contextKey";
import { report } from "@/lib/auth/center";
import { useClusters } from "@/lib/clusters/useClusters";
import { Kubernetes } from "@/services/Kubernetes";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  KubeContextSetActiveNamespacesKey,
  KubeContextStateKey,
} from "@/providers/KubeContextProvider";

const props = defineProps<{
  context: string;
  kubeConfig: string;
}>();

const { contexts } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const setActiveNamespaces = injectStrict(KubeContextSetActiveNamespacesKey);
const clusters = useClusters();

/* Active namespaces of the context; ["all"] = all namespaces. */
const active = computed(() => contexts.value.get(props.context) ?? []);
const isAll = computed(() => active.value.includes("all"));

const label = computed(() => {
  if (isAll.value || active.value.length === 0) return "All namespaces";
  if (active.value.length === 1) return active.value[0];
  return `${active.value.length} namespaces`;
});

/* ----------------------------------------------------- namespaces -- */

const menuOpen = ref(false);
const namespaces = ref<string[]>([]);
const loading = ref(false);
const failed = ref(false);

const load = async () => {
  const key = contextKey(props.context, props.kubeConfig);
  namespaces.value = known.get(key) ?? namespaces.value;
  failed.value = false;

  // Namespaces set for the cluster (Clusters hub › details) win.
  const configured = clusters.resolve(props.context, props.kubeConfig).namespaces;
  if (configured.length > 0) {
    namespaces.value = [...configured];
    return;
  }

  loading.value = namespaces.value.length === 0;
  try {
    const listed = await Kubernetes.getNamespaces(props.context, props.kubeConfig);
    const names = listed.map((ns) => ns.metadata?.name || "").filter(Boolean);
    known.set(key, names);
    if (key === contextKey(props.context, props.kubeConfig)) namespaces.value = names;
  } catch (err) {
    // A sign-in is the auth center's to offer; the selection stays usable.
    report({ context: props.context, kubeConfig: props.kubeConfig }, err, "api");
    failed.value = true;
  } finally {
    loading.value = false;
  }
};

watch(menuOpen, (open) => {
  if (open) void load();
  else filter.value = "";
});
watch(
  () => contextKey(props.context, props.kubeConfig),
  () => (namespaces.value = [])
);

/*
 * Listed namespaces plus selected ones the list doesn't have (no
 * permission to list, or a namespace that's gone): those stay pickable.
 */
const options = computed(() => {
  const selected = isAll.value ? [] : active.value;
  const extra = selected.filter((ns) => !namespaces.value.includes(ns));
  return [...namespaces.value, ...extra].sort((a, b) => a.localeCompare(b));
});

/* --------------------------------------------------------- search -- */

const SEARCH_THRESHOLD = 8;
const filter = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
const shown = computed(() => options.value.filter((ns) => matchesFilter(ns, filter.value)));

const onOpenAutoFocus = (event: Event) => {
  if (options.value.length <= SEARCH_THRESHOLD) return;
  event.preventDefault();
  nextTick(() => searchInput.value?.focus());
};

/* Typed keys must not reach the menu's typeahead; ArrowDown enters the list. */
const onSearchKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape") return;
  event.stopPropagation();
  if (event.key === "ArrowDown") {
    event.preventDefault();
    (event.target as HTMLElement)
      .closest('[role="menu"]')
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
      ?.focus();
  }
};

/* ---------------------------------------------------------- pick -- */

const isMac = getOsType() === "macos";
const invertPick = ref(false);
/* The select event carries no modifiers: remember the event before it. */
const rememberModifier = (event: PointerEvent | KeyboardEvent) => {
  invertPick.value = isMac ? event.metaKey : event.ctrlKey;
};
const switchesOnPick = () => (settings.value.switcher.pick === "switch") !== invertPick.value;

const apply = (next: string[]) => {
  if (next.length === 0) return;
  setActiveNamespaces(props.context, props.kubeConfig, next);
};

const pickAll = () => {
  apply(["all"]);
  menuOpen.value = false;
};

const pick = (namespace: string) => {
  if (switchesOnPick()) {
    apply([namespace]);
    menuOpen.value = false;
    return;
  }
  // From all namespaces, adding one narrows down to just that one.
  apply(
    isAll.value
      ? [namespace]
      : toggleNamespaceSelection(active.value, namespaces.value, namespace)
  );
};

const isChecked = (namespace: string) => !isAll.value && active.value.includes(namespace);
</script>

<template>
  <DropdownMenu v-model:open="menuOpen">
    <DropdownMenuTrigger
      class="flex h-7 min-w-0 max-w-[14rem] shrink items-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-fast ease-out hover:bg-muted focus-ring data-[state=open]:bg-muted"
      :class="isAll ? 'text-muted-foreground hover:text-foreground' : 'font-medium text-foreground'"
      :title="`Namespaces of ${context}`"
      :aria-label="`Namespaces: ${label}`"
    >
      <span class="truncate">{{ label }}</span>
      <ChevronsUpDown class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      class="max-h-80 w-60 overflow-y-auto"
      @open-auto-focus="onOpenAutoFocus"
      @pointerdown.capture="rememberModifier"
      @keydown.capture="rememberModifier"
    >
      <div
        v-if="options.length > SEARCH_THRESHOLD"
        class="-mx-1 -mt-1 mb-1 flex items-center gap-2 border-b px-3"
      >
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref="searchInput"
          v-model="filter"
          type="text"
          placeholder="Search namespaces…"
          aria-label="Search namespaces"
          class="h-8 w-full bg-transparent text-xs placeholder:text-muted-foreground/80 focus:outline-none"
          @keydown="onSearchKeydown"
        />
      </div>
      <DropdownMenuCheckboxItem :checked="isAll" @select="pickAll">
        <span class="font-medium">All namespaces</span>
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator v-if="shown.length > 0 || loading || failed" />
      <DropdownMenuLabel v-if="loading" class="flex items-center gap-2 py-2 font-normal">
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
        Fetching namespaces…
      </DropdownMenuLabel>
      <DropdownMenuLabel v-else-if="failed && options.length === 0" class="py-2 font-normal">
        Couldn't list the namespaces.
      </DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        v-for="ns in shown"
        :key="ns"
        :checked="isChecked(ns)"
        @select.prevent="pick(ns)"
      >
        <span class="truncate">{{ ns }}</span>
      </DropdownMenuCheckboxItem>
      <DropdownMenuLabel
        v-if="options.length > 0 && shown.length === 0"
        class="py-3 text-center font-normal"
      >
        No matching namespaces
      </DropdownMenuLabel>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
