type BaseCommand = {
  id: string;
  name: string;
  description?: string;
  keywords?: string[];
  /** Keyboard shortcut shown as a hint, e.g. ["Ctrl", "1"]. */
  shortcut?: string[];
  /**
   * Options of a command are cached and shown while they are re-fetched.
   * When the options depend on app state (e.g. the current context), return
   * a key describing that state: cached options are only shown when the key
   * still matches.
   */
  cacheKey?: () => string;
  /** Options: heading of the group the option is listed under (in order of appearance). */
  group?: string;
  /** Options: small colour dots after the name (CSS backgrounds, e.g. a theme's canvas + accent). */
  swatches?: string[];
  /** Options: a short muted label on the right, e.g. "Current". */
  badge?: string;
  /** Options: called while the option is highlighted by the user (debounced), e.g. to preview it. */
  onHighlight?: () => void;
  /** Commands with options: called when the options close (chosen, Esc or the palette closing). */
  onLeave?: () => void;
  /** Only listed while searching (e.g. one item per setting), under "Settings". */
  searchOnly?: boolean;
};

type ExecutableCommand = {
  execute: () => void;
  commands?: undefined;
};

type CommandWithOptions = {
  execute?: undefined;
  commands: () => Promise<Command[]>;
};

export type Command = BaseCommand & (ExecutableCommand | CommandWithOptions);
