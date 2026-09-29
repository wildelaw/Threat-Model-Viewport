# ADR-0001 — The artifact is the primary carrier; local storage is a cache

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-SYNC-001..008, REQ-STORE-001..008
- **Related:** `specs/05-storage.md`, `specs/04-versioning.md`

## Context

Requirements 3, 6, and 9 assume that a threat model persists in browser local storage and reconciles
with the file it came from. That assumption does not hold uniformly across browsers, for a reason that
is not a bug and cannot be worked around:

- **Chrome and Edge** give every `file://` page one shared origin. All local models share one
  `localStorage` bucket.
- **Firefox 92+** gives **every file path its own origin.** Two copies of the same model at different
  paths have separate, mutually invisible stores. Serving the same file over `http://localhost` lands
  it in a third, unrelated store.
- **Safari** partitions storage on `file://` in its own way, with behaviour that has changed across
  releases.

So "the model in local storage" is not a portable concept. A design that treats local storage as the
system of record works on Chrome, silently fails to reconcile on Firefox, and cannot be reasoned about
at all across protocols.

There is a second, quieter argument. A threat model is a document people email to each other. The file
is the thing that moves; storage on the opening machine is an artifact of having looked at it.

## Decision

**The HTML file is the primary carrier of the model. Browser local storage is a cache and working
overlay.**

- Every open operation reads the model from the file's embedded data block. That data is authoritative
  for the *content* of the model.
- Local storage holds a working set: commits made since the file was last exported, plus the registry
  of models this browser has seen, plus preferences.
- When the file and the cache disagree, the app **compares commit histories** rather than trusting a
  timestamp or a location. Fast-forward adopts the newer history silently (ADR-0003); divergence
  prompts.
- The model registry is **re-seeded from the embedded data on every load**, so a fresh browser profile
  or a partitioned origin still shows the model it just opened.
- Because the cache may be absent, unreachable, or partitioned, **the app is fully functional without
  it** — everything works, nothing persists (REQ-STORE-007).

## Consequences

**Good**

- Works identically on all four browsers and both protocols. Firefox's per-file origin becomes a
  documented condition that changes *which* features are available, not whether the app works.
- Deleting browser storage is never destructive to the model. The worst case is losing unexported
  commits, which the app warns about.
- Sending a file sends its complete history. No coordination, no server, no shared state to lose.
- Requirement 9's model switcher becomes meaningful on every browser rather than only on Chrome.

**Costly**

- **Nothing is automatic.** A user who edits and closes the tab without exporting has lost the edit,
  and the app must say so clearly rather than appearing to have saved.
- Users used to web apps will expect persistence. Every commit must be visibly marked as *unexported*
  until it is written to a file.
- Reconciliation logic (ADR-0003) exists entirely because the app cannot assume it knows where the
  newest version is.
- Storage quota (5 MB) is a working-memory limit for unexported commits, not a document limit. Long
  working sessions without exporting can hit it (`05-storage.md` §5).

## Alternatives considered

**Local storage as the system of record.** The conventional web-app design, and what requirement 6
reads like on first pass. Rejected: it cannot be implemented correctly on Firefox `file://`, and
faking it would produce an app that appears to work and loses data on some browsers.

**IndexedDB instead of local storage.** More space, structured data. Rejected as a *primary* store
because Firefox blocks IndexedDB on `file://` outright — strictly worse availability than
`localStorage` for the primary use case. Retained as a possible future backend behind the adapter
(`10-open-questions.md` OQ-12).

**Refuse to run on `file://`; require a local server.** Would make storage uniform. Rejected as
hostile to the actual task: the premise is opening a document someone sent you.

**Origin-keyed namespacing to survive partitioning.** Would let the app *detect* that a different path
is a different origin, but cannot make the stores see each other. Adopted only as detection and
explanation (REQ-SYNC-008).
