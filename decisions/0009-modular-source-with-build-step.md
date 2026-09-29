# ADR-0009 — Modular `src/` with a dependency-free build script

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-SHELL-003, REQ-SHELL-004
- **Related:** `specs/02-architecture.md` §8, `decisions/0006-classic-inline-script.md`, `specs/09-testing.md` §2

## Context

The shipped artifact is one file with one inline classic script (ADR-0006). That does not mean the
*source* should be one file. A single-file source of roughly the size this app will reach — a Carbon
component layer, a versioning engine, two interchange mappers, and nine tab views — is not maintainable
and cannot be reviewed.

The tension is between how the code is written and how it is delivered, and it is resolved the usual
way: a build step. The unusual part is the constraint on that step.

REQ-SHELL-003 requires the build to run **from a clean checkout with no install**. That is a real
requirement, not a stylistic one: the app's central claim is that you can trust a file you built
yourself. A build with an npm dependency graph cannot be audited by reading it, and a compromised
transitive dependency would be inside every threat model the tool produces. A build you cannot audit
is a build you cannot trust.

## Decision

**Source lives in `src/`, organized by concern; `build.mjs` concatenates it into one artifact using
nothing but the Node standard library.**

```
src/index.html        # shell, mount points, the data block
src/styles/*.css      # application CSS layered over Carbon
src/app/01-core.js    # hashing, canonical serialization, escaping
   ...  through 99-boot.js
src/vendor/           # pinned OTM and TML JSON Schemas, inlined at build
build.mjs             # no dependencies; concat + vendor inline + CSP hash → dist/
test/                 # node --test + Playwright
```

Rules the build enforces:

- **`BUILD_ORDER` is a single exported list**, and it is the only place order is defined. The test
  harness reads the same list, so tests and artifact cannot drift.
- **Source fragments attach to `globalThis.TMV`** — no `import`, no `export` — because the output is a
  classic script (ADR-0006).
- **The build computes the script's SHA-256** and writes it into the CSP meta tag, so the hash and the
  code it pins cannot disagree.
- **The build has zero dependencies**, and a CI stage runs it first, from a clean checkout, with no
  install step. Adding a dependency anywhere in `build.mjs` fails that stage.

Dev dependencies for *testing* (Playwright, axe-core, Ajv) are permitted and never ship
(`09-testing.md` §2).

## Consequences

**Good**

- The build is auditable in a few minutes by reading one file. Anyone can verify that the artifact
  contains what the source says and nothing else — which is a meaningful claim for a tool that ships
  as an executable document.
- No supply chain in the artifact and no supply chain in the build. The only third-party code is
  Carbon's CSS and Mermaid, both pinned and SRI-checked (ADR-0002, ADR-0010).
- `BUILD_ORDER` being shared with the test harness means a module that tests cannot load is a build
  error rather than a late discovery.
- Concatenation is trivially debuggable: the artifact is the source in order, with no transformation.

**Costly**

- **Load order is manual and total.** Adding a module means adding it to `BUILD_ORDER` in the right
  place; the failure mode is an undefined reference at runtime.
- No tree shaking, no dead-code elimination, no minification unless written. The artifact is larger
  than a bundled build — accepted, because the inline script is a small fraction of the file next to
  Carbon (ADR-0002) and the model data.
- No static analysis of the namespace: `TMV.foo` typos are caught by tests, not by a compiler. This is
  why the harness builds from `BUILD_ORDER` and why unit coverage is unusually high on pure logic.
- Contributors cannot use their usual tooling on the source — no TypeScript, no JSX, no import
  statements. A deliberate restriction with a real ergonomic cost.

## Alternatives considered

**Commit the built artifact and edit it directly.** Would remove the build step entirely. Rejected: a
~10,000-line single file is unreviewable, and the CSP hash would have to be updated by hand on every
change, which is exactly the kind of manual step that silently breaks.

**Use esbuild or rollup.** Fast, familiar, handles modules properly. Rejected on REQ-SHELL-003: it
introduces `node_modules` into the build, and the auditability argument above is the point.

**Write the app as ES modules and ship them as separate files alongside the HTML.** Would remove the
build. Rejected: requirement 1 asks for a single file, and relative `src` on `file://` fails
(ADR-0006).

**Keep the build but make it a shell script.** Considered; rejected because `build.mjs` already needs
to compute a SHA-256 and inline vendored JSON, both of which are one-liners in Node and awkward and
platform-dependent in POSIX shell.
