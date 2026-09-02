import { isDeepStrictEqual } from 'node:util';
import { assertValidCatalogManifest } from './manifest.mjs';
import { snapshotToolDescriptor } from './descriptor.mjs';

/**
 * Verify runtime descriptors against a frozen manifest and execute deterministic
 * success/error cases. Product-specific state/effect assertions remain in each
 * adapter case through its optional assert callback.
 *
 * @param {unknown} manifest
 * @param {{ tools: Record<string, { tool: unknown, cases: Array<{ name: string, input: unknown, expect: 'success' | 'error', assert?: (result: unknown) => unknown }> }> }} adapter
 */
export async function runExecutableCatalogFixture(manifest, adapter) {
  assertValidCatalogManifest(manifest);
  if (!adapter || typeof adapter !== 'object' || !adapter.tools || typeof adapter.tools !== 'object') {
    throw new TypeError('Executable fixture requires a tools adapter.');
  }
  const results = [];
  for (const page of manifest.pages) {
    for (const entry of page.tools) {
      const name = entry.descriptor.name;
      const runtime = adapter.tools[name];
      if (!runtime || typeof runtime !== 'object' || !runtime.tool || typeof runtime.tool.execute !== 'function' || !Array.isArray(runtime.cases) || runtime.cases.length === 0) {
        throw new TypeError(`Executable fixture is missing runtime cases for ${name}.`);
      }
      const actualDescriptor = snapshotToolDescriptor(runtime.tool);
      if (!isDeepStrictEqual(actualDescriptor, entry.descriptor)) throw new TypeError(`Runtime descriptor drifted from manifest for ${name}.`);

      for (const testCase of runtime.cases) {
        if (!testCase || typeof testCase.name !== 'string' || !['success', 'error'].includes(testCase.expect)) {
          throw new TypeError(`Executable fixture case is invalid for ${name}.`);
        }
        try {
          const result = await runtime.tool.execute(structuredClone(testCase.input));
          if (testCase.expect === 'error') throw new FixtureExpectationError(`${name}/${testCase.name} unexpectedly succeeded.`);
          assertReceiptAllowlist(result, entry.receiptAllowlist, name);
          await testCase.assert?.(result);
          results.push({ tool: name, case: testCase.name, outcome: 'success' });
        } catch (error) {
          if (error instanceof FixtureExpectationError) throw error;
          if (testCase.expect !== 'error') throw error;
          results.push({ tool: name, case: testCase.name, outcome: 'error' });
        }
      }
    }
  }
  return { catalog: manifest.id, cases: results.length, results };
}

/** @param {unknown} result @param {{ resultFields: string[], focusFields: string[], allowNull: boolean }} allowlist @param {string} [label] */
export function assertReceiptAllowlist(result, allowlist, label = 'tool') {
  if (result === null && allowlist.allowNull) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError(`${label} result must be an object covered by its receipt allowlist.`);
  assertExactKeys(result, allowlist.resultFields, `${label} result`);
  if (allowlist.focusFields.length > 0) {
    if (!result.focus || typeof result.focus !== 'object' || Array.isArray(result.focus)) throw new TypeError(`${label} focus receipt is missing.`);
    assertExactKeys(result.focus, allowlist.focusFields, `${label} focus receipt`);
  }
  return result;
}

/**
 * Exercise the lifecycle obligations shared by page-owned registration
 * helpers without depending on a browser framework.
 *
 * @param {(documentRef: unknown, tools: unknown[], options?: { onError?: (error: unknown, name: string) => void }) => () => void} register
 * @param {{ unsupportedNoop: boolean, sharedAbortSignal: boolean, abortAllOnFailure: boolean, cleanupIdempotent: boolean, staleCleanupIsolation: boolean }} obligations
 */
export async function runRegistrationLifecycleFixture(register, obligations) {
  if (typeof register !== 'function') throw new TypeError('Lifecycle fixture requires a registration function.');
  const tools = ['fixture_alpha', 'fixture_beta'].map((name) => ({
    name,
    title: name,
    description: `${name} lifecycle fixture`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute() { return {}; },
  }));
  const passed = [];

  if (obligations.unsupportedNoop) {
    const cleanup = register({}, tools);
    if (typeof cleanup !== 'function') throw new TypeError('Unsupported registration did not return cleanup.');
    cleanup();
    passed.push('unsupportedNoop');
  }

  if (obligations.sharedAbortSignal || obligations.cleanupIdempotent) {
    const signals = [];
    const cleanup = register({ modelContext: { registerTool(_tool, options) { signals.push(options?.signal); } } }, tools);
    if (obligations.sharedAbortSignal && (signals.length !== tools.length || new Set(signals).size !== 1 || !(signals[0] instanceof AbortSignal))) {
      throw new TypeError('Page catalog did not share one registration signal.');
    }
    cleanup();
    if (signals.some((signal) => !signal.aborted)) throw new TypeError('Catalog cleanup did not abort every registration.');
    if (obligations.cleanupIdempotent) {
      cleanup();
      passed.push('cleanupIdempotent');
    }
    if (obligations.sharedAbortSignal) passed.push('sharedAbortSignal');
  }

  if (obligations.abortAllOnFailure) {
    await assertRegistrationFailureAborts(register, tools, 'sync');
    await assertRegistrationFailureAborts(register, tools, 'async');
    passed.push('abortAllOnFailure');
  }

  if (obligations.staleCleanupIsolation) {
    const firstSignals = [];
    const secondSignals = [];
    const firstCleanup = register({ modelContext: { registerTool(_tool, options) { firstSignals.push(options?.signal); } } }, tools);
    const secondCleanup = register({ modelContext: { registerTool(_tool, options) { secondSignals.push(options?.signal); } } }, tools);
    firstCleanup();
    if (firstSignals.some((signal) => !signal.aborted) || secondSignals.some((signal) => signal.aborted)) {
      throw new TypeError('Stale cleanup affected the active catalog.');
    }
    secondCleanup();
    passed.push('staleCleanupIsolation');
  }

  return { checks: passed.length, passed };
}

async function assertRegistrationFailureAborts(register, tools, mode) {
  const signals = [];
  const errors = [];
  const failure = new Error(`${mode} fixture failure`);
  const documentRef = {
    modelContext: {
      registerTool(tool, options) {
        signals.push(options?.signal);
        if (tool.name === tools[1].name) {
          if (mode === 'sync') throw failure;
          return Promise.reject(failure);
        }
      },
    },
  };
  const cleanup = register(documentRef, tools, { onError(error, name) { errors.push({ error, name }); } });
  await new Promise((resolve) => setImmediate(resolve));
  if (signals.length !== tools.length || signals.some((signal) => !signal.aborted) || errors.length !== 1 || errors[0].name !== tools[1].name) {
    throw new TypeError(`${mode} registration failure did not abort the full page catalog exactly once.`);
  }
  cleanup();
}

function assertExactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (!isDeepStrictEqual(actual, expected)) throw new TypeError(`${label} fields must be exactly [${expected.join(', ')}], received [${actual.join(', ')}].`);
}

class FixtureExpectationError extends Error {}
