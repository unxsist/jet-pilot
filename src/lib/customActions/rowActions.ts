/*
 * Custom actions as table row actions: a "Custom" group at the end of the
 * row menu (only the ones whose scope matches the row), and mass actions
 * in the selection bar for `multiple` ones. Running loads ./run.ts.
 */
import { computed, type ComputedRef } from "vue";
import { type as osType } from "@tauri-apps/plugin-os";
import type { RowAction } from "@/components/tables/types";
import { useCustomActions } from "./store";
import { actionIconComponent } from "./icons";
import { matchesScope } from "./scope";
import { shortcutKeys } from "./shortcut";
import { customActionKind } from "./plan";
import type { CustomAction } from "./types";
import type { RunHost } from "./run";

export const CUSTOM_GROUP = "Custom";

export async function runCustom(action: CustomAction, objects: Record<string, any>[], host: RunHost) {
  const { runCustomAction } = await import("./run");
  await runCustomAction(action, objects, host);
}

const isMac = osType() === "macos";

export function toRowAction<T>(action: CustomAction, host: () => RunHost): RowAction<T> {
  const base = {
    label: action.name,
    kind: customActionKind(action),
    icon: actionIconComponent(action.icon),
    group: CUSTOM_GROUP,
    ...(action.shortcut ? { shortcut: shortcutKeys(action.shortcut, isMac) } : {}),
    isAvailable: (row: T) => matchesScope(action, row as Record<string, any>),
  };
  if (action.scope.multiple) {
    return {
      ...base,
      massAction: true,
      handler: (rows: T[]) => void runCustom(action, rows as Record<string, any>[], host()),
    };
  }
  return { ...base, handler: (row: T) => void runCustom(action, [row as Record<string, any>], host()) };
}

/** The enabled custom actions as row actions (reactive: the folder is watched). */
export function useCustomRowActions<T>(host: () => RunHost): ComputedRef<RowAction<T>[]> {
  const { actions } = useCustomActions();
  return computed(() => actions.value.map((action) => toRowAction<T>(action, host)));
}
