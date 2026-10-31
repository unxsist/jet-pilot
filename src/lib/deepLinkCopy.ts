/*
 * "Copy link" in the side panel's menu and the tables' row menu. Loaded when
 * used: the pure link code is in deepLink.ts.
 */
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "@/components/ui/toast";
import { homePath } from "@/lib/kubeconfigSources";
import { buildLink, objectLink, type DeepLink, type LinkableObject } from "@/lib/deepLink";

async function copy(url: string, what: string) {
  try {
    await writeText(url);
  } catch {
    try {
      await navigator.clipboard?.writeText(url);
    } catch {
      toast({ title: "Couldn't copy to the clipboard", variant: "destructive" });
      return;
    }
  }
  toast({ title: "Copied link", description: what, autoDismiss: true });
}

/** A table row or panel object (tagged with its cluster). */
export async function copyObjectLink(object: LinkableObject) {
  const url = objectLink(object, await homePath());
  if (url) await copy(url, `${object.kind} ${object.metadata?.name}`);
}

export async function copyLink(link: DeepLink, what: string) {
  await copy(buildLink(link, await homePath()), what);
}
