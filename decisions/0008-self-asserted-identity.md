# ADR-0008 — Self-asserted identity and a hash chain; no signing in v1

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-SEC-005, REQ-VCS-001..003
- **Related:** `specs/08-security.md` §8, `specs/10-open-questions.md` OQ-07

## Context

Requirement 8 makes the primary use case **decentralized** commit-based editing: someone sends you a
model, you make changes, you send it back. That raises the question of who a commit is attributed to,
and the app has no server, no account, and no directory to answer it with.

Two distinct properties are easy to conflate:

- **Integrity** — has this history been altered since it was written?
- **Authenticity** — did the claimed author actually write it?

A hash chain provides the first. It provides none of the second, because the author name is an input to
the hash: an attacker who wants to claim a commit was written by someone else simply writes that name
and recomputes the chain. Recomputing is trivial; nothing signs anything.

## Decision

**Commits carry a self-asserted name and email, and are chained by SHA-256. No signing in v1.**

Commit identity is computed deterministically:

```
modelHash  = sha256( canonicalSerialize(model) )
commitHash = sha256( canonicalSerialize({
               parents: sorted(parents), modelId,
               author, timestamp, message, modelHash
             }) )
```

The id covers the model **by hash**, not by content, which is what lets a commit id be stable under any
change to how deltas are stored (ADR-0005) while still changing when the model changes.

Because authorship is not verified, the UI must be precise about it:

- History reports **"chain intact"** — never "verified", "trusted", or a checkmark.
- Settings states that identity is self-asserted, at the point the user enters it.
- About explains what the chain does and does not prove.

The commit hash deliberately covers `timestamp` and `author`, so changing either changes the id and
invalidates every descendant. That makes tampering *detectable* — which is all that is being claimed.

## Consequences

**Good**

- Tampering and corruption are detectable, which is the property that makes a decentralized workflow
  safe enough to use: a model that has been quietly altered cannot be presented as the original.
- Zero setup. No keys to generate, store, lose, or explain.
- Commit ids are deterministic functions of content, which is what makes ADR-0003's fast-forward and
  merge logic work at all — two machines computing the same commit must agree on its id.

**Costly**

- **Authorship is forgeable, and the app must keep saying so.** This is a genuine limitation, disclosed
  in three places rather than one.
- A user who wants an audit trail with any strength behind it cannot use this tool as-is. Listed as
  residual risk R4 in `08-security.md` §11.
- Because `timestamp` is hashed, a commit made with a wrong system clock is permanently different from
  one made with a right one. Harmless for ordering (which uses ancestry), but it means ids are not
  reproducible across machines if clocks differ.
- Adding signing later is not purely additive: signed and unsigned commits will coexist, and the UI
  needs a three-state model (signed-and-valid, signed-and-invalid, unsigned) rather than a boolean.

## Alternatives considered

**Sign commits with a WebCrypto key from v1.** The correct eventual answer, deferred (OQ-07) — not
because it is wrong, but because key generation, storage, export/import, and trust-on-first-use UX is a
feature at least as large as the versioning system it protects, and it only helps if recipients
actually verify, which they mostly do not.

**No identity at all — anonymous commits.** Simpler, and removes a privacy leak (`08-security.md` §10).
Rejected: a review workflow's central question is "who said this, and did they say it after my last
change?" An unattributed history is much less useful, and the email is what makes a model's history
actionable for the recipient.

**Identity from an external source (GitHub, an IdP).** Requires network, an account, and a server.
Contradicts requirement 1 and the whole premise.

**Trust a user-provided public key without a chain of trust.** Provides no more real assurance than
self-assertion while adding all the key-management cost — the worst of both.
