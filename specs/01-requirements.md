# 01 — Requirements

Numbered, testable requirements. Each carries acceptance criteria (`AC`) and, where decided, the test
that proves it. An ID with no test is a spec bug — see `09-testing.md`.

Keywords follow RFC 2119: **shall** is mandatory, **should** is recommended, **may** is optional.

Requirement ID scheme and traceability to the original request are in [SPEC.md](../SPEC.md).

---

## SHELL — The single-file artifact

### REQ-SHELL-001 — One distributable file
The application **shall** be distributed as a single HTML file. Application JavaScript, application
CSS, and the model data **shall** be inline. Carbon's stylesheet **shall** be the only external
reference (ADR-0002).

- **AC** Opening the file with nothing else present in the directory renders a complete UI.
- **AC** No relative `src`/`href` references to sibling files exist in the artifact.
- **Test:** `shell.no-relative-refs`

### REQ-SHELL-002 — Classic inline script, not a module
The application script **shall** be a classic (non-module) inline `<script>`. It **shall not** use
`<script type="module">` with a local or relative `src`, which browsers block on `file://` due to the
null origin.

- **AC** The file loads and runs when opened via `file://` in Chrome, Firefox, and Safari.
- **AC** No `<script type="module" src="…">` with a non-absolute URL appears in the artifact.
- **Test:** `shell.classic-script`, `e2e.file-protocol.bootstrap`

### REQ-SHELL-003 — Build produces the artifact
A dependency-free Node build script **shall** concatenate modular sources into the single artifact.
The build **shall** require no third-party packages.

- **AC** `node build.mjs` produces `dist/threat-model-viewport.html` from a clean checkout with no
  `npm install`.
- **AC** The build fails loudly if any placeholder is unresolved.
- **Test:** `build.clean-checkout`

### REQ-SHELL-004 — Runs from `file://` and `http(s)://`
The application **shall** function identically when opened via `file://` and when served over HTTP,
except where platform storage rules differ — and where they differ, it **shall** say so in the UI
(REQ-STORE-007, REQ-SYNC-008).

- **AC** Every end-to-end test in the suite passes on both protocols.
- **Test:** `e2e.matrix.protocol`

### REQ-SHELL-005 — Browser support matrix
The application **shall** support the current and previous major versions of Chrome, Edge, Firefox,
and Safari. Behaviour differences in `file://` storage **shall** be detected at runtime rather than
assumed (REQ-SYNC-008).

- **AC** The support matrix is stated in the UI's About panel, including the `file://` caveat.
- **AC** No feature is used without a runtime capability check and a defined fallback.
- **Test:** `e2e.matrix.browser`

### REQ-SHELL-006 — Graceful degradation without JavaScript
The application **shall** show a plain "JavaScript is required" message inside a `<noscript>` element
rather than a blank page.

- **AC** With JavaScript disabled, the message is visible and names the requirement.
- **Test:** `shell.noscript`

### REQ-SHELL-007 — No network calls beyond pinned CDN assets
The application **shall not** transmit model data. The only permitted network requests are the pinned
Carbon stylesheet, the IBM Plex font files it references, and lazily-loaded Mermaid when a TML
Mermaid diagram is rendered (REQ-VIEW-005).

- **AC** With the network blocked after the app loads, no feature fails except those explicitly
  documented as requiring the CDN.
- **AC** No request carries model content in a URL, body, or header.
- **Test:** `sec.no-exfiltration`

---

## DATA — Embedded JSON and the canonical model

### REQ-DATA-001 — Model data is inline
The selected threat model **shall** be embedded in the HTML as a JSON data block that is not executed
as script. The container **shall** carry a stable element id.

- **AC** The block is discoverable by a single `getElementById` call.
- **AC** The block parses with `JSON.parse` after unescaping per REQ-DATA-002.
- **Test:** `data.block-discoverable`

### REQ-DATA-002 — Escaping is round-trip safe
Embedded JSON **shall** escape `</script`, `<!--`, and the line separators U+2028/U+2029 such that the
data survives a parse → serialize → re-embed cycle byte-identically in value terms.

- **AC** A model containing the literal text `</script>` in a description field round-trips unchanged.
- **AC** A model containing U+2028 in a title round-trips unchanged.
- **Test:** `data.escape-roundtrip` (cases: `close-script`, `close-comment`, `line-separator`)

### REQ-DATA-003 — The container is versioned and self-describing
The container **shall** declare its own format version and a `$schema` identifying the container
format — distinct from any interchange schema version.

- **AC** An unknown container version loads in read-only mode with a clear explanation rather than
  failing to parse.
- **Test:** `data.unknown-container-version`

### REQ-DATA-004 — Canonical model with passthrough bags
The canonical model **shall** be format-neutral and **shall** carry per-format passthrough bags
(`x-otm`, `x-tml`) at model and entity level to preserve source fields it does not represent natively.
See ADR-0004 and `03-data-model.md`.

- **AC** Fields present in an imported source document but absent from the canonical schema are
  preserved in the corresponding bag.
- **AC** Re-exporting to the source format restores those fields.
- **Test:** `data.passthrough.otm`, `data.passthrough.tml`

### REQ-DATA-005 — Invalid embedded data never destroys anything
When embedded data is malformed, truncated, or fails validation, the application **shall** present an
error state, **shall** offer the raw text for extraction, and **shall not** overwrite local history
for that model id.

- **AC** A corrupted data block leaves existing local history intact and reachable.
- **AC** The raw embedded text is retrievable from the error screen.
- **Test:** `data.corrupt-block-nondestructive`

### REQ-DATA-006 — Model identity is a stable UUID
Each model **shall** carry a `modelId` that is a UUID generated at creation and preserved across all
copies, exports, and re-exports.

- **AC** Exporting and reopening a model preserves `modelId`.
- **AC** Two independently created models never share a `modelId`.
- **Test:** `data.model-id-stable`

---

## VCS — Versioning

### REQ-VCS-001 — A commit is a content-addressed node
Each commit **shall** contain a unique id, zero or more parent ids, an author, a committer timestamp,
a message, and a model snapshot reference. The id **shall** be the SHA-256 of the commit's canonical
serialization.

- **AC** Recomputing the hash from the stored fields reproduces the id exactly.
- **AC** Two commits identical in model content, parents, author, timestamp, and message produce
  identical ids. (The hash covers exactly those inputs — see `03-data-model.md` §7 — so a differing
  timestamp is a different commit and *should* hash differently.)
- **Test:** `vcs.commit-hash-deterministic`

### REQ-VCS-002 — Hash chaining detects tampering
Because each commit's id covers its parents' ids, any modification to a historical commit **shall** be
detectable by recomputation.

- **AC** Altering any field of a non-head commit is reported as an integrity failure naming the
  affected commit.
- **AC** The app remains usable in read-only mode after an integrity failure; it does not silently
  accept the altered history.
- **Test:** `vcs.tamper-detected`

### REQ-VCS-003 — Canonical serialization is stable
Hash computation **shall** use a canonical serialization with sorted object keys, no insignificant
whitespace, and a fixed numeric representation, so the same logical model always hashes identically
across browsers and platforms.

- **AC** Serializing the same model in Chrome and Firefox yields identical bytes.
- **AC** Key insertion order does not affect the hash.
- **Test:** `vcs.canonical-serialization`

### REQ-VCS-004 — Commits capture the working copy
The application **shall** maintain a working copy that accumulates edits, and a commit operation that
snapshots it. A commit **shall not** be created implicitly.

- **AC** Editing a field does not create a commit until the user commits.
- **AC** Committing with no changes is refused with an explanation.
- **Test:** `vcs.commit-explicit`

### REQ-VCS-005 — History is stored as deltas with keyframes
Non-keyframe commits **shall** be stored as a JSON Patch (RFC 6902) delta against their parent, with a
full snapshot keyframe at a configured interval and at every branch point.

- **AC** A history of *N* commits stores *N* deltas plus ⌈*N*/interval⌉ keyframes.
- **AC** Keyframes are forced at every commit with more than one child.
- **Test:** `vcs.delta-storage`, `vcs.keyframe-at-branch`

### REQ-VCS-006 — Reconstruction is lossless
Reconstructing a model from its nearest preceding keyframe plus the intervening deltas **shall**
produce a model byte-identical to the one the hash was computed over.

- **AC** For a randomly sampled commit, reconstruction matches its recorded hash.
- **AC** Reconstruction succeeds from any commit in the DAG, not only from the head.
- **Test:** `vcs.reconstruct-fidelity` (property test over generated histories)

### REQ-VCS-007 — Timestamps are informational only
Commit timestamps **shall** be displayed but **shall not** be used to determine precedence. Ancestry
alone decides which of two histories is newer.

- **AC** A commit with a clock-skewed future timestamp does not outrank its own descendant.
- **Test:** `vcs.clock-skew-ignored`

### REQ-VCS-008 — Ancestry defines "newer"
History *A* is newer than *B* if and only if *B* is an ancestor of *A*, or *A* and *B* are the same
commit.

- **AC** For linear histories, the descendant is reported as newer regardless of timestamps.
- **AC** For diverged histories, no ordering is reported; the app reports divergence instead.
- **Test:** `vcs.ancestry-ordering`

### REQ-VCS-009 — Divergence requires an explicit decision
When two histories have diverged, the application **shall** present both for comparison and **shall
not** create a merge commit without an explicit user action. See ADR-0003.

- **AC** Opening a file whose history diverges from local history displays a compare view naming both
  heads.
- **AC** No commit is written before the user confirms a resolution.
- **AC** Dismissing the view leaves the working copy and both histories unchanged.
- **Test:** `vcs.divergence.no-auto-merge`, `e2e.conflict.prompt`

### REQ-VCS-010 — Merge base is the lowest common ancestor
Comparison and merge **shall** use the lowest common ancestor of the two heads as the merge base. If
multiple merge bases exist (criss-cross history), the application **shall** use one and **shall**
state in the UI that the comparison is approximate.

- **AC** For a criss-cross history, the UI discloses the approximation.
- **Test:** `vcs.merge-base-lca`, `vcs.criss-cross-disclosure`

### REQ-VCS-011 — Merge commits record both parents
A resolved merge **shall** be recorded as a commit with two parents, preserving both histories
permanently. History **shall not** be rewritten or discarded.

- **AC** After a merge, both original heads remain reachable from the new head.
- **AC** The merge commit appears in the log with both parents identified.
- **Test:** `vcs.merge-two-parents`

### REQ-VCS-012 — Uncommitted changes block merging
If the working copy has uncommitted changes, the application **shall** refuse to reconcile and
**shall** offer to commit, stash, or discard — never silently discarding.

- **AC** Reconcile is blocked while the working copy is dirty.
- **AC** A stash is recoverable from the UI after the reconcile completes.
- **Test:** `vcs.dirty-blocks-merge`

### REQ-VCS-013 — Rollback is forward-only
Reverting to a previous commit **shall** create a new commit whose content matches the target, rather
than removing history.

- **AC** After a revert, every previously reachable commit is still reachable.
- **Test:** `vcs.revert-forward-only`

### REQ-VCS-014 — Undo and redo within the working copy
The application **shall** provide undo/redo for working-copy edits, scoped to the uncommitted session.

- **AC** Undo after a commit does not un-commit; it is bounded by the commit boundary.
- **Test:** `vcs.undo-scope`

### REQ-VCS-015 — Commit messages and authors are required
A commit **shall** require a non-empty message. The author **shall** be taken from the stored identity,
which **shall** be configurable in Settings.

- **AC** Committing with an empty message is refused.
- **AC** Changing the identity in Settings affects subsequent commits only.
- **Test:** `vcs.commit-message-required`, `vcs.identity-change-forward-only`

---

## SYNC — Reconciling file and storage

### REQ-SYNC-001 — Reconcile runs on every open
On loading a file, the application **shall** compare the embedded history against local history for
the same `modelId`.

- **AC** The comparison happens before the UI becomes interactive, or a progress state is shown.
- **Test:** `sync.reconcile-on-open`

### REQ-SYNC-002 — Embedded ahead fast-forwards
If the embedded history is strictly ahead of local history, the application **shall** adopt it and
record it locally.

- **AC** After adoption, the local head equals the embedded head.
- **AC** A notification names the number of commits adopted.
- **Test:** `sync.embedded-ahead-adopts`

### REQ-SYNC-003 — Local ahead is used, and the file is offered for refresh
If local history is strictly ahead of the embedded history, the application **shall** use the local
version, and **shall** offer to export a refreshed file. *(This is the original "use the newer
version" requirement.)*

- **AC** The displayed model reflects local history, not the file's.
- **AC** A persistent, dismissible banner offers "Export updated file".
- **AC** Dismissing the banner does not discard the local history.
- **Test:** `sync.local-ahead-wins`, `sync.local-ahead-offer-export`

### REQ-SYNC-004 — Identical histories are a no-op
If both histories are identical, no prompt, banner, or notification **shall** appear.

- **AC** Opening an unchanged file twice produces no reconcile UI on the second open.
- **Test:** `sync.identical-silent`

### REQ-SYNC-005 — Divergent histories prompt
Divergence **shall** route to the compare view defined by REQ-VCS-009.

- **AC** The reconcile flow reaches the compare view without writing to storage.
- **Test:** `sync.divergence-routes-to-compare`

### REQ-SYNC-006 — Unrelated models never merge
If the file's `modelId` is unknown locally, or the two histories share no common ancestor, the file
**shall** be registered as a separate model and **shall not** be merged into any existing one.

- **AC** An unrelated model appears as a new registry entry.
- **AC** No existing model's history is modified.
- **Test:** `sync.unrelated-not-merged`

### REQ-SYNC-007 — Reconcile never depends on shared origin storage
The reconcile flow **shall** produce a correct result when local storage is empty, partitioned per
file, or unavailable. Correctness **shall not** depend on both files sharing an origin.

- **AC** With storage cleared, opening a file and reconciling against an exported copy yields the same
  result as reconciling with storage intact.
- **Test:** `sync.origin-independent`

### REQ-SYNC-008 — Storage partitioning is detected and explained
When the application cannot find expected local history, it **shall** distinguish "genuinely no local
history" from "storage is partitioned or unavailable," and **shall** explain the latter in plain
language naming the browser behaviour.

- **AC** On Firefox over `file://`, the explanation names per-file origin partitioning.
- **AC** The explanation offers the file-based reconcile path as the workaround.
- **Test:** `sync.partition-detected`, `e2e.file-protocol.firefox`

---

## STORE — Persistence, registry, switching

### REQ-STORE-001 — Persistence sits behind an adapter
All storage access **shall** go through a single persistence adapter with a `localStorage` backend, so
an alternative backend can be added without touching feature code.

- **AC** No feature module references `localStorage` directly.
- **Test:** `store.no-direct-storage-access` (static check)

### REQ-STORE-002 — Keys are namespaced
Storage keys **shall** be namespaced by model, with a separate registry key. Keys **shall** include a
format version to allow migration.

- **AC** Keys match the documented pattern `tmv:<formatVersion>:registry` and
  `tmv:<formatVersion>:model:<modelId>:*`.
- **Test:** `store.key-namespacing`

### REQ-STORE-003 — The registry is seeded on every load
The registry entry for the open file's model **shall** be upserted from embedded data on **every**
load, not only on first load, so a partitioned or cleared store repopulates itself.

- **AC** Clearing storage and reopening a file repopulates the registry from the file alone.
- **Test:** `store.registry-seeded-every-load`

### REQ-STORE-004 — Switching models
The application **shall** let the user switch the active model among registry entries and the
currently embedded model, guarding unsaved changes.

- **AC** Switching with a dirty working copy prompts to commit, stash, or discard.
- **AC** The currently embedded model always appears as a switchable entry.
- **Test:** `store.model-switch`, `store.switch-guards-dirty`

### REQ-STORE-005 — Deleting a stored model
The application **shall** allow deleting a model from local storage, behind a confirmation that names
the model and states plainly that the file on disk is unaffected.

- **AC** Deletion removes the registry entry and all namespaced keys for that model.
- **AC** The confirmation states that the original file is not deleted.
- **AC** Deleting the currently open model returns the UI to the embedded data.
- **Test:** `store.model-delete`, `store.delete-scope`

### REQ-STORE-006 — Quota is managed without data loss
When a write would approach the storage quota, the application **shall** warn, quantify what it can,
and offer export, compaction, or explicit pruning. It **shall not** silently delete history.

- **AC** Exceeding quota surfaces an actionable error; unrelated data is not evicted.
- **AC** Compaction reduces size while preserving all reachable commits, or reports that it cannot.
- **AC** No code path deletes commits without explicit user confirmation.
- **Test:** `store.quota-warn`, `store.no-silent-pruning`

### REQ-STORE-007 — Storage unavailable degrades gracefully
If storage is unavailable or throws on access, the application **shall** remain fully usable as a
viewer and editor, with export available, and **shall** show a persistent notice.

- **AC** With storage disabled, the app loads, renders, edits, and exports.
- **AC** The notice explains that changes will not persist across reloads.
- **Test:** `store.storage-blocked-degrades`

### REQ-STORE-008 — Unreachable commits are collected
Commits unreachable from any ref **shall** be collectable, and keyframes beyond the retention setting
**shall** be droppable — both only on explicit user action.

- **AC** A garbage-collection action reports what it will remove before removing it.
- **Test:** `store.gc-explicit`

---

## EXP — Export

### REQ-EXP-001 — Export to OTM
The application **shall** export the canonical model as OTM JSON conforming to the OTM schema.

- **AC** Exported documents validate against the OTM schema the app validates against.
- **AC** `otmVersion` reflects the schema version targeted.
- **Test:** `exp.otm-validates`

### REQ-EXP-002 — Export to OWASP TML
The application **shall** export the canonical model as TML JSON conforming to the TML schema,
including a `$schema` value matching the schema's own required pattern.

- **AC** Exported documents validate against the TML schema.
- **AC** `$schema` matches the pattern the schema enforces, so validation does not fail on the
  identifier alone. A self-hosted or `raw.githubusercontent.com` value is **not** acceptable.
- **Test:** `exp.tml-validates`, `exp.tml-schema-identifier`

### REQ-EXP-003 — Lossiness is disclosed before export
Before an interchange export, the application **shall** list the fields that will not survive the
conversion.

- **AC** Exporting a TML-imported model to OTM lists personas, assumptions, trust boundaries,
  CAPEC/CWE links, and the risk matrix as not representable.
- **AC** The list is derived from the mapping tables, not hard-coded prose.
- **Test:** `exp.lossiness-disclosed`

### REQ-EXP-004 — Passthrough bags are re-emitted
Export **shall** re-emit preserved source fields from the matching passthrough bag.

- **AC** An OTM → app → OTM round trip preserves unmapped fields.
- **AC** Exporting to a format whose bag is empty emits no empty bag object.
- **Test:** `exp.passthrough-roundtrip`

### REQ-EXP-005 — Identifiers are exported safely
Export **shall** produce identifiers valid for the target schema. For TML, ids **shall** be
transformed to satisfy the schema's restricted character set, with a stable, collision-free mapping so
repeated exports are identical.

- **AC** TML export contains no id violating the schema's pattern.
- **AC** Two entities whose slugs collide receive distinct ids, and re-exporting produces the same ids.
- **Test:** `exp.tml-id-slug`, `exp.tml-id-collision-stable`

### REQ-EXP-006 — Native container export
The application **shall** export the native container — model **and** history — as JSON, for
round-trip or archival use.

- **AC** Re-importing a native export restores the full DAG, not just the head.
- **Test:** `exp.native-roundtrip-full-history`

### REQ-EXP-007 — App re-export
The application **shall** export a complete HTML file: the application plus the current model and
history embedded.

- **AC** The exported file opens standalone and shows the exported model at the exported head.
- **AC** The exported file contains the full history, not only the head.
- **Test:** `e2e.export.self-contained`

### REQ-EXP-008 — Self-export uses the pristine DOM
The application **shall** capture a pristine clone of `document.documentElement` at boot, before any
rendering, and **shall** build the export from that clone — never from the live DOM.

- **AC** An exported file contains no rendered entity rows, no table markup, and no runtime-added
  attributes.
- **AC** Exporting after extensive interaction produces the same application markup as exporting
  immediately after load.
- **Test:** `exp.pristine-dom`

### REQ-EXP-009 — Application code is preserved byte-identically
Re-export **shall** reproduce the application's script and style content byte-for-byte, so that the
content-security hash (REQ-SEC-001) remains valid in the exported file.

- **AC** The script text in an exported file is byte-identical to the source artifact's.
- **AC** The exported file's declared hash matches its own script content.
- **Test:** `exp.script-byte-identical`

### REQ-EXP-010 — Export is verified before download
Before offering the file, the application **shall** verify that the assembled document is well-formed
and that the embedded JSON re-parses to the same model.

- **AC** A verification failure blocks the download and reports the reason.
- **Test:** `exp.self-verify`

### REQ-EXP-011 — Export filenames are predictable
Exported files **shall** be named deterministically from the model name, the target format, and the
head commit's short id.

- **AC** Filenames are filesystem-safe and free of characters requiring escaping.
- **Test:** `exp.filename-safe`

### REQ-EXP-012 — Export works without a server
Export **shall** work when the file is opened via `file://`, using a Blob download where available and
a copyable-text fallback where it is not.

- **AC** Under `file://`, export produces a downloadable file in Chrome, Firefox, and Safari.
- **AC** Where download is blocked, a fallback exposes the full content for manual saving.
- **Test:** `e2e.export.file-protocol`

### REQ-EXP-013 — Export is always available
Export **shall** be available regardless of storage state, dirty working copy, or pending conflicts.

- **AC** With storage disabled and a dirty working copy, both interchange and app export succeed.
- **Test:** `exp.available-in-degraded-modes`

---

## IMP — Import

### REQ-IMP-001 — Import from a chosen file or drag-and-drop
The application **shall** accept a file via a picker and via drag-and-drop onto the content area.

- **AC** Both paths accept the formats in REQ-IMP-002.
- **Test:** `imp.picker`, `imp.drag-drop`

### REQ-IMP-002 — Format detection
The application **shall** identify the incoming format before parsing to a model: native container,
exported HTML, OTM, or TML.

- **AC** Each format is detected from structural markers, not the filename extension alone.
- **AC** An unrecognised format produces a clear error naming what was expected.
- **Test:** `imp.detect-native`, `imp.detect-html`, `imp.detect-otm`, `imp.detect-tml`,
  `imp.detect-unknown`

### REQ-IMP-003 — Validation against vendored schemas
The application **shall** validate imported interchange documents against schema copies bundled at
build time, and **shall** report violations without crashing or partially importing.

- **AC** Validation runs offline with no schema fetch.
- **AC** By default, a document failing validation reports the failing paths and imports nothing.
- **AC** The failure screen offers an explicit **"Import anyway (limited)"** override, stating that
  the model will be read-only for re-export to that format until the violations are resolved. This
  exists because a viewport's purpose is to read what someone sent; refusing outright would make the
  tool useless for a slightly-off-spec file, while importing silently would propagate invalid data.
- **Test:** `imp.validate-offline`, `imp.invalid-reports-paths`, `imp.invalid-override-readonly`

### REQ-IMP-004 — Referential integrity is checked and reported
Because neither interchange schema enforces referential integrity, the application **shall** check
references itself and **shall** report dangling references as **warnings**, importing the model with
those references marked unresolved.

- **AC** A model with a dangling reference imports and flags the reference.
- **AC** Unresolved references are visible in the UI, not silently dropped.
- **Test:** `imp.dangling-refs-warn`

### REQ-IMP-005 — Imports become a root commit
An imported interchange model **shall** become a new model with a single root commit. No history
**shall** be fabricated.

- **AC** The imported model's history has exactly one commit.
- **Test:** `imp.root-commit`

### REQ-IMP-006 — Provenance is recorded
Import **shall** record source format, source schema version, source filename, content hash of the
source, and import timestamp in the model's passthrough bag so provenance survives re-export.

- **AC** Re-exporting to the source format emits the recorded provenance, namespaced.
- **Test:** `imp.provenance-recorded`

### REQ-IMP-007 — Import never merges silently
Import **shall** ask whether to create a new model or target an existing one, and **shall not**
merge into an existing model without an explicit choice.

- **AC** Importing a model whose `modelId` matches an existing entry prompts rather than merging.
- **Test:** `imp.no-silent-merge`

### REQ-IMP-008 — Imported HTML is never executed
When importing an HTML file, the application **shall** extract the embedded JSON by parsing text and
**shall not** execute, evaluate, or insert any part of the incoming document.

- **AC** A malicious HTML import with a script in its data block does not execute.
- **AC** The extraction path uses no `innerHTML` and no dynamic script insertion.
- **Test:** `sec.import-html-no-exec`

### REQ-IMP-009 — Round trips are stable
Importing a document that the application itself exported **shall** reproduce the same canonical
model, so repeated round trips do not drift.

- **AC** Two consecutive round trips produce identical canonical models.
- **Test:** `imp.roundtrip-stable`

### REQ-IMP-010 — Import reports are retained
The application **shall** retain the last import report — format detected, schema version, validation
result, warnings, entity counts — until replaced or dismissed.

- **AC** The report is reachable after the import notification is dismissed.
- **Test:** `imp.report-retained`

---

## VIEW — Presentation

### REQ-VIEW-001 — All entity types are viewable
The application **shall** present every entity type representable in the canonical model: overview and
scope, trust zones, trust boundaries, components, actors, data stores, data sets, data flows, threats,
threat personas, controls, mitigations, risks, assumptions, and diagrams.

- **AC** Each has a list view reachable from the navigation defined in `07-ui.md`.
- **AC** Absent sections render an informative empty state, not an error — both schemas make most
  sections optional.
- **Test:** `view.entity-coverage`, `view.empty-states`

### REQ-VIEW-002 — Tables support sorting, filtering, and search
List views **shall** provide column sorting, per-column filtering where meaningful, and free-text
search.

- **AC** Sorting is stable and keyboard-operable.
- **AC** Filters compose with search rather than replacing it.
- **Test:** `view.table-sort`, `view.table-filter-search`

### REQ-VIEW-003 — Detail views show every field and its provenance
A detail view **shall** show all populated fields for an entity, including values recovered from a
passthrough bag, clearly labelled as source-format-specific.

- **AC** Fields present only in a passthrough bag are displayed and attributed to their source format.
- **Test:** `view.detail-passthrough-visible`

### REQ-VIEW-004 — Diagrams from coordinate data render natively
Where the model carries diagram geometry (OTM representations), the application **shall** render it as
SVG with zones, components, and flows positioned from their recorded coordinates.

- **AC** Trust zones render as labelled containers with contained components inside them.
- **AC** Data flows render as edges between source and destination, with bidirectional flows
  distinguished.
- **Test:** `view.diagram-coordinates`

### REQ-VIEW-005 — Diagram source text is rendered per type
For diagrams stored as source text (TML), the application **shall**: render `svg` type after
sanitization; render `mermaid` type by lazily loading Mermaid from the pinned CDN on first use; and
display `graphviz` and `plantuml` as source text with a copy action.

- **AC** Mermaid is not fetched unless a Mermaid diagram is actually displayed.
- **AC** Failing to load Mermaid degrades to source text with an explanation, not an error page.
- **AC** Graphviz and PlantUML are shown as source without attempting to render.
- **Test:** `view.diagram-mermaid-lazy`, `view.diagram-fallback-source`

### REQ-VIEW-006 — Risk is presented in the model's own terms
The application **shall** render the 5×5 likelihood/impact risk matrix with banding for models that
carry TML risks, and CIA ratings, trust-zone ratings, and mitigation risk-reduction for models that
carry OTM data.

- **AC** Each presentation appears only when the model actually holds that data.
- **Test:** `view.risk-matrix`, `view.risk-otm-ratings`

### REQ-VIEW-007 — Unresolved references are visible
Entities with unresolved references (REQ-IMP-004) **shall** be marked in both list and detail views.

- **AC** A warning indicator appears with an explanation of the missing target.
- **Test:** `view.unresolved-visible`

### REQ-VIEW-008 — Read-only mode
The application **shall** provide a read-only mode that disables all mutation, used for unknown
container versions, failed integrity checks, and storage-unavailable operation where the user chooses
not to proceed.

- **AC** In read-only mode, no edit affordance is reachable and export still works.
- **Test:** `view.read-only`

### REQ-VIEW-009 — Large models stay responsive
List and table views **shall** remain interactive for models with several thousand entities.

- **AC** Initial render of a 5,000-entity model completes within 2 seconds on a mid-range laptop.
- **AC** Scrolling and sorting do not block input for more than 100 ms.
- **Test:** `perf.large-model` (benchmark, reported not asserted in CI)

---

## EDIT — Mutation

### REQ-EDIT-001 — Full CRUD on every entity type
The application **shall** support creating, reading, updating, and deleting every entity type in the
canonical model.

- **AC** Each entity type has create, edit, and delete affordances.
- **Test:** `edit.crud-coverage` (parameterised over entity types)

### REQ-EDIT-002 — Field validation
Forms **shall** validate against the canonical model's constraints — required fields, enumerations,
score ranges, and identifier formats — before accepting a change.

- **AC** Enumerated fields offer only valid values.
- **AC** Invalid input is rejected at the field with an accessible message.
- **Test:** `edit.validation`

### REQ-EDIT-003 — References are maintained by the UI
Fields that reference other entities **shall** be presented as selections over existing entities
rather than free text, so referential integrity is maintained by construction.

- **AC** Deleting a referenced entity prompts for how to handle the reference.
- **AC** No edit path can create a dangling reference.
- **Test:** `edit.reference-selects`, `edit.delete-referenced-entity`

### REQ-EDIT-004 — Structural edits preserve the model
Adding or removing zones, components, or flows **shall** update dependent references and **shall**
preserve entity identity and history.

- **AC** Removing a component that is the source of a flow prompts before orphaning the flow.
- **AC** Entity ids are stable across edits.
- **Test:** `edit.structural-integrity`

### REQ-EDIT-005 — Dirty state is always visible
The application **shall** indicate when the working copy differs from the head commit, and **shall**
warn before navigating away or closing.

- **AC** The indicator appears within one interaction of a change.
- **AC** A `beforeunload` warning appears when leaving with uncommitted changes.
- **Test:** `edit.dirty-indicator`, `edit.beforeunload`

### REQ-EDIT-006 — Commit dialog
Committing **shall** present a dialog showing the author, a required message, and a summary of what
changed since the head.

- **AC** The change summary counts entities added, modified, and removed.
- **Test:** `edit.commit-dialog`

### REQ-EDIT-007 — Discard changes
The application **shall** allow discarding the working copy in favour of the head commit, behind a
confirmation.

- **AC** Discarding restores the head exactly.
- **Test:** `edit.discard`

### REQ-EDIT-008 — Bulk operations
List views **shall** support multi-select with bulk delete and bulk field update on selected entities.

- **AC** Bulk update reports per-entity validation failures without aborting the whole operation.
- **Test:** `edit.bulk-update`, `edit.bulk-partial-failure`

### REQ-EDIT-009 — Passthrough data is preserved through edits
Editing an entity **shall not** discard its passthrough bag. Fields the UI does not surface **shall**
survive an edit.

- **AC** Editing a title leaves unrelated passthrough fields intact.
- **Test:** `edit.passthrough-preserved`

### REQ-EDIT-010 — Deletion is recoverable until commit
Deleted entities **shall** be recoverable via undo until the change is committed.

- **AC** Undo restores deleted entities with their identifiers and references.
- **Test:** `edit.delete-undo`

---

## UI — Carbon shell and navigation

### REQ-UI-001 — Carbon UI Shell
The application **shall** use Carbon's UI Shell: a fixed 48px header, a top tab row, a left side nav,
and a content region, using Carbon's documented class structure.

- **AC** Header, tabs, side nav, and content use `cds--` classes from the pinned Carbon stylesheet.
- **AC** The layout renders correctly with the Carbon stylesheet loaded from the CDN.
- **Test:** `ui.shell-structure`, `e2e.ui.shell`

### REQ-UI-002 — Nine top-level tabs
The application **shall** present nine top-level tabs: Overview, Architecture, Data, Flows, Threats,
Controls, Risk, History, Settings.

- **AC** Tabs are keyboard-navigable with correct ARIA roles and roving tabindex.
- **AC** Tab state survives a reload.
- **Test:** `ui.tabs`, `ui.tabs-keyboard`

### REQ-UI-003 — Side nav carries per-tab sub-sections
The left side nav **shall** present the sub-sections or functions of the **active** tab, at a single
level of nesting, at 16rem wide, collapsing to a 3rem rail.

- **AC** The nav contents change when the active tab changes.
- **AC** Only one level of nesting is used — Carbon's side nav supports no third tier.
- **AC** The collapsed/expanded state persists across reloads.
- **Test:** `ui.sidenav-per-tab`, `ui.sidenav-collapse-persist`

### REQ-UI-004 — Model switcher and delete live in the header
The header **shall** host the model switcher, listing registry entries plus the embedded model, and
**shall** provide delete for stored models.

- **AC** The switcher shows which entry is the embedded model.
- **AC** Delete is unavailable for the embedded-only entry and explains why.
- **Test:** `ui.model-switcher`, `ui.delete-affordance`

### REQ-UI-005 — Theme switching
The application **shall** offer Carbon's four prebuilt themes (White, Gray 10, Gray 90, Gray 100) via
the documented theme classes, and **shall** persist the choice.

- **AC** All four themes apply without custom stylesheet compilation.
- **AC** The choice persists across reloads; first-run default follows the OS preference.
- **Test:** `ui.theme-switch`, `ui.theme-persist`

### REQ-UI-006 — Responsive layout
Layout **shall** follow Carbon's 2× grid, with defined behaviour at each breakpoint and a usable
narrow-screen presentation.

- **AC** At the smallest breakpoint the side nav collapses and the tab row scrolls.
- **AC** No horizontal page overflow at 320px width.
- **Test:** `e2e.ui.responsive`

### REQ-UI-007 — Accessibility
The application **shall** target WCAG 2.1 AA, preserving the semantics of Carbon's markup.

- **AC** All interactive elements are keyboard reachable in a logical order.
- **AC** Modals and menus trap focus and restore it on close.
- **AC** Live regions announce commit, reconcile, import, and error outcomes.
- **AC** Colour is never the sole carrier of meaning — including risk bands.
- **Test:** `a11y.axe-core`, `a11y.focus-management`, `a11y.keyboard-only`

### REQ-UI-008 — No inline event handlers
The application **shall not** use inline event-handler attributes. All handlers **shall** be attached
programmatically, as required by the content-security policy.

- **AC** No `on*=` attribute appears in the artifact or in exported files.
- **Test:** `sec.no-inline-handlers` (static check)

### REQ-UI-009 — Notifications for outcomes
The application **shall** report the outcome of commits, reconciles, imports, exports, and errors
using Carbon notifications, with errors also persisted somewhere retrievable.

- **AC** Errors are not dismissible-into-oblivion; the last error remains retrievable.
- **Test:** `ui.notifications`

### REQ-UI-010 — Behaviour inventory is documented
Because Carbon supplies no JavaScript, the project **shall** document every hand-written component
behaviour and the Carbon class contract it relies on.

- **AC** `07-ui.md` lists each wired component with its state classes.
- **Test:** `docs.behaviour-inventory` (manual review)

### REQ-UI-011 — No framework runtime
The application **shall not** load React, a SPA framework, or any component runtime. Rendering
**shall** be hand-written against the DOM.

- **AC** The artifact loads no framework script.
- **Test:** `shell.no-framework`

### REQ-UI-012 — Carbon version is pinned and verified
The Carbon stylesheet **shall** be referenced at an exact version with a subresource-integrity hash
and `crossorigin` attribute.

- **AC** The URL contains an exact version, not a range or `latest`.
- **AC** Tampering with the stylesheet causes it to be rejected by the browser.
- **Test:** `sec.sri-pinned`

---

## SEC — Security

### REQ-SEC-001 — Content-security policy with a pinned script hash
Exported and distributed files **shall** carry a CSP delivered by `<meta http-equiv>`, placed before
any script it governs, allowing only: the hash-pinned inline application script, the pinned Carbon
stylesheet origin, the IBM Plex font origin, `data:` images, and the Mermaid origin when needed.
Nothing else **shall** be permitted.

- **AC** Modifying the application script in an exported file causes the browser to refuse it.
- **AC** The policy appears before the first script element.
- **AC** Adding an unexpected remote script is blocked.
- **Test:** `sec.csp-hash-pins-script`, `e2e.csp.tampered-script-blocked`

### REQ-SEC-002 — No dynamic code execution
The application **shall not** use `eval`, `new Function`, `setTimeout`/`setInterval` with string
arguments, or dynamic `<script>` insertion.

- **AC** Static analysis finds no occurrence of these in the artifact.
- **Test:** `sec.no-dynamic-exec` (static check)

### REQ-SEC-003 — All model text is escaped on render
Every value originating from a model **shall** be inserted as text, never as markup. No code path
**shall** pass untrusted data to `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or a `javascript:`
URL.

- **AC** A model containing `<img src=x onerror=alert(1)>` in any field renders as literal text.
- **AC** No `javascript:` URL survives into an `href`.
- **Test:** `sec.xss-model-fields` (parameterised over entity fields and URL fields)

### REQ-SEC-004 — Untrusted SVG is sanitized or sandboxed
SVG originating from an imported model **shall** be sanitized to remove scripting, event handlers,
and external references, or rendered in a sandboxed iframe without `allow-scripts`.

- **AC** An imported SVG containing a script does not execute.
- **AC** An imported SVG referencing an external resource does not fetch it.
- **Test:** `sec.svg-sanitized`

### REQ-SEC-005 — Foreign application versions are flagged
When an opened file's embedded application hash does not match a known build, the application
**shall** warn before treating the file as trusted, and **shall** default to read-only.

- **AC** The warning names the mismatch and explains the risk.
- **AC** Continuing to edit requires an explicit acknowledgement.
- **Test:** `sec.unknown-app-version`

### REQ-SEC-006 — The application states its own threat model
The project **shall** document that an exported threat model is executable HTML, that opening one
runs code with access to the origin's storage, and what the mitigations do and do not cover.

- **AC** `08-security.md` states the residual risk plainly, including the Chrome shared-origin case.
- **Test:** `docs.threat-model` (manual review)

### REQ-SEC-007 — Imported content is untrusted regardless of appearance
A file that appears to be a native export **shall** still be parsed as untrusted input, validated, and
subject to REQ-SEC-003 and REQ-SEC-004.

- **AC** No import path skips escaping on the grounds that the source looked native.
- **Test:** `sec.import-always-untrusted`

### REQ-SEC-008 — No telemetry
The application **shall not** collect, store, or transmit usage data, and **shall** make no network
request not enumerated in REQ-SHELL-007.

- **AC** Network inspection during a full exercise shows only the enumerated origins.
- **Test:** `sec.no-telemetry`

---

## Requirement count

| Domain | Count |
|---|---|
| `SHELL` | 7 |
| `DATA` | 6 |
| `VCS` | 15 |
| `SYNC` | 8 |
| `STORE` | 8 |
| `EXP` | 13 |
| `IMP` | 10 |
| `VIEW` | 9 |
| `EDIT` | 10 |
| `UI` | 12 |
| `SEC` | 8 |
| **Total** | **106** |

Open items that affect requirements are tracked in `10-open-questions.md`.
