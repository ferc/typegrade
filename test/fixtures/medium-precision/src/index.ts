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
  return { name: "", age: 0 };
}

export function setRole(role: Role): void {}

export function listUsers(): User[] {
  return [];
}
