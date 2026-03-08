/** Fetch a user record by identifier */
export function getUser(id: number): any {
  return { id, name: "test" };
}

/** List items with pagination */
export function listItems(page: number): any {
  return { items: ["item"], total: page };
}

/** Parse configuration from raw string */
export function parseConfig(raw: string): any {
  return { host: raw, port: 3000 };
}

/** Compute statistics from numeric array */
export function computeStats(values: number[]): { mean: number; max: number } {
  const max = Math.max(...values);
  const mean = values.reduce((acc, vv) => acc + vv, 0) / values.length;
  return { mean, max };
}

/** Validate input and return structured errors */
export function validateInput(input: string): { valid: boolean; errors: string[] } {
  if (input.length === 0) {
    return { valid: false, errors: ["Input must not be empty"] };
  }
  return { valid: true, errors: [] };
}
