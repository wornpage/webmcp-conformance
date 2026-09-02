import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  runExecutableCatalogFixture,
  runRegistrationLifecycleFixture,
} from '../src/index.mjs';

const execFileAsync = promisify(execFile);
const afterlistRoot = path.resolve(process.env.AFTERLIST_ROOT ?? fileURLToPath(new URL('../../../../afterlist/', import.meta.url)));
const projectsRoot = path.resolve(process.env.PROJECTS_WEBMCP_EXTENSION_ROOT ?? fileURLToPath(new URL('../../../../projects-webmcp-extension/', import.meta.url)));
const afterlistContract = await importLocal(afterlistRoot, 'src/lib/afterlist-webmcp.mjs');
const afterlistRegistration = await importLocal(afterlistRoot, 'src/lib/webmcp.mjs');
const projectsWork = await importLocal(projectsRoot, 'svelte-frontend/src/routes/work/work-webmcp.mjs');
const projectsReview = await importLocal(projectsRoot, 'svelte-frontend/src/routes/review/review-webmcp.mjs');
const projectsNext = await importLocal(projectsRoot, 'svelte-frontend/src/routes/next/next-webmcp.mjs');
const projectsPriority = await importLocal(projectsRoot, 'svelte-frontend/src/routes/priority/priority-webmcp.mjs');
const projectsGuide = await importLocal(projectsRoot, 'svelte-frontend/src/routes/webmcp-challenge/webmcp-challenge-webmcp.mjs');
const projectsRegistration = await importLocal(projectsRoot, 'svelte-frontend/src/lib/webmcp.mjs');
const {
  createCurrentAfterlistTool,
  createShowAfterlistViewTool,
} = afterlistContract;
const { registerPageTools: registerAfterlistTools } = afterlistRegistration;
const {
  createCurrentWorkTool,
  createShowWorkSearchTool,
  createWorkDraftsTool,
} = projectsWork;
const {
  createCurrentReviewTool,
  createSetReviewScopeTool,
} = projectsReview;
const {
  NEXT_PREPARATION_RECEIPT_ID,
  NEXT_PREPARATION_SUMMARY,
  createCurrentNextEditorTool,
  createPrepareNextActionTool,
  verifiedNextEvidenceNote,
} = projectsNext;
const { createPriorityRecommendationTool } = projectsPriority;
const { createWebMcpChallengeGuideTool } = projectsGuide;
const { registerPageTools: registerProjectsTools } = projectsRegistration;

const loadManifest = async (name) => JSON.parse(await readFile(new URL(`../../../fixtures/${name}.json`, import.meta.url), 'utf8'));

test('source fixtures are bound to the checked-out Git revisions', async () => {
  const [afterlist, projects] = await Promise.all([loadManifest('afterlist'), loadManifest('projects-extension')]);
  const [afterlistRevision, projectsRevision] = await Promise.all([gitRevision(afterlistRoot), gitRevision(projectsRoot)]);
  assert.equal(afterlistRevision, afterlist.source.revision, 'Afterlist HEAD does not match its manifest revision.');
  assert.equal(projectsRevision, projects.source.revision, 'Projects extension HEAD does not match its manifest revision.');
});

test('Afterlist executable fixture matches source, projects receipts, and rejects undeclared presenter fields', async () => {
  const manifest = await loadManifest('afterlist');
  const projectedView = {
    view: 'inbox',
    counts: { sources: 2, tracks: 5, triaged: 3, untriaged: 2, destinations: 1, needsReview: 1 },
  };
  const sourceView = { ...projectedView, rawImport: 'AFTERLIST_PRIVATE_SENTINEL', notes: ['AFTERLIST_PRIVATE_SENTINEL'] };
  const report = await runExecutableCatalogFixture(manifest, {
    tools: {
      get_current_afterlist: {
        tool: createCurrentAfterlistTool(() => sourceView),
        cases: [
          {
            name: 'current-view',
            input: {},
            expect: 'success',
            assert: (result) => {
              assert.deepEqual(result, projectedView);
              assert.doesNotMatch(JSON.stringify(result), /AFTERLIST_PRIVATE_SENTINEL/u);
            },
          },
          { name: 'bounded-input', input: { secret: true }, expect: 'error' },
        ],
      },
      show_afterlist_view: {
        tool: createShowAfterlistViewTool(async (shownView) => ({
          view: shownView,
          changed: true,
          focus: { target: 'view-heading', focused: true, focusVisible: true, inViewport: true, pulsed: true, hidden: 'not projected' },
          hidden: 'not projected',
        })),
        cases: [
          { name: 'visible-view', input: { view: 'tracks' }, expect: 'success' },
          { name: 'unsupported-view', input: { view: 'admin' }, expect: 'error' },
        ],
      },
    },
  });
  assert.equal(report.cases, 4);
});

test('Projects executable fixture matches all nine source descriptors and their receipt allowlists', async () => {
  const manifest = await loadManifest('projects-extension');
  const emptyWork = { ...workView(''), privateWorkspaceSentinel: 'PROJECTS_PRIVATE_SENTINEL' };
  const emptyReview = reviewView();
  const currentNext = nextView('Continue research', null);
  const tools = {
    get_projects_handoff_guide: {
      tool: createWebMcpChallengeGuideTool(() => guideView()),
      cases: [{ name: 'guide', input: {}, expect: 'success' }],
    },
    get_current_work_view: {
      tool: createCurrentWorkTool(() => emptyWork),
      cases: [{
        name: 'work',
        input: {},
        expect: 'success',
        assert: (result) => assert.doesNotMatch(JSON.stringify(result), /PROJECTS_PRIVATE_SENTINEL/u),
      }],
    },
    show_work_search: {
      tool: createShowWorkSearchTool(async (query) => ({
        changed: true,
        query,
        focus: pageFocus('search', null),
        work: workView(query),
      })),
      cases: [{ name: 'search', input: { query: 'alpha' }, expect: 'success' }],
    },
    create_work_drafts: {
      tool: createWorkDraftsTool(async ({ expectedWorkspaceCount, drafts }) => ({
        created: drafts.map((draft, index) => ({ id: `draft-${index + 1}`, title: draft.title, status: 'draft' })),
        workspaceBefore: expectedWorkspaceCount,
        workspaceAfter: expectedWorkspaceCount + drafts.length,
        workspaceChanged: true,
        requiresHumanStart: true,
        focus: activityFocus('work-webmcp-activity'),
      })),
      cases: [{ name: 'draft', input: { expectedWorkspaceCount: 0, drafts: [{ title: 'Fixture draft' }] }, expect: 'success' }],
    },
    get_current_review_queue: {
      tool: createCurrentReviewTool(() => emptyReview),
      cases: [{ name: 'review', input: {}, expect: 'success' }],
    },
    set_review_scope: {
      tool: createSetReviewScopeTool(async ({ query, filter }) => ({
        changed: true,
        focus: pageFocus('queue', null),
        review: reviewView(query, filter),
      })),
      cases: [{ name: 'scope', input: { query: '', filter: 'all' }, expect: 'success' }],
    },
    get_current_next_editor: {
      tool: createCurrentNextEditorTool(() => currentNext),
      cases: [{ name: 'next', input: {}, expect: 'success' }],
    },
    prepare_next_action: {
      tool: createPrepareNextActionTool(async ({ choice, evidence }) => {
        const verifiedEvidence = evidence.map((fact) => ({
          work: { id: fact.workId, title: 'Fixture work' },
          field: fact.field,
          label: fact.field === 'workflow' ? 'Workflow' : 'Blocker',
          value: fact.expectedValue,
        }));
        return {
          changed: true,
          focus: activityFocus(NEXT_PREPARATION_RECEIPT_ID),
          next: nextView(choice, {
            summary: NEXT_PREPARATION_SUMMARY,
            work: { id: 'work-1', title: 'Fixture work' },
            evidenceNote: verifiedNextEvidenceNote(verifiedEvidence),
            evidence: verifiedEvidence,
            preparedAction: choice,
            workspaceChanged: false,
            requiresHumanSave: true,
          }),
        };
      }),
      cases: [{
        name: 'prepare',
        input: {
          choice: 'Continue research',
          expectedMode: 'preset',
          expectedChoice: 'Continue research',
          evidence: [{ workId: 'work-1', field: 'workflow', expectedValue: 'Research' }],
        },
        expect: 'success',
      }],
    },
    get_next_recommendation: {
      tool: createPriorityRecommendationTool(() => ({ id: 'work-1', title: 'Fixture work', href: '/next?pack=work-1', reason: 'Fixture reason' })),
      cases: [{ name: 'priority', input: {}, expect: 'success' }],
    },
  };
  const report = await runExecutableCatalogFixture(manifest, { tools });
  assert.equal(report.cases, 9);
});

test('both source registration helpers satisfy the declared lifecycle matrix', async () => {
  const [afterlist, projects] = await Promise.all([loadManifest('afterlist'), loadManifest('projects-extension')]);
  const afterlistReport = await runRegistrationLifecycleFixture(registerAfterlistTools, afterlist.lifecycle);
  const projectsReport = await runRegistrationLifecycleFixture(registerProjectsTools, projects.lifecycle);
  assert.equal(afterlistReport.checks, 5);
  assert.equal(projectsReport.checks, 5);
});

function workView(query) {
  return {
    scope: {
      search: query,
      appliedSearch: query,
      status: 'all',
      energy: 'all',
      area: 'all',
      recurrence: 'all',
      owner: 'all',
      dueUrgency: 'all',
      sort: 'urgency',
      hideDone: false,
      focusMode: false,
      density: 'grid',
    },
    counts: { workspace: 0, matching: 0, shown: 0, remaining: 0, blocked: 0 },
    recommendation: null,
    items: [],
  };
}

function reviewView(query = '', filter = 'all') {
  return {
    scope: { query, filter },
    availableFilters: ['all', 'blocked', 'missing-next', 'owner-gap'],
    counts: { totalReview: 0, searchMatches: 0, filtered: 0, shown: 0, remaining: 0, blocked: 0, missingNext: 0, missingOwner: 0 },
    upNext: null,
    items: [],
  };
}

function nextView(choice, preparationReceipt) {
  return {
    work: { id: 'work-1', title: 'Fixture work' },
    decisionContext: null,
    presetChoices: ['Continue research'],
    editor: { mode: 'preset', choice },
    preview: { blocker: null, nextAction: choice },
    preparationReceipt,
    canSave: true,
    busy: false,
    staleReason: null,
  };
}

function pageFocus(target, itemId) {
  return { target, itemId, focused: true, focusVisible: true, inViewport: true, pulsed: true };
}

function activityFocus(id) {
  return { id, focused: true, focusVisible: true, inViewport: true, pulsed: true };
}

function guideView() {
  return {
    title: 'Projects handoff',
    purpose: 'Use bounded page tools.',
    steps: [
      { position: 1, title: 'Work', description: 'Read Work.', href: '/work' },
      { position: 2, title: 'Review', description: 'Read Review.', href: '/review' },
      { position: 3, title: 'Next', description: 'Prepare Next.', href: '/next' },
    ],
    safety: ['No hidden writes.', 'No external fetches.', 'Human controls remain visible.'],
    agentBrief: '',
    workQuery: '',
    workScope: {
      workspaceCount: 0,
      visibleCount: 0,
      discoveredChoiceCount: 0,
      shownChoiceCount: 0,
      omittedChoiceCount: 0,
      choices: [
        { id: 'all', kind: 'all', label: 'All visible work', query: '', matchingCount: 0 },
        { id: 'custom', kind: 'custom', label: 'Custom', query: null, matchingCount: null },
      ],
      selected: { id: 'all', kind: 'all', label: 'All visible work', query: '', matchingCount: 0 },
    },
  };
}

function importLocal(root, relativePath) {
  return import(pathToFileURL(path.join(root, ...relativePath.split('/'))).href);
}

async function gitRevision(root) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return stdout.trim();
}
