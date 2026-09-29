# 04 — Versioning

The history model: how commits are formed, stored, verified, compared, and reconciled.

This is the part of the system with the least room for error. Everything else can be re-rendered; a
bug here loses work.

Related: `03-data-model.md` §7 (commit records and hashing), ADR-0003 (prompt on divergence),
ADR-0005 (deltas + keyframes), ADR-0008 (identity), ADR-0011 (hashing implementation).

---

## 1. Shape of the history

A **directed acyclic graph** of commits, not a list. It has to be a DAG because reconciliation creates
commits with two parents (REQ-VCS-011), and because nothing is ever discarded.

```
            ┌── C4 ── C5 ──┐
C1 ── C2 ── C3              M      ← M has parents C5 and C7
            └── C6 ── C7 ──┘
```

| Concept | Definition |
|---|---|
| **Root commit** | A commit with no parents. One per model on creation or import (REQ-IMP-005) |
| **Head** | The commit the working copy was last synchronised to |
| **Ref** | A named pointer to a commit. v1 has exactly one ref per model: the head |
| **Keyframe** | A commit storing a full snapshot rather than a delta |
| **Reachable** | A commit from which the head can be reached by following parent links |

There is no branching UI in v1. Branches exist only as *divergence* created by two people editing
copies of the same file — which is the whole point of the tool, and is handled by §6, not by a
branch-creation feature.

---

## 2. Hash chaining

```
modelHash  = sha256( canonicalSerialize(model) )
commitHash = sha256( canonicalSerialize({
               parents: sorted(commit.parents), modelId, author, timestamp, message, modelHash
             }) )
```

Because `parents` is an input, a commit's id transitively covers its entire ancestry: changing any
historical commit changes the ids of every commit after it. That is what makes tampering detectable
(REQ-VCS-002) rather than merely visible.

The hash covers the **model**, not the storage representation — so compaction and re-keyframing never
rewrite ids. See `03-data-model.md` §7 for why this matters and what it costs.

### Verification on load

Two levels, because full verification is expensive and mostly unnecessary.

| Level | What it checks | Cost | When |
|---|---|---|---|
| **Chain check** | Stored fields hash to each commit's declared id; every parent id exists | O(N), no reconstruction | Always, at boot (REQ-VCS-002) |
| **Model check** | Reconstruct the model, recompute `modelHash` | O(N) reconstructions | Head, plus any commit the user inspects |

The chain check catches structural tampering, dangling parents, and truncation — the failures that
actually occur from a corrupted file or a bad merge of file contents. The model check catches a
snapshot rewritten in place with its id left alone, which requires deliberate effort and is caught the
moment that commit is displayed.

An integrity failure enters **read-only mode**, names the offending commit, and never writes to that
model's local history (REQ-DATA-005, REQ-VIEW-008).

### Verification cannot prove authorship

The chain makes history **tamper-evident against accidental and naive modification**. It does not
make it **authentic**: anyone can regenerate a complete, internally consistent history from scratch.
Author names are self-asserted (ADR-0008). This is documented in `08-security.md` and must not be
overstated in the UI — the History tab says "verified: chain intact", never "trusted".

---

## 3. Storage: deltas and keyframes

A commit is stored as **either** a full `snapshot` **or** an RFC 6902 JSON Patch `delta` against its
parent. Exactly one (REQ-VCS-005).

**Why not snapshots alone.** A realistic model is 100–500 KB of JSON; a hundred commits would be tens
of megabytes, against a ~5 MB localStorage budget (ADR-0005).

**Why not deltas alone.** Reconstructing an arbitrary commit would require replaying from the root —
O(N) per access, and a single corrupted delta destroys everything after it.

**Keyframes bound both problems.** Reconstruction replays from the nearest preceding keyframe, so cost
is bounded by the interval rather than by history length.

### Placement rules

A commit **must** be a keyframe when:

1. It is a **root** commit — there is no parent to delta against.
2. It has **more than one parent** — a merge. Deltas would be ambiguous between two parents.
3. Its delta would be **larger than the snapshot** — when a patch is bigger than the whole, storing
   the patch is pure loss. Compared before writing.
4. The count of commits since the last keyframe reaches `keyframeInterval` (default 20, configurable).

Rule 4 is a heuristic; rules 1–3 are correctness. Rule 3 in particular is what keeps a model that
changes shape drastically — every id rewritten, say — from producing an enormous delta chain.

### Reconstruction

```
materialize(commitId):
  chain = walk parents from commitId until a keyframe is found (inclusive)
  model = deepCopy(frame.snapshot)
  for each commit in chain after the frame, in topological order:
      model = applyPatch(model, commit.delta)
  return model
```

Guarantee (REQ-VCS-006): the result hashes to the commit's recorded `modelHash`. Property-tested over
generated histories, not just hand-written cases.

The walk is bounded by `keyframeInterval` by construction — except where rules 1–3 inserted an earlier
keyframe, which only shortens it.

### Compaction

Compaction rewrites the *representation* without touching ids: re-keyframe the history, drop
redundant keyframes, drop unreachable commits (REQ-STORE-008). It is the answer to quota pressure and
is always user-initiated and preceded by a report of what it will remove (REQ-STORE-006).

Because ids do not depend on representation, compaction cannot desynchronise a compacted local
history from an uncompacted file — they share commit ids and reconcile normally.

---

## 4. Ordering: which history is newer

**Ancestry decides. Timestamps never do** (REQ-VCS-007, REQ-VCS-008).

```
compare(A, B):
  if A == B                      → IDENTICAL
  if isAncestor(A, B)            → B is newer   (fast-forward to B)
  if isAncestor(B, A)            → A is newer   (fast-forward to A)
  otherwise                      → DIVERGED     (prompt, §6)

isAncestor(x, y):
  BFS from y following parents; true if x is reached
```

Timestamps are displayed because humans need them, and are excluded from every decision because they
come from untrusted client clocks. A machine with a wrong clock would otherwise silently win every
reconcile and overwrite its peer's work — a failure mode that is invisible until the work is gone.

This is why the original requirement "use the newer version in local storage" is implemented as
REQ-SYNC-003 (fast-forward) plus REQ-SYNC-005 (prompt), and not as a timestamp comparison. See
ADR-0003.

---

## 5. The working copy

The working copy is the editable model, held in memory, derived from the head commit.

| State | Meaning |
|---|---|
| **Clean** | Working copy equals the head commit's model |
| **Dirty** | It differs; the difference is uncommitted |

Rules:

- Edits mutate the working copy only. No commit is created implicitly (REQ-VCS-004).
- Committing snapshots the working copy, computes the hash, and sets the head to the new commit.
- Committing with no changes is refused (REQ-VCS-004 AC2) — it would create a commit identical to its
  parent, which is noise and a hash-chain oddity.
- Discarding restores the working copy from the head, behind a confirmation (REQ-EDIT-007).
- **A dirty working copy blocks reconciliation** (REQ-VCS-012). Reconciling would need to merge
  uncommitted changes, and a conflict in uncommitted work has nowhere to be recorded. The user is
  offered commit, stash, or discard — never a silent discard.

### Stash

A stash is the working copy's delta from the head, stored locally and never exported. It exists for
one purpose: to let a reconcile proceed without losing in-progress work. It is recoverable from the UI
after the reconcile completes, and it is surfaced prominently, because a forgotten stash is a lost
edit.

### Undo and redo

Operation history over the working copy, bounded by the commit boundary (REQ-VCS-014). Undo after a
commit cannot un-commit — that is what revert (§7) is for, and conflating them would make the
distinction between "change my mind about this edit" and "change the record of history" invisible.

---

## 6. Divergence

When `compare` returns `DIVERGED`, the application **stops and asks** (REQ-VCS-009, ADR-0003). It does
not pick a winner and does not auto-merge. Both sides contain real work, and only a human knows which
is intended.

### Merge base

The **lowest common ancestor** of the two heads (REQ-VCS-010):

```
mergeBase(a, b):
  ancestorsA = all ancestors of a, including a, with depth
  walk b's ancestry breadth-first; the first commit also in ancestorsA
  with maximal depth is the base
```

With criss-cross history — two prior merges that make multiple bases equally deep — the application
picks one and **says so in the UI** (REQ-VCS-010 AC1). Recursive virtual merge bases (what git does)
are deliberately not implemented: they add real complexity, and the outcome here is a *comparison*
that a human confirms anyway, not an automatic merge. The disclosure is what makes this honest.

### The compare view

Three-way, always: **base**, **A (embedded/file)**, **B (local)**. Two-way comparison is not enough —
without the base, a field absent on one side is indistinguishable from a field deleted on that side,
which is exactly the distinction the user needs.

Per entity, by id:

| Case | Presentation |
|---|---|
| Added in A only | Take from A / omit |
| Added in B only | Take from B / omit |
| Added in both, different ids | Both offered; both retained by default |
| Changed in A only | Take from A / keep base |
| Changed in B only | Take from B / keep base |
| Changed in both, **different** fields | Fields shown merged as a *suggestion*; user confirms |
| Changed in both, **same** field, different values | **Conflict.** No suggestion; user must pick |
| Deleted in one, changed in the other | Delete / keep-and-apply, both offered explicitly |

**Suggestions are never applied.** The view pre-selects a proposed resolution — combining
non-overlapping field changes is mechanically safe — but the merge is not written until the user
confirms it (REQ-VCS-009 AC2). Pre-selecting reduces the work of a routine reconcile; requiring
confirmation is what keeps a mechanical suggestion from silently overriding a judgement.

### Resolution

Confirming writes:

- A merge commit with **two parents**, whose model is the resolved result (REQ-VCS-011).
- The merge commit's `message` describing the resolution, defaulting to something the user can edit.

Both original heads remain reachable permanently. Nothing is discarded — not even the side the user
did not choose, which remains in the DAG and can be inspected from the History tab afterwards.

### Not in v1

- **Per-field merge UI for diagram geometry.** Coordinates conflict like any other field, but a
  table of `x`/`y` values is not a useful way to resolve them. Geometry conflicts are presented as
  whole-element choices (take A's layout or B's), which is coarse but comprehensible. Refining this is
  in `10-open-questions.md`.

---

## 7. Revert

Reverting to commit *X* creates a **new** commit whose model equals *X*'s (REQ-VCS-013). History is
never rewritten and nothing becomes unreachable.

This follows directly from the hash chain: rewriting history would invalidate every subsequent id,
which would desynchronise every copy in circulation and make reconciliation against any previously
exported file impossible. A tool built for exchanging files cannot afford to rewrite history.

The revert commit's message records what it reverts, so the reason survives in the log.

---

## 8. Reconciliation

The full flow, combining §4 and §6 with storage. Storage mechanics are in `05-storage.md`.

```
reconcile(embeddedHistory, localHistory):
  if local is absent                    → adopt embedded, write to local      REQ-SYNC-002
  if modelIds differ                    → register separately, do not merge   REQ-SYNC-006
  if no common ancestor in either       → register separately, do not merge   REQ-SYNC-006
  case compare(embeddedHead, localHead):
    IDENTICAL  → nothing                                               REQ-SYNC-004
    embedded newer → fast-forward: adopt embedded into local            REQ-SYNC-002
    local newer    → keep local; offer "Export updated file" banner     REQ-SYNC-003
    DIVERGED       → block; require a clean working copy; open compare  REQ-SYNC-005
```

Two properties this flow must hold:

**It must not depend on shared storage** (REQ-SYNC-007). Every branch above is computed from the
embedded history and whatever local history exists — including none. If storage is empty, the flow
still reaches a correct outcome, because the file carries everything needed. This is the direct
consequence of ADR-0001 and the reason the flow is written in terms of "local history, possibly
absent" rather than "the stored model".

**It must explain itself when storage is partitioned** (REQ-SYNC-008). "No local history" and "your
browser gives every file its own storage" look identical from inside the app, but mean very different
things to the user. The detection heuristic:

| Signal | Interpretation |
|---|---|
| Storage readable, other models present, this `modelId` absent | Genuinely new model |
| Storage readable, **registry entirely empty**, file has history | Likely first run, or partitioned origin |
| Storage throws on access | Unavailable — REQ-STORE-007 |
| Firefox + `file://` + file has history, registry empty | Partitioned per-file origin (ADR-0001) |

The last case earns a specific explanation naming the browser behaviour and pointing at the
file-based path, because otherwise the user concludes the app is broken. It is the single most likely
point of confusion in the whole design.

---

## 9. Garbage collection

Reachable commits are never removed. Unreachable commits and excess keyframes are collectable, always
on explicit user action with a report first (REQ-STORE-008).

Sources of unreachable commits are limited by design — nothing in v1 discards history — so collection
mostly reclaims keyframes that compaction made redundant. Its main value is as a pressure valve under
the quota limit, and it is reached through the quota warning, not as routine maintenance.

---

## 10. Format migration

Container format versions may change. Migration is deliberately boring:

| Situation | Behaviour |
|---|---|
| `tmvFormat` older than the app | Migrated in memory on load; the local store is updated only after a successful commit, so a failed migration cannot corrupt stored history |
| `tmvFormat` newer than the app | **Read-only**, with an explanation (REQ-DATA-003). Never guess at a format's semantics |
| Commit ids in a retired algorithm | The `sha256:` prefix anticipates this. A future algorithm gets a new prefix; old commits retain theirs and verification dispatches on the prefix |

Nothing about migration rewrites ids, for the same reason nothing else does.
