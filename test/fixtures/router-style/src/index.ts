export interface Request {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: Record<string, string>;
}

export interface Response {
  status: number;
  body: unknown;
}

export type Handler = (req: Request, res: Response) => void;
export type Middleware = (req: Request, res: Response, next: () => void) => void;

export function createRouter(): { get: (path: string, handler: Handler) => void } {
  return { get: () => {} };
}

export function route(path: string, handler: Handler): void {}
export function middleware(fn: Middleware): Middleware {
  return fn;
}
