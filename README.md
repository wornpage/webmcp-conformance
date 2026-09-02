# WebMCP conformance workspace

Framework-neutral conformance tools and fixtures for page-owned WebMCP catalogs.

| Package | Responsibility |
|---|---|
| [`webmcp-conformance`](packages/webmcp-conformance/README.md) | Descriptor validation, authority ceilings, manifest and receipt contracts, lifecycle fixtures, and catalog reports |
| [`webmcp-discovery-host`](packages/webmcp-discovery-host/README.md) | Fail-closed prototype for the current draft's in-page discovery and execution APIs |
| [`wornpage-consumer-check`](packages/wornpage-consumer-check/README.md) | Independent Wornpage package-delivery checks for consumer applications |

The packages are intentionally independent. Descriptor conformance does not
need a UI framework, and component-delivery checks do not participate in tool
authority classification.

## Validation

```powershell
npm test
npm run check
```

The checked-in fixtures snapshot Afterlist and the Projects WebMCP extension;
neither source application is modified by this workspace.

The executable source-fixture tests expect `afterlist` and
`projects-webmcp-extension` beside this repository by default. Set
`AFTERLIST_ROOT` or `PROJECTS_WEBMCP_EXTENSION_ROOT` to use another checkout.
Each checkout's current Git revision must exactly match its manifest.
The complete checkout must also be clean; tracked, staged, and untracked changes
all fail source binding before contract modules are imported.
