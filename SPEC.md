# Threat-Model-Viewport — Specification

A decentralized, single-file threat-model viewport. This directory is the **source of truth for
development**: code is written to satisfy these documents, and tests cite requirement IDs.

**Spec version:** 0.1.0 (draft) · **Status:** ready for iteration · **Last updated:** 2026-09-28

---

## How to read this spec

| Order | Document | What it settles |
|---|---|---|
| 1 | [specs/00-overview.md](specs/00-overview.md) | Goals, non-goals, personas, accepted deviations |
| 2 | [specs/01-requirements.md](specs/01-requirements.md) | Every numbered requirement + acceptance criteria |
| 3 | [specs/02-architecture.md](specs/02-architecture.md) | Single-file shape, build, self-export, Carbon seam |
| 4 | [specs/03-data-model.md](specs/03-data-model.md) | Canonical model, passthrough bags, id strategy |
| 5 | [specs/04-versioning.md](specs/04-versioning.md) | Commit DAG, hash chain, deltas, merge algorithm |
| 6 | [specs/05-storage.md](specs/05-storage.md) | Persistence, origins, registry, quota |
| 7 | [specs/06-interchange.md](specs/06-interchange.md) | OTM + TML import/export, mapping, lossiness |
| 8 | [specs/07-ui.md](specs/07-ui.md) | Carbon shell, tabs, side-nav, screens |
| 9 | [specs/08-security.md](specs/08-security.md) | Threat model of the app itself |
| 10 | [specs/09-testing.md](specs/09-testing.md) | Test harness + traceability matrix |
| — | [specs/10-open-questions.md](specs/10-open-questions.md) | Deferred decisions |
| — | [decisions/](decisions/) | ADRs — one per locked architectural decision |

Nothing in this spec is final. `specs/10-open-questions.md` carries what is deliberately unresolved.

---

## Decisions at a glance

Fourteen ADRs are recorded in [`decisions/`](decisions/). Each states its context, the decision, what
it costs, and what was rejected. Read them by concern:

| Concern | ADR |
|---|---|
| Where the model actually lives | [0001](decisions/0001-file-first-storage.md) |
| Why the app needs a network connection | [0002](decisions/0002-carbon-via-cdn.md) — **the only deviation from a stated requirement** |
| What happens when two histories disagree | [0003](decisions/0003-divergence-always-prompts.md) |
| How OTM and TML coexist in one model | [0004](decisions/0004-neutral-superset-canonical-model.md) |
| How history stays small | [0005](decisions/0005-delta-history-with-keyframes.md) |
| Why there is a build step | [0006](decisions/0006-classic-inline-script.md), [0009](decisions/0009-modular-source-with-build-step.md) |
| Navigation | [0007](decisions/0007-hybrid-tabs-and-per-tab-side-nav.md) |
| Who a commit is attributed to | [0008](decisions/0008-self-asserted-identity.md) |
| Diagrams | [0010](decisions/0010-diagram-rendering-strategy.md) |
| Hashing | [0011](decisions/0011-pure-js-sha256.md) |
| Validating imported files | [0012](decisions/0012-targeted-schema-validators.md) |
| Edit scope and import formats in v1 | [0013](decisions/0013-full-crud-in-v1.md), [0014](decisions/0014-v1-import-formats.md) |

---

## Requirement ID scheme

`REQ-<DOMAIN>-<NNN>`

| Domain | Scope | Traces to user requirement |
|---|---|---|
| `SHELL` | Single-file artifact, loading, browser support | U1, U5 |
| `DATA` | Embedded JSON container, canonical model | U2 |
| `VCS` | Commits, DAG, deltas, merge, history | U3, U8 |
| `SYNC` | Open-time reconcile between file and storage | U3, U6 |
| `STORE` | Persistence, registry, model switching, delete | U3, U9 |
| `EXP` | Interchange export and app re-export | U4, U5 |
| `IMP` | Import from existing files | U7 |
| `VIEW` | Read-only presentation of a model | U8 |
| `EDIT` | Create, update, delete, commit | U8 |
| `UI` | Carbon shell, navigation, accessibility | U10 |
| `SEC` | Untrusted input, CSP, escaping | cross-cutting |

IDs are **stable**. A requirement that is removed keeps its number retired, never reused — tests and
code comments cite these IDs.

Acceptance criteria are abbreviated `AC`. Test names are cited where they are known.

---

## Traceability to the original request

| # | Original request | Requirements |
|---|---|---|
| U1 | Single page, fully self-contained HTML | `REQ-SHELL-001..007` — **partially deviated**, see ADR-0002 |
| U2 | All data inline as JSON | `REQ-DATA-001..006` |
| U3 | Git-style versioning; newer changes merge into local storage | `REQ-VCS-001..015`, `REQ-SYNC-001..008`, `REQ-STORE-001..008` |
| U4 | Export as OWASP TML or OTM JSON | `REQ-EXP-001..006` |
| U5 | Export the full HTML app with current JSON embedded | `REQ-EXP-007..013` |
| U6 | If local storage holds a newer model, use it | `REQ-SYNC-003`, `REQ-VCS-008` |
| U7 | Ability to import threat models from existing files | `REQ-IMP-001..010` |
| U8 | Primary use: view a model and make/commit changes decentrally | `REQ-VIEW-001..009`, `REQ-EDIT-001..010`, `REQ-VCS-004` |
| U9 | Switch between stored/embedded models; delete stored models | `REQ-STORE-003..005`, `REQ-UI-004` |
| U10 | IBM Carbon UI, top tabs + vertical sub-nav bar | `REQ-UI-001..012` |

---

## Glossary

| Term | Meaning |
|---|---|
| **Canonical model** | The app's internal, format-neutral representation of a threat model. Both interchange formats convert to and from it. |
| **Commit** | An immutable node in the history DAG: a model snapshot, an author, a message, and parent links. Identified by a content hash. |
| **Container** | The JSON document embedded in the HTML. Holds the canonical model plus history and build metadata. |
| **Embedded data** | The container inside the HTML file currently open. |
| **Local store** | `localStorage` on the current origin. Treated as a **cache/overlay**, never as the sole source of truth. |
| **Fast-forward** | A reconcile where one history is a strict ancestor of the other; the descendant wins with no merge. |
| **Divergence** | Two histories where neither is an ancestor of the other. Requires an explicit user decision. |
| **Keyframe** | A full model snapshot stored in history, used as a base for reconstructing deltas. |
| **Passthrough bag** | A namespaced object (`x-otm`, `x-tml`) preserving source-format fields the canonical model does not cover. |
| **Pristine DOM** | A clone of `document.documentElement` captured at boot, before any rendering, used for self-export. |
| **OTM** | Open Threat Model, IriusRisk. Schema v0.2.0, JSON Schema draft-07. |
| **TML** | OWASP Threat Model Library Schema. v1.0.2, JSON Schema 2020-12. |
| **`cds--`** | Carbon v11 CSS class prefix (was `bx--` in v10). |

---

## Non-negotiables

Three constraints drive most of the design. Every future change must respect them:

1. **The file is the primary carrier.** Correctness must never depend on browser storage being shared
   across files, because it is not, on Firefox. See ADR-0001.
2. **Carbon v11 ships no JavaScript.** All component behavior is hand-written vanilla JS toggling
   `cds--*` classes. See ADR-0002 and `specs/07-ui.md`.
3. **Every input is untrusted.** An exported threat model is executable HTML. See `specs/08-security.md`.
