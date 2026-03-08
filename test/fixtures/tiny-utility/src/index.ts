/**
 * Tiny utility fixture: a small but complete utility library.
 * Single file with 15+ well-typed declarations.
 * Expected: compact sampling class, not undersampled.
 */

/** Clamp a number between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Deep freeze an object */
export function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return obj;
}

/** Check if a value is defined (not null or undefined) */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Group array elements by a key function */
export function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key]!.push(item);
  }
  return result;
}

/** Create a debounced version of a function */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

/** Pick specific keys from an object */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/** Omit specific keys from an object */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete (result as Record<string, unknown>)[key as string];
  }
  return result as Omit<T, K>;
}

/** Create a unique array preserving insertion order */
export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Chunk an array into groups of a given size */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

/** Flatten a nested array one level deep */
export function flatten<T>(items: T[][]): T[] {
  return items.reduce<T[]>((acc, arr) => acc.concat(arr), []);
}

/** Map over object values */
export function mapValues<T, U>(
  obj: Record<string, T>,
  fn: (value: T, key: string) => U,
): Record<string, U> {
  const result: Record<string, U> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = fn(value, key);
  }
  return result;
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Assert a condition, throwing if false */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violation: ${message}`);
  }
}

/** Safe JSON parse that returns undefined on failure */
export function tryParse(json: string): unknown | undefined {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** Capitalize the first letter of a string */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Type-safe entries for an object */
export function entries<T extends Record<string, unknown>>(obj: T): [keyof T, T[keyof T]][] {
  return Object.entries(obj) as [keyof T, T[keyof T]][];
}

/** Create a range of numbers [start, end) */
export function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let idx = start; idx < end; idx++) {
    result.push(idx);
  }
  return result;
}
