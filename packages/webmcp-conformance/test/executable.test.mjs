import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReceiptAllowlist,
  runExecutableCatalogFixture,
  runRegistrationLifecycleFixture,
} from '../src/index.mjs';

const descriptor = {
  name: 'show_fixture',
  title: 'Show fixture',
  description: 'Show a bounded fixture view.',
  inputSchema: {
    type: 'object',
    properties: { view: { type: 'string', enum: ['one'] } },
    required: ['view'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const manifest = {
  version: 1,
  id: 'fixture-app',
  title: 'Fixture app',
  source: { kind: 'local-git', revision: '0123456789abcdef0123456789abcdef01234567', paths: ['fixture.mjs'] },
  lifecycle: { unsupportedNoop: true, sharedAbortSignal: true, abortAllOnFailure: true, cleanupIdempotent: true, staleCleanupIsolation: true },
  pages: [{
    path: '/',
    tools: [{
      descriptor,
      declaredEffect: 'presentation',
      expectedAuthority: 'closed-world-change',
      allowedEffects: { domain: [], ui: ['view', 'focus'], durable: [], network: [], humanActivations: [] },
      evidence: { focusFields: ['focused'], denominatorFields: [], humanGate: false },
      receiptAllowlist: { resultFields: ['view', 'focus'], focusFields: ['focused'], allowNull: false },
    }],
  }],
};

test('executable fixture compares exact descriptors and enforces receipts', async () => {
  const tool = { ...descriptor, async execute() { return { view: 'one', focus: { focused: true } }; } };
  const report = await runExecutableCatalogFixture(manifest, {
    tools: { show_fixture: { tool, cases: [{ name: 'one', input: { view: 'one' }, expect: 'success' }] } },
  });
  assert.equal(report.cases, 1);
  await assert.rejects(() => runExecutableCatalogFixture(manifest, {
    tools: { show_fixture: { tool: { ...tool, title: 'Drifted' }, cases: [{ name: 'one', input: { view: 'one' }, expect: 'success' }] } },
  }), /descriptor drifted/u);
});

test('receipt allowlists reject undeclared top-level and focus fields', () => {
  const allowlist = { resultFields: ['view', 'focus'], focusFields: ['focused'], allowNull: false };
  assert.throws(() => assertReceiptAllowlist({ view: 'one', secret: 'no', focus: { focused: true } }, allowlist), /fields must be exactly/u);
  assert.throws(() => assertReceiptAllowlist({ view: 'one', focus: { focused: true, secret: 'no' } }, allowlist), /focus receipt fields/u);
});

test('lifecycle runner exercises unsupported, shared abort, fail-all, idempotent, and stale cleanup obligations', async () => {
  const register = (documentRef, tools, { onError = () => {} } = {}) => {
    const modelContext = documentRef?.modelContext;
    if (typeof modelContext?.registerTool !== 'function') return () => {};
    const controller = new AbortController();
    const fail = (error, name) => {
      if (controller.signal.aborted) return;
      controller.abort();
      onError(error, name);
    };
    for (const tool of tools) {
      try { void Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch((error) => fail(error, tool.name)); }
      catch (error) { fail(error, tool.name); break; }
    }
    return () => controller.abort();
  };
  const report = await runRegistrationLifecycleFixture(register, manifest.lifecycle);
  assert.deepEqual(report.passed, ['unsupportedNoop', 'cleanupIdempotent', 'sharedAbortSignal', 'abortAllOnFailure', 'staleCleanupIsolation']);
});
