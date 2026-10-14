/*
 * Shared by Settings › Actions (list, examples, form and YAML editors):
 * turning actions on and off (settings.json), and file operations through
 * the actions runtime with their error toasts.
 */
import { toast } from "@/components/ui/toast";
import { actionsRuntime } from "@/lib/customActions/store";
import type { Settings } from "@/lib/settings/types";

export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

export function isEnabled(settings: Settings, id: string): boolean {
  return !(settings.actions?.disabled ?? []).includes(id);
}

export function setEnabled(settings: Settings, id: string, enabled: boolean): void {
  const disabled = (settings.actions.disabled ?? []).filter((other) => other !== id);
  if (!enabled) disabled.push(id);
  settings.actions.disabled = disabled.sort();
}

/** The name in a file, also when it doesn't parse (for broken files). */
export const nameInText = (text: string): string | null =>
  /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1]?.trim() || null;

export async function openActionsFolder(): Promise<void> {
  try {
    await (await actionsRuntime()).openFolder();
  } catch (e) {
    toast({ title: "Couldn't open the actions folder", description: errorMessage(e), variant: "destructive" });
  }
}

export async function writeActionFile(file: string, text: string): Promise<boolean> {
  try {
    await (await actionsRuntime()).write(file, text);
    return true;
  } catch (e) {
    toast({ title: `Couldn't save ${file}`, description: errorMessage(e), variant: "destructive" });
    return false;
  }
}

export async function removeActionFile(file: string): Promise<boolean> {
  try {
    await (await actionsRuntime()).remove(file);
    return true;
  } catch (e) {
    toast({ title: `Couldn't delete ${file}`, description: errorMessage(e), variant: "destructive" });
    return false;
  }
}
