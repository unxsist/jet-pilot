<script setup lang="ts">
/*
 * One theme of the library: a live miniature of the app in the theme, the
 * name and a menu, and one quiet line: the appearances it has, where it
 * came from (Open VSX) and, when it is used, for which mode. The whole card is one button (a stretched overlay); the menu
 * trigger sits above it. Broken user files show their error and a way to
 * fix them instead of a preview.
 */
import { AlertTriangle, Check, Copy, Download, Moon, MoreHorizontal, Pencil, Sun, SunMoon, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ThemePreview from "./ThemePreview.vue";
import { appearanceChips, themeBadge, useOptions } from "@/lib/themes/library";
import type {
  ThemeAppearance,
  ThemeEntry,
  ThemeSettings,
  ThemeToken,
} from "@/lib/themes/types";

const props = defineProps<{
  entry: ThemeEntry;
  vars: Record<ThemeToken, string> | null;
  /** The appearance the miniature shows. */
  appearance: ThemeAppearance;
  settings: Pick<ThemeSettings, "lightTheme" | "darkTheme">;
}>();

const emit = defineEmits<{
  (e: "apply"): void;
  (e: "use", mode: ThemeAppearance | "both"): void;
  (e: "hover", hovering: boolean): void;
  (e: "duplicate"): void;
  (e: "edit"): void;
  (e: "export", portable: boolean): void;
  (e: "delete"): void;
}>();

const badge = computed(() => themeBadge(props.entry));
const chips = computed(() => appearanceChips(props.entry, props.settings));
const usedHalves = computed(() => chips.value.filter((chip) => chip.used));
const used = computed(() => usedHalves.value.length > 0);
const options = computed(() => useOptions(props.entry));
const editable = computed(() => props.entry.source !== "builtin");
const usedLabel = computed(() => {
  const halves = usedHalves.value.map((chip) => chip.appearance);
  if (halves.length === 2) return "in use for light and dark mode";
  return halves.length ? `in use for ${halves[0]} mode` : "";
});

const appearancesText = computed(() =>
  props.entry.appearances.length === 2 ? "Light and dark" : props.entry.appearances[0] === "light" ? "Light" : "Dark"
);
/* Which modes use it: "In use" (both), else the mode. */
const usedText = computed(() =>
  usedHalves.value.length === 2 ? "In use" : usedHalves.value[0]?.appearance === "light" ? "Light mode" : "Dark mode"
);
const usedTitle = computed(() =>
  usedHalves.value
    .map((chip) => `Used in ${chip.appearance} mode${chip.native ? "" : " (paints its own appearance)"}`)
    .join("\n")
);

const optionIcon = (mode: ThemeAppearance | "both") =>
  mode === "both" ? SunMoon : mode === "light" ? Sun : Moon;

const menuOpen = ref(false);
</script>

<template>
  <div
    class="group relative rounded-xl border bg-card p-1.5 shadow-xs transition-[border-color,box-shadow] duration-fast focus-within:border-border-strong hover:border-border-strong"
    :class="used ? 'border-primary ring-2 ring-primary/15 hover:border-primary focus-within:border-primary' : ''"
    :data-theme-card="entry.id"
    @pointerenter="emit('hover', true)"
    @pointerleave="emit('hover', false)"
  >
    <!-- The card's own button: stretched over the whole card. -->
    <button
      v-if="!entry.error"
      type="button"
      class="absolute inset-0 z-0 rounded-xl focus-ring"
      :aria-label="`${entry.name}${usedLabel ? `, ${usedLabel}` : ''}. Use this theme`"
      :aria-pressed="used"
      @click="emit('apply')"
    ></button>

    <div class="pointer-events-none relative">
      <ThemePreview v-if="!entry.error" :vars="vars" :appearance="appearance" />
      <div
        v-else
        class="flex h-28 flex-col gap-1.5 overflow-hidden rounded-md border border-destructive/20 bg-destructive/5 p-2.5"
      >
        <div class="flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
          This file can't be used
        </div>
        <p class="line-clamp-3 break-words text-xs text-muted-foreground" :title="entry.error">
          {{ entry.error }}
        </p>
      </div>
    </div>

    <div class="pointer-events-none relative flex items-center gap-1.5 pl-1.5 pt-2">
      <span class="truncate text-sm font-medium text-foreground" :title="entry.name">{{ entry.name }}</span>
      <DropdownMenu v-model:open="menuOpen">
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-xs"
            class="pointer-events-auto z-10 ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            :aria-label="`${entry.name} theme actions`"
          >
            <MoreHorizontal class="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <template v-if="!entry.error">
            <DropdownMenuItem
              v-for="option in options"
              :key="option.mode"
              @select="emit('use', option.mode)"
            >
              <component :is="optionIcon(option.mode)" class="h-3.5 w-3.5" />
              {{ option.label }}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="emit('duplicate')">
              <Copy class="h-3.5 w-3.5" />
              Duplicate &amp; edit
            </DropdownMenuItem>
          </template>
          <DropdownMenuItem v-if="editable" @select="emit('edit')">
            <Pencil class="h-3.5 w-3.5" />
            {{ entry.error ? "Fix in editor" : "Edit" }}
          </DropdownMenuItem>
          <DropdownMenuSub v-if="!entry.error">
            <DropdownMenuSubTrigger>
              <Download class="h-3.5 w-3.5" />
              Export
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent class="w-48">
              <DropdownMenuItem @select="emit('export', false)">JET Pilot theme…</DropdownMenuItem>
              <DropdownMenuItem @select="emit('export', true)">Standard theme…</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <template v-if="editable">
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" @select="emit('delete')">
              <Trash2 class="h-3.5 w-3.5" />
              Delete…
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="pointer-events-none relative flex h-6 items-center gap-2 pb-0.5 pl-1.5 pr-1 text-xs">
      <template v-if="!entry.error">
        <span class="truncate text-muted-foreground">
          {{ appearancesText }}<template v-if="badge.label === 'Open VSX'"> · Open VSX</template>
        </span>
        <span
          v-if="used"
          class="ml-auto flex shrink-0 items-center gap-1 font-medium text-link"
          :title="usedTitle"
        >
          <Check class="h-3 w-3" />
          {{ usedText }}
        </span>
      </template>
      <Button
        v-else
        variant="outline"
        size="xs"
        class="pointer-events-auto z-10"
        @click="emit('edit')"
      >
        <Pencil class="h-3 w-3" />
        Fix in editor
      </Button>
    </div>
  </div>
</template>
