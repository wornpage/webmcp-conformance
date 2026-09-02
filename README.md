# WebMCP conformance workspace

Framework-neutral conformance tools and fixtures for page-owned WebMCP catalogs.

| Package | Responsibility |
|---|---|
| [`webmcp-conformance`](packages/webmcp-conformance/README.md) | Descriptor validation, authority ceilings, manifest and receipt contracts, lifecycle fixtures, and catalog reports |
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
