# ADR-0003 — Divergence always prompts; fast-forward auto-adopts

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-SYNC-003..006, REQ-VCS-009..013
- **Related:** `specs/04-versioning.md` §5, §6, `specs/07-ui.md` §6

## Context

Requirement 6 says: when the file's model is newer than local storage, use the newer version. The
phrase assumes a total order. A commit graph does not have one.

Two cases have to be distinguished, and they are not variations of the same case:

**Fast-forward.** The cached history contains the file's head as an ancestor. The cache is strictly
ahead; adopting it loses nothing and is unambiguous.

**Divergence.** Both histories contain commits the other lacks. There is no "newer" — one branch has
edits the other does not. Choosing either silently discards work, and choosing by timestamp is worse
than choosing arbitrarily, because it *looks* principled: clocks disagree, and a file copied to a
machine with a skewed clock would silently win.

## Decision

- **Fast-forward adopts silently.** When one history is an ancestor of the other, the app takes the
  descendant and reports what it did in a notification. No prompt, because there is nothing to decide.
- **Divergence always prompts.** The app opens a three-way comparison against the merge base and
  requires an explicit choice: keep the file's branch, keep the local branch, or merge. There is no
  default and no timeout.
- **Timestamps are never decisive.** Ordering comes from ancestry (`isAncestor`); commit timestamps are
  displayed and hashed (ADR-0008) but never used to determine which history wins.
- **Nothing is auto-merged.** The compare view may *suggest* a resolution (`04-versioning.md` §6) but
  never applies one without a user action.
- **Nothing is discarded.** Both branches remain in the DAG after any resolution, so a wrong choice is
  recoverable by re-merging.

## Consequences

**Good**

- No path loses a commit without the user seeing it happen.
- The common case (you edited the file, you opened it again) is a fast-forward and stays out of the
  way.
- Clock skew cannot cause data loss, which is the failure mode that would be hardest to diagnose after
  the fact.

**Costly**

- A prompt appears in a situation where a user may not know which branch is which. Mitigated by
  showing the merge base and the commits unique to each side, in the user's own words, rather than
  hashes.
- A merge creates a commit with two parents and a commit message the user supplies. This is real
  cognitive load for what is conceptually "I opened the file."
- Users who open the same file in two places repeatedly will meet this prompt repeatedly. See OQ-04.

## Alternatives considered

**Newest timestamp wins (the literal reading of requirement 6).** Rejected: silently destroys commits,
and makes a decision based on the least trustworthy field in the commit.

**Always prompt, including fast-forward.** Safer, and rejected as friction that trains users to click
through the dialog that matters.

**Always auto-merge, prompt only on conflicting fields.** Rejected: this is the "helpful" behaviour
that produces a model nobody chose. Two threat models merged field-by-field can be internally
incoherent — a threat referencing a component removed on the other branch — and a plausible-looking
merged model that nobody wrote is worse than a prompt.

**Last-writer-wins per entity, CRDT-style.** Rejected: requires every entity to carry its own clock and
merging metadata, changes the data model, and still cannot merge semantic conflicts (an entity deleted
on one side and edited on the other). Also incompatible with git-style commit ids (ADR-0008), which
must be deterministic from content.
