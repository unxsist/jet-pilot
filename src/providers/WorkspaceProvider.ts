import {
  computed,
  provide,
  InjectionKey,
  onUnmounted,
  type ComputedRef,
  type SetupContext,
} from "vue";
import { useRouter } from "vue-router";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { injectStrict } from "@/lib/utils";
import { error as logError } from "@/lib/logger";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import {
  KubeContextSetActivationKey,
  KubeContextStateKey,
} from "@/providers/KubeContextProvider";
import { PanelProviderSessionKey } from "@/providers/PanelProvider";
import { PortForwardingProfilesKey } from "@/providers/PortForwardingProvider";
import { RegisterCommandStateKey } from "@/providers/CommandPaletteProvider";
import {
  createWorkspace,
  describeWorkspace,
  MAX_WORKSPACES,
  nextWorkspaceName,
  parseWorkspaces,
  updateWorkspace,
  type Workspace,
  type WorkspaceState,
} from "@/lib/workspaces";

export interface Workspaces {
  workspaces: ComputedRef<Workspace[]>;
  active: ComputedRef<Workspace | null>;
  /** Saves the current state as a new workspace and makes it active. */
  saveAs(name?: string): Workspace | null;
  /** Overwrites a workspace with the current state. */
  update(id: string): void;
  switchTo(id: string): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
}

export const WorkspacesKey: InjectionKey<Workspaces> = Symbol("Workspaces");

/** Mod+Alt+1..9 switches to the n-th workspace. */
export const WORKSPACE_SHORTCUT_COUNT = 9;

export default {
  name: "WorkspaceProvider",
  setup(_props: unknown, { slots }: SetupContext) {
    const { settings } = injectStrict(SettingsContextStateKey);
    const { contexts, contextKubeConfigMapping } =
      injectStrict(KubeContextStateKey);
    const setActivation = injectStrict(KubeContextSetActivationKey);
    const panel = injectStrict(PanelProviderSessionKey);
    const pfProfiles = injectStrict(PortForwardingProfilesKey);
    const registerCommand = injectStrict(RegisterCommandStateKey);
    const router = useRouter();

    const workspaces = computed(() =>
      parseWorkspaces(settings.value.workspaces)
    );
    const active = computed(
      () =>
        workspaces.value.find(
          (w) => w.id === settings.value.activeWorkspaceId
        ) ?? null
    );
    const setWorkspaces = (next: Workspace[]) => {
      settings.value.workspaces = next;
    };

    const captureState = (): WorkspaceState => ({
      contexts: [...contexts.value.entries()].map(([context, namespaces]) => ({
        context,
        kubeConfig: contextKubeConfigMapping.value.get(context) || "",
        namespaces: [...namespaces],
      })),
      tabs: panel.snapshot(),
      portForwardProfileIds: pfProfiles.profiles.value
        .filter((profile) => pfProfiles.isRunning(profile))
        .map((profile) => profile.id),
      route: router.currentRoute.value.fullPath,
    });

    const update = (id: string) => {
      const state = captureState();
      setWorkspaces(
        workspaces.value.map((w) =>
          w.id === id ? updateWorkspace(w, state) : w
        )
      );
    };

    const saveAs = (name?: string) => {
      if (workspaces.value.length >= MAX_WORKSPACES) {
        return null;
      }
      const workspace = createWorkspace(
        name || nextWorkspaceName(workspaces.value),
        captureState()
      );
      setWorkspaces([...workspaces.value, workspace]);
      settings.value.activeWorkspaceId = workspace.id;
      return workspace;
    };

    const switchTo = (id: string) => {
      const target = workspaces.value.find((w) => w.id === id);
      if (!target || target.id === active.value?.id) {
        return;
      }

      // Keep the workspace we leave as the user left it.
      if (active.value) {
        update(active.value.id);
      }
      settings.value.activeWorkspaceId = target.id;

      setActivation(target.contexts);
      panel.restore(target.tabs, { replace: true });
      for (const profileId of target.portForwardProfileIds) {
        pfProfiles
          .start(profileId)
          .catch((e) => logError(`Failed to start port forward: ${e}`));
      }
      if (target.route && target.route !== router.currentRoute.value.fullPath) {
        router.push(target.route).catch(() => {});
      }
    };

    const rename = (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setWorkspaces(
        workspaces.value.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
      );
    };

    const remove = (id: string) => {
      setWorkspaces(workspaces.value.filter((w) => w.id !== id));
      if (settings.value.activeWorkspaceId === id) {
        settings.value.activeWorkspaceId = null;
      }
    };

    provide(WorkspacesKey, {
      workspaces,
      active,
      saveAs,
      update,
      switchTo,
      rename,
      remove,
    });

    /* ------------------------------------------------- command palette -- */

    const isMac = getOsType() === "macos";

    registerCommand({
      id: "switch-workspace",
      shortcut: isMac ? ["⌘", "⌥", "1–9"] : ["Ctrl", "Alt", "1–9"],
      name: "Switch workspace",
      description: "Contexts, namespaces, tabs and port forwards",
      keywords: ["workspace", "hotbar", "profile", "layout"],
      cacheKey: () =>
        workspaces.value.map((w) => `${w.id}:${w.name}`).join("|") +
        `@${settings.value.activeWorkspaceId}`,
      commands: async () => [
        ...workspaces.value.map((workspace) => ({
          id: `workspace-${workspace.id}`,
          name: workspace.name,
          description:
            (workspace.id === active.value?.id ? "Current · " : "") +
            describeWorkspace(workspace),
          execute: () => switchTo(workspace.id),
        })),
        {
          id: "workspace-save-new",
          name: "Save current as new workspace",
          description: nextWorkspaceName(workspaces.value),
          execute: () => {
            saveAs();
          },
        },
      ],
    });

    registerCommand({
      id: "save-workspace",
      name: "Save workspace",
      description: "Store the current contexts, tabs and port forwards",
      keywords: ["workspace", "save", "snapshot"],
      execute: () => {
        if (active.value) update(active.value.id);
        else saveAs();
      },
    });

    /* ------------------------------------------------------- shortcuts -- */

    const onKeydown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || !event.altKey || event.shiftKey || event.repeat) {
        return;
      }
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      if (!match) return;
      const workspace = workspaces.value[Number(match[1]) - 1];
      if (!workspace) return;
      event.preventDefault();
      switchTo(workspace.id);
    };
    window.addEventListener("keydown", onKeydown);
    onUnmounted(() => window.removeEventListener("keydown", onKeydown));

    return () => slots.default?.();
  },
};
