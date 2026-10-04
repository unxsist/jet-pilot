/**
 * Shared class recipes for floating surfaces (menus, popovers, selects).
 * Keeping them in one place guarantees dropdown and context menus, popovers
 * and the command palette feel identical.
 */

/** Surface of any floating layer: popover token, hairline border, layered shadow. */
export const floatingSurface =
  "z-50 rounded-lg border bg-popover text-popover-foreground shadow-md outline-none";

/** Quick fade + subtle scale, nudged away from the trigger side. */
export const floatingMotion = [
  "data-[state=open]:animate-in data-[state=closed]:animate-out",
  "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
  "data-[state=open]:zoom-in-[0.97] data-[state=closed]:zoom-out-[0.98]",
  "data-[state=open]:duration-150 data-[state=closed]:duration-100 data-[state=open]:ease-out",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
].join(" ");

export const menuContent = `${floatingSurface} ${floatingMotion} min-w-[10rem] overflow-hidden p-1`;

/** Compact 28px menu row. */
export const menuItem = [
  "relative flex min-h-[1.75rem] cursor-default select-none items-center gap-2 rounded-[5px] px-2 py-1 text-sm outline-none",
  "transition-colors duration-75",
  "focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
  "[&_svg]:shrink-0",
].join(" ");

/** Destructive menu row (e.g. Delete). */
export const menuItemDestructive =
  "text-destructive focus:bg-destructive/10 focus:text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive";

/** Leading checkbox / radio indicator slot. */
export const menuIndicator =
  "absolute left-2 flex h-3.5 w-3.5 items-center justify-center";

export const menuLabel =
  "px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground";

export const menuSeparator = "-mx-1 my-1 h-px bg-border";

export const menuShortcut =
  "ml-auto pl-4 text-xs tracking-wide text-muted-foreground";
