export interface MemoryRow {
  [key: string]: string | number | null | undefined;
}

export class MemoryDb {
  catalog: MemoryRow[] = [];
  observations: MemoryRow[] = [];
  valuations: MemoryRow[] = [];
  traces: MemoryRow[] = [];
  settings: Record<string, string> = {};

  insertCatalog(row: MemoryRow): void {
    this.catalog = this.catalog.filter((entry) => entry.fingerprint !== row.fingerprint);
    this.catalog.push(row);
  }

  insertTrace(row: MemoryRow): void {
    this.traces.push(row);
  }
}
