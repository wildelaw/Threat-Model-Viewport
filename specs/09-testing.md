# 09 — Testing

How requirements become tests, and how the suite is kept honest.

Related: REQ-SHELL-003 (dependency-free build), `06-interchange.md` §11, `08-security.md` §12.

---

## 1. The rule

> Every requirement in `01-requirements.md` cites at least one test by name.
> Every test in the suite is cited by at least one requirement.

Both halves matter. The first prevents a requirement being written and forgotten. The second prevents
tests accumulating that no longer correspond to anything anyone asked for — the usual way a suite
becomes slow and then gets skipped.

This is **machine-checked**, not maintained by hand (§3).

---

## 2. Harness

| Layer | Tool | Runs against |
|---|---|---|
| Unit | `node --test` | Source modules, concatenated in `BUILD_ORDER` |
| Property | `node --test` | Generated models and histories |
| Interop | `node --test` | Vendored schemas + example corpora |
| End-to-end | Playwright | The built artifact, over `file://` **and** `http://localhost` |
| Accessibility | axe-core via Playwright | The built artifact |
| Static | Node script | The built artifact's text |

### How unit tests load the source

The application's source files are plain script fragments attaching to a `TMV` namespace
(`02-architecture.md` §3) — no `import`, no `export`. The harness therefore:

1. Reads `BUILD_ORDER` from `build.mjs` — **the same list the build uses**, so the two cannot drift.
2. Concatenates those files.
3. Evaluates them in a `node:vm` context with a minimal DOM stub.
4. Exposes `context.TMV` to the test.

This is why the naming convention matters: a module that needed a real bundler could not be tested
this way, and the constraint is enforced by the harness rather than by convention.

The DOM stub is deliberately small — `document.createElement` returning objects with `textContent`
and `setAttribute`, and enough of `addEventListener` to attach. Anything a unit test needs beyond that
belongs in an end-to-end test instead, which keeps the pure logic genuinely pure.

### On development dependencies

`build.mjs` has **no dependencies** (REQ-SHELL-003). The test suite **does**: Playwright for
end-to-end, axe-core for accessibility, and Ajv for one specific cross-check (§5). These are
development-only and never enter the artifact.

This split is deliberate and worth stating, because "dependency-free" is otherwise read as applying to
the whole repository, which would make the browser-matrix testing in §4 impossible — and browser
behaviour is where this project's hardest bugs live.

---

## 3. Machine-checked traceability

A test in `test/traceability.test.mjs`:

1. Parses `specs/01-requirements.md`.
2. Extracts every requirement id (`REQ-*`) and every test name from its `- **Test:**` line.
3. Asserts every requirement has at least one test.
4. Asserts every test name appears in the suite's collected test names.
5. Asserts every collected test name is cited by at least one requirement, **or** appears in the
   build-integrity exemption list.
6. Asserts requirement ids are unique and no id has been reused for a different statement — the id
   registry is compared against a frozen list so a retired id cannot be recycled.

**Where citations come from.** Step 2 is the primary source, and it is not the only one. Two documents
name suite tests in an explicit table rather than through a requirement, and those tests are no less
asked for: `05-storage.md` §9 (storage behaviour spanning several requirements — an interrupted
commit, a second tab, a migration crash) and `06-interchange.md` §11 (differential interchange tests,
which no single requirement owns because each cuts across the OTM and TML mappings). Reading only
`01-requirements.md` would push those tests into the orphan list, which is where tests *nobody* asked
for belong — and a list that is wrong is a list people learn to route around. The citing documents
live in `CITING_DOCUMENTS` in `test/lib/spec.mjs`.

**The collection is textual, and deliberately a second implementation.** `test/lib/check.mjs` refuses
an uncited name at the moment a test file loads, which catches a typo in the file being run. The
traceability test instead parses the declared names out of the sources. Neither subsumes the other: a
runtime check cannot see a test that was deleted, and a source parse cannot see whether a name is
spelled the way the specification spells it if the file never runs. Importing the test modules to ask
them what they declared would run the suite, which is what `node --test` is for.

**The exemption list** holds tests that check the *release artifact* rather than a behaviour anyone
asked for. `store.no-test-hooks-in-release` is currently its only member: it asserts a condition of
`dist/` (no fault-injection hook compiled in) and no requirement would sensibly name it. The list is
`EXEMPT` in `test/lib/spec.mjs`, where both the name check in `check.mjs` and the assertion here can
read it, so adding to it appears in review as a deliberate act rather than a quiet edit — which is the
property that makes the rule worth having. Two further cases guard the list itself: every exempt name
must still be a test that exists, and the traceability test's *own* cases are declared with
`node:test` under ordinary prose names rather than exempted, so the list cannot grow to cover the
checker.

Failures name the requirement id or the orphaned test. **This test is what makes the spec load-bearing
rather than decorative** — without it, the documents and the code drift within a few iterations and the
spec becomes historical fiction.

**Browser tests declare themselves the same way.** The end-to-end specs in `e2e/` run under
Playwright, not `node --test`, so they cannot call `specTest`. They call `e2eTest(name)` from
`test/lib/check.mjs`, which applies the identical name check and returns the name for Playwright's own
runner to take (`test(e2eTest('e2e.ui.shell'), …)`). One rule, two runners. The directory is beside
`test/` rather than inside it because `node --test` with no path arguments imports every module under
any directory named `test/`, which would hand a Playwright spec to the unit runner; the traceability
collector therefore reads both roots (see `02-architecture.md` §3 for the layout).

### Requirement coverage by domain

The authoritative mapping is the `Test:` line in each requirement. This is the summary:

| Domain | Requirements | Representative tests |
|---|---|---|
| `SHELL` | 7 | `shell.no-relative-refs`, `shell.classic-script`, `build.clean-checkout`, `e2e.matrix.protocol` |
| `DATA` | 6 | `data.escape-roundtrip`, `data.passthrough.otm`, `data.corrupt-block-nondestructive` |
| `VCS` | 15 | `vcs.commit-hash-deterministic`, `vcs.reconstruct-fidelity`, `vcs.divergence.no-auto-merge`, `vcs.merge-two-parents` |
| `SYNC` | 8 | `sync.local-ahead-wins`, `sync.origin-independent`, `sync.partition-detected` |
| `STORE` | 8 | `store.registry-seeded-every-load`, `store.quota-preflight`, `store.no-silent-pruning`, `store.concurrent-commit` |
| `EXP` | 13 | `exp.tml-schema-identifier`, `exp.pristine-dom`, `exp.script-byte-identical`, `exp.self-verify` |
| `IMP` | 10 | `imp.detect-*`, `imp.dangling-refs-warn`, `imp.roundtrip-stable`, `sec.import-html-no-exec` |
| `VIEW` | 9 | `view.entity-coverage`, `view.diagram-coordinates`, `view.diagram-mermaid-lazy`, `perf.large-model` |
| `EDIT` | 10 | `edit.crud-coverage`, `edit.reference-selects`, `edit.passthrough-preserved` |
| `UI` | 12 | `ui.sidenav-per-tab`, `ui.tabs-keyboard`, `a11y.axe-core`, `sec.sri-pinned` |
| `SEC` | 8 | `sec.xss-model-fields`, `sec.svg-sanitized`, `sec.prototype-pollution`, `sec.no-exfiltration` |

---

## 4. The browser and protocol matrix

This project's hardest bugs come from platform behaviour, so the matrix is a first-class part of the
suite rather than a note.

| Axis | Values |
|---|---|
| Browser | Chrome, Edge, Firefox, Safari |
| Protocol | `file://`, `http://localhost` |
| Storage | Healthy, unavailable, quota-exhausted, partitioned (Firefox `file://`) |

Not every combination is meaningful. The ones that are, and what each is for:

| Combination | Exercises |
|---|---|
| Chrome + `file://` | Shared origin; registry spans models; the R1 exposure in `08-security.md` |
| Firefox + `file://` | **Per-file origin.** REQ-SYNC-008's detection and explanation |
| Chrome + `http://localhost` | Ordinary single-origin behaviour; storage does not carry over from `file://` |
| Safari + `file://` | The least predictable storage behaviour; must degrade, not break |
| Any + storage unavailable | REQ-STORE-007 — full function, no persistence |
| Any + quota exhausted | REQ-STORE-006 — clean failure, nothing removed |

`e2e.matrix.protocol` runs the core journey on both protocols. `e2e.file-protocol.firefox` is the one
that specifically asserts the partitioning explanation appears rather than the app looking broken.

### The core journey

One end-to-end path, run across the matrix, covering the requirements that only fail in combination:

```
open file → view model → edit → commit → export HTML → reopen export in a
clean profile → reconcile → edit → export → import into the first profile →
compare → merge
```

---

## 5. Test categories

### Unit
Pure logic: canonical serialization, hashing, patch application, ancestry, merge base, slug
derivation, escaping, detection, mapping.

### Property-based
Generated inputs where hand-written cases would miss the failing one:

| Property | Generator |
|---|---|
| `vcs.reconstruct-fidelity` | Random histories with random branch points and keyframe intervals; reconstruct each commit; assert the hash matches |
| `data.escape-roundtrip` | Strings containing `</script`, `<!--`, U+2028, U+2029 at random positions |
| `vcs.canonical-serialization` | Same model with shuffled key insertion order |
| `interop.slug-stability` | Random entity sets; export, shuffle, rename, re-export; assert identical slugs |
| `sec.prototype-pollution` | `__proto__`/`constructor`/`prototype` injected at random depths |

### Interop differential
Detailed in `06-interchange.md` §11. Two are load-bearing:

- **`interop.validator-vs-ajv`** — our hand-written validator's verdict must match Ajv's across a
  corpus including deliberate violations. Ajv is a **test-only** dependency and never ships. This is
  what makes the `06-interchange.md` §3 recommendation (option C) safe: a hand-written validator that
  is proven to agree with a reference implementation, on a corpus, on every run.
- **`interop.lossiness-complete`** — every field in the vendored schemas is classified as mapped,
  folded, or dropped. A field present in a schema but absent from the lossiness ledger fails the test.
  This converts "did we forget a field?" from a review question into a mechanical check.

### Fault injection
`store.interrupted-commit` and `store.migration-verify-before-remove` require writes to fail on
command, so the storage adapter exposes a test hook. The hook is **compiled out of release builds** —
its presence in `dist/` is itself a test failure (`store.no-test-hooks-in-release`).

### End-to-end
The matrix in §4, plus: import of each format, export and reopen, compare and merge, delete, quota
recovery, and every error screen.

### Accessibility
axe-core over every screen and state — including modals, the compare view, and error states, which are
the states axe is usually not run against. Plus keyboard-only journeys and focus-management assertions.

### Static analysis
Over the **built artifact**, not the sources — the artifact is what ships.

| Check | Requirement |
|---|---|
| No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` | REQ-SEC-003 |
| No `eval`, `new Function`, string-argument timers, dynamic `<script>` | REQ-SEC-002 |
| No `on*=` attributes | REQ-UI-008 |
| No `<script type="module" src="…">` with a relative URL | REQ-SHELL-002 |
| No relative `src`/`href` to sibling files | REQ-SHELL-001 |
| Every external URL has an exact version and an `integrity` attribute | REQ-UI-012 |
| No feature module references `localStorage` directly | REQ-STORE-001 |
| No test hook present | §5 |
| CSP meta appears before the first `<script>` | REQ-SEC-001 |

### Performance
`perf.large-model` is a **benchmark, reported but not asserted** in CI — machine-dependent thresholds
make flaky gates, and the requirement (REQ-VIEW-009) is about staying interactive, which is better
judged from a trend than a single number. It generates a 5,000-entity model and reports render time
and sort/scroll blocking.

---

## 6. Blocking verification tasks

Four platform questions are **unverified**. Each could invalidate part of the design, so each is done
before the code that depends on it is written, and the finding is recorded in the relevant spec
regardless of outcome.

| # | Question | Affects | If it fails |
|---|---|---|---|
| V1 | Is a non-executable `<script type="application/json">` exempt from a hash-only `script-src`, on `file://`, in all four browsers? | `02-architecture.md` §4 | Compute the data block hash at export time and add it to the policy (documented fallback) |
| V2 | Is `<meta>`-delivered CSP enforced on `file://` in all four browsers? | `02-architecture.md` §5, `08-security.md` §4 | Tamper detection holds only over HTTP; `08-security.md` must say so |
| V3 | What are the actual state classes for tabs, side nav, and modal in the pinned Carbon stylesheet? | `07-ui.md` §5 | Correct the inventory; the docs describe React's conventions, not the CSS |
| V4 | What are the pinned Mermaid version's `securityLevel` default and `htmlLabels` behaviour? | `08-security.md` §6 | Configure explicitly, or reconsider rendering Mermaid at all |

V1 and V2 change the artifact's CSP string. V3 changes the UI. V4 changes a security claim. None is
expensive to test and all are expensive to discover late.

---

## 7. What is not automated

Three requirements are review-only and marked as such, because a script cannot judge them:

| Requirement | Why |
|---|---|
| `docs.behaviour-inventory` (REQ-UI-010) | Whether §5 of `07-ui.md` matches the code |
| `docs.threat-model` (REQ-SEC-006) | Whether the security documentation is honest and current |
| Copy review for identity labelling (`08-security.md` §8) | Whether the UI ever implies authorship is verified |

These are checked at review time and listed here so their absence from CI is a decision rather than an
oversight.

---

## 8. Continuous integration

| Stage | Runs | Gate |
|---|---|---|
| Build | `node build.mjs` from a clean checkout, no install | **Blocking** |
| Static analysis | Over `dist/` | **Blocking** |
| Unit + property + interop | `node --test` | **Blocking** |
| Traceability | §3 | **Blocking** |
| End-to-end | Playwright, Chrome + Firefox, both protocols | **Blocking** |
| End-to-end | Safari, Edge | Non-blocking; nightly |
| Accessibility | axe-core | **Blocking** |
| Performance | Benchmark | Reported only |

The build stage runs **first and with no install step**, which is the machine-checkable form of
REQ-SHELL-003: if anyone adds a build dependency, that stage fails.

Safari and Edge are non-blocking because they are slow to provision, but their absence from the
blocking path must not become a reason to skip them — the storage differences in `05-storage.md` §4
are real, and a regression that only appears on Safari should be found by the nightly run rather than
by a user.
