import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InputSchemaValidationError,
  assertInputAgainstClosedSchema,
  validateInputAgainstClosedSchema,
} from '../src/index.mjs';

const schema = {
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 0 },
    choice: { type: 'string', enum: ['one', 'two'] },
    note: { anyOf: [{ type: 'string', minLength: 1, maxLength: 5, pattern: '^[a-z]{1}$' }, { type: 'null' }] },
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['count', 'choice', 'entries'],
  additionalProperties: false,
};

test('shared input owner validates the supported subset and returns a detached canonical snapshot', () => {
  const input = { count: 1, choice: 'one', note: null, entries: [{ title: 'A' }] };
  const canonical = assertInputAgainstClosedSchema(schema, input);
  assert.deepEqual(canonical, input);
  assert.notEqual(canonical, input);
  assert.notEqual(canonical.entries, input.entries);
  input.entries[0].title = 'Mutated';
  assert.equal(canonical.entries[0].title, 'A');
});

test('shared input owner rejects required, extra, type, enum, pattern, and bound failures', () => {
  const invalid = [
    {},
    { count: -1, choice: 'one', entries: [{ title: 'A' }] },
    { count: 1.5, choice: 'one', entries: [{ title: 'A' }] },
    { count: 1, choice: 'three', entries: [{ title: 'A' }] },
    { count: 1, choice: 'one', note: 'UPPER', entries: [{ title: 'A' }] },
    { count: 1, choice: 'one', entries: [] },
    { count: 1, choice: 'one', entries: [{ title: 'A', extra: true }] },
    { count: 1, choice: 'one', entries: [{ title: 'A' }], extra: true },
  ];
  for (const input of invalid) assert.equal(validateInputAgainstClosedSchema(schema, input).valid, false, `input validated: ${JSON.stringify(input)}`);
});

test('shared input owner rejects accessors, custom prototypes, sparse or decorated arrays, symbols, and cycles without invoking code', () => {
  let getterCalls = 0;
  const accessor = { count: 1, choice: 'one', entries: [{ title: 'A' }] };
  Object.defineProperty(accessor, 'extra', { enumerable: true, get() { getterCalls += 1; return true; } });
  assert.throws(() => assertInputAgainstClosedSchema(schema, accessor), InputSchemaValidationError);
  assert.equal(getterCalls, 0);

  const custom = Object.create({ inherited: true });
  Object.assign(custom, { count: 1, choice: 'one', entries: [{ title: 'A' }] });
  assert.throws(() => assertInputAgainstClosedSchema(schema, custom), InputSchemaValidationError);

  const sparse = [];
  sparse.length = 1;
  assert.equal(validateInputAgainstClosedSchema({ type: 'array', items: { type: 'string' } }, sparse).valid, false);
  const decorated = ['a'];
  decorated.extra = true;
  assert.equal(validateInputAgainstClosedSchema({ type: 'array', items: { type: 'string' } }, decorated).valid, false);

  const symbolInput = { count: 1, choice: 'one', entries: [{ title: 'A' }], [Symbol('secret')]: true };
  assert.throws(() => assertInputAgainstClosedSchema(schema, symbolInput), InputSchemaValidationError);
  const cyclic = { count: 1, choice: 'one', entries: [{ title: 'A' }] };
  cyclic.self = cyclic;
  assert.throws(() => assertInputAgainstClosedSchema(schema, cyclic), InputSchemaValidationError);
});

test('shared input owner bounds depth, nodes, and UTF-8 string bytes before schema recursion', () => {
  const textSchema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  };
  assert.ok(validateInputAgainstClosedSchema(textSchema, { value: 'x'.repeat(16_385) }).issues.some(({ code }) => code === 'json.string_bytes'));

  const arraySchema = {
    type: 'object',
    properties: { values: { type: 'array', items: { type: 'string' } } },
    required: ['values'],
    additionalProperties: false,
  };
  assert.ok(validateInputAgainstClosedSchema(arraySchema, { values: Array.from({ length: 2_049 }, () => 'x') }).issues.some(({ code }) => code === 'json.nodes'));
  assert.ok(validateInputAgainstClosedSchema(arraySchema, { values: Array.from({ length: 2_000 }, () => 'x'.repeat(64)) }).issues.some(({ code }) => code === 'json.total_bytes'));

  const deep = {};
  let node = deep;
  for (let index = 0; index < 30; index += 1) {
    node.next = {};
    node = node.next;
  }
  assert.ok(validateInputAgainstClosedSchema({ type: 'object', properties: {}, additionalProperties: false }, deep).issues.some(({ code }) => code === 'json.depth'));
});
