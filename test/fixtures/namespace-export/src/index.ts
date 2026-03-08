/** Namespace with exported members */
export namespace Utils {
  export function parse(input: string): number {
    return parseInt(input, 10);
  }

  export interface Options {
    strict: boolean;
    timeout: number;
  }

  export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
}

/** Regular export alongside namespace */
export function main(opts: Utils.Options): string {
  return "done";
}
