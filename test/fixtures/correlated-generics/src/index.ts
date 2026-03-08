export interface Builder<TState extends Record<string, unknown>> {
  set<K extends string, V>(key: K, value: V): Builder<TState & Record<K, V>>;
  build(): TState;
}

export function createBuilder(): Builder<{}> {
  const state: Record<string, unknown> = {};
  const builder: Builder<any> = {
    build() {
      return state as any;
    },
    set(key, value) {
      state[key] = value;
      return builder;
    },
  };
  return builder;
}

export function pipe<A, B>(fn: (a: A) => B): (a: A) => B;
export function pipe<A, B, C>(f1: (a: A) => B, f2: (b: B) => C): (a: A) => C;
export function pipe(...fns: Function[]): Function {
  return (x: unknown) => fns.reduce((v, f) => f(v), x);
}

export function map<T, U>(arr: T[], fn: (item: T, index: number) => U): U[] {
  return arr.map(fn);
}

export function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

export interface EventMap {
  click: { x: number; y: number };
  keypress: { key: string; code: number };
  scroll: { deltaX: number; deltaY: number };
}

export function on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
  // Implementation
}
