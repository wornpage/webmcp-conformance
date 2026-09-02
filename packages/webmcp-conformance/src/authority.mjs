import { assertValidToolDescriptor } from './descriptor.mjs';

/**
 * Classify the authority ceiling declared by WebMCP annotations. This does not
 * infer product intent from a tool name or description.
 *
 * @param {unknown} descriptor
 */
export function classifyAuthority(descriptor) {
  assertValidToolDescriptor(descriptor);
  const annotations = descriptor.annotations;
  let authority;
  if (annotations.destructiveHint === true) authority = 'destructive-change';
  else if (annotations.readOnlyHint === true && annotations.openWorldHint === true) authority = 'open-world-read';
  else if (annotations.readOnlyHint === true) authority = 'read-only';
  else if (annotations.openWorldHint === true) authority = 'open-world-change';
  else authority = 'closed-world-change';

  return Object.freeze({
    authority,
    canChangeState: annotations.readOnlyHint === false,
    canDestroy: annotations.destructiveHint === true,
    canReachOpenWorld: annotations.openWorldHint === true,
    idempotent: typeof annotations.idempotentHint === 'boolean' ? annotations.idempotentHint : null,
    untrustedContent: typeof annotations.untrustedContentHint === 'boolean' ? annotations.untrustedContentHint : null,
  });
}
