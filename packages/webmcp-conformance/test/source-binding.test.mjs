import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { assertExactGitSourceCheckout } from '../src/index.mjs';

const execFileAsync = promisify(execFile);

test('exact source binding rejects revision drift and every dirty checkout state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webmcp-source-binding-'));
  const tracked = path.join(root, 'contract.mjs');
  try {
    await git(root, ['init', '-b', 'main']);
    await writeFile(tracked, 'export const contract = true;\n', 'utf8');
    await git(root, ['add', 'contract.mjs']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
    const revision = (await git(root, ['rev-parse', 'HEAD'])).trim();
    assert.deepEqual(await assertExactGitSourceCheckout({ root, revision, label: 'Fixture source' }), { root, revision, clean: true });

    await assert.rejects(
      () => assertExactGitSourceCheckout({ root, revision: '0123456789abcdef0123456789abcdef01234567', label: 'Fixture source' }),
      /does not match manifest revision/u,
    );

    await writeFile(tracked, 'export const contract = false;\n', 'utf8');
    await assert.rejects(() => assertExactGitSourceCheckout({ root, revision, label: 'Fixture source' }), /is dirty.*contract\.mjs/u);
    await git(root, ['add', 'contract.mjs']);
    await assert.rejects(() => assertExactGitSourceCheckout({ root, revision, label: 'Fixture source' }), /is dirty.*contract\.mjs/u);
    await writeFile(tracked, 'export const contract = true;\n', 'utf8');
    await git(root, ['add', 'contract.mjs']);
    await writeFile(path.join(root, 'untracked.mjs'), 'export {};\n', 'utf8');
    await assert.rejects(() => assertExactGitSourceCheckout({ root, revision, label: 'Fixture source' }), /is dirty.*untracked\.mjs/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
  return stdout;
}
