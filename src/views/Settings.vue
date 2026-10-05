<script setup lang="ts">
/*
 * Settings: a quiet rail (search, categories, and at its foot what you
 * changed, settings.json and the version) next to the category page or the
 * search results. Every preference comes from the registry
 * (src/lib/settings/registry.ts); `?q=` searches, `?setting=<key>` jumps to
 * a preference.
 */
import { getVersion } from "@tauri-apps/api/app";
import { useRoute, useRouter } from "vue-router";
import { useElementSize, useEventListener } from "@vueuse/core";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { Braces, Search, X } from "lucide-vue-next";
import { Kbd } from "@/components/ui/kbd";
import SettingsSearchResults from "@/views/settings/SettingsSearchResults.vue";
import { CATEGORIES } from "@/lib/settings/categories";
import { SETTINGS } from "@/lib/settings/registry";
import { isModified } from "@/lib/settings/store";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict, cn } from "@/lib/utils";

defineOptions({ name: "SettingsView" });

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

/* One quiet entry for everything you changed (search @modified) instead of counts per category. */
const modifiedCount = computed(() => SETTINGS.filter((def) => isModified(settings.value, def)).length);
const listingModified = computed(() => query.value.trim().toLowerCase() === "@modified");
const showModified = () => {
  query.value = "@modified";
  nextTick(() => searchInput.value?.focus());
};

const activeCategory = computed(() => String(route.params.category ?? ""));

const openCategory = () => {
  query.value = "";
};

/* The rail fills the visible height (its foot sits at the bottom) and stays put while the page scrolls. */
const scroller = ref<HTMLElement | null>(null);
const { height: viewHeight } = useElementSize(scroller);
</script>
<template>
  <!-- Full-bleed settings pages (JSON editors) bring their own layout. -->
  <div v-if="route.meta.fullBleed" class="h-full">
    <router-view />
  </div>
  <div v-else ref="scroller" class="h-full overflow-auto bg-background" data-settings-scroll>
    <div class="mx-auto flex max-w-5xl gap-14 px-10">
      <aside class="w-48 shrink-0">
        <div
          class="sticky top-0 flex min-h-[22rem] flex-col pb-6 pt-10"
          :style="viewHeight ? { height: `${viewHeight}px` } : undefined"
        >
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
              title="Type @modified to list what you changed"
              spellcheck="false"
              class="h-8 w-full rounded-lg border border-transparent bg-muted/60 pl-8 pr-8 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15 [&::-webkit-search-cancel-button]:hidden"
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
              variant="ghost"
              class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
            />
          </div>

          <nav class="mt-5 flex flex-col gap-px" aria-label="Settings sections">
            <router-link
              v-for="category in CATEGORIES"
              :key="category.id"
              :to="{ name: 'SettingsCategory', params: { category: category.id } }"
              :class="
                cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors duration-fast hover:bg-accent/50 hover:text-foreground focus-ring',
                  !searching && activeCategory === category.id && 'bg-accent font-medium text-foreground hover:bg-accent'
                )
              "
              :aria-current="!searching && activeCategory === category.id ? 'page' : undefined"
              @click="openCategory"
            >
              <component :is="category.icon" class="h-4 w-4 shrink-0" :stroke-width="1.75" />
              <span class="truncate">{{ category.title }}</span>
            </router-link>
          </nav>

          <div class="mt-auto space-y-px pt-6 text-xs text-muted-foreground">
            <button
              v-if="modifiedCount"
              type="button"
              :class="
                cn(
                  'flex h-7 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-fast hover:bg-accent/50 hover:text-foreground focus-ring',
                  listingModified && 'bg-accent text-foreground hover:bg-accent'
                )
              "
              :aria-pressed="listingModified"
              title="List the settings you changed"
              @click="showModified"
            >
              <span class="flex w-3.5 justify-center"><span class="h-1.5 w-1.5 rounded-full bg-primary" /></span>
              <span class="tabular-nums">{{ modifiedCount }} changed {{ modifiedCount === 1 ? "setting" : "settings" }}</span>
            </button>
            <router-link
              :to="{ name: 'SettingsJson' }"
              class="flex h-7 items-center gap-2.5 rounded-md px-2.5 transition-colors duration-fast hover:bg-accent/50 hover:text-foreground focus-ring"
            >
              <Braces class="h-3.5 w-3.5" :stroke-width="1.75" />
              settings.json
            </router-link>
            <p class="flex h-7 items-center px-2.5 tabular-nums">
              JET Pilot{{ appVersion ? ` v${appVersion}` : "" }}
            </p>
          </div>
        </div>
      </aside>
      <main class="min-w-0 flex-1 pb-16 pt-10">
        <SettingsSearchResults v-if="searching" :query="query" @navigate="query = ''" />
        <router-view v-else />
      </main>
    </div>
  </div>
</template>
