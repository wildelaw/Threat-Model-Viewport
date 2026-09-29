# ADR-0002 — Carbon v11 stylesheets from a pinned CDN

- **Status:** Accepted — **this is a deliberate deviation from REQ-SHELL-001**
- **Date:** 2026-09-28
- **Requirements:** REQ-SHELL-001, REQ-SHELL-007, REQ-UI-012
- **Related:** `specs/02-architecture.md` §3, §5, `specs/10-open-questions.md` OQ-08

## Context

Requirement 1 asks for a single page, fully self-contained HTML file. Requirement 10 asks for IBM
Carbon as the design system.

Carbon v11's compiled stylesheet is **~939 KB minified**. Inlining it puts that cost in *every* file
the app ever produces — the app file, and every threat model anyone exports, because an exported model
carries the app (ADR-0001). A 40-commit threat model with a diagram would be well over a megabyte,
most of it Carbon's CSS, repeated in every version of every model on every user's disk.

Over a CDN the same stylesheet is ~100 KB gzipped and cached across every file that references it.

The app's own assets — its JavaScript, its application CSS, and the model data — remain inline in all
cases. This decision concerns the third-party stylesheet only.

## Decision

Carbon stylesheets are loaded from `cdn.jsdelivr.net` with:

- an **exact pinned version** in the URL — never a range, never `latest`;
- a **`integrity` SRI hash** and `crossorigin`;
- a `<link rel="stylesheet">`, so the origin is granted `style-src` and **never** `script-src`.

Carbon's CSS is the only third-party asset loaded unconditionally. IBM Plex fonts arrive via
Carbon's own `@font-face` rules from IBM's CDN. Mermaid is the one third-party *script* and is loaded
lazily and separately (ADR-0010).

Delivery is isolated behind a **single seam**: one `<link>` in the shell, referenced by no component.
Swapping Carbon's delivery — for an inlined build, a vendored copy, or nothing — touches that seam and
nothing else.

### The deviation, stated plainly

> **An exported threat model requires network access to render correctly.** It is *not* fully
> self-contained as requirement 1 specifies. Opened offline, an exported model runs its own JavaScript
> and shows its data, but renders unstyled.

This is recorded here, and in `specs/00-overview.md` as an accepted deviation, because a requirement
that is not met should be visibly not met rather than quietly reinterpreted.

## Consequences

**Good**

- Exported models stay small and diffable. The size of a threat model file is roughly the size of its
  data and its history, which is what a version control system should cost.
- Carbon is cached once per browser rather than duplicated per file.
- Carbon can be updated by changing one version string, with SRI ensuring the change is the intended
  one.

**Costly**

- **Network required for correct rendering.** The air-gapped reviewer persona cannot be served without
  the alternative in OQ-08.
- Three external origins exist where a self-contained app would have none, and each is a supply-chain
  surface (`08-security.md` §7). Mitigated by pinning, SRI, and the fact that CSS cannot execute.
- An exported file discloses that it was opened — the CDN sees a request. Not model data, but not
  nothing (`08-security.md` §10).
- The app cannot claim "works offline," which is a claim users of a single-file tool reasonably expect.

## Alternatives considered

**Inline Carbon into every file.** Satisfies requirement 1 literally. Rejected on the size arithmetic
above — the cost lands on the artifact users exchange, not on the app.

**A separate build target that inlines Carbon.** The right eventual answer for air-gapped use, listed
as OQ-08 rather than done now, because it should be a distinct build the user chooses rather than a
per-export setting that produces two visually different classes of file.

**Vendor a subset of Carbon, built with Sass.** Would cut the size substantially. Rejected as adding a
Node build dependency, which REQ-SHELL-003 forbids — the build must run from a clean checkout with no
install.

**No design system; hand-written CSS.** Rejected: requirement 10 asks for Carbon, and reimplementing
its accessibility behaviour is a far larger cost than the CDN dependency.
