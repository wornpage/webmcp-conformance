import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PACKAGE_NAME = '@wornpage/button';
export const COMMIT = '867ea5449916d1dfd9e59d231282ff54cc060085';
export const ARCHIVE = `https://codeload.github.com/wornpage/button/tar.gz/${COMMIT}`;
export const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

export async function createValidConsumer(root) {
  const installedRoot = path.join(root, 'node_modules', '@wornpage', 'button');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(installedRoot, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeJson(path.join(root, 'package.json'), {
    name: 'fixture-consumer',
    private: true,
    type: 'module',
    dependencies: { [PACKAGE_NAME]: ARCHIVE },
  });
  const packages = {
    '': { dependencies: { [PACKAGE_NAME]: ARCHIVE } },
    [`node_modules/${PACKAGE_NAME}`]: { resolved: ARCHIVE, integrity: INTEGRITY },
  };
  await writeJson(path.join(root, 'package-lock.json'), { name: 'fixture-consumer', lockfileVersion: 3, packages });
  await writeJson(path.join(root, 'node_modules', '.package-lock.json'), { lockfileVersion: 3, packages });
  await writeJson(path.join(installedRoot, 'package.json'), {
    name: PACKAGE_NAME,
    version: '0.0.0',
    svelte: './src/index.js',
    exports: { '.': { svelte: './src/index.js', default: './src/index.js' } },
    files: ['src'],
    wornpage: { contractVersion: 2, delivery: 'source' },
  });
  await writeFile(path.join(installedRoot, 'src', 'index.js'), "export { default as Button } from './Button.svelte';\n", 'utf8');
  await writeFile(path.join(installedRoot, 'src', 'Button.svelte'), '<button><slot /></button>\n', 'utf8');
  await writeFile(path.join(root, 'src', 'App.svelte'), "<script>\n  import { Button } from '@wornpage/button';\n</script>\n<Button>Ready</Button>\n", 'utf8');
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
