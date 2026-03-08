export interface Column<T> {
  name: string;
  type: T;
  nullable: boolean;
}

export interface Table<T extends Record<string, Column<unknown>>> {
  name: string;
  columns: T;
}

export type Schema = Record<string, Table<Record<string, Column<unknown>>>>;

export function column<T>(name: string, type: T): Column<T> {
  return { name, type, nullable: false };
}

export function table<T extends Record<string, Column<unknown>>>(
  name: string,
  columns: T,
): Table<T> {
  return { name, columns };
}

export function query<T>(table: Table<T>): T[] {
  return [];
}

export function migration(name: string, up: () => void, down: () => void): void {}
