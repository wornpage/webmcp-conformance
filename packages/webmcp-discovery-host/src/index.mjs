import {
  InputSchemaValidationError,
  assertInputAgainstClosedSchema,
  validateClosedInputSchema,
} from 'webmcp-conformance';

const METADATA_TRUST = 'site-authored-unverified';
const READ_ONLY_HINT = 'read-only-hint';
const CHANGE_UNKNOWN = 'change-unknown';
const DECLARED_UNTRUSTED = 'declared-untrusted';
const NOT_DECLARED_UNTRUSTED = 'not-declared-untrusted';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const CLOSED_EMPTY_INPUT = Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false });
const MAX_RAW_RESULT_BYTES = 131_072;

export function supportsInPageWebMcp(documentRef) {
  const modelContext = documentRef?.modelContext;
  return !!modelContext &&
    typeof modelContext.getTools === 'function' &&
    typeof modelContext.executeTool === 'function' &&
    typeof modelContext.addEventListener === 'function' &&
    typeof modelContext.removeEventListener === 'function';
}

export function createWebMcpDiscoveryHost(options = {}) {
  return new WebMcpDiscoveryHost(options);
}

export class WebMcpDiscoveryHost {
  #modelContext;
  #requestorOrigin;
  #allowedOrigins;
  #discoverableOrigins;
  #generation = 0;
  #catalog = null;
  #registeredById = new Map();
  #plans = new WeakMap();
  #planSequence = 0;
  #disposed = false;
  #onToolChange;
  #authorize;

  constructor({ documentRef = globalThis.document, requestorOrigin, allowedOrigins = [], authorize } = {}) {
    if (!supportsInPageWebMcp(documentRef)) throw new WebMcpUnavailableError('The current in-page WebMCP discovery API is unavailable.');
    if (typeof authorize !== 'function') throw new AuthorizationRequiredError('A construction-time authorizer is required for every tool invocation.');
    const derivedOrigin = exactRequestorOrigin(documentRef?.location?.origin, 'document origin');
    if (requestorOrigin !== undefined && exactRequestorOrigin(requestorOrigin, 'requestor origin') !== derivedOrigin) {
      throw new OriginPolicyError('requestorOrigin must exactly match document.location.origin.');
    }
    if (!Array.isArray(allowedOrigins)) throw new OriginPolicyError('allowedOrigins must be an array of exact HTTPS origins.');
    const normalizedAllowed = allowedOrigins.map((origin) => exactSecureOrigin(origin, 'allowed origin'));
    if (new Set(normalizedAllowed).size !== normalizedAllowed.length) throw new OriginPolicyError('allowedOrigins must not contain duplicates.');
    if (normalizedAllowed.includes(derivedOrigin)) throw new OriginPolicyError('allowedOrigins must contain only explicit cross-origin origins.');

    this.#modelContext = documentRef.modelContext;
    this.#authorize = authorize;
    this.#requestorOrigin = derivedOrigin;
    this.#allowedOrigins = Object.freeze([...normalizedAllowed]);
    this.#discoverableOrigins = new Set([derivedOrigin, ...normalizedAllowed]);
    this.#onToolChange = () => this.#invalidate();
    this.#modelContext.addEventListener('toolchange', this.#onToolChange);
  }

  get stale() {
    return this.#catalog === null;
  }

  async refresh({ signal } = {}) {
    this.#assertActive();
    throwIfAborted(signal);
    this.#invalidate();
    const discoveryGeneration = this.#generation;
    const options = this.#allowedOrigins.length > 0 ? { fromOrigins: [...this.#allowedOrigins] } : undefined;
    const registeredTools = await awaitWithAbort(
      options ? this.#modelContext.getTools(options) : this.#modelContext.getTools(),
      signal,
    );
    throwIfAborted(signal);
    if (this.#generation !== discoveryGeneration) throw new CatalogStaleError('Tool discovery was invalidated by toolchange.');
    if (!Array.isArray(registeredTools)) throw new TypeError('modelContext.getTools() must resolve to an array of RegisteredTool objects.');

    const seenIdentities = new Set();
    const ownerNames = new WeakMap();
    const records = [];
    for (const registeredTool of registeredTools) {
      if (!plainRecord(registeredTool)) throw new TypeError('Discovery returned an invalid RegisteredTool object.');
      if (seenIdentities.has(registeredTool)) throw new TypeError('Discovery returned duplicate RegisteredTool identity.');
      seenIdentities.add(registeredTool);
      const fields = registeredToolFields(registeredTool);
      const origin = safeRegisteredOrigin(fields.origin);
      if (!origin || !this.#discoverableOrigins.has(origin)) {
        throw new OriginPolicyError('Discovery returned a malformed or unauthorized RegisteredTool origin.');
      }
      const name = registeredToolName(fields.name);
      const ownerWindow = fields.window;
      if ((typeof ownerWindow !== 'object' && typeof ownerWindow !== 'function') || ownerWindow === null) {
        throw new TypeError(`RegisteredTool ${name} is missing its required owner window.`);
      }
      const identityKey = `${origin}\u0000${name}`;
      const names = ownerNames.get(ownerWindow) ?? new Set();
      if (names.has(identityKey)) throw new TypeError(`Discovery returned duplicate owner/origin/name identity for ${name}.`);
      names.add(identityKey);
      ownerNames.set(ownerWindow, names);
      records.push(this.#catalogRecord(registeredTool, fields, origin, name, discoveryGeneration, records.length + 1));
    }
    if (this.#generation !== discoveryGeneration) throw new CatalogStaleError('Tool discovery was invalidated by toolchange.');

    this.#registeredById = new Map(records.map(({ entry, registeredTool, schema }) => [entry.id, { entry, registeredTool, schema }]));
    this.#catalog = deepFreeze({
      revision: discoveryGeneration,
      requestorOrigin: this.#requestorOrigin,
      discoverableOrigins: [this.#requestorOrigin, ...this.#allowedOrigins],
      metadataTrust: METADATA_TRUST,
      tools: records.map(({ entry }) => entry),
    });
    return this.#catalog;
  }

  getCatalog() {
    this.#assertActive();
    if (!this.#catalog) throw new CatalogStaleError('The tool catalog is stale; refresh is required.');
    return this.#catalog;
  }

  prepare(toolId, input = {}) {
    this.#assertActive();
    const catalog = this.getCatalog();
    if (typeof toolId !== 'string' || !toolId) throw new TypeError('A catalog tool id is required.');
    const record = this.#registeredById.get(toolId);
    if (!record) throw new PlanInvalidError('The catalog tool id is not active.');
    if (record.entry.status !== 'ready') throw new ToolBlockedError(`Tool ${toolId} is blocked by ${record.entry.blockedReason}.`);
    const preparedInput = deepFreeze(assertInputAgainstClosedSchema(record.schema, input));
    const plan = deepFreeze({
      id: `plan-${catalog.revision}-${++this.#planSequence}`,
      catalogRevision: catalog.revision,
      tool: {
        id: record.entry.id,
        origin: record.entry.origin,
        name: record.entry.name,
        title: record.entry.title,
        classification: record.entry.classification,
        metadataTrust: METADATA_TRUST,
        outputTrust: record.entry.outputTrust,
      },
      input: preparedInput,
      authorizationRequired: true,
    });
    this.#plans.set(plan, {
      generation: catalog.revision,
      registeredTool: record.registeredTool,
      input: preparedInput,
      outputTrust: record.entry.outputTrust,
      used: false,
    });
    return plan;
  }

  async execute(plan, { signal } = {}) {
    this.#assertActive();
    throwIfAborted(signal);
    const record = this.#plans.get(plan);
    if (!record || record.used) throw new PlanInvalidError('The prepared plan is unknown or already used.');
    this.#assertCurrentPlan(record);

    record.used = true;
    const accepted = await awaitWithAbort(Promise.resolve().then(() => this.#authorize(plan)), signal);
    throwIfAborted(signal);
    this.#assertCurrentPlan(record);
    if (accepted !== true) throw new AuthorizationDeniedError('The prepared plan was not authorized.');

    throwIfAborted(signal);
    this.#assertCurrentPlan(record);
    const result = await awaitWithAbort(
      this.#modelContext.executeTool(
        record.registeredTool,
        structuredClone(record.input),
        signal === undefined ? {} : { signal },
      ),
      signal,
    );
    const isStringResult = typeof result === 'string';
    const resultBytes = !isStringResult || result.length > MAX_RAW_RESULT_BYTES ? null : new TextEncoder().encode(result).byteLength;
    const resultOmitted = !isStringResult || resultBytes === null || resultBytes > MAX_RAW_RESULT_BYTES;
    return deepFreeze({
      executionCompleted: true,
      resultStatus: !isStringResult ? 'invalid-non-string' : resultOmitted ? 'omitted-too-large' : 'raw',
      rawResult: resultOmitted ? null : result,
      resultOmitted,
      rawResultBytes: resultBytes,
      rawResultCodeUnits: isStringResult ? result.length : null,
      outputTrust: record.outputTrust,
      metadataTrust: METADATA_TRUST,
      tool: plan.tool,
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#modelContext.removeEventListener('toolchange', this.#onToolChange);
    this.#disposed = true;
    this.#invalidate();
  }

  #catalogRecord(registeredTool, fields, origin, name, generation, position) {
    const title = metadataText(fields.title, 200, false);
    const description = metadataText(fields.description, 4_000, true);
    const schemaWasOmitted = fields.inputSchema === undefined;
    const schemaResult = validateClosedInputSchema(schemaWasOmitted ? CLOSED_EMPTY_INPUT : fields.inputSchema);
    const metadataValid = title !== null && description !== null;
    const blockedReason = !metadataValid ? 'invalid-metadata' : !schemaResult.valid ? 'unsupported-input-schema' : null;
    const annotations = {
      readOnlyHint: standardAnnotationHint(fields.annotations, 'readOnlyHint'),
      untrustedContentHint: standardAnnotationHint(fields.annotations, 'untrustedContentHint'),
    };
    const classification = annotations.readOnlyHint ? READ_ONLY_HINT : CHANGE_UNKNOWN;
    const outputTrust = annotations.untrustedContentHint ? DECLARED_UNTRUSTED : NOT_DECLARED_UNTRUSTED;
    const schema = schemaResult.valid ? deepFreeze(schemaResult.schema) : null;
    const entry = deepFreeze({
      id: `tool-${generation}-${position}`,
      origin,
      name,
      title,
      description,
      inputSchema: schema,
      inputSchemaSource: schemaWasOmitted ? 'host-default-closed-empty' : 'site-authored',
      annotations,
      classification,
      metadataTrust: METADATA_TRUST,
      outputTrust,
      status: blockedReason ? 'blocked' : 'ready',
      authorizationRequired: true,
      blockedReason,
      schemaIssues: schemaResult.valid ? [] : schemaResult.issues.map(({ path, code, message }) => ({ path, code, message })),
    });
    return { entry, registeredTool, schema };
  }

  #assertCurrentPlan(record) {
    if (!this.#catalog || record.generation !== this.#generation) throw new CatalogStaleError('The prepared plan was invalidated by a catalog change.');
  }

  #assertActive() {
    if (this.#disposed) throw new WebMcpUnavailableError('The discovery host has been disposed.');
  }

  #invalidate() {
    this.#generation += 1;
    this.#catalog = null;
    this.#registeredById = new Map();
  }
}

export class WebMcpUnavailableError extends Error {}
export class OriginPolicyError extends TypeError {}
export class CatalogStaleError extends Error {}
export class ToolBlockedError extends Error {}
export class PlanInvalidError extends Error {}
export class AuthorizationRequiredError extends Error {}
export class AuthorizationDeniedError extends Error {}
export { InputSchemaValidationError };

function exactOrigin(value, label) {
  if (typeof value !== 'string' || !value) throw new OriginPolicyError(`${label} must be an exact HTTP(S) origin.`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new OriginPolicyError(`${label} must be an exact HTTP(S) origin.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) throw new OriginPolicyError(`${label} must be an exact HTTP(S) origin.`);
  return parsed.origin;
}

function exactSecureOrigin(value, label) {
  const origin = exactOrigin(value, label);
  if (!origin.startsWith('https://')) throw new OriginPolicyError(`${label} must use HTTPS.`);
  return origin;
}

function exactRequestorOrigin(value, label) {
  const origin = exactOrigin(value, label);
  const parsed = new URL(origin);
  const loopback = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new OriginPolicyError(`${label} must use HTTPS or explicit loopback HTTP.`);
  }
  return origin;
}

function safeRegisteredOrigin(value) {
  try { return exactOrigin(value, 'RegisteredTool origin'); } catch { return null; }
}

function metadataText(value, limit, required) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > limit || CONTROL_CHARACTERS.test(value) || (required && value.length === 0)) return null;
  return value;
}

function registeredToolName(value) {
  if (typeof value !== 'string' || !TOOL_NAME.test(value)) throw new TypeError('RegisteredTool name does not match the current WebMCP grammar.');
  return value;
}

function registeredToolFields(tool) {
  return {
    name: ownDataField(tool, 'name', true),
    title: ownDataField(tool, 'title', false),
    description: ownDataField(tool, 'description', true),
    inputSchema: ownDataField(tool, 'inputSchema', false),
    origin: ownDataField(tool, 'origin', true),
    window: ownDataField(tool, 'window', true),
    annotations: ownDataField(tool, 'annotations', false),
  };
}

function ownDataField(record, name, required) {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) {
    if (!required) return undefined;
    throw new TypeError(`RegisteredTool is missing required ${name}.`);
  }
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw new TypeError(`RegisteredTool ${name} must be an enumerable data field.`);
  return descriptor.value;
}

function standardAnnotationHint(annotations, name) {
  if (!plainRecord(annotations)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(annotations, name);
  return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true && descriptor.value === true;
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
