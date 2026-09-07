import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { assertWornpageConsumer, inspectWornpageConsumer, WornpageConsumerCheckError } from '../src/index.mjs';
import { ARCHIVE, COMMIT, createValidConsumer, PACKAGE_NAME, readJson, writeJson } from './fixtures/consumer-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wornpage-consumer-check-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await createValidConsumer(root);
  return root;
}

async function useArchive(root, specifier) {
  const manifestPath = path.join(root, 'package.json');
  const manifest = await readJson(manifestPath);
  manifest.dependencies[PACKAGE_NAME] = specifier;
  await writeJson(manifestPath, manifest);
  for (const file of ['package-lock.json', path.join('node_modules', '.package-lock.json')]) {
    const target = path.join(root, file);
    const lock = await readJson(target);
    lock.packages[''].dependencies[PACKAGE_NAME] = specifier;
    lock.packages[`node_modules/${PACKAGE_NAME}`].resolved = specifier;
    await writeJson(target, lock);
  }
}

void test('preserves full source identity for consolidated historical transport archives', async (t) => {
  const root = await fixture(t);
  await useArchive(root, `https://github.com/wornpage/wornpage/releases/download/components-2026.09.07/wornpage-button-${COMMIT}.tar.gz`);
  const report = await assertWornpageConsumer({ root });
  assert.equal(report.packages[0].commit, COMMIT);
  assert.equal(report.packages[0].lockResolved, COMMIT);
  assert.equal(report.packages[0].installedResolved, COMMIT);
});

void test('records release tags and versions without pretending they are source commits', async (t) => {
  const root = await fixture(t);
  await useArchive(root, 'https://github.com/wornpage/wornpage/releases/download/components-2026.09.07/wornpage-button-0.0.0.tgz');
  const report = await assertWornpageConsumer({ root });
  assert.equal(report.packages[0].commit, null);
  assert.deepEqual(report.packages[0].release, {
    tag: 'components-2026.09.07', version: '0.0.0', lockTag: 'components-2026.09.07', lockVersion: '0.0.0', installedTag: 'components-2026.09.07', installedVersion: '0.0.0',
  });
  let output = '';
  assert.equal(await runCli([root, '--verbose'], { stdout: { write(value) { output += value; } } }), 0);
  assert.match(output, /components-2026\.09\.07@0\.0\.0/u);
});

void test('rejects release drift and a package version that differs from its asset', async (t) => {
  const root = await fixture(t);
  await useArchive(root, 'https://github.com/wornpage/wornpage/releases/download/components-2026.09.07/wornpage-button-0.0.0.tgz');
  const lockPath = path.join(root, 'package-lock.json');
  const lock = await readJson(lockPath);
  lock.packages[`node_modules/${PACKAGE_NAME}`].resolved = lock.packages[`node_modules/${PACKAGE_NAME}`].resolved.replace('2026.09.07', '2026.09.08');
  await writeJson(lockPath, lock);
  const pkgPath = path.join(root, 'node_modules', '@wornpage', 'button', 'package.json');
  const pkg = await readJson(pkgPath);
  pkg.version = '0.0.1';
  await writeJson(pkgPath, pkg);
  const report = await inspectWornpageConsumer({ root });
  assert.deepEqual(new Set(report.issues.map(issue => issue.code)), new Set(['lock_release_mismatch', 'installed_version_mismatch']));
});

void test('rejects mutable release aliases and archive/package name mismatches', async (t) => {
  const root = await fixture(t);
  for (const url of [
    'https://github.com/wornpage/wornpage/releases/latest/download/wornpage-button-0.0.0.tgz',
    'https://github.com/wornpage/wornpage/releases/download/components-2026.09.07/wornpage-alert-0.0.0.tgz',
  ]) {
    await useArchive(root, url);
    const report = await inspectWornpageConsumer({ root });
    assert.ok(report.issues.some(issue => issue.code === 'mutable_or_invalid_pin'));
  }
});

void test('rejects an old installed transport even when its source commit matches', async (t) => {
  const root = await fixture(t);
  await useArchive(root, `https://github.com/wornpage/wornpage/releases/download/components-2026.09.07/wornpage-button-${COMMIT}.tar.gz`);
  const installedPath = path.join(root, 'node_modules', '.package-lock.json');
  const installed = await readJson(installedPath);
  installed.packages[`node_modules/${PACKAGE_NAME}`].resolved = ARCHIVE;
  await writeJson(installedPath, installed);
  const report = await inspectWornpageConsumer({ root });
  assert.deepEqual(report.issues.map(issue => issue.code), ['installed_archive_mismatch']);
});

void test('accepts one immutable, locked, installed, and directly imported Wornpage package', async (t) => {
  const root = await fixture(t);
  const report = await assertWornpageConsumer({ root });
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.packages, [{
    name: PACKAGE_NAME,
    specifier: ARCHIVE,
    commit: COMMIT,
    lockResolved: COMMIT,
    installedResolved: COMMIT,
    contractVersion: 2,
    delivery: 'source',
    source: 'src/index.js',
    sourceAvailable: true,
    runtime: 'src/index.js',
    runtimeAvailable: true,
    imports: ['src/App.svelte'],
  }]);
});

void test('rejects mutable declarations, lock drift, and non-SHA-512 integrity', async (t) => {
  const root = await fixture(t);
  const manifestPath = path.join(root, 'package.json');
  const manifest = await readJson(manifestPath);
  manifest.dependencies[PACKAGE_NAME] = 'github:wornpage/button#main';
  await writeJson(manifestPath, manifest);
  const lockPath = path.join(root, 'package-lock.json');
  const lock = await readJson(lockPath);
  lock.packages[`node_modules/${PACKAGE_NAME}`].integrity = 'sha512-not-a-real-digest';
  await writeJson(lockPath, lock);

  const report = await inspectWornpageConsumer({ root });
  assert.equal(report.ok, false);
  assert.deepEqual(new Set(report.issues.map(({ code }) => code)), new Set([
    'lock_integrity_invalid',
    'lock_specifier_mismatch',
    'mutable_or_invalid_pin',
  ]));
  await assert.rejects(() => assertWornpageConsumer({ root }), WornpageConsumerCheckError);
});

void test('reports deep imports, undeclared imports, and unused declarations deterministically', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'src', 'App.svelte'), [
    "<script>",
    "  import Button from '@wornpage/button/src/Button.svelte';",
    "  import { Alert } from '@wornpage/alert';",
    "</script>",
    '<Button /><Alert />',
    '',
  ].join('\n'), 'utf8');
  const first = await inspectWornpageConsumer({ root });
  const second = await inspectWornpageConsumer({ root });
  assert.deepEqual(first.issues, second.issues);
  assert.deepEqual(first.issues.map(({ code }) => code), ['deep_import', 'undeclared_import']);

  await writeFile(path.join(root, 'src', 'App.svelte'), "<script>import { Alert } from '@wornpage/alert';</script>\n", 'utf8');
  const unused = await inspectWornpageConsumer({ root });
  assert.deepEqual(unused.issues.map(({ code }) => code), ['undeclared_import', 'unused_dependency']);
});

void test('fails when installed source or runtime entries are absent', async (t) => {
  const root = await fixture(t);
  const installedManifestPath = path.join(root, 'node_modules', '@wornpage', 'button', 'package.json');
  const installedManifest = await readJson(installedManifestPath);
  installedManifest.exports['.'].default = './dist/worn-button.js';
  installedManifest.files.push('dist');
  installedManifest.wornpage.delivery = 'browser-bundle';
  await writeJson(installedManifestPath, installedManifest);
  await unlink(path.join(root, 'node_modules', '@wornpage', 'button', 'src', 'index.js'));

  const report = await inspectWornpageConsumer({ root });
  assert.deepEqual(report.issues.map(({ code }) => code), ['installed_runtime_missing', 'installed_source_missing']);
  assert.equal(report.packages[0].sourceAvailable, false);
  assert.equal(report.packages[0].runtimeAvailable, false);
});

void test('rejects an active prop-and-children compatibility wrapper while allowing direct package use', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'src', 'WornButton.svelte'), [
    '<script>',
    "  import type { Snippet } from 'svelte';",
    "  import { Button } from '@wornpage/button';",
    '  let { children, ...rest }: { children: Snippet } = $props();',
    '</script>',
    '<Button {...rest}>{@render children?.()}</Button>',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'src', 'App.svelte'), [
    '<script>',
    "  import WornButton from './WornButton.svelte';",
    '</script>',
    '<WornButton>Wrapped</WornButton>',
    '',
  ].join('\n'), 'utf8');
  const report = await inspectWornpageConsumer({ root });
  assert.deepEqual(report.issues.map(({ code }) => code), ['active_compatibility_wrapper']);
  assert.equal(report.issues[0].file, 'src/WornButton.svelte');
});

void test('rejects nested Wornpage revisions in the authoritative and installed locks', async (t) => {
  const root = await fixture(t);
  for (const lockFile of ['package-lock.json', path.join('node_modules', '.package-lock.json')]) {
    const target = path.join(root, lockFile);
    const lock = await readJson(target);
    lock.packages['node_modules/example/node_modules/@wornpage/button'] = { resolved: ARCHIVE };
    await writeJson(target, lock);
  }
  const report = await inspectWornpageConsumer({ root });
  assert.deepEqual(report.issues.map(({ code }) => code), ['nested_wornpage_dependency', 'nested_wornpage_dependency']);
});

void test('CLI returns stable success, conformance-failure, and usage exit codes', async (t) => {
  const root = await fixture(t);
  const capture = () => {
    let value = '';
    return { stream: { write(chunk) { value += chunk; } }, read: () => value };
  };
  const successOut = capture();
  const successErr = capture();
  assert.equal(await runCli([root, '--json'], { stdout: successOut.stream, stderr: successErr.stream }), 0);
  assert.equal(JSON.parse(successOut.read()).ok, true);
  assert.equal(successErr.read(), '');

  await writeFile(path.join(root, 'src', 'App.svelte'), "<script>import Button from '@wornpage/button/src/Button.svelte';</script>\n", 'utf8');
  const failureOut = capture();
  const failureErr = capture();
  assert.equal(await runCli([root], { stdout: failureOut.stream, stderr: failureErr.stream }), 1);
  assert.match(failureErr.read(), /\[deep_import\]/u);
  assert.equal(failureOut.read(), '');

  const usageOut = capture();
  const usageErr = capture();
  assert.equal(await runCli(['--unknown'], { stdout: usageOut.stream, stderr: usageErr.stream }), 2);
  assert.match(usageErr.read(), /Unknown option/u);
});
