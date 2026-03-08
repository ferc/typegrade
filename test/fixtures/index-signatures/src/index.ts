/** Interface with index signature */
export interface StringMap {
  [key: string]: string;
}

/** Interface with call signature */
export interface Callable {
  (arg: string): number;
}

/** Interface with construct signature */
export interface Constructable {
  new (name: string): { name: string };
}

/** Interface with both properties and index signature */
export interface Config {
  name: string;
  version: number;
  [key: string]: string | number;
}

/** Interface with multiple signatures */
export interface Complex {
  readonly id: string;
  (input: number): boolean;
  new (data: string[]): Complex;
  [index: number]: string;
}
