/** Configuration options */
export interface Config {
  host: string;
  port: number;
  debug?: boolean;
}

/** Create a client with the given configuration */
export declare function createClient(config: Config): Client;

/** Client interface */
export interface Client {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

/** Event types emitted by the client */
export type ClientEvent = "connect" | "disconnect" | "error";
