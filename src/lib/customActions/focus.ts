/*
 * The objects the user is on in the visible resource table (the selected
 * rows, else the row under the keyboard cursor): what custom actions from
 * the command palette and their shortcuts run on. The table publishes it;
 * a hidden (kept-alive) or closed table withdraws its own.
 */
import { shallowRef } from "vue";

type Objects = readonly Record<string, any>[];

const current = shallowRef<{ owner: symbol; objects: Objects } | null>(null);
/*
 * Non-reactive mirror of `current` for the publish/withdraw checks. Reading
 * the ref there would make the publishing watchEffect (VirtualDataTable)
 * depend on `current` itself: during a keep-alive route swap both tables'
 * effects are alive for a moment and invalidate each other forever (owner
 * ping-pong), freezing the view in a microtask storm. The mirror is written
 * together with the ref; readers use the ref.
 */
let currentRaw: { owner: symbol; objects: Objects } | null = null;

export function publishFocus(owner: symbol, objects: Objects): void {
  const previous = currentRaw;
  if (previous?.owner === owner && previous.objects.length === objects.length && previous.objects.every((o, i) => o === objects[i])) {
    return;
  }
  currentRaw = { owner, objects };
  current.value = currentRaw;
}

export function withdrawFocus(owner: symbol): void {
  if (currentRaw?.owner === owner) {
    currentRaw = null;
    current.value = null;
  }
}

/** The focused table objects (reactive); empty when there are none. */
export const focusedObjects = (): Objects => current.value?.objects ?? [];
