# 08 — Security

The application's own threat model. A tool that displays untrusted documents, executes JavaScript, and
keeps state in browser storage has a specific and non-obvious risk profile, and one of its risks is
structural rather than fixable.

Related: REQ-SEC-001..008, ADR-0001 (`file://` origins), ADR-0002 (CDN), ADR-0008 (identity).

---

## 1. The structural problem, stated plainly

**An exported threat model is an executable HTML file.**

That is not incidental — it is the design. The file carries the application so the model and its
viewer cannot be separated. The consequence is that *opening* a threat model means *running its
code*, with whatever privileges a local page has.

On Chrome and Edge, every `file://` page shares **one** origin. So a threat model received by email,
opened by double-click, runs its script with access to every other model in that origin's
`localStorage` — every threat model the user has ever opened locally.

A threat model is also, by nature, a document worth stealing: it describes systems, their data
classification, their weaknesses, and their controls.

Put together: **a crafted "threat model" is a plausible exfiltration vector, and this application
makes the pattern routine.** Anyone who tells you otherwise has not thought about it.

### What this means for the design

The mitigation is not technical alone, because no browser mechanism distinguishes a file the user
trusts from one they do not. Three layers:

| Layer | Mitigation | Strength |
|---|---|---|
| 1 | **Recommend the import path** — see §3 | **Strong.** Import never executes |
| 2 | Warn on unrecognized application builds; default to read-only | Moderate |
| 3 | CSP, escaping, sanitization | Protects the *authentic* file; does nothing against a hostile one |

Layer 1 is the one that actually works and is therefore given prominence in the UI, not buried in
documentation.

---

## 2. Assets, and who wants them

| Asset | Why it matters |
|---|---|
| **All stored threat models** (`localStorage`) | Architecture, data classification, weaknesses, controls. Readable by any same-origin page |
| **The model's integrity** | A subtly altered model is worse than a missing one — it is believed |
| **Authorship claims** | "Who said this?" drives decisions downstream |
| **The user's machine** | Only through the browser, but that is enough |
| **The repository's supply chain** | Third-party CSS and JS loaded into the app |

| Adversary | Capability | Interest |
|---|---|---|
| **Document author** | Can craft a file and get it opened. The primary adversary | Exfiltrate other models; inject content into a model's history |
| **Network attacker** | Can modify files in transit; cannot change a pinned CDN asset without breaking SRI | Tamper with a model, or with the app |
| **Local malware / a saved webpage** | Can read `file://` storage on Chrome/Edge | Harvest models opportunistically |
| **Curious recipient** | No malice; inspects a file they were sent | Not an adversary, but a privacy consideration (`metadata.contributors`, commit authorship) |

The **document author** is the adversary that matters, because they are the one the design invites.

---

## 3. The primary mitigation: import, do not open

To read a threat model you do not trust, **do not open the file**. Open a copy of the application you
trust — one you built, or one fetched from a source you control — and **import** the model into it.

Import path guarantees (REQ-IMP-008):

- Files are read with `FileReader`/`text()` as **text**.
- The HTML data block is located by string scanning, not by parsing the document.
- The incoming document is **never** inserted into the DOM, never assigned to `innerHTML`, never
  parsed with `DOMParser` in a mode that executes, and never given a `<script>` element.
- Extracted JSON is parsed with `JSON.parse` and validated structurally before use.

An imported malicious model can therefore still contain hostile *content* — which the escaping and
sanitization rules handle (§5, §6) — but its *code never runs*.

This is the safe path and the UI says so: the import screen carries a note that importing is safer
than opening an unfamiliar file, and About explains why. That note is not decoration; it is the
mitigation.

---

## 4. What the content-security policy does and does not do

The CSP is specified in `02-architecture.md` §5. Its value must not be overstated, because the natural
reading — "the app is sandboxed" — is wrong.

**What it does:**

| Protection | Mechanism |
|---|---|
| A tampered authentic file does not run | `script-src` allows only the build's script hash; modify the script and the browser refuses it (REQ-SEC-001) |
| Injected content cannot execute | If a model field could somehow introduce a script element, its hash is not in the policy, so it will not run |
| Data cannot be exfiltrated by the app | `connect-src 'none'` — there is no network egress path at all |
| No unexpected third-party code | Only three origins are permitted, each pinned and enumerated |
| Injected markup cannot redirect | `base-uri 'none'`, `form-action 'none'` |

**What it does not do:**

> **A hostile file sets its own policy.** An attacker authoring a malicious "threat model" writes the
> CSP meta tag themselves and permits their own script's hash. The policy in the file cannot constrain
> the file's author.

This is why §3's import guidance is the primary mitigation and the CSP is secondary. Stating it the
other way round would be a comfortable lie.

**Platform caveat.** `<meta>`-delivered CSP enforcement on `file://` must be verified per browser
(`02-architecture.md` §5). If some browser does not enforce it there, the protections above hold only
when a file is served over HTTP, and this document must say so rather than claim them universally.
Until that verification is done, treat CSP-on-`file://` as **unconfirmed**.

### Detecting a foreign build

`<meta name="tmv-app-hash">` declares the build (REQ-SEC-005). On load:

| Condition | Behaviour |
|---|---|
| Hash matches a known build | Normal |
| Hash matches a known build but the script's actual hash differs | The browser has already refused the script; the app does not run |
| Hash is unrecognized | **Warn, default to read-only**, require explicit acknowledgement to edit. The app was produced by a build this user has not seen |

The third case is advisory by necessity — the file could come from a legitimate newer build — but it
is the signal that turns "I opened a file" into "I opened a file from an unfamiliar source."

---

## 5. Injection through model content

Escaping is the whole defence and it must be applied without exception (REQ-SEC-003).

| Rule | |
|---|---|
| All model-derived text enters the DOM via `textContent` or `createTextNode` | Never `innerHTML` |
| No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` anywhere in the app | Static-analysis enforced |
| Attribute values set with `setAttribute` from a validated allowlist | Never string-concatenated markup |
| URLs (`repoLink`, `releaseDocsLink`, `link`, `repositoryUrl`) validated against an allowlist of schemes — `http`, `https`, `mailto` | `javascript:`, `data:`, `vbscript:` and friends rejected |
| Rendered URLs are additionally marked `rel="noopener noreferrer"` | |
| No template strings producing markup | |

The test is parameterised over **every** entity field and every URL field rather than a sample
(`sec.xss-model-fields`), because the failure mode is a single missed field, and a sample would miss
exactly the field that was missed.

### Prototype pollution

Model data is attacker-controlled JSON, and `JSON.parse` will happily produce a `"__proto__"` key.
Any deep merge, default-filling, or patch application over that data is a prototype-pollution
primitive.

| Rule | |
|---|---|
| Model objects are reconstructed into `Object.create(null)` or by explicit field copying | |
| No deep merge of untrusted data into a normal object | |
| `JSON Patch` application validates each operation: `op` from an allowlist, `path` a bounded pointer, no `__proto__`/`constructor`/`prototype` segments | |
| Exported field names are checked against the canonical schema before being written | |

Test: `sec.prototype-pollution`, fed models containing `__proto__`, `constructor`, and `prototype`
keys at every nesting level.

### Resource exhaustion

A hostile file can declare an enormous history, deeply nested entities, or a 200 MB diagram source.
There is no decompression in the pipeline, so no zip bomb — but a large file still hangs the tab.

| Guard | Limit |
|---|---|
| Container size | Warn above ~20 MB; refuse above ~100 MB with an explanation |
| Commit count | Warn above 10,000 commits |
| Per-delta operation count | Refuse a patch above 100,000 operations |
| Nesting depth on parse | Refuse beyond a fixed depth |
| Diagram source length | Refuse to render beyond a fixed size; offer source text instead |

Every limit fails with an explanation and an offer to export what was readable, never a blank page.

---

## 6. SVG and Mermaid

Both are code-carrying formats.

**SVG** can contain `<script>`, event handlers, `<foreignObject>` with HTML, and external references.
An imported SVG is therefore sanitized before display (REQ-SEC-004), or rendered in a sandboxed iframe
**without** `allow-scripts` — never inserted as-is. What sanitization must remove:

| Removed | |
|---|---|
| `<script>`, `<foreignObject>`, `<use>` with an external href | |
| All `on*` attributes | |
| `href`/`xlink:href` with `javascript:` or external URLs | |
| `<?xml-stylesheet?>`, `<style>` with `@import` | |
| `<image>` with an external URL | |

If sanitization cannot be completed confidently, the diagram is shown as **source text** instead. A
diagram the user cannot see is a small loss; a script that runs is not.

**Mermaid** is third-party code loaded from a CDN. It is pinned and SRI-checked, loaded only when a
Mermaid diagram is actually displayed (REQ-VIEW-005), and it is the one dependency granted
`script-src`. Mermaid parses attacker-controlled diagram text — its own sanitization settings must be
configured for the safe mode (`securityLevel: 'strict'`), and this must be verified rather than
assumed, since the default has changed across versions.

> **Verify:** the pinned Mermaid version's `securityLevel` default and its `htmlLabels` behaviour.
> Both have historically permitted HTML injection in labels.

---

## 7. Supply chain

| Dependency | Type | Mitigation |
|---|---|---|
| `@carbon/styles` | CSS | Exact version in the URL; SRI; `crossorigin`; CSS cannot execute |
| IBM Plex fonts | Fonts | Referenced by Carbon's own CSS from IBM's CDN. Fonts cannot execute |
| `mermaid` | **JavaScript** | Exact version; SRI; lazy-loaded; the only third-party script origin |

Carbon's CSS origin is granted `style-src`, not `script-src` — a compromised stylesheet can deface the
app but cannot execute code. Mermaid is the genuine supply-chain risk, which is why it is not loaded
until needed, and why the app remains fully functional if it fails.

The build is dependency-free (REQ-SHELL-003), so there is no npm supply chain in the artifact.
Development dependencies (test tooling) do not ship.

---

## 8. What the hash chain does not prove

The commit chain (ADR-0008, `04-versioning.md` §2) detects modification of an existing history. It
does **not** authenticate authorship.

| Property | Provided? |
|---|---|
| The history has not been altered since it was written | **Yes** |
| The history is internally consistent and complete | **Yes** |
| Corruption or truncation is detected | **Yes** |
| The named author actually wrote it | **No** |
| The history wasn't fabricated wholesale from scratch | **No** |
| The history wasn't regenerated with the same content but a different author name | **No** |

Commit ids incorporate the author field, so changing an author name changes every subsequent id — an
attacker must rebuild the chain, which is trivial because nothing signs it.

The UI must therefore use precise language. The History tab reports **"chain intact"**, never
"verified", never "trusted", never a checkmark implying authenticity. The self-asserted nature of
identity is stated in Settings where the identity is entered, so a user is not surprised later.

Cryptographic signing is the fix and is deferred (`10-open-questions.md`); the honest label costs
nothing and is present from v1.

---

## 9. Local storage exposure

Stored models sit in `localStorage`, and on Chrome/Edge every `file://` page shares that store.

| Risk | Status |
|---|---|
| Any HTML file saved to disk can read all models (Chrome, Edge) | **Platform behaviour, not fixable by us.** Disclosed in About |
| Firefox gives each file its own origin | Narrower exposure; also why sync needs the file path (ADR-0001) |
| Another user account on the machine | Browser profile scoping applies as usual |
| Secrets | **None are stored.** No credentials, no tokens, no keys. The only personal data is the self-asserted name and email |

The app stores nothing it would be embarrassed to have read, which is the only real mitigation
available. What it stores is the user's threat models — and the user should know that a threat model
in local storage is as exposed as any file in that browser profile.

`About` states this. It is a disclosure obligation, not a warning dialog.

---

## 10. Privacy

- **No telemetry** (REQ-SEC-008). No analytics, no error reporting, no update checks.
- **No network requests** beyond the three enumerated origins, none of which receive model data
  (REQ-SHELL-007). There is no code path that could send a model anywhere, because `connect-src` is
  `'none'`.
- **No accounts.** There is no server to have one with.
- **Exported files carry author names and emails** in every commit. This is inherent to a git-style
  model and is worth knowing before sending a model outside an organization. Replacing history to
  remove them would rewrite commit ids and break reconciliation (`04-versioning.md` §7), so the answer
  is disclosure, not a "strip authors" button that silently fragments the history. A future
  "export head only, no history" option is the correct fix — see `10-open-questions.md`.

---

## 11. Residual risk

Stated so it is not mistaken for solved.

| # | Residual risk | Acceptable? |
|---|---|---|
| R1 | A hostile threat-model file opened directly can read all models in the origin (Chrome/Edge) | **Partly.** Mitigated by the import path (§3) and build warnings. Not eliminable while a threat model is executable HTML |
| R2 | If a browser does not enforce meta CSP on `file://`, tamper detection degrades to HTTP-served files only | **Temporarily.** Requires the §4 verification; the finding must then be documented rather than assumed away |
| R3 | A hostile model can exhaust memory or hang the tab | **Yes**, bounded by §5's guards, and recoverable by closing the tab. Nothing is corrupted |
| R4 | Authorship is forgeable | **Yes, for v1.** Disclosed in the UI. Signing is the v2 fix |
| R5 | A compromised Mermaid release could execute code | **Yes.** Pinned, SRI-checked, lazy, and the app works without it |
| R6 | Models in local storage are readable by other local pages on Chrome/Edge | **Yes.** Platform behaviour; disclosed. The app stores no secrets |
| R7 | A user can be social-engineered into opening an unfamiliar file and clicking through the warning | **Yes.** No technical control fixes this; the warning is the control |

R1 and R4 are the two that a security reviewer should press on. Both are disclosed in the product and
here, rather than mitigated on paper.

---

## 12. Security verification

| Check | Method |
|---|---|
| No `innerHTML` / `eval` / inline handlers / dynamic script insertion | Static analysis over the built artifact (REQ-SEC-002, REQ-UI-008) |
| XSS via any model field | Parameterised over every field and URL field (REQ-SEC-003) |
| Prototype pollution | Adversarial models with `__proto__`/`constructor`/`prototype` at every level |
| Imported HTML never executes | Import a file whose data block contains a script; assert it does not run |
| SVG sanitization | Imported SVGs with script, handlers, `foreignObject`, external refs |
| CSP blocks a tampered script | Modify the script in an exported file; assert the app does not start |
| No network egress | Full exercise with network inspection; assert only the enumerated origins |
| No telemetry | Same inspection; assert no request carries model content |
| Resource guards | Oversized container, commit count, patch operations, diagram source |
| SRI pinned | Exact versions in every external URL; tamper test |
| Identity labelled honestly | Copy review: no "verified" claim anywhere near authorship |

`sec.no-exfiltration` and `sec.xss-model-fields` are the two that must never be skipped in CI. The
first is the promise; the second is the most likely way to break it.
