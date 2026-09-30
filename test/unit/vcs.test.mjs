/*
 * vcs.test.mjs — the history model.
 *
 * The largest single block of requirements in the spec, and the one with the least room for error:
 * everything else can be re-rendered, and a bug here loses work. Two invariants run through every
 * assertion in this file, and most of the tests are one of them stated as a case.
 *
 *   I1  A commit id covers the model and the commit message, never the storage representation.
 *       So `snapshot` and `delta` are not hash inputs, compaction is id-preserving, and a commit
 *       read from a file with its commits in a different order is the same commit.
 *   I2  Ordering is ancestry only. `timestamp` is hashed and displayed and never consulted to
 *       decide which of two histories is newer.
 *
 * The histories here are built by hand rather than by the fixture, because the shapes that matter —
 * a branch point, a criss-cross, a merge that is not the head — are exactly the ones a linear
 * fixture cannot produce.
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadApp, loadShell } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { vcs, model: M, core, canonical, hash } = TMV;

const ALICE = { name: 'Alice', email: 'alice@example.com' };
const BOB = { name: 'Bob', email: 'bob@example.com' };

function newModel(name) {
  return M.createEmpty(name || 'Test model');
}

/** A model with `n` controls in it, so successive commits differ. */
function withControls(base, n, tag) {
  const m = core.deepCopy(base);
  for (let i = 0; i < n; i++) {
    M.insert(m, 'control', { id: `${tag}-${i}`, name: `${tag} ${i}`, status: 'planned' });
  }
  return m;
}

/** Commit `model` onto `history` with a fixed timestamp, so a test that cares can control the clock. */
function commitAt(history, model, when, author, message) {
  const result = vcs.commit(history, model, author || ALICE, message || 'edit', { timestamp: when });
  assert.equal(result.ok, true, `commit failed: ${result.message}`);
  return result.commit;
}

/** A linear history of `n` commits on top of a root. Returns the history and every model. */
function linearHistory(n, interval) {
  let history = vcs.initHistory(newModel(), ALICE, 'root', {
    timestamp: '2020-01-01T00:00:00.000Z',
    keyframeInterval: interval || TMV.DEFAULT_KEYFRAME_INTERVAL,
  });
  const models = [vcs.materialize(history, history.head)];
  for (let i = 1; i <= n; i++) {
    const next = withControls(models[i - 1], i, `c${i}`);
    commitAt(history, next, `2020-01-0${i + 1}T00:00:00.000Z`, ALICE, `commit ${i}`);
    models.push(next);
  }
  return { history, models };
}

// ---------------------------------------------------------------------------------------------

specTest('vcs.canonical-serialization', () => {
  // REQ-VCS-003. The property the whole chain rests on: two models that differ only in the *order
  // their keys were inserted* must serialize identically, because otherwise a hash depends on how a
  // program happened to build an object and no two implementations could ever agree.
  // One id for both, so the only difference between them is the order the keys went in.
  const ID = '11111111-2222-4333-8444-555555555555';
  const a = M.createEmpty('Order', ID);
  const b = M.createEmpty('Order', ID);

  // Same values, opposite insertion order, at every level.
  for (const m of [a, b]) {
    m.description = 'same';
    m.x = Object.create(null);
  }
  a.x.otm = Object.create(null);
  a.x.otm.one = 1;
  a.x.otm.two = 2;
  b.x.otm = Object.create(null);
  b.x.otm.two = 2;
  b.x.otm.one = 1;

  assert.equal(canonical.serialize(a), canonical.serialize(b));

  // Shuffling the entity arrays' *contents* is order-significant and must change the hash, while
  // shuffling the order the entities were inserted into the model is not, because each entity's own
  // key order is what canonicalization sorts.
  const shuffled = TMV.model.createEmpty('Order', a.modelId);
  shuffled.description = 'same';
  shuffled.x = Object.create(null);
  shuffled.x.otm = Object.create(null);
  shuffled.x.otm.two = 2;
  shuffled.x.otm.one = 1;
  assert.equal(canonical.serialize(shuffled), canonical.serialize(a));

  // 200 random key orders over the same value set all serialize the same. `Object.keys` order is
  // insertion order for string keys, so this is the property under test and not a tautology — and the
  // value each key holds is the key itself, so the shuffle changes the order and nothing else.
  const signatures = new Set();
  for (let round = 0; round < 200; round++) {
    const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    for (let i = keys.length - 1; i > 0; i--) {
      const j = (i * 7 + round * 13) % (i + 1);
      const swap = keys[i];
      keys[i] = keys[j];
      keys[j] = swap;
    }
    const o = Object.create(null);
    for (const k of keys) o[k] = k;
    signatures.add(canonical.serialize(o));
  }
  assert.equal(signatures.size, 1, 'every insertion order produces one serialization');

  // The specified details, each of which a plain `JSON.stringify` gets wrong.
  assert.equal(canonical.serialize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonical.serialize({ a: undefined, b: 1 }), '{"b":1}', 'undefined is omitted from an object');
  assert.equal(canonical.serialize([1, undefined, 2]), '[1,null,2]', 'but held as null in an array');
  assert.equal(canonical.serialize({ a: null }), '{"a":null}', 'null is preserved');
  assert.equal(canonical.serialize([]), '[]');
  assert.equal(canonical.serialize({}), '{}');
  assert.equal(canonical.serialize(-0), '0', 'negative zero collapses, so it cannot fork a hash');
  assert.equal(canonical.serialize(1e21), '1e+21');
  assert.throws(() => canonical.serialize(NaN), /non-finite/);
  assert.throws(() => canonical.serialize(Infinity), /non-finite/);
  // NFC, so two strings that render identically hash identically.
  assert.equal(canonical.serialize('é'), canonical.serialize('é'));
});

specTest('vcs.commit-hash-deterministic', () => {
  // REQ-VCS-001: the same content produces the same id, on any machine, at any time — and the id
  // covers exactly what the spec says it covers (I1).
  const model = withControls(newModel('Deterministic'), 3, 's');
  const payload = {
    parents: [],
    modelId: model.modelId,
    author: ALICE,
    timestamp: '2021-05-05T05:05:05.000Z',
    message: 'same',
    modelHash: vcs.modelHashOf(model),
  };
  const id = vcs.commitIdOf(payload);
  assert.equal(id, vcs.commitIdOf(payload), 'same fields, same id');
  assert.ok(hash.isAddress(id));

  // Every field that is part of the identity changes it.
  const mutations = [
    ['parents', { ...payload, parents: ['sha256:' + '0'.repeat(64)] }],
    ['modelId', { ...payload, modelId: core.uuid() }],
    ['author', { ...payload, author: BOB }],
    ['timestamp', { ...payload, timestamp: '2021-05-05T05:05:06.000Z' }],
    ['message', { ...payload, message: 'different' }],
    ['modelHash', { ...payload, modelHash: vcs.modelHashOf(withControls(model, 1, 'x')) }],
  ];
  for (const [field, variant] of mutations) {
    assert.notEqual(vcs.commitIdOf(variant), id, `${field} is part of the id`);
  }

  // And the fields that are *not*: the storage representation, which is what makes compaction
  // id-preserving (I1).
  const withStorage = { ...payload, isKeyframe: true, snapshot: model, delta: null };
  assert.equal(vcs.commitIdOf(withStorage), id, 'commitPayload ignores the storage fields entirely');
  assert.equal(vcs.commitIdOf({ ...payload, isKeyframe: true }), id, 'and an unknown extra field too');
  same(Object.keys(vcs.commitPayload(payload)).sort(), ['author', 'message', 'modelHash', 'modelId', 'parents', 'timestamp']);

  // Parents are sorted into the payload, so a merge declared in either order is one commit.
  const twoParents = { ...payload, parents: ['b'.repeat(64), 'a'.repeat(64)] };
  const reversed = { ...payload, parents: ['a'.repeat(64), 'b'.repeat(64)] };
  assert.equal(vcs.commitIdOf(twoParents), vcs.commitIdOf(reversed));
});

specTest('vcs.tamper-detected', () => {
  // REQ-VCS-002. The chain check catches a commit whose stored fields no longer hash to its id, a
  // missing parent, a head that is not in the commits, and a truncation.
  const { history } = linearHistory(3);
  assert.equal(vcs.verifyChain(history).ok, true, 'a clean history verifies');
  assert.equal(vcs.verifyModel(history, history.head).ok, true);

  /** A copy of the history with one thing wrong with it. */
  const variant = (mutate) => {
    const copy = core.deepCopy(history);
    mutate(copy);
    return copy;
  };
  const tamper = (mutate) => vcs.verifyChain(variant(mutate));
  const codes = (verdict) => verdict.problems.map((p) => p.code);

  const edited = tamper((h) => {
    h.commits[1].message = 'rewritten';
  });
  assert.equal(edited.ok, false);
  assert.ok(codes(edited).includes('COMMIT_HASH'), codes(edited).join(','));

  const truncated = tamper((h) => {
    h.commits.splice(0, 1);
  });
  assert.equal(truncated.ok, false);
  assert.ok(codes(truncated).includes('COMMIT_PARENT_MISSING'), codes(truncated).join(','));

  const danglingHead = tamper((h) => {
    h.head = 'sha256:' + 'f'.repeat(64);
  });
  assert.equal(danglingHead.ok, false);
  assert.ok(codes(danglingHead).includes('HISTORY_HEAD_MISSING'));

  const badId = tamper((h) => {
    h.commits[2].id = 'not-an-address';
  });
  assert.ok(codes(badId).includes('COMMIT_ID'));

  const bothStorage = tamper((h) => {
    h.commits[2].snapshot = {};
  });
  assert.ok(codes(bothStorage).includes('COMMIT_STORAGE'));

  const wrongFlag = tamper((h) => {
    h.commits[2].isKeyframe = true;
  });
  assert.ok(codes(wrongFlag).includes('COMMIT_KEYFRAME'));

  // An orphan is reported, and reported as a *warning*. This is a well-formed second root — its id
  // hashes correctly, so the only thing wrong with it is that nothing leads to it. The distinction
  // matters: the reachable history still verifies, and the app can offer to drop the stray commit
  // rather than declaring the file unreadable.
  const orphaned = vcs.verifyChain(
    variant((h) => {
      const orphan = core.deepCopy(h.commits[0]);
      orphan.parents = [];
      orphan.message = 'a second root, left behind by a bad compaction';
      orphan.id = vcs.commitIdOf(orphan);
      h.commits.push(orphan);
    }),
  );
  assert.ok(
    orphaned.problems.some((p) => p.code === 'COMMIT_UNREACHABLE'),
    codes(orphaned).join(','),
  );
  assert.equal(codes(orphaned).length, 1, 'and it is the only problem reported');
  assert.equal(orphaned.ok, true, 'an unreachable commit is a warning: the reachable history still verifies');

  // The model check is the one that catches a snapshot rewritten with its id left alone — the case
  // the chain check cannot see, because `snapshot` is not a hash input. This is the whole reason
  // REQ-VCS-006 requires a faithful reconstruction: if materialization were lossy, this check would
  // fail on every untouched history and would be worth nothing.
  const rewritten = variant((h) => {
    h.commits[0].snapshot.name = 'quietly renamed';
  });
  assert.equal(vcs.verifyChain(rewritten).ok, true, 'the chain check does not read snapshots');
  const modelCheck = vcs.verifyModel(rewritten, rewritten.commits[0].id);
  assert.equal(modelCheck.ok, false, 'but the model check does');
  assert.equal(modelCheck.problems[0].code, 'COMMIT_MODEL_MISMATCH');

  // And an intact history of the same shape passes the model check, so the test above is measuring
  // the tampering and not a check that fails for everything.
  assert.equal(vcs.verifyModel(history, history.commits[0].id).ok, true);
});

specTest('vcs.reconstruct-fidelity', (t) => {
  // REQ-VCS-006, as a property over generated histories: for every commit, the model reconstructed
  // from storage hashes to the modelHash recorded in that commit — and equals the model that was
  // committed. A lossy materialization would fail here and would also make the model check useless.
  let seed = 0x1234567;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  for (let round = 0; round < 12; round++) {
    const interval = 1 + next(5);
    const length = 2 + next(14);
    const history = vcs.initHistory(newModel(`P${round}`), ALICE, 'root', {
      timestamp: '2020-01-01T00:00:00.000Z',
      keyframeInterval: interval,
    });
    const models = [{ id: history.head, model: vcs.materialize(history, history.head) }];

    for (let i = 1; i <= length; i++) {
      const parent = models[i - 1].model;
      const edits = 1 + next(4);
      const working = core.deepCopy(parent);
      for (let e = 0; e < edits; e++) {
        M.insert(working, 'control', { id: `r${round}-${i}-${e}`, name: `c ${i}.${e}`, status: 'planned' });
      }
      if (next(6) === 0) {
        // A rename, so a replace op is generated as well as adds.
        working.name = `${working.name}!`;
      }
      const result = vcs.commit(history, working, ALICE, `commit ${i}`, {
        timestamp: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
      });
      assert.equal(result.ok, true, result.message);
      models.push({ id: result.commit.id, model: working });
    }

    // Half the rounds get a divergent branch and a merge. A delta applied against the wrong parent is
    // only reachable through a diamond, so a property test that only ever walked a straight line
    // would not cover the case the keyframe-at-a-branch rule exists for.
    let branched = false;
    if (round % 2 === 0 && length >= 3) {
      const at = 1 + next(length - 2);
      const side = {
        keyframeInterval: interval,
        head: models[at].id,
        commits: core.deepCopy(history.commits).slice(0, at + 1),
      };
      const sideModel = core.deepCopy(models[at].model);
      M.insert(sideModel, 'control', { id: `side-${round}`, name: 'side', status: 'planned' });
      const sideResult = vcs.commit(side, sideModel, BOB, 'side edit', {
        timestamp: new Date(Date.UTC(2020, 5, 1, 0, 0, round)).toISOString(),
      });
      assert.equal(sideResult.ok, true, sideResult.message);
      for (const c of side.commits) if (!vcs.commitById(history, c.id)) history.commits.push(c);
      vcs.invalidate(history);

      // The resolution is the union, so it differs from both parents and the merge is not a no-op.
      const resolution = core.deepCopy(models[length].model);
      M.insert(resolution, 'control', { id: `side-${round}`, name: 'side', status: 'planned' });
      const merge = vcs.mergeCommit(history, resolution, [models[length].id, sideResult.commit.id], ALICE, 'merge');
      assert.ok(merge, 'the merge was built');
      models.push({ id: merge.id, model: resolution });
      branched = true;

      // Both parents are still reachable and still reconstruct, which is what a merge must not cost.
      assert.equal(vcs.verifyChain(history).ok, true, `round ${round}: the merged history is well formed`);
    }

    for (const entry of models) {
      const reconstructed = vcs.materialize(history, entry.id);
      assert.equal(
        vcs.modelHashOf(reconstructed),
        vcs.commitById(history, entry.id).modelHash,
        `round ${round}: commit ${entry.id} reconstructs to the model it recorded`,
      );
      same(reconstructed, entry.model, `round ${round}: reconstructed model equals what was committed`);
    }
    t.diagnostic(`round ${round}: ${models.length} commits, interval ${interval}${branched ? ', merged' : ''}`);
  }

  // The materialization cache lives beside the history and is the one part of reconstruction that can
  // return the *wrong* model rather than a missing one — a cached value served after the history
  // moved. It is checked here because the failure is invisible from every other angle.
  const cache = vcs.initHistory(newModel('Cache'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const first = vcs.materialize(cache, cache.head);
  const one = withControls(first, 1, 'a');
  const c1 = vcs.commit(cache, one, ALICE, 'one', { timestamp: '2020-01-02T00:00:00.000Z' }).commit;
  assert.equal(vcs.materialize(cache, c1.id).controls.length, 1, 'appending invalidated the cache');

  // A returned model is a copy: mutating it must not poison the next reconstruction.
  const copy = vcs.materialize(cache, c1.id);
  copy.name = 'mutated in place';
  assert.equal(vcs.materialize(cache, c1.id).name, one.name, 'reconstruction hands out a copy');
});

specTest('vcs.delta-storage', () => {
  // REQ-VCS-005: history is stored as deltas with periodic keyframes. The keyframe rules are part of
  // the requirement's acceptance criteria, so each of the four is asserted directly rather than
  // inferred from what a run happened to produce.
  const interval = 3;
  const { history } = linearHistory(7, interval);
  const commits = vcs.topoSort(history);

  assert.equal(commits[0].isKeyframe, true, 'rule 1: a root commit is a keyframe');
  assert.equal(commits[0].delta, null);
  assert.ok(core.isObject(commits[0].snapshot));

  // Rule 4: every `interval` commits.
  for (let i = 0; i < commits.length; i++) {
    const distance = vcs.commitsSinceKeyframe(history, commits[i].id);
    assert.ok(distance < interval, `commit ${i} is within ${interval} of a keyframe (distance ${distance})`);
  }

  const deltas = commits.filter((c) => !c.isKeyframe);
  assert.ok(deltas.length > 0, 'most commits are deltas');
  for (const c of deltas) {
    assert.ok(core.isArray(c.delta) && c.delta.length > 0, 'a delta commits a non-empty patch');
    assert.equal(c.snapshot, null, 'and carries no snapshot');
    for (const op of c.delta) assert.ok(['add', 'remove', 'replace'].indexOf(op.op) !== -1, op.op);
  }

  // Rule 3: a delta at least as large as the snapshot is stored as a snapshot instead.
  //
  // Note what does *not* trigger this. A single field rewritten with a large value produces a delta
  // of one op — `{op:"replace",path:"/description",value:"…"}` — which is *smaller* than the snapshot,
  // because the snapshot carries that same value plus the rest of a mostly-empty model. The rule bites
  // when nearly every top-level field changes at once and the patch's per-op path overhead is what
  // tips it over.
  const history2 = vcs.initHistory(newModel('Big'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const big = M.createEmpty('Big', history2.commits[0].modelId);
  const kinds = [
    'trustZone', 'trustBoundary', 'component', 'actor', 'dataStore', 'dataSet', 'asset', 'dataFlow',
    'threat', 'threatPersona', 'control', 'risk', 'assumption', 'diagram',
  ];
  for (const kind of kinds) M.insert(big, kind, { id: `${kind}-1`, name: `${kind} one` });
  big.description = 'A description';
  const bigCommit = vcs.commit(history2, big, ALICE, 'rewrite', { timestamp: '2020-01-02T00:00:00.000Z' }).commit;
  const ops = vcs.diff(history2.commits[0].snapshot, big, '', []);
  assert.ok(
    core.utf8Length(canonical.serialize(ops)) >= core.utf8Length(canonical.serialize(big)),
    'the patch really is at least as large as the snapshot',
  );
  assert.equal(bigCommit.isKeyframe, true, 'rule 3: an oversized delta becomes a keyframe');
  assert.ok(core.isObject(bigCommit.snapshot));

  // And the rule is stated directly, so the thresholds are visible rather than emergent.
  assert.equal(vcs.shouldKeyframe({ parents: [] }, { deltaBytes: 0, snapshotBytes: 100, sinceKeyframe: 0, interval: 50 }), true);
  assert.equal(vcs.shouldKeyframe({ parents: ['a', 'b'] }, { deltaBytes: 0, snapshotBytes: 100, sinceKeyframe: 0, interval: 50 }), true);
  assert.equal(vcs.shouldKeyframe({ parents: ['a'] }, { deltaBytes: 100, snapshotBytes: 100, sinceKeyframe: 0, interval: 50 }), true);
  assert.equal(vcs.shouldKeyframe({ parents: ['a'] }, { deltaBytes: 99, snapshotBytes: 100, sinceKeyframe: 0, interval: 50 }), false);
  assert.equal(vcs.shouldKeyframe({ parents: ['a'] }, { deltaBytes: 1, snapshotBytes: 100, sinceKeyframe: 50, interval: 50 }), true);
  assert.equal(vcs.shouldKeyframe({ parents: ['a'] }, { deltaBytes: 1, snapshotBytes: 100, sinceKeyframe: 49, interval: 50 }), false);
});

specTest('vcs.keyframe-at-branch', () => {
  // REQ-VCS-005's rules 2 and 3, from the other side: a merge commit is always a keyframe, so a
  // reconstruction never has to walk a diamond, and a branch point is where a delta would otherwise
  // have two possible parents to apply against.
  const { history, models } = linearHistory(2, 50);
  const base = vcs.materialize(history, history.head);

  // Two branches from the same base, each with its own commit.
  const left = core.deepCopy(history);
  const leftModel = withControls(base, 1, 'left');
  const leftCommit = commitAt(left, leftModel, '2020-02-01T00:00:00.000Z', ALICE, 'left');
  const right = core.deepCopy(history);
  const rightModel = withControls(base, 1, 'right');
  const rightCommit = commitAt(right, rightModel, '2020-02-02T00:00:00.000Z', BOB, 'right');

  // Put both branches in one history, so a merge can be built.
  for (const c of right.commits) {
    if (!vcs.commitById(left, c.id)) left.commits.push(c);
  }
  vcs.invalidate(left);

  const merged = core.deepCopy(base);
  M.insert(merged, 'control', { id: 'left-0', name: 'left 0', status: 'planned' });
  M.insert(merged, 'control', { id: 'right-0', name: 'right 0', status: 'planned' });

  const merge = vcs.mergeCommit(left, merged, [leftCommit.id, rightCommit.id], ALICE, 'merge', {
    timestamp: '2020-03-01T00:00:00.000Z',
  });
  assert.equal(merge.isKeyframe, true, 'a merge commit is always a keyframe');
  assert.equal(merge.delta, null);
  assert.ok(core.isObject(merge.snapshot));
  assert.equal(merge.parents.length, 2);
  assert.equal(vcs.materialize(left, merge.id).name, base.name);

  // A keyframe at a branch point is what makes each branch independently reconstructible: the
  // left branch never has to materialize anything from the right one.
  const leftOnly = { keyframeInterval: 50, head: leftCommit.id, commits: core.deepCopy(history.commits).concat([leftCommit]) };
  assert.equal(vcs.verifyChain(leftOnly).ok, true);
  assert.equal(vcs.materialize(leftOnly, leftCommit.id).controls.length, base.controls.length + 1);
});

specTest('vcs.ancestry-ordering', () => {
  // REQ-VCS-008, and I2. "Newer" means "descends from", and nothing else. The log is ordered by
  // depth, not by timestamp.
  const { history } = linearHistory(4);
  const commits = vcs.topoSort(history);
  const ids = commits.map((c) => c.id);

  assert.equal(vcs.isAncestor(history, ids[0], ids[4]), true, 'the root is an ancestor of the head');
  assert.equal(vcs.isAncestor(history, ids[4], ids[0]), false);
  assert.equal(vcs.isAncestor(history, ids[2], ids[2]), true, 'a commit is its own ancestor');
  assert.equal(vcs.compare(history, ids[2], ids[4]), vcs.B_NEWER);
  assert.equal(vcs.compare(history, ids[4], ids[2]), vcs.A_NEWER);
  assert.equal(vcs.compare(history, ids[3], ids[3]), vcs.IDENTICAL);

  const log = vcs.log(history);
  assert.equal(log.length, 5, 'every reachable commit is in the log');
  assert.equal(log[0].isHead, true, 'newest first');
  assert.equal(log[log.length - 1].isRoot, true);
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i - 1].depth >= log[i].depth, 'ordered by depth, descending');
  }
  const depths = vcs.depths(history);
  assert.equal(depths[ids[4]], 4);
  assert.equal(depths[ids[0]], 0);

  // Two commits at the same depth on divergent branches have no true order between them; the log
  // must still be *stable*, which is what makes a list that does not shuffle under the reader.
  const { history: h2 } = linearHistory(1, 50);
  const base = vcs.materialize(h2, h2.head);
  const leftModel = withControls(base, 1, 'l');
  const rightModel = withControls(base, 1, 'r');
  const leftH = core.deepCopy(h2);
  const rightH = core.deepCopy(h2);
  const lc = commitAt(leftH, leftModel, '2030-01-01T00:00:00.000Z', ALICE, 'l');
  const rc = commitAt(rightH, rightModel, '1990-01-01T00:00:00.000Z', BOB, 'r');
  assert.equal(vcs.compare(leftH, lc.id, rc.id), vcs.DIVERGED, 'neither descends from the other');
  for (const c of rightH.commits) if (!vcs.commitById(leftH, c.id)) leftH.commits.push(c);
  vcs.invalidate(leftH);
  const logA = vcs.log(leftH).map((e) => e.commit.id);
  const logB = vcs.log(leftH).map((e) => e.commit.id);
  same(logA, logB, 'the same history logs the same order every time');
});

specTest('vcs.clock-skew-ignored', () => {
  // REQ-VCS-007. The timestamps here are deliberately absurd in both directions. If any comparison
  // in this file read a timestamp, one of these would come out backwards.
  const history = vcs.initHistory(newModel('Skew'), ALICE, 'root', { timestamp: '2039-12-31T23:59:59.000Z' });
  const root = history.head;
  const working = withControls(vcs.materialize(history, root), 1, 'future');
  // The *child* claims to have been written in 1970, thirty years before its parent.
  const child = vcs.commit(history, working, ALICE, 'past', { timestamp: '1970-01-01T00:00:00.000Z' }).commit;

  assert.equal(vcs.compare(history, root, child.id), vcs.B_NEWER, 'descendant is newer despite a 1970 clock');
  assert.equal(vcs.compare(history, child.id, root), vcs.A_NEWER);
  assert.equal(vcs.isAncestor(history, root, child.id), true);

  const log = vcs.log(history);
  same(log.map((e) => e.commit.id), [child.id, root], 'the log puts the descendant first');

  // And the timestamps are still *stored*, because they are displayed — they are just not decisive.
  assert.equal(child.timestamp, '1970-01-01T00:00:00.000Z');

  // Two unrelated roots with the newer timestamp is still DIVERGED, never "a is newer".
  const other = vcs.initHistory(newModel('Other'), BOB, 'root', { timestamp: '2040-01-01T00:00:00.000Z' });
  assert.equal(vcs.compare(history, root, other.head), vcs.DIVERGED);
  assert.equal(vcs.sharesHistory(history, other), false);
});

specTest('vcs.commit-explicit', () => {
  // REQ-VCS-004: commits capture the working copy, and an empty commit is refused. The refusal is
  // the interesting half — an empty commit is identical to its parent, which is noise in the log and
  // an oddity in a hash chain.
  const history = vcs.initHistory(newModel('Explicit'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const head = vcs.materialize(history, history.head);
  assert.equal(vcs.isDirty(history, head), false);

  const empty = vcs.commit(history, core.deepCopy(head), ALICE, 'nothing');
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
  assert.equal(history.commits.length, 1, 'nothing was appended');

  const changed = withControls(head, 1, 'a');
  assert.equal(vcs.isDirty(history, changed), true);
  const result = vcs.commit(history, changed, ALICE, 'a change');
  assert.equal(result.ok, true);
  assert.equal(history.head, result.commit.id);
  assert.equal(history.commits.length, 2);
  assert.equal(vcs.isDirty(history, changed), false, 'committing clears the dirty state');
  assert.equal(vcs.headModel(history).controls.length, head.controls.length + 1);

  // `allowEmpty` exists for the one case that needs it, and is off by default.
  const forced = vcs.commit(history, core.deepCopy(changed), ALICE, 'deliberate no-op', { allowEmpty: true });
  assert.equal(forced.ok, true);
  assert.notEqual(forced.commit.id, result.commit.id, 'a different timestamp is a different commit');
});

specTest('vcs.commit-message-required', () => {
  // REQ-VCS-015. A message is required and a missing one is normalised to the empty string rather
  // than stored as undefined — because `message` is a hash input, and `undefined` is omitted from
  // the canonical serialization while `""` is not. The two would be different commits and only one
  // of them could be reconstructed from a file.
  const history = vcs.initHistory(newModel('Messages'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const one = withControls(vcs.materialize(history, history.head), 1, 'm');

  const blank = vcs.commit(history, one, ALICE, '', { timestamp: '2020-01-02T00:00:00.000Z' }).commit;
  assert.equal(blank.message, '');
  assert.equal(vcs.commitPayload(blank).message, '');

  const made = vcs.makeCommit({ parents: [], modelId: one.modelId, author: ALICE, timestamp: 'x', message: undefined, modelHash: 'sha256:' + '0'.repeat(64), isKeyframe: true, snapshot: {} });
  assert.equal(made.message, '');
  assert.equal(vcs.commitIdOf(made), vcs.commitIdOf({ ...made, message: '' }), 'undefined and empty are one commit');

  // The author is normalised the same way, for the same reason.
  const anon = vcs.makeCommit({ parents: [], modelId: one.modelId, author: null, timestamp: 'x', message: 'm', modelHash: 'sha256:' + '0'.repeat(64), isKeyframe: true, snapshot: {} });
  same(anon.author, { name: '', email: '' });
  assert.equal(anon.id, vcs.commitIdOf({ ...anon, author: { name: '', email: '' } }));

  // REQ-VCS-015 AC1 — "committing with an empty message is refused" — lives in the commit dialog, not
  // in `vcs.commit`: the dialog is where a person can still type one, so it is where the refusal can
  // say so. The button is disabled until there is a message, and clicking a disabled button is what
  // makes the refusal hold for a mouse and not only for a keyboard.
  const { dom, TMV: shellTMV, shell } = loadShell({});
  const working = core.deepCopy(shell.state().model);
  shellTMV.model.insert(working, 'control', { id: 'msg-1', name: 'Msg', status: 'planned' });
  shell.edit(working, { label: 'An edit' });
  const before = shell.state().history.commits.length;

  const dialog = shell.commit();
  assert.ok(dialog, 'the commit dialog opened');
  const confirm = dom.body.querySelector('[data-action="commit"]');
  assert.ok(confirm, 'it has a Commit button');
  assert.notEqual(confirm.getAttribute('disabled'), null, 'which starts disabled, because the message is empty');
  confirm.click();
  assert.equal(shell.state().history.commits.length, before, 'the refused commit changed nothing');
  assert.equal(shell.isDirty(), true, 'and the edit is still uncommitted');

  // Whitespace is not a message either.
  dialog.message.setValue('   ');
  dialog.message.control.dispatch('input');
  assert.notEqual(confirm.getAttribute('disabled'), null, 'whitespace does not enable it');

  dialog.message.setValue('Something happened');
  dialog.message.control.dispatch('input');
  assert.equal(confirm.getAttribute('disabled'), null, 'a real message does');
  confirm.click();
  assert.equal(shell.state().history.commits.length, before + 1);
  const last = shell.state().history.commits[shell.state().history.commits.length - 1];
  assert.equal(last.message, 'Something happened');
  same(last.author, { name: '', email: '' }, 'the author is whatever the stored identity says, and none is set here');
});

specTest('vcs.identity-change-forward-only', () => {
  // REQ-VCS-015's other half: changing who you are applies to commits made *after* the change. Past
  // commits keep the author they were made with, because the author is a hash input and rewriting it
  // would rewrite history.
  const history = vcs.initHistory(newModel('Identity'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const firstId = history.head;
  const one = withControls(vcs.materialize(history, history.head), 1, 'i');
  const second = vcs.commit(history, one, ALICE, 'as alice', { timestamp: '2020-01-02T00:00:00.000Z' }).commit;
  const two = withControls(one, 1, 'j');
  const third = vcs.commit(history, two, BOB, 'as bob', { timestamp: '2020-01-03T00:00:00.000Z' }).commit;

  assert.equal(vcs.commitById(history, firstId).author.name, 'Alice');
  assert.equal(second.author.name, 'Alice');
  assert.equal(third.author.name, 'Bob');
  assert.equal(vcs.verifyChain(history).ok, true, 'the earlier commits still hash to their ids');

  // The model does not learn who it is; identity lives in the commit and nowhere else.
  assert.equal(vcs.materialize(history, third.id).modelId, history.commits[0].modelId);
  assert.equal(JSON.stringify(vcs.materialize(history, third.id)).indexOf('Bob'), -1, 'identity is not written into the model');
});

specTest('vcs.merge-base-lca', () => {
  // REQ-VCS-010. The merge base is the deepest common ancestor, found by ancestry alone.
  const { history } = linearHistory(3);
  const commits = vcs.topoSort(history);
  const [root, a, b, c] = commits;

  assert.equal(vcs.mergeBase(history, c.id, b.id).base, b.id, 'a direct parent');
  assert.equal(vcs.mergeBase(history, c.id, a.id).base, a.id);
  assert.equal(vcs.mergeBase(history, c.id, root.id).base, root.id);
  assert.equal(vcs.mergeBase(history, c.id, c.id).base, c.id, 'the LCA of a commit with itself is itself');

  // Divergent branches sharing a base. The branches are cut back to `b`, because a branch taken from
  // the *head* of the linear run would have `c` as its base and would not exercise the case at all.
  const base = vcs.materialize(history, b.id);
  const truncateTo = (source, id) => {
    const cut = core.deepCopy(source);
    // `isAncestor` is reflexive, so this keeps the commit itself as well as its ancestors.
    cut.commits = cut.commits.filter((commit) => vcs.isAncestor(source, commit.id, id));
    cut.head = id;
    vcs.invalidate(cut);
    return cut;
  };
  const leftH = truncateTo(history, b.id);
  const rightH = truncateTo(history, b.id);
  const l = commitAt(leftH, withControls(base, 1, 'l'), '2021-01-01T00:00:00.000Z', ALICE, 'l');
  const r = commitAt(rightH, withControls(base, 1, 'r'), '2021-01-02T00:00:00.000Z', BOB, 'r');
  for (const cm of rightH.commits) if (!vcs.commitById(leftH, cm.id)) leftH.commits.push(cm);
  vcs.invalidate(leftH);
  const found = vcs.mergeBase(leftH, l.id, r.id);
  assert.equal(found.base, b.id);
  assert.equal(found.multiple, false);
  same(found.candidates, [b.id]);

  // Unrelated histories have no base at all, which is what stops them being merged.
  const other = vcs.initHistory(newModel('Unrelated'), BOB, 'root');
  const none = vcs.commonAncestors(other, other.head, l.id);
  same(none.bases, []);
  assert.equal(vcs.mergeBase(leftH, vcs.commitById(leftH, l.id).id, 'sha256:' + '0'.repeat(64)).base, null);
});

specTest('vcs.criss-cross-disclosure', () => {
  // REQ-VCS-010 AC1: where there is more than one lowest common ancestor, the fact is disclosed
  // rather than resolved silently. Recursive virtual merge bases are deliberately not implemented,
  // and the disclosure is what makes that honest.
  const history = vcs.initHistory(newModel('Criss'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const root = vcs.materialize(history, history.head);

  // The classic criss-cross: A and B branch from the root; each merges the other; the two merges are
  // the heads, and both are lowest common ancestors of each other.
  const aModel = withControls(root, 1, 'a');
  const bModel = withControls(root, 1, 'b');
  const a = vcs.makeCommit({
    parents: [history.head],
    modelId: root.modelId,
    author: ALICE,
    timestamp: '2020-01-02T00:00:00.000Z',
    message: 'A',
    modelHash: vcs.modelHashOf(aModel),
    isKeyframe: true,
    snapshot: aModel,
  });
  const b = vcs.makeCommit({
    parents: [history.head],
    modelId: root.modelId,
    author: BOB,
    timestamp: '2020-01-03T00:00:00.000Z',
    message: 'B',
    modelHash: vcs.modelHashOf(bModel),
    isKeyframe: true,
    snapshot: bModel,
  });
  const both = core.deepCopy(root);
  M.insert(both, 'control', { id: 'a-0', name: 'a 0', status: 'planned' });
  M.insert(both, 'control', { id: 'b-0', name: 'b 0', status: 'planned' });
  const ab = vcs.makeCommit({
    parents: [a.id, b.id],
    modelId: root.modelId,
    author: ALICE,
    timestamp: '2020-01-04T00:00:00.000Z',
    message: 'A merges B',
    modelHash: vcs.modelHashOf(both),
    isKeyframe: true,
    snapshot: both,
  });
  const ba = vcs.makeCommit({
    parents: [b.id, a.id],
    modelId: root.modelId,
    author: BOB,
    timestamp: '2020-01-05T00:00:00.000Z',
    message: 'B merges A',
    modelHash: vcs.modelHashOf(both),
    isKeyframe: true,
    snapshot: both,
  });

  const criss = { keyframeInterval: 50, head: ab.id, commits: [history.commits[0], a, b, ab, ba] };
  vcs.invalidate(criss);
  assert.equal(vcs.verifyChain(criss).ok, true, `the criss-cross history is well formed`);

  const found = vcs.commonAncestors(criss, ab.id, ba.id);
  assert.equal(found.multiple, true, 'two lowest common ancestors');
  same(found.bases, [a.id, b.id].sort());
  const base = vcs.mergeBase(criss, ab.id, ba.id);
  assert.equal(base.multiple, true, 'and the choice is disclosed');
  assert.equal(base.candidates.length, 2);
  assert.equal(base.base, base.candidates[0], 'one is picked, deterministically');
  assert.equal(vcs.compare(criss, ab.id, ba.id), vcs.DIVERGED, 'neither merge contains the other');
});

specTest('vcs.merge-two-parents', () => {
  // REQ-VCS-011: a merge records both parents, both stay reachable, and nothing is discarded.
  const { history } = linearHistory(1, 50);
  const root = vcs.materialize(history, history.head);
  const leftH = core.deepCopy(history);
  const rightH = core.deepCopy(history);
  const left = commitAt(leftH, withControls(root, 1, 'l'), '2021-01-01T00:00:00.000Z', ALICE, 'left');
  const right = commitAt(rightH, withControls(root, 1, 'r'), '2021-01-02T00:00:00.000Z', BOB, 'right');
  for (const c of rightH.commits) if (!vcs.commitById(leftH, c.id)) leftH.commits.push(c);
  vcs.invalidate(leftH);

  const resolved = withControls(withControls(root, 1, 'l'), 1, 'r');
  const merge = vcs.mergeCommit(leftH, resolved, [left.id, right.id], ALICE, 'merge');
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.isKeyframe, true, 'rule 2: a merge is a keyframe, so no delta crosses a diamond');
  assert.equal(vcs.verifyChain(leftH).ok, true);

  // Both original heads are reachable from the merge, so neither branch's work is lost.
  const reachable = vcs.reachableFrom(leftH, merge.id);
  assert.equal(reachable[left.id], true);
  assert.equal(reachable[right.id], true);
  assert.equal(reachable[history.head], true);
  const kept = vcs.log(leftH).map((e) => e.commit.id);
  assert.ok(kept.indexOf(left.id) !== -1 && kept.indexOf(right.id) !== -1);

  // Parent order is normalised, so the same merge declared either way is one commit id.
  const other = vcs.mergeCommit(core.deepCopy(leftH), resolved, [right.id, left.id], ALICE, 'merge', {
    timestamp: merge.timestamp,
  });
  assert.equal(other.id, merge.id, 'parent order is not part of a merge identity');

  // The materialized merge is exactly the resolution that was confirmed — this is the one commit
  // whose model is not derived from a parent.
  same(vcs.materialize(leftH, merge.id), resolved);
  assert.equal(vcs.verifyModel(leftH, merge.id).ok, true);
});

specTest('vcs.revert-forward-only', () => {
  // REQ-VCS-013. A revert is a new commit whose model equals an earlier commit's. Every commit id
  // ever issued stays valid; nothing is rewritten.
  const { history, models } = linearHistory(3);
  const commits = vcs.topoSort(history);
  const before = commits.map((c) => c.id);

  const revert = vcs.revertTo(history, commits[1].id, BOB, 'go back');
  assert.equal(history.commits.length, 5, 'a commit was added, none removed');
  assert.equal(vcs.headModel(history).controls.length, models[1].controls.length);
  same(history.commits.slice(0, 4).map((c) => c.id), before, 'every earlier commit is untouched');
  assert.equal(revert.parents.length, 1);
  assert.equal(revert.parents[0], commits[3].id, 'it descends from the head it reverted');
  assert.equal(vcs.verifyChain(history).ok, true);
  assert.equal(vcs.verifyModel(history, revert.id).ok, true);

  // Reverting to a commit that is not in the history is refused, not guessed at.
  assert.throws(() => vcs.revertTo(history, 'sha256:' + '0'.repeat(64), ALICE, 'nope'), /No commit/);

  // And the default message names the commit it went back to, so the log explains itself.
  const auto = vcs.revertTo(history, commits[0].id, ALICE);
  assert.match(auto.message, /^Revert to /);
});

specTest('vcs.undo-scope', () => {
  // REQ-VCS-014. Undo operates on the working copy and never on committed history: pressing undo
  // after a commit must not walk the history backwards.
  const { dom, TMV: shellTMV, shell } = loadShell({});
  const forms = shellTMV.forms;
  const before = shell.state().model.controls.length;

  const edited = core.deepCopy(shell.state().model);
  shellTMV.model.insert(edited, 'control', { id: 'undo-me', name: 'Undo me', status: 'planned' });
  shell.edit(edited, { label: 'Add a control' });
  assert.equal(shell.state().model.controls.length, before + 1);
  assert.equal(shell.isDirty(), true);

  shell.undo();
  assert.equal(shell.state().model.controls.length, before, 'undo restored the working copy');
  assert.equal(shell.isDirty(), false, 'and the model is back to what the head holds');

  // The depth is bounded, and it is *not* cleared by editing again — only by the history moving.
  assert.ok(forms.UNDO_LIMIT > 0);
  for (let i = 0; i < forms.UNDO_LIMIT + 5; i++) {
    const m = core.deepCopy(shell.state().model);
    shellTMV.model.insert(m, 'control', { id: `bulk-${i}`, name: `Bulk ${i}`, status: 'planned' });
    shell.edit(m, { label: `Edit ${i}` });
  }
  let undone = 0;
  while (shell.undo()) undone++;
  assert.equal(undone, forms.UNDO_LIMIT, 'the stack is bounded by UNDO_LIMIT');

  // Committing clears it. The stack's entries describe a model that is now a commit of its own, so
  // leaving them would let a single undo silently revert a commit — which is the AC, stated the other
  // way round: undo after a commit does not un-commit.
  const m2 = core.deepCopy(shell.state().model);
  shellTMV.model.insert(m2, 'assumption', { id: 'committed', name: 'Committed', validity: 'unconfirmed' });
  shell.edit(m2, { label: 'Before commit' });

  const headBefore = shell.state().history.head;
  const depthBefore = forms.undo.depth();
  assert.ok(depthBefore > 0, 'there is something to undo before the commit');

  const dialog = shell.commit();
  assert.ok(dialog, 'the commit dialog opened');
  const confirm = dom.body.querySelector('[data-action="commit"]');
  dialog.message.setValue('A commit');
  dialog.message.control.dispatch('input');
  confirm.click();

  assert.notEqual(shell.state().history.head, headBefore, 'the commit moved the head');
  const headAfterCommit = shell.state().history.head;
  assert.equal(forms.undo.depth(), 0, 'the undo stack was cleared by the commit');
  assert.equal(shell.undo(), false, 'undo after a commit does nothing');
  assert.equal(shell.state().history.head, headAfterCommit, 'and the head is where the commit put it');
  assert.equal(dom.getElementById('tmv-dirty').hasAttribute('hidden'), true);
});

specTest('vcs.dirty-blocks-merge', () => {
  // REQ-VCS-012: uncommitted changes block a merge, and the refusal says why. The reason is that a
  // merge resolved against edits that are in neither history would write over them.
  const base = vcs.initHistory(newModel('Dirty'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const root = vcs.materialize(base, base.head);
  const other = core.deepCopy(base);
  const otherCommit = commitAt(other, withControls(root, 1, 'o'), '2021-01-01T00:00:00.000Z', BOB, 'theirs');
  for (const c of other.commits) if (!vcs.commitById(base, c.id)) base.commits.push(c);
  vcs.invalidate(base);

  const plan = TMV.compare.plan(base, base.head, otherCommit.id, { workingDirty: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'dirty');
  assert.match(plan.message, /uncommitted changes/);
  assert.match(plan.message, /Commit, stash or discard/);

  // With a clean working copy the same comparison is planned.
  const clean = TMV.compare.plan(base, base.head, otherCommit.id, { workingDirty: false });
  assert.equal(clean.ok, true, clean.message);

  // The other refusals, which have to produce sentences rather than an empty screen: two histories
  // that share nothing, no history at all, and a head that is not in the history it names.
  const unrelated = vcs.initHistory(newModel('A'), ALICE, 'root');
  const stranger = vcs.initHistory(newModel('B'), BOB, 'root');
  for (const c of stranger.commits) if (!vcs.commitById(unrelated, c.id)) unrelated.commits.push(c);
  vcs.invalidate(unrelated);

  const noBase = TMV.compare.plan(unrelated, unrelated.commits[0].id, unrelated.commits[1].id, {});
  assert.equal(noBase.ok, false);
  assert.equal(noBase.reason, 'unrelated');
  assert.ok(noBase.message.length > 20, noBase.message);

  const noHistory = TMV.compare.plan(null, null, null, {});
  assert.equal(noHistory.ok, false);
  assert.equal(noHistory.reason, 'history');

  const noHead = TMV.compare.plan(unrelated, 'sha256:' + '0'.repeat(64), unrelated.commits[0].id, {});
  assert.equal(noHead.ok, false);
  assert.ok(noHead.message.length > 10);
});

specTest('vcs.divergence.no-auto-merge', () => {
  // REQ-VCS-009. Divergence produces a prompt, never a merge. `compare.plan` describes what a merge
  // would do and never performs one; nothing in it writes to the history it was handed.
  const base = vcs.initHistory(newModel('Diverge'), ALICE, 'root', { timestamp: '2020-01-01T00:00:00.000Z' });
  const rootCommit = base.head;
  const root = vcs.materialize(base, base.head);
  const other = core.deepCopy(base);
  const theirs = commitAt(other, withControls(root, 1, 'theirs'), '2021-01-01T00:00:00.000Z', BOB, 'theirs');
  const mine = commitAt(base, withControls(root, 1, 'mine'), '2021-01-02T00:00:00.000Z', ALICE, 'mine');
  for (const c of other.commits) if (!vcs.commitById(base, c.id)) base.commits.push(c);
  vcs.invalidate(base);

  const beforeHead = base.head;
  const beforeCount = base.commits.length;
  const plan = TMV.compare.plan(base, mine.id, theirs.id, {});
  assert.equal(plan.ok, true, plan.message);
  assert.equal(plan.base.id, rootCommit, 'the merge base was found');

  // The plan is a description. It has not touched the history, and there is no path from here to a
  // merge without an explicit confirmation.
  assert.equal(base.head, beforeHead);
  assert.equal(base.commits.length, beforeCount);
  assert.equal(vcs.compare(base, mine.id, theirs.id), vcs.DIVERGED);

  // A merge only exists once it is built explicitly, and it needs a resolution.
  const merged = vcs.mergeCommit(base, withControls(withControls(root, 1, 'theirs'), 1, 'mine'), [mine.id, theirs.id], ALICE, 'merged');
  assert.equal(base.commits.length, beforeCount + 1);
  assert.equal(base.head, merged.id);
});
