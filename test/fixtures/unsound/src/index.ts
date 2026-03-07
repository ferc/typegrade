interface User {
  name: string;
}

const x = JSON.parse("{}") as User;
const y = x as unknown as number;
const z = x!;
// @ts-expect-error
const broken = (undefined as any).foo;
// @ts-expect-error — intentional
const deliberate: number = "string" as any;

export function getData(): User {
  return JSON.parse("{}") as User;
}

export function processInput(input: string): number {
  return input as unknown as number;
}
