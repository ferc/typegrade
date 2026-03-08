export type InferOutput<T> = T extends Schema<infer O> ? O : never;

export interface Schema<T = unknown> {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: string };
}

export function string(): Schema<string> {
  return {
    parse: (input: unknown) => String(input),
    safeParse: (input: unknown) => ({ success: true, data: String(input) }),
  };
}

export function number(): Schema<number> {
  return {
    parse: (input: unknown) => Number(input),
    safeParse: (input: unknown) => ({ success: true, data: Number(input) }),
  };
}

export function object<T extends Record<string, Schema>>(
  shape: T,
): Schema<{ [K in keyof T]: InferOutput<T[K]> }> {
  return {
    parse: (input: unknown) => input as any,
    safeParse: (input: unknown) => ({ success: true, data: input as any }),
  };
}
