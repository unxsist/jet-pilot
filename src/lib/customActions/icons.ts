import type { Component } from "vue";
import {
  Activity,
  BookOpen,
  Box,
  Bug,
  Cable,
  ChartLine,
  Clipboard,
  Cloud,
  Code,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Flame,
  Gauge,
  GitBranch,
  Globe,
  HeartPulse,
  KeyRound,
  Layers,
  Link,
  Package,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  ScrollText,
  Search,
  Server,
  Shield,
  Sparkles,
  SquareTerminal,
  Wrench,
  Zap,
} from "lucide-vue-next";

/*
 * The icons a custom action can use (`icon:` in its file), by their lucide
 * names. A curated set keeps menus calm and the bundle small.
 */
export const ACTION_ICONS: Record<string, Component> = {
  zap: Zap,
  "external-link": ExternalLink,
  globe: Globe,
  link: Link,
  "chart-line": ChartLine,
  gauge: Gauge,
  activity: Activity,
  "heart-pulse": HeartPulse,
  "scroll-text": ScrollText,
  terminal: SquareTerminal,
  code: Code,
  copy: Copy,
  clipboard: Clipboard,
  "rotate-ccw": RotateCcw,
  "refresh-cw": RefreshCw,
  play: Play,
  rocket: Rocket,
  bug: Bug,
  database: Database,
  "git-branch": GitBranch,
  cable: Cable,
  search: Search,
  "file-text": FileText,
  "book-open": BookOpen,
  wrench: Wrench,
  shield: Shield,
  "key-round": KeyRound,
  package: Package,
  box: Box,
  layers: Layers,
  cloud: Cloud,
  server: Server,
  flame: Flame,
  sparkles: Sparkles,
};

export const ACTION_ICON_NAMES = Object.keys(ACTION_ICONS);

/** Icon when the file names none (or one outside the set). */
export const DEFAULT_ACTION_ICON = "zap";

export const actionIconComponent = (name: string | undefined): Component =>
  ACTION_ICONS[name ?? ""] ?? ACTION_ICONS[DEFAULT_ACTION_ICON]!;
