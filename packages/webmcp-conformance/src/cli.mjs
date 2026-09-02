#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { buildCatalogReport, formatCatalogMarkdown } from './report.mjs';
import { validateCatalogManifest } from './manifest.mjs';

const [command, ...args] = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const json = jsonIndex !== -1;
if (json) args.splice(jsonIndex, 1);

if (!['validate', 'catalog'].includes(command) || args.length === 0) {
  process.stderr.write('Usage: webmcp-conformance <validate|catalog> [--json] <manifest.json>...\n');
  process.exitCode = 2;
} else {
  try {
    const loaded = await Promise.all(args.map(loadManifest));
    if (command === 'validate') validate(loaded, json);
    else catalog(loaded, json);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function loadManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path, manifest };
}

function validate(loaded, json) {
  const results = loaded.map(({ path, manifest }) => ({ path, id: manifest?.id ?? null, ...validateCatalogManifest(manifest) }));
  if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    for (const result of results) {
      if (result.valid) process.stdout.write(`PASS ${result.path} (${result.id})\n`);
      else {
        process.stdout.write(`FAIL ${result.path}\n`);
        for (const issue of result.issues) process.stdout.write(`  ${issue.path} [${issue.code}] ${issue.message}\n`);
      }
    }
  }
  if (results.some((result) => !result.valid)) process.exitCode = 1;
}

function catalog(loaded, json) {
  const report = buildCatalogReport(loaded.map(({ manifest }) => manifest));
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatCatalogMarkdown(report));
}
