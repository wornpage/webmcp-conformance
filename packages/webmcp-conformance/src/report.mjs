import { classifyAuthority } from './authority.mjs';
import { assertValidCatalogManifest } from './manifest.mjs';

/** @param {unknown[]} manifests */
export function buildCatalogReport(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) throw new TypeError('At least one catalog manifest is required.');
  manifests.forEach(assertValidCatalogManifest);
  const rows = manifests.flatMap((manifest) => manifest.pages.flatMap((page) => page.tools.map((tool) => {
    const classification = classifyAuthority(tool.descriptor);
    return {
      catalog: manifest.id,
      page: page.path,
      tool: tool.descriptor.name,
      title: tool.descriptor.title,
      declaredEffect: tool.declaredEffect,
      authority: classification.authority,
      idempotent: classification.idempotent,
      openWorld: classification.canReachOpenWorld,
      destructive: classification.canDestroy,
      untrustedContent: classification.untrustedContent,
      requiredInputs: Array.isArray(tool.descriptor.inputSchema.required) ? [...tool.descriptor.inputSchema.required] : [],
      knownGaps: tool.knownGaps ? tool.knownGaps.map((gap) => ({ ...gap })) : [],
    };
  }))).sort(compareRows);

  return {
    summary: {
      catalogs: manifests.length,
      pages: manifests.reduce((total, manifest) => total + manifest.pages.length, 0),
      tools: rows.length,
      knownGaps: rows.reduce((total, row) => total + row.knownGaps.length, 0),
      byAuthority: countBy(rows, 'authority'),
      byDeclaredEffect: countBy(rows, 'declaredEffect'),
    },
    rows,
  };
}

/** @param {ReturnType<typeof buildCatalogReport>} report */
export function formatCatalogMarkdown(report) {
  const lines = [
    '| Catalog | Page | Tool | Declared effect | Authority ceiling | Idempotent | Gaps |',
    '|---|---|---|---|---|---:|---:|',
  ];
  for (const row of report.rows) {
    lines.push(`| ${cell(row.catalog)} | ${cell(row.page)} | ${cell(row.tool)} | ${cell(row.declaredEffect)} | ${cell(row.authority)} | ${row.idempotent === null ? 'n/a' : row.idempotent} | ${row.knownGaps.length} |`);
  }
  lines.push('', `${report.summary.catalogs} catalogs · ${report.summary.pages} pages · ${report.summary.tools} tools · ${report.summary.knownGaps} acknowledged gaps`);
  return `${lines.join('\n')}\n`;
}

function countBy(rows, key) {
  return Object.fromEntries([...new Set(rows.map((row) => row[key]))].sort().map((value) => [value, rows.filter((row) => row[key] === value).length]));
}

function compareRows(left, right) {
  return left.catalog.localeCompare(right.catalog, 'en') || left.page.localeCompare(right.page, 'en') || left.tool.localeCompare(right.tool, 'en');
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
