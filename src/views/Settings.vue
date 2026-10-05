<script setup lang="ts">
/*
 * Settings: a category rail with search on the left, the category (or the
 * search results) on the right. Every preference comes from the registry
 * (src/lib/settings/registry.ts); `?q=` searches, `?setting=<key>` jumps to
 * a preference.
 */
import { getVersion } from "@tauri-apps/api/app";
import { useRoute, useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { Braces, Search, X } from "lucide-vue-next";
import { Kbd } from "@/components/ui/kbd";
import SettingsSearchResults from "@/views/settings/SettingsSearchResults.vue";
import { CATEGORIES } from "@/lib/settings/categories";
import { SETTINGS } from "@/lib/settings/registry";
import { isModified } from "@/lib/settings/store";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict, cn } from "@/lib/utils";

const route = useRoute();
const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);

const appVersion = ref("");
onMounted(() => {
  getVersion().then((version) => (appVersion.value = version));
});

const query = ref(typeof route.query.q === "string" ? route.query.q : "");
watch(
  () => route.query.q,
  (q) => {
    if (typeof q === "string" && q !== query.value) query.value = q;
  }
);
const searching = computed(() => query.value.trim() !== "");

const searchInput = ref<HTMLInputElement | null>(null);
const focusSearch = () => {
  searchInput.value?.focus();
  searchInput.value?.select();
};
defineExpose({ focusSearch });

const isMac = getOsType() === "macos";
/* "/" or Mod+F focuses the search (not while typing elsewhere). */
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (route.meta.fullBleed) return;
  const target = event.target as HTMLElement | null;
  const typing = !!target?.closest?.("input, textarea, [contenteditable=true], .monaco-editor, .xterm");
  const modF = (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && event.code === "KeyF";
  if (modF || (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey)) {
    if (document.querySelector("[role=dialog]")) return;
    event.preventDefault();
    focusSearch();
  }
});
/* Mod+, while settings are open: back to the search. */
watch(
  () => route.query.focus,
  (focus) => {
    if (focus === "search") {
      nextTick(focusSearch);
      router.replace({ query: { ...route.query, focus: undefined } });
    }
  },
  { immediate: true }
);

const clearSearch = () => {
  query.value = "";
  searchInput.value?.focus();
};

const modifiedCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const def of SETTINGS) {
    if (isModified(settings.value, def)) {
      counts.set(def.category, (counts.get(def.category) ?? 0) + 1);
    }
  }
  return counts;
});

const activeCategory = computed(() => String(route.params.category ?? ""));

const openCategory = () => {
  query.value = "";
};
</script>
<template>
  <!-- Full-bleed settings pages (JSON editors) bring their own layout. -->
  <div v-if="route.meta.fullBleed" class="h-full">
    <router-view />
  </div>
  <div v-else class="h-full overflow-auto" data-settings-scroll>
    <div class="mx-auto flex max-w-5xl gap-10 px-10 py-8">
      <aside class="w-52 shrink-0">
        <div class="sticky top-8 space-y-5">
          <div class="space-y-1">
            <h1 class="text-xl font-semibold tracking-tight">Settings</h1>
            <p class="text-sm text-muted-foreground">Fine-tune JET Pilot to your liking</p>
          </div>

          <div class="relative">
            <Search
              class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref="searchInput"
              v-model="query"
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              spellcheck="false"
              class="h-8 w-full rounded-md border bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground focus-ring [&::-webkit-search-cancel-button]:hidden"
              @keydown.esc="query ? clearSearch() : undefined"
            />
            <button
              v-if="query"
              type="button"
              class="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-ring"
              aria-label="Clear search"
              @click="clearSearch"
            >
              <X class="h-3 w-3" />
            </button>
            <Kbd
              v-else
              :keys="['/']"
              size="sm"
              class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
            />
          </div>

          <nav class="flex flex-col gap-0.5" aria-label="Settings sections">
            <router-link
              v-for="category in CATEGORIES"
              :key="category.id"
              :to="{ name: 'SettingsCategory', params: { category: category.id } }"
              :class="
                cn(
                  'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors duration-fast hover:bg-accent/70 hover:text-foreground focus-ring',
                  !searching &&
                    activeCategory === category.id &&
                    'bg-accent font-medium text-foreground'
                )
              "
              :aria-current="!searching && activeCategory === category.id ? 'page' : undefined"
              @click="openCategory"
            >
              <component
                :is="category.icon"
                class="h-4 w-4 shrink-0"
                :class="!searching && activeCategory === category.id ? 'text-primary' : ''"
                :stroke-width="1.75"
              />
              <span class="flex-1 truncate">{{ category.title }}</span>
              <span
                v-if="modifiedCounts.get(category.id)"
                class="text-2xs tabular-nums text-muted-foreground"
                :title="`${modifiedCounts.get(category.id)} changed from the default`"
              >
                {{ modifiedCounts.get(category.id) }}
              </span>
            </router-link>
          </nav>

          <div class="space-y-1 border-t border-border-subtle pt-4">
            <router-link
              :to="{ name: 'SettingsJson' }"
              class="flex h-7 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors duration-fast hover:bg-accent/70 hover:text-foreground focus-ring"
            >
              <Braces class="h-3.5 w-3.5" :stroke-width="1.75" />
              Open settings.json
            </router-link>
            <p class="px-2.5 text-xs tabular-nums text-muted-foreground">
              JET Pilot {{ appVersion ? `v${appVersion}` : "" }}
            </p>
          </div>
        </div>
      </aside>
      <main class="min-w-0 flex-1 space-y-6 pb-16">
        <SettingsSearchResults v-if="searching" :query="query" @navigate="query = ''" />
        <router-view v-else />
      </main>
    </div>
  </div>
</template>
