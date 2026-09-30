/* 06-vcs.js — the history model: commit hashing, delta/keyframe storage, verification, ordering,
 * merge bases, revert and compaction (`04-versioning.md`, ADR-0005, ADR-0003).
 *
 * This is the part of the system with the least room for error. Everything else can be re-rendered; a
 * bug here loses work. Two invariants hold everywhere in this file and are worth stating before the
 * code, because almost every subtle mistake here is a violation of one of them:
 *
 *   I1 — **A commit id covers the model and the commit message, never the storage representation.**
 *        `snapshot` and `delta` are not hash inputs. That is what lets compaction and re-keyframing
 *        run without rewriting ids (`03-data-model.md` §7).
 *   I2 — **Ordering is ancestry only.** `timestamp` is hashed, displayed, and never consulted to
 *        decide which of two histories is newer (`04-versioning.md` §4). A wrong client clock must not
 *        be able to win a reconcile, because that failure is invisible until the work is gone.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var TmvError = TMV.error;
  var canonical = TMV.canonical;
  var hash = TMV.hash;

  // ---------------------------------------------------------------------------------------------
  // Hashing (`03-data-model.md` §7, `04-versioning.md` §2)
  // ---------------------------------------------------------------------------------------------

  /** `sha256:` over the canonical serialization of a model. */
  function modelHashOf(model) {
    return hash.contentAddress(canonical.serialize(model));
  }

  /**
   * The exact object whose canonical serialization is a commit's identity.
   *
   * Kept as its own function because it is the specification, and a test can assert the shape directly
   * rather than inferring it from a hash. Note what is absent: `isKeyframe`, `snapshot`, `delta`.
   */
  function commitPayload(commit) {
    return {
      parents: sortedParents(commit.parents),
      modelId: commit.modelId,
      author: commit.author,
      timestamp: commit.timestamp,
      message: commit.message,
      modelHash: commit.modelHash,
    };
  }

  /** Parent ids, sorted — so the same merge declared in either order is the same commit. */
  function sortedParents(parents) {
    var list = core.isArray(parents) ? parents.slice() : [];
    list.sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return list;
  }

  /** A commit's id, recomputed from its stored fields. */
  function commitIdOf(commit) {
    return hash.contentAddress(canonical.serialize(commitPayload(commit)));
  }

  // ---------------------------------------------------------------------------------------------
  // RFC 6902 JSON Patch
  //
  // Enough of the specification to store deltas: add, remove, replace, move, copy, test. Generation
  // only ever produces add/remove/replace, but the reader accepts the whole set so a delta written by
  // another implementation still applies.
  // ---------------------------------------------------------------------------------------------

  var OPERATIONS = ['add', 'remove', 'replace', 'move', 'copy', 'test'];

  function pointerTokens(pointer) {
    if (pointer === '' || pointer === '/') return [];
    var raw = pointer.charAt(0) === '/' ? pointer.slice(1) : pointer;
    var parts = raw.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) out.push(canonical.unescapePointer(parts[i]));
    return out;
  }

  function pointerOf(tokens) {
    var out = '';
    for (var i = 0; i < tokens.length; i++) out += '/' + canonical.escapePointer(tokens[i]);
    return out;
  }

  function resolveParent(doc, tokens) {
    var node = doc;
    for (var i = 0; i < tokens.length - 1; i++) {
      if (node === null || typeof node !== 'object') {
        throw TmvError('PATCH_PATH', 'Cannot walk through a scalar at ' + pointerOf(tokens.slice(0, i + 1)));
      }
      node = node[tokens[i]];
    }
    return node;
  }

  /**
   * Apply an RFC 6902 patch. Mutates and returns `doc`, so callers pass a copy when they need the
   * original.
   *
   * Every failure is a `TmvError` naming the operation and pointer: a corrupted delta must produce an
   * explanation, never a half-applied model (`04-versioning.md` §3, REQ-VCS-006).
   */
  function applyPatch(doc, ops) {
    if (!core.isArray(ops)) throw TmvError('PATCH_SHAPE', 'A delta must be an array of operations.');
    if (ops.length > TMV.LIMITS.patchOpRefuse) {
      throw TmvError(
        'PATCH_TOO_MANY',
        'A delta with ' + ops.length + ' operations exceeds the ' + TMV.LIMITS.patchOpRefuse +
          ' operation limit this application will apply.',
        { ops: ops.length },
      );
    }
    var out = doc;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!core.isObject(op) || OPERATIONS.indexOf(op.op) === -1) {
        throw TmvError('PATCH_OP', 'Operation ' + i + ' is not a recognised RFC 6902 operation.');
      }
      if (!core.isString(op.path)) throw TmvError('PATCH_OP', 'Operation ' + i + ' has no path.');
      var where = op.op + ' ' + op.path;
      var tokens = pointerTokens(op.path);
      var container = tokens.length ? resolveParent(out, tokens) : null;
      var last = tokens.length ? tokens[tokens.length - 1] : null;

      if (op.op === 'test') {
        var found = tokens.length ? readAt(out, tokens) : out;
        if (!core.deepEqual(found, op.value)) {
          throw TmvError('PATCH_TEST', 'Test failed at ' + op.path + '.');
        }
        continue;
      }
      if (op.op === 'remove' || op.op === 'replace') {
        if (!tokens.length) throw TmvError('PATCH_ROOT', 'Cannot ' + op.op + ' the document root.');
        removeAt(container, last, where);
        if (op.op === 'replace') addAt(container, last, core.deepCopy(op.value), where);
        continue;
      }
      if (op.op === 'move' || op.op === 'copy') {
        if (!core.isString(op.from)) throw TmvError('PATCH_OP', op.op + ' requires a from path.');
        var fromTokens = pointerTokens(op.from);
        var fromContainer = resolveParent(out, fromTokens);
        var fromLast = fromTokens[fromTokens.length - 1];
        var value = readAt(fromContainer, fromLast);
        if (op.op === 'move') {
          removeAt(fromContainer, fromLast, op.op + ' ' + op.from);
          // A move into the subtree it came from is the one case that cannot be expressed by index.
          container = tokens.length ? resolveParent(out, tokens) : null;
          last = tokens.length ? tokens[tokens.length - 1] : null;
        }
        addAt(container, last, core.deepCopy(value), where);
        continue;
      }
      // add
      if (!tokens.length) {
        out = core.deepCopy(op.value);
        continue;
      }
      addAt(container, last, core.deepCopy(op.value), where);
    }
    return out;
  }

  function readAt(container, token) {
    if (core.isArray(container)) {
      if (token === '-') throw TmvError('PATCH_PATH', 'Cannot read the append token.');
      var i = Number(token);
      return container[i];
    }
    return container[token];
  }

  function addAt(container, token, value, where) {
    if (core.isArray(container)) {
      if (token === '-') {
        container.push(value);
        return;
      }
      var i = Number(token);
      if (!isFinite(i) || i < 0) throw TmvError('PATCH_PATH', 'Bad array index in ' + where + '.');
      container.splice(i, 0, value);
      return;
    }
    if (!core.isObject(container)) throw TmvError('PATCH_PATH', 'Cannot add into a scalar at ' + where + '.');
    container[token] = value;
  }

  function removeAt(container, token, where) {
    if (core.isArray(container)) {
      var i = Number(token);
      if (!isFinite(i) || i < 0 || i >= container.length) {
        throw TmvError('PATCH_PATH', 'Array index out of range in ' + where + '.');
      }
      container.splice(i, 1);
      return;
    }
    if (!core.isObject(container)) throw TmvError('PATCH_PATH', 'Cannot remove from a scalar at ' + where + '.');
    delete container[token];
  }

  /**
   * Generate a patch that turns `base` into `next`.
   *
   * Every value is deep-copied into the patch. This is not tidiness — a patch holding a live reference
   * into the working copy is a history-corruption bug of the worst kind: the delta is stored, the user
   * keeps editing, and the stored delta's `value` silently becomes whatever the model looks like now.
   * Every later reconstruction from that delta is then wrong, and the model check reports it as
   * tampering rather than as the aliasing it actually is. `test/unit/vcs.test.mjs` pins this by committing
   * a sequence of edits and materializing every commit.
   *
   * Arrays are replaced whole rather than diffed element-wise. That is deliberate: an element-wise
   * array diff is where a patch generator most easily produces something that applies cleanly and
   * yields the wrong document (see the identity questions around reordering and duplicate values),
   * and the keyframe rules make the size cost irrelevant — a model whose arrays churn is exactly the
   * case rule 3 stores as a snapshot instead.
   */
  function diff(base, next, path, out) {
    var acc = out || [];
    var at = path || '';
    if (core.deepEqual(base, next)) return acc;

    if (core.isObject(base) && core.isObject(next)) {
      var baseKeys = core.sortedKeys(base);
      var nextKeys = core.sortedKeys(next);
      var seen = Object.create(null);
      var i;
      for (i = 0; i < nextKeys.length; i++) {
        var nk = nextKeys[i];
        seen[nk] = true;
        if (!core.has(base, nk)) {
          acc.push({ op: 'add', path: at + '/' + canonical.escapePointer(nk), value: core.deepCopy(next[nk]) });
        } else {
          diff(base[nk], next[nk], at + '/' + canonical.escapePointer(nk), acc);
        }
      }
      for (i = 0; i < baseKeys.length; i++) {
        if (!seen[baseKeys[i]]) acc.push({ op: 'remove', path: at + '/' + canonical.escapePointer(baseKeys[i]) });
      }
      return acc;
    }
    acc.push({ op: 'replace', path: at === '' ? '' : at, value: core.deepCopy(next) });
    return acc;
  }

  /** Byte size of a serialized patch, for keyframe rule 3. */
  function patchBytes(ops) {
    return core.utf8Length(canonical.serialize(ops));
  }

  // ---------------------------------------------------------------------------------------------
  // Commit construction
  // ---------------------------------------------------------------------------------------------

  function normalizeAuthor(author) {
    return {
      name: core.isObject(author) && core.isString(author.name) ? author.name : '',
      email: core.isObject(author) && core.isString(author.email) ? author.email : '',
    };
  }

  /**
   * A commit record. Exactly one of `snapshot` or `delta` is present, and `isKeyframe` says which.
   *
   * The id is computed last, from the fields and not from the storage, so this function cannot produce
   * a commit whose id disagrees with its content.
   */
  function makeCommit(fields) {
    var commit = {
      parents: sortedParents(fields.parents),
      modelId: fields.modelId,
      author: normalizeAuthor(fields.author),
      timestamp: fields.timestamp,
      message: core.isString(fields.message) ? fields.message : '',
      modelHash: fields.modelHash,
      isKeyframe: !!fields.isKeyframe,
      snapshot: fields.isKeyframe ? fields.snapshot : null,
      delta: fields.isKeyframe ? null : fields.delta,
    };
    commit.id = commitIdOf(commit);
    return commit;
  }

  /** A history with one root commit, containing `model`. Used on model creation and on import. */
  function initHistory(model, author, message, options) {
    var opts = options || {};
    var root = makeCommit({
      parents: [],
      modelId: model.modelId,
      author: author,
      timestamp: opts.timestamp || new Date().toISOString(),
      message: message,
      modelHash: modelHashOf(model),
      isKeyframe: true,
      snapshot: core.deepCopy(model),
    });
    return {
      keyframeInterval: opts.keyframeInterval || TMV.DEFAULT_KEYFRAME_INTERVAL,
      head: root.id,
      commits: [root],
    };
  }

  /** Convenience wrapper matching the name used by `04-container.js`. */
  function createRootCommit(model, author, message, options) {
    return initHistory(model, author, message, options).commits[0];
  }

  function commitById(history, id) {
    if (!history || !core.isArray(history.commits) || !core.isString(id)) return null;
    for (var i = 0; i < history.commits.length; i++) {
      if (history.commits[i] && history.commits[i].id === id) return history.commits[i];
    }
    return null;
  }

  function indexCommits(history) {
    return core.indexById(history && history.commits);
  }

  /** Commits between the nearest preceding keyframe and `id`, oldest first, keyframe included. */
  function chainToKeyframe(history, id) {
    var idx = indexCommits(history);
    var chain = [];
    var node = idx[id];
    var guard = 0;
    while (node && !node.isKeyframe) {
      chain.push(node);
      if (guard++ > TMV.LIMITS.commitWarnCount * 4) {
        throw TmvError('VCS_CYCLE', 'The history appears to contain a cycle.');
      }
      var parents = node.parents || [];
      if (parents.length > 1) {
        throw TmvError(
          'VCS_MERGE_NOT_KEYFRAME',
          'Commit ' + core.shortId(node.id) + ' has more than one parent but is not a keyframe.',
        );
      }
      node = parents.length ? idx[parents[0]] : null;
    }
    if (node) chain.push(node);
    chain.reverse();
    return chain;
  }

  // ---------------------------------------------------------------------------------------------
  // Reconstruction (`04-versioning.md` §3)
  // ---------------------------------------------------------------------------------------------

  /**
   * Materialization cache, keyed by the history object rather than stored on it.
   *
   * A `WeakMap` on the side keeps the cache out of the history itself, which matters because the
   * history is hashed and serialized: a cache property that leaked into the enumerable keys would
   * change every commit id in the model. Weak, so a discarded history does not pin its models.
   */
  var CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;

  function cacheFor(history) {
    if (!CACHE) return null;
    var map = CACHE.get(history);
    if (!map) {
      map = new Map();
      CACHE.set(history, map);
    }
    return map;
  }

  /** Drop any cached reconstruction. Called after every mutation of a history. */
  function invalidate(history) {
    if (CACHE && history) CACHE['delete'](history);
  }

  /**
   * Reconstruct the model at a commit by replaying from the nearest preceding keyframe.
   *
   * Bounded by `keyframeInterval` by construction, except where the merge and oversized-delta rules
   * inserted an earlier keyframe, which only shortens the walk.
   */
  function materialize(history, id) {
    var cache = cacheFor(history);
    if (cache && cache.has(id)) return core.deepCopy(cache.get(id));

    var chain = chainToKeyframe(history, id);
    if (!chain.length) throw TmvError('VCS_NO_COMMIT', 'No commit ' + id + ' in this history.', { id: id });
    var frame = chain[0];
    if (!core.isObject(frame.snapshot)) {
      throw TmvError('VCS_NO_KEYFRAME', 'Commit ' + core.shortId(frame.id) + ' is a keyframe but carries no snapshot.');
    }
    var model = core.deepCopy(frame.snapshot);
    for (var i = 1; i < chain.length; i++) {
      var step = chain[i];
      if (!core.isArray(step.delta)) {
        throw TmvError('VCS_NO_DELTA', 'Commit ' + core.shortId(step.id) + ' carries no delta.');
      }
      model = applyPatch(model, step.delta);
    }
    if (cache && cache.size < 64) cache.set(id, model);
    return core.deepCopy(model);
  }

  /** The model at the head. The one reconstruction that is always needed. */
  function headModel(history) {
    return materialize(history, history.head);
  }

  // ---------------------------------------------------------------------------------------------
  // Verification (`04-versioning.md` §2)
  // ---------------------------------------------------------------------------------------------

  /**
   * The chain check: always run at boot, O(N), no reconstruction.
   *
   * It catches what actually goes wrong in practice — a truncated file, a commit whose stored fields
   * no longer hash to its id, a parent that is not present. It deliberately does **not** catch a
   * snapshot rewritten in place with its id left alone, because `snapshot` is not a hash input (I1);
   * that is the model check's job, and it is only paid for the commit being displayed.
   */
  function verifyChain(history) {
    var problems = [];
    if (!core.isObject(history) || !core.isArray(history.commits)) {
      return { ok: false, problems: [{ code: 'HISTORY_SHAPE', message: 'The history is not an object with a commits array.' }] };
    }
    var idx = indexCommits(history);
    var roots = 0;
    for (var i = 0; i < history.commits.length; i++) {
      var c = history.commits[i];
      var at = '/' + i;
      if (!core.isObject(c)) {
        problems.push({ code: 'COMMIT_SHAPE', path: at, message: 'Not an object.' });
        continue;
      }
      var label = core.isString(c.id) ? c.id : at;
      if (!hash.isAddress(c.id)) {
        problems.push({ code: 'COMMIT_ID', path: at, id: label, message: 'Not a sha256 content address.' });
      } else if (commitIdOf(c) !== c.id) {
        problems.push({
          code: 'COMMIT_HASH',
          path: at,
          id: c.id,
          message: 'Commit ' + core.shortId(c.id) + ' does not hash to its own id: its stored fields have been altered.',
        });
      }
      if (!hash.isAddress(c.modelHash)) {
        problems.push({ code: 'COMMIT_MODEL_HASH', path: at, id: label, message: 'modelHash is not a content address.' });
      }
      if (!core.isArray(c.parents)) {
        problems.push({ code: 'COMMIT_PARENTS', path: at, id: label, message: 'parents is not an array.' });
      } else {
        if (c.parents.length === 0) roots++;
        for (var p = 0; p < c.parents.length; p++) {
          if (!idx[c.parents[p]]) {
            problems.push({
              code: 'COMMIT_PARENT_MISSING',
              path: at,
              id: label,
              message: 'Commit ' + core.shortId(c.id) + ' names parent ' + core.shortId(c.parents[p]) +
                ', which is not in this history. The history is truncated or was assembled from mismatched files.',
            });
          }
        }
      }
      var isFrame = core.isObject(c.snapshot);
      var isDelta = core.isArray(c.delta);
      if (isFrame === isDelta) {
        problems.push({
          code: 'COMMIT_STORAGE',
          path: at,
          id: label,
          message: 'Commit ' + core.shortId(c.id) + ' must carry exactly one of snapshot or delta; it carries ' +
            (isFrame ? 'both' : 'neither') + '.',
        });
      }
      if (c.isKeyframe !== isFrame) {
        problems.push({
          code: 'COMMIT_KEYFRAME',
          path: at,
          id: label,
          message: 'Commit ' + core.shortId(c.id) + ' is marked ' + (c.isKeyframe ? 'a keyframe' : 'a delta') +
            ' but stores a ' + (isFrame ? 'snapshot' : 'delta') + '.',
        });
      }
      if (c.isKeyframe && core.isArray(c.parents) && c.parents.length === 1) {
        // Not an error: rule 3 and rule 4 both keyframe a single-parent commit on purpose.
      }
    }
    if (roots === 0 && history.commits.length) {
      problems.push({ code: 'HISTORY_NO_ROOT', message: 'The history has no root commit.' });
    }
    if (history.head !== null && !idx[history.head]) {
      problems.push({
        code: 'HISTORY_HEAD_MISSING',
        message: 'The head points at ' + core.shortId(history.head) + ', which is not in this history.',
      });
    }
    // Every commit must be reachable from the head, or it is not part of this model's history.
    var reachable = reachableFrom(history, history.head);
    for (var r = 0; r < history.commits.length; r++) {
      var rc = history.commits[r];
      if (core.isObject(rc) && core.isString(rc.id) && !reachable[rc.id]) {
        problems.push({
          code: 'COMMIT_UNREACHABLE',
          path: '/' + r,
          id: rc.id,
          message: 'Commit ' + core.shortId(rc.id) + ' is not reachable from the head.',
          severity: 'warning',
        });
      }
    }
    var errors = 0;
    for (var e = 0; e < problems.length; e++) if (problems[e].severity !== 'warning') errors++;
    return { ok: errors === 0, problems: problems, errorCount: errors };
  }

  /**
   * The model check for one commit: reconstruct and recompute `modelHash`.
   *
   * This is what catches a snapshot edited in place, and it is why REQ-VCS-006 requires the
   * reconstruction to be faithful — if materialization were lossy, every commit would fail this check
   * and the check would be worthless.
   */
  function verifyModel(history, id) {
    var commit = commitById(history, id);
    if (!commit) return { ok: false, problems: [{ code: 'VCS_NO_COMMIT', message: 'No such commit: ' + id }] };
    var model;
    try {
      model = materialize(history, id);
    } catch (err) {
      return { ok: false, problems: [{ code: err.code || 'VCS_MATERIALIZE', message: err.message }] };
    }
    var actual = modelHashOf(model);
    if (actual !== commit.modelHash) {
      return {
        ok: false,
        problems: [{
          code: 'COMMIT_MODEL_MISMATCH',
          message: 'Commit ' + core.shortId(id) + ' claims model ' + core.shortId(commit.modelHash) +
            ' but reconstructs to ' + core.shortId(actual) + '. Its stored content has been altered.',
        }],
      };
    }
    return { ok: true, problems: [], model: model };
  }

  // ---------------------------------------------------------------------------------------------
  // Reachability, ancestry, ordering (`04-versioning.md` §4)
  // ---------------------------------------------------------------------------------------------

  /** Map of commit id → true for every commit reachable from `id`, following parents. */
  function reachableFrom(history, id) {
    var idx = indexCommits(history);
    var seen = Object.create(null);
    if (!idx[id]) return seen;
    var stack = [id];
    while (stack.length) {
      var next = stack.pop();
      if (seen[next]) continue;
      seen[next] = true;
      var c = idx[next];
      var parents = c && core.isArray(c.parents) ? c.parents : [];
      for (var i = 0; i < parents.length; i++) if (idx[parents[i]]) stack.push(parents[i]);
    }
    return seen;
  }

  /** Breadth-first ancestry: true when `x` is `y` or an ancestor of it. */
  function isAncestor(history, x, y) {
    if (x === y) return true;
    var idx = indexCommits(history);
    var seen = Object.create(null);
    var queue = [y];
    while (queue.length) {
      var next = queue.shift();
      if (seen[next]) continue;
      seen[next] = true;
      var c = idx[next];
      var parents = c && core.isArray(c.parents) ? c.parents : [];
      for (var i = 0; i < parents.length; i++) {
        if (parents[i] === x) return true;
        if (!seen[parents[i]]) queue.push(parents[i]);
      }
    }
    return false;
  }

  var IDENTICAL = 'identical';
  var A_NEWER = 'a-newer';
  var B_NEWER = 'b-newer';
  var DIVERGED = 'diverged';

  /**
   * Which of two commits is newer, by ancestry alone (I2).
   *
   * `timestamp` is not read here, and must never be added to this function.
   */
  function compare(history, a, b) {
    if (a === b) return IDENTICAL;
    if (isAncestor(history, a, b)) return B_NEWER;
    if (isAncestor(history, b, a)) return A_NEWER;
    return DIVERGED;
  }

  /** Depth of each reachable commit: 0 for a root, otherwise 1 + max(depth of parents). */
  function depths(history) {
    var idx = indexCommits(history);
    var order = topoSort(history);
    var out = Object.create(null);
    for (var i = 0; i < order.length; i++) {
      var c = order[i];
      var parents = c.parents || [];
      var d = 0;
      for (var p = 0; p < parents.length; p++) {
        var pd = out[parents[p]];
        if (core.isNumber(pd) && pd + 1 > d) d = pd + 1;
      }
      out[c.id] = d;
    }
    return out;
  }

  /** Commits in topological order — every parent before its children. */
  function topoSort(history) {
    var idx = indexCommits(history);
    var ids = Object.keys(idx);
    var visited = Object.create(null);
    var out = [];
    function visit(id) {
      if (visited[id] || !idx[id]) return;
      visited[id] = true;
      var parents = idx[id].parents || [];
      for (var i = 0; i < parents.length; i++) visit(parents[i]);
      out.push(idx[id]);
    }
    // Iterate ids in sorted order so the result is deterministic for equal histories.
    ids.sort();
    for (var i = 0; i < ids.length; i++) visit(ids[i]);
    return out;
  }

  /**
   * The log for the History tab: every commit reachable from the head, newest-first by ancestry.
   *
   * Newest-first is computed as *descending depth*, not as descending timestamp. Two commits at the
   * same depth on divergent branches have no true order between them, and the timestamp is not used to
   * invent one — they are shown in a stable order (by id) so the list does not shuffle.
   */
  function log(history) {
    var reachable = reachableFrom(history, history.head);
    var order = topoSort(history);
    var depth = depths(history);
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var c = order[i];
      if (!reachable[c.id]) continue;
      out.push({
        commit: c,
        depth: depth[c.id] || 0,
        isHead: c.id === history.head,
        isMerge: (c.parents || []).length > 1,
        isRoot: (c.parents || []).length === 0,
      });
    }
    out.sort(function (a, b) {
      if (b.depth !== a.depth) return b.depth - a.depth;
      return a.commit.id < b.commit.id ? -1 : a.commit.id > b.commit.id ? 1 : 0;
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Merge base (`04-versioning.md` §6)
  // ---------------------------------------------------------------------------------------------

  /**
   * Lowest common ancestors of two commits, with their depths.
   *
   * Returns a list because criss-cross history genuinely has more than one base at the same depth.
   * The caller picks one and says so (REQ-VCS-010 AC1) — recursive virtual merge bases are
   * deliberately not implemented, and the disclosure is what makes that honest.
   */
  function commonAncestors(history, a, b) {
    var ancA = reachableFrom(history, a);
    var depthA = depths(history);
    var idx = indexCommits(history);
    var found = [];
    var seen = Object.create(null);
    var queue = [b];
    while (queue.length) {
      var next = queue.shift();
      if (seen[next]) continue;
      seen[next] = true;
      if (ancA[next]) found.push(next);
      var c = idx[next];
      var parents = c && core.isArray(c.parents) ? c.parents : [];
      for (var i = 0; i < parents.length; i++) if (!seen[parents[i]]) queue.push(parents[i]);
    }
    if (!found.length) return { bases: [], multiple: false };
    var best = -1;
    for (var f = 0; f < found.length; f++) {
      var d = depthA[found[f]];
      if (!core.isNumber(d)) d = 0;
      if (d > best) best = d;
    }
    var bases = [];
    for (var g = 0; g < found.length; g++) {
      var dg = depthA[found[g]];
      if (!core.isNumber(dg)) dg = 0;
      if (dg === best) bases.push(found[g]);
    }
    bases.sort();
    return { bases: bases, multiple: bases.length > 1 };
  }

  /** The merge base to use, and whether the choice needs disclosing. */
  function mergeBase(history, a, b) {
    var result = commonAncestors(history, a, b);
    if (!result.bases.length) return { base: null, multiple: false, candidates: [] };
    return { base: result.bases[0], multiple: result.multiple, candidates: result.bases };
  }

  // ---------------------------------------------------------------------------------------------
  // Appending commits (`04-versioning.md` §3, §5)
  // ---------------------------------------------------------------------------------------------

  /** Commits since the last keyframe at or before `id`, counting `id`'s own distance. */
  function commitsSinceKeyframe(history, id) {
    return Math.max(0, chainToKeyframe(history, id).length - 1);
  }

  /**
   * The keyframe placement rules.
   *
   * Rules 1–3 are correctness, rule 4 is the interval heuristic. Rule 3 compares an already-computed
   * delta against the snapshot, which is why this takes sizes rather than deciding them itself.
   */
  function shouldKeyframe(commit, context) {
    if (!(commit.parents || []).length) return true;
    if (commit.parents.length > 1) return true;
    if (context.deltaBytes !== null && context.deltaBytes >= context.snapshotBytes) return true;
    if (context.sinceKeyframe >= context.interval) return true;
    return false;
  }

  /**
   * Build a commit on top of an existing model, choosing snapshot or delta by the placement rules.
   *
   * `parentModels` are supplied by the caller because it has already materialized them; recomputing
   * them here would double the cost of every commit.
   */
  function buildCommit(history, nextModel, parentIds, parentModels, author, message, options) {
    var opts = options || {};
    var interval = opts.keyframeInterval || history.keyframeInterval || TMV.DEFAULT_KEYFRAME_INTERVAL;
    var parents = sortedParents(parentIds);
    var modelHash = modelHashOf(nextModel);
    var snapshotBytes = core.utf8Length(canonical.serialize(nextModel));

    var delta = null;
    var deltaBytes = null;
    if (parents.length === 1 && parentModels && parentModels[0]) {
      delta = diff(parentModels[0], nextModel, '', []);
      deltaBytes = patchBytes(delta);
    }
    var isKeyframe = shouldKeyframe(
      { parents: parents },
      {
        deltaBytes: deltaBytes,
        snapshotBytes: snapshotBytes,
        sinceKeyframe: parents.length === 1 ? commitsSinceKeyframe(history, parents[0]) + 1 : 0,
        interval: interval,
      },
    );
    return makeCommit({
      parents: parents,
      modelId: nextModel.modelId,
      author: author,
      timestamp: opts.timestamp || new Date().toISOString(),
      message: message,
      modelHash: modelHash,
      isKeyframe: isKeyframe,
      snapshot: isKeyframe ? core.deepCopy(nextModel) : null,
      delta: isKeyframe ? null : delta,
    });
  }

  /** Append a commit and advance the head. Mutates the history in place and invalidates its cache. */
  function append(history, commit) {
    history.commits.push(commit);
    history.head = commit.id;
    invalidate(history);
    return commit;
  }

  /**
   * Commit the working copy. Refuses a commit that changes nothing (REQ-VCS-004 AC2) — an empty
   * commit is identical to its parent, which is noise in the log and an oddity in the hash chain.
   */
  function commit(history, workingModel, author, message, options) {
    var opts = options || {};
    var head = commitById(history, history.head);
    var parents = head ? [head.id] : [];
    var parentModels = [];
    if (head) {
      var parentModel = materialize(history, head.id);
      if (opts.allowEmpty !== true && modelHashOf(parentModel) === modelHashOf(workingModel)) {
        return { ok: false, reason: 'empty', message: 'No changes to commit — the working copy matches the head commit.' };
      }
      parentModels.push(parentModel);
    }
    var record = buildCommit(history, workingModel, parents, parentModels, author, message, opts);
    append(history, record);
    return { ok: true, commit: record };
  }

  /**
   * A merge commit: two or more parents, always a keyframe (rule 2), whose model is the resolution the
   * user confirmed (REQ-VCS-011). Both original heads stay reachable; nothing is discarded.
   */
  function mergeCommit(history, resolvedModel, parentIds, author, message, options) {
    var opts = options || {};
    var record = buildCommit(history, resolvedModel, parentIds, null, author, message, {
      timestamp: opts.timestamp,
      keyframeInterval: opts.keyframeInterval,
    });
    append(history, record);
    return record;
  }

  /**
   * Revert to an earlier commit by creating a *new* commit whose model equals that commit's
   * (REQ-VCS-013). History is never rewritten: rewriting would invalidate every subsequent id and
   * desynchronise every copy already in circulation (`04-versioning.md` §7).
   */
  function revertTo(history, targetId, author, message, options) {
    var target = commitById(history, targetId);
    if (!target) throw TmvError('VCS_NO_COMMIT', 'No commit ' + targetId + ' to revert to.', { id: targetId });
    var model = materialize(history, targetId);
    var head = commitById(history, history.head);
    var parentModel = head ? materialize(history, head.id) : null;
    var text = core.isString(message) && message !== ''
      ? message
      : 'Revert to ' + core.shortId(targetId) + ' — "' + core.oneLine(target.message) + '"';
    var record = buildCommit(
      history,
      model,
      head ? [head.id] : [],
      parentModel ? [parentModel] : [],
      author,
      text,
      options || {},
    );
    append(history, record);
    return record;
  }

  // ---------------------------------------------------------------------------------------------
  // Working copy
  // ---------------------------------------------------------------------------------------------

  /** True when the working copy differs from the head commit's model (REQ-VCS-004). */
  function isDirty(history, workingModel) {
    var head = commitById(history, history.head);
    if (!head) return true;
    return modelHashOf(workingModel) !== head.modelHash;
  }

  // ---------------------------------------------------------------------------------------------
  // Compaction (`04-versioning.md` §3, §9)
  // ---------------------------------------------------------------------------------------------

  /**
   * Rewrite the storage representation without touching a single id.
   *
   * Re-keyframes the reachable history by the placement rules, drops redundant keyframes, and drops
   * commits unreachable from the head. Because ids do not depend on representation (I1), a compacted
   * history still reconciles against an uncompacted file that shares its commit ids.
   */
  function compact(history, options) {
    var opts = options || {};
    var interval = opts.keyframeInterval || history.keyframeInterval || TMV.DEFAULT_KEYFRAME_INTERVAL;
    var reachable = reachableFrom(history, history.head);
    var order = topoSort(history);
    var kept = [];
    for (var i = 0; i < order.length; i++) if (reachable[order[i].id]) kept.push(order[i]);
    var dropped = history.commits.length - kept.length;

    var models = Object.create(null);
    var framesBefore = 0;
    for (var m = 0; m < kept.length; m++) {
      if (kept[m].isKeyframe) framesBefore++;
      models[kept[m].id] = materialize(history, kept[m].id);
    }

    var rebuilt = [];
    var sinceKeyframe = -1;
    var framesAfter = 0;
    for (var k = 0; k < kept.length; k++) {
      var c = kept[k];
      var parents = c.parents || [];
      var snapshot = models[c.id];
      var snapshotBytes = core.utf8Length(canonical.serialize(snapshot));
      var delta = null;
      var deltaBytes = null;
      if (parents.length === 1 && models[parents[0]]) {
        delta = diff(models[parents[0]], snapshot, '', []);
        deltaBytes = patchBytes(delta);
      }
      var frame = shouldKeyframe(c, {
        deltaBytes: deltaBytes,
        snapshotBytes: snapshotBytes,
        sinceKeyframe: sinceKeyframe < 0 ? interval : sinceKeyframe,
        interval: interval,
      });
      var next = {
        id: c.id,
        parents: sortedParents(parents),
        modelId: c.modelId,
        author: c.author,
        timestamp: c.timestamp,
        message: c.message,
        modelHash: c.modelHash,
        isKeyframe: frame,
        snapshot: frame ? snapshot : null,
        delta: frame ? null : delta,
      };
      if (frame) {
        sinceKeyframe = 0;
        framesAfter++;
      } else {
        sinceKeyframe++;
      }
      rebuilt.push(next);
    }

    var out = {
      keyframeInterval: interval,
      head: history.head,
      commits: rebuilt,
    };
    invalidate(history);
    return {
      history: out,
      report: {
        dropped: dropped,
        before: history.commits.length,
        after: rebuilt.length,
        keyframesBefore: framesBefore,
        keyframesAfter: framesAfter,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Stash (`04-versioning.md` §5)
  //
  // A stash exists for exactly one purpose: to let a reconcile proceed without losing in-progress
  // work. It is local-only and never exported.
  // ---------------------------------------------------------------------------------------------

  function createStash(history, workingModel, meta) {
    var head = commitById(history, history.head);
    if (!head) return null;
    var base = materialize(history, head.id);
    var delta = diff(base, workingModel, '', []);
    if (!delta.length) return null;
    return {
      base: head.id,
      delta: delta,
      createdAt: (meta && meta.createdAt) || new Date().toISOString(),
      reason: (meta && meta.reason) || '',
    };
  }

  /**
   * Reapply a stash to the current head, by patch.
   *
   * A stash applies against the commit it was taken from. If the head has moved on, the patch may no
   * longer apply cleanly; that failure is reported rather than swallowed, because a stash that
   * silently vanished is a lost edit, which is the exact outcome the stash exists to prevent.
   */
  function applyStash(history, stash) {
    if (!core.isObject(stash) || !core.isArray(stash.delta)) {
      return { ok: false, message: 'The stash is not readable.' };
    }
    var head = commitById(history, history.head);
    if (!head) return { ok: false, message: 'There is no head to apply the stash to.' };
    var base = materialize(history, head.id);
    if (stash.base && stash.base !== head.id) {
      // Try anyway: a stash often still applies when the intervening commits touched other entities.
      try {
        var applied = applyPatch(core.deepCopy(base), stash.delta);
        return { ok: true, model: applied, rebased: true };
      } catch (err) {
        return {
          ok: false,
          rebased: true,
          message: 'The stash was taken from commit ' + core.shortId(stash.base) +
            ' and no longer applies to the head (' + err.message + '). It is still stored and can be inspected.',
        };
      }
    }
    try {
      var model = applyPatch(core.deepCopy(base), stash.delta);
      return { ok: true, model: model };
    } catch (err) {
      return { ok: false, message: 'The stash could not be applied: ' + err.message };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Import helpers
  // ---------------------------------------------------------------------------------------------

  /**
   * Validate a history read from a file or from storage, then normalise its commit order.
   *
   * Order is not semantics here: `04-versioning.md` §7 says commits are stored "in topological
   * order", but nothing may *depend* on the array order, and a file assembled by a third party (or by
   * a bad merge of two file contents) may not honour it. Sorting on load costs one pass and removes an
   * entire class of ordering bug.
   */
  function adopt(raw, options) {
    var opts = options || {};
    var history = {
      keyframeInterval: core.isNumber(raw && raw.keyframeInterval) ? raw.keyframeInterval : TMV.DEFAULT_KEYFRAME_INTERVAL,
      head: raw && core.isString(raw.head) ? raw.head : null,
      commits: core.isArray(raw && raw.commits) ? raw.commits.slice() : [],
    };
    var sorted = topoSort(history);
    if (sorted.length !== history.commits.length) {
      // topoSort drops entries it cannot reach; keep them so verification can report them.
      var seen = Object.create(null);
      for (var i = 0; i < sorted.length; i++) seen[sorted[i].id] = true;
      for (var j = 0; j < history.commits.length; j++) {
        var c = history.commits[j];
        if (!core.isObject(c) || !seen[c.id]) sorted.push(c);
      }
    }
    history.commits = sorted;
    var verdict = verifyChain(history);
    return { history: history, verdict: verdict, readOnly: opts.readOnly === true || !verdict.ok };
  }

  /** True when two histories share at least one commit id, i.e. they describe the same lineage. */
  function sharesHistory(historyA, historyB) {
    var a = indexCommits(historyA);
    var b = indexCommits(historyB);
    var keys = Object.keys(a);
    for (var i = 0; i < keys.length; i++) if (b[keys[i]]) return true;
    return false;
  }

  /**
   * A human-readable summary of one commit, for the History tab and commit messages.
   * Never used for ordering (I2).
   */
  function describeCommit(commit) {
    if (!commit) return 'Unknown commit';
    var flags = [];
    if ((commit.parents || []).length > 1) flags.push('merge');
    if ((commit.parents || []).length === 0) flags.push('root');
    if (commit.isKeyframe) flags.push('keyframe');
    return core.shortId(commit.id) + (flags.length ? ' (' + flags.join(', ') + ')' : '');
  }

  TMV.vcs = {
    IDENTICAL: IDENTICAL,
    A_NEWER: A_NEWER,
    B_NEWER: B_NEWER,
    DIVERGED: DIVERGED,
    OPERATIONS: OPERATIONS,

    modelHashOf: modelHashOf,
    commitPayload: commitPayload,
    commitIdOf: commitIdOf,
    sortedParents: sortedParents,

    applyPatch: applyPatch,
    diff: diff,
    patchBytes: patchBytes,

    initHistory: initHistory,
    createRootCommit: createRootCommit,
    makeCommit: makeCommit,
    commitById: commitById,
    indexCommits: indexCommits,
    chainToKeyframe: chainToKeyframe,
    materialize: materialize,
    headModel: headModel,
    invalidate: invalidate,

    verifyChain: verifyChain,
    verifyModel: verifyModel,

    reachableFrom: reachableFrom,
    isAncestor: isAncestor,
    compare: compare,
    depths: depths,
    topoSort: topoSort,
    log: log,

    commonAncestors: commonAncestors,
    mergeBase: mergeBase,

    commitsSinceKeyframe: commitsSinceKeyframe,
    shouldKeyframe: shouldKeyframe,
    buildCommit: buildCommit,
    append: append,
    commit: commit,
    mergeCommit: mergeCommit,
    revertTo: revertTo,

    isDirty: isDirty,

    compact: compact,

    createStash: createStash,
    applyStash: applyStash,

    adopt: adopt,
    sharesHistory: sharesHistory,
    describeCommit: describeCommit,
  };
})(globalThis.TMV = globalThis.TMV || {});
