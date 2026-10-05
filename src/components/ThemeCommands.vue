<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { type as getOsType } from "@tauri-apps/plugin-os";
import type { Command } from "@/command-palette";
import { injectStrict } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import {
  RegisterCommandStateKey,
  ShowSingleCommandKey,
} from "@/providers/CommandPaletteProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useTheme } from "@/providers/ThemeProvider";
import { themeGroup, type ThemeGroup } from "@/lib/themes/runtime";
import type { ColorScheme, ThemeAppearance, ThemeEntry } from "@/lib/themes/types";

/*
 * Command palette entries for the app theme, with T3 Code's shortcuts:
 * "Change theme…" (Mod+Alt+A) lists the themes; moving the highlight
 * previews them live, Enter applies, Esc / closing reverts. "Change
 * appearance" picks System / Light / Dark; Mod+Alt+Shift+A cycles them.
 */
const registerCommand = injectStrict(RegisterCommandStateKey);
const showSingleCommand = injectStrict(ShowSingleCommandKey);
const { settings } = injectStrict(SettingsContextStateKey);
const theme = useTheme();
const { toast } = useToast();
const isMac = getOsType() === "macos";
const mod = isMac ? "⌘" : "Ctrl";
const alt = isMac ? "⌥" : "Alt";

const GROUP_ORDER: ThemeGroup[] = ["Built-in", "T3 Code", "Yours", "Open VSX"];
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/* A circle per appearance: canvas with an accent wedge. */
const swatches = async (entry: ThemeEntry) => {
  try {
    const resolved = await Promise.all(
      entry.appearances.map((appearance) => theme.resolve(entry.id, appearance))
    );
    return resolved.map(
      ({ roles }) => `linear-gradient(135deg, ${roles.canvas} 55%, ${roles.accent} 55%)`
    );
  } catch {
    return [];
  }
};

/* Which halves a theme is saved for. */
const badge = (id: string) => {
  const { lightTheme, darkTheme } = settings.value.appearance;
  if (id === lightTheme && id === darkTheme) return "Current";
  if (id === lightTheme) return "Light";
  if (id === darkTheme) return "Dark";
  return undefined;
};

/*
 * T3's rule: a theme with both appearances is used for both; a theme with
 * one claims that half only (Dracula becomes the dark theme and shows when
 * the appearance is dark).
 */
const apply = (entry: ThemeEntry) => {
  const [only] = entry.appearances.length === 1 ? entry.appearances : [];
  theme.setTheme(entry.id, only ?? "both");
  if (only && only !== currentWanted()) {
    toast({
      title: `${entry.name} is your ${only} theme`,
      description: `It shows when the appearance is ${only}.`,
    });
  }
};

/* The appearance the colour scheme asks for (not the one painted). */
const currentWanted = (): ThemeAppearance => {
  const scheme = settings.value.appearance.colorScheme;
  if (scheme !== "auto") return scheme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

/* Previews only while the list is open (a late, debounced highlight is ignored). */
let listOpen = false;

/*
 * Options are reused while nothing about them changed: the palette shows
 * the cached list first and refreshes it while open, and the combobox
 * loses the highlight (and Enter) when its option objects are replaced.
 */
const options = new Map<string, Command>();
const option = async (entry: ThemeEntry, group: ThemeGroup): Promise<Command> => {
  const current = badge(entry.id);
  const key = `${entry.id}|${group}|${current}`;
  const cached = options.get(key);
  if (cached && cached.name === entry.name) return cached;
  const command: Command = {
    id: `theme:${entry.id}`,
    name: entry.name,
    description:
      entry.appearances.length === 1 ? `${capitalize(entry.appearances[0])} only` : undefined,
    keywords: [entry.id, group],
    group,
    badge: current,
    swatches: await swatches(entry),
    onHighlight: () => {
      if (listOpen) void theme.preview(entry.id);
    },
    execute: () => apply(entry),
  };
  options.set(key, command);
  return command;
};

registerCommand({
  id: "change-theme",
  name: "Change theme…",
  description: "Preview themes as you move through them",
  keywords: ["theme", "colors", "colours", "palette", "appearance", "dark", "light"],
  shortcut: [mod, alt, "A"],
  cacheKey: () =>
    [
      ...theme.themes.value.map((entry) => `${entry.id}:${entry.name}`),
      settings.value.appearance.lightTheme,
      settings.value.appearance.darkTheme,
    ].join("|"),
  commands: async () => {
    listOpen = true;
    // The list comes with the lazy theme runtime.
    await theme.resolved();
    const entries = theme.themes.value
      .filter((entry) => !entry.error)
      .map((entry) => ({ entry, group: themeGroup(entry) }))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    return Promise.all(entries.map(({ entry, group }) => option(entry, group)));
  },
  onLeave: () => {
    listOpen = false;
    void theme.preview(null);
  },
});

const SCHEMES: { scheme: ColorScheme; label: string }[] = [
  { scheme: "auto", label: "System" },
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
];
const schemeLabel = (scheme: ColorScheme) =>
  SCHEMES.find((option) => option.scheme === scheme)?.label ?? scheme;

registerCommand({
  id: "change-appearance",
  name: "Change appearance",
  get description() {
    return `${schemeLabel(settings.value.appearance.colorScheme)} · System, Light or Dark`;
  },
  keywords: ["appearance", "dark", "light", "system", "mode", "color scheme"],
  shortcut: [mod, alt, "⇧", "A"],
  cacheKey: () => settings.value.appearance.colorScheme,
  commands: async () =>
    SCHEMES.map(({ scheme, label }) => ({
      id: `appearance:${scheme}`,
      name: label,
      badge: settings.value.appearance.colorScheme === scheme ? "Current" : undefined,
      execute: () => theme.setColorScheme(scheme),
    })),
});

const cycleAppearance = () => {
  const current = SCHEMES.findIndex(
    ({ scheme }) => scheme === settings.value.appearance.colorScheme
  );
  const next = SCHEMES[(current + 1) % SCHEMES.length];
  theme.setColorScheme(next.scheme);
  toast({ title: `Appearance: ${next.label}` });
};

/*
 * In-window shortcuts (not OS-global), like Mod+K: they work in dialogs
 * and fields too, only terminals keep their keys. event.code: Option+A
 * types "å" on macOS.
 */
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  if (!modifier || !event.altKey || event.code !== "KeyA" || event.repeat) return;
  if (isMac ? event.ctrlKey : event.metaKey) return;
  if ((event.target as Element | null)?.closest?.(".xterm")) return;
  event.preventDefault();
  if (event.shiftKey) cycleAppearance();
  else showSingleCommand("change-theme");
});
</script>

<template>
  <slot />
</template>
