# ADR-0012 — Hand-written targeted validators, Ajv cross-check in tests only

- **Status:** **Proposed** — the recommendation stands, but see OQ-01 for why it is not settled
- **Date:** 2026-09-28
- **Requirements:** REQ-IMP-002, REQ-IMP-003, REQ-IMP-005
- **Related:** `specs/06-interchange.md` §3, `specs/09-testing.md` §5, `specs/10-open-questions.md` OQ-01

## Context

Imported files must be validated against the vendored OTM and TML JSON Schemas before use. There is a
vendored copy of each (`src/vendor/`) and a schema-aware validator is the obvious tool.

The obstacles are specific to this project:

- **Ajv is a large library.** The full draft-07 plus 2020-12 validators, inlined, would be a
  significant fraction of the app's own script — and the app script is hashed into the CSP
  (REQ-SEC-001) and shipped in every exported file under size pressure (ADR-0002).
- **The runtime is a classic inline script with no module system** (ADR-0006). Ajv's distribution is
  ESM and CommonJS; there is no bundler (ADR-0009) to reconcile that.
- **Two schema dialects.** OTM is draft-07; TML is 2020-12. A single Ajv instance does not cover both
  cleanly.
- **The schemas are known, fixed, and small in the keywords they actually use.** Neither relies on
  exotic constructs; the interesting parts are type checks, required fields, enums, patterns, and
  nested structure.

Against that, the cost of being wrong is asymmetric and severe: a validator that wrongly *accepts*
malformed input lets this app propagate invalid data on re-export into someone else's tool. Silent
corruption of a third party's model is the worst outcome this application can produce.

## Decision

**Write targeted validators against the vendored schemas — implementing the keyword subset those
schemas actually use — and cross-check them against Ajv in the test suite only.**

- The runtime validator is ours, dependency-free, and covers exactly the keywords present in the
  vendored schemas. Keywords the schemas do not use are not implemented, and that is stated in the
  source rather than left as an assumption.
- **Ajv is a development dependency** and never enters the artifact.
- `interop.validator-vs-ajv` runs both over a corpus including **deliberate violations**, and asserts
  agreement on every case. The corpus is the artifact of this decision; its breadth is what makes the
  validator trustworthy.
- The vendored schemas are pinned by version (`10-open-questions.md` OQ-11), and a schema bump is a
  reviewed change that re-runs the differential suite.

If the corpus reveals the keyword subset cannot be implemented faithfully, **the fallback is to inline
Ajv** and accept the size cost — a correct validator is worth more than a small file.

## Consequences

**Good**

- No runtime dependency, so the CSP keeps its single-script shape, the artifact stays small, and the
  app retains its auditability property (ADR-0009).
- The validator is written to be *readable as a statement of what the formats require*, which is more
  useful in this codebase than a general-purpose engine.
- The differential test converts "is our validator right?" from a review question into a mechanical
  check that runs on every commit — which is the same technique used for the lossiness ledger
  (`09-testing.md` §5).

**Costly**

- **The guarantee is corpus-relative.** Agreement with Ajv is proven only over inputs the corpus
  contains; a keyword interaction nobody wrote a case for can diverge. The mitigation is corpus
  breadth, and it is a permanent maintenance obligation rather than a one-time cost.
- Two implementations of the same semantics must be kept in step if either schema changes.
- Hand-written validation code is a place bugs hide, and it runs on the security-critical import path.
- Reviewers will reasonably ask why the app validates JSON Schema itself. This record exists to answer
  that, and `06-interchange.md` §3 states the recommendation in context.

## Alternatives considered

**Option A — inline Ajv.** Correct and complete by construction. Rejected on size and on module-format
friction, but **retained as the documented fallback** if the differential corpus shows the targeted
validators cannot be trusted.

**Option B — load Ajv from a CDN like Mermaid.** Would keep the artifact small. Rejected: it makes
*importing a file* — the app's safest path and its primary mitigation against hostile files
(`08-security.md` §3) — depend on a network fetch and on a third-party script. Validation must work
offline, and importing a file must not require trusting a CDN.

**Option D — no validation; attempt the mapping and report failures as they occur.** Superficially
attractive, since the mapping code already knows what it expects. Rejected: it reports the *first*
structural problem rather than the set of them, gives poor diagnostics, and makes it hard to
distinguish "malformed file" from "bug in the mapper."

**Vendor a minimal, hand-picked subset of Ajv.** Rejected as the worst of the options: a modified copy
of a library with no upstream security updates and no clean upgrade path, while still carrying the
module-format problem.
