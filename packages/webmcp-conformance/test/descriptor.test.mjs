import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebMcpDescriptorValidationError,
  ProjectPolicyValidationError,
  assertValidWebMcpDescriptor,
  classifyProjectPolicyCeiling,
  classifyWebMcpDiscoveryHint,
  snapshotPageToolContract,
  validateClosedInputSchema,
  validateWebMcpDescriptor,
} from '../src/index.mjs';

function descriptor(annotations = { readOnlyHint: true }) {
  return {
    name: 'fixture_tool',
    title: 'Fixture tool',
    description: 'Read a bounded fixture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations,
  };
}

test('validates official descriptors and splits page-only policy annotations from the standard snapshot', () => {
  let executions = 0;
  const value = descriptor({ readOnlyHint: true, untrustedContentHint: true, openWorldHint: false });
  value.execute = async () => { executions += 1; };
  const before = structuredClone({ ...value, execute: null });
  assert.equal(validateWebMcpDescriptor({
    name: value.name,
    title: value.title,
    description: value.description,
    inputSchema: value.inputSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  }).valid, true);
  assert.deepEqual(snapshotPageToolContract(value), {
    descriptor: {
      name: value.name,
      title: value.title,
      description: value.description,
      inputSchema: value.inputSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    },
    nonstandardAnnotations: { openWorldHint: false },
  });
  assert.equal(executions, 0);
  assert.deepEqual({ ...value, execute: null }, before);
});

test('fails loudly for open schemas and nonstandard fields in official annotations', () => {
  const value = descriptor({ readOnlyHint: false, openWorldHint: false });
  value.inputSchema.additionalProperties = true;
  const result = validateWebMcpDescriptor(value);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(({ code }) => code), ['annotations.unsupported']);
  assert.ok(validateClosedInputSchema(value.inputSchema).issues.some(({ code }) => code === 'schema.closed_object'));
  assert.throws(() => assertValidWebMcpDescriptor(value), WebMcpDescriptorValidationError);
});

test('rejects malformed and contradictory descriptor data deterministically', () => {
  const value = descriptor({ readOnlyHint: true, destructiveHint: true });
  value.name = 'not a tool';
  value.inputSchema = {
    type: 'object',
    properties: { value: { type: 'string', minLength: 4, maxLength: 2 } },
    required: ['missing'],
    additionalProperties: false,
  };
  const result = validateWebMcpDescriptor(value);
  assert.deepEqual(result.issues.map(({ code }) => code), [
    'descriptor.name',
    'annotations.unsupported',
  ]);
  assert.deepEqual(validateClosedInputSchema(value.inputSchema).issues.map(({ code }) => code), ['schema.bound_order', 'schema.required_property']);
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
  const result = validateClosedInputSchema(value.inputSchema);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.filter(({ code }) => code === 'schema.closed_object'), [{
    path: '$.properties.entries.items.anyOf[1].additionalProperties',
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
    assert.equal(validateClosedInputSchema(value.inputSchema).valid, false, `schema escape validated: ${JSON.stringify(escape)}`);
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
    assert.equal(validateClosedInputSchema(value.inputSchema).valid, false, `invalid schema keyword validated: ${JSON.stringify(property)}`);
  }
});

test('rejects unsafe regular expressions and over-budget schemas before recursive validation', () => {
  const unsafe = descriptor();
  unsafe.inputSchema.properties = { value: { type: 'string', pattern: '^(a+)+$' } };
  assert.ok(validateClosedInputSchema(unsafe.inputSchema).issues.some(({ code }) => code === 'schema.pattern_safety'));
  const overlapping = descriptor();
  overlapping.inputSchema.properties = { value: { type: 'string', pattern: '^a+a+$' } };
  assert.ok(validateClosedInputSchema(overlapping.inputSchema).issues.some(({ code }) => code === 'schema.pattern_safety'));
  const oversizedFixed = descriptor();
  oversizedFixed.inputSchema.properties = { value: { type: 'string', pattern: '^a{999999}$' } };
  assert.ok(validateClosedInputSchema(oversizedFixed.inputSchema).issues.some(({ code }) => code === 'schema.pattern_safety'));

  const safe = descriptor();
  safe.inputSchema.properties = { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } };
  assert.equal(validateClosedInputSchema(safe.inputSchema).valid, true);

  const deep = descriptor();
  let node = deep.inputSchema;
  for (let index = 0; index < 30; index += 1) {
    node.properties = { next: { type: 'object', properties: {}, additionalProperties: false } };
    node = node.properties.next;
  }
  assert.ok(validateClosedInputSchema(deep.inputSchema).issues.some(({ code }) => code === 'json.depth'));
});

test('separates standard discovery hints from explicitly nonstandard project-policy ceilings', () => {
  const readDescriptor = descriptor({ readOnlyHint: true });
  const changeDescriptor = descriptor({ readOnlyHint: false });
  assert.equal(classifyWebMcpDiscoveryHint(readDescriptor), 'read-only-hint');
  assert.equal(classifyWebMcpDiscoveryHint(changeDescriptor), 'change-unknown');
  assert.equal(classifyProjectPolicyCeiling(readDescriptor, { openWorldHint: false }), 'read-only');
  assert.equal(classifyProjectPolicyCeiling(readDescriptor, { openWorldHint: true }), 'open-world-read');
  assert.equal(classifyProjectPolicyCeiling(changeDescriptor, { destructiveHint: false, idempotentHint: true, openWorldHint: false }), 'closed-world-change');
  assert.equal(classifyProjectPolicyCeiling(changeDescriptor, { destructiveHint: false, idempotentHint: false, openWorldHint: true }), 'open-world-change');
  assert.equal(classifyProjectPolicyCeiling(changeDescriptor, { destructiveHint: true, idempotentHint: false, openWorldHint: false }), 'destructive-change');
  assert.throws(() => classifyProjectPolicyCeiling(readDescriptor, { destructiveHint: true, openWorldHint: false }), ProjectPolicyValidationError);
  assert.throws(() => classifyProjectPolicyCeiling(changeDescriptor, { openWorldHint: false }), ProjectPolicyValidationError);
});

test('official descriptors allow dot names and optional title, schema, and annotations', () => {
  assert.equal(validateWebMcpDescriptor({ name: 'namespace.tool-1', description: 'No optional fields.' }).valid, true);
  const broaderSchema = {
    name: 'broader.schema',
    description: 'Standard-shaped but outside the project profile.',
    inputSchema: { $ref: '#/$defs/Value', $defs: { Value: { type: 'object' } } },
  };
  assert.equal(validateWebMcpDescriptor(broaderSchema).valid, true);
  assert.equal(validateClosedInputSchema(broaderSchema.inputSchema).valid, false);
});

test('page-tool snapshots reject malformed annotations and unsupported runtime fields', () => {
  assert.throws(() => snapshotPageToolContract({ ...descriptor(), annotations: null }), /annotations must be a plain object/u);
  assert.throws(() => snapshotPageToolContract({ ...descriptor(), annotations: [] }), /annotations must be a plain object/u);
  assert.throws(() => snapshotPageToolContract({ ...descriptor(), unexpected: true }), /not a supported field/u);
});

test('official descriptor and snapshot validation never invoke getters or proxy get traps', () => {
  let getterCalls = 0;
  const accessor = descriptor();
  Object.defineProperty(accessor, 'name', { enumerable: true, get() { getterCalls += 1; return 'getter'; } });
  assert.equal(validateWebMcpDescriptor(accessor).valid, false);
  assert.throws(() => snapshotPageToolContract(accessor), /own enumerable data field/u);

  const nestedSchema = descriptor();
  Object.defineProperty(nestedSchema.inputSchema.properties, 'secret', { enumerable: true, get() { getterCalls += 1; return { type: 'string' }; } });
  assert.equal(validateWebMcpDescriptor(nestedSchema).valid, false);
  assert.throws(() => snapshotPageToolContract(nestedSchema), /enumerable data properties/u);

  const annotationAccessor = descriptor();
  Object.defineProperty(annotationAccessor.annotations, 'readOnlyHint', { enumerable: true, get() { getterCalls += 1; return true; } });
  assert.equal(validateWebMcpDescriptor(annotationAccessor).valid, false);

  let proxyGets = 0;
  const proxied = new Proxy(descriptor(), { get(target, key, receiver) { proxyGets += 1; return Reflect.get(target, key, receiver); } });
  assert.equal(validateWebMcpDescriptor(proxied).valid, true);
  assert.equal(getterCalls, 0);
  assert.equal(proxyGets, 0);
});

test('official descriptor schema serialization is depth-bounded without applying project keywords', () => {
  const value = descriptor();
  let node = value.inputSchema;
  for (let index = 0; index < 30; index += 1) {
    node.next = {};
    node = node.next;
  }
  assert.ok(validateWebMcpDescriptor(value).issues.some(({ code }) => code === 'json.depth'));
});
