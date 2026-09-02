import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REVISION = /^[0-9a-f]{40}$/u;

/**
 * Bind executable source fixtures to one clean Git checkout at an exact commit.
 * Any tracked, staged, or untracked change invalidates the immutable claim.
 *
 * @param {{ root: string, revision: string, label?: string }} source
 */
export async function assertExactGitSourceCheckout({ root, revision, label = 'Source checkout' }) {
  if (typeof root !== 'string' || !root || typeof revision !== 'string' || !REVISION.test(revision)) {
    throw new TypeError('Exact Git source binding requires a root and full lowercase commit.');
  }
  const checkout = path.resolve(root);
  const head = (await runGit(checkout, ['rev-parse', 'HEAD'], label)).trim();
  if (head !== revision) throw new Error(`${label} HEAD ${head} does not match manifest revision ${revision}.`);
  const status = (await runGit(checkout, ['status', '--porcelain=v1', '--untracked-files=all'], label)).trim();
  if (status) throw new Error(`${label} is dirty and cannot represent immutable revision ${revision}: ${status.split(/\r?\n/u).join('; ')}`);
  return Object.freeze({ root: checkout, revision, clean: true });
}

async function runGit(root, args, label) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    throw new Error(`${label} Git inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
