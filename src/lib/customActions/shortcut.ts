/*
 * Shortcuts of custom actions ("Mod+Shift+G", pure, unit tested): the keys
 * shown in menus and whether a key press is the shortcut. Mod is ⌘ on
 * macOS and Ctrl elsewhere. Keys are matched by their physical code, so
 * Alt/Option combinations work on every layout.
 */
export interface ShortcutEvent {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface Parsed {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parse(shortcut: string, isMac: boolean): Parsed | null {
  const parts = shortcut.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  if (!key) return null;
  const parsed: Parsed = { ctrl: false, meta: false, alt: false, shift: false, key: key.toUpperCase() };
  for (const part of parts) {
    if (part === "mod") parsed[isMac ? "meta" : "ctrl"] = true;
    else if (part === "ctrl") parsed.ctrl = true;
    else if (part === "cmd" || part === "meta") parsed.meta = true;
    else if (part === "alt") parsed.alt = true;
    else if (part === "shift") parsed.shift = true;
    else return null;
  }
  return parsed;
}

/** The keys to show, e.g. ["⌘", "⇧", "G"] on macOS, ["Ctrl", "Shift", "G"] elsewhere. */
export function shortcutKeys(shortcut: string, isMac: boolean): string[] {
  const parsed = parse(shortcut, isMac);
  if (!parsed) return [];
  const keys: string[] = [];
  if (parsed.ctrl) keys.push(isMac ? "⌃" : "Ctrl");
  if (parsed.alt) keys.push(isMac ? "⌥" : "Alt");
  if (parsed.shift) keys.push(isMac ? "⇧" : "Shift");
  if (parsed.meta) keys.push(isMac ? "⌘" : "Meta");
  keys.push(parsed.key);
  return keys;
}

const codeOf = (key: string) => (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : key);

export function matchesShortcut(shortcut: string, event: ShortcutEvent, isMac: boolean): boolean {
  const parsed = parse(shortcut, isMac);
  if (!parsed) return false;
  return (
    event.code === codeOf(parsed.key) &&
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}
