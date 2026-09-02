const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const WEBMCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const STANDARD_ANNOTATIONS = ['readOnlyHint', 'untrustedContentHint'];
const PROJECT_POLICY_ANNOTATIONS = ['destructiveHint', 'idempotentHint', 'openWorldHint'];
const WEBMCP_DESCRIPTOR_KEYS = ['name', 'title', 'description', 'inputSchema', 'annotations'];
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'additionalProperties', 'allOf', 'anyOf', 'description', 'enum', 'items', 'maxItems',
  'maxLength', 'minItems', 'minLength', 'minimum', 'oneOf', 'pattern', 'properties',
  'required', 'type',
]);
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 2_048;
const MAX_JSON_STRING_BYTES = 16_384;
const MAX_JSON_TOTAL_BYTES = 131_072;

/**
 * Validate only the serializable WebMCP descriptor contract. The function is
 * pure: it neither executes a tool nor modifies the supplied object.
 *
 * @param {unknown} descriptor
 * @returns {{ valid: boolean, issues: Array<{ path: string, code: string, message: string }> }}
 */
export function validateWebMcpDescriptor(descriptor) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });

  if (!plainRecord(descriptor)) {
    add('$', 'descriptor.type', 'Tool descriptor must be an object.');
    return { valid: false, issues };
  }
  const fields = collectDataFields(descriptor, WEBMCP_DESCRIPTOR_KEYS, '$', add);

  if (typeof fields.name !== 'string' || !WEBMCP_TOOL_NAME.test(fields.name)) {
    add('$.name', 'descriptor.name', 'WebMCP name must be 1-128 ASCII alphanumeric, _, -, or . characters.');
  }
  if (fields.title !== undefined && typeof fields.title !== 'string') add('$.title', 'descriptor.title', 'WebMCP title must be a string when present.');
  if (typeof fields.description !== 'string' || fields.description.length === 0) add('$.description', 'descriptor.description', 'WebMCP description must be a non-empty string.');
  if (fields.inputSchema !== undefined) {
    if (!isRecord(fields.inputSchema)) add('$.inputSchema', 'descriptor.input_schema', 'WebMCP inputSchema must be an object when present.');
    else {
      const schemaJson = canonicalizeBoundedJson(fields.inputSchema, '$.inputSchema');
      schemaJson.issues.forEach((issue) => add(issue.path, issue.code, issue.message));
    }
  }
  validateStandardAnnotations(fields.annotations, add);

  return { valid: issues.length === 0, issues };
}

/** @param {unknown} descriptor */
export function assertValidWebMcpDescriptor(descriptor) {
  const result = validateWebMcpDescriptor(descriptor);
  if (!result.valid) throw new WebMcpDescriptorValidationError(result.issues);
  return descriptor;
}

/** @param {unknown} schema */
export function validateClosedInputSchema(schema) {
  const canonical = canonicalizeBoundedJson(schema, '$');
  const issues = [...canonical.issues];
  const canonicalSchema = canonical.value;
  if (issues.length === 0) validateInputSchema(canonicalSchema, '$', (path, code, message) => issues.push({ path, code, message }));
  return { valid: issues.length === 0, issues, schema: issues.length === 0 ? canonicalSchema : null };
}

/** @param {unknown} schema */
export function assertClosedInputSchema(schema) {
  const result = validateClosedInputSchema(schema);
  if (!result.valid) throw new InputSchemaValidationError(result.issues);
  return result.schema;
}

/** @param {unknown} schema @param {unknown} input */
export function validateInputAgainstClosedSchema(schema, input) {
  const schemaResult = validateClosedInputSchema(schema);
  const issues = [];
  if (!schemaResult.valid) return { valid: false, issues: schemaResult.issues, value: null };
  const canonical = canonicalizeBoundedJson(input, '$');
  issues.push(...canonical.issues);
  const canonicalInput = canonical.value;
  if (issues.length === 0) validateInputValue(canonicalInput, schemaResult.schema, '$', issues, new WeakSet());
  return { valid: issues.length === 0, issues, value: issues.length === 0 ? canonicalInput : null };
}

/** @param {unknown} schema @param {unknown} input */
export function assertInputAgainstClosedSchema(schema, input) {
  const result = validateInputAgainstClosedSchema(schema, input);
  if (!result.valid) throw new InputSchemaValidationError(result.issues);
  return result.value;
}

/**
 * Return the exact serializable fields used for catalog comparison. Runtime
 * callbacks and framework state are deliberately outside this snapshot.
 *
 * @param {unknown} descriptor
 */
export function snapshotPageToolContract(pageTool) {
  if (!plainRecord(pageTool)) throw new TypeError('Page tool contract requires a plain object.');
  const allowedPageToolKeys = [...WEBMCP_DESCRIPTOR_KEYS, 'execute'];
  const fieldIssues = [];
  const fields = collectDataFields(pageTool, allowedPageToolKeys, '$', (path, code, message) => fieldIssues.push({ path, code, message }));
  if (fieldIssues.length > 0) throw new TypeError(fieldIssues.map(({ path, message }) => `${path} ${message}`).join('\n'));
  if (Object.hasOwn(fields, 'execute') && typeof fields.execute !== 'function') throw new TypeError('Page tool execute must be a function when present.');
  if (Object.hasOwn(fields, 'annotations') && !plainRecord(fields.annotations)) throw new TypeError('Page tool annotations must be a plain object when present.');
  const annotations = Object.hasOwn(fields, 'annotations') ? collectSnapshotAnnotations(fields.annotations) : {};
  const standardAnnotations = Object.fromEntries(STANDARD_ANNOTATIONS.filter((key) => Object.hasOwn(annotations, key)).map((key) => [key, annotations[key]]));
  const nonstandardAnnotations = Object.fromEntries(PROJECT_POLICY_ANNOTATIONS.filter((key) => Object.hasOwn(annotations, key)).map((key) => [key, annotations[key]]));
  const descriptor = {
    name: fields.name,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    description: fields.description,
    ...(fields.inputSchema === undefined ? {} : { inputSchema: canonicalizeSnapshotSchema(fields.inputSchema) }),
    ...(fields.annotations === undefined ? {} : { annotations: standardAnnotations }),
  };
  assertValidWebMcpDescriptor(descriptor);
  return structuredClone({ descriptor, nonstandardAnnotations });
}

export class WebMcpDescriptorValidationError extends TypeError {
  /** @param {Array<{ path: string, code: string, message: string }>} issues */
  constructor(issues) {
    super(issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join('\n'));
    this.name = 'WebMcpDescriptorValidationError';
    this.issues = structuredClone(issues);
  }
}

export class InputSchemaValidationError extends TypeError {
  /** @param {Array<{ path: string, code: string, message: string }>} issues */
  constructor(issues) {
    super(issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join('\n'));
    this.name = 'InputSchemaValidationError';
    this.issues = structuredClone(issues);
  }
}

function validateStandardAnnotations(value, add) {
  if (value === undefined) return;
  if (!plainRecord(value)) {
    add('$.annotations', 'annotations.type', 'Standard WebMCP annotations must be an object.');
    return;
  }
  const fields = collectDataFields(value, STANDARD_ANNOTATIONS, '$.annotations', add, 'annotations');
  for (const key of STANDARD_ANNOTATIONS) {
    if (Object.hasOwn(fields, key) && typeof fields[key] !== 'boolean') add(`$.annotations.${key}`, 'annotations.boolean', `${key} must be a boolean when present.`);
  }
  validateJsonValue(fields, '$.annotations', add, new WeakSet());
}

function validateInputSchema(value, path, add) {
  if (!isRecord(value)) {
    add(path, 'schema.type', 'Input schema must be an object schema.');
    return;
  }
  validateSchemaNode(value, path, add, new WeakSet());
  if (value.type !== 'object') add(`${path}.type`, 'schema.root_object', 'Input schema must declare type "object".');
}

function validateSchemaNode(value, path, add, seen) {
  if (typeof value === 'boolean') {
    add(path, 'schema.boolean', 'Boolean schemas are not supported by the closed input contract.');
    return;
  }
  if (!isRecord(value)) {
    add(path, 'schema.node', 'Schema node must be an object or boolean.');
    return;
  }
  if (seen.has(value)) {
    add(path, 'schema.cycle', 'Schema must not contain cycles.');
    return;
  }
  seen.add(value);

  for (const keyword of Object.keys(value).sort()) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) add(`${path}.${keyword}`, 'schema.unsupported_keyword', `${keyword} is not supported by the closed input contract.`);
  }

  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.length === 0 || types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) || new Set(types).size !== types.length) {
      add(`${path}.type`, 'schema.keyword', 'Schema type must contain unique supported JSON Schema types.');
    }
  }
  const schemaTypes = Array.isArray(value.type) ? value.type : [value.type];
  const hasComposition = ['allOf', 'anyOf', 'oneOf'].some((keyword) => Object.hasOwn(value, keyword));
  const objectTyped = schemaTypes.includes('object') || ['properties', 'required', 'additionalProperties'].some((keyword) => Object.hasOwn(value, keyword));
  if (value.type === undefined && !hasComposition && !objectTyped) {
    add(path, 'schema.unconstrained', 'Schema nodes must declare a type, a supported composition, or a closed object shape.');
  }
  if (objectTyped) {
    if (!isRecord(value.properties)) add(`${path}.properties`, 'schema.properties', 'Object schemas must declare a properties object.');
    if (value.additionalProperties !== false) {
      add(`${path}.additionalProperties`, 'schema.closed_object', 'Every object schema must set additionalProperties to false.');
    }
  }
  if (schemaTypes.includes('array') && value.items === undefined) add(`${path}.items`, 'schema.array_items', 'Array schemas must declare one recursively closed items schema.');
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      add(`${path}.properties`, 'schema.properties', 'properties must be an object.');
    } else {
      for (const key of Object.keys(value.properties).sort()) {
        if (!key || CONTROL_CHARACTERS.test(key)) add(`${path}.properties`, 'schema.property_name', 'Property names must be non-empty and control-free.');
        validateSchemaNode(value.properties[key], `${path}.properties.${key}`, add, seen);
      }
    }
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== 'string') || new Set(value.required).size !== value.required.length) {
      add(`${path}.required`, 'schema.required', 'required must contain unique property names.');
    } else if (isRecord(value.properties)) {
      for (const name of value.required) {
        if (!Object.hasOwn(value.properties, name)) add(`${path}.required`, 'schema.required_property', `Required property ${JSON.stringify(name)} is not declared.`);
      }
    }
  }
  if (value.items !== undefined) validateSchemaNode(value.items, `${path}.items`, add, seen);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (value[keyword] !== undefined) {
      if (!Array.isArray(value[keyword]) || value[keyword].length === 0) {
        add(`${path}.${keyword}`, 'schema.composition', `${keyword} must be a non-empty array.`);
      } else {
        value[keyword].forEach((entry, index) => validateSchemaNode(entry, `${path}.${keyword}[${index}]`, add, seen));
      }
    }
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || !uniqueJsonValues(value.enum))) {
    add(`${path}.enum`, 'schema.enum', 'enum must contain at least one unique JSON value.');
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string') add(`${path}.pattern`, 'schema.pattern', 'pattern must be a string.');
    else {
      try { new RegExp(value.pattern, 'u'); } catch { add(`${path}.pattern`, 'schema.pattern', 'pattern must be a valid regular expression.'); }
      if (!safeLinearPattern(value.pattern)) add(`${path}.pattern`, 'schema.pattern_safety', 'pattern must use the anchored linear subset.');
    }
  }
  if (value.minimum !== undefined && (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum))) {
    add(`${path}.minimum`, 'schema.minimum', 'minimum must be a finite number.');
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (value[keyword] !== undefined && (!Number.isSafeInteger(value[keyword]) || value[keyword] < 0)) {
      add(`${path}.${keyword}`, 'schema.bound', `${keyword} must be a non-negative safe integer.`);
    }
  }
  if (Number.isSafeInteger(value.minLength) && Number.isSafeInteger(value.maxLength) && value.minLength > value.maxLength) {
    add(path, 'schema.bound_order', 'minLength cannot exceed maxLength.');
  }
  if (Number.isSafeInteger(value.minItems) && Number.isSafeInteger(value.maxItems) && value.minItems > value.maxItems) {
    add(path, 'schema.bound_order', 'minItems cannot exceed maxItems.');
  }
  if (value.description !== undefined) validateText(value.description, `${path}.description`, 4_000, add);
  validateJsonValue(value, path, add, new WeakSet());
  seen.delete(value);
}

function validateText(value, path, maxLength, add, pattern) {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maxLength || CONTROL_CHARACTERS.test(value)) {
    add(path, 'text.invalid', `Value must be non-empty, control-free text of at most ${maxLength} characters.`);
  } else if (pattern && !pattern.test(value)) {
    add(path, 'text.pattern', 'Tool name contains unsupported characters.');
  }
}

function canonicalizeBoundedJson(value, path) {
  const issues = [];
  const canonical = canonicalJsonValue(value, path, issues, new WeakSet(), createJsonBudget(), 0);
  if (issues.length === 0) validateSerializedJsonBudget(canonical, path, issues);
  return { valid: issues.length === 0, issues, value: issues.length === 0 ? canonical : null };
}

function canonicalizeSnapshotSchema(value) {
  const result = canonicalizeBoundedJson(value, '$.inputSchema');
  if (!result.valid) throw new TypeError(result.issues.map(({ path, message }) => `${path} ${message}`).join('\n'));
  return result.value;
}

function canonicalJsonValue(value, path, issues, ancestors, budget, depth) {
  if (!enterJsonBudget(value, path, issues, budget, depth)) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    issues.push({ path, code: 'json.number', message: 'JSON numbers must be finite.' });
    return null;
  }
  if (typeof value !== 'object') {
    issues.push({ path, code: 'json.value', message: 'Value must be JSON-serializable.' });
    return null;
  }
  if (ancestors.has(value)) {
    issues.push({ path, code: 'json.cycle', message: 'Value must not contain cycles.' });
    return null;
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) issues.push({ path, code: 'json.array', message: 'Arrays must use the intrinsic Array prototype.' });
    if (value.length > MAX_JSON_NODES) {
      issues.push({ path, code: 'json.nodes', message: `JSON values may contain at most ${MAX_JSON_NODES} nodes.` });
      ancestors.delete(value);
      return [];
    }
    const keys = Reflect.ownKeys(value);
    const expectedKeys = [...Array(value.length).keys()].map(String);
    const actualElementKeys = keys.filter((key) => key !== 'length');
    if (
      actualElementKeys.some((key) => typeof key !== 'string') ||
      actualElementKeys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => actualElementKeys.includes(key))
    ) issues.push({ path, code: 'json.array_shape', message: 'Arrays must be dense and contain no extra properties.' });
    const clone = [];
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        issues.push({ path: `${path}[${key}]`, code: 'json.data_property', message: 'JSON values must use enumerable data properties.' });
        continue;
      }
      clone.push(canonicalJsonValue(descriptor.value, `${path}[${key}]`, issues, ancestors, budget, depth + 1));
    }
    ancestors.delete(value);
    return clone;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push({ path, code: 'json.object', message: 'Objects must use Object.prototype or a null prototype.' });
  }
  const clone = {};
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_JSON_NODES) {
    issues.push({ path, code: 'json.nodes', message: `JSON values may contain at most ${MAX_JSON_NODES} nodes.` });
    ancestors.delete(value);
    return clone;
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      issues.push({ path, code: 'json.property', message: 'JSON object keys must be strings.' });
      continue;
    }
    chargeJsonBytes(key, path, issues, budget);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      issues.push({ path: `${path}.${key}`, code: 'json.data_property', message: 'JSON values must use enumerable data properties.' });
      continue;
    }
    Object.defineProperty(clone, key, {
      value: canonicalJsonValue(descriptor.value, `${path}.${key}`, issues, ancestors, budget, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return clone;
}

function createJsonBudget() {
  return { nodes: 0, bytes: 0, failed: false };
}

function enterJsonBudget(value, path, issues, budget, depth) {
  if (budget.failed) return false;
  if (depth > MAX_JSON_DEPTH) {
    issues.push({ path, code: 'json.depth', message: `JSON values may be at most ${MAX_JSON_DEPTH} levels deep.` });
    budget.failed = true;
    return false;
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) {
    issues.push({ path, code: 'json.nodes', message: `JSON values may contain at most ${MAX_JSON_NODES} nodes.` });
    budget.failed = true;
    return false;
  }
  if (typeof value === 'string' && (value.length > MAX_JSON_STRING_BYTES || utf8Bytes(value) > MAX_JSON_STRING_BYTES)) {
    issues.push({ path, code: 'json.string_bytes', message: `JSON strings may contain at most ${MAX_JSON_STRING_BYTES} UTF-8 bytes.` });
    budget.failed = true;
    return false;
  }
  const scalar = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value === null ? 'null' : typeof value === 'boolean' ? String(value) : '';
  chargeJsonBytes(scalar, path, issues, budget);
  return !budget.failed;
}

function chargeJsonBytes(value, path, issues, budget) {
  if (budget.failed) return;
  if (value.length > MAX_JSON_STRING_BYTES) {
    issues.push({ path, code: 'json.string_bytes', message: `JSON strings may contain at most ${MAX_JSON_STRING_BYTES} UTF-8 bytes.` });
    budget.failed = true;
    return;
  }
  const bytes = utf8Bytes(value);
  if (bytes > MAX_JSON_STRING_BYTES) {
    issues.push({ path, code: 'json.string_bytes', message: `JSON strings may contain at most ${MAX_JSON_STRING_BYTES} UTF-8 bytes.` });
    budget.failed = true;
    return;
  }
  budget.bytes += bytes;
  if (budget.bytes > MAX_JSON_TOTAL_BYTES) {
    issues.push({ path, code: 'json.total_bytes', message: `JSON values may contain at most ${MAX_JSON_TOTAL_BYTES} UTF-8 bytes.` });
    budget.failed = true;
  }
}

function validateSerializedJsonBudget(value, path, issues) {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_JSON_TOTAL_BYTES || utf8Bytes(serialized) > MAX_JSON_TOTAL_BYTES) {
    issues.push({ path, code: 'json.total_bytes', message: `Serialized JSON may contain at most ${MAX_JSON_TOTAL_BYTES} UTF-8 bytes.` });
  }
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function safeLinearPattern(pattern) {
  if (pattern.length === 0 || pattern.length > 256 || !pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  if (/[()|+*?]/u.test(pattern) || /\\[1-9]/u.test(pattern)) return false;
  if ([...pattern.matchAll(/\{(\d+)\}/gu)].some((match) => Number(match[1]) > 1_024)) return false;
  const withoutFixedQuantifiers = pattern.replace(/\{\d+\}/gu, '');
  if (/[{},]/u.test(withoutFixedQuantifiers)) return false;
  return /^[\^$A-Za-z0-9_\-.:\\\[\]{}]+$/u.test(pattern);
}

function validateInputValue(value, schema, path, issues, ancestors) {
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    const branchResults = schema[keyword].map((branch) => {
      const branchIssues = [];
      validateInputValue(value, branch, path, branchIssues, ancestors);
      return branchIssues;
    });
    const matches = branchResults.filter((branchIssues) => branchIssues.length === 0).length;
    if (keyword === 'allOf') branchResults.forEach((branchIssues) => issues.push(...branchIssues));
    else if (keyword === 'anyOf' && matches === 0) issues.push({ path, code: 'input.anyOf', message: 'Value must match at least one allowed schema.' });
    else if (keyword === 'oneOf' && matches !== 1) issues.push({ path, code: 'input.oneOf', message: 'Value must match exactly one allowed schema.' });
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.length > 0 && !types.some((type) => inputMatchesType(value, type))) {
    issues.push({ path, code: 'input.type', message: `Value must match type ${types.join(' or ')}.` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) {
    issues.push({ path, code: 'input.enum', message: 'Value is not one of the allowed enum values.' });
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (Number.isSafeInteger(schema.minLength) && length < schema.minLength) issues.push({ path, code: 'input.minLength', message: `String must contain at least ${schema.minLength} characters.` });
    if (Number.isSafeInteger(schema.maxLength) && length > schema.maxLength) issues.push({ path, code: 'input.maxLength', message: `String must contain at most ${schema.maxLength} characters.` });
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) issues.push({ path, code: 'input.pattern', message: 'String does not match the required pattern.' });
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    issues.push({ path, code: 'input.minimum', message: `Number must be at least ${schema.minimum}.` });
  }
  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) issues.push({ path, code: 'input.minItems', message: `Array must contain at least ${schema.minItems} items.` });
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) issues.push({ path, code: 'input.maxItems', message: `Array must contain at most ${schema.maxItems} items.` });
    if (schema.items) {
      if (ancestors.has(value)) {
        issues.push({ path, code: 'input.cycle', message: 'Input must not contain cycles.' });
      } else {
        ancestors.add(value);
        value.forEach((entry, index) => validateInputValue(entry, schema.items, `${path}[${index}]`, issues, ancestors));
        ancestors.delete(value);
      }
    }
  }
  const objectSchema = types.includes('object') || ['properties', 'required', 'additionalProperties'].some((keyword) => Object.hasOwn(schema, keyword));
  if (objectSchema && isPlainInputObject(value)) {
    if (ancestors.has(value)) {
      issues.push({ path, code: 'input.cycle', message: 'Input must not contain cycles.' });
      return;
    }
    ancestors.add(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) issues.push({ path, code: 'input.property', message: 'Input object keys must be strings.' });
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, required)) issues.push({ path: `${path}.${required}`, code: 'input.required', message: 'Required property is missing.' });
    }
    for (const key of Object.keys(value).sort()) {
      if (!Object.hasOwn(properties, key)) issues.push({ path: `${path}.${key}`, code: 'input.additionalProperty', message: 'Additional properties are not allowed.' });
      else validateInputValue(value[key], properties[key], `${path}.${key}`, issues, ancestors);
    }
    ancestors.delete(value);
  } else if (objectSchema && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    issues.push({ path, code: 'input.object', message: 'Object inputs must be plain records.' });
  }
}

function inputMatchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainInputObject(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function isPlainInputObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  if (isPlainInputObject(left) && isPlainInputObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

function validateJsonValue(value, path, add, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) add(path, 'json.number', 'JSON numbers must be finite.');
    return;
  }
  if (typeof value !== 'object') {
    add(path, 'json.value', 'Value must be JSON-serializable.');
    return;
  }
  if (seen.has(value)) {
    add(path, 'json.cycle', 'Value must not contain cycles.');
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, add, seen));
  else for (const key of Object.keys(value).sort()) validateJsonValue(value[key], `${path}.${key}`, add, seen);
  seen.delete(value);
}

function uniqueJsonValues(values) {
  try {
    const keys = values.map((value) => JSON.stringify(value));
    return keys.every((key) => key !== undefined) && new Set(keys).size === keys.length;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainRecord(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function collectDataFields(record, allowedKeys, path, add, namespace = 'descriptor') {
  const fields = {};
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') {
      add(path, `${namespace}.symbol`, 'Descriptor fields must use string keys.');
      continue;
    }
    if (!allowedKeys.includes(key)) {
      add(`${path}.${key}`, `${namespace}.unsupported`, `${key} is not a supported field.`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      add(`${path}.${key}`, `${namespace}.data_field`, `${key} must be an own enumerable data field.`);
      continue;
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function collectSnapshotAnnotations(annotations) {
  const issues = [];
  const fields = collectDataFields(
    annotations,
    [...STANDARD_ANNOTATIONS, ...PROJECT_POLICY_ANNOTATIONS],
    '$.annotations',
    (path, code, message) => issues.push({ path, code, message }),
    'annotations',
  );
  if (issues.length > 0) throw new TypeError(issues.map(({ path, message }) => `${path} ${message}`).join('\n'));
  return fields;
}
