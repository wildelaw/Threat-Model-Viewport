# ADR-0007 — Nine hybrid top tabs, each with its own side nav

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-UI-001..006, REQ-UI-010
- **Related:** `specs/07-ui.md`, `specs/10-open-questions.md` OQ-06

## Context

Requirement 10 asks specifically for **tabs across the top for major sections of a threat model** and
**a vertical bar for sub-sections or functions**. That is a hybrid navigation model, and it is worth
being explicit that it was chosen by the user rather than arrived at by default, because it has a
consequence: the vertical bar's content must change as the tab changes.

The alternative — Carbon's more conventional UI Shell pattern — is a persistent side nav of top-level
destinations with no top tabs. It is better supported by Carbon's own markup and ARIA conventions, and
it would not require a per-tab side nav at all.

Two things settled it in favour of the user's design. First, the entity types of a threat model are
numerous and heterogeneous; a flat side nav of fifteen destinations is a worse map than nine sections
with three or four sub-destinations each. Second, the tabs give the app a **stable shape** — a user
returning to a model knows where everything is, which matters more in a reviewing tool than in an
authoring one.

## Decision

**Nine top tabs, each owning its own side nav, with the side nav's contents regenerated on tab
change.**

| # | Tab | Side nav contents |
|---|---|---|
| 1 | Overview | Model summary, metadata, contributors, coverage |
| 2 | Architecture | Trust zones, trust boundaries, components, actors, data stores, diagrams |
| 3 | Data | Data sets, assets, classification |
| 4 | Flows | Data flows, `bidirectional` handling |
| 5 | Threats | Threat list, per-threat detail, `threatApplications` join |
| 6 | Controls | Controls (mitigations), mitigation plans |
| 7 | Risk | Risk matrix, per-threat risk, `riskReduction` |
| 8 | History | Commit log, per-commit diff, compare, merge, working copy |
| 9 | Settings | Identity, formats, storage, About |

The side nav is `cds--side-nav` at 16rem, collapsing to a 3rem rail. Its **contents are rebuilt per
tab** rather than being a fixed list with disabled items — a nav that shows entries which do nothing on
the current tab is a lie about what is available.

This departs from Carbon's documented tabs markup, which assumes one panel per tab and a tablist with
sibling panels. Here there is **one panel** whose contents change. That is handled by using a single
`role="tabpanel"` associated with the selected tab, updating its `aria-labelledby`, and managing focus
explicitly (`07-ui.md` §2) — a documented deviation, not an accident.

## Consequences

**Good**

- Matches the requested design, and gives a stable top-level map of a threat model.
- The side nav is always *about the current tab*, so it can be specific: entity types under
  Architecture, functions under Threats and Risk.
- Nine tabs fit at typical widths and degrade to a horizontal scroll rather than a menu.

**Costly**

- **The single-panel tab pattern is the accessibility risk in this design.** Carbon's CSS assumes the
  conventional structure, so the ARIA wiring is hand-written and must be verified by keyboard testing,
  not by axe alone (`10-open-questions.md` OQ-09).
- The side nav's meaning changes per tab, so there is no consistent mental model for "the thing in the
  sidebar." Documented in REQ-UI-010's behaviour inventory.
- Nine top-level sections is at the upper end for tabs. `10-open-questions.md` OQ-06 flags that the
  grouping was chosen without real models and should be revisited once some have been imported.
- Rebuilding nav contents on tab change means focus and scroll state must be handled deliberately.

## Alternatives considered

**Carbon's UI Shell with a persistent side nav and no top tabs.** Would follow Carbon's markup
convention exactly and remove the ARIA deviation. Rejected: it does not implement requirement 10, and
it forces fifteen-plus destinations into one flat list.

**Tabs only, with sub-sections as an in-page segmented control.** Would remove the vertical bar
requirement. Rejected: the user asked for it, and entity-type navigation in a long list genuinely
benefits from a persistent rail.

**Fewer tabs by merging Risk into Threats, and Data into Architecture.** Would reduce to seven.
Plausible — and exactly the kind of change OQ-06 exists to hold open, once real usage shows whether
Risk deserves its own section.
