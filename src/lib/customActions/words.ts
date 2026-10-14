import type { CustomAction, RunType } from "./types";

/* Plain words about custom actions, shared by the form, previews and menus. */

/** The "What it does" choices of the form editor. */
export const RUN_LABELS: Record<RunType, string> = {
  open: "Open URL",
  command: "Run command",
  kubectl: "kubectl",
  exec: "Exec",
  patch: "Patch",
  copy: "Copy",
};

/** Heading of a preview. */
export const PREVIEW_LABELS: Record<RunType, string> = {
  open: "Will open",
  command: "Will run",
  kubectl: "Will run",
  exec: "Will run",
  patch: "Will patch",
  copy: "Will copy",
};

/** The button that runs the action. */
export function runVerb(action: Pick<CustomAction, "run">): string {
  switch (action.run.type) {
    case "open":
      return "Open";
    case "copy":
      return "Copy";
    case "patch":
      return "Apply";
    case "exec":
      return action.run.command ? "Run" : "Open shell";
    default:
      return "Run";
  }
}
