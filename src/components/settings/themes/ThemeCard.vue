<script setup lang="ts">
/*
 * One theme of the library: a live miniature of the app in the theme, the
 * name, its origin badge, the appearances it has (and which halves use it)
 * and a menu. The whole card is one button (a stretched overlay); the menu
 * trigger sits above it. Broken user files show their error and a way to
 * fix them instead of a preview.
 */
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Moon,
  MoreHorizontal,
  Pencil,
  Sun,
  SunMoon,
  Trash2,
} from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
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
  (e: "export", forT3: boolean): void;
  (e: "delete"): void;
}>();

const badge = computed(() => themeBadge(props.entry));
const chips = computed(() => appearanceChips(props.entry, props.settings));
const used = computed(() => chips.value.some((chip) => chip.used));
const options = computed(() => useOptions(props.entry));
const editable = computed(() => props.entry.source !== "builtin");
const usedLabel = computed(() => {
  const halves = chips.value.filter((chip) => chip.used).map((chip) => chip.appearance);
  if (halves.length === 2) return "in use for light and dark mode";
  return halves.length ? `in use for ${halves[0]} mode` : "";
});

const BADGE_VARIANT = {
  muted: "muted",
  accent: "accent",
  info: "info",
  outline: "outline",
  destructive: "destructive",
} as const;

const optionIcon = (mode: ThemeAppearance | "both") =>
  mode === "both" ? SunMoon : mode === "light" ? Sun : Moon;

const menuOpen = ref(false);
</script>

<template>
  <div
    class="group relative rounded-lg border bg-card p-1.5 shadow-xs transition-[border-color,box-shadow] duration-fast focus-within:border-border-strong hover:border-border-strong"
    :class="used ? 'border-primary ring-2 ring-primary/20 hover:border-primary focus-within:border-primary' : ''"
    :data-theme-card="entry.id"
    @pointerenter="emit('hover', true)"
    @pointerleave="emit('hover', false)"
  >
    <!-- The card's own button: stretched over the whole card. -->
    <button
      v-if="!entry.error"
      type="button"
      class="absolute inset-0 z-0 rounded-lg focus-ring focus-visible:ring-offset-card"
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

    <div class="pointer-events-none relative flex items-center gap-1.5 px-1 pt-2">
      <span class="truncate text-sm font-medium text-foreground" :title="entry.name">{{ entry.name }}</span>
      <Badge size="sm" :variant="BADGE_VARIANT[badge.tone]">
        {{ badge.label }}
      </Badge>
      <DropdownMenu v-model:open="menuOpen">
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-xs"
            class="pointer-events-auto z-10 ml-auto text-muted-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
              <DropdownMenuItem @select="emit('export', true)">For T3 Code…</DropdownMenuItem>
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

    <div class="pointer-events-none relative flex h-6 items-center gap-1 px-1 pt-1">
      <template v-if="!entry.error">
        <span
          v-for="chip in chips"
          :key="chip.appearance"
          class="pointer-events-none inline-flex h-5 items-center gap-1 rounded-[5px] border px-1.5 text-xs"
          :class="
            chip.used
              ? 'border-primary/30 bg-primary/10 font-medium text-link'
              : 'border-border-subtle text-muted-foreground'
          "
          :title="
            chip.used
              ? `Used in ${chip.appearance} mode${chip.native ? '' : ' (paints its own appearance)'}`
              : `Has a ${chip.appearance} appearance`
          "
        >
          <Check v-if="chip.used" class="h-3 w-3" />
          <component :is="chip.appearance === 'light' ? Sun : Moon" v-else class="h-3 w-3" />
          {{ chip.appearance === "light" ? "Light" : "Dark" }}
        </span>
        <span
          v-if="chips.length === 2 && chips.every((chip) => chip.used)"
          class="pointer-events-none ml-auto text-xs text-muted-foreground"
        >
          Both modes
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
