# ADR-0004 — Neutral superset model with per-format passthrough bags

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-DATA-001..006, REQ-IMP-004, REQ-EXP-003
- **Related:** `specs/03-data-model.md`, `specs/06-interchange.md`

## Context

The app must import and export two formats that overlap but are not interchangeable.

**OTM (Open Threat Model, IriusRisk) 0.2.0** — camelCase, unconstrained string ids,
`additionalProperties` never restricted, free-form `attributes` on nearly every object. It has trust
zones and boundaries, components, assets, data stores, data flows, threat personas, and mitigations.
It has no first-class notion of an assumption or a diagram of TML's kind.

**OWASP TML 1.0.2** — snake_case, `^[0-9a-z-]+$` symbolic-name ids, a rich threat/control/risk story
with CAPEC/CWE references and a 5×5 risk matrix, actors, assumptions, and source-text diagrams. It has
no trust zone *ratings*, no asset CIA scores, no diagram coordinates.

Four options were available for the internal representation:

1. **OTM as the internal model.** Cheap for OTM round trips; TML concepts have nowhere to live.
2. **TML as the internal model.** The mirror image.
3. **A neutral superset** of both, plus a way to carry what the superset does not model.
4. **A neutral subset** — only the overlap — with everything else discarded on import.

## Decision

**Option 3.** A neutral canonical model (`specs/03-data-model.md`) that is a *superset* of the concepts
either format expresses, plus **passthrough bags**:

- Every entity and the model root may carry `x-otm` and `x-tml` objects.
- A bag holds fields the canonical model does not interpret, preserved verbatim.
- Bags are **opaque**: the app never reads them for behaviour, never validates their contents, and
  never merges them semantically. They are carried.
- On export, a bag's contents are written back under their own key if the target format permits it —
  OTM's `attributes` and TML's `extensions`.

One canonical entity exists purely to bridge the formats rather than to be imported from either: a flat
**`threatApplications`** join, because OTM attaches threat state to a component and TML attaches risk
to a threat, and no single nested shape represents both.

## Consequences

**Good**

- **Import is lossless in the sense that matters.** A model imported from OTM and immediately
  re-exported to OTM is unchanged, including fields this app has never heard of — which is what makes
  it safe to use on someone else's model.
- Neither format is privileged in the code. Adding a third (OQ-11) is additive.
- The lossiness ledger (`06-interchange.md` §7) becomes writable: it enumerates where a *canonical*
  concept has no home in a target format, which is a finite, auditable list.

**Costly**

- **The canonical model is larger than either format**, and larger than what v1's UI displays. Some
  entities are reachable only through the raw view for now.
- Passthrough bags accumulate format-specific debris across conversions. A model that has been through
  both formats carries both bags on every entity.
- Two sources of truth for a field are possible: a value in `x-otm` that duplicates a canonical field
  that has since been edited. The rule is that canonical fields win and stale bag entries are dropped
  on export — but this must be implemented consistently, and it is the kind of rule that rots.
- Bags must be included in the model hash (ADR-0008) or an edit to one would be invisible to
  versioning. That means an unreadable field changes commit ids, which is correct but surprising.

## Alternatives considered

**Option 4, a neutral subset.** Superficially attractive — a smaller app, less to build. Rejected
decisively: dropping unmapped fields on import means the app **corrupts models it touches**. A user
imports their OTM model to look at it, exports it, and has silently lost their trust zone ratings. For
a tool whose stated purpose is viewing other people's models, that is disqualifying.

**Option 1 or 2, adopting one format internally.** Rejected for the same reason in one direction, plus
it makes the other format a permanent second-class citizen in every code path.

**Store the original document alongside the canonical model and re-emit it on export.** Preserves
bytes perfectly but fails as soon as the user edits anything, at which point the stored original is
stale and the app must fall back to the canonical mapping anyway. Two code paths, one of them dead.
Passthrough bags achieve the same preservation while staying consistent with edits.
