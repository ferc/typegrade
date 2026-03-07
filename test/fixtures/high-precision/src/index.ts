/** Status of a user account */
export type Status = "active" | "inactive" | "pending";

/** Branded user ID */
export type UserId = string & { __brand: "UserId" };

/** Discriminated union of shapes */
export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number };

/** Template literal API path */
export type ApiPath = `/api/${string}`;

/** Get a user by branded ID */
export function getUser(id: UserId): Shape {
  return { kind: "circle", radius: 1 };
}

/** Set a user's status */
export function setStatus(status: Status): void {}

/** Fetch an API endpoint */
export function fetchEndpoint(path: ApiPath): Promise<unknown> {
  return Promise.resolve(undefined);
}

/** Compute area of a shape */
export function computeArea(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "square":
      return shape.side ** 2;
  }
}
