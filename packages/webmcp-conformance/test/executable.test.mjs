import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEvidenceObligations,
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

const evidence = {
  focusTruePaths: ['focus.focused', 'focus.focusVisible', 'focus.inViewport', 'focus.pulsed'],
  denominatorPaths: ['counts.total'],
  humanGateTruePaths: [],
};

const manifest = {
  version: 2,
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
      evidence,
      receiptAllowlist: {
        resultFields: ['view', 'focus', 'counts'],
        focusFields: ['focused', 'focusVisible', 'inViewport', 'pulsed'],
        allowNull: false,
      },
    }],
  }],
};

test('executable fixture preflights exact descriptors and enforces two-sided cases', async () => {
  const tool = fixtureTool();
  const cases = fixtureCases();
  const report = await runExecutableCatalogFixture(manifest, { tools: { show_fixture: { tool, cases } } });
  assert.equal(report.cases, 2);
  await assert.rejects(() => runExecutableCatalogFixture(manifest, {
    tools: { show_fixture: { tool: { ...tool, title: 'Drifted' }, cases } },
  }), /descriptor drifted/u);
});

test('executable fixture rejects one-sided, duplicate, and mismatched error coverage', async () => {
  const tool = fixtureTool();
  await assert.rejects(() => executeWithCases(tool, [fixtureCases()[0]]), /at least one success and one expected-error/u);
  await assert.rejects(() => executeWithCases(tool, [fixtureCases()[1]]), /at least one success and one expected-error/u);
  await assert.rejects(() => executeWithCases(tool, [fixtureCases()[0], { ...fixtureCases()[1], name: 'valid' }]), /case names must be unique/u);
  const missingPostcondition = fixtureCases();
  delete missingPostcondition[1].assertAfterError;
  await assert.rejects(() => executeWithCases(tool, missingPostcondition), /requires an effect postcondition/u);
  await assert.rejects(() => executeWithCases(tool, [
    fixtureCases()[0],
    { ...fixtureCases()[1], expectedError: { name: 'TypeError', message: 'Wrong message.' } },
  ]), /threw TypeError.*expected TypeError/u);
});

test('expected-error postconditions reject matching errors that already changed state', async () => {
  let writes = 0;
  const tool = fixtureTool();
  tool.execute = async (input) => {
    if (input.view !== 'one') {
      writes += 1;
      throw new TypeError('Fixture view must be one.');
    }
    return fixtureResult();
  };
  const cases = fixtureCases();
  cases[1].assertAfterError = () => assert.equal(writes, 0, 'invalid input wrote before rejection');
  await assert.rejects(() => executeWithCases(tool, cases), /invalid input wrote before rejection/u);
});

test('global preflight rejects a later incomplete adapter before an earlier tool executes', async () => {
  let executions = 0;
  const firstTool = fixtureTool(() => { executions += 1; });
  const secondDescriptor = { ...descriptor, name: 'second_fixture', title: 'Second fixture' };
  const twoToolManifest = structuredClone(manifest);
  twoToolManifest.pages[0].tools.push({ ...structuredClone(manifest.pages[0].tools[0]), descriptor: secondDescriptor });
  await assert.rejects(() => runExecutableCatalogFixture(twoToolManifest, {
    tools: {
      show_fixture: { tool: firstTool, cases: fixtureCases() },
      second_fixture: { tool: { ...secondDescriptor, execute: fixtureTool().execute }, cases: [fixtureCases()[0]] },
    },
  }), /at least one success and one expected-error/u);
  assert.equal(executions, 0);
});

test('evidence obligations reject false or missing focus and gate proofs plus invalid denominators', () => {
  const valid = fixtureResult();
  assert.equal(assertEvidenceObligations(valid, evidence), valid);
  for (const denominator of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertEvidenceObligations({ ...valid, counts: { total: denominator } }, evidence), /denominator counts\.total/u);
  }
  assert.throws(() => assertEvidenceObligations({ ...valid, focus: { ...valid.focus, focused: false } }, evidence), /focus proof focus\.focused/u);
  assert.throws(() => assertEvidenceObligations({ ...valid, focus: Object.create({ focused: true }) }, { ...evidence, focusTruePaths: ['focus.focused'] }), /evidence path focus\.focused is missing/u);
  assert.throws(() => assertEvidenceObligations({ ...valid, counts: {} }, evidence), /evidence path counts\.total is missing/u);
  assert.throws(() => assertEvidenceObligations({ gate: false }, { focusTruePaths: [], denominatorPaths: [], humanGateTruePaths: ['gate'] }), /human gate gate must be true/u);
});

test('receipt allowlists reject undeclared top-level and focus fields', () => {
  const allowlist = manifest.pages[0].tools[0].receiptAllowlist;
  assert.throws(() => assertReceiptAllowlist({ ...fixtureResult(), secret: 'no' }, allowlist), /fields must be exactly/u);
  assert.throws(() => assertReceiptAllowlist({ ...fixtureResult(), focus: { ...fixtureResult().focus, secret: 'no' } }, allowlist), /focus receipt fields/u);
});

test('lifecycle runner proves sync failure stops the later descriptor', async () => {
  const register = registrationFixture({ continueAfterSyncFailure: false });
  const report = await runRegistrationLifecycleFixture(register, manifest.lifecycle);
  assert.deepEqual(report.passed, ['unsupportedNoop', 'cleanupIdempotent', 'sharedAbortSignal', 'abortAllOnFailure', 'staleCleanupIsolation']);
  await assert.rejects(
    () => runRegistrationLifecycleFixture(registrationFixture({ continueAfterSyncFailure: true }), manifest.lifecycle),
    /sync registration failure did not abort/u,
  );
});

function fixtureTool(onExecute = () => {}) {
  return {
    ...descriptor,
    async execute(input) {
      onExecute();
      if (!input || input.view !== 'one' || Object.keys(input).length !== 1) throw new TypeError('Fixture view must be one.');
      return fixtureResult();
    },
  };
}

function fixtureResult() {
  return {
    view: 'one',
    focus: { focused: true, focusVisible: true, inViewport: true, pulsed: true },
    counts: { total: 1 },
  };
}

function fixtureCases() {
  return [
    { name: 'valid', input: { view: 'one' }, expect: 'success' },
    {
      name: 'invalid',
      input: { view: 'two' },
      expect: 'error',
      expectedError: { name: 'TypeError', message: 'Fixture view must be one.' },
      assertAfterError: () => {},
    },
  ];
}

function executeWithCases(tool, cases) {
  return runExecutableCatalogFixture(manifest, { tools: { show_fixture: { tool, cases } } });
}

function registrationFixture({ continueAfterSyncFailure }) {
  return (documentRef, tools, { onError = () => {} } = {}) => {
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
      catch (error) {
        fail(error, tool.name);
        if (!continueAfterSyncFailure) break;
      }
    }
    return () => controller.abort();
  };
}
