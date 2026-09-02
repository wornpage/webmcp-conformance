import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildCatalogReport,
  formatCatalogMarkdown,
  validateCatalogManifest,
} from '../src/index.mjs';

const fixturePaths = [
  new URL('../../../fixtures/afterlist.json', import.meta.url),
  new URL('../../../fixtures/projects-extension.json', import.meta.url),
];

const loadFixtures = async () => Promise.all(fixturePaths.map(async (url) => JSON.parse(await readFile(url, 'utf8'))));

test('both application manifests validate as independent snapshots', async () => {
  const fixtures = await loadFixtures();
  assert.deepEqual(fixtures.map((fixture) => validateCatalogManifest(fixture)), [
    { valid: true, issues: [] },
    { valid: true, issues: [] },
  ]);
});

test('manifest validation catches duplicate tools, authority drift, and undeclared receipt fields', async () => {
  const [fixture] = await loadFixtures();
  const changed = structuredClone(fixture);
  changed.pages[0].tools.push(structuredClone(changed.pages[0].tools[0]));
  changed.pages[0].tools[0].expectedAuthority = 'closed-world-change';
  changed.pages[0].tools[0].receiptAllowlist.focusFields = ['focused'];
  const codes = validateCatalogManifest(changed).issues.map(({ code }) => code);
  assert.ok(codes.includes('tool.duplicate'));
  assert.ok(codes.includes('tool.authority_mismatch'));
  assert.ok(codes.includes('receipt.focus_parent'));
});

test('manifest v2 rejects v1 and cross-checks executable evidence against receipts', async () => {
  const [afterlist, projects] = await loadFixtures();
  const legacy = structuredClone(afterlist);
  legacy.version = 1;
  assert.ok(validateCatalogManifest(legacy).issues.some(({ code }) => code === 'manifest.version'));

  const mismatchedFocus = structuredClone(afterlist);
  mismatchedFocus.pages[0].tools[1].evidence.focusTruePaths = ['focus.focused'];
  assert.ok(validateCatalogManifest(mismatchedFocus).issues.some(({ code }) => code === 'evidence.focus_proof'));

  const outsideReceipt = structuredClone(afterlist);
  outsideReceipt.pages[0].tools[0].evidence.denominatorPaths = ['hidden.total'];
  assert.ok(validateCatalogManifest(outsideReceipt).issues.some(({ code }) => code === 'evidence.receipt_root'));

  const missingHumanGate = structuredClone(projects);
  const drafts = missingHumanGate.pages.flatMap(({ tools }) => tools).find(({ descriptor }) => descriptor.name === 'create_work_drafts');
  drafts.evidence.humanGateTruePaths = [];
  assert.ok(validateCatalogManifest(missingHumanGate).issues.some(({ code }) => code === 'evidence.human_gate'));

  const substitutedHumanGate = structuredClone(projects);
  const substitutedDrafts = substitutedHumanGate.pages.flatMap(({ tools }) => tools).find(({ descriptor }) => descriptor.name === 'create_work_drafts');
  substitutedDrafts.evidence.humanGateTruePaths = ['focus.focused'];
  const substitutedCodes = validateCatalogManifest(substitutedHumanGate).issues.map(({ code }) => code);
  assert.ok(substitutedCodes.includes('evidence.human_gate_path'));
  assert.ok(substitutedCodes.includes('evidence.overlap'));

  const focuslessPresentation = structuredClone(afterlist);
  const presenter = focuslessPresentation.pages[0].tools[1];
  presenter.evidence.focusTruePaths = [];
  presenter.receiptAllowlist.resultFields = presenter.receiptAllowlist.resultFields.filter((field) => field !== 'focus');
  presenter.receiptAllowlist.focusFields = [];
  assert.ok(validateCatalogManifest(focuslessPresentation).issues.some(({ code }) => code === 'evidence.focus_proof'));
});

test('catalog reporting is deterministic and preserves declared effects', async () => {
  const report = buildCatalogReport(await loadFixtures());
  assert.deepEqual(report.summary, {
    catalogs: 2,
    pages: 6,
    tools: 11,
    knownGaps: 0,
    byAuthority: { 'closed-world-change': 5, 'read-only': 6 },
    byDeclaredEffect: { 'local-draft': 2, presentation: 3, reader: 6 },
  });
  assert.deepEqual(report.rows.map(({ tool }) => tool), [...report.rows.map(({ tool }) => tool)].sort((left, right) => {
    const leftRow = report.rows.find((row) => row.tool === left);
    const rightRow = report.rows.find((row) => row.tool === right);
    return leftRow.catalog.localeCompare(rightRow.catalog, 'en') || leftRow.page.localeCompare(rightRow.page, 'en') || left.localeCompare(right, 'en');
  }));
  const markdown = formatCatalogMarkdown(report);
  assert.match(markdown, /create_work_drafts \| local-draft \| closed-world-change/u);
  assert.match(markdown, /2 catalogs · 6 pages · 11 tools/u);
});
