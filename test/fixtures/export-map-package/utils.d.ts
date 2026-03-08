/** Retry an async operation with exponential backoff */
export declare function retry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T>;

/** Format a duration in milliseconds to a human-readable string */
export declare function formatDuration(ms: number): string;

/** Parse a connection string into host and port */
export declare function parseConnectionString(connStr: string): { host: string; port: number };
