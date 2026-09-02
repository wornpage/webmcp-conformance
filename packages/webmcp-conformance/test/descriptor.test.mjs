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

test('requires closed objects recursively through array items and compositions', () => {
  const value = descriptor();
  value.inputSchema.properties = {
    entries: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string' },
          { type: 'object', properties: { label: { type: 'string' } } },
        ],
      },
    },
  };
  const result = validateToolDescriptor(value);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.filter(({ code }) => code === 'schema.closed_object'), [{
    path: '$.inputSchema.properties.entries.items.anyOf[1].additionalProperties',
    code: 'schema.closed_object',
    message: 'Every object schema must set additionalProperties to false.',
  }]);
});

test('rejects schema escape hatches outside the recursively closed subset', () => {
  const escapes = [
    { property: { $ref: '#/$defs/Open' }, root: { $defs: { Open: { type: 'object', properties: {} } } } },
    { property: { $ref: '#/definitions/Open' }, root: { definitions: { Open: { type: 'object', properties: {} } } } },
    { property: { required: ['secret'] } },
    { property: {} },
    { property: true },
    { property: { if: { type: 'string' }, then: { type: 'object', properties: {} } } },
    { property: { type: 'object', properties: {}, additionalProperties: false, patternProperties: { '^x': { type: 'string' } } } },
    { property: { type: 'array', items: { type: 'string' }, contains: { type: 'object', properties: {} } } },
    { property: { type: 'array', items: { type: 'string' }, prefixItems: [{ type: 'object', properties: {} }] } },
  ];
  for (const escape of escapes) {
    const value = descriptor();
    value.inputSchema = {
      type: 'object',
      properties: { candidate: escape.property },
      additionalProperties: false,
      ...escape.root,
    };
    assert.equal(validateToolDescriptor(value).valid, false, `schema escape validated: ${JSON.stringify(escape)}`);
  }
});

test('rejects invalid values and unsupported scalar keywords in the schema subset', () => {
  const invalid = [
    { type: 'integer', minimum: 'not-a-number' },
    { type: 'number', multipleOf: 0 },
    { type: 'string', format: { bad: true } },
    { type: 'string', title: 7 },
  ];
  for (const property of invalid) {
    const value = descriptor();
    value.inputSchema.properties = { candidate: property };
    assert.equal(validateToolDescriptor(value).valid, false, `invalid schema keyword validated: ${JSON.stringify(property)}`);
  }
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
