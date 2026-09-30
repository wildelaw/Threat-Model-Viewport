/*
 * sync.test.mjs — the reconcile: which history wins when a file meets a store.
 *
 * `04-versioning.md` §6 is the flow these tests hold to, and the whole point of it is that a file is
 * a carrier rather than a copy (ADR-0001): storage may be absent, cleared, or partitioned per file
 * path, and an open still has to reach a correct answer from the file alone.
 *
 * The reconcile is written as a *verdict* — `storage.reconcile(embedded, local)` decides, and boot
 * acts on the decision — so most of these tests drive the real open path rather than the decision
 * function in isolation: a vm context with a document and a fake `localStorage` that stands in for
 * one origin. That is the only way to observe the two properties the requirements are really about,
 * neither of which a pure function shows on its own:
 *
 *   - the comparison happens before the UI is interactive (REQ-SYNC-001 AC1), and
 *   - the side that wins is the side that is on screen, and in the store, afterwards.
 *
 * Ordering is ancestry, never a timestamp (ADR-0003), so nothing here asserts that a later
 * `timestamp` wins. The clocks in these fixtures exist only to make commit ids differ.
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';

import { specTest } from '../lib/check.mjs';
import { loadApp, loadShell, sourceOf, FIXTURE_MODEL_ID } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { storage: S, model: M, vcs, core, container: C } = TMV;

const ALICE = { name: 'Alice', email: 'alice@example.com' };
const EARLIER = '2019-01-01T00:00:00.000Z';
const NOW = '2020-06-01T00:00:00.000Z';
const LATER = '2020-06-02T00:00:00.000Z';

function model(name, id) {
  return M.createEmpty(name, id);
}

/** A one-commit history over `m`, with a fixed clock so every id is reproducible. */
function root(m, id, tag, when) {
  return vcs.initHistory(m, ALICE, tag || 'root', {
    timestamp: when || NOW,
    keyframeInterval: TMV.DEFAULT_KEYFRAME_INTERVAL,
  });
}

/** Commit one more threat onto `history` — the smallest edit that moves the head. */
function addThreat(history, base, threatId, name, message, when) {
  const next = core.deepCopy(base);
  M.insert(next, 'threat', { id: threatId, name });
  const result = vcs.commit(history, next, ALICE, message, { timestamp: when || LATER });
  if (!result.ok) throw new Error('fixture commit failed: ' + result.message);
  return next;
}

/**
 * A `localStorage` stand-in for one origin, backed by a plain map so a test can also read exactly
 * what was written. This is the "injected origin" the environment note in the harness describes:
 * Firefox's per-path partitioning cannot be observed from Node, so it is simulated by giving two
 * contexts two different stores.
 */
function fakeStore(contents) {
  const data = Object.assign(Object.create(null), contents || {});
  return {
    _data: data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    key: (i) => Object.keys(data)[i] || null,
    get length() { return Object.keys(data).length; },
  };
}

/**
 * A fresh browser: the harness's shell mounted against a stub DOM, then unmounted so boot can mount
 * it as it really does, with a `localStorage` this test controls and a `location` that decides the
 * storage context. Timers are stubbed out so a toast stays on screen to be asserted on rather than
 * auto-dismissing five seconds after the test ends.
 */
function browser(options) {
  const opts = options || {};
  const env = loadShell({});
  env.shell.unmount();
  const { ctx } = env;
  ctx.navigator = opts.userAgent ? { userAgent: opts.userAgent } : {};
  ctx.location = { protocol: opts.protocol || 'https:' };
  ctx.setTimeout = () => 0;
  ctx.clearTimeout = () => {};
  if (opts.throwingStorage) {
    // The private-mode shape: a localStorage object that throws on the first write probe.
    ctx.localStorage = {
      getItem: () => null,
      setItem() { throw new Error('storage disabled'); },
      removeItem() {},
      key: () => null,
      length: 0,
    };
  } else if (opts.localStorage === null) {
    delete ctx.localStorage;
  } else {
    env.localStorage = fakeStore(opts.localStorage);
    ctx.localStorage = env.localStorage;
  }
  return env;
}

/** Write a history into the origin's store, the way an earlier session would have left it. */
function seedStore(env, history, m, modelId) {
  const id = modelId || history.commits[history.commits.length - 1].modelId;
  const staging = S.createAdapter({ backend: 'memory' }).adapter;
  const saved = S.saveModel(staging, history, { modelId: id, model: m, name: m && m.name });
  if (!saved.ok) throw new Error('could not seed the origin: ' + JSON.stringify(saved));
  for (const key of staging.keys()) env.localStorage._data[key] = staging.read(key);
}

/** An adapter over whatever this origin's store now holds. */
function localStore(env) {
  return env.TMV.storage.createAdapter({ backend: 'local' }).adapter;
}

/** Every key and value this origin's store holds for one model, for "nothing was written" claims. */
function snapshotStore(env, modelId) {
  const prefix = S.modelPrefix(modelId);
  const data = env.localStorage._data;
  return Object.keys(data)
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((k) => k + '=' + data[k]);
}

/** Put a container in the page's data block and run boot — the real open path, not a decision call. */
function openFile(env, containerValue) {
  const { dom, ctx, TMV: t } = env;
  let node = dom.body.querySelector('[id="' + C.BLOCK_ID + '"]');
  if (!node) {
    node = dom.createElement('script');
    node.setAttribute('id', C.BLOCK_ID);
    node.setAttribute('type', 'application/json');
    dom.body.appendChild(node);
  }
  node.textContent = C.serialize(containerValue);
  vm.runInContext(sourceOf('19-boot.js'), ctx, { filename: 'src/app/19-boot.js' });
  return t.shell.state();
}

// ---------------------------------------------------------------------------------------------

specTest('sync.reconcile-on-open', () => {
  // REQ-SYNC-001. The acceptance criterion is about *when* the comparison happens, so the assertion
  // is the order of the two things boot does: reconcile, then mount. Wrapping them is what makes the
  // ordering observable; asserting the verdict afterwards is what stops the ordering alone from
  // being vacuous, because a mount with the wrong history would satisfy "reconcile ran first".
  const env = browser({});
  const t = env.TMV;
  const base = model('Base', FIXTURE_MODEL_ID);
  const fileHistory = root(base, FIXTURE_MODEL_ID, 'file-root');

  // The store holds a history for the *same* modelId and it is ahead of the file, so a comparison
  // that failed to look up local history would have nothing to compare against.
  const localHistory = core.deepCopy(fileHistory);
  const localModel = addThreat(localHistory, base, 'threat-local', 'Local work', 'local commit');
  seedStore(env, localHistory, localModel);

  const order = [];
  let seen = null;
  const realReconcile = t.storage.reconcile;
  t.storage.reconcile = (embedded, loc) => {
    order.push('reconcile');
    seen = { embedded, loc };
    return realReconcile(embedded, loc);
  };
  const realMount = t.shell.mount;
  t.shell.mount = (opts) => {
    order.push('mount');
    return realMount(opts);
  };

  const state = openFile(env, C.makeContainer(base, fileHistory, { appHash: null }));

  same(order, ['reconcile', 'mount'], 'the comparison runs on every open, before anything is interactive');
  assert.ok(seen, 'the reconcile was called with the two histories');
  assert.equal(seen.embedded.history.head, fileHistory.head, 'the history the file carries');
  assert.equal(seen.loc.ok, true, 'against the history stored for the same modelId');
  assert.equal(seen.loc.history.head, localHistory.head);
  assert.equal(seen.loc.history.commits[0].modelId, FIXTURE_MODEL_ID, 'the lookup is by the file’s modelId');

  // And the verdict is what ended up on screen — the comparison decided, it did not merely run.
  assert.equal(state.mounted, true);
  assert.equal(state.reconcile.verdict, S.LOCAL_AHEAD);
  assert.equal(state.history.head, localHistory.head);
});

specTest('sync.embedded-ahead-adopts', () => {
  // REQ-SYNC-002. Two acceptance criteria: the local head equals the embedded head after adoption,
  // and the notification names the number of commits adopted. The second is subtler than it looks —
  // the count is what this open *added*, not the size of the history it arrived with — so the fixture
  // gives the file one commit on top of a shared root and asserts "1", not "2".
  const env = browser({});
  const base = model('Base', FIXTURE_MODEL_ID);
  const localHistory = root(base, FIXTURE_MODEL_ID, 'local-root');
  const fileHistory = core.deepCopy(localHistory);
  const fileModel = addThreat(fileHistory, base, 'threat-file', 'File work', 'file commit');
  seedStore(env, localHistory, base);

  const state = openFile(env, C.makeContainer(fileModel, fileHistory, { appHash: null }));

  assert.equal(state.reconcile.verdict, S.EMBEDDED_AHEAD);
  assert.equal(state.reconcile.adopt, true);
  assert.equal(state.reconcile.adopted, 1, 'the commits this open added, not the size of the file history');
  assert.equal(state.history.head, fileHistory.head, 'the file’s head is what is on screen');

  const stored = S.loadModel(localStore(env), FIXTURE_MODEL_ID);
  assert.equal(stored.ok, true, 'the adopted history was recorded locally, not only shown');
  assert.equal(stored.history.head, fileHistory.head, 'so the local head equals the embedded head');
  assert.equal(stored.history.commits.length, fileHistory.commits.length);

  const toast = env.dom.body.querySelector('.tmv-toast');
  assert.ok(toast, 'a notification says what happened');
  assert.match(toast.textContent, /Adopted 1 commit from the file/, 'and names the number of commits adopted');
});

specTest('sync.local-ahead-wins', () => {
  // REQ-SYNC-003 AC1: the displayed model reflects local history, not the file's. Asserting the whole
  // model against the local head is what makes this more than "a threat is present": it would catch a
  // mount that took the file's model and then found the local id in it.
  const env = browser({});
  const base = model('Base', FIXTURE_MODEL_ID);
  const fileHistory = root(base, FIXTURE_MODEL_ID, 'file-root');
  const localHistory = core.deepCopy(fileHistory);
  const localModel = addThreat(localHistory, base, 'threat-local', 'Local work', 'local commit');
  seedStore(env, localHistory, localModel);

  const state = openFile(env, C.makeContainer(base, fileHistory, { appHash: null }));

  assert.equal(state.reconcile.verdict, S.LOCAL_AHEAD);
  assert.equal(state.reconcile.adopt, false, 'the store is not behind, so nothing is adopted over it');
  assert.equal(state.source, 'stored', 'the session is working from the store');
  assert.equal(state.history.head, localHistory.head);
  same(state.model, vcs.headModel(localHistory), 'the model on screen is the local head, not the file’s');
  assert.ok(M.get(state.model, 'threats', 'threat-local'), 'the local work is in it');
});

specTest('sync.local-ahead-offer-export', () => {
  // REQ-SYNC-003 AC2 and AC3. AC2 asks for a persistent, dismissible banner offering the export, so
  // all three words are asserted: a banner (not a toast), a dismiss control, and the named action.
  // AC3 is the one with a trap in it — dismissing must not discard the local history — so the local
  // head is re-read from the store after the dismiss rather than trusted to have survived.
  const env = browser({});
  const base = model('Base', FIXTURE_MODEL_ID);
  const fileHistory = root(base, FIXTURE_MODEL_ID, 'file-root');
  const localHistory = core.deepCopy(fileHistory);
  const localModel = addThreat(localHistory, base, 'threat-local', 'Local work', 'local commit');
  seedStore(env, localHistory, localModel);

  openFile(env, C.makeContainer(base, fileHistory, { appHash: null }));

  const banner = env.dom.body.querySelector('.tmv-banner');
  assert.ok(banner, 'the offer is a banner, so it stays until it is dismissed');
  assert.equal(banner.hasAttribute('hidden'), false);
  assert.match(banner.textContent, /ahead of the copy embedded in the file/);

  const exportButton = [...banner.querySelectorAll('[data-action="notify-action"]')]
    .find((b) => b.getAttribute('data-value') === 'export-updated');
  assert.ok(exportButton, 'the banner offers the export');
  assert.equal(exportButton.textContent, 'Export updated file');

  const dismiss = banner.querySelector('[data-action="dismiss-notification"]');
  assert.ok(dismiss, 'and it is dismissible');
  dismiss.click();

  assert.equal(env.dom.body.querySelector('.tmv-banner'), null, 'the banner is gone');
  const stored = S.loadModel(localStore(env), FIXTURE_MODEL_ID);
  assert.equal(stored.ok, true, 'the local history is still there after the dismiss');
  assert.equal(stored.history.head, localHistory.head, 'and it is the same head, not the file’s');
});

specTest('sync.identical-silent', () => {
  // REQ-SYNC-004. "No prompt, banner, or notification" is asserted as the absence of every surface,
  // and the second half of the acceptance criterion — opening an unchanged file twice — is run for
  // real, because a first open that quietly wrote something would make the second open speak.
  const env = browser({});
  const base = model('Base', FIXTURE_MODEL_ID);
  const history = root(base, FIXTURE_MODEL_ID, 'shared-root');
  seedStore(env, history, base);

  const first = openFile(env, C.makeContainer(base, history, { appHash: null }));
  assert.equal(first.reconcile.verdict, S.IDENTICAL);
  assert.equal(first.reconcile.adopt, false);
  assert.equal(env.TMV.shell.logic.reconcileNotice(first.reconcile), null, 'the reconcile has nothing to say');
  assert.equal(env.dom.body.querySelectorAll('.tmv-banner').length, 0, 'no banner');
  assert.equal(env.dom.body.querySelectorAll('.tmv-toast').length, 0, 'and no toast');

  const second = openFile(env, C.makeContainer(base, history, { appHash: null }));
  assert.equal(second.reconcile.verdict, S.IDENTICAL, 'the first open left the store exactly where it was');
  assert.equal(env.dom.body.querySelectorAll('.tmv-banner').length, 0, 'so the second open is silent too');
  assert.equal(env.dom.body.querySelectorAll('.tmv-toast').length, 0);
});

specTest('sync.divergence-routes-to-compare', () => {
  // REQ-SYNC-005. The acceptance criterion is "reaches the compare view without writing to storage",
  // and the second half is the one worth testing: an implementation that resolved the divergence by
  // writing would still show a compare view. So the store's keys and values for the model are
  // snapshotted around the open, and the mounted history is checked to contain *both* heads — the
  // compare screen walks one history, and a mount carrying only one side would report the other
  // missing.
  const env = browser({});
  const base = model('Base', FIXTURE_MODEL_ID);
  const common = root(base, FIXTURE_MODEL_ID, 'common-root');
  const localHistory = core.deepCopy(common);
  const localModel = addThreat(localHistory, base, 'threat-local', 'Mine', 'local commit', LATER);
  const fileHistory = core.deepCopy(common);
  const fileModel = addThreat(fileHistory, base, 'threat-file', 'Theirs', 'file commit', '2020-06-03T00:00:00.000Z');
  seedStore(env, localHistory, localModel);

  const beforeKeys = Object.keys(env.localStorage._data).sort();
  const beforeModel = snapshotStore(env, FIXTURE_MODEL_ID);

  const state = openFile(env, C.makeContainer(fileModel, fileHistory, { appHash: null }));

  assert.equal(state.reconcile.verdict, S.DIVERGED);
  assert.equal(state.reconcile.adopt, false, 'divergence adopts nothing, which is why nothing is written');
  assert.ok(state.compare, 'the reconcile routes to the compare view');
  same(
    { aHead: state.compare.aHead, bHead: state.compare.bHead, aRole: state.compare.aRole, bRole: state.compare.bRole },
    {
      aHead: fileHistory.head,
      bHead: localHistory.head,
      aRole: 'The history in the file you opened',
      bRole: 'The history stored in this browser',
    },
    'both heads are carried, each labelled with the side it came from',
  );
  assert.equal(state.activeTab, 'history', 'the session opens on the compare section');
  assert.equal(state.activeSection, 'compare');
  assert.ok(vcs.commitById(state.history, fileHistory.head), 'the file’s head is findable in the mounted history');
  assert.ok(vcs.commitById(state.history, localHistory.head), 'and so is the stored head');

  same(Object.keys(env.localStorage._data).sort(), beforeKeys, 'the reconcile wrote no new key');
  same(snapshotStore(env, FIXTURE_MODEL_ID), beforeModel, 'and left the stored history byte-for-byte as it was');
});

specTest('sync.unrelated-not-merged', () => {
  // REQ-SYNC-006 has two triggers and both are exercised, because they take different paths through
  // boot. An unknown modelId is "no local history" to the reconcile; two histories under the *same*
  // modelId that share no ancestor is `unrelated`. Neither may merge, and the proof of "did not
  // merge" is that the existing model's stored keys are unchanged.
  //
  // (a) A modelId the store has never seen appears as a new registry entry beside the old one.
  const env = browser({});
  const existing = model('Existing', 'model-existing');
  const existingHistory = root(existing, 'model-existing', 'existing-root');
  seedStore(env, existingHistory, existing, 'model-existing');
  const existingBefore = snapshotStore(env, 'model-existing');

  const newcomer = model('Newcomer', FIXTURE_MODEL_ID);
  const newcomerHistory = root(newcomer, FIXTURE_MODEL_ID, 'newcomer-root');
  const state = openFile(env, C.makeContainer(newcomer, newcomerHistory, { appHash: null }));

  assert.equal(state.reconcile.verdict, S.NO_LOCAL, 'the id is unknown locally, so there is nothing to merge with');
  assert.equal(state.model.name, 'Newcomer');
  same(
    S.listModels(localStore(env)).map((e) => e.modelId).sort(),
    [FIXTURE_MODEL_ID, 'model-existing'],
    'both models are registered, side by side',
  );
  same(snapshotStore(env, 'model-existing'), existingBefore, 'and the existing model’s history is untouched');

  // (b) The same modelId, two lineages with no commit in common. The verdict is `unrelated`, and what
  // is mounted is the file's history alone — not a union, and with no merge commit added to either.
  const other = browser({});
  const mine = model('Mine', FIXTURE_MODEL_ID);
  const mineHistory = root(mine, FIXTURE_MODEL_ID, 'my-root', NOW);
  seedStore(other, mineHistory, mine);
  const mineBefore = snapshotStore(other, FIXTURE_MODEL_ID);

  const theirs = model('Theirs', FIXTURE_MODEL_ID);
  const theirsHistory = root(theirs, FIXTURE_MODEL_ID, 'their-root', EARLIER);
  const unrelated = openFile(other, C.makeContainer(theirs, theirsHistory, { appHash: null }));

  assert.equal(unrelated.reconcile.verdict, S.UNRELATED);
  assert.equal(unrelated.reconcile.certain, true);
  assert.equal(unrelated.reconcile.adopt, false, 'an unrelated file is never adopted over local work');
  assert.equal(unrelated.history.head, theirsHistory.head, 'the file’s history alone is on screen');
  assert.equal(unrelated.history.commits.length, theirsHistory.commits.length, 'so no merge commit was created');
  assert.equal(unrelated.model.name, 'Theirs');
  same(snapshotStore(other, FIXTURE_MODEL_ID), mineBefore, 'and the stored lineage was not modified');
});

specTest('sync.origin-independent', () => {
  // REQ-SYNC-007. Correctness must not depend on two files sharing an origin, and the acceptance
  // criterion is the cleared-storage case: opening the file there must land where the intact origin
  // already is. That is only true if the open *records* what it adopted, so the assertion is the end
  // state — after the open with storage cleared, a fresh reconcile of the same file is identical.
  const base = model('Base', FIXTURE_MODEL_ID);
  const history = root(base, FIXTURE_MODEL_ID, 'shared-root');

  // Two origins holding the same local history reach the same decision for the same file.
  const originA = browser({});
  const originB = browser({});
  seedStore(originA, history, base);
  seedStore(originB, history, base);
  const a = openFile(originA, C.makeContainer(base, history, { appHash: null }));
  const b = openFile(originB, C.makeContainer(base, history, { appHash: null }));
  assert.equal(a.reconcile.verdict, S.IDENTICAL);
  assert.equal(b.reconcile.verdict, a.reconcile.verdict, 'which origin holds the history changes nothing');
  assert.equal(b.history.head, a.history.head);

  // Storage cleared: the file alone carries everything, so the outcome is the same state the intact
  // origin was already in, not an error and not a lost model.
  const cleared = browser({});
  const c = openFile(cleared, C.makeContainer(base, history, { appHash: null }));
  assert.equal(c.reconcile.verdict, S.NO_LOCAL, 'an empty store is a state the flow handles');
  assert.equal(c.reconcile.adopt, true);
  assert.equal(c.history.head, history.head, 'the file’s history is what is shown');
  const restored = S.loadModel(localStore(cleared), FIXTURE_MODEL_ID);
  assert.equal(restored.ok, true, 'and the open recorded it, so the store is no longer behind');
  assert.equal(restored.history.head, history.head);
  assert.equal(
    S.reconcile({ history }, restored).verdict,
    S.IDENTICAL,
    'a second reconcile is identical, which is the state the intact origin was already in',
  );

  // Storage unavailable is the same story: a memory fallback, no crash, and the file still wins.
  const blocked = browser({ throwingStorage: true });
  const d = openFile(blocked, C.makeContainer(base, history, { appHash: null }));
  assert.equal(d.reconcile.verdict, S.NO_LOCAL);
  assert.equal(d.reconcile.adopt, true);
  assert.equal(d.history.head, history.head);
  assert.equal(d.storage.context, S.UNAVAILABLE, 'and the session knows there is nowhere to remember it');
});

specTest('sync.partition-detected', () => {
  // REQ-SYNC-008. "Genuinely no local history" and "this browser gives every file its own storage"
  // look identical from inside the app, so the detection is asserted from both sides: the signal that
  // produces the explanation, and the signals that must not. The explanation is required to name the
  // behaviour and offer the file-based path, so both parts of the sentence are matched, and the offer
  // is checked in the UI rather than in the prose — that is where a user meets it (AC2).
  const partitioned = S.detectStorageContext({
    protocol: 'file:',
    isFirefox: true,
    registryEmpty: true,
    fileHasHistory: true,
  });
  assert.equal(partitioned.context, S.FILE_ORIGIN_PARTITIONED);
  assert.equal(partitioned.certain, false, 'an empty registry on a first run looks the same, and the result says so');
  assert.match(partitioned.message, /Firefox/, 'the explanation names the browser behaviour');
  assert.match(partitioned.message, /separate storage area for each local file path/);
  assert.match(partitioned.message, /exporting a new copy is the reliable way/, 'and offers the file-based path');

  // The distinctions. A readable store holding other models is simply a new model, not partitioning;
  // a file with no history of its own cannot have failed to find one; a web origin is neither; and
  // storage that cannot be read at all is its own state, with its own explanation.
  assert.equal(
    S.detectStorageContext({ protocol: 'file:', isFirefox: true, registryEmpty: false, fileHasHistory: true }).context,
    S.FILE_ORIGIN,
    'other models present means the registry is readable, so nothing is partitioned',
  );
  assert.equal(
    S.detectStorageContext({ protocol: 'file:', isFirefox: true, registryEmpty: true, fileHasHistory: false }).context,
    S.FILE_ORIGIN,
    'a file with no history has nothing the store could have failed to find',
  );
  assert.equal(
    S.detectStorageContext({ protocol: 'https:', isFirefox: true, registryEmpty: true, fileHasHistory: true }).context,
    S.WEB_ORIGIN,
    'partitioning is a file:// behaviour, not a browser one',
  );
  assert.equal(S.detectStorageContext({ available: false }).context, S.UNAVAILABLE);

  // AC2: the workaround is an action, not only a sentence.
  const { dom, shell } = loadShell({});
  shell.reportStorage(partitioned);
  const banner = dom.body.querySelector('.tmv-banner');
  assert.ok(banner, 'the explanation reaches the screen');
  assert.match(banner.textContent, /Firefox does this/, 'and carries the part of the sentence that names the browser');
  const action = banner.querySelector('[data-action="notify-action"]');
  assert.ok(action, 'and it offers a way forward');
  assert.equal(action.getAttribute('data-value'), 'export-now', 'the file-based path');
});
