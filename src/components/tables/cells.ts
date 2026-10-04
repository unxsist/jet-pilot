import { h } from "vue";
import { StatusDot } from "@/components/ui/status";
import type { StatusTone as UiStatusTone } from "@/components/ui/status";
import ContextAvatar from "@/components/ContextAvatar.vue";
import type { StatusTone } from "./status";

/*
 * Shared cell renderers / classes so every resource table reads the same:
 * a status dot + label for states, muted secondary text, monospace for
 * machine values (IPs, images, ports).
 */

/** Secondary information: namespaces, nodes, ages. */
export const mutedCell = "text-muted-foreground";

/** Machine values: IPs, ports, images, hashes. */
export const monoCell = "font-mono text-xs text-muted-foreground";

const uiTone = (tone: StatusTone): UiStatusTone =>
  tone === "none" ? "muted" : tone;

/* Healthy states keep neutral text: the dot carries the colour. */
const labelClass: Record<StatusTone, string> = {
  success: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  none: "text-foreground",
};

/** Status dot + label, e.g. for pod / node / release states. */
export const statusCell = (label: string, tone: StatusTone) =>
  label
    ? h("span", { class: "inline-flex max-w-full items-center gap-2" }, [
        h(StatusDot, { tone: uiTone(tone) }),
        h("span", { class: ["truncate", labelClass[tone]] }, label),
      ])
    : "";

/** Context name with its monogram (multi-context tables). */
export const contextCell = (context: string) =>
  context
    ? h("span", { class: "inline-flex max-w-full items-center gap-2" }, [
        h(ContextAvatar, {
          name: context,
          size: "sm",
          class: "[--avatar-ring:var(--background)]",
        }),
        h("span", { class: "truncate text-muted-foreground" }, context),
      ])
    : "";
