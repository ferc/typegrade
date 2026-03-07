export interface RouteConfig<
  TPath extends string,
  TParams extends Record<string, string>,
> {
  path: TPath;
  parse: (raw: string) => TParams;
}

export function createRoute<
  TPath extends string,
  TParams extends Record<string, string>,
>(config: RouteConfig<TPath, TParams>): { path: TPath; params: TParams } {
  return { path: config.path, params: {} as TParams };
}

export type EventName = `on${Capitalize<string>}`;

export interface TypedEventEmitter<TEvents extends Record<string, unknown>> {
  on<K extends keyof TEvents>(event: K, handler: (data: TEvents[K]) => void): void;
  emit<K extends keyof TEvents>(event: K, data: TEvents[K]): void;
}

export function createEmitter<
  TEvents extends Record<string, unknown>,
>(): TypedEventEmitter<TEvents> {
  const handlers = new Map<string, Function[]>();
  return {
    on(event, handler) {
      const key = event as string;
      if (!handlers.has(key)) handlers.set(key, []);
      handlers.get(key)!.push(handler);
    },
    emit(event, data) {
      const key = event as string;
      for (const h of handlers.get(key) ?? []) h(data);
    },
  };
}
