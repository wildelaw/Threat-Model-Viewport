# Threat-Model-Viewport

A threat model you can email. One HTML file that carries the model, its full revision history, and the
application that reads and edits it — so a threat model circulates as a **document** rather than as a
link into someone's platform tenant.

[![CI](https://github.com/wildelaw/Threat-Model-Viewport/actions/workflows/ci.yml/badge.svg)](https://github.com/wildelaw/Threat-Model-Viewport/actions/workflows/ci.yml)

Double-click the file and you have a viewer, an editor, and a git-style version control client. Send it
to a colleague, get it back with their changes, and the app reconciles the two histories on your own
machine — no server, no account, and no network calls carrying model data.

**Status:** v0.1.0, under active development. The specification is authoritative and the implementation
is written against it; see [Status and honest claims](#status-and-honest-claims) for what is not yet
verified.

---

## The problem this solves

Threat models are authored in tools that assume a server. But a threat model is usually a document you
send to someone — attached to a ticket, committed beside the code it describes, handed to an assessor.
When it lives in someone's tenant, it stops being a document and becomes a link that expires with their
licence.

The interchange formats that exist — IriusRisk's **Open Threat Model (OTM)** and the **OWASP Threat
Model Library Schema (TML)** — are transport formats. They carry the model and nothing about who changed
what, when, or why: no revision field, no timestamp, no history. That is by design. They describe a
threat model, not its authorship.

So two people can be sent the same model, each annotate it, and there is no mechanism to bring those
changes back together short of a human reconciling both files by eye. The format that makes the model
portable is exactly the format that makes the edits unmergeable.

**Threat-Model-Viewport closes that gap by putting a version control system inside the document.**

|  | Hosted threat-model platform | Threat-Model-Viewport |
|---|---|---|
| Where the data lives | Vendor's database | Inside the file you hold |
| How you share | A URL and an account | A file, over any channel |
| Who can read it | Anyone the vendor grants | Anyone you hand the file to |
| History | Server-side, opaque | In the file, inspectable JSON |
| Works offline | Usually not | Yes, once loaded — see [Status and honest claims](#status-and-honest-claims) |
| Import into a commercial tool | Native | Via OTM export |

---

## Quick start

The build has **no dependencies and no install step** — that is a deliberate, machine-checked property
(`REQ-SHELL-003`, [ADR-0009](decisions/0009-modular-source-with-build-step.md)), not an accident of the
current dependency list.

```sh
git clone https://github.com/wildelaw/Threat-Model-Viewport.git
cd Threat-Model-Viewport

node build.mjs          # → dist/threat-model-viewport.html   (~1.5 MB)
```

Then open `dist/threat-model-viewport.html` — double-click it, or `open dist/threat-model-viewport.html`
on macOS. It runs from `file://` with nothing else in the directory.

Node 24 is what CI uses. There is no `npm install` in the build path at all: if you find yourself
needing one, something has gone wrong.

### Getting a build without building it

CI attaches `dist/threat-model-viewport.html` to a GitHub Release for any `v*` tag, so the file a user
downloads is the file the pipeline tested. Until a release is tagged, `node build.mjs` is the way.

---

## Using it

### Opening a model

The app opens with the model embedded in the file. From there:

- **Import** (header overflow menu, or Settings → Import) reads an existing threat model. Four formats
  are detected **by content**, not by extension — a mis-named file works, and you do not have to know
  what format your file is in ([ADR-0014](decisions/0014-v1-import-formats.md)):
  - **OTM** (IriusRisk), JSON
  - **TML** (OWASP Threat Model Library), JSON
  - **Native container** — this app's own JSON
  - **Exported HTML** — a file this app previously produced
- Every import produces a **report** of what was mapped, what was folded, and what was dropped, rather
  than a silent conversion. A file that fails schema validation is not rejected outright: it can be
  opened read-only via "Import anyway (limited)".

### Reading a model

Nine tabs, content first and mechanics last:

| # | Tab | Contents |
|---|---|---|
| 1 | **Overview** | Scope, metadata, contributors, export readiness |
| 2 | **Architecture** | Trust zones, boundaries, components, actors, data stores, the diagram |
| 3 | **Data** | Data sets and OTM assets, sensitivity, CIA ratings, placement |
| 4 | **Flows** | Data flows and where they cross trust boundaries |
| 5 | **Threats** | Threats, personas, assumptions, threat-to-target links |
| 6 | **Controls** | Countermeasures and what they cover |
| 7 | **Risk** | 5×5 risk matrix, risk register, rating inputs |
| 8 | **History** | Commits, comparison, conflicts, stashes, integrity |
| 9 | **Settings** | Identity, storage, import/export, diagram, appearance, about, danger zone |

Each tab has its own side navigation of sub-sections. Filters like *Unencrypted*, *Cross-Zone* and
*Coverage Gaps* are marked with counts so they read as findings rather than empty sections.

### Editing and committing

Every entity type can be created, updated and deleted, and the model's own name and description are
editable too ([ADR-0013](decisions/0013-full-crud-in-v1.md)). Edits accumulate in a working copy; you
**commit** them with a message and an author, exactly as you would with git.

- The author comes from the **identity** in Settings → Identity. Set it once before your first commit.
- Identity is **self-asserted** — see [Status and honest claims](#status-and-honest-claims).
- History is a content-addressed DAG. Reverting to an earlier commit creates a *new* commit whose
  content matches the target; it never removes history.
- Undo/redo is scoped to the uncommitted working copy and stops at the commit boundary.

### Exporting

From Settings → Export:

- **OTM** or **TML** JSON, for the wider ecosystem. Both show a **lossiness ledger** and an export
  readiness list before you commit to the export, so nothing is dropped silently.
- **Native container** JSON.
- **Exported HTML** — the full application with your model and history embedded, regenerated from a
  pristine copy of the boot DOM. Because the app script is byte-identical between exports, the content
  security policy's script hash is constant and computable at build time.

### Reconciling two copies

This is the feature the project exists for. When a file's history has diverged from what this browser
has stored, the app **stops and asks** rather than guessing ([ADR-0003](decisions/0003-divergence-always-prompts.md)):

- **Fast-forward** — one history is a strict ancestor of the other; the descendant wins, no merge.
- **Divergence** — neither is an ancestor of the other. The Compare & Merge view shows a three-pane
  entity diff (base / file / local) with per-entity and per-field choices. It defaults to showing
  **conflicts only**, since that is where a decision is actually needed. Non-conflicting changes are
  pre-selected *as a suggestion*; conflicts have no pre-selection and the user must pick. Nothing is
  written until you confirm.

Nothing is ever merged automatically.

### Storage, and why your browser matters

**The file is the system of record.** Browser `localStorage` is a cache that makes the common case fast
([ADR-0001](decisions/0001-file-first-storage.md)) — never the sole source of truth. This matters
because `file://` origin behaviour is browser-dependent and was never standardised:

- **Chrome and Edge** treat all local files as one origin. Convenient — and it means any HTML file you
  ever saved to disk shares that bucket. The app tells you when this applies.
- **Firefox 92+** treats each file path as its own origin. Safer, but storage does not follow a file
  that is moved or renamed. The app detects this and explains it rather than looking broken.
- **`http://localhost`** and `file://` have **separate** stores, even for the same file.

The app is fully functional with storage unavailable or exhausted — it just does not persist.

### Themes and accessibility

Four built-in Carbon themes, plus a light/dark switch in the header. The UI targets Carbon's 2× grid
breakpoints down to 320px and is tested with axe-core across every screen and state, including modals,
the compare view and error states.

---

## Security: import, don't open

**Read this before you open a threat model someone sent you.**

An exported threat model is an executable HTML file. On Chrome and Edge, every `file://` page shares
one origin — so a hostile threat-model file that you double-click can run its own code and read every
other model in that origin's storage.

The content security policy in the file protects the *authentic* artifact. It does nothing against a
hostile file, because a hostile file writes its own policy. The primary mitigation is a usage rule:

> **Import the file through the app; do not open it in a new tab.**

The import path reads files as text and never inserts them into the DOM (`specs/08-security.md` §3).
This is a deliberate design decision, and its limits are documented rather than glossed: see
`specs/08-security.md` §11 for the residual risk stated plainly.

Other security properties worth knowing:

- **The hash chain proves integrity, not authorship.** It detects corruption and naive tampering, not
  forgery. Commit identity is self-asserted. The UI says "chain intact" and never "verified".
- **No model data is transmitted.** The only permitted network requests are pinned, SRI-checked CDN
  assets (Carbon's stylesheet, IBM Plex fonts, lazily-loaded Mermaid). No request carries model content
  in a URL, body or header.
- **Model content is untrusted throughout.** All rendering escapes; there is no `innerHTML`, no `eval`,
  no inline `on*=` handler, and untrusted JSON is reconstructed into null-prototype objects rather than
  deep-merged.

---

## Repository layout

```
SPEC.md                  Index and entry point for the specification
specs/00–10              The specification (see below)
decisions/               14 ADRs, one per locked architectural decision
CLAUDE.md                Guidance for working in this repository

src/index.html           The artifact template, with {{PLACEHOLDER}} markers
src/app/*.js             Numbered modules, concatenated in BUILD_ORDER
src/styles/*.css         Application CSS, inlined at build
build.mjs                The dependency-free build
dist/                    Build output (git-ignored)
vendor/                  Pinned OTM/TML schemas, Mermaid pin, example corpora
test/                    node:test units + static analysis over the built artifact
e2e/                     Playwright specs (browser × protocol matrix)
IMPLEMENTATION-STATUS.md Where and why the implementation interprets the spec
```

The specification is the source of truth, and it is read in numeric order — each document assumes the
previous ones:

| Document | What it settles |
|---|---|
| [`SPEC.md`](SPEC.md) | Index, glossary, requirement ID scheme, non-negotiables |
| [`specs/00-overview.md`](specs/00-overview.md) | Goals, non-goals, personas, accepted deviations |
| [`specs/01-requirements.md`](specs/01-requirements.md) | 107 numbered requirements with acceptance criteria |
| [`specs/02-architecture.md`](specs/02-architecture.md) | Single-file shape, build, self-export, Carbon seam |
| [`specs/03-data-model.md`](specs/03-data-model.md) | Canonical model, passthrough bags, id strategy |
| [`specs/04-versioning.md`](specs/04-versioning.md) | Commit DAG, hash chain, deltas, merge algorithm |
| [`specs/05-storage.md`](specs/05-storage.md) | Persistence, origins, registry, quota |
| [`specs/06-interchange.md`](specs/06-interchange.md) | OTM + TML import/export, mapping, lossiness |
| [`specs/07-ui.md`](specs/07-ui.md) | Carbon shell, tabs, side nav, screens |
| [`specs/08-security.md`](specs/08-security.md) | Threat model of the app itself |
| [`specs/09-testing.md`](specs/09-testing.md) | Test harness and traceability matrix |
| [`specs/10-open-questions.md`](specs/10-open-questions.md) | Deliberately deferred decisions |

Requirements carry stable IDs (`REQ-<DOMAIN>-<NNN>`) that code and tests cite directly, across eleven
domains: `SHELL`, `DATA`, `VCS`, `SYNC`, `STORE`, `EXP`, `IMP`, `VIEW`, `EDIT`, `UI`, `SEC`. A test
enforces traceability in both directions — every requirement cites at least one test, and every test is
cited by at least one requirement. An ID with no test is a spec bug.

---

## How it is built

**The artifact is the entire application.** One HTML file containing the app's JavaScript and CSS
inline, plus a `<script type="application/json">` data block holding the threat model and its full
git-style history. Exporting produces another such file with new data and a byte-identical script,
which is why the CSP script hash is constant and computable at build time.

Three constraints drive most of the design, and each is counter-idiomatic on purpose:

1. **The file is the carrier, not the browser.** Correctness never depends on storage being shared
   across files, because it is not, on Firefox.
2. **Carbon v11 ships no JavaScript.** No UMD build, and the Web Components are code-split ES modules.
   Every tab, side nav, table, modal, dropdown and tree behaviour is hand-written vanilla JS toggling
   `cds--*` classes. This is the largest implementation surface in the project, and it is inventoried
   with its class contracts in [`specs/07-ui.md`](specs/07-ui.md) §5.
3. **Everything in a file is untrusted.** See the security section above.

Consequences a contributor will meet immediately, all enforced by static analysis over the built
artifact:

| Do not | Because |
|---|---|
| Use `import` / `export` / `type="module"` in shipped code | `file://` blocks module `src` on an opaque origin. One classic inline script, concatenated at build |
| Use a bundler, or add any build dependency | The build must run from a clean checkout with no install |
| Use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` | Model data is untrusted; escaping is the whole defence |
| Use `eval`, `new Function`, string-argument timers, dynamic `<script>`, inline `on*=` | CSP forbids them |
| Use `crypto.subtle` for hashing | Async, secure-context-dependent. A pure-JS synchronous SHA-256 is verified against NIST vectors |
| Access `localStorage` directly from a feature module | Everything goes through the storage adapter |
| Deep-merge untrusted JSON into a normal object | Prototype pollution |

`CLAUDE.md` carries the full list with the ADR behind each one.

### Build

```sh
node build.mjs     # or: npm run build
```

Concatenates `src/styles/*.css` and `src/app/*.js` in `BUILD_ORDER`, computes the CSP script and style
hashes, substitutes them into `src/index.html`, and **verifies the artifact's declared hash against the
script it actually carries**. It fails loudly on an unresolved placeholder, on a literal `</script`
sequence anywhere in the concatenated source, or on a test hook that survived stripping. Nothing is
minified — the CSP hash is computed over the final bytes.

The seed container is produced by *evaluating the application's own modules* rather than by a second
implementation of canonical serialization in the build. Two implementations of the hash input would
drift, and the drift would be silent.

### Test

The suite reads `dist/`, not `src/` — the artifact is what ships — so **build first**.

```sh
npm install            # test-only dev dependencies; they never enter dist/
node build.mjs
npm test               # node --test
```

`node --test` runs the static analysis, unit, property-based, interop differential, traceability and
accessibility suites in one command. A single file:

```sh
node --test test/unit/vcs.test.mjs
```

End-to-end tests are Playwright, in `e2e/` (deliberately *not* under `test/`, where `node --test` would
import them outside their own runner):

```sh
npx playwright install chromium firefox
npm run test:e2e
```

They drive a real browser against `dist/` over both `file://` and `http://localhost`. To look at the
artifact by hand, `e2e/serve.mjs` is a static server with no dependencies:

```sh
node e2e/serve.mjs dist 4173
# → http://127.0.0.1:4173/threat-model-viewport.html
```

Dev dependencies (Playwright, axe-core, Ajv) are permitted for **testing only**. Ajv exists to prove the
hand-written schema validators agree with a reference implementation on every run; axe-core drives the
accessibility stage. There is no linter and no formatter — "static analysis" in this project means the
custom checks over the built artifact.

### CI

Four jobs in [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Job | Gate | Notes |
|---|---|---|
| **Build** | Blocking | From a clean checkout with **no install step**, and asserts `node_modules` is absent |
| **Test** | Blocking | Static, unit, interop, traceability, a11y — via the same `node --test` a developer runs |
| **End-to-end** | Blocking | Chromium and Firefox on every run; Safari/WebKit is nightly and non-blocking |
| **Release** | On `v*` tags | Attaches the tested artifact to a GitHub Release |

The build is uploaded once and downloaded by the later jobs, which do not rebuild — so the bytes tested
are the bytes published. The performance benchmark is reported but not asserted; machine-dependent
thresholds make flaky gates.

---

## Status and honest claims

The specification is written to avoid overclaiming and the code follows it. Points that matter:

- **v0.1.0 — not yet released.** No `v*` tag has been pushed, so there is no downloadable artifact yet;
  build from source.
- **The application is not offline-capable.** Carbon's stylesheet comes from a pinned CDN
  ([ADR-0002](decisions/0002-carbon-via-cdn.md)) rather than being inlined, because inlining it would
  add ~939 KB to *every exported threat model file* and re-exporting is routine. Offline, the app
  degrades to unstyled-but-functional HTML. This is **the only accepted deviation from a stated
  requirement**, and it is recorded as such rather than quietly reinterpreted.
- **Commit identity is self-asserted and forgeable.** The hash chain proves integrity, not authorship.
- **Four platform questions remain unverified** (`specs/09-testing.md` §6, V1–V4): whether a JSON script
  block is exempt from a hash-only `script-src` on `file://`; whether `<meta>`-delivered CSP is enforced
  on `file://`; the actual state classes in the pinned Carbon stylesheet; and the pinned Mermaid
  version's `securityLevel` and `htmlLabels` defaults. Each could invalidate part of the design. They
  are listed rather than guessed at.
- **Firefox could not be launched in the development environment.** Chromium and WebKit both run, so
  `REQ-SHELL-005`'s matrix is checked in two engines locally; CI provisions and launches Firefox. The
  claim "a real Firefox shows this" is not made where it was not observed.
- **[`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md)** records every place the implementation
  interprets, departs from, or corrects the specification's prose — and what is not done or not
  verifiable. It is worth reading before assuming something is a bug.

Non-goals for v1, each a decision rather than an omission: real-time collaboration, cryptographic
signing, full diagram authoring (diagrams are *rendered*, not drawn), Graphviz/PlantUML rendering,
threat libraries, multi-model workspaces, and print/PDF reports. See
[`specs/00-overview.md`](specs/00-overview.md) and [`specs/10-open-questions.md`](specs/10-open-questions.md).

---

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first — it covers the two modes of work (writing the implementation vs.
changing the specification) and the rules that bind each.

The short version:

- **Writing the implementation:** follow the spec. Where the spec is silent it is usually silent on
  purpose — check `specs/10-open-questions.md` before inventing an answer.
- **Changing the specification:** a new requirement needs a `- **Test:**` line naming a test, and IDs
  are never renumbered or reused. Changing an architectural decision means writing or superseding an
  ADR, not editing the prose. Do not resolve an open question by editing it out of
  `10-open-questions.md`.
- **Counter-idiomatic constraints are load-bearing.** Most of what a modern JavaScript developer
  reaches for first is forbidden here for a stated reason, and CI will say so.

---

## License

Licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE) for the full text. The
license file carries the standard Apache text without a copyright holder filled in.

Third-party material, and where it lives:

- The **OTM and TML JSON Schemas** are vendored under `vendor/` and inlined into every built artifact so
  that validation needs no network. Their sources and versions are recorded in
  [`vendor/README.md`](vendor/README.md).
- The **Carbon stylesheet** and **Mermaid** are *not* vendored. They are referenced from a pinned,
  SRI-checked CDN under their own licenses — Apache-2.0 for Carbon, MIT for Mermaid — and are the only
  two third-party assets the app loads.
