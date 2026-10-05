/** Two-column settings row: label + one line of description left, control right. */
export const settingsRow =
  "grid grid-cols-1 gap-3 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-10";

/** Full-width settings row (lists, log output). */
export const settingsBlock = "space-y-3 py-4";

/** Row label and its description. */
export const settingsLabel = "text-sm text-foreground";
export const settingsHint = "text-xs text-muted-foreground";

/** Icon tile of a list row (tools, credentials, files). */
export const settingsTile =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-1 text-muted-foreground";
