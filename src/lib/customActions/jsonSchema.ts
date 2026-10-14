/*
 * JSON schema of an action file: validation, completion and hovers in the
 * YAML editor (Settings › Actions › Edit as YAML). The descriptions are the
 * format's documentation. ./schema.ts implements the same rules (with
 * friendlier messages and template checks).
 */
import { ACTION_ICON_NAMES } from "./icons";

export const ACTION_SCHEMA_ID = "jet-pilot://schemas/action.json";

const TEMPLATE_HELP =
  "Variables like {{name}}, {{namespace}}, {{context}}, {{labels.app}}, {{.spec.replicas}}, {{image}} or {{input.<name>}}.";

const stringOrList = (description: string) => ({
  description,
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
});

export const ACTION_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  description:
    "A one-click action for objects in JET Pilot. One action per file in the actions folder; the file name is its id.",
  type: "object",
  additionalProperties: false,
  required: ["name", "run"],
  properties: {
    name: {
      type: "string",
      maxLength: 60,
      description: "Shown in menus, the side panel and the command palette, e.g. \"Open in Grafana\".",
    },
    description: { type: "string", description: "One quiet line about what it does." },
    icon: {
      type: "string",
      enum: ACTION_ICON_NAMES,
      default: "zap",
      description: "An icon from the curated set.",
    },
    shortcut: {
      type: "string",
      pattern: "^((Mod|Ctrl|Alt|Shift|Cmd|Meta)\\+)+([A-Za-z0-9]|F[1-9]|F1[0-2])$",
      description:
        "Runs the action on the selected object, e.g. \"Mod+Shift+G\" (Mod is ⌘ on macOS, Ctrl elsewhere). Needs Mod, Ctrl, Alt or Cmd.",
    },
    scope: {
      type: "object",
      additionalProperties: false,
      description: "Which objects the action shows up for. Leave it out for every object.",
      properties: {
        kinds: stringOrList(
          'Kinds, e.g. [Pod, Deployment], "*" for any kind, or Kind.group (Application.argoproj.io).'
        ),
        namespaces: stringOrList('Namespace globs, e.g. ["prod-*", "!kube-system"] (! excludes).'),
        contexts: stringOrList('Context globs, e.g. "prod-*".'),
        labels: {
          type: "string",
          description: 'A label selector, e.g. "app=web, tier in (api,worker), !canary".',
        },
        multiple: {
          type: "boolean",
          default: false,
          description: "Also run on several selected objects at once (once per object).",
        },
      },
    },
    inputs: {
      type: "array",
      description: "Values asked in a small form before the action runs; use them as {{input.<name>}}.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z_][\\w-]*$", description: "Used as {{input.<name>}}." },
          label: { type: "string", description: "The field's label." },
          default: { type: ["string", "number"], description: "Pre-filled value." },
          placeholder: { type: "string" },
          options: {
            type: "array",
            items: { type: ["string", "number"] },
            description: "A pick list instead of a text field.",
          },
          type: {
            type: "string",
            enum: ["text", "number"],
            default: "text",
            description: "number: inserted as a number into patches.",
          },
        },
      },
    },
    run: {
      type: "object",
      description: "What the action does: exactly one of open, command, kubectl, exec, patch or copy.",
      properties: {
        open: { type: "string", description: `A URL opened in your browser; values are URL-encoded (| raw inserts one as is). ${TEMPLATE_HELP}` },
        command: {
          type: "string",
          description: `A command run by your system shell (sh, PowerShell on Windows). Values are passed safely, never as code. KUBECONFIG points to the object's kubeconfig. ${TEMPLATE_HELP}`,
        },
        kubectl: {
          description: `kubectl arguments, e.g. "logs -f {{name}}". --context, --kubeconfig and --namespace are added for the object. ${TEMPLATE_HELP}`,
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        exec: {
          description: "A command run in the object's container (empty or true: a shell). Pods, or workloads (one of their pods).",
          anyOf: [{ type: "string" }, { type: "boolean", const: true }],
        },
        patch: {
          type: "object",
          description: `A JSON merge patch applied to the object, e.g. { spec: { replicas: "{{input.replicas}}" } }. Always changes the cluster. ${TEMPLATE_HELP}`,
        },
        copy: { type: "string", description: `Text copied to the clipboard. ${TEMPLATE_HELP}` },
        in: {
          type: "string",
          enum: ["terminal", "background"],
          default: "terminal",
          description: "command / kubectl: run in a terminal tab, or in the background with the result in a notification.",
        },
        container: {
          type: "string",
          description: "exec: the container, e.g. \"db\". Left out: asked when there are several.",
        },
      },
      additionalProperties: false,
      oneOf: [
        { required: ["open"] },
        { required: ["command"] },
        { required: ["kubectl"] },
        { required: ["exec"] },
        { required: ["patch"] },
        { required: ["copy"] },
      ],
    },
    confirm: {
      description: "Asked before running, e.g. \"Restart {{name}}?\" (true: a standard question).",
      anyOf: [{ type: "string" }, { type: "boolean" }],
    },
    mutates: {
      type: "boolean",
      default: false,
      description:
        "The action changes the cluster: read-only clusters block it and protected clusters ask you to type the name first.",
    },
  },
} as const;
