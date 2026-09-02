import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DescriptorValidationError,
  assertValidToolDescriptor,
  classifyAuthority,
  snapshotToolDescriptor,
  validateToolDescriptor,
} from '../src/index.mjs';

function descriptor(annotations = { readOnlyHint: true, openWorldHint: false }) {
  return {
    name: 'fixture_tool',
    title: 'Fixture tool',
    description: 'Read a bounded fixture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations,
    async execute() {},
  };
}

test('validates and snapshots a runtime descriptor without executing or mutating it', () => {
  let executions = 0;
  const value = descriptor();
  value.execute = async () => { executions += 1; };
  const before = structuredClone({ ...value, execute: null });
  assert.equal(validateToolDescriptor(value).valid, true);
  assert.deepEqual(snapshotToolDescriptor(value), {
    name: value.name,
    title: value.title,
    description: value.description,
    inputSchema: value.inputSchema,
    annotations: value.annotations,
  });
  assert.equal(executions, 0);
  assert.deepEqual({ ...value, execute: null }, before);
});

test('fails loudly when authority hints or closed input bounds are missing', () => {
  const value = descriptor({ readOnlyHint: false, openWorldHint: false });
  value.inputSchema.additionalProperties = true;
  const result = validateToolDescriptor(value);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(({ code }) => code), [
    'schema.closed_object',
    'annotations.required',
    'annotations.required',
  ]);
  assert.throws(() => assertValidToolDescriptor(value), DescriptorValidationError);
});

test('rejects malformed and contradictory descriptor data deterministically', () => {
  const value = descriptor({ readOnlyHint: true, destructiveHint: true, openWorldHint: false });
  value.name = 'not a tool';
  value.inputSchema = {
    type: 'object',
    properties: { value: { type: 'string', minLength: 4, maxLength: 2 } },
    required: ['missing'],
    additionalProperties: false,
  };
  const result = validateToolDescriptor(value);
  assert.deepEqual(result.issues.map(({ code }) => code), [
    'text.pattern',
    'schema.bound_order',
    'schema.required_property',
    'annotations.conflict',
  ]);
});

test('classifies annotation authority ceilings without reading names or descriptions', () => {
  const cases = [
    [{ readOnlyHint: true, openWorldHint: false }, 'read-only'],
    [{ readOnlyHint: true, openWorldHint: true }, 'open-world-read'],
    [{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, 'closed-world-change'],
    [{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, 'open-world-change'],
    [{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, 'destructive-change'],
  ];
  for (const [annotations, expected] of cases) assert.equal(classifyAuthority(descriptor(annotations)).authority, expected);
});
