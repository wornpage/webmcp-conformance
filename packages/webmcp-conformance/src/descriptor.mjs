const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const AUTHORITY_ANNOTATIONS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

/**
 * Validate only the serializable WebMCP descriptor contract. The function is
 * pure: it neither executes a tool nor modifies the supplied object.
 *
 * @param {unknown} descriptor
 * @returns {{ valid: boolean, issues: Array<{ path: string, code: string, message: string }> }}
 */
export function validateToolDescriptor(descriptor) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });

  if (!isRecord(descriptor)) {
    add('$', 'descriptor.type', 'Tool descriptor must be an object.');
    return { valid: false, issues };
  }

  validateText(descriptor.name, '$.name', 128, add, TOOL_NAME);
  validateText(descriptor.title, '$.title', 200, add);
  validateText(descriptor.description, '$.description', 4_000, add);
  validateInputSchema(descriptor.inputSchema, '$.inputSchema', add);
  validateAnnotations(descriptor.annotations, add);

  return { valid: issues.length === 0, issues };
}

/** @param {unknown} descriptor */
export function assertValidToolDescriptor(descriptor) {
  const result = validateToolDescriptor(descriptor);
  if (!result.valid) throw new DescriptorValidationError(result.issues);
  return descriptor;
}

/**
 * Return the exact serializable fields used for catalog comparison. Runtime
 * callbacks and framework state are deliberately outside this snapshot.
 *
 * @param {unknown} descriptor
 */
export function snapshotToolDescriptor(descriptor) {
  assertValidToolDescriptor(descriptor);
  return structuredClone({
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    annotations: descriptor.annotations,
  });
}

export class DescriptorValidationError extends TypeError {
  /** @param {Array<{ path: string, code: string, message: string }>} issues */
  constructor(issues) {
    super(issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join('\n'));
    this.name = 'DescriptorValidationError';
    this.issues = structuredClone(issues);
  }
}

function validateAnnotations(value, add) {
  if (!isRecord(value)) {
    add('$.annotations', 'annotations.type', 'Annotations must be an object.');
    return;
  }

  for (const key of AUTHORITY_ANNOTATIONS) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      add(`$.annotations.${key}`, 'annotations.boolean', `${key} must be a boolean when present.`);
    }
  }
  if (typeof value.untrustedContentHint !== 'undefined' && typeof value.untrustedContentHint !== 'boolean') {
    add('$.annotations.untrustedContentHint', 'annotations.boolean', 'untrustedContentHint must be a boolean when present.');
  }
  if (typeof value.readOnlyHint !== 'boolean') {
    add('$.annotations.readOnlyHint', 'annotations.required', 'readOnlyHint must be declared explicitly.');
  }
  if (typeof value.openWorldHint !== 'boolean') {
    add('$.annotations.openWorldHint', 'annotations.required', 'openWorldHint must be declared explicitly.');
  }
  if (value.readOnlyHint === false) {
    for (const key of ['destructiveHint', 'idempotentHint']) {
      if (typeof value[key] !== 'boolean') {
        add(`$.annotations.${key}`, 'annotations.required', `${key} must be declared for a tool that can change state.`);
      }
    }
  }
  if (value.readOnlyHint === true && value.destructiveHint === true) {
    add('$.annotations.destructiveHint', 'annotations.conflict', 'A read-only tool cannot be destructive.');
  }
  validateJsonValue(value, '$.annotations', add, new WeakSet());
}

function validateInputSchema(value, path, add) {
  if (!isRecord(value)) {
    add(path, 'schema.type', 'Input schema must be an object schema.');
    return;
  }
  validateSchemaNode(value, path, add, new WeakSet());
  if (value.type !== 'object') add(`${path}.type`, 'schema.root_object', 'Input schema must declare type "object".');
  if (!isRecord(value.properties)) add(`${path}.properties`, 'schema.properties', 'Input schema must declare a properties object.');
  if (value.additionalProperties !== false) {
    add(`${path}.additionalProperties`, 'schema.closed_object', 'Input schema must set additionalProperties to false.');
  }
}

function validateSchemaNode(value, path, add, seen) {
  if (typeof value === 'boolean') return;
  if (!isRecord(value)) {
    add(path, 'schema.node', 'Schema node must be an object or boolean.');
    return;
  }
  if (seen.has(value)) {
    add(path, 'schema.cycle', 'Schema must not contain cycles.');
    return;
  }
  seen.add(value);

  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.length === 0 || types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) || new Set(types).size !== types.length) {
      add(`${path}.type`, 'schema.keyword', 'Schema type must contain unique supported JSON Schema types.');
    }
  }
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
    }
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
