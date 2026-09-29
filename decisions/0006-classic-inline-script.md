# ADR-0006 — One classic inline script; modules at authoring time only

- **Status:** Accepted
- **Date:** 2026-09-28
- **Requirements:** REQ-SHELL-002, REQ-SHELL-003, REQ-SEC-001
- **Related:** `specs/02-architecture.md` §2, §3, `decisions/0009-modular-source-with-build-step.md`

## Context

A single-file app that opens from disk has to load its own code, and the obvious modern mechanism does
not work for that.

`<script type="module" src="./app.js">` on a `file://` page is subject to CORS, and a `file://` origin
is opaque — the request fails in all four major browsers. Module scripts also cannot be inlined and
still use relative imports. This is not a policy that can be configured around at runtime; it is how
the browser treats the scheme.

Two related constraints point the same way:

- The CSP that pins the app's script by hash (REQ-SEC-001) requires the script to be **inline and
  static**, because the hash must be known at build time. An external script would be pinned by origin
  instead, and there is no trustworthy origin for a local file.
- Requirement 5 exports the app into a new file, which must be openable by exactly the same mechanism
  as the original.

## Decision

**The shipped artifact contains exactly one inline classic script**, with no `src`, no `type="module"`,
and no dynamic insertion. It is the only script in the file except the non-executable JSON data block
and the lazily-added Mermaid script (ADR-0010).

- Source is authored as ordinary script fragments that attach to a `globalThis.TMV` namespace
  (`02-architecture.md` §3), concatenated by the build (ADR-0009).
- No `import`, no `export`, no bundler, no `type="module"` anywhere in the shipped file.
- Because the script is static, its SHA-256 is **constant across every export**: exporting a model
  changes only the data block, never the script. This is what makes self-export byte-stable for the
  app portion (REQ-EXP-004).
- Consequently: no `eval`, no `new Function`, no string-argument timers, no inline `on*` handlers — the
  CSP forbids them, so the UI code is written accordingly (REQ-SEC-002, REQ-UI-008).

## Consequences

**Good**

- The file opens by double-click on every browser and both protocols. This is the entire premise of
  the tool.
- One constant script hash to pin, computed once at build, identical in every generated file.
- Self-export is a text splice of the data block into a pristine clone, with no code generation and no
  possibility of emitting a subtly different script.
- No loader, no module registry, no resolution algorithm — the script is simply present.

**Costly**

- **Load order is explicit and total.** The build concatenates files in a declared order, so a module
  cannot depend on one that appears later. There is no cycle detection and no lazy loading; every
  fragment runs at boot. Enforced by convention plus the test harness, which builds from the same
  `BUILD_ORDER`.
- Namespace-attached fragments are less tool-friendly than modules: no static analysis for unused
  exports, no tree shaking, and `TMV.foo` typo-safety depends on tests rather than on the compiler.
- Everything is in one scope at runtime. Collisions are possible and are avoided by convention.
- Testability depends on the `node:vm` harness (`09-testing.md` §2) rather than on importing the
  source directly, which is an extra layer that must keep working.

## Alternatives considered

**ES modules with an import map and a relative `src`.** Blocked on `file://` by CORS, as above.

**Inline the modules as one `<script type="module">` without imports.** Would allow module *syntax* in
one file with no resolution step. Rejected: an inline module still runs in strict mode and defers
execution, but more importantly it buys nothing over a classic script while adding a second execution
model to reason about — and self-export would then need to re-emit module syntax correctly.

**A bundler (esbuild, rollup).** Would give real modules at authoring time and one file at build time.
Rejected because it introduces an install step, and REQ-SHELL-003 requires the build to run from a
clean checkout with no dependencies. The build being dependency-free is itself testable, and that test
is more valuable than the ergonomics a bundler would add.

**A data-URI module or blob URL constructed at runtime.** Blocked by CSP (`script-src` is a hash), and
dependent on `file://` behaviours that differ per browser.
