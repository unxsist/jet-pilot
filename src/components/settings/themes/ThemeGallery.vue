<script setup lang="ts">
/*
 * Open VSX gallery: searches the Themes category of open-vsx.org (Rust
 * commands in src-tauri/src/openvsx.rs, so no CSP / HTTP scope changes),
 * installs an extension's colour themes after a confirmation listing them.
 * Light / dark variants of one family are paired into one theme.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { AlertCircle, Check, ChevronDown, Download, Loader2, Palette, RotateCw, Search, Star } from "lucide-vue-next";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import ThemeInstallDialog from "./ThemeInstallDialog.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { useTheme } from "@/providers/ThemeProvider";
import { formatCount, isExtensionInstalled, openVsxUrl } from "@/lib/themes/library";
import type {
  OpenVsxExtension,
  OpenVsxInstallResult,
  OpenVsxSearchResult,
  OpenVsxSort,
  ThemeFile,
  ThemeOrigin,
} from "@/lib/themes/types";
import { errorMessage, importSources, type ImportReport } from "./shared";

const theme = useTheme();
const { toast } = useToast();

const PAGE = 24;
const SORTS: { value: OpenVsxSort; label: string }[] = [
  { value: "downloadCount", label: "Popular" },
  { value: "relevance", label: "Relevance" },
  { value: "averageRating", label: "Rating" },
  { value: "timestamp", label: "Newest" },
];

const query = ref("");
const sort = ref<OpenVsxSort>("downloadCount");
const results = ref<OpenVsxExtension[]>([]);
const total = ref(0);
const loading = ref(false);
const loadingMore = ref(false);
const searchError = ref("");
let generation = 0;

const search = async (append = false) => {
  const current = ++generation;
  const offset = append ? results.value.length : 0;
  if (append) loadingMore.value = true;
  else loading.value = true;
  searchError.value = "";
  try {
    const result = await invoke<OpenVsxSearchResult>("openvsx_search", {
      query: query.value.trim(),
      sort: sort.value,
      offset,
      size: PAGE,
    });
    if (current !== generation) return;
    results.value = append ? [...results.value, ...result.extensions] : result.extensions;
    total.value = result.totalSize;
  } catch (e) {
    if (current !== generation) return;
    searchError.value = errorMessage(e);
    if (!append) results.value = [];
  } finally {
    if (current === generation) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
};

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search(), 300);
});
onBeforeUnmount(() => clearTimeout(searchTimer));
watch(sort, () => void search());
onMounted(() => void search());

const keyOf = (extension: OpenVsxExtension) => `${extension.namespace}.${extension.name}`;
const installed = (extension: OpenVsxExtension) =>
  isExtensionInstalled(theme.themes.value, extension.namespace, extension.name);

/* Icons: https only (CSP img-src); broken ones fall back to a glyph. */
const brokenIcons = ref(new Set<string>());
const iconFailed = (extension: OpenVsxExtension) => {
  brokenIcons.value = new Set(brokenIcons.value).add(keyOf(extension));
};
const iconOf = (extension: OpenVsxExtension) =>
  extension.iconUrl?.startsWith("https://") && !brokenIcons.value.has(keyOf(extension))
    ? extension.iconUrl
    : null;

/* ------------------------------------------------------------ install -- */

const fetching = ref<string | null>(null);
const installErrors = ref(new Map<string, string>());
const setInstallError = (key: string, message: string | null) => {
  const next = new Map(installErrors.value);
  if (message) next.set(key, message);
  else next.delete(key);
  installErrors.value = next;
};

const confirm = ref<{ extension: OpenVsxExtension; origin: ThemeOrigin; report: ImportReport } | null>(null);
const confirmOpen = ref(false);
const installing = ref(false);

const fetchThemes = async (extension: OpenVsxExtension) => {
  const key = keyOf(extension);
  fetching.value = key;
  setInstallError(key, null);
  try {
    const result = await invoke<OpenVsxInstallResult>("openvsx_install", {
      namespace: extension.namespace,
      name: extension.name,
      version: extension.version,
    });
    const origin: ThemeOrigin = {
      label: "Open VSX",
      url: openVsxUrl(extension.namespace, extension.name),
      author: extension.namespace,
      ...(result.extension.license ? { license: result.extension.license } : {}),
    };
    const report = await importSources(
      result.themes.map((item) => ({ name: item.label || item.path, text: item.text, uiTheme: item.uiTheme, label: item.label || undefined })),
      origin
    );
    report.warnings.unshift(...(result.warnings ?? []));
    if (!report.themes.length) {
      throw new Error(
        report.errors[0]?.message ?? `${extension.displayName} has no colour themes JET Pilot can read.`
      );
    }
    confirm.value = { extension, origin, report };
    confirmOpen.value = true;
  } catch (e) {
    setInstallError(key, errorMessage(e));
  } finally {
    fetching.value = null;
  }
};

const install = async (files: ThemeFile[]) => {
  const pending = confirm.value;
  if (!pending) return;
  installing.value = true;
  try {
    const entries = await theme.install(files, "openvsx", pending.origin);
    confirmOpen.value = false;
    toast({
      title:
        entries.length === 1
          ? `Installed ${entries[0]!.name}`
          : `Installed ${entries.length} themes from ${pending.extension.displayName}`,
      description: "Find them under Your themes.",
      variant: "success",
    });
  } catch (e) {
    toast({ title: "Couldn't install the themes", description: errorMessage(e), variant: "destructive" });
  } finally {
    installing.value = false;
  }
};
</script>

<template>
  <SettingsSection
    title="Open VSX gallery"
    description="Colour themes from the open extension registry. Only MIT-licensed themes can be installed."
  >
    <div class="space-y-4 pt-4">
      <div class="flex items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            v-model="query"
            type="search"
            spellcheck="false"
            placeholder="Search themes on Open VSX"
            aria-label="Search Open VSX themes"
            class="h-9 w-full rounded-lg border border-transparent bg-muted/60 pl-9 pr-3 text-sm transition-colors duration-fast placeholder:text-muted-foreground hover:bg-muted focus:border-input focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/15 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" class="h-9 text-muted-foreground" aria-label="Sort by">
              {{ SORTS.find((option) => option.value === sort)?.label }}
              <ChevronDown class="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="sort" @update:model-value="(value) => (sort = value as OpenVsxSort)">
              <DropdownMenuRadioItem v-for="option in SORTS" :key="option.value" :value="option.value">
                {{ option.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div v-if="loading" class="-mx-3 grid grid-cols-1 gap-x-4 gap-y-1 lg:grid-cols-2" aria-busy="true">
        <div v-for="index in 6" :key="index" class="flex h-[4.5rem] gap-3 px-3 py-3">
          <Skeleton class="h-10 w-10 shrink-0 rounded-lg" />
          <div class="flex-1 space-y-2 pt-0.5">
            <Skeleton class="h-3 w-1/2" />
            <Skeleton class="h-2.5 w-5/6" />
          </div>
        </div>
      </div>

      <div
        v-else-if="searchError"
        class="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-3"
        role="alert"
      >
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div class="min-w-0 flex-1 space-y-0.5">
          <p class="text-sm font-medium text-destructive">Open VSX couldn't be reached</p>
          <p class="break-words text-xs text-muted-foreground">{{ searchError }}</p>
        </div>
        <Button variant="outline" size="xs" @click="search()">
          <RotateCw class="h-3 w-3" />
          Retry
        </Button>
      </div>

      <EmptyState
        v-else-if="results.length === 0"
        size="sm"
        :icon="Search"
        title="No themes found"
        :description="query.trim() ? `Nothing on Open VSX matches “${query.trim()}”.` : 'Open VSX returned no themes.'"
      />

      <template v-else>
        <ul class="-mx-3 grid grid-cols-1 gap-x-4 gap-y-1 lg:grid-cols-2" aria-label="Open VSX themes">
          <li
            v-for="extension in results"
            :key="keyOf(extension)"
            class="flex gap-3 rounded-lg px-3 py-3"
            :data-extension="keyOf(extension)"
          >
            <img
              v-if="iconOf(extension)"
              :src="iconOf(extension)!"
              alt=""
              class="h-10 w-10 shrink-0 rounded-lg object-contain"
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="iconFailed(extension)"
            />
            <div
              v-else
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-1 text-muted-foreground"
            >
              <Palette class="h-4 w-4" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <a
                    :href="openVsxUrl(extension.namespace, extension.name)"
                    rel="noreferrer"
                    class="block truncate rounded-sm text-sm font-medium text-foreground hover:underline focus-ring"
                    :title="extension.displayName"
                    @click.prevent="openExternal(openVsxUrl(extension.namespace, extension.name))"
                  >
                    {{ extension.displayName }}
                  </a>
                  <p class="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <span class="truncate">{{ extension.namespace }}</span>
                    <span aria-hidden="true">·</span>
                    <span class="inline-flex items-center gap-0.5 tabular-nums" :title="`${extension.downloadCount.toLocaleString()} downloads`">
                      <Download class="h-3 w-3" />{{ formatCount(extension.downloadCount) }}
                    </span>
                    <template v-if="extension.averageRating">
                      <span aria-hidden="true">·</span>
                      <span class="inline-flex items-center gap-0.5 tabular-nums">
                        <Star class="h-3 w-3" />{{ extension.averageRating.toFixed(1) }}
                      </span>
                    </template>
                  </p>
                </div>
                <span
                  v-if="installed(extension)"
                  class="inline-flex h-7 shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground"
                >
                  <Check class="h-3.5 w-3.5 text-success" />
                  Installed
                </span>
                <Button
                  v-else
                  variant="outline"
                  size="sm"
                  class="h-7 shrink-0"
                  :disabled="fetching !== null"
                  :aria-label="`Install ${extension.displayName}`"
                  @click="fetchThemes(extension)"
                >
                  <Loader2 v-if="fetching === keyOf(extension)" class="h-3.5 w-3.5 animate-spin" />
                  Install
                </Button>
              </div>
              <p v-if="extension.description" class="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {{ extension.description }}
              </p>
              <div
                v-if="installErrors.get(keyOf(extension))"
                class="mt-2 flex items-start gap-1.5 text-xs text-destructive"
                role="alert"
              >
                <span class="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                <p class="min-w-0 flex-1 break-words">{{ installErrors.get(keyOf(extension)) }}</p>
                <button
                  type="button"
                  class="shrink-0 rounded-sm font-medium text-link hover:underline focus-ring"
                  @click="fetchThemes(extension)"
                >
                  Retry
                </button>
              </div>
            </div>
          </li>
        </ul>

        <div v-if="results.length < total" class="flex items-center justify-between gap-3">
          <p class="text-xs tabular-nums text-muted-foreground">
            {{ results.length.toLocaleString() }} of {{ total.toLocaleString() }}
          </p>
          <Button
            variant="outline"
            size="sm"
            :disabled="loadingMore"
            @click="search(true)"
          >
            <Loader2 v-if="loadingMore" class="h-3.5 w-3.5 animate-spin" />
            Load more
          </Button>
        </div>
      </template>
    </div>

    <ThemeInstallDialog
      v-model:open="confirmOpen"
      :title="confirm ? `Install ${confirm.extension.displayName}` : 'Install'"
      :description="
        confirm
          ? `${confirm.report.themes.length === 1 ? '1 theme' : `${confirm.report.themes.length} themes`} by ${confirm.extension.namespace}${confirm.origin.license ? ` · ${confirm.origin.license}` : ''}`
          : undefined
      "
      :report="confirm?.report ?? null"
      :busy="installing"
      @install="install"
    />
  </SettingsSection>
</template>
