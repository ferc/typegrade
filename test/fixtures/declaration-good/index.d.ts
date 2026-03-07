export type Status = "active" | "inactive" | "pending";
export type UserId = string & { __brand: "UserId" };

export interface User {
  id: UserId;
  name: string;
  status: Status;
  createdAt: Date;
}

export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "triangle"; base: number; height: number };

export declare function getUser(id: UserId): Promise<User>;
export declare function setStatus(id: UserId, status: Status): Promise<void>;
export declare function computeArea(shape: Shape): number;

export interface TypedEmitter<TEvents extends Record<string, unknown>> {
  on<K extends keyof TEvents>(event: K, handler: (data: TEvents[K]) => void): void;
  emit<K extends keyof TEvents>(event: K, data: TEvents[K]): void;
}
