import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const WORNPAGE_PREFIX = '@wornpage/';
const ARCHIVE_PATTERN = /^https:\/\/codeload\.github\.com\/wornpage\/([a-z0-9][a-z0-9-]*)\/tar\.gz\/([0-9a-f]{40})$/u;
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.svelte', '.ts']);
const CONTRACT_VERSION = 2;

export class WornpageConsumerCheckError extends Error {
  constructor(report) {
    super(`Wornpage consumer check failed with ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}.`);
    this.name = 'WornpageConsumerCheckError';
    this.report = report;
    this.issues = report.issues;
  }
}

/**
 * Inspect one Svelte consumer without changing it.
 *
 * @param {{ root?: string, sourceDir?: string, requireInstalled?: boolean }} [options]
 */
export async function inspectWornpageConsumer(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const sourceRoot = path.resolve(root, options.sourceDir ?? 'src');
  const requireInstalled = options.requireInstalled !== false;
  const issues = [];
  const addIssue = (code, message, details = {}) => issues.push({ code, message, ...details });

  const manifest = await readRequiredJson(path.join(root, 'package.json'), 'package.json', addIssue);
  const lock = await readRequiredJson(path.join(root, 'package-lock.json'), 'package-lock.json', addIssue);
  const installedLockPath = path.join(root, 'node_modules', '.package-lock.json');
  const installedLock = requireInstalled
    ? await readRequiredJson(installedLockPath, 'node_modules/.package-lock.json', addIssue)
    : null;

  const importedByPackage = new Map();
  const sourceRecords = [];
  if (!existsSync(sourceRoot)) {
    addIssue('source_directory_missing', `Source directory does not exist: ${relativePath(root, sourceRoot)}.`, {
      file: relativePath(root, sourceRoot),
    });
  } else {
    for (const file of await sourceFiles(sourceRoot)) {
      const relativeFile = relativePath(root, file);
      const source = await readFile(file, 'utf8');
      sourceRecords.push({ file, relativeFile, source });
      for (const specifier of importSpecifiers(source)) {
        const packageName = packageRoot(specifier);
        if (specifier !== packageName) {
          addIssue('deep_import', `${relativeFile} deep-imports ${specifier}; import ${packageName} instead.`, {
            file: relativeFile,
            packageName,
            specifier,
          });
        }
        const locations = importedByPackage.get(packageName) ?? new Set();
        locations.add(relativeFile);
        importedByPackage.set(packageName, locations);
      }
    }
    for (const wrapper of activeCompatibilityWrappers(sourceRoot, sourceRecords)) {
      addIssue(
        'active_compatibility_wrapper',
        `${wrapper.file} actively forwards arbitrary props and children through ${wrapper.binding}; import the Wornpage package directly.`,
        { file: wrapper.file, packageName: wrapper.packageName },
      );
    }
  }

  const dependencies = Object.entries(manifest?.dependencies ?? {})
    .filter(([name]) => name.startsWith(WORNPAGE_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right));
  if (manifest && dependencies.length === 0) {
    addIssue('no_wornpage_dependencies', 'No @wornpage/* dependencies are declared in package.json#dependencies.');
  }

  const declaredNames = new Set(dependencies.map(([name]) => name));
  for (const packageName of [...importedByPackage.keys()].sort()) {
    if (!declaredNames.has(packageName)) {
      addIssue('undeclared_import', `${packageName} is imported but not declared in package.json#dependencies.`, { packageName });
    }
  }

  if (lock) rejectNestedDependencies(lock, 'package-lock.json', addIssue);
  if (installedLock) rejectNestedDependencies(installedLock, 'node_modules/.package-lock.json', addIssue);

  const packages = [];
  for (const [name, specifier] of dependencies) {
    const imports = [...(importedByPackage.get(name) ?? [])].sort();
    if (imports.length === 0) {
      addIssue('unused_dependency', `${name} is declared but unused by ${relativePath(root, sourceRoot)}/.`, { packageName: name });
    }

    const expected = archivePin(name, specifier, addIssue);
    const locked = inspectLockEntry(name, specifier, lock, expected, addIssue);
    const installedResolution = requireInstalled
      ? inspectInstalledResolution(name, installedLock, expected, addIssue)
      : null;
    const installed = requireInstalled
      ? await inspectInstalledPackage(root, name, addIssue)
      : emptyInstalledReport();

    packages.push({
      name,
      specifier,
      commit: expected?.commit ?? null,
      lockResolved: locked?.commit ?? null,
      installedResolved: installedResolution?.commit ?? null,
      contractVersion: installed.contractVersion,
      delivery: installed.delivery,
      source: installed.source,
      sourceAvailable: installed.sourceAvailable,
      runtime: installed.runtime,
      runtimeAvailable: installed.runtimeAvailable,
      imports,
    });
  }

  issues.sort(compareIssues);
  return {
    ok: issues.length === 0,
    root,
    sourceDirectory: relativePath(root, sourceRoot),
    lockfile: 'package-lock.json',
    packages,
    issues,
  };
}

/** @param {{ root?: string, sourceDir?: string, requireInstalled?: boolean }} [options] */
export async function assertWornpageConsumer(options = {}) {
  const report = await inspectWornpageConsumer(options);
  if (!report.ok) throw new WornpageConsumerCheckError(report);
  return report;
}

async function readRequiredJson(file, label, addIssue) {
  if (!existsSync(file)) {
    addIssue('required_file_missing', `${label} is missing.`, { file: label });
    return null;
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    addIssue('invalid_json', `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { file: label });
    return null;
  }
}

async function sourceFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  }
  await visit(root);
  return files;
}

function importSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bfrom\s*["'](@wornpage\/[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](@wornpage\/[^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["'](@wornpage\/[^"']+)["']\s*\)/gu,
    /\bimport\s*["'](@wornpage\/[^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

function packageRoot(specifier) {
  return specifier.split('/').slice(0, 2).join('/');
}

function archivePin(name, specifier, addIssue) {
  const repository = name.slice(WORNPAGE_PREFIX.length);
  const match = String(specifier).match(ARCHIVE_PATTERN);
  if (!match || match[1] !== repository) {
    addIssue('mutable_or_invalid_pin', `${name} must use an immutable codeload.github.com/wornpage/${repository} archive URL with a full lowercase commit.`, { packageName: name });
    return null;
  }
  return { repository, commit: match[2], specifier };
}

function inspectLockEntry(name, specifier, lock, expected, addIssue) {
  if (!lock) return null;
  const rootSpecifier = lock.packages?.['']?.dependencies?.[name];
  if (rootSpecifier !== specifier) {
    addIssue('lock_specifier_mismatch', `${name} disagrees between package.json and package-lock.json.`, { packageName: name });
  }
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry || typeof entry !== 'object') {
    addIssue('lock_entry_missing', `${name} has no node_modules entry in package-lock.json.`, { packageName: name });
    return null;
  }
  const resolved = archiveValue(entry.resolved);
  if (!resolved || (expected && resolved.repository !== expected.repository)) {
    addIssue('lock_resolution_invalid', `${name} has no exact matching Wornpage archive in package-lock.json.`, { packageName: name });
  } else if (expected && resolved.commit !== expected.commit) {
    addIssue('lock_commit_mismatch', `${name} package.json pins ${expected.commit}, but package-lock.json resolves ${resolved.commit}.`, { packageName: name });
  }
  if (!validSha512Integrity(entry.integrity)) {
    addIssue('lock_integrity_invalid', `${name} package-lock.json entry must contain a valid SHA-512 integrity digest.`, { packageName: name });
  }
  return resolved;
}

function inspectInstalledResolution(name, installedLock, expected, addIssue) {
  if (!installedLock) return null;
  const entry = installedLock.packages?.[`node_modules/${name}`];
  const resolved = archiveValue(entry?.resolved);
  if (!resolved || (expected && resolved.repository !== expected.repository)) {
    addIssue('installed_resolution_invalid', `${name} has no exact matching archive metadata in node_modules/.package-lock.json.`, { packageName: name });
    return resolved;
  }
  if (expected && resolved.commit !== expected.commit) {
    addIssue('installed_commit_mismatch', `${name} installed revision ${resolved.commit} does not match package.json revision ${expected.commit}.`, { packageName: name });
  }
  return resolved;
}

async function inspectInstalledPackage(root, name, addIssue) {
  const packageDirectory = path.join(root, 'node_modules', ...name.split('/'));
  const manifestPath = path.join(packageDirectory, 'package.json');
  if (!existsSync(manifestPath)) {
    addIssue('installed_package_missing', `${name} is not installed.`, { packageName: name });
    return emptyInstalledReport();
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    addIssue('installed_manifest_invalid', `${name} installed package.json is invalid: ${error instanceof Error ? error.message : String(error)}`, { packageName: name });
    return emptyInstalledReport();
  }
  if (manifest.name !== name) {
    addIssue('installed_name_mismatch', `${name} installed a manifest named ${String(manifest.name ?? '(missing)')}.`, { packageName: name });
  }

  const exported = rootExport(manifest.exports);
  const sourceEntry = exported?.svelte ?? manifest.svelte
    ?? [exported?.default, manifest.module, manifest.main].find((entry) => normalizeEntry(entry).startsWith('src/'));
  const runtimeEntry = exported?.default ?? manifest.module ?? manifest.main ?? sourceEntry;
  const source = normalizeEntry(sourceEntry);
  const runtime = normalizeEntry(runtimeEntry);
  const sourceAvailable = Boolean(source && existsSync(path.join(packageDirectory, ...source.split('/'))));
  const runtimeAvailable = Boolean(runtime && existsSync(path.join(packageDirectory, ...runtime.split('/'))));

  if (!source.startsWith('src/')) {
    addIssue('installed_source_invalid', `${name} must expose one canonical Svelte source entry under src/.`, { packageName: name });
  }
  if (!sourceAvailable) {
    addIssue('installed_source_missing', `${name} installed source entry is missing: ${source || '(undeclared)'}.`, { packageName: name });
  }
  if (!runtime.startsWith('src/') && !runtime.startsWith('dist/')) {
    addIssue('installed_runtime_invalid', `${name} runtime entry must be under src/ or dist/.`, { packageName: name });
  }
  if (!runtimeAvailable) {
    addIssue('installed_runtime_missing', `${name} installed runtime entry is missing: ${runtime || '(undeclared)'}.`, { packageName: name });
  }

  const delivery = runtime.startsWith('dist/') ? 'browser-bundle' : runtime.startsWith('src/') ? 'source' : null;
  const contractVersion = manifest.wornpage?.contractVersion ?? null;
  if (contractVersion !== CONTRACT_VERSION) {
    addIssue('contract_version_invalid', `${name} must declare wornpage.contractVersion as ${CONTRACT_VERSION}.`, { packageName: name });
  }
  if (!['source', 'browser-bundle'].includes(manifest.wornpage?.delivery)) {
    addIssue('delivery_declaration_invalid', `${name} must declare wornpage.delivery as source or browser-bundle.`, { packageName: name });
  } else if (delivery && manifest.wornpage.delivery !== delivery) {
    addIssue('delivery_declaration_mismatch', `${name} declares ${manifest.wornpage.delivery} delivery, but its runtime entry resolves to ${delivery}.`, { packageName: name });
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) {
    addIssue('package_files_missing', `${name} must declare package.json#files.`, { packageName: name });
  } else {
    if (source && !includedByFiles(files, source)) {
      addIssue('package_files_omit_source', `${name} package files omit ${source}.`, { packageName: name });
    }
    if (runtime && !includedByFiles(files, runtime)) {
      addIssue('package_files_omit_runtime', `${name} package files omit ${runtime}.`, { packageName: name });
    }
  }

  return { contractVersion, delivery, source, sourceAvailable, runtime, runtimeAvailable };
}

function rejectNestedDependencies(lock, label, addIssue) {
  const nested = Object.keys(lock.packages ?? {})
    .filter((entry) => /^node_modules\/.+\/node_modules\/@wornpage\/[^/]+$/u.test(entry))
    .sort();
  if (nested.length > 0) {
    addIssue('nested_wornpage_dependency', `${label} contains nested @wornpage dependencies: ${nested.join(', ')}.`, { file: label });
  }
}

function activeCompatibilityWrappers(sourceRoot, records) {
  const activeTargets = new Set();
  for (const record of records) {
    for (const specifier of localImportSpecifiers(record.source)) {
      const resolved = resolveLocalImport(sourceRoot, record.file, specifier);
      if (resolved) activeTargets.add(resolved);
    }
  }

  const wrappers = [];
  for (const record of records) {
    if (path.extname(record.file) !== '.svelte' || !activeTargets.has(path.normalize(record.file))) continue;
    const bindings = wornpageComponentBindings(record.source);
    if (bindings.length === 0) continue;
    const tags = [...record.source.matchAll(/<([A-Z][A-Za-z0-9_$]*)\b/gu)].map((match) => match[1]);
    const rendered = [...new Set(tags.filter((tag) => bindings.some(({ binding }) => binding === tag)))];
    if (rendered.length !== 1) continue;
    const forwardsProps = /\{\.\.\.(?:\$\$restProps|[A-Za-z_$][\w$]*)\}/u.test(record.source);
    const forwardsChildren = /<slot\b|\{@render\s+[A-Za-z_$][\w$]*\??\./u.test(record.source);
    if (!forwardsProps || !forwardsChildren) continue;
    const owner = bindings.find(({ binding }) => binding === rendered[0]);
    wrappers.push({ file: record.relativeFile, binding: rendered[0], packageName: owner.packageName });
  }
  return wrappers.sort((left, right) => left.file.localeCompare(right.file));
}

function wornpageComponentBindings(source) {
  const bindings = [];
  const named = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s*["'](@wornpage\/[^"']+)["']/gu;
  for (const match of source.matchAll(named)) {
    for (const entry of match[1].split(',')) {
      const cleaned = entry.trim().replace(/^type\s+/u, '');
      if (!cleaned) continue;
      const parts = cleaned.split(/\s+as\s+/u);
      bindings.push({ binding: parts.at(-1).trim(), packageName: packageRoot(match[2]) });
    }
  }
  const defaultImport = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["'](@wornpage\/[^"']+)["']/gu;
  for (const match of source.matchAll(defaultImport)) {
    bindings.push({ binding: match[1], packageName: packageRoot(match[2]) });
  }
  return bindings;
}

function localImportSpecifiers(source) {
  const found = new Set();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.') || match[1].startsWith('$lib/')) found.add(match[1]);
    }
  }
  return found;
}

function resolveLocalImport(sourceRoot, importer, specifier) {
  const base = specifier.startsWith('$lib/')
    ? path.join(sourceRoot, 'lib', specifier.slice('$lib/'.length))
    : path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.svelte`, `${base}.ts`, `${base}.js`, path.join(base, 'index.svelte')]) {
    if (existsSync(candidate)) return path.normalize(candidate);
  }
  return null;
}

function archiveValue(value) {
  const match = String(value ?? '').match(ARCHIVE_PATTERN);
  return match ? { repository: match[1], commit: match[2] } : null;
}

function validSha512Integrity(value) {
  const match = String(value ?? '').match(/^sha512-([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) return false;
  try {
    return Buffer.from(match[1], 'base64').byteLength === 64;
  } catch {
    return false;
  }
}

function rootExport(exportsField) {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return null;
  const root = exportsField['.'];
  return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
}

function normalizeEntry(value) {
  return String(value ?? '').replace(/^\.\//u, '').replaceAll('\\', '/');
}

function includedByFiles(files, entry) {
  const normalized = normalizeEntry(entry);
  return files.some((candidate) => {
    const allowed = normalizeEntry(candidate).replace(/\/$/u, '');
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

function emptyInstalledReport() {
  return {
    contractVersion: null,
    delivery: null,
    source: null,
    sourceAvailable: false,
    runtime: null,
    runtimeAvailable: false,
  };
}

function relativePath(root, target) {
  const relative = path.relative(root, target).replaceAll('\\', '/');
  return relative || '.';
}

function compareIssues(left, right) {
  return [left.code, left.packageName ?? '', left.file ?? '', left.specifier ?? '', left.message]
    .join('\0')
    .localeCompare([right.code, right.packageName ?? '', right.file ?? '', right.specifier ?? '', right.message].join('\0'));
}
