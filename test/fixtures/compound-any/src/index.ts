export function fetchData(): Promise<any> {
  return Promise.resolve(null);
}

export function getItems(): any[] {
  return [];
}

export function getConfig(): Record<string, any> {
  return {};
}

export function getMap(): Map<string, any> {
  return new Map();
}

export interface ApiResponse {
  data: any;
  items: any[];
  meta: Record<string, any>;
}
