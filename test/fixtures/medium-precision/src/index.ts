export interface User {
  name: string;
  age: number;
}

export enum Role {
  Admin = "admin",
  User = "user",
  Guest = "guest",
}

export function getUser(id: number): User {
  return { age: 0, name: "" };
}

export function setRole(role: Role): void {}

export function listUsers(): User[] {
  return [];
}
