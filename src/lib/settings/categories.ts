/*
 * Layout of the settings page: categories (the sidebar) and their sections
 * (cards). A section shows the rows of the preferences defined for it
 * (./registry.ts) and/or a bespoke component that renders its own card
 * (theme library, kubeconfig files, tools, ...). Bespoke sections are found
 * by search through their title, description and keywords.
 */
import type { Component } from "vue";
import {
  Palette,
  Server,
  SlidersHorizontal,
  SquareTerminal,
  Table2,
  Wrench,
} from "lucide-vue-next";
import { SETTINGS } from "./registry";
import type { SettingCategoryId, SettingDefinition } from "./types";

export interface SettingSection {
  id: string;
  title: string;
  description?: string;
  /** Extra search terms (bespoke sections). */
  keywords?: string[];
  /** Renders the whole card itself (instead of, or after, the rows card). */
  component?: () => Promise<{ default: Component }>;
}

export interface SettingCategory {
  id: SettingCategoryId;
  title: string;
  description: string;
  icon: Component;
  sections: SettingSection[];
}

export const CATEGORIES: readonly SettingCategory[] = [
  {
    id: "general",
    title: "General",
    description: "Updates, your settings file and JET Pilot itself",
    icon: SlidersHorizontal,
    sections: [
      { id: "updates", title: "Updates", description: "New releases and what's in them" },
      {
        id: "data",
        title: "Your settings",
        description: "Edit settings.json, move your setup to another machine, or start over",
        keywords: ["settings.json", "import", "export", "backup", "reset", "json", "dotfiles"],
        component: () => import("@/components/settings/sections/SettingsDataSection.vue"),
      },
      {
        id: "about",
        title: "About JET Pilot",
        description: "Version, website and how to support the project",
        keywords: ["version", "sponsor", "donate", "github", "license", "support"],
        component: () => import("@/components/settings/sections/AboutSection.vue"),
      },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    description: "Light and dark modes, themes and the theme gallery",
    icon: Palette,
    sections: [
      {
        id: "mode",
        title: "Mode",
        description: "Light, dark, or follow your system",
        component: () => import("@/components/settings/sections/ColorSchemeSection.vue"),
      },
      {
        id: "themes",
        title: "Themes",
        description: "Your theme library, importing themes and the Open VSX gallery",
        keywords: ["theme", "import", "gallery", "open vsx", "vs code", "sublime", "textmate", "colors"],
        component: () => import("@/components/settings/sections/ThemesSection.vue"),
      },
    ],
  },
  {
    id: "terminal",
    title: "Terminal & Editor",
    description: "Built-in terminals, shells and the YAML editor",
    icon: SquareTerminal,
    sections: [
      { id: "terminal", title: "Terminal", description: "Local terminals and container shells" },
      { id: "shells", title: "Shells", description: "Programs started in terminals" },
      { id: "editor", title: "Editor", description: "The YAML editor, diffs and JSON files" },
    ],
  },
  {
    id: "tables",
    title: "Tables & Logs",
    description: "How lists stay up to date and how logs open",
    icon: Table2,
    sections: [
      { id: "live", title: "Live updates", description: "Keeping resource lists current" },
      { id: "logs", title: "Logs", description: "Defaults for the log viewer" },
    ],
  },
  {
    id: "clusters",
    title: "Clusters",
    description: "Kubeconfig files and per-cluster namespaces",
    icon: Server,
    sections: [
      {
        id: "kubeconfigs",
        title: "Kubeconfig files",
        description: "Where your contexts come from",
        keywords: ["kubeconfig", "KUBECONFIG", "contexts", "clusters", "files", "~/.kube/config"],
        component: () => import("@/components/settings/sections/KubeconfigSourcesSection.vue"),
      },
      {
        id: "namespaces",
        title: "Namespaces per cluster",
        description: "Namespaces to offer for clusters where you can't list them",
        keywords: ["namespaces", "rbac", "forbidden", "cluster settings"],
        component: () => import("@/components/settings/sections/ClusterNamespacesSection.vue"),
      },
    ],
  },
  {
    id: "advanced",
    title: "Advanced",
    description: "Tools, network, debugging and diagnostics",
    icon: Wrench,
    sections: [
      {
        id: "tools",
        title: "Command-line tools",
        description: "kubectl, Helm and cloud CLIs JET Pilot uses",
        keywords: ["kubectl", "helm", "aws", "gcloud", "az", "kubelogin", "doctl", "download", "install", "path"],
        component: () => import("@/components/settings/sections/ToolsSection.vue"),
      },
      { id: "network", title: "Network", description: "Talking to API servers" },
      { id: "debug", title: "Debugging", description: "Debug containers and node shells" },
      {
        id: "environment",
        title: "Environment",
        description: "Variables JET Pilot takes over from your login shell",
        keywords: ["PATH", "env", "environment variables", "shell", "proxy", "KUBECONFIG", "AWS_PROFILE"],
        component: () => import("@/components/settings/sections/EnvironmentSection.vue"),
      },
      { id: "diagnostics", title: "Diagnostics", description: "JET Pilot's own application log" },
      {
        id: "app-log",
        title: "Application log",
        description: "Live output of the JET Pilot backend",
        keywords: ["logs", "export logs", "troubleshoot", "bug report"],
        component: () => import("@/components/settings/sections/AppLogSection.vue"),
      },
    ],
  },
];

export const categoryById = (id: string) => CATEGORIES.find((category) => category.id === id);

/** Visible preference rows of a section (bespoke sections edit hidden ones). */
export function sectionSettings(
  category: SettingCategoryId,
  section: string,
  platform?: string
): SettingDefinition[] {
  return SETTINGS.filter(
    (def) =>
      def.category === category &&
      def.section === section &&
      !def.hidden &&
      (!def.platforms || !platform || def.platforms.includes(platform as never))
  );
}

export const sectionAnchor = (section: string) => `section-${section}`;
export const settingAnchor = (key: string) => `setting-${key.replace(/\./g, "-")}`;
