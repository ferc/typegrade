/**
 * CLI builder fixture: a CLI library with fluent builder pattern.
 * Expected domain: cli
 */

/** Parsed option value types */
export type OptionType = "string" | "number" | "boolean";

/** Option configuration */
export interface OptionConfig {
  description: string;
  type: OptionType;
  required?: boolean;
  alias?: string;
  default?: string | number | boolean;
}

/** Parsed command-line arguments */
export interface ParsedArgs {
  command: string;
  options: Record<string, string | number | boolean>;
  positionals: string[];
}

/** Command definition */
export interface CommandDefinition {
  name: string;
  description: string;
  options: Record<string, OptionConfig>;
  action?: (args: ParsedArgs) => void | Promise<void>;
  subcommands: CommandDefinition[];
}

/** CLI program builder with fluent API */
export class Program {
  private readonly commands: CommandDefinition[] = [];
  private readonly globalOptions: Record<string, OptionConfig> = {};

  /** Set the program name */
  name(programName: string): Program {
    return this;
  }

  /** Set the program version */
  version(ver: string): Program {
    return this;
  }

  /** Set the program description */
  description(desc: string): Program {
    return this;
  }

  /** Add a command to the program */
  command(name: string, description?: string): Command {
    return new Command(name, description ?? "");
  }

  /** Add a global option */
  option(flags: string, description: string, defaultValue?: string | number | boolean): Program {
    return this;
  }

  /** Parse argv and execute the matched command */
  parse(argv?: string[]): ParsedArgs {
    return { command: "", options: {}, positionals: [] };
  }

  /** Parse argv asynchronously */
  parseAsync(argv?: string[]): Promise<ParsedArgs> {
    return Promise.resolve(this.parse(argv));
  }
}

/** Individual command builder */
export class Command {
  constructor(
    private readonly commandName: string,
    private readonly desc: string,
  ) {}

  /** Add an option to this command */
  option(flags: string, description: string, defaultValue?: string | number | boolean): Command {
    return this;
  }

  /** Add a required argument */
  argument(name: string, description?: string): Command {
    return this;
  }

  /** Add a subcommand */
  command(name: string, description?: string): Command {
    return new Command(name, description ?? "");
  }

  /** Set the action handler */
  action(handler: (args: ParsedArgs) => void | Promise<void>): Command {
    return this;
  }

  /** Show help text */
  help(): string {
    return "";
  }
}

/** Create a new program instance */
export function createProgram(): Program {
  return new Program();
}

/** Parse command-line arguments with minimal configuration */
export function parseArgs(argv: string[]): ParsedArgs {
  return { command: "", options: {}, positionals: [] };
}
