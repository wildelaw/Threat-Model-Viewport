# ADR-0013 — Full CRUD on every entity type in v1

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-EDIT-001..010
- **Related:** `specs/07-ui.md` §5, §6

## Context

Requirement 8 states the primary use as **viewing** a threat model and being able to **make and commit
changes**. The word "viewing" invites a reading in which v1 is a viewer with a notes field, and the
edit surface is small.

That reading does not survive contact with the actual workflow. The decentralized loop is: someone
sends you a model, you review it, you record what you found, you send it back. A reviewer who can leave
a comment but cannot add the threat they identified has not been given the tool the requirement
describes — they have been given a viewer and told it is an editor.

There is a real cost to the alternative, too. A partial edit surface means a partial data model in the
UI, which means the canonical model (ADR-0004) is only partly reachable, which means the parts that are
unreachable are effectively dead weight in the file.

## Decision

**v1 supports create, read, update, and delete on every entity type in the canonical model**, exposed
through the tab that owns each type.

Scope and limits:

- **Every entity type** listed in `03-data-model.md` §4 — trust zones and boundaries, components,
  actors, data stores, data sets, assets, data flows, threats, threat personas, threat applications,
  controls, risks, mitigation plans, assumptions, diagrams, representations.
- **References are chosen from selectors, never typed as ids** (REQ-EDIT-004). A user must not be able
  to create a dangling reference by hand.
- **Passthrough bag contents are not editable.** They are preserved through edits (REQ-EDIT-006) but
  there is no UI for fields the app does not model. This is deliberate: the bags exist to avoid
  corrupting data, not to become a raw editor.
- **Diagrams are not authored.** Coordinates are editable as properties, but there is no canvas
  editing, no auto-layout, and no drag-to-create. Diagram authoring remains a non-goal.
- Deletion checks referential integrity and offers the standard choices (block, or remove the
  references; `06-interchange.md` §8) rather than silently orphaning entities.

## Consequences

**Good**

- The tool does the job the requirement describes: a reviewer can record a finding, not just note that
  one exists.
- The whole canonical model is reachable through the UI, so nothing in the data model is speculative.
- Import → edit → export is a complete round trip in the app's own terms, which is what makes
  `interop.roundtrip-stable` a meaningful test.

**Costly**

- **This is the largest single workstream in the project.** Fifteen entity types, each with a list
  view, a detail view, a form, validation, and reference selectors — on top of a component layer that
  must be hand-written because Carbon ships no JavaScript (ADR-0002's context).
- Forms for entities with many optional fields are genuinely hard to make usable, and the risk is a
  uniform generated-form look that is technically complete and unpleasant to use.
- Every field added to the canonical model gains an editing obligation. The data model is now coupled
  to the UI surface.
- Partial edits interact with versioning: an edit form that fails validation mid-way must not leave a
  half-built entity in the working copy. The working-copy model (`04-versioning.md` §5) handles this,
  but the form layer must respect it.

## Alternatives considered

**Read-only v1 with a comment/annotation layer.** Much smaller, and it would ship sooner. Rejected: it
does not satisfy requirement 8, and a comments layer that cannot produce a real threat is a feature
nobody would use twice.

**CRUD on threats and risks only** — the entities a reviewer most often adds. A defensible v1, and the
strongest alternative. Rejected because a threat added without the component it applies to is not a
usable threat, so the entity you leave out is the one that makes the one you kept meaningful
(`threatApplications`, ADR-0004).

**CRUD on everything, plus diagram authoring.** Rejected: canvas editing is a different product with a
different interaction model, and it is not requested.

**CRUD on everything, including passthrough bags.** Rejected: raw editing of uninterpreted fields lets
a user create data the app will export without understanding, which is the opposite of what the bags
are for. A raw JSON view is a possible *read-only* addition later.
