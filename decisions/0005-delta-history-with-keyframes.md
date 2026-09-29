# ADR-0005 — History as JSON Patch deltas plus periodic keyframes

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-VCS-007..009, REQ-STORE-005
- **Related:** `specs/04-versioning.md` §4, `specs/05-storage.md` §5

## Context

Requirement 3 asks for git-style versioning, and requirement 2 requires every commit to be stored
inline in the HTML file. Requirement 5 requires exporting the current version with that history
embedded.

History storage therefore has two hard constraints that pull in opposite directions:

- **The file must stay small enough to email and to open.** A model's full snapshot might be 200 KB to
  2 MB of JSON. Fifty commits of full snapshots is a file nobody can send.
- **Any commit must be reconstructable.** Not just the head — the History tab shows any commit, and
  merge needs a third version from the merge base.

Storing only the head loses history. Storing every full snapshot is unaffordable. Deltas are the
obvious answer, but a chain of N deltas requires N applications to read commit 1, and the app must
reconstruct arbitrary commits, not just the newest.

## Decision

**Store each commit as a JSON Patch (RFC 6902) delta against its parent, plus full snapshots
("keyframes") at computed points.**

Keyframes are placed by rule, not by user choice (`04-versioning.md` §4):

| Keyframe at | Why |
|---|---|
| The root commit | There is nothing to diff against |
| Every merge commit | Two-parent commits are branch points; reconstruction should not cross them |
| Intermittently, when accumulated delta size exceeds a snapshot | Bounds worst-case read cost |
| At a fixed interval | Bounds the number of deltas between keyframes regardless of size |

Every commit record carries its `modelHash` independently (ADR-0008), so reconstruction is
**verifiable**: after applying deltas to reach a commit, the reconstructed model is re-hashed and
compared. A mismatch is a detected corruption, not a silent wrong answer.

Reconstruction cost is bounded by the keyframe interval rather than by history length, and compaction
can drop delta runs that a keyframe makes redundant — never the keyframes themselves.

## Consequences

**Good**

- File size grows with *change*, not with history length. A model reviewed fifty times with small edits
  stays small.
- Every commit remains independently verifiable via its stored hash, which is what makes the tamper
  detection in `08-security.md` meaningful at all.
- Reconstruction is O(keyframe interval) rather than O(history), so the History tab stays responsive
  on a long-lived model.

**Costly**

- **A delta chain is fragile in a way a snapshot is not.** A single dropped or corrupted delta makes
  every commit after the preceding keyframe unreconstructable. Mitigated by keyframe density and by
  verification, but the failure mode exists and recovery is "go back to the last keyframe."
- Compaction is a background operation that rewrites storage, and an interrupted compaction is the
  most dangerous state the app has. This is why storage writes are ordered so the pointer moves last
  (`05-storage.md` §3) and why §7 of `09-testing.md` injects faults into exactly this path.
- The JSON Patch implementation is now on the security-critical path: it applies attacker-controlled
  operations to the model, which is a prototype-pollution and resource-exhaustion surface
  (`08-security.md` §5).
- Two extra code paths — delta generation and delta application — must produce identical results, and
  a property test rather than an example test is what proves it.

## Alternatives considered

**Full snapshot per commit.** Simple, robust, trivially correct — and unaffordable at the file sizes
requirement 2 and 5 imply. Retained in one place: the root commit is a snapshot.

**Line-oriented text diff, git-style.** Would allow textual diff display. Rejected: JSON is not
line-oriented, key order is not semantically meaningful, and a text diff of reformatted JSON is
unreadable noise. Canonical serialization (`03-data-model.md` §6) makes structural patches stable,
which a text diff would not be.

**Merkle tree over entities, storing only changed subtrees.** More elegant and would make per-entity
history queries cheap. Rejected as substantially more machinery than v1 needs, and it does not change
the file-size arithmetic enough to justify it.

**Only-ever store the head; treat history as metadata.** Rejected: this discards the thing requirement
3 asks for.
