import { classifyAuthority } from './authority.mjs';
import { validateToolDescriptor } from './descriptor.mjs';

const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const DECLARED_EFFECTS = new Set(['reader', 'presentation', 'local-draft', 'destructive', 'external-action']);
const AUTHORITIES = new Set(['read-only', 'open-world-read', 'closed-world-change', 'open-world-change', 'destructive-change']);
const EFFECT_KEYS = ['domain', 'ui', 'durable', 'network', 'humanActivations'];

/** @param {unknown} manifest */
export function validateCatalogManifest(manifest) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });
  if (!isRecord(manifest)) {
    add('$', 'manifest.type', 'Catalog manifest must be an object.');
    return { valid: false, issues };
  }
  if (manifest.version !== 1) add('$.version', 'manifest.version', 'Manifest version must be 1.');
  validateIdentifier(manifest.id, '$.id', add);
  validateText(manifest.title, '$.title', add);
  validateSource(manifest.source, add);
  validateLifecycle(manifest.lifecycle, add);

  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    add('$.pages', 'manifest.pages', 'Manifest must contain at least one page.');
  } else {
    const pagePaths = [];
    const toolNames = [];
    manifest.pages.forEach((page, pageIndex) => {
      const path = `$.pages[${pageIndex}]`;
      if (!isRecord(page)) {
        add(path, 'page.type', 'Page must be an object.');
        return;
      }
      if (typeof page.path !== 'string' || !page.path.startsWith('/') || page.path.includes('?') || page.path.includes('#')) {
        add(`${path}.path`, 'page.path', 'Page path must be an absolute route path without query or fragment.');
      } else pagePaths.push(page.path);
      if (!Array.isArray(page.tools) || page.tools.length === 0) {
        add(`${path}.tools`, 'page.tools', 'Page must declare at least one tool.');
      } else {
        page.tools.forEach((tool, toolIndex) => {
          validateManifestTool(tool, `${path}.tools[${toolIndex}]`, add);
          if (isRecord(tool) && isRecord(tool.descriptor) && typeof tool.descriptor.name === 'string') toolNames.push(tool.descriptor.name);
        });
      }
    });
    addDuplicates(pagePaths, '$.pages', 'page.duplicate', 'Page paths must be unique.', add);
    addDuplicates(toolNames, '$.pages', 'tool.duplicate', 'Tool names must be unique across the manifest.', add);
  }
  return { valid: issues.length === 0, issues };
}

/** @param {unknown} manifest */
export function assertValidCatalogManifest(manifest) {
  const result = validateCatalogManifest(manifest);
  if (!result.valid) throw new ManifestValidationError(result.issues);
  return manifest;
}

export class ManifestValidationError extends TypeError {
  constructor(issues) {
    super(issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join('\n'));
    this.name = 'ManifestValidationError';
    this.issues = structuredClone(issues);
  }
}

function validateManifestTool(tool, path, add) {
  if (!isRecord(tool)) {
    add(path, 'tool.type', 'Tool entry must be an object.');
    return;
  }
  const descriptorResult = validateToolDescriptor(tool.descriptor);
  for (const issue of descriptorResult.issues) add(`${path}.descriptor${issue.path.slice(1)}`, issue.code, issue.message);
  if (!DECLARED_EFFECTS.has(tool.declaredEffect)) add(`${path}.declaredEffect`, 'tool.effect', 'declaredEffect is not supported.');
  if (!AUTHORITIES.has(tool.expectedAuthority)) add(`${path}.expectedAuthority`, 'tool.authority', 'expectedAuthority is not supported.');
  if (descriptorResult.valid) {
    const { authority } = classifyAuthority(tool.descriptor);
    if (tool.expectedAuthority !== authority) {
      add(`${path}.expectedAuthority`, 'tool.authority_mismatch', `Expected authority must match descriptor classification ${authority}.`);
    }
    validateEffectCompatibility(tool.declaredEffect, authority, `${path}.declaredEffect`, add);
  }
  validateAllowedEffects(tool.allowedEffects, `${path}.allowedEffects`, tool.declaredEffect, add);
  validateEvidence(tool.evidence, `${path}.evidence`, add);
  validateReceiptAllowlist(tool.receiptAllowlist, `${path}.receiptAllowlist`, add);
  if (tool.knownGaps !== undefined) validateKnownGaps(tool.knownGaps, `${path}.knownGaps`, add);
}

function validateEffectCompatibility(effect, authority, path, add) {
  const permitted = {
    reader: new Set(['read-only', 'open-world-read']),
    presentation: new Set(['closed-world-change']),
    'local-draft': new Set(['closed-world-change']),
    destructive: new Set(['destructive-change']),
    'external-action': new Set(['open-world-change', 'destructive-change']),
  };
  if (permitted[effect] && !permitted[effect].has(authority)) {
    add(path, 'tool.effect_authority', `${effect} is incompatible with authority ${authority}.`);
  }
}

function validateAllowedEffects(value, path, effect, add) {
  if (!isRecord(value)) {
    add(path, 'effects.type', 'allowedEffects must be an object.');
    return;
  }
  for (const key of EFFECT_KEYS) validateUniqueStrings(value[key], `${path}.${key}`, add);
  if (EFFECT_KEYS.some((key) => !Array.isArray(value[key]))) return;
  if (effect === 'reader' && ['domain', 'ui', 'durable', 'humanActivations'].some((key) => value[key].length > 0)) {
    add(path, 'effects.reader', 'Reader tools cannot declare state or human-activation effects.');
  }
  if (effect === 'presentation' && (value.ui.length === 0 || value.domain.length > 0 || value.durable.length > 0 || value.network.length > 0 || value.humanActivations.length > 0)) {
    add(path, 'effects.presentation', 'Presentation tools must declare only bounded UI effects.');
  }
  if (effect === 'local-draft' && (value.domain.length + value.durable.length === 0 || value.network.length > 0 || value.humanActivations.length > 0)) {
    add(path, 'effects.local_draft', 'Local-draft tools require a local state effect and cannot declare network or human activation.');
  }
}

function validateEvidence(value, path, add) {
  if (!isRecord(value)) {
    add(path, 'evidence.type', 'evidence must be an object.');
    return;
  }
  for (const key of ['focusFields', 'denominatorFields']) validateUniqueStrings(value[key], `${path}.${key}`, add);
  if (typeof value.humanGate !== 'boolean') add(`${path}.humanGate`, 'evidence.boolean', 'humanGate must be a boolean.');
}

function validateReceiptAllowlist(value, path, add) {
  if (!isRecord(value)) {
    add(path, 'receipt.type', 'receiptAllowlist must be an object.');
    return;
  }
  validateUniqueStrings(value.resultFields, `${path}.resultFields`, add);
  validateUniqueStrings(value.focusFields, `${path}.focusFields`, add);
  if (typeof value.allowNull !== 'boolean') add(`${path}.allowNull`, 'receipt.boolean', 'allowNull must be a boolean.');
  if (Array.isArray(value.focusFields) && value.focusFields.length > 0 && Array.isArray(value.resultFields) && !value.resultFields.includes('focus')) {
    add(`${path}.focusFields`, 'receipt.focus_parent', 'focusFields require focus in resultFields.');
  }
}

function validateKnownGaps(value, path, add) {
  if (!Array.isArray(value)) {
    add(path, 'gaps.type', 'knownGaps must be an array.');
    return;
  }
  const codes = [];
  value.forEach((gap, index) => {
    if (!isRecord(gap)) {
      add(`${path}[${index}]`, 'gap.type', 'Known gap must be an object.');
      return;
    }
    validateIdentifier(gap.code, `${path}[${index}].code`, add);
    validateText(gap.note, `${path}[${index}].note`, add);
    if (typeof gap.code === 'string') codes.push(gap.code);
  });
  addDuplicates(codes, path, 'gap.duplicate', 'Known gap codes must be unique per tool.', add);
}

function validateSource(value, add) {
  if (!isRecord(value)) {
    add('$.source', 'source.type', 'source must be an object.');
    return;
  }
  if (!['git', 'local-git'].includes(value.kind)) add('$.source.kind', 'source.kind', 'Source kind must be git or local-git.');
  if (typeof value.revision !== 'string' || !REVISION.test(value.revision)) add('$.source.revision', 'source.revision', 'Source revision must be a full lowercase Git commit.');
  if (value.repository !== undefined && (typeof value.repository !== 'string' || !/^https:\/\//u.test(value.repository))) {
    add('$.source.repository', 'source.repository', 'Repository must be an HTTPS URL when present.');
  }
  validateUniqueStrings(value.paths, '$.source.paths', add);
}

function validateLifecycle(value, add) {
  if (!isRecord(value)) {
    add('$.lifecycle', 'lifecycle.type', 'lifecycle must be an object.');
    return;
  }
  for (const key of ['unsupportedNoop', 'sharedAbortSignal', 'abortAllOnFailure', 'cleanupIdempotent', 'staleCleanupIsolation']) {
    if (typeof value[key] !== 'boolean') add(`$.lifecycle.${key}`, 'lifecycle.boolean', `${key} must be declared as a boolean obligation.`);
  }
}

function validateUniqueStrings(value, path, add) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0) || new Set(value).size !== value.length) {
    add(path, 'array.unique_strings', 'Value must contain unique non-empty strings.');
  }
}

function addDuplicates(values, path, code, message, add) {
  if (new Set(values).size !== values.length) add(path, code, message);
}

function validateIdentifier(value, path, add) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) add(path, 'identifier.invalid', 'Value must be a lowercase kebab-case identifier.');
}

function validateText(value, path, add) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    add(path, 'text.invalid', 'Value must be non-empty, bounded, control-free text.');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
