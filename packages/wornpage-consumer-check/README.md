# Wornpage consumer check

`@webmcp-conformance/wornpage-consumer-check` is a zero-dependency, read-only
consumer gate for Svelte applications that compile `@wornpage/*` packages.
The checker is independent of SvelteKit, Vite, npm workspaces, and any one app
layout: give it the consumer root and, when needed, a different source folder.

## What it proves

For every declared `@wornpage/*` runtime dependency, the checker verifies:

- `package.json` uses an exact
  `https://codeload.github.com/wornpage/<repo>/tar.gz/<40-char-commit>` pin;
- `package-lock.json` repeats that declaration, resolves the same archive and
  commit, and records a real SHA-512 integrity digest;
- installed npm metadata resolves the same commit without a nested Wornpage
  revision;
- the installed package exposes existing canonical Svelte source and runtime
  entries under `src/` or `dist/`, declares the Wornpage v2 delivery contract,
  and includes those entries in `package.json#files`;
- application imports use the package root, are declared, and leave no declared
  Wornpage package unused; and
- active thin compatibility components do not forward arbitrary props and
  children through a Wornpage component instead of importing it directly.

The gate does not contact GitHub, install dependencies, repair locks, or rewrite
the consumer. Run the consumer's locked install before checking it.

## CLI

```sh
npx wornpage-consumer-check ./path/to/svelte-consumer
npx wornpage-consumer-check --root ./app --source-dir src --verbose
npx wornpage-consumer-check ./app --json
```

Exit codes are stable:

| Code | Meaning |
| ---: | --- |
| `0` | The complete consumer contract passed. |
| `1` | One or more conformance findings were reported. |
| `2` | CLI arguments were invalid. |

JSON mode always prints the complete report, including sorted issue codes, and
uses exit code `1` when `ok` is false.

## Library

```js
import {
  assertWornpageConsumer,
  inspectWornpageConsumer,
  WornpageConsumerCheckError,
} from '@webmcp-conformance/wornpage-consumer-check';

const report = await inspectWornpageConsumer({ root: './app' });
if (!report.ok) console.error(report.issues);

await assertWornpageConsumer({ root: './app' });
```

`inspectWornpageConsumer` always returns a deterministic report.
`assertWornpageConsumer` returns that report or throws
`WornpageConsumerCheckError` carrying the same `report` and `issues`.

## Development

```sh
npm test
npm run check
```

Tests materialize isolated consumers from deterministic fixtures, including
valid delivery, mutable pins, lock drift, invalid integrity, deep and undeclared
imports, unused dependencies, nested revisions, missing installed entries, and
active compatibility wrappers, plus CLI exit behavior.
