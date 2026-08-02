import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Apps Script triggers bind to global function names, and an IIFE exposes
// nothing. The footer shims re-expose the entry points as plain globals
// (spec §6 "The build gotcha"). Every trigger entry point added to
// src/main.ts needs a line here.
const footer = [
  'function dailyRun() { return App.dailyRun(); }',
  'function weeklyHeartbeat() { return App.weeklyHeartbeat(); }',
  'function verifySetup() { return App.verifySetup(); }',
  '',
].join('\n');

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'App',
  target: 'es2019',
  outfile: 'dist/bundle.js',
  footer: { js: footer },
  logLevel: 'info',
});

// clasp pushes the dist/ directory; the manifest must ship alongside the
// bundle so the pushed project always carries its scopes and services.
await copyFile('appsscript.json', 'dist/appsscript.json');
