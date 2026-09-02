import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createWebMcpDiscoveryHost } from '../src/index.mjs';

const ORIGIN = 'https://fixtures.example';

test('Afterlist and Projects descriptors yield 6 read-only hints and 5 change-unknown entries without domain rules', async () => {
  const manifests = await Promise.all([
    readFixture('afterlist.json'),
    readFixture('projects-extension.json'),
  ]);
  const privateWindows = [];
  const tools = manifests.flatMap((manifest) => manifest.pages.flatMap((page) => page.tools.map(({ descriptor }) => {
    const privateWindow = { catalog: manifest.id, secret: `${descriptor.name}-PRIVATE_WINDOW` };
    privateWindows.push(privateWindow);
    return {
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      origin: ORIGIN,
      window: privateWindow,
      annotations: {
        readOnlyHint: descriptor.annotations?.readOnlyHint,
        untrustedContentHint: descriptor.annotations?.untrustedContentHint,
      },
    };
  })));
  const modelContext = new FixtureModelContext(tools);
  const host = createWebMcpDiscoveryHost({ documentRef: { location: { origin: ORIGIN }, modelContext }, authorize: async () => true });
  const catalog = await host.refresh();
  assert.equal(catalog.tools.length, 11);
  assert.equal(catalog.tools.filter(({ classification }) => classification === 'read-only-hint').length, 6);
  assert.equal(catalog.tools.filter(({ classification }) => classification === 'change-unknown').length, 5);
  assert.equal(catalog.tools.every(({ status }) => status === 'ready'), true);
  assert.equal(catalog.tools.every(({ authorizationRequired }) => authorizationRequired === true), true);
  const serialized = JSON.stringify(catalog);
  for (const privateWindow of privateWindows) assert.doesNotMatch(serialized, new RegExp(privateWindow.secret, 'u'));
});

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8'));
}

class FixtureModelContext {
  constructor(tools) {
    this.tools = tools;
    this.listeners = new Set();
  }
  addEventListener(_name, listener) { this.listeners.add(listener); }
  removeEventListener(_name, listener) { this.listeners.delete(listener); }
  async getTools() { return this.tools; }
  async executeTool() { return 'unused'; }
}
