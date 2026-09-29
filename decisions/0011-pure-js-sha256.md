# ADR-0011 — Pure-JavaScript synchronous SHA-256

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-VCS-001, REQ-VCS-002, REQ-SEC-001
- **Related:** `specs/02-architecture.md` §9, `specs/03-data-model.md` §7

## Context

SHA-256 is load-bearing for this app in two independent places:

1. **Commit ids** (ADR-0008) — every commit id is a hash, and every comparison, ancestry check, and
   merge base depends on those ids being computed identically everywhere.
2. **The CSP script hash** (REQ-SEC-001) — the policy pins the app's inline script by its SHA-256.

The browser offers `crypto.subtle.digest`. It is not usable here, for three reasons that stack:

- **Availability.** `crypto.subtle` is only exposed in a **secure context**. `file://` is treated as
  secure in current browsers, but the guarantee is not uniform across versions and is exactly the kind
  of platform detail this app cannot afford to be wrong about — and the app must also run over
  `http://localhost`, where it is fine, and potentially other origins where it is not.
- **Asynchrony.** `crypto.subtle.digest` returns a Promise. Commit id computation is embedded in
  synchronous logic: hashing a model, comparing ids during an ancestry walk, verifying a reconstruction.
  Making that path asynchronous would infect the merge algorithm, the DAG walk, and the patch
  application — a large, invasive change for a digest routine.
- **Determinism across environments.** Commit ids must be reproducible by anyone, on any browser. A
  pure implementation is a specification; a platform implementation is a promise.

Note that the *build* also computes a SHA-256 (to write the CSP), and it must do so with Node's
standard library only (ADR-0009).

## Decision

**Implement SHA-256 in pure JavaScript, synchronously, as part of the app's own source.**

- Located in the core module (`src/app/01-core.js`), with no dependency and no platform API.
- **Verified against the NIST test vectors** in the unit suite, including the empty string, `"abc"`,
  the multi-block message, and inputs spanning the padding boundary.
- Used for commit ids, model hashes, and integrity checks in the app.
- The **build** uses `node:crypto` — a different implementation is correct there, because the build is
  trusted, runs in Node, and its digest is compared at runtime by the browser's own CSP enforcement.

Both implementations are tested against the same vectors, so a divergence is caught rather than
shipped.

## Consequences

**Good**

- Commit ids are identical on every browser, every protocol, and in Node, by construction.
- The hashing path is synchronous, so ancestry walks, patch application, and merge stay synchronous and
  much simpler.
- No secure-context dependency. The app works over any origin a user happens to open it from.
- The implementation is auditable and is the same code in every build.

**Costly**

- **Hand-written cryptography is a liability in general.** It is acceptable here only because SHA-256 is
  a *digest*, not a cryptographic operation requiring secrecy or constant-time behaviour: the inputs
  are public model data, there is no key, and timing side channels are not a threat model for this use.
  This reasoning must be recorded alongside the code, because "we wrote our own hash" is otherwise a
  red flag in review.
- Performance is worse than native — pure JS SHA-256 is several times slower than `crypto.subtle`.
  Irrelevant at model sizes, but it does mean hashing a very large model on every commit is measurable,
  and it interacts with the resource guards in `08-security.md` §5.
- The implementation is on the integrity-critical path, so a subtle bug (an off-by-one in padding, a
  wrong rotation constant) would produce *consistently wrong but internally consistent* hashes —
  self-consistent, so tamper detection would still work, but ids would not match another implementation.
  The NIST vectors are what prevent this, and they are the reason this ADR names them specifically.

## Alternatives considered

**`crypto.subtle.digest` everywhere.** Rejected on the three grounds above; the synchrony problem alone
would force an async redesign of the commit graph logic.

**`crypto.subtle` where available, pure-JS fallback.** The worst option: two code paths that must agree
exactly, with a divergence producing ids that differ between users' browsers. A user on one browser
could not reconcile with a user on another, and the failure would be baffling.

**A small vendored SHA-256 library.** Rejected: it is a supply-chain entry for ~100 lines of
well-specified code, and REQ-SHELL-003's auditability argument (ADR-0009) applies — code you can read
is the point.

**Skip hashing; use random commit ids.** Would remove the whole problem. Rejected: it destroys the
property that makes decentralized merging work — two machines must independently compute the same id
for the same commit, or every reconciliation produces spurious divergence (ADR-0003).
