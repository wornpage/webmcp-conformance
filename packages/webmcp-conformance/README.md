# WebMCP conformance

`webmcp-conformance` is a zero-dependency Node package and CLI for comparing
page-owned WebMCP catalogs across unrelated applications.

It validates declarations; it does not guess authority from product copy or
grant authority to a tool.

## Contract layers

| Layer | Question answered |
|---|---|
| Descriptor | Is the tool name, closed input schema, and annotation set explicit and serializable? |
| Authority ceiling | What do the standard annotations permit: read, closed-world change, open-world access, or destruction? |
| Declared effect | What does the product say the tool actually does: read, change presentation, or prepare a local draft? |
| Receipt allowlist | Which exact top-level and focus fields may leave the tool? |
| Evidence | Which focus and denominator fields must a runtime test verify? |
| Lifecycle | Which whole-page registration properties must the registration owner satisfy? |

Authority classification is intentionally coarse. Both a page-local search
setter and a browser-local draft creator have a `closed-world-change` ceiling;
their separate `declaredEffect` and `allowedEffects` entries explain the
meaningful difference.

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
  classifyAuthority,
  runExecutableCatalogFixture,
  runRegistrationLifecycleFixture,
  validateCatalogManifest,
  validateToolDescriptor,
} from 'webmcp-conformance';
```

`runExecutableCatalogFixture` compares each live runtime descriptor to its
frozen snapshot before running success and failure cases. Successful results
must match the manifest's receipt allowlist. Adapter cases retain ownership of
domain, UI, durable-write, privacy, network, and human-gate assertions.

`runRegistrationLifecycleFixture` checks unsupported-browser cleanup, one
shared abort signal, synchronous and asynchronous fail-all behavior, idempotent
cleanup, and stale-cleanup isolation.

## Fixture boundaries

The JSON manifests are snapshots of named Git revisions. They do not import,
wrap, or change either source application. Updating a fixture requires a new
source revision and an executable source-contract test. The workspace's source
fixture test also resolves each configured checkout and requires its `HEAD` to
equal the manifest revision; `AFTERLIST_ROOT` and
`PROJECTS_WEBMCP_EXTENSION_ROOT` override the default sibling paths.
