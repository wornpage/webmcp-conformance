import { assertValidWebMcpDescriptor } from './descriptor.mjs';

const PROJECT_POLICY_ANNOTATIONS = ['destructiveHint', 'idempotentHint', 'openWorldHint'];

/** @param {unknown} descriptor */
export function classifyWebMcpDiscoveryHint(descriptor) {
  assertValidWebMcpDescriptor(descriptor);
  return descriptor.annotations?.readOnlyHint === true ? 'read-only-hint' : 'change-unknown';
}

/**
 * Compute the ceiling of the explicitly nonstandard project policy. These
 * declarations are source-parity evidence, not standard WebMCP annotations.
 *
 * @param {unknown} descriptor
 * @param {{ destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} declarations
 */
export function classifyProjectPolicyCeiling(descriptor, declarations) {
  assertValidWebMcpDescriptor(descriptor);
  const policy = assertValidProjectPolicyDeclarations(descriptor, declarations);
  const readOnly = descriptor.annotations?.readOnlyHint === true;
  if (policy.destructiveHint === true) return 'destructive-change';
  if (readOnly && policy.openWorldHint === true) return 'open-world-read';
  if (readOnly) return 'read-only';
  if (policy.openWorldHint === true) return 'open-world-change';
  return 'closed-world-change';
}

/** @param {unknown} descriptor @param {unknown} declarations */
export function validateProjectPolicyDeclarations(descriptor, declarations) {
  assertValidWebMcpDescriptor(descriptor);
  const issues = [];
  if (!plainRecord(declarations)) {
    return { valid: false, issues: [{ path: '$', code: 'project_policy.annotations', message: 'Project-policy declarations must be a plain object.' }], value: null };
  }
  const fields = {};
  for (const key of Reflect.ownKeys(declarations)) {
    if (typeof key !== 'string' || !PROJECT_POLICY_ANNOTATIONS.includes(key)) {
      issues.push({ path: typeof key === 'string' ? `$.${key}` : '$', code: 'project_policy.annotation_unsupported', message: `${String(key)} is not a supported project-policy annotation.` });
      continue;
    }
    const property = Object.getOwnPropertyDescriptor(declarations, key);
    if (!property || !Object.hasOwn(property, 'value') || property.enumerable !== true) {
      issues.push({ path: `$.${key}`, code: 'project_policy.annotation_data_field', message: `${key} must be an own enumerable data field.` });
      continue;
    }
    fields[key] = property.value;
    if (typeof fields[key] !== 'boolean') issues.push({ path: `$.${key}`, code: 'project_policy.annotation_boolean', message: `${key} must be a boolean when present.` });
  }
  if (typeof fields.openWorldHint !== 'boolean') issues.push({ path: '$.openWorldHint', code: 'project_policy.annotation_required', message: 'openWorldHint must be declared for project-policy parity.' });
  if (descriptor.annotations?.readOnlyHint !== true) {
    for (const key of ['destructiveHint', 'idempotentHint']) {
      if (typeof fields[key] !== 'boolean') issues.push({ path: `$.${key}`, code: 'project_policy.annotation_required', message: `${key} must be declared for a change-unknown tool.` });
    }
  }
  if (descriptor.annotations?.readOnlyHint === true && fields.destructiveHint === true) {
    issues.push({ path: '$.destructiveHint', code: 'project_policy.annotation_conflict', message: 'A read-only hint cannot pair with a destructive project-policy declaration.' });
  }
  return { valid: issues.length === 0, issues, value: issues.length === 0 ? fields : null };
}

/** @param {unknown} descriptor @param {unknown} declarations */
export function assertValidProjectPolicyDeclarations(descriptor, declarations) {
  const result = validateProjectPolicyDeclarations(descriptor, declarations);
  if (!result.valid) throw new ProjectPolicyValidationError(result.issues);
  return result.value;
}

export class ProjectPolicyValidationError extends TypeError {
  constructor(issues) {
    super(issues.map(({ path, code, message }) => `${path} [${code}] ${message}`).join('\n'));
    this.name = 'ProjectPolicyValidationError';
    this.issues = structuredClone(issues);
  }
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
