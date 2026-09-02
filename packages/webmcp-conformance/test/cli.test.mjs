import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const afterlist = fileURLToPath(new URL('../../../fixtures/afterlist.json', import.meta.url));
const projects = fileURLToPath(new URL('../../../fixtures/projects-extension.json', import.meta.url));

test('CLI validates fixtures and emits deterministic JSON catalog output', () => {
  const validated = run(['validate', afterlist, projects]);
  assert.equal(validated.status, 0);
  assert.match(validated.stdout, /PASS .*afterlist\.json \(afterlist\)/u);
  const catalog = run(['catalog', '--json', afterlist, projects]);
  assert.equal(catalog.status, 0);
  const report = JSON.parse(catalog.stdout);
  assert.deepEqual(report.summary.byDiscoveryClassification, { 'change-unknown': 5, 'read-only-hint': 6 });
  assert.deepEqual(report.summary.byProjectPolicyEffect, { 'local-draft': 2, presentation: 3, reader: 6 });
  assert.deepEqual(report.summary.byProjectPolicyInputSchemaProfile, { 'closed-bounded-v1': 11 });
});

test('CLI distinguishes validation failures from incorrect usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webmcp-conformance-'));
  try {
    const invalidPath = join(directory, 'invalid.json');
    await writeFile(invalidPath, JSON.stringify({ version: 1 }), 'utf8');
    const invalid = run(['validate', invalidPath]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /FAIL/u);
    const usage = run([]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}
