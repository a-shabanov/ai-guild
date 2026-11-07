// An optional boundary around a piece of work, usually one request: everything it touches
// (database schema, files, public address, events) can differ from the install's defaults.
// A plain install never enters a scope and runs on its settings from the environment.
// Holds no SQL and imports nothing from the app, so config.ts and db.ts can both read it.
import { AsyncLocalStorage } from 'node:async_hooks';

export type Scope = {
  /** Identifies the scope: events, passkey challenges and cached keys stay within it. */
  key: string;
  /** Requires DB_SCOPED=1. */
  dbSchema?: string;
  dataDir?: string;
  publicUrl?: string;
  maxUploadBytes?: number;
};

const store = new AsyncLocalStorage<Scope>();

export const currentScope = (): Scope | undefined => store.getStore();
export const runInScope = <T>(scope: Scope, fn: () => T): T => store.run(scope, fn);
/** Empty outside any scope. */
export const scopeKey = (): string => store.getStore()?.key ?? '';
