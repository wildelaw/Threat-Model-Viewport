# 00 — Overview

## The problem

Threat models are authored in tools that assume a server: a hosted platform, a database, an account.
That makes them awkward to circulate. A threat model is usually a **document you send to someone** —
attached to a ticket, committed beside the code it describes, handed to an assessor. When it lives in
someone's platform tenant, it stops being a document and becomes a link that expires with their
licence.

Meanwhile the interchange formats that exist — IriusRisk's **Open Threat Model (OTM)** and the
**OWASP Threat Model Library Schema (TML)** — are *transport* formats. They carry the model, and
nothing about who changed what, when, or why. Neither has a revision field, a timestamp, or any
notion of history. That is by design: they describe a threat model, not its authorship.

This leaves a gap. Two people can each be sent the same model, each annotate it, and there is no
mechanism to bring those two sets of changes back together — short of a human opening both files and
reconciling them by eye. The format that makes the model portable is exactly the format that makes
the edits unmergeable.

## The approach

**Threat-Model-Viewport** closes that gap by putting a version control system *inside the document*.

A threat model becomes a single HTML file that carries three things:

1. The model itself, as JSON, in the canonical internal representation.
2. A **history** — a git-style DAG of commits, content-addressed and chained, so edits accumulate
   in the file rather than in someone's account.
3. The **application** that reads it, so the file is self-sufficient: open it and you have a viewer,
   an editor, and a version control client.

Because the history travels *with* the model, two people editing copies of the same file can be
reconciled by the app itself, on the user's own machine, with no server, no account, and no network
calls.

### What makes this different from a hosted tool

| | Hosted threat-model platform | Threat-Model-Viewport |
|---|---|---|
| Where the data lives | Vendor's database | Inside the file you hold |
| How you share | A URL and an account | A file, over any channel |
| Who can read it | Anyone the vendor grants | Anyone you hand the file to |
| History | Server-side, opaque | In the file, inspectable JSON |
| Works offline | Usually not | Yes, once loaded (see ADR-0002) |
| Import into a commercial tool | Native | Via OTM export |

The intended outcome: a threat model that behaves like a **shared document with real revision
history**, and that can still be exchanged with the wider ecosystem through OTM and TML.

## Goals

- **G1** — View a threat model in a purpose-built interface: architecture, data flows, threats,
  controls, risk. TML models in particular are poorly served by existing viewers.
- **G2** — Edit every entity type, and commit changes with an author and a message.
- **G3** — Reconcile edits made independently to copies of the same model, without a server.
- **G4** — Exchange the model with the ecosystem: import and export OTM and TML.
- **G5** — Distribute the whole application as one file, so the model and its viewer are never
  separated.
- **G6** — Never lose work. No silent data loss, no silent history pruning, no destructive
  reconcile.

## Non-goals (v1)

Explicitly out of scope. Each is a decision, not an omission.

- **Real-time collaboration.** No presence, no live cursors, no server. Reconciliation is
  asynchronous and file-based, by design.
- **Cryptographic signing and verified authorship.** Commit identity is **self-asserted**. The hash
  chain detects corruption and naive tampering, not forgery. Deferred — see `10-open-questions.md`.
- **Threat Dragon import.** The mapping is viable, but Threat Dragon's own export path is currently
  broken upstream, which makes it a poor integration target today. Deferred.
- **Full diagram authoring.** v1 *renders* diagrams. It does not provide a canvas to draw or
  rearrange one. Coordinates present in an imported OTM file are preserved and re-exported, but not
  editable on a canvas.
- **Graphviz and PlantUML rendering.** TML allows these as diagram source types. v1 renders Mermaid
  (lazily, from CDN) and inline SVG, and displays Graphviz/PlantUML as source text. See ADR-0010.
- **Threat library / catalogue management.** Neither interchange format defines a reusable
  threat-template catalogue. TML's "library" is a collection of complete models, not templates. v1
  does not invent one.
- **Multi-model workspaces.** One model per file. The registry lets you switch, but there is no
  cross-model reporting.
- **Print / PDF report generation.** Not requested; a plausible v2. See `10-open-questions.md`.
- **Custom Carbon themes.** Carbon ships four prebuilt themes and custom themes require Sass. v1
  offers the four built-ins only.

## Personas

| Persona | Context | What they need |
|---|---|---|
| **Reviewer** | Sent a model, asked for an opinion | Open the file, read it, add threats and comments, commit, send it back |
| **Model owner** | Maintains the model across releases | Import from the authoring tool, edit, keep history, export back to OTM for the platform |
| **Assessor** | Auditing someone else's model | Read-only browsing, filtering, tracing a threat to its control and its risk |
| **Contributor** | Editing offline, on a plane or an air-gapped network | Everything except CDN assets must already be cached; export must work locally |

The **Reviewer** is the persona that shapes the most decisions: they receive a file from an
untrusted-ish source, on an unknown browser, and the first thing they do is open it by double-clicking.

## Usage contexts

These are the situations the design must survive. They are not hypothetical — they drive ADR-0001.

| Context | Load path | Storage behaviour |
|---|---|---|
| Double-click a downloaded file | `file://` | Chrome/Edge: **shared** bucket across all local files. Firefox 92+: **per-file** origin |
| Hosted on a wiki or intranet | `https://…` | Normal single origin, isolated from all `file://` data |
| Served locally for development | `http://localhost` | **Separate store** from the same file opened via `file://` |
| Air-gapped | `file://` | As above, with no network for CDN assets (see ADR-0002) |

## Key constraints

Summarised here; the full research-derived list with sources is in the topical specs.

### The file is the carrier, not the browser
`file://` origin behaviour is browser-dependent and was never standardised. Chrome and Edge treat all
local files as one origin — convenient, but any HTML file you ever saved to disk can read every
stored threat model. Firefox 92+ treats each file path as its own origin — safer, but storage does
not follow a file that is moved, renamed, or copied. Safari is inconsistent.

Consequence: **localStorage can never be the source of truth.** It is a cache that makes the common
case fast. The authoritative reconcile is explicit and file-based. See ADR-0001.

### Carbon provides styling, not behaviour
Carbon v11 publishes a complete prebuilt stylesheet but **no JavaScript bundle** at all — no UMD
build, and the Web Components are code-split ES modules. Every interactive behaviour must be written
by hand against Carbon's `cds--` state classes. This is the single largest implementation surface in
the project and is inventoried in `specs/07-ui.md`.

### The two interchange formats are not reconcilable by field mapping alone
OTM and TML disagree structurally, not just in naming. OTM stores diagram geometry as coordinates;
TML stores diagram *source text*. OTM has no actor or data-store concept; TML has no asset CIA
scores or trust-zone ratings. Neither enforces referential integrity. A converter that maps field to
field will silently drop data, so the canonical model carries **passthrough bags**. See
`specs/06-interchange.md`.

## Accepted deviations

Recorded here so they are visible rather than discovered later.

### D1 — The application is not fully offline (ADR-0002)

The original requirement was "fully self-contained." Carbon is loaded from a CDN instead of being
inlined, because inlining Carbon's stylesheet adds ~939 KB to **every exported threat model file**,
and re-exporting is a routine action.

**Consequence:** an exported file needs network access to render correctly. Offline, it degrades to
unstyled-but-functional HTML. All app JavaScript, app CSS, and model data remain inline; Carbon is
the only external reference, and it is pinned and subresource-integrity-checked. The dependency is
isolated behind a single seam so an inlined build target can be added later without touching
component code.

### D2 — "Use the newer version" is a fast-forward rule, not a general one

The original requirement said to prefer the newer model in local storage. That holds only when one
history is strictly ahead of the other. When histories have genuinely diverged, adopting either side
would discard real work, so the app **stops and asks**. See ADR-0003.

### D3 — Requirement 9 does not provide shared storage on Firefox

Switching between stored models requires a shared registry, which `file://` does not provide uniformly
on Firefox. The registry is therefore seeded from the file's embedded data on every load, and the
model switcher lists what the *current origin* knows about. This is a limitation of the platform, not
a design choice, and the UI states it plainly when it applies.

## Related documents

- Architecture and the single-file shape → `specs/02-architecture.md`
- The data the app actually stores → `specs/03-data-model.md`
- Why history is stored as deltas → ADR-0005, `specs/04-versioning.md`
- Decisions and their rejected alternatives → `decisions/`
