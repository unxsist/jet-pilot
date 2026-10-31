/**
 * Pop-out windows: a bottom-panel tab, or a whole view, in a window of its
 * own (a second monitor, a log tail next to the terminal...).
 *
 * The main window (label "main") owns every pop-out window (labels
 * "pop-<id>"): it opens them, remembers them in state.json (they come back
 * on the next start) and is the only window that writes settings. A pop-out
 * window loads the same app at "/", asks the main window what to show
 * (`window://ready` → `window://payload`) and reports its open tabs and
 * position back (`window://state`), so the main window can restore it
 * (the messages: WINDOW_EVENTS in @/lib/windowRecords).
 *
 * Backend resources (watches, log streams, shells) belong to the window
 * that started them: reloading or closing a window only stops its own. A
 * running shell moves between windows without restarting: the source
 * releases it (`tty_release`), the target attaches to it (`tty_attach`) and
 * gets its recent output replayed.
 */
import type { InjectionKey } from "vue";
import type { TabDescriptor, TabSession } from "@/lib/tabDescriptors";
import type { WorkspaceContext } from "@/lib/workspaces";

export const MAIN_WINDOW = "main";
export const POP_OUT_PREFIX = "pop-";

/** backend → main: the main window is closing, quit the app (see WINDOW_EVENTS). */
export const QUIT_REQUESTED_EVENT = "window://quit-requested";

/**
 * "tabs": bottom-panel tabs filling the window (its own tab strip).
 * "view": a resource view (its own navigation history, side panel and tabs).
 */
export type WindowKind = "tabs" | "view";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPayload {
  kind: WindowKind;
  /** View windows: the full path of the view. */
  route: string | null;
  /** The clusters (and namespaces) the window works with: those active when it opened. */
  contexts: WorkspaceContext[];
  tabs: TabSession;
  /**
   * Running shells that move along (tab id → pty session id). Only for the
   * move itself; never stored (sessions end with the app).
   */
  attach?: Record<string, string>;
}

/** A pop-out window as the main window remembers it (state.json `windows`). */
export interface WindowRecord extends WindowPayload {
  label: string;
  bounds: WindowBounds | null;
}

export interface WindowStateReport {
  label: string;
  tabs?: TabSession;
  route?: string | null;
  bounds?: WindowBounds;
}

export interface TabTransfer {
  label: string;
  tab: TabDescriptor;
  /** pty session id of a running shell (released by the pop-out window). */
  session?: string;
}

/*
 * Set once the app is quitting: pop-out windows closing because of it are
 * not forgotten (they come back on the next start).
 */
let quitting = false;
export const beginQuit = () => {
  quitting = true;
};
export const isQuitting = () => quitting;

export const isPopOutLabel = (label: unknown): label is string =>
  typeof label === "string" && /^pop-[a-z0-9-]+$/.test(label);

/**
 * The label of this window, read synchronously from the Tauri metadata
 * (the visual QA harness mocks it, see dev/harness/setup.ts `?window=`).
 */
export function currentWindowLabel(): string {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
    .__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  if (typeof label === "string" && label) return label;
  return MAIN_WINDOW;
}

export const isMainWindow = () => !isPopOutLabel(currentWindowLabel());

/* ------------------------------------------------------------ main API -- */

export interface Windows {
  /** Opens a view in a new window (and closes the split pane it came from). */
  openView(path: string, options?: { closePane?: number }): Promise<void>;
  /** Moves a bottom-panel tab into a new window (a running shell keeps running). */
  moveTab(tabId: string): Promise<void>;
  /** Whether a tab can move to a window (restorable kinds only). */
  canMoveTab(tabId: string): boolean;
}

/** Provided in the main window only (WindowsProvider). */
export const WindowsKey: InjectionKey<Windows> = Symbol("Windows");

/* --------------------------------------------------------- pop-out API -- */

export interface PopOut {
  label: string;
  payload: WindowPayload;
  /** Puts a tab back into the main window (and closes it here). */
  moveTabToMain(tabId: string): Promise<void>;
  /** Shows this window's view in the main window and closes this window. */
  viewToMain(): Promise<void>;
  close(): Promise<void>;
}

/** Provided in pop-out windows (PopOutApp). */
export const PopOutKey: InjectionKey<PopOut> = Symbol("PopOut");
