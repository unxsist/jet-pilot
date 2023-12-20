type BaseCommand = {
  id: string;
  name: string;
  description?: string;
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
