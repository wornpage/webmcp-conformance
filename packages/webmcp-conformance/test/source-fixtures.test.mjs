import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertExactGitSourceCheckout,
  runExecutableCatalogFixture,
  runRegistrationLifecycleFixture,
} from '../src/index.mjs';

const afterlistRoot = path.resolve(process.env.AFTERLIST_ROOT ?? fileURLToPath(new URL('../../../../afterlist/', import.meta.url)));
const projectsRoot = path.resolve(process.env.PROJECTS_WEBMCP_EXTENSION_ROOT ?? fileURLToPath(new URL('../../../../projects-webmcp-extension/', import.meta.url)));

const loadManifest = async (name) => JSON.parse(await readFile(new URL(`../../../fixtures/${name}.json`, import.meta.url), 'utf8'));
const sourceContextPromise = loadSourceContext();

test('source fixtures are bound to the checked-out Git revisions', async () => {
  const context = await sourceContextPromise;
  assert.equal(context.afterlistBinding.clean, true);
  assert.equal(context.projectsBinding.clean, true);
});

test('Afterlist executable fixture matches source, projects receipts, and rejects undeclared presenter fields', async () => {
  const { afterlistManifest: manifest, afterlistContract } = await sourceContextPromise;
  const { createCurrentAfterlistTool, createShowAfterlistViewTool } = afterlistContract;
  const projectedView = {
    view: 'inbox',
    counts: { sources: 2, tracks: 5, triaged: 3, untriaged: 2, destinations: 1, needsReview: 1 },
  };
  const sourceView = { ...projectedView, rawImport: 'AFTERLIST_PRIVATE_SENTINEL', notes: ['AFTERLIST_PRIVATE_SENTINEL'] };
  const ownerCalls = { current: 0, show: 0 };
  const report = await runExecutableCatalogFixture(manifest, {
    tools: {
      get_current_afterlist: {
        tool: createCurrentAfterlistTool(() => {
          ownerCalls.current += 1;
          return sourceView;
        }),
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
          {
            name: 'bounded-input',
            input: { secret: true },
            expect: 'error',
            expectedError: { name: 'TypeError', message: 'Current Afterlist accepts only an empty object.' },
            assertAfterError: ownerUncalled(ownerCalls, 'current'),
          },
        ],
      },
      show_afterlist_view: {
        tool: createShowAfterlistViewTool(async (shownView) => {
          ownerCalls.show += 1;
          return {
            view: shownView,
            changed: true,
            focus: { target: 'view-heading', focused: true, focusVisible: true, inViewport: true, pulsed: true, hidden: 'not projected' },
            hidden: 'not projected',
          };
        }),
        cases: [
          { name: 'visible-view', input: { view: 'tracks' }, expect: 'success' },
          {
            name: 'unsupported-view',
            input: { view: 'admin' },
            expect: 'error',
            expectedError: { name: 'TypeError', message: 'Afterlist view is invalid.' },
            assertAfterError: ownerUncalled(ownerCalls, 'show'),
          },
        ],
      },
    },
  });
  assert.equal(report.cases, 4);
  assert.deepEqual(ownerCalls, { current: 1, show: 1 });
});

test('Projects executable fixture matches all nine source descriptors and their receipt allowlists', async () => {
  const {
    projectsManifest: manifest,
    projectsWork,
    projectsReview,
    projectsNext,
    projectsPriority,
    projectsGuide,
  } = await sourceContextPromise;
  const { createCurrentWorkTool, createShowWorkSearchTool, createWorkDraftsTool } = projectsWork;
  const { createCurrentReviewTool, createSetReviewScopeTool } = projectsReview;
  const {
    NEXT_PREPARATION_RECEIPT_ID,
    NEXT_PREPARATION_SUMMARY,
    createCurrentNextEditorTool,
    createPrepareNextActionTool,
    verifiedNextEvidenceNote,
  } = projectsNext;
  const { createPriorityRecommendationTool } = projectsPriority;
  const { createWebMcpChallengeGuideTool } = projectsGuide;
  const emptyWork = { ...workView(''), privateWorkspaceSentinel: 'PROJECTS_PRIVATE_SENTINEL' };
  const emptyReview = reviewView();
  const currentNext = nextView('Continue research', null);
  const ownerCalls = {
    guide: 0,
    currentWork: 0,
    search: 0,
    drafts: 0,
    currentReview: 0,
    reviewScope: 0,
    currentNext: 0,
    prepare: 0,
    priority: 0,
  };
  const tools = {
    get_projects_handoff_guide: {
      tool: createWebMcpChallengeGuideTool(() => {
        ownerCalls.guide += 1;
        return guideView();
      }),
      cases: [
        { name: 'guide', input: {}, expect: 'success' },
        {
          name: 'bounded-input',
          input: { unexpected: true },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Projects handoff guide accepts only an empty object.' },
          assertAfterError: ownerUncalled(ownerCalls, 'guide'),
        },
      ],
    },
    get_current_work_view: {
      tool: createCurrentWorkTool(() => {
        ownerCalls.currentWork += 1;
        return emptyWork;
      }),
      cases: [
        {
          name: 'work',
          input: {},
          expect: 'success',
          assert: (result) => assert.doesNotMatch(JSON.stringify(result), /PROJECTS_PRIVATE_SENTINEL/u),
        },
        {
          name: 'bounded-input',
          input: { unexpected: true },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Work current view requires an empty object.' },
          assertAfterError: ownerUncalled(ownerCalls, 'currentWork'),
        },
      ],
    },
    show_work_search: {
      tool: createShowWorkSearchTool(async (query) => {
        ownerCalls.search += 1;
        return { changed: true, query, focus: pageFocus('search', null), work: workView(query) };
      }),
      cases: [
        { name: 'search', input: { query: 'alpha' }, expect: 'success' },
        {
          name: 'bounded-input',
          input: { query: 'alpha', unexpected: true },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Work search accepts only query.' },
          assertAfterError: ownerUncalled(ownerCalls, 'search'),
        },
      ],
    },
    create_work_drafts: {
      tool: createWorkDraftsTool(async ({ expectedWorkspaceCount, drafts }) => {
        ownerCalls.drafts += 1;
        return {
          created: drafts.map((draft, index) => ({ id: `draft-${index + 1}`, title: draft.title, status: 'draft' })),
          workspaceBefore: expectedWorkspaceCount,
          workspaceAfter: expectedWorkspaceCount + drafts.length,
          workspaceChanged: true,
          requiresHumanStart: true,
          focus: activityFocus('work-webmcp-activity'),
        };
      }),
      cases: [
        { name: 'draft', input: { expectedWorkspaceCount: 0, drafts: [{ title: 'Fixture draft' }] }, expect: 'success' },
        {
          name: 'bounded-input',
          input: { expectedWorkspaceCount: 0, drafts: [] },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Work draft preparation requires one to 3 drafts.' },
          assertAfterError: ownerUncalled(ownerCalls, 'drafts'),
        },
      ],
    },
    get_current_review_queue: {
      tool: createCurrentReviewTool(() => {
        ownerCalls.currentReview += 1;
        return emptyReview;
      }),
      cases: [
        { name: 'review', input: {}, expect: 'success' },
        {
          name: 'bounded-input',
          input: { unexpected: true },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Review current queue requires an empty object.' },
          assertAfterError: ownerUncalled(ownerCalls, 'currentReview'),
        },
      ],
    },
    set_review_scope: {
      tool: createSetReviewScopeTool(async ({ query, filter }) => {
        ownerCalls.reviewScope += 1;
        return { changed: true, focus: pageFocus('queue', null), review: reviewView(query, filter) };
      }),
      cases: [
        { name: 'scope', input: { query: '', filter: 'all' }, expect: 'success' },
        {
          name: 'bounded-input',
          input: { query: '', filter: 'unknown' },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Review filter must be all, blocked, missing-next, or owner-gap.' },
          assertAfterError: ownerUncalled(ownerCalls, 'reviewScope'),
        },
      ],
    },
    get_current_next_editor: {
      tool: createCurrentNextEditorTool(() => {
        ownerCalls.currentNext += 1;
        return currentNext;
      }),
      cases: [
        { name: 'next', input: {}, expect: 'success' },
        {
          name: 'bounded-input',
          input: { unexpected: true },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Next current editor requires an empty object.' },
          assertAfterError: ownerUncalled(ownerCalls, 'currentNext'),
        },
      ],
    },
    prepare_next_action: {
      tool: createPrepareNextActionTool(async ({ choice, evidence }) => {
        ownerCalls.prepare += 1;
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
      cases: [
        {
          name: 'prepare',
          input: {
            choice: 'Continue research',
            expectedMode: 'preset',
            expectedChoice: 'Continue research',
            evidence: [{ workId: 'work-1', field: 'workflow', expectedValue: 'Research' }],
          },
          expect: 'success',
        },
        {
          name: 'bounded-input',
          input: { choice: 'Continue research', expectedMode: 'preset', expectedChoice: 'Continue research' },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Prepare next action requires choice, expectedMode, expectedChoice, and evidence.' },
          assertAfterError: ownerUncalled(ownerCalls, 'prepare'),
        },
      ],
    },
    get_next_recommendation: {
      tool: createPriorityRecommendationTool(() => {
        ownerCalls.priority += 1;
        return { id: 'work-1', title: 'Fixture work', href: '/next?pack=work-1', reason: 'Fixture reason' };
      }),
      cases: [
        { name: 'priority', input: {}, expect: 'success' },
        {
          name: 'bounded-input',
          input: { unexpected: true },
          expect: 'error',
          expectedError: { name: 'TypeError', message: 'Priority recommendation requires an empty object.' },
          assertAfterError: ownerUncalled(ownerCalls, 'priority'),
        },
      ],
    },
  };
  const report = await runExecutableCatalogFixture(manifest, { tools });
  assert.equal(report.cases, 18);
  assert.deepEqual(ownerCalls, {
    guide: 1,
    currentWork: 1,
    search: 1,
    drafts: 1,
    currentReview: 1,
    reviewScope: 1,
    currentNext: 1,
    prepare: 1,
    priority: 1,
  });
});

test('both source registration helpers satisfy the declared lifecycle matrix', async () => {
  const context = await sourceContextPromise;
  const afterlistReport = await runRegistrationLifecycleFixture(context.afterlistRegistration.registerPageTools, context.afterlistManifest.lifecycle);
  const projectsReport = await runRegistrationLifecycleFixture(context.projectsRegistration.registerPageTools, context.projectsManifest.lifecycle);
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

function ownerUncalled(calls, key) {
  return () => assert.equal(calls[key], 0, `${key} owner ran for rejected input`);
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

async function loadSourceContext() {
  const [afterlistManifest, projectsManifest] = await Promise.all([loadManifest('afterlist'), loadManifest('projects-extension')]);
  const [afterlistBinding, projectsBinding] = await Promise.all([
    assertExactGitSourceCheckout({ root: afterlistRoot, revision: afterlistManifest.source.revision, label: 'Afterlist source' }),
    assertExactGitSourceCheckout({ root: projectsRoot, revision: projectsManifest.source.revision, label: 'Projects extension source' }),
  ]);
  const [
    afterlistContract,
    afterlistRegistration,
    projectsWork,
    projectsReview,
    projectsNext,
    projectsPriority,
    projectsGuide,
    projectsRegistration,
  ] = await Promise.all([
    importLocal(afterlistRoot, 'src/lib/afterlist-webmcp.mjs'),
    importLocal(afterlistRoot, 'src/lib/webmcp.mjs'),
    importLocal(projectsRoot, 'svelte-frontend/src/routes/work/work-webmcp.mjs'),
    importLocal(projectsRoot, 'svelte-frontend/src/routes/review/review-webmcp.mjs'),
    importLocal(projectsRoot, 'svelte-frontend/src/routes/next/next-webmcp.mjs'),
    importLocal(projectsRoot, 'svelte-frontend/src/routes/priority/priority-webmcp.mjs'),
    importLocal(projectsRoot, 'svelte-frontend/src/routes/webmcp-challenge/webmcp-challenge-webmcp.mjs'),
    importLocal(projectsRoot, 'svelte-frontend/src/lib/webmcp.mjs'),
  ]);
  return {
    afterlistManifest,
    projectsManifest,
    afterlistBinding,
    projectsBinding,
    afterlistContract,
    afterlistRegistration,
    projectsWork,
    projectsReview,
    projectsNext,
    projectsPriority,
    projectsGuide,
    projectsRegistration,
  };
}
