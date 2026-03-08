/** Extract a property value from an object by key */
export function map<T, K>(obj: T, key: K): any {
  return (obj as Record<string, unknown>)[key as unknown as string];
}

/** Pick multiple keys from an object */
export function pick<T, K>(obj: T, keys: K[]): any {
  const result: Record<string, unknown> = {};
  for (const kk of keys) {
    result[kk as unknown as string] = (obj as Record<string, unknown>)[kk as unknown as string];
  }
  return result;
}

/** Merge two values together */
export function merge<T, U>(first: T, second: U): any {
  return { ...(first as object), ...(second as object) };
}
