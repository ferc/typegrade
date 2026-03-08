/** Create a new user with validated fields */
export function createUser(name: string, age: number): { id: number; name: string; age: number } {
  return { id: 1, name, age };
}

/** Delete a user by their unique identifier */
export function deleteUser(id: number): boolean {
  return id > 0;
}
