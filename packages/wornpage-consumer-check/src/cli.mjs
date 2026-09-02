import path from 'node:path';

import { inspectWornpageConsumer } from './index.mjs';

export const USAGE = `Usage: wornpage-consumer-check [consumer-root] [options]

Options:
  --root <path>        Consumer root (alternative to the positional path)
  --source-dir <path> Source directory relative to the consumer root (default: src)
  --json               Print the complete machine-readable report
  --verbose            Print the verified package inventory
  --help               Show this help`;

export async function runCli(args, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const report = await inspectWornpageConsumer({
    root: path.resolve(cwd, parsed.root ?? '.'),
    sourceDir: parsed.sourceDir,
  });
  if (parsed.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!report.ok) {
    stderr.write(`Wornpage consumer check failed with ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}:\n`);
    for (const issue of report.issues) stderr.write(`- [${issue.code}] ${issue.message}\n`);
  } else {
    stdout.write(`Verified ${report.packages.length} immutable @wornpage package${report.packages.length === 1 ? '' : 's'} from ${report.lockfile}.\n`);
    if (parsed.verbose) {
      for (const pkg of report.packages) {
        stdout.write(`  ${pkg.name} #${pkg.commit.slice(0, 7)} v${pkg.contractVersion} ${pkg.delivery}: ${pkg.source} -> ${pkg.runtime}\n`);
      }
    }
  }
  return report.ok ? 0 : 1;
}

function parseArgs(args) {
  const result = { root: null, sourceDir: 'src', json: false, verbose: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') result.json = true;
    else if (argument === '--verbose') result.verbose = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--root' || argument === '--source-dir') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new TypeError(`${argument} requires a path.`);
      index += 1;
      if (argument === '--root') {
        if (result.root !== null) throw new TypeError('Consumer root may be provided only once.');
        result.root = value;
      } else result.sourceDir = value;
    } else if (argument.startsWith('-')) throw new TypeError(`Unknown option: ${argument}`);
    else {
      if (result.root !== null) throw new TypeError('Consumer root may be provided only once.');
      result.root = argument;
    }
  }
  if (result.json && result.verbose) throw new TypeError('--json and --verbose are mutually exclusive.');
  return result;
}
