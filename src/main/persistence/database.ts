import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  readSchemaVersion,
  runMigrations,
  type Migration,
} from "./migrations.js";
import {
  createRepositories,
  type PersistenceRepositories,
  type RepositoryContext,
} from "./repositories.js";

export interface LocalPersistenceOptions {
  clock?: () => Date | string | number;
  migrations?: readonly Migration[];
  timeoutMs?: number;
}

export class LocalPersistenceDatabase {
  readonly repositories: PersistenceRepositories;
  readonly catalogItems: PersistenceRepositories["catalogItems"];
  readonly itemObservations: PersistenceRepositories["itemObservations"];
  readonly valuations: PersistenceRepositories["valuations"];
  readonly ruleSets: PersistenceRepositories["ruleSets"];
  readonly presets: PersistenceRepositories["presets"];
  readonly buildProfiles: PersistenceRepositories["buildProfiles"];
  readonly gearTargets: PersistenceRepositories["gearTargets"];
  readonly scanSessions: PersistenceRepositories["scanSessions"];
  readonly scanSlots: PersistenceRepositories["scanSlots"];
  readonly settings: PersistenceRepositories["settings"];
  readonly provenance: PersistenceRepositories["provenance"];

  private readonly database: Database.Database;
  private closed = false;

  constructor(
    readonly filePath: string,
    options: LocalPersistenceOptions = {},
  ) {
    if (!filePath.trim()) throw new Error("SQLite database path is required");
    if (filePath !== ":memory:") mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    const timeout = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) {
      throw new Error("SQLite timeout must be an integer between 0 and 60000 milliseconds");
    }
    this.database = new Database(filePath, { timeout });
    try {
      this.database.pragma("foreign_keys = ON");
      this.database.pragma(`busy_timeout = ${timeout}`);
      this.database.pragma("trusted_schema = OFF");
      if (filePath !== ":memory:") {
        this.database.pragma("journal_mode = WAL");
        this.database.pragma("synchronous = NORMAL");
      }
      const clock = options.clock ?? (() => new Date());
      runMigrations(this.database, {
        ...(options.migrations ? { migrations: options.migrations } : {}),
        now: clock(),
      });
      const context: RepositoryContext = {
        database: this.database,
        now: clock,
      };
      this.repositories = createRepositories(context);
      this.catalogItems = this.repositories.catalogItems;
      this.itemObservations = this.repositories.itemObservations;
      this.valuations = this.repositories.valuations;
      this.ruleSets = this.repositories.ruleSets;
      this.presets = this.repositories.presets;
      this.buildProfiles = this.repositories.buildProfiles;
      this.gearTargets = this.repositories.gearTargets;
      this.scanSessions = this.repositories.scanSessions;
      this.scanSlots = this.repositories.scanSlots;
      this.settings = this.repositories.settings;
      this.provenance = this.repositories.provenance;
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get schemaVersion(): number {
    this.assertOpen();
    return readSchemaVersion(this.database);
  }

  get inTransaction(): boolean {
    this.assertOpen();
    return this.database.inTransaction;
  }

  transaction<T>(work: (repositories: PersistenceRepositories) => T): T {
    this.assertOpen();
    const execute = this.database.transaction(() => {
      const result = work(this.repositories);
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new Error("SQLite transactions must be synchronous");
      }
      return result;
    });
    return execute();
  }

  checkpoint(): void {
    this.assertOpen();
    if (this.filePath !== ":memory:") this.database.pragma("wal_checkpoint(PASSIVE)");
  }

  close(): void {
    if (this.closed) return;
    if (this.database.inTransaction) {
      throw new Error("Cannot close SQLite while a transaction is active");
    }
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite database is closed");
  }
}

export function openLocalPersistence(
  filePath: string,
  options: LocalPersistenceOptions = {},
): LocalPersistenceDatabase {
  return new LocalPersistenceDatabase(filePath, options);
}
