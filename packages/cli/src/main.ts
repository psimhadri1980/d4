#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { runCli } from './cli';

runCli(process.argv.slice(2), {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  env: process.env,
  fetch,
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, t) => writeFile(p, t, 'utf8'),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e);
    process.exitCode = 1;
  },
);
