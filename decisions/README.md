# Architecture Decision Records

Each record captures one decision that is expensive to reverse, the reasoning behind it, and what it
costs. They are numbered in the order they were made, not in order of importance.

**Status values:** `Accepted` — in force · `Superseded by ADR-nnnn` — replaced · `Proposed` — needed,
not yet settled.

| # | Decision | Status |
|---|---|---|
| [0001](0001-file-first-storage.md) | The artifact is the primary carrier; local storage is a cache | Accepted |
| [0002](0002-carbon-via-cdn.md) | Carbon v11 stylesheets from a pinned CDN | Accepted |
| [0003](0003-divergence-always-prompts.md) | Divergence always prompts; fast-forward auto-adopts | Accepted |
| [0004](0004-neutral-superset-canonical-model.md) | Neutral superset model with per-format passthrough bags | Accepted |
| [0005](0005-delta-history-with-keyframes.md) | History as JSON Patch deltas plus periodic keyframes | Accepted |
| [0006](0006-classic-inline-script.md) | One classic inline script; modules at authoring time only | Accepted |
| [0007](0007-hybrid-tabs-and-per-tab-side-nav.md) | Nine hybrid top tabs, each with its own side nav | Accepted |
| [0008](0008-self-asserted-identity.md) | Self-asserted identity and a hash chain; no signing in v1 | Accepted |
| [0009](0009-modular-source-with-build-step.md) | Modular `src/` with a dependency-free build script | Accepted |
| [0010](0010-diagram-rendering-strategy.md) | Diagram rendering by source format | Accepted |
| [0011](0011-pure-js-sha256.md) | Pure-JavaScript synchronous SHA-256 | Accepted |
| [0012](0012-targeted-schema-validators.md) | Hand-written validators, Ajv cross-check in tests only | Proposed |
| [0013](0013-full-crud-in-v1.md) | Full CRUD on every entity type in v1 | Accepted |
| [0014](0014-v1-import-formats.md) | Four import formats in v1; Threat Dragon deferred | Accepted |

## The two that are easiest to get wrong

**ADR-0002 is the only accepted deviation from a stated requirement.** It should be read before
complaining that the app needs a network connection.

**ADR-0001 is the one everything else depends on.** If the artifact is not the primary carrier,
requirements 6 and 9 (`06`-era assumptions about shared browser storage) cannot be satisfied on
Firefox at all. Read it before proposing to move state into the browser.

## Records referenced but not written

None. Every decision named in the spec documents resolves to a record here, and every question left
unanswered is in [`specs/10-open-questions.md`](../specs/10-open-questions.md) rather than being
absent from both.
