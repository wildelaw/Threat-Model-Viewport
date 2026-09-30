/*
 * storage.test.mjs — the cache that must never become the system of record.
 *
 * ADR-0001 says the file is the carrier and storage is a cache, and every test here is some version
 * of that sentence being put under pressure. Three properties recur:
 *
 *   P1  **Every failure has a defined answer, and none of them is "fail".** Storage is absent, or
 *       partitioned, or read-only, or full, or was interrupted mid-write; the application still
 *       loads, edits and exports. Anything that throws out of a boot path is the bug this tests for.
 *   P2  **Writes are ordered blobs first, pointer last; removals the other way round.** The failure
 *       that leaves behind is an orphan (waste, collected); the failure ruled out is a head naming
 *       commits that are not there (corruption). `store.interrupted-commit` is that ordering as a
 *       case, driven by the fault-injection hook the build strips from release.
 *   P3  **Nothing destructive happens without an explicit flag.** `collect` is a dry run until
 *       `confirm === true`, and the migration removes old keys only after the new ones verify.
 *
 * The fault hook is under `TMV.storage.__test`, which exists only because `build.mjs` strips the
 * marked region — so the tests exercise the shipped code path and the shipped artifact contains
 * neither the counter nor its call site (`store.no-test-hooks-in-release`).
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadApp, loadShell, FIXTURE_MODEL_ID } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { storage: S, model: M, vcs, core } = TMV;

const ALICE = { name: 'Alice', email: 'alice@example.com' };
const NOW = '2020-06-01T00:00:00.000Z';

/** A fresh memory adapter — the backend the tests run against, which is also the one that ships. */
function memory() {
  return S.createAdapter({ backend: 'memory' }).adapter;
}

/** A model and a one-commit history over it, with a fixed clock so ids are reproducible. */
function seeded(modelId, name) {
  const model = M.createEmpty(name, modelId);
  const history = vcs.initHistory(model, ALICE, 'root', { timestamp: NOW, keyframeInterval: TMV.DEFAULT_KEYFRAME_INTERVAL });
  return { model, history, container: { model, history } };
}

/** Add one threat and commit it, so the history has a second commit to store. */
function commitThreat(history, name, id) {
  const working = core.deepCopy(vcs.headModel(history));
  M.insert(working, 'threat', { id: id, name: name });
  return vcs.commit(history, working, ALICE, 'add ' + id, { timestamp: NOW });
}

specTest('store.key-namespacing', () => {
  // REQ-STORE-002: every key is `tmv:<formatVersion>:registry`, `tmv:<formatVersion>:prefs`, or
  // `tmv:<formatVersion>:model:<modelId>:*`. The version is in every key so a future layout can find
  // the old one without knowing anything else about it.
  assert.match(S.REGISTRY_KEY, /^tmv:\d+:registry$/, 'the registry key carries the format version');
  assert.match(S.PREFS_KEY, /^tmv:\d+:prefs$/);
  assert.equal(S.PREFIX, `tmv:${TMV.STORAGE_VERSION}:`);

  const keys = S.keysFor('model-a');
  assert.equal(keys.prefix, `tmv:${TMV.STORAGE_VERSION}:model:model-a:`);
  assert.equal(keys.meta, keys.prefix + 'meta');
  for (const commitId of ['sha256:aaaa', 'sha256:bbbb']) {
    for (const build of [keys.snap, keys.delta, keys.cmeta]) {
      const key = build(commitId);
      assert.ok(key.startsWith(keys.prefix), `${key} is inside the model's namespace`);
      assert.ok(key.includes(commitId), 'and names the commit it belongs to');
    }
  }
  same(
    [keys.snap('x'), keys.delta('x'), keys.cmeta('x')].map((k) => S.parseKey(k).kind),
    ['snap', 'delta', 'cmeta'],
    'each key shape decodes to the kind it was built for',
  );

  // Every key the adapter actually holds, after a real save, matches the documented pattern. This is
  // the assertion that would catch a key built by hand somewhere else in the module.
  const adapter = memory();
  const { model, history } = seeded('model-a', 'Namespaced');
  commitThreat(history, 'A threat', 'threat-1');
  S.saveModel(adapter, history, { modelId: 'model-a', model, name: 'Namespaced' });
  const written = adapter.keys().filter((k) => k !== S.REGISTRY_KEY);
  assert.ok(written.length >= 4, 'a save writes a meta pointer and the commits behind it');
  for (const key of written) {
    assert.match(
      key,
      /^tmv:\d+:(registry|prefs|model:[A-Za-z0-9_-]+:(meta|snap:.+|delta:.+|cmeta:.+))$/,
      `${key} matches the documented key pattern`,
    );
    assert.ok(S.parseKey(key), `${key} decodes`);
  }

  // A model id reaches the module from a file anybody could have written, and it goes straight into
  // a key — so the alphabet is narrow and a hostile id is refused before any key is built from it.
  assert.equal(S.isModelId('ok-id_1'), true);
  for (const hostile of ['../evil', 'a:b', '', 'a/b', 'x'.repeat(129), null, 42]) {
    assert.equal(S.isModelId(hostile), false, `${JSON.stringify(hostile)} is not a usable model id`);
  }
  assert.equal(S.parseKey('not-ours'), null, 'a foreign key is not ours to interpret');
  assert.equal(S.parseKey('localStorage'), null, 'and neither is a key that is not even ours by prefix');
});

specTest('store.registry-seeded-every-load', () => {
  // REQ-STORE-003. The subtle half is the second assertion: "upsert from the file on every load"
  // read naively would clobber a local history that is ahead of the file's, which is REQ-SYNC-003.
  const adapter = memory();
  const { model, history, container } = seeded('model-s', 'Seeded');
  commitThreat(history, 'A threat', 'threat-1');

  // A cleared store: the file is all there is, and seeding is what repopulates the registry.
  same(S.listModels(adapter), [], 'nothing is stored to begin with');
  const first = S.seedRegistry(adapter, container, { now: NOW });
  assert.equal(first.action, 'created');
  same(S.listModels(adapter).map((e) => e.modelId), ['model-s'], 'the file alone was enough');

  // Opened again with storage unchanged: nothing to say, so nothing is written.
  assert.equal(S.seedRegistry(adapter, container, { now: NOW }).action, 'kept', 'an unchanged load is a no-op');

  // Opened again after an interval: only the presentation fields move.
  assert.equal(S.seedRegistry(adapter, container, { now: '2021-01-01T00:00:00.000Z' }).action, 'refreshed');

  // Now storage is ahead of the file. Seeding must not downgrade the index to the file's older head:
  // the registry indexes *storage*, so storage's own `meta` record wins for the head and the count.
  S.saveModel(adapter, history, { modelId: 'model-s', model, name: 'Seeded' });
  const behind = {
    model,
    history: { keyframeInterval: history.keyframeInterval, head: history.commits[0].id, commits: [history.commits[0]] },
  };
  const seeded2 = S.seedRegistry(adapter, behind, { now: '2031-01-01T00:00:00.000Z' });
  assert.equal(seeded2.action, 'refreshed');
  assert.equal(seeded2.entry.headCommitId, history.head, 'the head is storage’s, not the file’s older one');
  assert.equal(seeded2.entry.commitCount, history.commits.length, 'and so is the count');

  // A file with no usable model id, and a read-only adapter, both skip rather than throw.
  assert.equal(S.seedRegistry(memory(), { model: {}, history: { commits: [] } }, {}).action, 'skipped');
  const readOnly = S.createAdapter({ readOnly: true, backend: 'memory' }).adapter;
  const skipped = S.seedRegistry(readOnly, container, {});
  assert.equal(skipped.action, 'skipped');
  assert.ok(skipped.reason, 'and says why, because the reason is what the UI has to show');

  // A hostile model id never reaches a key.
  const hostile = { model: { modelId: '../../evil', name: 'Evil' }, history: { head: 'x', commits: [{ id: 'x' }] } };
  assert.equal(S.embeddedEntry(hostile, {}).modelId, null, 'a model id outside the alphabet is not used');
  assert.equal(S.seedRegistry(memory(), hostile, {}).action, 'skipped');
});

specTest('store.registry-name-follows-head', () => {
  // `05-storage.md` §3: a stored entry is named after the model at **storage's head**, not after
  // whichever file was opened last. This is the case that made REQ-EDIT-011 look broken on first
  // use — rename, commit, reload, and the old name is back while storage's head carries the new one
  // all along — because seeding took the name from the file on every load.
  const adapter = memory();
  const { model, history, container } = seeded('model-n', 'Original name');
  commitThreat(history, 'A threat', 'threat-1');

  // Storage is empty, so the file is all there is and its name is the entry's name. The fix must not
  // have made the file's name unusable — this is the first-run and cleared-store case, and it is the
  // whole reason seeding happens on every load (REQ-STORE-003).
  const first = S.seedRegistry(adapter, container, { now: NOW });
  assert.equal(first.action, 'created');
  assert.equal(first.entry.name, 'Original name', 'a first load names the entry after the file');
  assert.equal(S.readMeta(adapter, 'model-n'), null, 'and storage holds no record of the model yet');

  // A committed rename, written the way the commit path writes it: `saveModel` upserts the name of
  // the model at the new head.
  const renamed = core.deepCopy(vcs.headModel(history));
  renamed.name = 'Renamed after a commit';
  const renameCommit = vcs.commit(history, renamed, ALICE, 'rename', { timestamp: NOW });
  assert.equal(renameCommit.ok, true, 'the rename committed');
  S.saveModel(adapter, history, { modelId: 'model-n', model: renamed, name: renamed.name });
  assert.equal(S.listModels(adapter)[0].name, 'Renamed after a commit', 'the commit renames the stored entry');

  // Now reopen the *old* file: its embedded model still carries the old name, and its history is a
  // commit behind storage's head. The entry keeps storage's name, because that is the name the head
  // it points at holds. A name taken from the file here would describe a history the entry is not
  // pointing at.
  const stale = {
    model,
    history: { keyframeInterval: history.keyframeInterval, head: history.commits[0].id, commits: [history.commits[0]] },
  };
  const reseeded = S.seedRegistry(adapter, stale, { now: '2031-01-01T00:00:00.000Z' });
  assert.equal(reseeded.action, 'refreshed', 'the load refreshed the entry');
  assert.equal(reseeded.entry.name, 'Renamed after a commit', 'the file’s older name does not win');
  assert.equal(S.listModels(adapter)[0].name, 'Renamed after a commit', 'and that is what is written back');
  assert.equal(reseeded.entry.headCommitId, renameCommit.commit.id, 'the head is still storage’s');
  assert.notEqual(reseeded.entry.headCommitId, stale.history.head, 'and not the file’s older one');

  // A model id this browser has never seen is still seeded from its file, so the rule above is about
  // *one* id and its own stored record rather than "the file never names anything".
  const other = seeded('model-o', 'A different model');
  assert.equal(S.seedRegistry(adapter, other.container, { now: NOW }).entry.name, 'A different model');

  // The rename survives a reload the app actually performs: seeding in place, then reading back.
  const again = S.seedRegistry(adapter, stale, { now: '2032-01-01T00:00:00.000Z' });
  assert.equal(again.entry.name, 'Renamed after a commit', 'and it is stable across loads');
});

specTest('store.registry-reseed', () => {
  // The §9 case, stated from the storage side rather than the requirement's: storage is *cleared*
  // underneath the application and the next load rebuilds the index from the file alone. This is the
  // behaviour that makes Firefox's per-path partitioning survivable rather than fatal.
  const adapter = memory();
  const { model, history, container } = seeded('model-r', 'Reseeded');
  commitThreat(history, 'A threat', 'threat-1');
  S.saveModel(adapter, history, { modelId: 'model-r', model, name: 'Reseeded' });
  assert.equal(S.listModels(adapter).length, 1);

  // Clear storage the way a user would: everything with our prefix goes.
  for (const key of adapter.keys()) adapter.remove(key);
  same(adapter.keys(), [], 'the store is empty');
  same(S.listModels(adapter), [], 'and the registry with it');

  // Reopen the same file. The registry comes back from the file, not from anything stored.
  const reseeded = S.seedRegistry(adapter, container, { now: NOW });
  assert.equal(reseeded.action, 'created');
  same(S.listModels(adapter).map((e) => e.modelId), ['model-r']);

  // But the *history* is gone, and the app must not pretend otherwise: this is what "storage is a
  // cache" costs. The file's history is what is loaded, and the store is behind again.
  assert.equal(S.loadModel(adapter, 'model-r').ok, false);
  assert.equal(S.loadModel(adapter, 'model-r').reason, 'absent');
  assert.equal(S.readMeta(adapter, 'model-r'), null);
});

specTest('store.model-switch', () => {
  // REQ-STORE-004 AC2: the embedded model always appears as a switchable entry, alongside whatever
  // storage holds. Both halves are visible in the switcher, and switching to a stored one works.
  const { dom, TMV: shellTMV, shell, adapter } = loadShell({ stored: true });
  const entries = shell.state().switcherEntries;
  const fileEntry = entries.find((e) => e.kind === 'file');
  const storedEntry = entries.find((e) => e.kind === 'stored');
  assert.ok(fileEntry, 'the embedded model is offered');
  assert.ok(storedEntry, 'and so is the stored copy of the same model');
  assert.equal(fileEntry.value, shellTMV.shell.FILE_VALUE);
  assert.equal(storedEntry.value, FIXTURE_MODEL_ID);
  assert.equal(storedEntry.current, true, 'the open one is marked as current');

  // A second model in storage, then switch to it.
  const other = M.createEmpty('Second model', 'model-second');
  const otherHistory = vcs.initHistory(other, ALICE, 'root', { timestamp: NOW });
  assert.equal(S.saveModel(adapter, otherHistory, { modelId: 'model-second', model: other, name: 'Second model' }).ok, true);
  shell.reloadRegistry();
  shell.refresh();

  const target = shell.state().switcherEntries.find((e) => e.value === 'model-second');
  assert.ok(target, 'the new model is an entry');
  assert.equal(target.current, false);
  shell.switchModel(target.value);

  assert.equal(shell.currentModelId(), 'model-second', 'the switch happened');
  assert.equal(shell.state().source, 'stored', 'and it came from storage, not from the adapter’s memory');
  assert.equal(shell.state().model.name, 'Second model');
  assert.equal(
    shell.state().switcherEntries.find((e) => e.value === 'model-second').current,
    true,
    'and it is the current entry now',
  );

  // Switching to the entry already open is not a switch.
  assert.equal(shell.switchModel('model-second'), null);

  // The same switch is reachable from Settings → Storage, which is where a user who is looking for
  // the model they saved actually goes. It is the same operation rather than a second one: the button
  // carries the model id and the shell does the switching, so the dirty-working-copy guard above is
  // in front of this path too.
  shell.switchModel(FIXTURE_MODEL_ID);
  shell.go('settings', 'storage');

  const content = dom.body.querySelector('#tmv-content');
  const table = content.querySelector('table');
  assert.ok(table, 'the storage screen lists the models this browser is holding');

  const openButtons = [...table.querySelectorAll('[data-action="open-model"]')];
  assert.equal(openButtons.length, 2, 'every stored model can be opened, not only deleted');

  const mine = table.querySelector(`[data-action="open-model"][data-value="model-second"]`);
  const open = table.querySelector(`[data-action="open-model"][data-value="${FIXTURE_MODEL_ID}"]`);
  assert.ok(open.hasAttribute('disabled'), 'the copy already on screen cannot be opened again');
  assert.match(open.getAttribute('title'), /already showing/);
  assert.ok(!mine.hasAttribute('disabled'), 'and the other one can');

  // The row that is open says so in text as well, because a disabled button's tooltip is not
  // reachable by keyboard or by touch.
  const row = table.querySelectorAll('tr').find((tr) => tr.contains(open));
  assert.ok(
    [...row.querySelectorAll('.cds--tag__label')].some((tag) => /open/i.test(tag.textContent)),
    'the open model is marked in the row, not only by a disabled control',
  );

  assert.equal(mine.getAttribute('data-value'), 'model-second', 'the button names the model it opens');
  mine.click();
  assert.equal(shell.currentModelId(), 'model-second', 'clicking it opened that stored model');
  assert.equal(shell.state().source, 'stored', 'and from storage, so it is a real switch');
  assert.equal(shell.state().model.name, 'Second model');

  // A switch from this screen announces itself rather than leaving the user to notice a changed
  // heading, which is what the header's switcher does.
  const toast = dom.body.querySelector('#tmv-notifications');
  assert.ok(toast, 'a switch from the storage screen reports the outcome');
  assert.match(toast.textContent, /Second model/);
});

specTest('store.switch-guards-dirty', () => {
  // REQ-STORE-004 AC1: switching with a dirty working copy prompts to commit, stash, or discard. The
  // prompt is a real dialog with all three, and cancelling leaves the user where they were — an
  // uncommitted working copy attached to the model it was made against.
  const { dom, TMV: shellTMV, shell, adapter } = loadShell({ stored: true, dirty: true });
  const other = M.createEmpty('Second model', 'model-second');
  const otherHistory = vcs.initHistory(other, ALICE, 'root', { timestamp: NOW });
  S.saveModel(adapter, otherHistory, { modelId: 'model-second', model: other, name: 'Second model' });
  shell.reloadRegistry();
  shell.refresh();
  assert.equal(shell.isDirty(), true, 'the working copy is dirty to begin with');

  shell.switchModel('model-second');
  const modal = dom.body.querySelector('.cds--modal');
  assert.ok(modal, 'a dirty switch raises a dialog rather than switching');
  const actions = [...modal.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'));
  same(
    actions.slice().sort(),
    ['cancel', 'commit', 'discard', 'stash'],
    'all three ways out are offered, plus cancel',
  );
  assert.equal(shell.currentModelId(), FIXTURE_MODEL_ID, 'and nothing has moved yet');

  // Cancel is the boring case and the one that has to be right: the change is still there.
  modal.querySelector('[data-action="cancel"]').click();
  assert.equal(dom.body.querySelector('.cds--modal'), null, 'the dialog is gone');
  assert.equal(shell.currentModelId(), FIXTURE_MODEL_ID, 'the model did not change');
  assert.equal(shell.isDirty(), true, 'and the uncommitted change survived the refusal');
  assert.ok(
    M.get(shell.state().model, 'assumptions', 'asm-uncommitted'),
    'the working copy still holds the edit it was holding',
  );
});

specTest('store.model-delete', () => {
  // REQ-STORE-005. Deleting the open model returns the UI to the embedded data rather than to an
  // empty state, and the confirmation says the file on disk is unaffected — §7 calls that the most
  // likely misunderstanding, because the user's mental model is that the application *is* the file.
  const { dom, shell, adapter } = loadShell({ stored: true });
  assert.ok(S.readMeta(adapter, FIXTURE_MODEL_ID), 'there is a stored copy');

  shell.deleteStored();
  const modal = dom.body.querySelector('.cds--modal');
  assert.ok(modal, 'deletion is behind a confirmation');
  const text = [...modal.querySelectorAll('p')].map((p) => p.textContent).join(' ');
  assert.ok(text.includes('Payments Platform'), 'the dialog names the model');
  assert.ok(/file on disk is not deleted/.test(text), 'and states plainly that the file on disk is unaffected');

  modal.querySelector('[data-action="delete"]').click();

  // The registry entry and every namespaced key are gone; the registry key itself is not namespaced
  // by model, so it survives holding the other entries.
  same(shell.state().registry.map((e) => e.modelId), [], 'the registry entry is gone');
  same(
    adapter.keys().filter((k) => k.startsWith(S.modelPrefix(FIXTURE_MODEL_ID))),
    [],
    'and every key namespaced to the model',
  );
  assert.equal(S.readMeta(adapter, FIXTURE_MODEL_ID), null);

  // The UI returns to the embedded data.
  assert.equal(shell.state().source, 'file', 'the shell fell back to the file');
  assert.equal(shell.state().model.name, 'Payments Platform', 'which still has the model in it');
  same(
    shell.state().switcherEntries.map((e) => e.kind),
    ['file'],
    'the stored entry is gone from the switcher and the file entry remains',
  );

  // And the delete does not undo itself inside the same page load: opening the embedded data again
  // must not re-record it, or the user would watch the entry come back.
  assert.equal(S.readMeta(adapter, FIXTURE_MODEL_ID), null, 'nothing rewrote the record after the delete');
});

specTest('store.delete-scope', () => {
  // REQ-STORE-005 AC2 and §7: the operation is deliberately narrow. It removes what is in *this
  // browser*, and it removes only what belongs to the model named — a second stored model is
  // untouched, and `deleteModel` refuses an id it cannot build a key from rather than guessing.
  const adapter = memory();
  const keep = seeded('model-keep', 'Keep');
  const drop = seeded('model-drop', 'Drop');
  commitThreat(drop.history, 'A threat', 'threat-1');
  S.saveModel(adapter, keep.history, { modelId: 'model-keep', model: keep.model, name: 'Keep' });
  S.saveModel(adapter, drop.history, { modelId: 'model-drop', model: drop.model, name: 'Drop' });

  const keepKeys = adapter.keys().filter((k) => k.startsWith(S.modelPrefix('model-keep')));
  const report = S.deleteModel(adapter, 'model-drop');
  assert.equal(report.modelId, 'model-drop');
  assert.ok(report.removed > 0, 'it reports how much it removed');
  assert.ok(report.bytes > 0, 'and how many bytes that was');

  same(
    adapter.keys().filter((k) => k.startsWith(S.modelPrefix('model-keep'))),
    keepKeys,
    'the other model’s keys are exactly as they were',
  );
  assert.equal(S.loadModel(adapter, 'model-keep').ok, true, 'and it still loads');
  same(S.listModels(adapter).map((e) => e.modelId), ['model-keep'], 'only the named entry left the registry');

  // A model id that cannot be a key is refused, not normalised into one.
  assert.throws(() => S.deleteModel(adapter, '../../evil'), (err) => err.code === 'STORAGE_MODEL_ID');
  assert.throws(() => S.deleteModel(adapter, ''), (err) => err.code === 'STORAGE_MODEL_ID');

  // A read-only adapter cannot delete: the whole point of read-only is that nothing changes.
  const readOnly = S.createAdapter({ readOnly: true, backend: 'memory' }).adapter;
  assert.throws(() => S.deleteModel(readOnly, 'model-keep'), (err) => err.code === 'STORAGE_READ_ONLY');
});

specTest('store.origin-partitioned', () => {
  // The §9 case: the same file, two origins. Storage does not carry over — and the application *says
  // so*, because a user who moved a file and found their history gone needs an explanation, not an
  // empty list. The message must be presented as the likely explanation, not as a fact: an empty
  // registry on a first run looks exactly like a partitioned one.
  const originA = memory();
  const originB = memory(); // a different origin is a different store, by construction
  const { model, history, container } = seeded('model-p', 'Partitioned');
  commitThreat(history, 'A threat', 'threat-1');
  S.saveModel(originA, history, { modelId: 'model-p', model, name: 'Partitioned' });

  assert.equal(S.loadModel(originA, 'model-p').ok, true, 'the first origin knows the model');
  assert.equal(S.loadModel(originB, 'model-p').ok, false, 'the second knows nothing');
  same(S.listModels(originB), [], 'and this is exactly what a first run looks like');

  const made = S.detectStorageContext({
    protocol: 'file:',
    isFirefox: true,
    registryEmpty: true,
    fileHasHistory: true,
  });
  assert.equal(made.context, S.FILE_ORIGIN_PARTITIONED);
  assert.equal(made.certain, false, 'it is a heuristic, and it says so');
  assert.match(made.message, /separate storage area for each local file path/, 'the message names the behaviour');
  assert.match(made.message, /file path/i, 'rather than the condition');
  assert.match(made.message, /history in the file is used/, 'and points at the file-based path');

  // The app says so through the shell too, where the user actually meets it.
  const { dom, TMV: shellTMV, shell } = loadShell({});
  shell.reportStorage(shellTMV.storage.detectStorageContext({ protocol: 'file:', isFirefox: true, registryEmpty: true, fileHasHistory: true }));
  const banner = dom.body.querySelector('.tmv-banner');
  assert.ok(banner, 'a banner is raised');
  assert.match(banner.textContent, /separate storage area for each local file path/);

  // And the verdict on the same file is the same: the file's history is adopted, storage follows.
  const verdict = S.reconcile({ history }, S.loadModel(originB, 'model-p'));
  assert.equal(verdict.verdict, S.NO_LOCAL);
  assert.equal(verdict.adopt, true, 'the file wins when storage has nothing, which is the whole design');
});

specTest('store.memory-fallback', () => {
  // REQ-STORE-007 and §4: `localStorage` throwing is not "no storage" — Safari's private mode has a
  // localStorage object that throws on the first `setItem`, so the probe is a *write* probe. The
  // fallback is a memory backend with full function plus a notice the user must see.
  const { TMV: isolated, context } = loadApp();
  assert.equal(typeof context.localStorage, 'undefined', 'there is no localStorage to begin with');

  const absent = isolated.storage.createAdapter({});
  assert.equal(absent.adapter.kind, 'memory');
  assert.equal(absent.notice.code, 'STORAGE_UNAVAILABLE');
  assert.equal(absent.notice.kind, 'warning');

  // Now a localStorage that exists and throws — the private-mode shape.
  context.localStorage = {
    setItem() {
      throw new Error('QuotaExceededError: storage is disabled');
    },
    getItem() {
      return null;
    },
    removeItem() {},
    key() {
      return null;
    },
    length: 0,
  };
  const throwing = isolated.storage.createAdapter({});
  assert.equal(throwing.adapter.kind, 'memory', 'a throwing localStorage falls back rather than failing');
  assert.equal(throwing.adapter.isAvailable(), true, 'the adapter itself is fully available');
  assert.equal(throwing.adapter.writable(), true, 'and fully writable');
  assert.equal(throwing.notice.code, 'STORAGE_UNAVAILABLE');
  assert.match(throwing.notice.message, /memory only/i);
  assert.match(throwing.notice.message, /lost when this page is reloaded or closed/, 'the notice says what is lost');
  assert.match(throwing.notice.message, /Exporting writes a file you can keep/, 'and what to do about it');

  // "Full function" is the claim, so make it: a save and a load over the fallback.
  const adapter = throwing.adapter;
  const { model, history } = seeded('model-m', 'Memory');
  commitThreat(history, 'A threat', 'threat-1');
  assert.equal(S.saveModel(adapter, history, { modelId: 'model-m', model }).ok, true, 'saving works');
  const loaded = S.loadModel(adapter, 'model-m');
  assert.equal(loaded.ok, true, 'loading works');
  assert.equal(loaded.history.head, history.head, 'and it is the same history');
  same(S.listModels(adapter).map((e) => e.modelId), ['model-m'], 'and the registry works');
});

specTest('store.storage-blocked-degrades', () => {
  // REQ-STORE-007 ACs: with storage disabled the app loads, renders, edits and exports, and a
  // persistent notice explains that changes will not persist. "Loads, renders, edits and exports" is
  // four claims, so it is four assertions — and the export one matters most, because it is the way
  // out: the notice says so, and it has to be true.
  const { dom, TMV: shellTMV, shell, model, history } = loadShell({});
  shell.reportStorage(TMV.storage.detectStorageContext({ available: false }));

  // 1. It rendered.
  assert.equal(shell.state().mounted, true);
  assert.ok(dom.body.querySelector('#tmv-content'), 'the content region exists');
  assert.ok(dom.body.querySelectorAll('#tmv-tabs [role="tab"]').length >= 9, 'and the tabs are drawn');

  // 2. There is a persistent notice, and it explains what will not survive.
  const banner = dom.body.querySelector('.tmv-banner');
  assert.ok(banner, 'a persistent notice is shown');
  assert.match(banner.textContent, /not be kept between visits/, 'saying what is lost');
  assert.equal(dom.body.querySelector('#tmv-storage-notice').hasAttribute('hidden'), false, 'and the header indicator is on');
  assert.ok(dom.body.querySelector('#tmv-storage-notice-text').textContent.length > 0);

  // 3. It edits: an edit goes into the working copy and the dirty indicator moves.
  const working = core.deepCopy(shell.state().model);
  M.insert(working, 'control', { id: 'ctrl-offline', name: 'Offline edit', status: 'planned' });
  shell.edit(working, { label: 'Edit with no storage' });
  assert.equal(shell.isDirty(), true, 'the edit landed');
  assert.ok(M.get(shell.state().model, 'controls', 'ctrl-offline'));

  // 4. It exports — both an interchange document and the application itself. Export reads neither
  //    storage nor the working-copy state (REQ-EXP-013), which is what makes this unconditional.
  //    The fixture deliberately carries a dangling reference (`seed()`'s `flow-bad`) so the
  //    "Unresolved References" finding has a row, and §8 blocks an export that would write that
  //    name into someone else's tool in *either* format. The flow it belongs to comes out first, so
  //    the thing under test is the export path rather than the block.
  shell.state().model.dataFlows = shell.state().model.dataFlows.filter((f) => f.id !== 'flow-bad');
  const toOtm = shellTMV.exporting.interchange(shell.state().model, 'otm', { history: shell.state().history });
  assert.equal(toOtm.ok, true, 'an interchange export succeeds');
  assert.ok(toOtm.document, 'and produces a document');
  assert.ok(toOtm.text.length > 0, 'with text to write to a file');
  const native = shellTMV.exporting.exportNative(shell.state().model, shell.state().history, {});
  assert.equal(native.ok, true, 'a native export succeeds');
  assert.ok(native.container, 'and carries the history');
  assert.equal(native.container.model.modelId, FIXTURE_MODEL_ID, 'for the model that was open');
  assert.ok(model && history, 'the fixture is what it was');
});

specTest('store.quota-warn', () => {
  // REQ-STORE-006: warn, quantify, and offer a way out; never silently delete. The warning is
  // raised *before* the write, so the user chooses rather than discovers.
  //
  // The pre-flight measures against `TMV.QUOTA.budgetBytes` — the app's own estimate of what the
  // origin will hold — because no browser will tell the page its real budget on `file://`. The test
  // moves that number rather than filling five megabytes of memory to reach 85% of the real one.
  const original = TMV.QUOTA.budgetBytes;
  try {
    const adapter = memory();
    const { model, history } = seeded('model-q', 'Quota');
    commitThreat(history, 'A threat', 'threat-1');
    assert.equal(S.saveModel(adapter, history, { modelId: 'model-q', model }).ok, true, 'a model inside the budget saves');
    const used = adapter.usage().bytes;

    // One more commit, with the budget set so that storing it would cross the warning threshold.
    const working = core.deepCopy(vcs.headModel(history));
    M.insert(working, 'threat', { id: 'threat-2', name: 'Another' });
    vcs.commit(history, working, ALICE, 'add another', { timestamp: NOW });
    TMV.QUOTA.budgetBytes = Math.round(used / 0.8);

    const over = S.saveModel(adapter, history, { modelId: 'model-q', model: working });
    assert.equal(over.ok, false, 'a write that would cross the threshold does not happen');
    assert.equal(over.reason, 'quota');
    assert.ok(['warning', 'exhausted'].includes(over.level), `a level the UI can render, got ${over.level}`);
    assert.match(over.message, /Nothing has been written yet/, 'and it says so plainly');
    assert.match(over.message, /\d+(\.\d+)?\s*[KMG]?B/, 'with a number in it rather than "too big"');
    assert.ok(over.gauge && over.projection, 'and both the current gauge and the projection, so the UI can quantify');

    // Nothing was written and nothing was evicted: the pre-flight is a projection, not a partial
    // write, and the refusal leaves the store byte-for-byte where it was.
    assert.equal(adapter.usage().bytes, used, 'the store did not grow');
    assert.equal(S.loadModel(adapter, 'model-q').ok, true, 'and the stored history is untouched');
    assert.equal(S.loadModel(adapter, 'model-q').history.head, history.commits[history.commits.length - 2].id);

    // The explicit override is the only way past it, and it is a flag the caller has to pass.
    const allowed = S.saveModel(adapter, history, { modelId: 'model-q', model: working, allowOverThreshold: true });
    assert.equal(allowed.ok, true, 'the override is honoured');
    assert.ok(adapter.usage().bytes > used, 'and the write actually happened');

    // The gauge reports level and ratio, which is what the UI needs to say "about 86% full".
    const gauge = S.gauge(adapter, { budget: Math.max(1, used) });
    assert.ok(['normal', 'elevated', 'warning', 'exhausted'].includes(gauge.level));
    assert.ok(gauge.ratio >= 0);
    assert.equal(S.levelFor(0, 1000), 'normal');
    assert.equal(S.levelFor(750, 1000), 'elevated');
    assert.equal(S.levelFor(900, 1000), 'warning');
    assert.equal(S.levelFor(1000, 1000), 'exhausted');
    assert.equal(S.levelFor(0, 0), 'normal', 'a nonsense budget does not divide by zero');
  } finally {
    TMV.QUOTA.budgetBytes = original;
  }
});

specTest('store.quota-preflight', () => {
  // The §9 case, from the other side: the projection is available *without attempting the write*, so
  // import can ask "would this fit?" and warn before it has anything to lose.
  const original = TMV.QUOTA.budgetBytes;
  try {
    const adapter = memory();
    const { model, history } = seeded('model-pf', 'Preflight');
    assert.equal(S.saveModel(adapter, history, { modelId: 'model-pf', model, name: 'Preflight' }).ok, true);
    const used = S.gauge(adapter).bytes;
    const budget = Math.round(used / 0.5); // half full

    const small = S.preflight(adapter, 10, { budget });
    assert.equal(small.crossesWarning, false, 'a small projection does not warn');
    assert.equal(small.level, 'normal');
    assert.equal(small.projected, used + 10);
    assert.equal(small.available, budget - used, 'available is the headroom, and it is reported');

    const big = S.preflight(adapter, Math.round(budget * 0.5), { budget });
    assert.equal(big.crossesWarning, true, 'a projection over the threshold says so before anything is written');
    assert.equal(big.level, 'exhausted');

    // An impossible projection is not negative, and a zero budget does not divide by zero.
    assert.equal(S.preflight(adapter, -100, { budget }).projected, used, 'a negative size is clamped, not subtracted');
    assert.equal(S.preflight(adapter, 0, { budget: 0 }).level, 'normal');

    // The projection does not write. That is the whole point of it existing as a separate call.
    assert.equal(S.gauge(adapter).bytes, used, 'preflight changed nothing');

    // And the save path consults the same projection, so a caller that ignores `preflight` still
    // cannot write past the threshold without the explicit flag.
    TMV.QUOTA.budgetBytes = Math.round(used / 0.8);
    const working = core.deepCopy(vcs.headModel(history));
    M.insert(working, 'threat', { id: 'threat-1', name: 'A threat' });
    vcs.commit(history, working, ALICE, 'add', { timestamp: NOW });
    const blocked = S.saveModel(adapter, history, { modelId: 'model-pf', model: working });
    assert.equal(blocked.ok, false, 'the save path refuses on the same projection');
    assert.equal(blocked.reason, 'quota');
    assert.equal(S.gauge(adapter).bytes, used, 'and nothing was written');

    // `preflight: false` skips the check for a caller that has already asked — a prompt, not a gate.
    const skipped = S.saveModel(adapter, history, { modelId: 'model-pf', model: working, preflight: false });
    assert.equal(skipped.ok, true, 'a caller that already prompted can proceed');
  } finally {
    TMV.QUOTA.budgetBytes = original;
  }
});

specTest('store.quota-exhausted', () => {
  // The §9 case: the platform throws. `makeAdapter` wraps whatever the backend raises into
  // `STORAGE_QUOTA` — a clean, catchable failure with the byte count in its detail, after which
  // nothing has been removed and the stored history still loads.
  const backend = {
    kind: 'memory',
    data: Object.create(null),
    refuse: null,
    read(key) {
      return core.has(this.data, key) ? this.data[key] : null;
    },
    write(key, value) {
      if (this.refuse && key.includes(this.refuse)) {
        throw new Error('QuotaExceededError: the quota has been exceeded.');
      }
      this.data[key] = value;
    },
    remove(key) {
      delete this.data[key];
    },
    keys() {
      return Object.keys(this.data);
    },
  };
  const adapter = S.makeAdapter(backend);
  const { model, history } = seeded('model-full', 'Full');
  commitThreat(history, 'A threat', 'threat-1');
  assert.equal(S.saveModel(adapter, history, { modelId: 'model-full', model }).ok, true, 'the first save fits');
  const settled = adapter.keys().length;

  // Now a commit whose payload the platform refuses to hold. Point the refusal at that one commit,
  // so what fails is the write being tested rather than the registry write that follows it.
  const working = core.deepCopy(vcs.headModel(history));
  working.description = 'x'.repeat(5000);
  const big = vcs.commit(history, working, ALICE, 'a very large commit', { timestamp: NOW });
  assert.ok(big.ok, 'the commit itself is fine — the model is not what runs out of room');
  backend.refuse = big.commit.id;

  let raised = null;
  try {
    S.saveModel(adapter, history, { modelId: 'model-full', model: working });
  } catch (err) {
    raised = err;
  }
  assert.ok(raised, 'the platform’s refusal surfaces as a throw rather than a silent no-op');
  assert.equal(raised.code, 'STORAGE_QUOTA', 'with a code the caller can branch on');
  assert.match(raised.message, /QuotaExceededError|storage is full/);
  assert.ok(raised.detail && raised.detail.bytes > 0, 'and the byte count that was refused');

  // "Clean failure, nothing removed": the commits that were there are still there and still load,
  // and the head has not moved to the commit that could not be written.
  const loaded = S.loadModel(adapter, 'model-full');
  assert.equal(loaded.ok, true, 'what was stored before the failure is still loadable');
  assert.equal(loaded.history.head, history.commits[history.commits.length - 2].id, 'at the head it had');
  assert.equal(S.readMeta(adapter, 'model-full').headCommitId, loaded.history.head);
  assert.ok(adapter.keys().length >= settled, 'and nothing already stored was evicted to make room');

  // Recovery is offered because the pointer was never moved: the file on disk and the working copy
  // both still hold the big commit, so exporting is a way forward rather than a dead end.
  const exported = TMV.exporting.exportNative(working, history, {});
  assert.equal(exported.ok, true, 'the model with the big commit still exports');
  backend.refuse = null;
  assert.equal(S.saveModel(adapter, history, { modelId: 'model-full', model: working }).ok, true, 'and saves once there is room');
});

specTest('store.interrupted-commit', () => {
  // The §9 fault-injection case, and the reason the write order is what it is: a kill between the
  // blob write and the head update must leave an orphan, not a dangling pointer. This drives the real
  // path — `saveModel` writing through the adapter — and fails the write in the middle of it.
  const adapter = memory();
  const { model, history } = seeded('model-i', 'Interrupted');
  const second = commitThreat(history, 'A threat', 'threat-1');
  assert.ok(second.ok);

  // The third write is the second commit's payload: the root keyframe and its record go first, so a
  // failure here lands *after* the blobs and *before* the pointer — exactly the window this is about.
  assert.equal(S.__test.failWritesAt(3), 3, 'the third write will fail, and the counter starts over');
  let raised = null;
  try {
    S.saveModel(adapter, history, { modelId: 'model-i', model });
  } catch (err) {
    raised = err;
  }
  assert.ok(raised, 'the interrupted write surfaces rather than being swallowed');
  assert.equal(raised.code, 'STORAGE_TEST_FAILURE');
  assert.equal(S.__test.writesSeen(), 3, 'three writes went through before the failure');
  S.__test.failWritesAt(0);

  // The invariant: no meta record, so no head naming a commit that is not there.
  assert.equal(S.readMeta(adapter, 'model-i'), null, 'the pointer was never written');
  const loaded = S.loadModel(adapter, 'model-i');
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'absent', 'storage reports "nothing here", which the file-backed path handles');
  assert.notEqual(loaded.reason, 'dangling', 'and specifically not a head pointing at a missing commit');

  // The orphans are real and they are collectable — waste, not corruption.
  assert.ok(adapter.keys().some((k) => k.includes(':snap:')), 'blobs were written before the failure');
  const report = S.collect(adapter, history, { modelId: 'model-i' });
  assert.equal(report.confirmed, false, 'a collect with no confirm is a dry run');
  assert.equal(report.removed, undefined, 'and removes nothing');
  assert.ok(report.before > 0, 'but it reports what is there');

  // Finish the save properly, and then the interruption is invisible: the history is whole.
  assert.equal(S.saveModel(adapter, history, { modelId: 'model-i', model, name: 'Interrupted' }).ok, true);
  const healed = S.loadModel(adapter, 'model-i');
  assert.equal(healed.ok, true, 'the retry completes the write');
  assert.equal(healed.history.commits.length, history.commits.length);
  assert.equal(healed.history.head, history.head);
  assert.equal(vcs.verifyChain(healed.history).ok, true, 'and the chain verifies');

  // The property the ordering buys, stated as a walk rather than a case: for *every* prefix of a
  // save's writes, the store reads back either whole or as "nothing here". It never reads back as a
  // head naming a commit that is not there, and never as commits that do not reconstruct — which is
  // the corruption the order blobs-then-pointer exists to make impossible.
  //
  // The walk also shows why the order is what it is rather than "write the pointer first, it is the
  // important one": by the last write the pointer is *already* correct, and the failure that follows
  // it costs nothing. The registry write is the one left exposed, and an index that is behind is
  // re-derived from `meta` on the next load. The two orderings differ only in which of those is the
  // failure, and this is the one that is recoverable.
  const probes = [];
  for (let failAt = 1; failAt <= 8; failAt++) {
    const walked = memory();
    const fixture = seeded('model-w', 'Walked');
    commitThreat(fixture.history, 'A threat', 'threat-1');
    S.__test.failWritesAt(failAt);
    let interrupted = null;
    try {
      S.saveModel(walked, fixture.history, { modelId: 'model-w', model: fixture.model, name: 'Walked' });
    } catch (err) {
      interrupted = err;
    }
    const reached = S.__test.writesSeen();
    S.__test.failWritesAt(0);
    const readBack = S.loadModel(walked, 'model-w');
    probes.push({ failAt, reached, interrupted: Boolean(interrupted), ok: readBack.ok, reason: readBack.reason });
    assert.notEqual(readBack.reason, 'dangling', `a failure at write ${failAt} left a head pointing at a missing commit`);
    assert.notEqual(readBack.reason, 'corrupt', `a failure at write ${failAt} left commits that do not reconstruct`);
    if (readBack.ok) {
      assert.equal(readBack.history.head, fixture.history.head, `write ${failAt} reads back the head it was saving`);
      assert.equal(
        vcs.verifyChain(readBack.history).ok,
        true,
        `write ${failAt} left a chain that verifies`,
      );
    }
  }
  assert.ok(
    probes.some((p) => p.ok) && probes.some((p) => !p.ok),
    'the walk spans both outcomes, so the assertions above are not vacuous',
  );
  assert.equal(probes[0].ok, false, 'failing the very first write leaves nothing at all');
  assert.equal(probes[probes.length - 1].ok, true, 'and running out of writes to fail leaves a complete save');
  assert.ok(
    probes.some((p) => p.interrupted && p.ok),
    'a write that fails after the pointer is already correct costs nothing — which is the point of the order',
  );
});

specTest('store.concurrent-commit', () => {
  // The §9 case: a second tab commits. The first tab's commit must be *refused*, not silently
  // overwrite the second's. The write token is what makes this an optimistic concurrency check
  // rather than last-writer-wins, and the token is re-read immediately before the pointer is written.
  const adapter = memory();
  const { model, history } = seeded('model-c', 'Concurrent');
  commitThreat(history, 'First', 'threat-1');
  assert.equal(S.saveModel(adapter, history, { modelId: 'model-c', model }).ok, true);
  const mine = S.readMeta(adapter, 'model-c').writeToken;

  // Another tab loads, commits, and saves — which moves the token.
  const theirs = core.deepCopy(history);
  commitThreat(theirs, 'Theirs', 'threat-theirs');
  const theirSave = S.saveModel(adapter, theirs, { modelId: 'model-c', model });
  assert.equal(theirSave.ok, true, 'the other tab saved');
  assert.notEqual(theirSave.writeToken, mine, 'and the token moved');

  // The first tab saves against the token it loaded. It must be refused — with the working copy kept.
  const refused = S.saveModel(adapter, history, { modelId: 'model-c', model, expectedWriteToken: mine });
  assert.equal(refused.ok, false, 'the stale write is refused');
  assert.equal(refused.reason, 'conflict');
  assert.match(refused.message, /Another tab saved this model/);
  assert.match(refused.message, /working copy is untouched/, 'and says so, because that is the user’s next question');

  // The other tab’s work is intact: refused means *nothing* of the first tab’s landed.
  const still = S.loadModel(adapter, 'model-c');
  assert.equal(still.ok, true, 'the store is readable');
  assert.equal(still.history.head, theirs.head, 'and it is the other tab’s head');
  assert.ok(
    still.history.commits.some((c) => c.message === 'add threat-theirs'),
    'the other tab’s commit is there',
  );

  // Reloading and retrying with the fresh token succeeds — the user is not stuck.
  const reloadedMeta = S.readMeta(adapter, 'model-c');
  const retry = S.saveModel(adapter, history, { modelId: 'model-c', model, expectedWriteToken: reloadedMeta.writeToken });
  assert.equal(retry.ok, true, 'the retry with the current token goes through');
});

specTest('store.no-silent-pruning', () => {
  // REQ-STORE-006 AC3: no code path deletes commits without explicit user confirmation. `collect` is
  // the only caller of `adapter.remove` for commits, and it is a dry run until `confirm === true`.
  // This asserts the flag is load-bearing at the storage layer, so a UI that forgot to pass it
  // removes nothing rather than removing a lot.
  const adapter = memory();
  const { model, history } = seeded('model-np', 'No pruning');
  const branch = core.deepCopy(history);
  commitThreat(branch, 'Orphaned', 'threat-orphan');
  S.saveModel(adapter, branch, { modelId: 'model-np', model });
  S.saveModel(adapter, history, { modelId: 'model-np', model, name: 'No pruning' });
  const keysBefore = adapter.keys().length;
  assert.ok(S.collect(adapter, history, { modelId: 'model-np' }).unreachable.length > 0, 'there is something to collect');

  // Every call shape that is not the explicit confirmation removes nothing.
  for (const options of [{ modelId: 'model-np' }, { modelId: 'model-np', confirm: 'yes' }, { modelId: 'model-np', confirm: 1 }]) {
    const report = S.collect(adapter, history, options);
    assert.equal(report.confirmed, false, `confirm: ${JSON.stringify(options.confirm)} is not consent`);
    assert.equal(report.removed, undefined);
    assert.equal(adapter.keys().length, keysBefore, 'and the store is byte-for-byte where it was');
  }

  // The report is what the user consents *to*, so it has to be truthful: the ids it names are the
  // ones a confirmed run removes, and `bytes` is what it frees.
  const preview = S.collect(adapter, history, { modelId: 'model-np' });
  const confirmed = S.collect(adapter, history, { modelId: 'model-np', confirm: true });
  assert.equal(confirmed.removed > 0, true, 'the explicit flag is the one that removes');
  assert.ok(confirmed.after < confirmed.before, 'and the model is smaller afterwards');
  assert.equal(confirmed.unreachable.join(','), preview.unreachable.join(','), 'what it said it would remove is what it removed');
  for (const id of preview.unreachable) {
    assert.equal(adapter.keys().filter((k) => k.includes(id)).length, 0, `${id} is gone`);
  }

  // Reachable commits are never touched, at any setting. The history is the user's work.
  const after = S.loadModel(adapter, 'model-np');
  assert.equal(after.ok, true, 'the reachable history still loads');
  assert.equal(after.history.head, history.head);
  same(
    after.history.commits.map((c) => c.id).sort(),
    history.commits.map((c) => c.id).sort(),
    'and every reachable commit is still there',
  );
});

specTest('store.gc-explicit', () => {
  // REQ-STORE-008 AC1: a collection action reports what it will remove *before* removing it. Through
  // the shell this is two calls — `collectionReport` decides, `runCollection` writes — which is what
  // makes "asks first" a property of the code rather than of the dialogue.
  const { dom, TMV: shellTMV, shell, adapter, history, model } = loadShell({ stored: true });
  const S2 = shellTMV.storage;

  // Leave an orphan in storage: save a longer history, then save the shorter one over it.
  const branch = core.deepCopy(history);
  const working = core.deepCopy(vcs.headModel(history));
  M.insert(working, 'threat', { id: 'threat-orphan', name: 'Orphaned by a revert' });
  const orphan = vcs.commit(branch, working, ALICE, 'will be orphaned', { timestamp: NOW });
  assert.ok(orphan.ok);
  S2.saveModel(adapter, branch, { modelId: FIXTURE_MODEL_ID, model: working });
  S2.saveModel(adapter, history, { modelId: FIXTURE_MODEL_ID, model });

  const keysBefore = adapter.keys().length;
  const preview = shell.collectionReport();
  assert.equal(preview.ok, true, 'a report is available');
  assert.equal(preview.report.confirmed, false, 'and it is not a removal');
  assert.equal(preview.report.removed, undefined);
  assert.equal(preview.report.unreachable.length, 1, 'it names the unreachable commit');
  assert.equal(preview.report.unreachable[0], orphan.commit.id);
  assert.ok(preview.report.bytes > 0, 'and quantifies what removing it would free');
  assert.equal(adapter.keys().length, keysBefore, 'asking changed nothing');

  // The user is told, and then consents. Only then does anything go.
  const banner = dom.body.querySelector('.tmv-banner');
  assert.ok(banner === null || banner !== undefined, 'the report is rendered by the view, not here');
  const ran = shell.runCollection();
  assert.equal(ran.ok, true, 'the confirmed run happens');
  assert.equal(ran.report.removed > 0, true, 'and removes');
  assert.ok(adapter.keys().length < keysBefore, 'the store shrank');
  assert.equal(
    adapter.keys().filter((k) => k.includes(orphan.commit.id)).length,
    0,
    'and the orphan it named is gone',
  );

  // The reachable history is untouched, and the app is still on the same head.
  assert.equal(shell.state().history.head, history.head, 'the head did not move');
  assert.equal(S2.loadModel(adapter, FIXTURE_MODEL_ID).ok, true, 'and the model still loads');

  // Read-only: a collection is refused rather than half-done.
  const { shell: roShell } = loadShell({ stored: true, editable: false });
  assert.equal(roShell.runCollection().ok, false);
  assert.equal(roShell.runCollection().reason, 'read-only');
});

specTest('store.migration-verify-before-remove', () => {
  // The §9 fault-injection case. The ordering is the whole point (§8): build the new layout, verify
  // it, *then* remove the old keys. A crash between the two leaves both layouts, which the next run
  // completes. The reverse order leaves neither.
  const adapter = memory();
  const a = seeded('model-old-a', 'Old A');
  const b = seeded('model-old-b', 'Old B');
  adapter.write('tmv:0:model:model-old-a:meta', JSON.stringify({ layout: 'old' }));
  adapter.write('tmv:0:model:model-old-b:meta', JSON.stringify({ layout: 'old' }));
  adapter.write('tmv:9:model:future:meta', JSON.stringify({ layout: 'future' }));
  adapter.write('tmv:1:mystery', 'x');
  adapter.write('some-other-app:key', 'y');
  const oldKeys = () => adapter.keys().filter((k) => k.startsWith('tmv:0:'));

  // A migration that half-finishes — it writes the new layout for one model and then "crashes"
  // before the other. Verification catches it, and *nothing* is removed.
  S.MIGRATIONS[0] = function (adapter2) {
    S.saveModel(adapter2, a.history, { modelId: 'model-old-a', model: a.model, name: 'Old A' });
    return { written: 1 };
  };
  try {
    const first = S.runMigrations(adapter);
    assert.equal(first.current, TMV.STORAGE_VERSION);
    same(first.migrated, [], 'a migration that did not verify is not counted as done');
    assert.equal(first.failed.version, 0);
    assert.match(first.failed.reason, /did not verify; nothing was removed/);
    assert.equal(oldKeys().length, 2, 'both old keys are still there — nothing was lost');

    // A newer application's layout is not ours to destroy: ignored, and its keys left alone.
    same(first.ignoredNewer, [{ version: 9, keys: 1 }]);
    assert.equal(adapter.keys().filter((k) => k.startsWith('tmv:9:')).length, 1);
    // Junk under our prefix is reported rather than deleted, and a foreign key is not even looked at.
    assert.ok(first.unrecognised.includes('tmv:1:mystery'));
    assert.equal(first.unrecognised.includes('some-other-app:key'), false);

    // Now the migration completes. It verifies, and only then are the old keys removed.
    S.MIGRATIONS[0] = function (adapter2) {
      S.saveModel(adapter2, a.history, { modelId: 'model-old-a', model: a.model, name: 'Old A' });
      S.saveModel(adapter2, b.history, { modelId: 'model-old-b', model: b.model, name: 'Old B' });
      return { written: 2 };
    };
    const second = S.runMigrations(adapter);
    same(second.migrated.map((m) => m.version), [0]);
    assert.equal(second.removed.length, 2, 'the old keys are removed once the new layout verifies');
    assert.equal(oldKeys().length, 0, 'and not before');
    assert.equal(adapter.keys().filter((k) => k.startsWith('tmv:9:')).length, 1, 'the newer layout is still untouched');

    // Both models are readable in the new layout — which is what "verified" meant.
    assert.equal(S.loadModel(adapter, 'model-old-a').ok, true);
    assert.equal(S.loadModel(adapter, 'model-old-b').ok, true);
    assert.equal(S.runMigrations(adapter).migrated.length, 0, 'a second run has nothing left to do');
  } finally {
    delete S.MIGRATIONS[0];
  }
});

