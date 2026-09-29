# ADR-0014 — Four import formats in v1; Threat Dragon deferred

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-IMP-001..010
- **Related:** `specs/06-interchange.md`, `specs/10-open-questions.md` OQ-10

## Context

Requirement 7 asks the app to be **designed with the ability to import threat models from existing
files**. The phrase "designed with the ability" is doing real work: the requirement is about the
architecture, not a specific format list.

That architecture is already fixed by ADR-0004 — a canonical superset with passthrough bags means an
importer is a *mapper into the canonical model*, and adding one later does not touch the versioning,
storage, or UI layers. The question this ADR settles is therefore narrower: **which mappers ship in
v1**, and what the app does with a file it does not recognize.

The candidates, and what research established about each:

| Format | Status |
|---|---|
| OTM (IriusRisk) | In — the app's export target, and the format most existing models are in |
| OWASP TML | In — the other export target, and the richest threat/control/risk model |
| Native container | In — the app's own format, and what exported HTML carries |
| Exported HTML | In — requirement 5 produces them, so requirement 7 must read them |
| Threat Dragon | **Deferred** — a viable mapping exists, but its own OTM export is currently broken upstream |

## Decision

**v1 imports four formats.** Detection is by content, not by file extension or by user declaration
(`06-interchange.md` §2): the app inspects the JSON and identifies the format, and only asks the user
when it genuinely cannot tell.

- **OTM**, **TML**, **native container**, and **previously exported HTML** — the last requiring only
  that the data block be located by string scanning and parsed (`08-security.md` §3).
- **All four go through the same pipeline**: identify → parse → validate → map → report.
- **Import reports are part of the feature**, not an error path. Every import produces a summary of
  what was mapped, what was folded, and what was dropped — the lossiness ledger
  (`06-interchange.md` §7) made visible to the user.
- **Structural failures do not block automatically.** A file that fails schema validation offers an
  explicit "Import anyway (limited)" path (REQ-IMP-003): the model is readable but marked read-only for
  re-export to that format until the violations are resolved. Rejecting a file the user was asked to
  look at is the wrong default for a viewport.
- **Threat Dragon is deferred**, not designed out. Its mappers would slot into the same pipeline.

## Consequences

**Good**

- The four formats cover the realistic paths into the app: a model from a modeling tool (OTM), a model
  from an OWASP-style library (TML), and a model someone sent you from this app (HTML or container).
- Content-based detection means a mis-named file works, and a user does not have to know what format
  their file is in — which they often do not.
- The report-first design makes lossiness a documented property rather than a surprise discovered after
  re-export.
- Deferring Threat Dragon costs nothing architecturally, and it avoids testing against an upstream
  exporter that does not currently work.

**Costly**

- **Four detection paths, each of which can misfire.** A file that looks like two formats, or that is
  valid JSON but not a threat model, must produce a clear diagnosis rather than a confusing error from
  deep in a mapper.
- The import report is user-facing surface that must be maintained as the mappers change; it is the
  kind of UI that rots.
- "Import anyway (limited)" creates a state — a model that can be read but not exported to its source
  format — that has to be represented clearly and enforced, or the user will export and silently lose
  the violations.
- Threat Dragon users import nothing. Real, and accepted (`10-open-questions.md` OQ-10).

## Alternatives considered

**OTM and TML only.** Would drop the app's own formats, which is self-defeating: requirement 5 produces
exported HTML files, and an app that cannot open its own exports would be a strange thing.

**Add Threat Dragon in v1.** Rejected on upstream state — its OTM export is currently broken, so the
fixtures would have to be hand-written, and the mapping would be validated against a moving and
currently-inoperative target. Deferred rather than refused.

**Add CycloneDX TM-BOM.** Rejected for v1: it is BOM-shaped and tool-chain oriented rather than
human-modeling oriented, and TML 1.0.2 is expected to change for semantic compatibility with it
(`10-open-questions.md` OQ-11). Adding a format whose landscape is moving, before the two primary
formats are settled, is poor ordering.

**Require the user to select the format.** Would remove detection entirely and every misfire with it.
Rejected: users frequently do not know, the container and HTML formats are self-identifying anyway, and
detection can always fall back to asking when it is unsure — which is strictly better than always
asking.

**Reject any file that fails schema validation.** Rejected as hostile to the stated purpose. The app
exists partly so people can look at models they were sent; refusing to display one because a field is
the wrong type inverts the priority. The override states its consequence instead.
