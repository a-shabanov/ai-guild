// What a service around the tracker may build on: the public surface of the core when it is embedded in another
// process, such as a host of many teams. Each request runs in a scope (scope.ts) that gives it its own schema, files
// and address. Everything else in this directory can change between versions without notice.
// A self-hosted install needs none of this: it runs server.ts and never enters a scope.
export { buildApp } from './server.ts';
export { runInScope } from './scope.ts';
export type { OidcSettings, Scope } from './scope.ts';
export { migrate, pool } from './db.ts';
export { createAccount, deleteAccount, listAccounts, rotateKey, updateAccount } from './service.ts';
export { linkOidcIdentity, oidcAccount } from './social-auth.ts';
