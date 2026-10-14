/*
 * Custom actions: one-click actions the user teaches JET Pilot with small
 * YAML files in $APPCONFIG/actions (one action per file). The file format is
 * documented by the JSON schema in ./jsonSchema.ts; ./schema.ts parses and
 * validates it into the shape below.
 */

/** What an action does (exactly one `run` key in the file). */
export type RunType = "open" | "command" | "kubectl" | "exec" | "patch" | "copy";

export const RUN_TYPES: readonly RunType[] = ["open", "command", "kubectl", "exec", "patch", "copy"];

/** A value asked before the action runs (`{{input.<name>}}`). */
export interface ActionInput {
  name: string;
  label: string;
  /** Pre-filled value. */
  default?: string;
  placeholder?: string;
  /** A pick list instead of a text field. */
  options?: string[];
  /** Numbers are inserted as numbers into patches. */
  type: "text" | "number";
}

export interface ActionScope {
  /** Kind names ("Pod", "Deployment", or "Application.argoproj.io"); empty: any kind. */
  kinds: string[];
  /** Namespace globs ("prod-*", "!kube-system"); empty: any namespace. */
  namespaces: string[];
  /** Context globs; empty: any context. */
  contexts: string[];
  /** A label selector ("app=web,tier in (api,worker)"); empty: any labels. */
  labels: string;
  /** Also runs on several selected objects at once. */
  multiple: boolean;
}

export type ActionRun =
  | { type: "open"; template: string }
  | { type: "copy"; template: string }
  | { type: "command"; template: string; background: boolean }
  /** kubectl arguments as templates, one per argument (split before rendering). */
  | { type: "kubectl"; args: string[]; background: boolean }
  /** `command` empty: the container shell. */
  | { type: "exec"; command: string; container: string }
  /** A JSON merge patch whose strings are templates. */
  | { type: "patch"; patch: unknown };

export interface CustomAction {
  /** File name without its extension (unique in the folder). */
  id: string;
  name: string;
  description: string;
  /** Icon name from ACTION_ICON_NAMES. */
  icon: string;
  /** e.g. "Mod+Shift+G"; empty: none. */
  shortcut: string;
  scope: ActionScope;
  inputs: ActionInput[];
  run: ActionRun;
  /** Asked before running; empty: no question (guardrails still apply). */
  confirm: string;
  /** Changes the cluster: guardrails (read-only blocks it, protected asks to type). */
  mutates: boolean;
}

export interface ActionProblem {
  message: string;
  /** 1-based line in the file, when known. */
  line?: number;
  /** Where in the action, e.g. "run.open" (the form editor puts the message there). */
  path?: string;
}

/** A file of the actions folder: an action, or why it isn't one. */
export interface ActionFile {
  /** e.g. "grafana.yaml" */
  file: string;
  id: string;
  /** Absolute path (shown, and opened in the editor). */
  path: string;
  text: string;
  action: CustomAction | null;
  error: ActionProblem | null;
}

/** What a template can refer to for one object. */
export interface TemplateContext {
  object: Record<string, any>;
  context: string;
  kubeConfig: string;
  inputs: Record<string, string>;
  /** The chosen container (`{{container}}`, `{{image}}`). */
  container?: string;
}
