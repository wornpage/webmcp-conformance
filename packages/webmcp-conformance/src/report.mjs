import { assertValidCatalogManifest } from './manifest.mjs';

/** @param {unknown[]} manifests */
export function buildCatalogReport(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) throw new TypeError('At least one catalog manifest is required.');
  manifests.forEach(assertValidCatalogManifest);
  const rows = manifests.flatMap((manifest) => manifest.pages.flatMap((page) => page.tools.map((tool) => {
    const declarations = tool.projectPolicy.nonstandardAnnotations;
    return {
      catalog: manifest.id,
      page: page.path,
      tool: tool.descriptor.name,
      title: tool.descriptor.title,
      discoveryClassification: tool.discoveryClassification,
      projectPolicyCeiling: tool.projectPolicy.ceiling,
      projectPolicyEffect: tool.projectPolicy.effect,
      projectPolicyInputSchemaProfile: tool.projectPolicy.inputSchemaProfile,
      projectPolicyIdempotent: typeof declarations.idempotentHint === 'boolean' ? declarations.idempotentHint : null,
      projectPolicyOpenWorld: declarations.openWorldHint === true,
      projectPolicyDestructive: declarations.destructiveHint === true,
      declaredUntrustedContent: tool.descriptor.annotations?.untrustedContentHint === true,
      requiredInputs: Array.isArray(tool.descriptor.inputSchema?.required) ? [...tool.descriptor.inputSchema.required] : [],
      knownGaps: tool.projectPolicy.knownGaps ? tool.projectPolicy.knownGaps.map((gap) => ({ ...gap })) : [],
    };
  }))).sort(compareRows);

  return {
    summary: {
      catalogs: manifests.length,
      pages: manifests.reduce((total, manifest) => total + manifest.pages.length, 0),
      tools: rows.length,
      knownGaps: rows.reduce((total, row) => total + row.knownGaps.length, 0),
      byDiscoveryClassification: countBy(rows, 'discoveryClassification'),
      byProjectPolicyCeiling: countBy(rows, 'projectPolicyCeiling'),
      byProjectPolicyEffect: countBy(rows, 'projectPolicyEffect'),
      byProjectPolicyInputSchemaProfile: countBy(rows, 'projectPolicyInputSchemaProfile'),
    },
    rows,
  };
}

/** @param {ReturnType<typeof buildCatalogReport>} report */
export function formatCatalogMarkdown(report) {
  const lines = [
    '| Catalog | Page | Tool | Discovery classification | Project-policy effect | Input-schema profile | Project-policy ceiling | Gaps |',
    '|---|---|---|---|---|---|---|---:|',
  ];
  for (const row of report.rows) {
    lines.push(`| ${cell(row.catalog)} | ${cell(row.page)} | ${cell(row.tool)} | ${cell(row.discoveryClassification)} | ${cell(row.projectPolicyEffect)} | ${cell(row.projectPolicyInputSchemaProfile)} | ${cell(row.projectPolicyCeiling)} | ${row.knownGaps.length} |`);
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
