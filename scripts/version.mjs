#!/usr/bin/env node
// One version for the server, the web app and the iOS app. It lives in version.json;
// the files the builds read are written from it.
//
//   node scripts/version.mjs            show the current version
//   node scripts/version.mjs build      next build: 0.2.0 (7) -> 0.2.0 (8)
//   node scripts/version.mjs set 0.3.0  new version, and the next build
//   node scripts/version.mjs sync       rewrite the derived files without changing anything
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'version.json');
const current = JSON.parse(readFileSync(file, 'utf8'));
const [command, value] = process.argv.slice(2);

if (command === 'set') {
  if (!/^\d+\.\d+\.\d+$/.test(value ?? '')) {
    console.error('usage: node scripts/version.mjs set <major.minor.patch>');
    process.exit(1);
  }
  current.version = value;
  current.build += 1;
} else if (command === 'build') {
  current.build += 1;
} else if (command && command !== 'sync') {
  console.error(`unknown command "${command}"; use build, set or sync`);
  process.exit(1);
}

if (command) {
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  writeFileSync(
    resolve(root, 'ios/Version.xcconfig'),
    `// Written by scripts/version.mjs from version.json. Do not edit.\nAPP_VERSION = ${current.version}\nAPP_BUILD = ${current.build}\n`,
  );
  const pkg = resolve(root, 'server/package.json');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace(/"version": "[^"]*"/, `"version": "${current.version}"`));
  const lockFile = resolve(root, 'server/package-lock.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  lock.version = lock.packages[''].version = current.version;
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(resolve(root, 'server/public/version.js'),
    `// Written by scripts/version.mjs from version.json. Do not edit.\nexport default ${JSON.stringify(current)};\n`);
  const worker = resolve(root, 'server/public/sw.js');
  writeFileSync(worker, readFileSync(worker, 'utf8').replace(/const VERSION = '[^']*';/,
    `const VERSION = 'v${current.version}-b${current.build}';`));
}
console.log(`${current.version} (${current.build})`);
