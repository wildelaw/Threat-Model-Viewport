# 10 — Open Questions

Decisions deliberately **not** made. Each is either deferred past v1, or blocked on evidence the
project does not yet have.

This file is not a backlog. A backlog item is work someone has decided to do; these are questions
someone has decided *not to answer yet*, with the reason and the cost of being wrong.

Priority key: **P1** — affects v1 correctness or scope, decide during implementation · **P2** — should
be decided before v2 · **P3** — revisit if the need appears.

---

## Blocking platform verifications

These are questions with factual answers that can be resolved by experiment. They are listed in
`09-testing.md` §6 as V1–V4 and are **not** open design questions — they are unknowns, and they are
resolved before the code that depends on them.

| # | Question | Blocks |
|---|---|---|
| V1 | `<script type="application/json">` exemption from hash-only `script-src` on `file://` | The CSP string in every exported file |
| V2 | `<meta>` CSP enforcement on `file://` | Whether tamper detection is universal or HTTP-only |
| V3 | Actual Carbon state classes in the pinned stylesheet | The whole UI wiring inventory |
| V4 | Pinned Mermaid `securityLevel` default and `htmlLabels` | Whether Mermaid can be rendered safely |

---

## P1 — Decide during v1 implementation

### OQ-01 — Schema validator: targeted hand-written, or Ajv from CDN?

**Recommendation:** targeted validators + a test-only Ajv cross-check (ADR-0012), because it keeps the
runtime dependency-free and still gives a validator proven to agree with a reference implementation.

**Why it is open:** the cross-check only proves agreement on the corpus. If the corpus is thin in some
keyword's coverage, a divergence ships. The mitigation is corpus breadth, and the corpus should be
reviewed once real-world models have been imported.

**Cost of being wrong:** an import accepts malformed data, or rejects valid data. The first is worse —
it propagates invalid data on re-export into someone else's tool.

---

### OQ-02 — The TML extension namespace needs a domain the project controls

TML's `extensions` keys must match a `domain.tld/extension-name` pattern, so provenance cannot be
written without naming a domain. Writing one the project does not own is squatting.

**Options:** register a domain · use a GitHub Pages URL under the project's own org · omit provenance
on TML export and say so in the report.

**Current behaviour:** the third. Provenance is written to OTM (`attributes` is unconstrained, so no
domain is needed) and **omitted** from TML export unless a domain is configured in Settings.

**Cost of being wrong:** TML round trips lose provenance. Low severity, but it is a real gap in
REQ-IMP-006.

---

### OQ-03 — Diagram merge UX

Geometry conflicts are presented as whole-element choices (take A's layout or B's), because a table of
`x`/`y` values is not a usable resolution interface.

**Why it is open:** this is coarse. Two people who moved different components should be able to keep
both moves, and currently cannot without discarding one layout.

**Options:** per-element resolution (finer, but still a list of coordinates) · a visual merge on the
canvas (correct, but this is diagram *authoring*, which is a v1 non-goal) · accept the coarseness.

**Cost of being wrong:** a user loses a layout change they wanted to keep. Recoverable from the DAG —
nothing is discarded — but annoying.

---

### OQ-04 — Cross-tab coordination

v1 detects a concurrent commit and refuses it (`05-storage.md` §6). It does not coordinate.

**Why it is open:** a lock or a "take over" action is a real feature with real edge cases (abandoned
locks, stale tabs), and refusing-and-comparing may be sufficient for the actual usage pattern, which
is one person with one file open in one tab.

**Cost of being wrong:** a user with two tabs open does more reconciliation work than necessary. Not
data loss — the refusal path is safe.

---

### OQ-05 — Export without history, for privacy

Commits carry author names and emails. Sending a model outside an organization distributes them.
Replacing history would rewrite commit ids and break reconciliation, so it is not offered as a
"strip authors" button.

**The right fix** is a distinct export: *current model only, single root commit, no history* —
explicitly a different artifact with a different purpose, not a modified history.

**Why it is open:** it is a new export mode with its own requirements (what is the root commit's
author? what is its message?), and v1's export surface is already large.

**Cost of being wrong:** a user cannot easily share a model without also sharing who worked on it. See
`08-security.md` §10.

---

### OQ-06 — Tab taxonomy after real models

The nine-tab grouping is a design decision made without real data. The hybrid choice means the side
nav's meaning changes per tab — entity types under Architecture, functions under Threats/Controls/Risk.

**Why it is open:** it cannot be evaluated without seeing how people actually use OTM and TML models.
A TML model has no assets and a rich threat/risk/control story; an OTM model is the reverse. The tab
that matters most differs by source format.

**Action:** revisit after importing a representative sample of real models, and consider whether the
active tab set should adapt to what the model actually contains.

**Cost of being wrong:** navigation friction. Recoverable, but the kind of thing that is much cheaper
to fix before the views are built than after.

---

## P2 — Decide before v2

### OQ-07 — Cryptographic signing

ADR-0008 defers it. The hash chain detects modification but not forgery, and the UI says "chain
intact", never "verified".

**The fix:** sign commits with a WebCrypto key (ECDSA P-256 for broad support), show a verified /
unverified badge, and require trust-on-first-use for a new key.

**Why deferred:** key generation, storage, export/import, and TOFU trust UX is a feature in its own
right — larger than it appears — and it only helps if recipients actually check.

**Cost of being wrong:** authorship remains forgeable and the app must keep saying so. Acceptable for
v1; embarrassing if the tool is used for anything with an audit requirement.

---

### OQ-08 — Offline build target

ADR-0002 accepts a CDN dependency for Carbon. The seam exists so an inlined build can be added.

**The cost, restated:** inlining Carbon adds ~939 KB to *every* exported threat model file. For an
air-gapped user or a locked-down network, that may be worth it; for a routine export, it is not.

**Possible shape:** a separate build target rather than a setting, so the artifact's size is a property
of the build the user chose, not a per-export option that produces two incompatible-looking files.

**Cost of being wrong:** users on isolated networks cannot use the tool at all. `00-overview.md`
names the air-gapped contributor as a persona, so this is a real gap, not a hypothetical one.

---

### OQ-09 — WCAG conformance target and audit

REQ-UI-007 targets WCAG 2.1 AA, and `07-ui.md` §8 lists obligations. Automated axe checks catch
roughly a third of AA issues.

**Why it is open:** the two compositions that need human review — the single-panel tab pattern and the
three-column compare view — are exactly the ones a tool cannot judge, and the compare view is the
screen where a keyboard-only user is most likely to be blocked.

**Action:** commission a manual audit, or accept and document a weaker claim. Claiming AA without an
audit is the outcome to avoid.

---

### OQ-10 — Threat Dragon import

Deferred (`00-overview.md`, non-goals). Research confirms a viable mapping exists — `tm.Actor`,
`tm.Process`, `tm.Store`, `tm.Flow`, `tm.Boundary` map to canonical entity types, and threats nest in
cells.

**Why deferred:** Threat Dragon's own OTM export is currently broken upstream, which makes it an
unreliable counterpart — the app would be tested against a format that the reference implementation
does not currently produce.

**Cost of being wrong:** users with existing Threat Dragon models cannot bring them in directly. They
can via OTM if and when upstream export works.

---

### OQ-11 — TM-BOM (CycloneDX) as a third format

CycloneDX's Threat Model BOM was accepted for CycloneDX 2.0, and the TML project has said a further
schema version will follow to ensure semantic compatibility. TML 1.0.2 is therefore **expected to
change**.

**Two distinct concerns:**

1. Should TM-BOM be an interchange target? It is BOM-shaped and oriented toward tool chains rather
   than human modeling, so it may be a poor fit for a *viewport*.
2. **TML schema drift.** When TML bumps for TM-BOM compatibility, the vendored schema and the mapping
   must be re-verified. `interop.lossiness-complete` will catch added fields; it will not catch
   changed semantics.

**Action:** pin the vendored TML schema version explicitly, and treat a schema bump as a reviewed
change with the interop suite re-run — not a routine vendoring update.

---

### OQ-12 — Storage backend beyond `localStorage`

`localStorage` is ~5 MB, synchronous, string-only, and blocked or partitioned on `file://` in ways
ADR-0001 documents. IndexedDB is worse on `file://` (Firefox blocks it outright). OPFS is not
available on `file://`.

**Why it is open:** the adapter (`05-storage.md` §1) exists so a better backend can be added, but on
`file://` there may not be one. The realistic answer is that `localStorage` is the ceiling for the
primary use case, and the quota limits are permanent.

**Cost of being wrong:** large models with long histories hit the ceiling and must be pruned or split.
The quota design (§`05-storage.md` §5) assumes this is survivable; if real models are much larger than
expected, it may not be.

---

## P3 — Revisit if the need appears

### OQ-13 — Graphviz and PlantUML rendering

v1 renders Mermaid lazily and shows Graphviz/PlantUML as source (ADR-0010).

**Why deferred:** a Graphviz renderer is a WASM build of a large C library, and PlantUML needs a Java
service or a server-rendered image — neither fits a single-file app that makes no runtime calls.
Mermaid works because it is pure JavaScript.

**Cost of being wrong:** a TML model with a Graphviz diagram is readable as source but not as a
picture. Given that TML diagrams are source text by design, this may be acceptable permanently.

---

### OQ-14 — Print / PDF export

Not requested. A threat model is often needed as a document for a review meeting.

**Why it deferred:** printing a single-page app is its own design problem — the shell chrome, the side
nav, and the tabbed structure all fight a printed page. `src/styles/01-print.css` is reserved for it.

**Cost of being wrong:** users screenshot instead, and the screenshots are worse.

---

### OQ-15 — Keyboard shortcuts

v1 has standard navigation only.

**Why deferred:** shortcuts are only useful once the frequent actions are known, and the commit /
compare / import flows are the candidates. Guessing early risks binding keys that a later design needs.

---

### OQ-16 — Internationalization and RTL

The model data supports Unicode, and Carbon has RTL support via `dir` and logical properties.

**Why deferred:** the UI is English-only and the string count is large enough that retrofitting i18n is
a real cost. Worth deciding *before* the UI strings are written, however — hence listing it here rather
than leaving it unmentioned.

**Cost of being wrong:** every string has to be extracted later. This is the cheapest item on this list
to get right early and the most annoying to fix late.

---

### OQ-17 — Proposing a `state` vocabulary upstream

OTM types `state` as a free string with no enum, and the official examples use four values
inconsistently. `03-data-model.md` §4.10 defines a canonical vocabulary that is a UI convenience, never
a validation gate.

**Why it matters beyond this project:** a shared vocabulary would make threat states interoperable
between tools instead of each inventing one.

**Action:** consider proposing the vocabulary in the OTM repository. It costs little and the format
needs it regardless of what this project does.

---

### OQ-18 — Multi-model workspaces

One model per file. The registry allows switching; there is no cross-model view.

**Why deferred:** cross-model reporting (shared components, recurring threats, aggregate risk) is a
different product with a different data model — it needs a set, not a model.

**Cost of being wrong:** an organization with twenty models cannot see across them. They would more
likely adopt a hosted platform for that, which is a reasonable outcome.

---

### OQ-19 — Folding actors and data stores into components by default

On OTM export, TML's `actors` and `dataStores` have no home, but they *can* be folded into
`components` with a synthesized `type` — which is exactly how OTM models them
(`06-interchange.md` §5.3).

It is offered as an explicit option, not applied silently, because folding is a semantic claim about
what an actor *is*.

**Why it is open:** whether folding should be the default for TML → OTM export depends on how much
better a fully-populated OTM document is than one missing its actors. Probably yes; not obviously so.

---

### OQ-20 — Model size limits

`08-security.md` §5 sets guards (container size, commit count, patch operations, nesting depth) chosen
without empirical data on real models.

**Action:** revisit once real models have been imported, and replace the guesses with observed
distributions. A limit that rejects a legitimate model is worse than one that lets a hostile model be
slow.
