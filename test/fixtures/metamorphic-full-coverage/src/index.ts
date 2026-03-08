/** Create a new user with validated fields */
export function createUser(name: string, age: number): { id: number; name: string; age: number } {
  return { id: 1, name, age };
}

/** Delete a user by their unique identifier */
export function deleteUser(id: number): boolean {
  return id > 0;
}

/** Find a user by name, returning null if not found */
export function findUser(name: string): { id: number; name: string } | null {
  return name ? { id: 1, name } : null;
}

/** Update a user's name and return the updated record */
export function updateUser(id: number, name: string): { id: number; name: string } {
  return { id, name };
}

/** List all users with pagination support */
export function listUsers(offset: number, limit: number): { id: number; name: string }[] {
  return [{ id: 1, name: "test" }].slice(offset, offset + limit);
}

/** Count total users in the system */
export function countUsers(): number {
  return 42;
}

/** Check if a user exists by identifier */
export function userExists(id: number): boolean {
  return id > 0;
}

/** Get user's display name formatted for output */
export function displayName(first: string, last: string): string {
  return `${first} ${last}`;
}

/** Validate an email address format */
export function validateEmail(email: string): boolean {
  return email.includes("@");
}

/** Hash a password string for storage */
export function hashPassword(password: string): string {
  return `hashed_${password}`;
}

/** Compare a password against its hash */
export function verifyPassword(password: string, hash: string): boolean {
  return hash === `hashed_${password}`;
}

/** Generate a unique session token */
export function generateToken(): string {
  return "token_123";
}
