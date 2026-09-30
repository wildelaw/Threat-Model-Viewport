# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is right now

**There is no code yet.** The repository contains `LICENSE`, a one-line `README.md`, and the
specification: `SPEC.md`, `specs/00…10`, and `decisions/` (14 ADRs). The specification is the
deliverable that was asked for, and it is authoritative.

That means two modes of work, with different rules:

- **Writing the implementation** — follow the spec. Where the spec is silent, it is usually silent on
  purpose: check `specs/10-open-questions.md` before inventing an answer, and prefer the smallest thing
  consistent with the ADRs.
- **Changing the specification** — see *Editing the spec* below. The spec has invariants that are
  machine-checked, and breaking one silently is worse than not making the change.

## The spec is load-bearing

Requirements carry stable IDs (`REQ-<DOMAIN>-<NNN>`) that code and tests cite directly. Eleven domains:
`SHELL`, `DATA`, `VCS`, `SYNC`, `STORE`, `EXP`, `IMP`, `VIEW`, `EDIT`, `UI`, `SEC` — 107 requirements
total, each with acceptance criteria and a `- **Test:**` line.

`specs/09-testing.md` §3 specifies a test that enforces this in both directions: every requirement
cites at least one test, and every test is cited by at least one requirement. An ID with no test is a
spec bug. IDs are never reused after retirement.

## Counter-idiomatic constraints

These are the decisions most likely to be violated by writing normal modern JavaScript. Each is
deliberate, each has an ADR explaining what it costs, and most are enforced by static analysis over the
built artifact (`specs/09-testing.md` §5).

| Do not | Because |
|---|---|
| Use `import` / `export` / `type="module"` in shipped code | `file://` blocks module `src` on an opaque origin. One classic inline script, concatenated at build (ADR-0006) |
| Use a bundler, or add any build dependency | The build must run from a clean checkout with no install — that is the auditability claim (ADR-0009, REQ-SHELL-003) |
| Use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` | Model data is untrusted; escaping is the whole defence (REQ-SEC-003) |
| Use `eval`, `new Function`, string-argument timers, dynamic `<script>`, inline `on*=` | CSP forbids them; `script-src` is a hash (REQ-SEC-002, REQ-UI-008) |
| Use `crypto.subtle` for hashing | Async, secure-context-dependent, and must agree across browsers. Use the pure-JS synchronous SHA-256, verified against NIST vectors (ADR-0011) |
| Use a commit timestamp to decide which history wins | Timestamps are hashed and displayed but never decisive; ordering is ancestry only (ADR-0003) |
| Treat `localStorage` as the system of record | Firefox gives every `file://` path its own origin. The file is the carrier; storage is a cache (ADR-0001) |
| Access `localStorage` directly from a feature module | Everything goes through the storage adapter (REQ-STORE-001) |
| Deep-merge untrusted JSON into a normal object | Prototype pollution; reconstruct into `Object.create(null)` or copy fields explicitly (REQ-SEC-003) |
| Add a field to a mapping without updating the lossiness ledger | A differential test fails if any vendored-schema field is unclassified (`06-interchange.md` §7) |
| Expect a Carbon JS bundle | Carbon v11 ships none. Every tab, side nav, table, modal, dropdown and tree behaviour is hand-written vanilla JS toggling `cds--*` classes (ADR-0002). This is the largest workstream |

`.cds--row` does not exist in Carbon v11 — `.cds--grid` is itself the flex container.

## Commands

**None of these exist yet** — they are what the spec specifies. Treat writing them as part of building
the implementation, not as setup that already happened.

| Purpose | Command | Source |
|---|---|---|
| Build → `dist/threat-model-viewport.html` | `node build.mjs` | `02-architecture.md` §3 |
| Unit + property + interop tests | `node --test` | `09-testing.md` §2 |
| A single test file | `node --test test/unit/<name>.test.mjs` | same harness |
| Traceability check | included in `node --test` (`test/traceability.test.mjs`) | `09-testing.md` §3 |
| End-to-end | Playwright over `dist/`, on **both** `file://` and `http://localhost` | `09-testing.md` §4 |

There is **no linter and no formatter** configured, and the spec does not call for one. "Static
analysis" in this project means the custom checks over the built artifact, not ESLint.

Dev dependencies are permitted for *testing only* (Playwright, axe-core, Ajv). They never enter
`dist/`. The build itself has zero dependencies and CI runs it first with no install step.

## Architecture in one page

**The artifact is the entire application.** One HTML file that a user double-clicks. It contains the
app's JavaScript and CSS inline, plus a `<script type="application/json">` data block holding the
threat model and its full git-style history. Exporting produces another such file with new data and a
byte-identical script — which is why the CSP script hash is constant and computable at build time.

Three things follow from that and explain most of the design:

1. **The file is the primary carrier** (ADR-0001). Storage is a cache, reconcile is explicit, and the
   app must work with no storage at all.
2. **Everything in a file is untrusted** (ADR-0002's counterpart). An exported threat model is
   executable HTML; on Chrome and Edge every `file://` page shares one origin, so a hostile model can
   read every other model's storage. The primary mitigation is **"import, don't open"** — the import
   path reads files as text and never inserts them into the DOM (`specs/08-security.md` §3). CSP protects
   the *authentic* file and does nothing against a hostile one, because a hostile file writes its own
   policy.
3. **The canonical model is a neutral superset** of OTM and TML, with `x-otm` / `x-tml` passthrough
   bags carrying fields it does not interpret (ADR-0004). This is what makes import non-destructive.

History is a content-addressed commit DAG (SHA-256 over a canonical serialization), stored as JSON
Patch deltas with periodic keyframes (ADR-0005). Merge base is the LCA of two heads; divergence always
prompts and nothing is ever auto-merged (ADR-0003).

## Reading the spec

Read in numeric order — each document assumes the previous ones. `SPEC.md` is the index. §-level
citations across documents (`05-storage.md` §3) are load-bearing and resolve; keep them accurate when
editing.

The two documents worth reading early regardless of your task: `specs/08-security.md` (it constrains
almost every other decision) and `specs/10-open-questions.md` (it tells you what is *deliberately*
unresolved, so you do not "fix" a decision that was consciously deferred).

## Editing the spec

- **A new requirement needs a `- **Test:**` line** naming a test. Adding a requirement without one
  breaks the traceability test, by design.
- **Never renumber or reuse an ID.** A removed requirement's ID is retired, not recycled.
- **Changing an architectural decision means writing or superseding an ADR**, not editing the prose.
  ADRs carry Status / Context / Decision / Consequences / Alternatives; mark the old one
  `Superseded by ADR-nnnn` rather than deleting it.
- **Do not resolve an open question by editing it out of `10-open-questions.md`.** Answer it there,
  point to the ADR that now owns it, and remove it from the list.
- **The one escape hatch** to the traceability rule is the build-integrity exemption list in
  `test/traceability.test.mjs`. It currently holds a single test, `store.no-test-hooks-in-release`.
  Adding to it should be visible in review as a deliberate act.
- **`decisions/README.md`** holds an index table that must stay in step with the `decisions/` directory.

## Open verification tasks

Four platform facts are **unverified**, and each could invalidate part of the design. They are listed
in `specs/09-testing.md` §6 as V1–V4 and should be resolved before the code depending on them is
written — not discovered later:

- V1 — is `<script type="application/json">` exempt from a hash-only `script-src` on `file://`?
- V2 — is `<meta>`-delivered CSP enforced on `file://`? Until answered, `specs/08-security.md` §4 marks
  CSP-on-`file://` as **unconfirmed** rather than claiming it.
- V3 — what are the actual state classes in the pinned Carbon stylesheet? `specs/07-ui.md` §5 currently
  describes React's conventions, which are not the same thing.
- V4 — the pinned Mermaid version's `securityLevel` default and `htmlLabels` behaviour.

## Honest claims

The spec is written to avoid overclaiming, and new prose should match. Two places this matters:

- The hash chain proves **integrity, not authorship** (ADR-0008). The UI says "chain intact" and never
  "verified". Authorship is self-asserted and forgeable.
- The app is **not offline-capable** — Carbon comes from a pinned CDN (ADR-0002). This is the only
  accepted deviation from the stated requirements, and it is recorded as such in `SPEC.md`,
  `specs/00-overview.md`, and the ADR rather than being quietly reinterpreted.
