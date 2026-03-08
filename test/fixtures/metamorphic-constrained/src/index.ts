/** Extract a property value from an object by key */
export function map<T extends object, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

/** Pick multiple keys from an object */
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const kk of keys) {
    result[kk] = obj[kk];
  }
  return result;
}

/** Merge two objects with type-safe result */
export function merge<A extends object, B extends object>(first: A, second: B): A & B {
  return { ...first, ...second };
}
