type BaseCommand = {
  id: string;
  name: string;
  description?: string;
  keywords?: string[];
  /**
   * Options of a command are cached and shown while they are re-fetched.
   * When the options depend on app state (e.g. the current context), return
   * a key describing that state: cached options are only shown when the key
   * still matches.
   */
  cacheKey?: () => string;
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
