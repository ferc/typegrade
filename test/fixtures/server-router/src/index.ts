/**
 * Server-router fixture: a server-side router with middleware patterns.
 * No client-side navigation (no Link, no navigate, no searchParams).
 */

/** HTTP request object */
export interface Request {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

/** HTTP response object */
export interface Response {
  status(code: number): Response;
  json(data: unknown): void;
  send(body: string): void;
  setHeader(name: string, value: string): Response;
}

/** Route handler function */
export type Handler = (req: Request, res: Response) => void | Promise<void>;

/** Middleware function with next callback */
export type Middleware = (req: Request, res: Response, next: () => void) => void | Promise<void>;

/** Server instance */
export interface Server {
  listen(port: number, callback?: () => void): void;
  close(): void;
}

/** Router instance with route registration */
export interface Router {
  get(path: string, handler: Handler): Router;
  post(path: string, handler: Handler): Router;
  put(path: string, handler: Handler): Router;
  delete(path: string, handler: Handler): Router;
  use(middleware: Middleware): Router;
  route(prefix: string): Router;
}

/** Create a new server instance */
export function createServer(): Server & Router {
  return {} as Server & Router;
}

/** Create a new router */
export function createRouter(): Router {
  return {} as Router;
}

/** Apply middleware to all routes */
export function use(middleware: Middleware): void {}

/** Start listening on a port */
export function listen(port: number, callback?: () => void): Server {
  return {} as Server;
}

/** Create a middleware stack */
export function compose(...middlewares: Middleware[]): Middleware {
  return {} as Middleware;
}

/** Parse JSON request body middleware */
export function jsonParser(): Middleware {
  return {} as Middleware;
}

/** CORS middleware */
export function cors(options?: { origin: string | string[] }): Middleware {
  return {} as Middleware;
}
