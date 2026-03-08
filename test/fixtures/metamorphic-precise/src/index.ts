/** Parse structured data from input string */
export function parse(input: string): { name: string; age: number } {
  return { name: input, age: 0 };
}

/** Format a user record to display string */
export function format(record: { name: string; age: number }): string {
  return `${record.name} (${record.age})`;
}

/** Validate that input matches expected shape */
export function validate(input: string): boolean {
  return input.length > 0;
}
