/*
 * app.mjs — load the application's sources the way the build does.
 *
 * `09-testing.md` §2 is prescriptive about this and the reason is worth restating where the code
 * lives: the harness reads `BUILD_ORDER` **out of `build.mjs`**, so the list of modules the tests
 * load and the list the artifact carries cannot drift. A test harness with its own copy of that list
 * passes for months after someone adds a module, because the module it forgot is simply absent and
 * nothing asserts on its absence.
 *
 * Reading `BUILD_ORDER` by *import* would run the build (it is a script, not a library), so it is
 * read as text and the array literal is parsed out. That is the one fragile thing here, and it is
 * fragile in a way that fails loudly: no match throws.
 *
 * Two loaders, because most of this application is pure and only some of it is DOM:
 *
 *   loadApp()    — the namespace, with `document` undefined. Canonical serialization, hashing, the
 *                  VCS, both interchange mappings, detection, storage's key arithmetic: all of it
 *                  runs in Node with no DOM at all, and the fact that it does is a property worth
 *                  keeping. A module that starts needing a document to *define* itself breaks here.
 *   loadShell()  — the same, plus the stub DOM and the shell's mount hosts, mounted. This is for the
 *                  wiring: which element got which class, which action is attached where.
 */

import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeDom } from './dom.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `19-boot.js` is excluded: it is the only file with load-time side effects, and it is what the
 *  end-to-end tests drive rather than something the unit harness can usefully run. */
export const BOOT_FILE = '19-boot.js';

const buildSrc = fs.readFileSync(join(ROOT, 'build.mjs'), 'utf8');
const orderBlock = /export const BUILD_ORDER = \[([\s\S]*?)\];/.exec(buildSrc);
if (!orderBlock) throw new Error('could not find BUILD_ORDER in build.mjs');
export const LOADED_FILES = [...orderBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
export const SOURCE = new Map(
  LOADED_FILES.filter((f) => fs.existsSync(join(ROOT, 'src', 'app', f))).map((f) => [
    f,
    fs.readFileSync(join(ROOT, 'src', 'app', f), 'utf8'),
  ]),
);

export function sourceOf(file) {
  const src = SOURCE.get(file);
  if (src === undefined) throw new Error(`no such source file in BUILD_ORDER: ${file}`);
  return src;
}

/** The vendored schemas, as `build.mjs` inlines them into the artifact. */
export function schemas() {
  return {
    otm: JSON.parse(fs.readFileSync(join(ROOT, 'vendor', 'otm_schema.json'), 'utf8')),
    tml: JSON.parse(fs.readFileSync(join(ROOT, 'vendor', 'tml_schema.json'), 'utf8')),
  };
}

export function vendoredExamples() {
  const dir = join(ROOT, 'vendor', 'examples');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, format: f.split('_')[0], json: JSON.parse(fs.readFileSync(join(dir, f), 'utf8')) }));
}

/**
 * Evaluate every module in `BUILD_ORDER` except the boot file, and hand back the namespace.
 *
 * The sources are cached but the *context* is not: module-level state (`notify`'s retained errors,
 * `storage.__test`'s injected faults, the shell's own state object) must not leak from one test to
 * the next, and re-evaluating the concatentation costs a few milliseconds. Sharing a context between
 * test files would make the suite's order matter, which is the property that turns a suite into a
 * thing people run one file at a time.
 */
export function loadApp() {
  const context = vm.createContext({
    console,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    document: undefined,
  });
  vm.runInContext('globalThis.globalThis = globalThis;', context);
  vm.runInContext(`globalThis.TMV_SCHEMAS = ${JSON.stringify(schemas())};`, context);
  for (const [file, src] of SOURCE) {
    vm.runInContext(src, context, { filename: `src/app/${file}` });
  }
  const TMV = context.TMV;
  if (!TMV) throw new Error('the sources did not publish a TMV namespace');
  return { TMV, context };
}

/** The id of every element the shell expects to find before it can mount. */
export const HOST_IDS = [
  'tmv-layers',
  'tmv-notifications',
  'tmv-live',
  'tmv-banners',
  'tmv-dirty',
  'tmv-dirty-text',
  'tmv-commit',
  'tmv-storage-notice',
  'tmv-storage-notice-text',
  'tmv-content',
  'tmv-tabs',
  'tmv-side-nav',
  'tmv-side-nav-items',
  'tmv-model-switcher',
  'tmv-header-actions',
  'tmv-sidenav-trigger',
  'tmv-shell',
];

/**
 * Mount the shell against a stub DOM.
 *
 * `options` selects a **state**, not a fixture. Every view defect found while this was being written
 * was in a state the seeded happy path does not reach — an empty model, a read-only file, uncommitted
 * edits, a stash, an open comparison — so the harness has to be able to put the shell into each of
 * them, or the tests only ever exercise the case that already works.
 *
 *   empty    — a model with nothing in it, and a history of one commit over it
 *   editable — `false` mounts the file read-only, with a reason
 *   dirty    — uncommitted edits in the working copy
 *   stash    — one stash held for this session
 *   compare  — a comparison open between two divergent heads
 *   stored   — the model is also written to the adapter, so the switcher has an entry
 */
export function loadShell(options) {
  const opts = options || {};
  const { TMV, context } = loadApp();
  const dom = makeDom();

  // `document` is injected *after* the modules are evaluated, which is deliberate: it proves no
  // module needs a document to define itself, and the shell receives one only when it mounts.
  context.document = dom;
  context.navigator = {};
  for (const id of HOST_IDS) {
    const node = dom.createElement('div');
    node.setAttribute('id', id);
    dom.body.appendChild(node);
  }

  const model = opts.empty
    ? TMV.model.createEmpty('Untitled model', FIXTURE_MODEL_ID)
    : seed(TMV.model);
  const history = TMV.vcs.initHistory(model, { name: 'Tester', email: 't@example.com' }, 'Initial');
  const adapter = TMV.storage.createAdapter({ backend: 'memory' }).adapter;

  // Stored *before* the mount: the switcher's current entry is decided at mount time, so a save
  // afterwards leaves the shell believing the file is what is open — which is the state in which
  // Settings' Danger Zone reports there is nothing to delete.
  if (opts.stored) {
    const saved = TMV.storage.saveModel(adapter, history, {
      modelId: model.modelId,
      model,
      name: model.name,
    });
    if (!saved || saved.ok === false) {
      throw new Error(`harness could not store the model: ${JSON.stringify(saved)}`);
    }
  }

  TMV.shell.mount({
    adapter,
    container: { model, history },
    embedded: opts.embedded === undefined ? { model, history } : opts.embedded,
    model,
    history,
    editable: opts.editable !== false,
    readOnlyReason: opts.editable === false ? 'This file was opened without a writable history.' : null,
    source: opts.stored ? 'stored' : 'file',
  });

  if (opts.stash || opts.compare) {
    const base = history.head;
    const branch = {
      keyframeInterval: history.keyframeInterval,
      head: base,
      commits: TMV.core.deepCopy(history.commits),
    };
    const theirs = TMV.core.deepCopy(model);
    TMV.model.insert(theirs, 'threat', { id: 'threat-theirs', name: 'Their work' });
    const commit = TMV.vcs.commit(branch, theirs, { name: 'Grace', email: 'g@example.com' }, 'Their work');
    for (const [id, c] of Object.entries(branch.commits)) history.commits[id] = c;

    if (opts.stash) {
      const aside = TMV.core.deepCopy(model);
      TMV.model.insert(aside, 'control', { id: 'ctrl-aside', name: 'Held aside', status: 'planned' });
      TMV.shell.state().stash = TMV.vcs.createStash(history, aside, { reason: 'Reconcile with the file' });
    }
    if (opts.compare) {
      TMV.shell.state().compare = {
        aHead: history.head,
        bHead: commit.commit.id,
        aName: 'This browser',
        aRole: 'local',
        bName: 'The file',
        bRole: 'embedded',
      };
    }
  }

  if (opts.dirty) {
    const working = TMV.core.deepCopy(TMV.shell.state().model);
    TMV.model.insert(working, 'assumption', { id: 'asm-uncommitted', name: 'Not committed yet' });
    TMV.shell.edit(working, { label: 'Uncommitted change' });
  }

  TMV.shell.refresh();

  return { dom, ctx: context, TMV, shell: TMV.shell, core: TMV.core, M: TMV.model, model, history, adapter };
}

export const FIXTURE_MODEL_ID = '11111111-2222-4333-8444-555555555555';

/**
 * A model with one of most things in it, plus the specific shapes the derived findings need:
 *
 * - `ctrl-1` is `scheduled`, one of the statuses that say a control is not in effect.
 * - `ctrl-2` is `active`, so "Unapplied" has something it must *not* report.
 * - `threat-2` is applied to a target and has no control, so Coverage Gaps has a row.
 * - `flow-bad` ends at an id nothing holds, so Unresolved References has a row.
 * - one data set is regulated and placed unencrypted, and one is regulated and unplaced, so the Data
 *   tab's sensitivity finding has both of its kinds.
 * - `asset-unrated` states no CIA ratings, and `threat-unplaced` is applied to nothing.
 */
export function seed(M) {
  const m = M.createEmpty('Payments Platform', FIXTURE_MODEL_ID);
  m.description = 'Card payments and settlement.';
  m.scope = Object.assign(Object.create(null), {
    title: 'Payments Platform',
    description: 'Everything between the cardholder and the acquirer.',
    businessCriticality: 'high',
    dataSensitivity: ['pci', 'pii'],
    exposure: 'external',
    tier: 'mission_critical',
  });
  m.metadata = Object.assign(Object.create(null), {
    owner: 'Payments Team',
    ownerContact: 'payments@example.com',
    tags: ['payments', 'tier-1'],
    version: '2.1',
    contributors: [{ name: 'Ada Lovelace', email: 'ada@example.com', role: 'author' }],
  });

  M.insert(m, 'trustZone', { id: 'zone-internet', name: 'Internet', type: 'untrusted', trustRating: 0 });
  M.insert(m, 'trustZone', { id: 'zone-dmz', name: 'DMZ', type: 'dmz', trustRating: 50 });
  M.insert(m, 'trustZone', { id: 'zone-core', name: 'Core', type: 'trusted' });
  M.insert(m, 'trustBoundary', {
    id: 'tb-1',
    name: 'Edge',
    zoneAId: 'zone-internet',
    zoneBId: 'zone-dmz',
    accessControlMethods: ['acl'],
    authenticationMethods: ['token'],
    accessTokenExpires: true,
    accessTokenTtl: 3600,
    hasRefreshToken: false,
    canUserLogout: true,
  });
  M.insert(m, 'component', {
    id: 'comp-gw',
    name: 'API Gateway',
    type: 'process',
    trustZoneId: 'zone-dmz',
    repoLink: 'https://example.com/repo',
  });
  M.insert(m, 'component', { id: 'comp-db', name: 'Card Store', type: 'datastore', trustZoneId: 'zone-dmz' });
  M.insert(m, 'actor', { id: 'actor-user', name: 'Cardholder', type: 'user', trustZoneId: 'zone-internet' });
  M.insert(m, 'dataStore', {
    id: 'ds-cards',
    name: 'Cards',
    type: 'sql',
    trustZoneId: 'zone-dmz',
    vendor: 'Acme',
    product: 'DB',
  });
  M.insert(m, 'dataSet', {
    id: 'set-pan',
    name: 'PANs',
    dataSensitivity: ['pci'],
    placements: [{ dataStoreId: 'ds-cards', encrypted: true }],
    recordCount: 1000,
  });
  M.insert(m, 'dataSet', {
    id: 'set-phi',
    name: 'Clinical notes',
    dataSensitivity: ['phi'],
    placements: [{ dataStoreId: 'ds-cards', encrypted: false }],
    recordCount: 50,
  });
  M.insert(m, 'dataSet', { id: 'set-cred', name: 'Credentials', dataSensitivity: ['cred'], recordCount: 5 });
  M.insert(m, 'dataSet', {
    id: 'set-biz',
    name: 'Usage metrics',
    dataSensitivity: ['biz'],
    placements: [{ dataStoreId: 'ds-cards', encrypted: true }],
    recordCount: 900,
  });
  M.insert(m, 'asset', {
    id: 'asset-pan',
    name: 'PAN database',
    confidentiality: 90,
    integrity: 80,
    availability: 70,
    processedByIds: ['comp-gw'],
    storedByIds: ['comp-db'],
  });
  M.insert(m, 'asset', { id: 'asset-unrated', name: 'Settlement ledger', description: 'No CIA ratings stated.' });
  M.insert(m, 'dataFlow', {
    id: 'flow-1',
    name: 'Authorise',
    sourceId: 'actor-user',
    destinationId: 'comp-gw',
    sourceType: 'actor',
    destinationType: 'component',
    bidirectional: false,
    encrypted: false,
    hasSensitiveData: true,
    assetIds: ['asset-pan'],
  });
  M.insert(m, 'dataFlow', {
    id: 'flow-2',
    name: 'Store PAN',
    sourceId: 'comp-gw',
    destinationId: 'comp-db',
    sourceType: 'component',
    destinationType: 'component',
    encrypted: true,
    assetIds: ['asset-pan'],
  });
  M.insert(m, 'threatPersona', {
    id: 'persona-1',
    name: 'Organised crime',
    isPerson: false,
    skillLevel: 'expert_engineer',
    accessLevel: 'anonymous',
    maliciousIntent: true,
    applicabilityToOrg: 'high',
  });
  M.insert(m, 'threatPersona', {
    id: 'persona-2',
    name: 'Careless insider',
    isPerson: true,
    skillLevel: 'insider',
    accessLevel: 'user',
    maliciousIntent: false,
    applicabilityToOrg: 'moderate',
  });
  M.insert(m, 'threat', {
    id: 'threat-1',
    name: 'SQL injection',
    description: 'Injection through the gateway.',
    personaId: 'persona-1',
    event: 'Attacker injects SQL',
    sources: ['adversary'],
    cwes: ['CWE-89'],
    likelihood: 60,
    impact: 80,
  });
  M.insert(m, 'threat', {
    id: 'threat-2',
    name: 'Credential stuffing',
    description: 'Reused passwords tried against the login flow.',
    personaId: 'persona-1',
    event: 'Credentials are replayed',
    sources: ['adversary', 'human_error'],
    likelihood: 70,
    impact: 50,
  });
  M.insert(m, 'threat', {
    id: 'threat-unplaced',
    name: 'Disk failure',
    description: 'Applied to nothing.',
    personaId: 'persona-2',
    sources: ['failure'],
  });
  M.insert(m, 'threatApplication', {
    id: 'ta-1',
    threatId: 'threat-1',
    targetType: 'component',
    targetId: 'comp-gw',
    state: 'exposed',
    controlStates: [
      { controlId: 'ctrl-1', state: 'planned' },
      { controlId: 'ctrl-2', state: 'implemented' },
    ],
  });
  M.insert(m, 'threatApplication', {
    id: 'ta-2',
    threatId: 'threat-2',
    targetType: 'dataFlow',
    targetId: 'flow-1',
    state: 'exposed',
  });
  M.insert(m, 'control', {
    id: 'ctrl-1',
    name: 'Parameterised queries',
    threatIds: ['threat-1'],
    status: 'scheduled',
    priority: 'high',
    riskReduction: 60,
    trustBoundary: { zoneAId: 'zone-internet', zoneBId: 'zone-dmz' },
  });
  M.insert(m, 'control', {
    id: 'ctrl-2',
    name: 'Input validation',
    threatIds: ['threat-1'],
    status: 'active',
    priority: 'medium',
    riskReduction: 40,
  });
  M.insert(m, 'risk', { id: 'risk-1', name: 'Card data exposure', threatIds: ['threat-1'], likelihood: 'likely', impact: 'major' });
  M.insert(m, 'risk', { id: 'risk-2', name: 'Account takeover', threatIds: ['threat-2'], likelihood: 'possible', impact: 'moderate' });
  M.insert(m, 'mitigationPlan', { id: 'mp-1', name: 'Roll out ORM', riskId: 'risk-1', controlIds: ['ctrl-1'] });
  M.insert(m, 'mitigationPlan', { id: 'mp-2', name: 'Rate-limit the login', riskId: 'risk-2' });
  M.insert(m, 'assumption', { id: 'asm-1', name: 'TLS is terminated at the edge', validity: 'confirmed', topics: ['network'] });
  M.insert(m, 'assumption', {
    id: 'asm-2',
    name: 'Staff do not reuse passwords',
    validity: 'unconfirmed',
    topics: ['people', 'authentication'],
  });
  M.insert(m, 'diagram', { id: 'dia-1', name: 'Context', type: 'mermaid', source: 'graph TD; a-->b;' });
  M.insert(m, 'representation', { id: 'rep-1', name: 'Default', type: 'canvas', width: 800, height: 600 });
  M.insert(m, 'representationElement', {
    id: 're-1',
    representationId: 'rep-1',
    ownerId: 'comp-gw',
    ownerType: 'component',
    position: { x: 10, y: 20 },
    size: { width: 100, height: 50 },
  });
  // A dangling reference, so the unresolved paths get exercised.
  M.insert(m, 'dataFlow', {
    id: 'flow-bad',
    name: 'Orphan',
    sourceId: 'comp-gw',
    destinationId: 'comp-missing',
    sourceType: 'component',
    destinationType: 'component',
  });
  return m;
}

/** Render a node's tree as indented text, for reading what a section actually produced. */
export function walk(node, depth = 0) {
  if (!node || depth > 14) return '';
  if (node.nodeType === 3) return String(node.data || '').replace(/\s+/g, ' ').trim();
  const tag = (node.tagName || '').toLowerCase();
  const cls = node.getAttribute ? node.getAttribute('class') : null;
  const act = node.getAttribute && node.getAttribute('data-action');
  const hidden = node.getAttribute && node.hasAttribute('hidden') ? '[hidden]' : '';
  const kids = (node.childNodes || []).map((c) => walk(c, depth + 1)).filter(Boolean).join(' ');
  const head = `<${tag}${cls ? `.${String(cls).split(' ').filter(Boolean).slice(0, 2).join('.')}` : ''}${
    act ? `:${act}` : ''
  }${hidden}>`;
  return `\n${'  '.repeat(depth)}${head} ${kids}`;
}
