/*
 * The objects the user is on in the visible resource table (the selected
 * rows, else the row under the keyboard cursor): what custom actions from
 * the command palette and their shortcuts run on. The table publishes it;
 * a hidden (kept-alive) or closed table withdraws its own.
 */
import { shallowRef } from "vue";

type Objects = readonly Record<string, any>[];

const current = shallowRef<{ owner: symbol; objects: Objects } | null>(null);

export function publishFocus(owner: symbol, objects: Objects): void {
  const previous = current.value;
  if (previous?.owner === owner && previous.objects.length === objects.length && previous.objects.every((o, i) => o === objects[i])) {
    return;
  }
  current.value = { owner, objects };
}

export function withdrawFocus(owner: symbol): void {
  if (current.value?.owner === owner) current.value = null;
}

/** The focused table objects (reactive); empty when there are none. */
export const focusedObjects = (): Objects => current.value?.objects ?? [];
