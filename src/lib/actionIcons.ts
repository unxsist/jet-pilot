import type { Component } from "vue";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Ban,
  Cable,
  CircleCheck,
  FileCode2,
  FileText,
  OctagonX,
  PanelRight,
  Play,
  RotateCcw,
  Scaling,
  ScrollText,
  SquareTerminal,
  Trash2,
  Undo2,
} from "lucide-vue-next";

/* Leading icons for row / context menu actions, keyed by lower-case label. */
const ACTION_ICONS: Record<string, Component> = {
  "view details": PanelRight,
  "edit yaml": FileCode2,
  describe: FileText,
  logs: ScrollText,
  shell: SquareTerminal,
  "port forward": Cable,
  scale: Scaling,
  restart: RotateCcw,
  rollback: Undo2,
  trigger: Play,
  cordon: Ban,
  uncordon: CircleCheck,
  drain: ArrowDownToLine,
  "go to object": ArrowUpRight,
  delete: Trash2,
  kill: OctagonX,
  uninstall: Trash2,
};

/* Actions that remove or disrupt something: rendered in the destructive tone. */
const DESTRUCTIVE_ACTIONS = new Set(["delete", "kill", "uninstall", "drain"]);

export const actionIcon = (label: string): Component | null =>
  ACTION_ICONS[label.trim().toLowerCase()] ?? null;

export const isDestructiveAction = (label: string): boolean =>
  DESTRUCTIVE_ACTIONS.has(label.trim().toLowerCase());
