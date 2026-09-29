# 02 — Architecture

How the single-file application is shaped, built, booted, and re-exported.

Related: ADR-0002 (Carbon via CDN), ADR-0006 (classic script), ADR-0009 (modular source, build step),
ADR-0011 (hashing implementation).

---

## 1. The artifact

One HTML file. Its structure, in order — the order is load-bearing:

```html
<!DOCTYPE html>
<html lang="en" class="cds--white">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <!-- Must precede every script it governs. See §5. -->
  <meta http-equiv="Content-Security-Policy" content="…">

  <title>…</title>
  <meta name="tmv-app-version" content="0.1.0">
  <meta name="tmv-app-hash" content="sha256-…">   <!-- for REQ-SEC-005 -->

  <link rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/@carbon/styles@1.116.0/css/styles.min.css"
        integrity="sha384-…" crossorigin="anonymous">

  <style>/* app CSS, inlined */</style>
</head>
<body>
  <!-- Carbon UI shell markup, static -->
  <header class="cds--header">…</header>
  <div class="cds--tabs">…</div>
  <nav class="cds--side-nav">…</nav>
  <main class="cds--content" id="tmv-content"></main>

  <!-- Container: model + history. NOT executed. See §4. -->
  <script type="application/json" id="tmv-data">…escaped JSON…</script>

  <!-- Application. Classic, inline, hash-pinned. See §5. -->
  <script>/* app JS, inlined, concatenated */</script>
</body>
</html>
```

**Invariants**

| # | Invariant | Requirement |
|---|---|---|
| I1 | Carbon is the only external reference; everything else is inline | REQ-SHELL-001 |
| I2 | The application script is classic, never `type="module"` with a local `src` | REQ-SHELL-002 |
| I3 | The CSP meta precedes the first `<script>` | REQ-SEC-001 |
| I4 | The data block is inert — a data block, not executable script | REQ-DATA-001 |
| I5 | Shell markup is static; all dynamic content renders into `#tmv-content` | REQ-EXP-008 |
| I6 | No inline `on*=` handlers, no `eval`, no `new Function` | REQ-UI-008, REQ-SEC-002 |

I5 matters more than it looks. Because only `#tmv-content`, the side nav, and the tab strip are ever
mutated, the pristine-DOM capture in §6 is cheap and the exported markup is predictable.

### Why not `type="module"`

Browsers block `<script type="module" src="…">` on `file://` because the page's origin is `null` and
module loading is subject to CORS. An inline module importing from a CORS-enabled CDN does work, but
that makes the application code a network fetch — unacceptable. The application is therefore authored
as modules and **built into one classic script**. See §3.

---

## 2. Carbon delivery seam

ADR-0002 accepts a CDN `<link>` to keep exported files small. The consequence — no offline styling —
is bounded by isolating the dependency:

- The stylesheet URL and its integrity hash live in **one place**: `src/index.html`.
- Application CSS **never** depends on Carbon variables that only exist after the stylesheet loads;
  it uses Carbon's `--cds-*` custom properties where they help, with literal fallbacks, so the app is
  legible unstyled.
- Application JavaScript **never** reads Carbon classes to make decisions. It writes `cds--*` state
  classes but does not parse them back.

This means switching to an inlined build later is a change to `build.mjs` plus one line of
`src/index.html` — no component code changes. The spec reserves a future build target
`dist/threat-model-viewport-offline.html` for that case; it is not implemented in v1.

### Pinning

- Exact version in the URL — never a range, never `latest` (REQ-UI-012).
- `integrity` + `crossorigin="anonymous"` so a tampered stylesheet is rejected.
- The version is recorded in the artifact and surfaced in the About panel.

### Fonts

Carbon's prebuilt CSS declares `@font-face` rules pointing at IBM's CDN and lists IBM Plex first in
every `font-family`. Fonts are **not** embedded: the full Plex family is ~178 MB and per-face woff2 is
~20 KB per face per subset, which is not worth carrying in every exported file.

Offline or blocked, text falls back to the system stack Carbon already specifies. No override is
needed — the stylesheet's own fallback chain handles it. Deliberately, the app does **not** inject a
`font-family` override, because that would be a second place to maintain.

---

## 3. Build

`build.mjs` — dependency-free Node, ESM.

**Inputs**

```
src/index.html            # shell with {{PLACEHOLDER}} markers
src/styles/*.css          # concatenated in filename order
src/app/*.js              # concatenated in filename order
vendor/otm_schema.json    # pinned copies, inlined
vendor/tml_schema.json
vendor/mermaid.version    # pinned version string
```

**Source authoring convention.** Each `src/app/*.js` is a plain script fragment — **no** `import`, no
`export`, no top-level `await`. Each attaches its exports to a shared namespace:

```js
(function (TMV) {
  'use strict';
  TMV.canonical = { serialize, normalize };
})(globalThis.TMV = globalThis.TMV || {});
```

This is deliberate. It means the same source files load unmodified in a browser (via concatenation)
and in Node (via the test harness, which concatenates in the same order). No bundler, no transform
step, no third-party dependency — and REQ-SHELL-003's zero-install build stays true.

The cost is honest: there is no module isolation, so discipline is required to keep files from
reaching into each other's internals. The dependency order is declared once, in `BUILD_ORDER` in
`build.mjs`, and the test harness imports that same list so the two can never drift.

**Steps**

1. Read and concatenate CSS → `styles`.
2. Read and concatenate JS in `BUILD_ORDER` → `script`.
3. **Minify nothing.** If minification is ever added it must run *before* step 4, because the CSP hash
   is computed over the final bytes.
4. Compute `appHash = "sha256-" + base64(sha256(script))`.
5. Compute `styleHash` similarly if app CSS needs hashing (it does — see §5).
6. Substitute placeholders in `src/index.html`: `{{APP_JS}}`, `{{APP_CSS}}`, `{{CSP}}`,
   `{{APP_HASH}}`, `{{SCHEMAS}}`, `{{MERMAID_VERSION}}`, `{{BUILD_TIME}}`.
7. **Fail loudly** on any unresolved `{{…}}` marker (REQ-SHELL-003).
8. Write `dist/threat-model-viewport.html`.

**Schemas.** OTM and TML schemas are vendored at build time and inlined, so import validation works
offline with no fetch (REQ-IMP-003). Each is recorded with its source URL and retrieval commit in
`vendor/README.md` so a future update is reproducible.

**Schema drift.** Both schemas are young — OTM 0.2.0 and TML 1.0.2 — and the OTM 0.2.0 *release tag*
has an invalid `required` placement that makes per-item constraints unenforced. We therefore vendor
the schema from the repository's `main` branch, not the release tag, and note the discrepancy in
`vendor/README.md`.

---

## 4. The container block

```html
<script type="application/json" id="tmv-data">…</script>
```

A data block, not executable script. Contents are the container JSON defined in
`03-data-model.md`, escaped per REQ-DATA-002:

| Sequence | Escaped as | Why |
|---|---|---|
| `</script` | `<\/script` | Would terminate the block |
| `<!--` | `<\!--` | Legacy comment parsing can swallow script content |
| U+2028, U+2029 | ` `, ` ` | Valid in JSON strings, illegal in older JS source |

Escaping happens on `</`, `<!--`, and the separators — not blanket HTML-escaping — so the JSON stays
valid and human-readable.

> **Verification required (blocking):** confirm empirically that a non-executable
> `<script type="application/json">` is exempt from `script-src` under a hash-only CSP, on
> `file://`, in all four supported browsers. The CSP specification says non-JavaScript script types
> are not executed and are not subject to `script-src`, but this has historically varied.
>
> **Fallback if it is blocked:** the build emits a placeholder hash slot in the CSP and the export
> path computes the data block's own SHA-256 at export time, injecting it alongside the app script
> hash. The export is already verifying its output (REQ-EXP-010), so this is a small addition. Record
> the outcome whichever way it goes — it changes the CSP string in the artifact.

---

## 5. Content-security policy

Delivered by `<meta http-equiv>` because exported files have no server to set a header. Only
`<meta>`-supported directives are used — `frame-ancestors`, `report-uri`, and `sandbox` are
header-only and are not relied upon.

```
default-src 'none';
script-src 'sha256-<appScriptHash>' <mermaidOrigin>;
style-src 'sha256-<appStyleHash>' https://cdn.jsdelivr.net;
font-src https://1.www.s81c.com;
img-src data: blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
```

Notes on each choice:

- `default-src 'none'` — everything is denied unless named. The app makes no `fetch`/XHR calls, so
  `connect-src 'none'` is exact rather than aspirational (REQ-SHELL-007, REQ-SEC-008).
- `script-src` — a hash, never `'unsafe-inline'`. This is what makes tampering with an exported
  file's application code detectable by the browser rather than merely discouraged (REQ-SEC-001).
- `style-src` includes a hash for the inline app CSS. Carbon's CDN origin is named because its
  stylesheet is external; it is *not* granted `'unsafe-inline'`.
- `img-src data: blob:` — the export path uses Blob URLs for downloads, and diagrams may use `data:`.
- `form-action 'none'`, `base-uri 'none'` — the app has no forms that submit anywhere, and `base-uri`
  denies a `<base>` tag injected into an untrusted file from redirecting relative URLs.

**Why the hash is stable.** The application script is static; only the data block changes between
exports. `build.mjs` computes the hash once over the final script bytes, and the export path copies
that script verbatim (REQ-EXP-009), so the hash baked into the artifact remains valid in every
exported file. The hash is therefore a property of the *build*, not of the export.

**Consequences for all UI code** — REQ-UI-008, REQ-SEC-002:

- No `on*=` attributes. Handlers are attached with `addEventListener`.
- No `eval`, `new Function`, or string-argument timers.
- No `javascript:` URLs.
- Templates are built with `document.createElement` and `textContent`, never `innerHTML`.

> **Verification required (blocking):** confirm `<meta>`-delivered CSP is enforced on `file://` in all
> four browsers. Meta CSP is widely supported, but enforcement of hash sources on a `file://` origin
> must be demonstrated, not assumed. If meta CSP is not enforced on `file://` in some browser, the
> mitigation degrades to "detects tampering only when served over HTTP" — which must then be stated
> honestly in `08-security.md` rather than claimed as universal.

---

## 6. Boot sequence

Order is deliberate. Step 1 in particular is unrecoverable if done late.

```
1.  Capture pristine DOM
      PRISTINE = document.documentElement.cloneNode(true)
      — FIRST statement of the application, before any DOM mutation, before any
        theme class is applied. REQ-EXP-008.

2.  Read and parse the container
      – read #tmv-data textContent
      – unescape (§4) → JSON.parse
      – validate container version, then model. REQ-DATA-003, REQ-DATA-005
      – on failure: render error state offering the raw text, then STOP. Never touch
        local history for this modelId. REQ-DATA-005

3.  Integrity check
      – recompute commit hashes; verify chain. REQ-VCS-002
      – on failure: enter read-only mode, report the affected commit. REQ-VIEW-008

4.  Initialise storage
      – probe availability; detect origin partitioning. REQ-STORE-007, REQ-SYNC-008
      – upsert the registry from embedded data. REQ-STORE-003

5.  Reconcile
      – compare embedded history to local history. REQ-SYNC-001..006
      – fast-forward silently; banner if local is ahead; STOP into compare view if
        diverged. REQ-VCS-009

6.  Render
      – shell state (theme, tab, side nav) from persisted UI preferences
      – active tab's content into #tmv-content

7.  Attach handlers
      – delegated listeners on the shell; no per-row handlers. REQ-UI-008

8.  Report
      – notifications for anything the user needs to know. REQ-UI-009
```

Steps 2–5 are all "before the UI is interactive, or with a progress state shown" per
REQ-SYNC-001. In practice the work is milliseconds for realistic models, so a blocking boot with an
error branch is honest and simpler than an async skeleton.

**Why step 1 must be first.** `cloneNode(true)` on `documentElement` captures the shell as authored.
If it runs after rendering, or after a theme class is applied, the export carries whatever state the
session happened to be in — rendered entity rows in `#tmv-content`, a theme class, a dirty indicator.
Capturing first makes the export deterministic regardless of how long the user worked before
exporting (REQ-EXP-008 AC2).

---

## 7. Self-export

```
buildExport(container):
  clone = PRISTINE.cloneNode(true)
  block = clone.querySelector('#tmv-data')
  block.textContent = escapeForScriptBlock(serialize(container))
  return '<!DOCTYPE html>\n' + clone.outerHTML
```

Then, before offering the download (REQ-EXP-010):

1. Re-parse the assembled document; assert the data block re-parses.
2. Assert the extracted container equals the one passed in.
3. Assert the script text is byte-identical to the artifact's own (REQ-EXP-009 AC1).
4. Assert the declared `tmv-app-hash` matches the script's actual hash.

Downloads use `Blob` + an anchor with `download`. Where that is blocked — some configurations
suppress downloads from `file://` — the fallback presents the full text in a read-only Carbon code
snippet with a copy action (REQ-EXP-012). The fallback is always reachable from the export dialog, not
only surfaced on failure, so users on locked-down browsers are not stuck.

The file can be large: the application plus a full history. Nothing is truncated, and the size is
reported in the export dialog before the user commits to it.

---

## 8. Source layout

```
src/
  index.html
  styles/
    00-app.css              # app-level styling layered over Carbon
    01-print.css            # print behaviour (see 10-open-questions.md)
  app/
    01-core.js              # namespace, DOM helpers, escaping
    02-canonical.js         # canonical serialization (§ canonical hash input)
    03-hash.js              # SHA-256 (ADR-0011)
    04-container.js         # container parse/serialize, script-block escaping
    05-model.js             # canonical model shape + validation
    06-vcs.js               # commits, DAG, ancestry, deltas, keyframes, merge base
    07-storage.js           # persistence adapter, registry, quota
    08-otm.js               # OTM mapping both directions
    09-tml.js               # TML mapping both directions
    10-import.js            # detection, validation, reports
    11-export.js            # interchange export, app re-export, download
    12-shell.js             # header, tabs, side nav, theme — hand-written Carbon wiring
    13-views-*.js           # one per tab group
    14-forms.js             # create/edit/delete, validation, references
    15-compare.js           # divergence compare + merge resolution
    16-notify.js            # notifications, errors
    99-boot.js              # §6
vendor/
  otm_schema.json
  tml_schema.json
  README.md                 # source URLs + retrieval commits
build.mjs
test/
  run.mjs                   # concatenates BUILD_ORDER, loads into a VM context
  unit/*.test.mjs
  e2e/*.spec.mjs
dist/                       # build output, git-ignored
```

The numbering *is* the dependency order and matches `BUILD_ORDER` in `build.mjs`.

---

## 9. Hashing implementation

ADR-0011 settles this, but it belongs here because it shapes every module signature.

Commit ids are SHA-256 over canonical serialization. The obvious implementation is
`crypto.subtle.digest`, but:

- `crypto.subtle` requires a **secure context**. `file://` is specified as potentially trustworthy and
  is treated as a secure context by current browsers, but this is exactly the kind of platform
  assumption this project has already been burned by (ADR-0001). If it does not hold, hashing — and
  therefore the entire application — fails at the first commit.
- It is **asynchronous**, which makes every commit, hash, and integrity check async, complicating the
  boot sequence and every test.
- It is **not available in Node** in the same form, so the unit tests would diverge from production.

**Decision:** a pure-JavaScript SHA-256, synchronous, identical in every environment, verified against
NIST test vectors in the unit suite. v1 has no cryptographic signing (ADR-0008), so the only property
required is collision resistance for content addressing — which SHA-256 provides regardless of
implementation language.

The trade-off is accepted knowingly: hand-written cryptographic primitives are a classic source of
subtle bugs. The mitigation is that this one is verified against published test vectors on every
build, and it makes no security claims beyond content addressing.

---

## 10. What this architecture does not do

Stated so the boundaries are visible:

- **No service worker.** A service worker would give genuine offline support for the CDN assets, but
  it requires a secure context *and* an HTTP origin — it does not work from `file://`, which is the
  primary use case. ADR-0002's degradation stands.
- **No `fetch` at runtime.** Schemas are inlined; the container is in the document. The app never
  performs a network read.
- **No IndexedDB.** Firefox blocks it on `file://` because such an origin is `null`, and its
  workaround would make every `file://` page share one database — worse than the localStorage
  situation in ADR-0001. localStorage, with all its limits, is the honest choice.
- **No routing or history API.** `pushState` is unreliable on `file://`. Tab state is held in memory
  and mirrored to a UI-preferences storage key, not to the URL.
