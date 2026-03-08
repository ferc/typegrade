/** Parse data from input */
export function parse(input: any): any {
  return { name: input, age: 0 };
}

/** Format a record to display string */
export function format(record: any): any {
  return `${record.name} (${record.age})`;
}

/** Validate that input matches expected shape */
export function validate(input: any): any {
  return input.length > 0;
}
