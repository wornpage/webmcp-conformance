# WebMCP conformance

`webmcp-conformance` is a zero-dependency Node package and CLI for comparing
page-owned WebMCP catalogs across unrelated applications.

It validates declarations; it does not guess authority from product copy or
grant authority to a tool.

## Contract layers

| Layer | Question answered |
|---|---|
| Descriptor | Is the tool name, recursively closed input schema, and annotation set explicit and serializable? |
| Authority ceiling | What do the standard annotations permit: read, closed-world change, open-world access, or destruction? |
| Declared effect | What does the product say the tool actually does: read, change presentation, or prepare a local draft? |
| Receipt allowlist | Which exact top-level and focus fields may leave the tool? |
| Evidence | Which full result-relative focus, denominator, and human-gate paths must the runner prove? |
| Lifecycle | Which whole-page registration properties must the registration owner satisfy? |

Authority classification is intentionally coarse. Both a page-local search
setter and a browser-local draft creator have a `closed-world-change` ceiling;
their separate `declaredEffect` and `allowedEffects` entries explain the
meaningful difference.

Catalog manifests use schema version `2`. Version `1` is rejected because its
evidence declarations were metadata-only. In version `2`, every successful
case must prove:

- `focusTruePaths` exist as own properties and equal `true`;
- `denominatorPaths` exist as non-negative safe integers; and
- `humanGateTruePaths` exist as own properties and equal `true`.

Focus receipts must expose all four proof flags: `focused`, `focusVisible`,
`inViewport`, and `pulsed`. Local-draft tools must declare at least one explicit
`requiresHuman…` gate path, disjoint from focus and denominator evidence.

Input schemas use a deliberately bounded JSON Schema subset. Every accepted
node declares a type, a supported composition, or a closed object shape; arrays
declare `items`; and every object shape declares `properties` plus
`additionalProperties: false`. Boolean schemas, references, conditionals, and
unrecognized subschema keywords fail instead of bypassing recursive closure.

## CLI

From the workspace root:

```powershell
node packages/webmcp-conformance/src/cli.mjs validate fixtures/afterlist.json fixtures/projects-extension.json
node packages/webmcp-conformance/src/cli.mjs catalog fixtures/afterlist.json fixtures/projects-extension.json
node packages/webmcp-conformance/src/cli.mjs catalog --json fixtures/afterlist.json fixtures/projects-extension.json
```

`validate` exits `1` for any invalid manifest and `2` for incorrect CLI use.
The catalog report is sorted by catalog, page, and tool for deterministic diffs.

## Package API

```js
import {
  assertExactGitSourceCheckout,
  classifyAuthority,
  runExecutableCatalogFixture,
  runRegistrationLifecycleFixture,
  validateCatalogManifest,
  validateToolDescriptor,
} from 'webmcp-conformance';
```

`runExecutableCatalogFixture` compares each live runtime descriptor to its
frozen snapshot and preflights every adapter before executing anything. Every
tool requires at least one success and one bounded expected-error case. Errors
must match an exact `{ name, message }` declaration and run a mandatory
post-error effect assertion; arbitrary throws or reject-after-write behavior do
not satisfy the fixture. All error cases execute before any success. Successful
results must match the receipt allowlist and all executable evidence paths.
Adapter cases retain ownership of domain, UI, durable-write, privacy, and
network assertions.

`runRegistrationLifecycleFixture` checks unsupported-browser cleanup, one
shared abort signal, synchronous and asynchronous fail-all behavior, idempotent
cleanup, and stale-cleanup isolation. The synchronous failure probe includes a
later descriptor and fails if registration attempts continue past the error.

## Fixture boundaries

The JSON manifests are snapshots of named Git revisions. They do not import,
wrap, or change either source application. Updating a fixture requires a new
source revision and an executable source-contract test. The workspace's source
fixture test also resolves each configured checkout and requires its `HEAD` to
equal the manifest revision before importing source modules. Any tracked,
staged, or untracked checkout change rejects the immutable claim. `AFTERLIST_ROOT` and
`PROJECTS_WEBMCP_EXTENSION_ROOT` override the default sibling paths.
