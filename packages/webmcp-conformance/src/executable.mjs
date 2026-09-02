import { isDeepStrictEqual } from 'node:util';
import { assertValidCatalogManifest } from './manifest.mjs';
import { snapshotToolDescriptor } from './descriptor.mjs';

/**
 * Verify runtime descriptors against a frozen manifest and execute deterministic
 * success/error cases. Evidence obligations are enforced for every successful
 * result; product-specific state/effect assertions remain adapter-owned.
 *
 * @param {unknown} manifest
 * @param {{ tools: Record<string, { tool: unknown, cases: Array<{ name: string, input: unknown, expect: 'success' | 'error', expectedError?: { name: string, message: string }, assert?: (result: unknown) => unknown, assertAfterError?: (error: Error) => unknown }> }> }} adapter
 */
export async function runExecutableCatalogFixture(manifest, adapter) {
  assertValidCatalogManifest(manifest);
  if (!adapter || typeof adapter !== 'object' || !adapter.tools || typeof adapter.tools !== 'object') {
    throw new TypeError('Executable fixture requires a tools adapter.');
  }
  const plans = [];
  for (const page of manifest.pages) {
    for (const entry of page.tools) {
      const name = entry.descriptor.name;
      const runtime = adapter.tools[name];
      if (!runtime || typeof runtime !== 'object' || !runtime.tool || typeof runtime.tool.execute !== 'function' || !Array.isArray(runtime.cases)) {
        throw new TypeError(`Executable fixture is missing runtime cases for ${name}.`);
      }
      validateRuntimeCases(runtime.cases, name);
      const actualDescriptor = snapshotToolDescriptor(runtime.tool);
      if (!isDeepStrictEqual(actualDescriptor, entry.descriptor)) throw new TypeError(`Runtime descriptor drifted from manifest for ${name}.`);
      plans.push({ entry, name, runtime });
    }
  }

  const results = [];
  for (const expectedOutcome of ['error', 'success']) {
    for (const { entry, name, runtime } of plans) {
      for (const testCase of runtime.cases.filter(({ expect }) => expect === expectedOutcome)) {
        const input = structuredClone(testCase.input);
        if (testCase.expect === 'success') {
          const result = await runtime.tool.execute(input);
          assertReceiptAllowlist(result, entry.receiptAllowlist, name);
          assertEvidenceObligations(result, entry.evidence, name);
          await testCase.assert?.(result);
          results.push({ tool: name, case: testCase.name, outcome: 'success' });
          continue;
        }

        let didThrow = false;
        let thrown;
        try {
          await runtime.tool.execute(input);
        } catch (error) {
          didThrow = true;
          thrown = error;
        }
        if (!didThrow) throw new FixtureExpectationError(`${name}/${testCase.name} unexpectedly succeeded.`);
        assertExpectedError(thrown, testCase.expectedError, `${name}/${testCase.name}`);
        await testCase.assertAfterError(thrown);
        results.push({ tool: name, case: testCase.name, outcome: 'error' });
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

/** @param {unknown} result @param {{ focusTruePaths: string[], denominatorPaths: string[], humanGateTruePaths: string[] }} evidence @param {string} [label] */
export function assertEvidenceObligations(result, evidence, label = 'tool') {
  for (const resultPath of evidence.focusTruePaths) {
    if (readResultPath(result, resultPath, label) !== true) throw new TypeError(`${label} focus proof ${resultPath} must be true.`);
  }
  for (const resultPath of evidence.denominatorPaths) {
    const value = readResultPath(result, resultPath, label);
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} denominator ${resultPath} must be a non-negative safe integer.`);
  }
  for (const resultPath of evidence.humanGateTruePaths) {
    if (readResultPath(result, resultPath, label) !== true) throw new TypeError(`${label} human gate ${resultPath} must be true.`);
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
  const tools = ['fixture_alpha', 'fixture_beta', 'fixture_gamma'].map((name) => ({
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
  const attempted = [];
  const failure = new Error(`${mode} fixture failure`);
  const documentRef = {
    modelContext: {
      registerTool(tool, options) {
        attempted.push(tool.name);
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
  const expectedAttempts = mode === 'sync' ? tools.slice(0, 2).map(({ name }) => name) : tools.map(({ name }) => name);
  if (!isDeepStrictEqual(attempted, expectedAttempts) || signals.some((signal) => !signal.aborted) || errors.length !== 1 || errors[0].name !== tools[1].name) {
    throw new TypeError(`${mode} registration failure did not abort the full page catalog exactly once.`);
  }
  cleanup();
}

function validateRuntimeCases(cases, name) {
  const names = [];
  let successes = 0;
  let errors = 0;
  for (const testCase of cases) {
    if (!testCase || typeof testCase.name !== 'string' || !testCase.name || !['success', 'error'].includes(testCase.expect)) {
      throw new TypeError(`Executable fixture case is invalid for ${name}.`);
    }
    names.push(testCase.name);
    if (testCase.expect === 'success') {
      successes += 1;
      if (testCase.expectedError !== undefined || testCase.assertAfterError !== undefined) {
        throw new TypeError(`Successful fixture case ${name}/${testCase.name} cannot declare expected-error handling.`);
      }
    } else {
      errors += 1;
      validateExpectedError(testCase.expectedError, `${name}/${testCase.name}`);
      if (typeof testCase.assertAfterError !== 'function') throw new TypeError(`Expected-error case ${name}/${testCase.name} requires an effect postcondition.`);
    }
  }
  if (new Set(names).size !== names.length) throw new TypeError(`Executable fixture case names must be unique for ${name}.`);
  if (successes === 0 || errors === 0) throw new TypeError(`Executable fixture requires at least one success and one expected-error case for ${name}.`);
}

function validateExpectedError(specification, label) {
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
    throw new TypeError(`Expected-error case ${label} requires an explicit matcher.`);
  }
  if (
    Object.keys(specification).length !== 2 ||
    typeof specification.name !== 'string' || !specification.name ||
    typeof specification.message !== 'string' || !specification.message
  ) {
    throw new TypeError(`Expected-error case ${label} must declare exact non-empty name and message strings.`);
  }
}

function assertExpectedError(error, specification, label) {
  if (!(error instanceof Error) || error.name !== specification.name || error.message !== specification.message) {
    const actualName = error instanceof Error ? error.name : typeof error;
    const actualMessage = error instanceof Error ? error.message : String(error);
    throw new FixtureExpectationError(
      `${label} threw ${actualName} ${JSON.stringify(actualMessage)}, expected ${specification.name} ${JSON.stringify(specification.message)}.`,
    );
  }
}

function readResultPath(result, resultPath, label) {
  let current = result;
  for (const segment of resultPath.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) {
      throw new TypeError(`${label} evidence path ${resultPath} is missing.`);
    }
    current = current[segment];
  }
  return current;
}

function assertExactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (!isDeepStrictEqual(actual, expected)) throw new TypeError(`${label} fields must be exactly [${expected.join(', ')}], received [${actual.join(', ')}].`);
}

class FixtureExpectationError extends Error {}
