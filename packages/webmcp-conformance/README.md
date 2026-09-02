# WebMCP conformance

`webmcp-conformance` is a zero-dependency Node package and CLI for comparing
page-owned WebMCP catalogs across unrelated applications.

It validates declarations; it does not guess authority from product copy or
grant authority to a tool.

## Contract layers

| Layer | Question answered |
|---|---|
| Standard descriptor | Does the tool use the current name grammar, required name/description, optional title/schema, and only `readOnlyHint` / `untrustedContentHint`? |
| Discovery classification | Is the site-authored standard hint `read-only-hint` or conservatively `change-unknown`? |
| Project policy | Which explicitly nonstandard destructive/idempotent/open-world declarations, ceiling, and effect does this project verify? |
| Receipt allowlist | Which exact top-level and focus fields may leave the tool? |
| Evidence | Which full result-relative focus, denominator, and human-gate paths must the runner prove? |
| Lifecycle | Which whole-page registration properties must the registration owner satisfy? |

Standard discovery classification never reads names, descriptions, schemas, or
project-only declarations. Project-policy ceilings and effects are reported in
a separate namespace and are not presented as WebMCP standard authority.

Catalog manifests use schema version `3`; version `2` is rejected. Version `3`
separates official descriptor data from `projectPolicy`. Within project policy,
every successful case must prove:

- `focusTruePaths` exist as own properties and equal `true`;
- `denominatorPaths` exist as non-negative safe integers; and
- `humanGateTruePaths` exist as own properties and equal `true`.

Focus receipts must expose all four proof flags: `focused`, `focusVisible`,
`inViewport`, and `pulsed`. Local-draft tools must declare at least one explicit
`requiresHuman…` gate path, disjoint from focus and denominator evidence.

The standard descriptor accepts an optional serializable object schema without
claiming that the project's subset is WebMCP standard. The explicit
`projectPolicy.inputSchemaProfile: closed-bounded-v1` applies a deliberately
bounded JSON Schema subset. Every accepted
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
  assertInputAgainstClosedSchema,
  classifyProjectPolicyCeiling,
  classifyWebMcpDiscoveryHint,
  runExecutableCatalogFixture,
  runRegistrationLifecycleFixture,
  validateCatalogManifest,
  validateWebMcpDescriptor,
} from 'webmcp-conformance';
```

`assertInputAgainstClosedSchema` is the shared runtime input owner. It rejects
accessors, custom prototypes, symbols, sparse/decorated arrays, cycles, unsafe
regular expressions, and over-budget depth, nodes, strings, or total UTF-8
bytes, then returns a detached canonical JSON snapshot. Consumers never freeze
or execute the caller-owned value.

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
