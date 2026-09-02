# WebMCP discovery host

`@webmcp-conformance/webmcp-discovery-host` is a zero-third-party-dependency,
in-page host prototype for the [26 August 2026 WebMCP Draft Community Group
Report](https://webmachinelearning.github.io/webmcp/).

It uses only the draft page surface:

- `document.modelContext.getTools({ fromOrigins })`;
- `document.modelContext.executeTool(registeredTool, input, { signal })`; and
- `toolchange` on `document.modelContext`.

This is not a browser extension bridge. The draft explicitly says built-in
browser agents discover tools through a different internal mechanism; this
package neither exposes nor claims access to that mechanism.

## Security boundary

- Feature detection fails closed when the complete in-page API is absent.
- Discovery is same-origin by default. Cross-origin discovery accepts only an
  explicit list of exact HTTPS origins, passes only those origins to
  `getTools()`, and independently rejects any malformed or unauthorized result.
- The exact `RegisteredTool` and owner `window` remain private. Public tool ids
  include the catalog generation and expose only frozen serializable metadata.
- `readOnlyHint === true` is labeled `read-only-hint`; every other tool is
  `change-unknown`. Names, descriptions, schemas, and results never influence
  this label.
- All site metadata is `site-authored-unverified`. Outputs are either
  `declared-untrusted` or `not-declared-untrusted`—never trusted.
- A construction-time authorizer runs for every invocation, including tools
  carrying a read-only hint. It receives the exact frozen one-use plan. Only
  literal `true` permits native execution; no approval is remembered.
- `toolchange` invalidates the complete catalog, generation ids, and every plan.
- Inputs use the workspace's single recursively closed schema owner, with
  bounded depth, nodes, UTF-8 bytes, and an anchored linear regex subset.
  Regexes allow only small fixed `{n}` quantifiers; variable or overlapping
  quantifiers, groups, alternation, and backreferences are rejected.
- An omitted draft `inputSchema` is safely narrowed to a host-authored closed
  empty-object schema. Unsupported supplied schemas remain visible but blocked.
- Native results are not parsed. The host returns a bounded frozen envelope
  containing the exact raw string when it fits, or a successful omission
  receipt after an oversized or non-string polyfill result, plus
  `executionCompleted: true`, output/metadata labels, and sanitized tool
  identity. Post-execution host diagnostics never masquerade as a no-effect
  rejection.

## Usage

```js
import { createWebMcpDiscoveryHost } from '@webmcp-conformance/webmcp-discovery-host';

const host = createWebMcpDiscoveryHost({
  documentRef: document,
  allowedOrigins: ['https://partner.example'],
  authorize: async (plan) => showMandatoryReview(plan),
});

const catalog = await host.refresh();
const plan = host.prepare(catalog.tools[0].id, {});
const result = await host.execute(plan, { signal });

console.log(result.outputTrust, result.rawResult);
host.dispose();
```

`refresh()` and `execute()` reject pre-aborted signals and race pending discovery,
authorization, and native execution against later aborts.

The 128 KiB host result limit is applied only after the native API has
materialized its DOMString. It bounds the returned envelope, not the browser or
tool-owner allocation that already occurred. Page tools must therefore bound
their own results before resolving.

## Draft limitation

The draft identifies an unregister/re-register race for a same-name tool. This
host preserves the exact discovered dictionary, binds plans to a catalog
generation, and invalidates on `toolchange`, but event delivery is asynchronous;
it cannot prove that a final same-name registration still owns the callback at
the instant of execution. Page tools must continue to revalidate input and
authority inside their own execution path.

## Development

```sh
npm test
npm run check
```

The package depends only on the workspace's `webmcp-conformance` schema owner
and has no third-party runtime dependencies.
