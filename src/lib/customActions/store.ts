/*
 * The custom actions the app knows about, for every surface that shows them
 * (row menus, the side panel, the command palette, Settings › Actions).
 * Cheap to import: the folder runtime (fs, YAML parser, watcher) is loaded
 * on first use and keeps `actionFiles` current (hot reload).
 */
import { computed, shallowRef } from "vue";
import { runtimeSettings } from "@/lib/settings/runtime";
import type { ActionFile, CustomAction } from "./types";

export const actionFiles = shallowRef<ActionFile[]>([]);
/** The folder was read at least once. */
export const actionsReady = shallowRef(false);

type Runtime = Awaited<ReturnType<typeof import("./runtime")["startActionsRuntime"]>>;

let runtime: Promise<Runtime> | null = null;

/** Starts (once) and returns the folder runtime. */
export function actionsRuntime(): Promise<Runtime> {
  if (!runtime) {
    runtime = import("./runtime").then((module) =>
      module.startActionsRuntime((files) => {
        actionFiles.value = files;
        actionsReady.value = true;
      })
    );
    runtime.catch(() => (runtime = null));
  }
  return runtime;
}

/** Ids of the actions turned off in Settings › Actions (settings.json). */
export const disabledActionIds = (): string[] => runtimeSettings()?.actions?.disabled ?? [];

/** Valid, turned-on actions (reactive). Starts the runtime on first use. */
export const enabledActions = computed<CustomAction[]>(() => {
  const disabled = new Set(disabledActionIds());
  return actionFiles.value.flatMap((file) =>
    file.action && !disabled.has(file.id) ? [file.action] : []
  );
});

export function useCustomActions() {
  void actionsRuntime().catch(() => undefined);
  return { files: actionFiles, actions: enabledActions, ready: actionsReady };
}
