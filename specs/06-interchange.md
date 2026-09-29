# 06 — Interchange

Mapping between the canonical model and the two interchange formats, in both directions.

This is the largest source of subtle bugs in the project, because the two formats disagree not just in
naming but in **structure**, and because a mapping that looks obviously correct field-by-field will
quietly drop data.

Related: `03-data-model.md` (canonical model, passthrough bags), ADR-0004 (neutral superset).

---

## 1. Formats, versions, and sources

| | OTM | TML |
|---|---|---|
| Name | Open Threat Model (IriusRisk) | OWASP Threat Model Library Schema |
| Version targeted | `0.2.0` | `1.0.2` |
| JSON Schema draft | draft-07 | 2020-12 |
| Vendored from | `iriusrisk/OpenThreatModel` `main` | `OWASP/www-project-threat-model-library` `main` |
| Casing | `camelCase` | `snake_case` |
| Identifier rule | Unconstrained string | `^[0-9a-z-]+$` |
| Referential integrity | Not enforced | Not enforced |
| `additionalProperties` | Unrestricted everywhere | `false` on most objects |
| Extension mechanism | Free-form `attributes` maps | Namespaced `extensions` |
| Diagram model | Coordinates (`position`, `size`) | Source text (`graphviz`/`mermaid`/`plantuml`/`svg`) |
| Document revision field | **None** | **None** |

Two consequences worth stating up front:

**Vendored from `main`, not the release tag.** The OTM `0.2.0` release tag places `required` directly
on array schemas with no `items` wrapper — invalid draft-07, so per-item requirements are silently
unenforced. `main` corrects this. Validating against the tag would make the app accept documents it
should reject.

**Neither format has any notion of revision.** All history lives in our layer. Provenance we add on
import is written into the format's extension mechanism (§9) so it survives re-export, but it is our
data living in their container, and a third-party tool may drop it.

---

## 2. Detection

Structural markers, never the filename alone (REQ-IMP-002).

| Format | Marker |
|---|---|
| Container (native) | `tmvFormat` **and** `history` at root |
| Exported HTML | `<!doctype html` / `<html` present; extract `#tmv-data`, then re-detect the JSON |
| TML | `$schema` contains `threat-model-library`, **or** `trust_zones` **and** `symbolic_name` present |
| OTM | `otmVersion` present, **or** `trustZones` **and** `dataflows` present |
| Unknown | None of the above |

Ambiguity is resolved in the order listed — container first, because a native export could
conceivably carry an `otmVersion` in a passthrough bag, and misreading it as OTM would discard the
history.

Detection of **HTML is not parsing of HTML**. The embedded JSON is extracted by locating the data
block as text (REQ-IMP-008). The incoming document is never inserted into the DOM, never parsed as
markup, and never executed.

---

## 3. Validation

Validation is **vendored-schema-based and offline** (REQ-IMP-003): the build inlines copies of both
schemas (§`02-architecture.md` §3), so no network fetch is needed and a schema update is a deliberate
vendoring act rather than something that changes underfoot.

### The validator

JSON Schema validation needs a validator, and this is an unresolved dependency question.

| Option | Assessment |
|---|---|
| **A.** Ajv from CDN | Consistent with the Carbon decision, but adds a second external dependency, a second CSP origin, and a second offline failure mode — for a feature used only on import |
| **B.** Hand-written general-purpose validator | Highest risk. Draft-07 and 2020-12 differ meaningfully, and a subtly wrong validator is worse than none because it produces confident wrong answers |
| **C.** Format-specific hand-written validators | ~200 lines each, covering exactly the keywords these two schemas use, with a dev-time cross-check against Ajv |
| **D.** No schema validation; structural checks only | Simplest, but loses the ability to tell a user precisely what is wrong with their file |

**Recommendation: C.** Validate against the *documented subset* of JSON Schema the two schemas
actually use (`type`, `required`, `properties`, `items`, `enum`, `pattern`, `patternProperties`,
`oneOf`, `$ref`, `additionalProperties`, `const`), derived from the vendored schemas rather than
guessed at. Then, **in the test suite only**, cross-check our validator's verdict against Ajv over a
corpus of real documents (the OTM `EXAMPLE.json`, the TML reference models, plus generated
violations). If the two ever disagree, the test fails.

That gives a dependency-free runtime and a validator that is *proven* to agree with a reference
implementation, which B cannot offer at comparable effort.

> This is a real decision with a cost either way and is carried in `10-open-questions.md`. C is
> specified here as the default; adopting A instead is a small change to `build.mjs` and one CSP
> origin.

### Validation outcome

| Tier | Condition | Behaviour |
|---|---|---|
| **Blocked** | Not parseable as JSON | Cannot proceed |
| **Blocked by default** | Schema violations | Report failing paths; offer explicit "Import anyway (limited)" (§ REQ-IMP-003) |
| **Warning** | Referential integrity problems | Import; mark references unresolved (REQ-IMP-004) |
| **Warning** | Values outside a canonical vocabulary | Import verbatim; flag for the user |

Referential integrity is checked by us because neither schema enforces it (REQ-IMP-004). A dangling
`dataflows[].source`, an `assets.processed` naming an absent asset, a `control.threats` naming an
absent threat — all validate fine upstream and all produce a broken model. Every reference type in
both directions is enumerated in §5 and §6 so the checker is complete rather than best-effort.

---

## 4. Identifiers

Canonical ids are opaque and stable; each format needs its own id discipline
(`03-data-model.md` §1).

**OTM.** Ids are unconstrained strings. Export writes the canonical id verbatim. No derivation, no
collisions possible, and OTM import takes `id` directly. This direction is safe by construction.

**TML.** Symbolic names are `^[0-9a-z-]+$` — lowercase alphanumerics and hyphens. Canonical ids may be
UUIDs, may contain uppercase, underscores, or Unicode, and are therefore frequently invalid.

Derivation, which must be **deterministic** so repeated exports are byte-identical (REQ-EXP-005):

```
slug(entity):
  base = lowercase(canonical id) → transliterate to ASCII → replace [^a-z0-9]+ with "-"
         → trim leading/trailing "-" → truncate to 64 chars
  if base is empty: base = entity-type name (e.g. "component")
  if base taken:
      suffix = 2, 3, ...  until free
      base = base + "-" + suffix
```

**Collision order must be stable.** Candidates are processed in a fixed order — sorted by canonical
id — so the same model always yields the same assignment. Processing them in iteration order would
make the export depend on array order, and a re-export after a harmless reordering would rename
entities, breaking any external references to them.

The slug map is stored in the model's `x.tml.symbolicNames` (id → slug) and reused on subsequent
exports, so a slug stays stable even if an entity is renamed. Regenerating on every export would
rename entities whenever a title changed, which for a shared model is a breaking change.

**TML import** is the easy direction: the symbolic name *is* a valid canonical id, so it is used
directly and `slug` is set to the same value.

---

## 5. OTM mapping

### 5.1 Import — OTM → canonical

| OTM | Canonical | Notes |
|---|---|---|
| `otmVersion` | `x.otm.otmVersion` | Recorded, not interpreted |
| `project.name` | `name` | |
| `project.id` | `modelId` **or** `x.otm.projectId` | Used as `modelId` when it parses as a UUID; otherwise a UUID is generated and the original is preserved |
| `project.description` | `description` | |
| `project.owner`, `ownerContact`, `tags` | `metadata.*` | Direct |
| `project.attributes` | `x.otm.attributes` | Verbatim, minus our own provenance keys |
| any unrecognised `project` key | `x.otm.projectExtras` | |
| `trustZones[]` | `trustZones[]` | `id`→`id`, `name`→`name`, `type`→`type`, `risk.trustRating`→`trustRating`, `parent`→`parentId` |
| `trustZones[].representations[]` | `representationElements[]` | Hoisted to model level; `ownerId`/`ownerType` set from the containing zone |
| `assets[]` | `assets[]` | `risk.{confidentiality,integrity,availability}`→ same names; `risk.comment`→`riskComment` |
| `components[]` | `components[]` | `type`→`type`, `parent`→`parentId`, `tags`→`tags` |
| `components[].assets.processed[]` | `assets[].processedByIds[]` | **Inverted**: OTM stores the relation on the component, canonical on the asset |
| `components[].assets.stored[]` | `assets[].storedByIds[]` | Inverted, as above |
| `components[].threats[]` | `threatApplications[]` | **Flattened** out of the component; `targetType: "component"` |
| `dataflows[]` | `dataFlows[]` | `source`/`destination`→ ids with `sourceType`/`destinationType` `"component"`; `bidirectional`, `tags`, `assets`→`assetIds` |
| `dataflows[].threats[]` | `threatApplications[]` | Flattened; `targetType: "dataFlow"` |
| `threats[]` | `threats[]` | `id`→`id`, `name`→`name`, `categories`→`categories`, `cwes`→`cwes`, `risk.*`→`likelihood`/`impact`/comments |
| `mitigations[]` | `controls[]` | `riskReduction`→`riskReduction`. `status`/`priority` left unset |
| threat/mitigation instance `state` | `threatApplications[].state`, `controlStates[].state` | **Kept verbatim**; may be outside our vocabulary (`03-data-model.md` §4.10) |
| `representations[]` | `representations[]` | `size`→`width`/`height`, `repository.url`→`repositoryUrl` |
| `representationElement` on components/zones | `representationElements[]` | Hoisted; `file`/`line`/`codeSnippet` kept |

Two inversions matter most: OTM puts asset relationships on the **component** and threat instances
**inside** the component. Both flatten during import. Getting either backwards produces a model that
looks plausible and is wrong.

### 5.2 Export — canonical → OTM

Required-field handling follows the synthesis rule in §8.

| Canonical | OTM | Handling |
|---|---|---|
| `name` | `project.name` | Required; blocked if empty |
| `modelId` | `project.id` | Direct |
| `metadata.*` | `project.owner`/`ownerContact`/`tags` | Direct |
| `x.otm.attributes` | `project.attributes` | **Re-emitted** (REQ-EXP-004) |
| `trustZones[]` | `trustZones[]` | `trustRating` **required** — synthesized `100` if unset, disclosed |
| `assets[]` | `assets[]` | `risk.{c,i,a}` **required** — synthesized `0`, disclosed |
| `components[]` | `components[]` | `type` **required** — synthesized `"unknown"`, disclosed. `parent` **required** — synthesized, see below |
| `components[].parentId` | `parent` | If unset, derived from `trustZoneId`; if that is also unset, a placeholder zone is created and disclosed |
| `assets[].processedByIds` | `components[].assets.processed` | **Inverted back** |
| `threatApplications[]` | nested `threats[]` | **Re-nested** into the target component or data flow |
| `threats[]` | `threats[]` | `risk.likelihood`/`impact` **required** — synthesized `50`, disclosed |
| `controls[]` | `mitigations[]` | `riskReduction` **required** — synthesized `0`, disclosed |
| `representations[]`, `representationElements[]` | `representations[]`, `zones[].representations[]`, `components[].representations[]` | Elements re-nested under their owner |
| `otmVersion` | `otmVersion` | `"0.2.0"` — the targeted schema version |

`dataflows[].source`/`destination` **cannot** be synthesized: a flow with no endpoints is
meaningless. Missing endpoints **block** export with a per-flow fix instruction (§8).

### 5.3 Dropped on OTM export

Reported by REQ-EXP-003. No OTM home exists for these:

`trustBoundaries` (all fields) · `actors` (all fields) · `dataStores` (distinct type) ·
`dataSets` (all fields) · `threatPersonas` · `assumptions` · `risks` (matrix, score, level) ·
`mitigationPlans` · `diagrams` (source text) · `components[].repoLink` ·
`dataFlows[].hasSensitiveData`, `.encrypted`, `.sourceType`/`.destinationType` ·
`threats[].weaknesses` (structured), `.attackMechanisms`, `.personaId`, `.event`, `.sources` ·
`controls[].status`, `.priority`, `.trustBoundary`, `.threatIds` ·
`metadata.frozen`, `.releasedAt`, `.reviewedAt`, `.productReleaseDate`, `.repoLink`, `.releaseDocsLink`, `.version`

`actors` and `dataStores` deserve a note: they are not lost, they can be **folded** into `components`
with a synthesized `type` (`"actor"`, `"database"`), which is exactly how OTM models them. That is a
better outcome than dropping them, so it is offered as an explicit export option — *"Represent actors
and data stores as components (recommended)"* — rather than applied silently. The reverse fold happens
on import only if the user asks, because a `component` with `type: "database"` might genuinely be a
component.

---

## 6. TML mapping

### 6.1 Import — TML → canonical

| TML | Canonical | Notes |
|---|---|---|
| `$schema` | `x.tml.$schema` | Recorded |
| `version` | `metadata.version` | |
| `scope` | `scope` | Direct; enum values map 1:1 |
| `description` | `description` | |
| `frozen`, `released_at`, `product_release_date`, `reviewed_at`, `repo_link`, `release_docs_link` | `metadata.*` | Renamed to camelCase |
| `trust_zones[]` | `trustZones[]` | `symbolic_name`→`id` and `slug` |
| `trust_boundaries[]` | `trustBoundaries[]` | `trust_zone_a`/`_b` → `zoneAId`/`zoneBId` **via the symbolic name → id map** |
| `actors[]` | `actors[]` | `type`, `trust_zone`→`trustZoneId`, `permissions` |
| `components[]` | `components[]` | `trust_zone`→`trustZoneId`, `parent_component`→`parentId`, `repo_link`→`repoLink` |
| `data_stores[]` | `dataStores[]` | `type` enum, `vendor`, `product` |
| `data_sets[]` | `dataSets[]` | `placements[].data_store`→`placements[].dataStoreId`; `data_sensitivity`→`dataSensitivity` |
| `data_flows[]` | `dataFlows[]` | `source{type,object}`→`sourceId`+`sourceType`; `has_sensitive_data`, `encrypted` |
| `threats[]` | `threats[]` + `threatApplications[]` | `components_affected[]` becomes one application per component; `threat_persona`→`personaId`; `event`, `sources`, `attack_mechanisms`→`attackMechanisms`, `weaknesses` |
| `threat_personas[]` | `threatPersonas[]` | Direct |
| `controls[]` | `controls[]` | `threats`→`threatIds`, `status`, `priority`, `trust_boundary`→`trustBoundary` |
| `risks[]` | `risks[]` | `threats`→`threatIds`; `score`/`level` **stored as given**, not recomputed |
| `mitigation_plans[]` | `mitigationPlans[]` | |
| `assumptions[]` | `assumptions[]` | `validity` direct |
| `diagrams[]` | `diagrams[]` | `type`, `source`, `link` |
| `extensions` | `x.tml.extensions` | Verbatim |

The symbolic-name → id map is built **before** any reference is resolved. References appear before
their targets in document order in practice, and resolving in a single pass produces spurious
dangling-reference warnings.

### 6.2 Export — canonical → TML

TML requires far more than OTM, and its requirements fall into both §8 categories.

**Always emitted, even when empty** — TML's nine required root arrays:
`version`, `scope`, `trust_zones`, `trust_boundaries`, `actors`, `components`, `data_stores`,
`data_sets`, `data_flows`. Emitting `[]` for an unused section is valid and is what P3 in
`03-data-model.md` exists to make trivial.

| Canonical | TML | Handling |
|---|---|---|
| — | `$schema` | Emitted as a value matching the schema's own pattern: the OWASP repository blob URL with a `v<major>.<minor>.<patch>` segment. **A self-hosted or `raw.githubusercontent.com` URL fails validation** |
| `metadata.version` | `version` | Required; defaulted to `"1.0"` if unset, disclosed |
| `scope.*` | `scope.*` | All six fields **required** — synthesized from documented defaults, each disclosed |
| `id` (every entity) | `symbolic_name` | Slugified via §4's stable map |
| `trustZones[]` | `trust_zones[]` | `trustRating` dropped (no TML equivalent) |
| `threatApplications[]` | `threats[].components_affected[]` | Regrouped per threat. **`state` and per-application control states are dropped** |
| `controls[].threatIds` | `controls[].threats` | **Required.** A control with no threats **blocks** export — see §8 |
| `controls[].status`, `.priority` | same | **Required** — synthesized (`assumed`, `none`) when unset, disclosed |
| `controls[].riskReduction` | — | Dropped |
| `risks[].threatIds` | `risks[].threats` | **Required.** A risk with no threats **blocks** export |
| `risks[].{likelihood,impact,impactDescription,score,level}` | same | All required; enums enforced by the editor |
| `threats[].personaId` | `threats[].threat_persona` | **Required.** A threat with no persona **blocks** export |
| `threats[].sources` | `threats[].sources` | **Required**, non-empty — synthesized `["adversary"]` when unset, disclosed |
| `threats[].event`, `.description`, `.title` | same | Required strings; empty string is emitted and disclosed |
| `threats[].cwes[]` | `threats[].weaknesses[]` | **Lossy**: `"CWE-89"` → `{cweId: 89}`; unparseable entries reported and dropped |
| `assets[]`, `representations[]`, `representationElements[]` | — | Dropped entirely — no TML equivalent |
| `diagrams[]` | `diagrams[]` | Direct |
| `x.tml.extensions` | `extensions` | Re-emitted |

### 6.3 Dropped on TML export

`assets` (CIA scores) · `trustZones[].trustRating` · `trustZones[].parentId` (nesting) ·
`components[].type`, `.tags` · `dataFlows[].bidirectional`, `.tags`, `.assetIds` ·
`threats[].categories`, `.cwes` (as free strings), `.likelihood`, `.impact`, `.likelihoodComment`,
`.impactComment` · `threatApplications[].state`, `.controlStates` ·
`controls[].riskReduction` · `representations`, `representationElements` ·
`metadata.owner`, `.ownerContact`, `.tags` · `metadata.contributors`

Note that **risk is expressed differently, not lost**: OTM's per-threat `likelihood`/`impact` inputs
and TML's separate `risks[]` objects with a 5×5 matrix are the same information in incompatible
shapes. Export to TML does not invent `risks[]` entries from OTM threat risks, because choosing the
matrix banding would be the application making an assessment the author never made. The threat's
values are dropped, disclosed, and the export-readiness panel suggests creating risks explicitly.

---

## 7. The lossiness ledger

One table, both directions, for REQ-EXP-003. The export dialog renders this filtered to the actual
model.

| Concept | OTM | TML | Lost exporting to |
|---|---|---|---|
| Trust zone rating | `trustRating` 0–100 | — | TML |
| Trust zone nesting | `parent` | — | TML |
| Trust boundary (first-class) | — | ✔ + auth/access-control enums | OTM |
| Actor (first-class) | — | ✔ + type enum | OTM *(foldable into components)* |
| Data store (distinct type) | — | ✔ + storage enum | OTM *(foldable)* |
| Data set | — | ✔ + sensitivity, placements | OTM |
| Asset CIA scores | ✔ | — | TML |
| Flow directionality | `bidirectional` | — | TML |
| Flow encryption / sensitivity | — | ✔ | OTM |
| Threat persona | — | ✔ + skill/access/intent | OTM |
| Threat categories (free text) | ✔ | — | TML |
| CWE | `cwes` strings | `weaknesses` objects | *lossy transform*, both |
| CAPEC | — | ✔ | OTM |
| Assumption | — | ✔ + validity | OTM |
| Risk matrix (score, level) | — | ✔ | OTM |
| Threat risk inputs | `risk.likelihood`/`impact` | — | TML |
| Mitigation risk reduction | `riskReduction` | — | TML |
| Control status / priority | — | ✔ + enums | OTM |
| Threat application state | ✔ free-form | — | TML |
| Diagram coordinates | ✔ | — | TML |
| Diagram source text | — | ✔ | OTM |
| Lifecycle (`frozen`, dates) | — | ✔ | OTM |
| Project metadata (owner, tags) | ✔ | — | TML |

Reading the table as a whole: **neither direction is close to lossless**, and the losses are
concentrated in exactly the concepts each format was designed around. OTM is an architecture-and-risk
format; TML is an architecture-and-adversary format. A threat model that uses the strengths of one
will lose them in the other. The application's job is to make that visible before the user commits to
the export, not to paper over it.

---

## 8. Synthesis versus blocking

TML and OTM both impose required fields the canonical model does not. Two different responses, and
choosing wrongly is a correctness bug:

> **Synthesize** when a neutral default is honest and the user can see it was filled in.
> **Block** when any value the app could invent would be a false statement.

| Situation | Response | Why |
|---|---|---|
| `trustRating` unset, exporting to OTM | **Synthesize `100`**, disclose | A zone's rating is a preference; a disclosed default is recoverable |
| Asset CIA unset | **Synthesize `0`**, disclose | `0` means "no assessed impact", honestly conservative |
| Component `type` unset | **Synthesize `"unknown"`**, disclose | An open string; `"unknown"` states the truth |
| Threat `likelihood`/`impact` unset | **Synthesize `50`**, disclose | Midpoint, visible, fixable |
| Control `riskReduction` unset | **Synthesize `0`**, disclose | Claims no reduction, which is the safe direction |
| Control `status`/`priority` unset | **Synthesize `assumed`/`none`**, disclose | Matches the format's own defaults |
| `threat.sources` empty | **Synthesize `["adversary"]`**, disclose | Enum has no neutral member; the disclosure carries the caveat |
| Required strings (`event`, `title`) | **Emit `""`**, disclose | Empty is visibly empty |
| **Flow `source`/`destination` missing** | **Block** | A flow with no endpoints asserts nothing |
| **Control with no `threatIds`** | **Block** | Inventing a threat reference fabricates an assessment |
| **Risk with no `threatIds`** | **Block** | Same |
| **Threat with no `personaId`** | **Block** | Inventing an adversary attributes intent the author never asserted |
| **Reference to a deleted entity** | **Block** | Exporting a dangling reference produces a broken document in someone else's tool |

Blocked exports are not errors — they are a **to-do list**. Each names the entity, the missing field,
and the fix. The export-readiness view (`03-data-model.md` §6) shows the same list continuously, so
the user learns about it while editing rather than at export time.

**Disclosure is not optional.** Every synthesized value appears in the export report, so a recipient
can tell what the exporter's tool inferred from what the author actually said. An undisclosed
synthesis is indistinguishable from data loss.

---

## 9. Provenance

Recorded on import (REQ-IMP-006) so a model can describe where it came from, and re-emitted on export
(REQ-EXP-004) so it survives a round trip.

| Recorded | Example |
|---|---|
| Source format and schema version | `otm/0.2.0`, `tml/1.0.2` |
| Source filename | `payments.otm` |
| Content hash of the source | `sha256:…` |
| Import timestamp | `2026-09-28T12:00:00Z` |
| Tool and version | `threat-model-viewport/0.1.0` |

**OTM:** written to `project.attributes` under `tmv:…` keys. `attributes` is a free-form map with no
inner schema, so this is safe and tolerated by any conformant reader.

**TML:** written to `extensions`. This is where a real constraint bites — TML's `extensions` keys must
match a pattern of the form `domain.tld/extension-name`, so provenance cannot be written under an
invented key without squatting on a domain the project does not own.

> **Open question.** The project needs a stable domain (or a documented placeholder) for its TML
> extension namespace. Until one is chosen, the TML export writes provenance only when a domain is
> configured in Settings, and otherwise omits it and says so in the export report. See
> `10-open-questions.md`.

---

## 10. Round-trip guarantees

What the application promises, and what it does not.

| Round trip | Guarantee |
|---|---|
| OTM → canonical → OTM | **Lossless** for everything OTM can express. Unmapped keys survive in `x.otm` and are re-emitted. Synthesized required fields are the one addition |
| TML → canonical → TML | **Lossless** where TML is concerned. `$schema` and enum values are preserved; `extensions` survives |
| canonical → OTM → canonical | **Lossy** — everything in §5.3 has no OTM home |
| canonical → TML → canonical | **Lossy** — §6.3 |
| OTM → canonical → TML | **Lossy in both layers** |
| Native → canonical → native | **Fully lossless**, including history |

The asymmetry is the point: **import is lossless, export is not.** A model brought in from OTM and
sent back to OTM is unchanged; a model brought in from OTM and sent to TML loses what TML cannot say.
Only the native container round-trips everything, which is the argument for using it for archival and
for passing models between instances of this app.

---

## 11. Testing

Interchange is where a bug is least visible — a dropped field produces a model that still validates
and still renders, just wrongly. Testing is therefore differential rather than example-based.

| Test | Method |
|---|---|
| `interop.otm-roundtrip` | Every vendored example + generated models: OTM → canonical → OTM, assert deep equality modulo synthesized fields |
| `interop.tml-roundtrip` | As above for TML |
| `interop.validator-vs-ajv` | Our validator's verdict matches Ajv's across a corpus including deliberate violations (§3) |
| `interop.lossiness-complete` | Every field in the vendored schemas is classified as mapped, folded, or dropped — a field present in a schema but absent from §5.3/§6.3 fails the test |
| `interop.slug-stability` | Re-export after reordering arrays and renaming entities produces identical symbolic names |
| `interop.slug-collisions` | Entities whose slugs collide get distinct, stable ids |
| `interop.referential-integrity` | Every reference type in both schemas is exercised with a dangling target and reported |
| `interop.synthesis-disclosed` | Every synthesized field appears in the export report |
| `interop.block-vs-synthesize` | Each §8 blocking case blocks; each synthesis case does not |

`interop.lossiness-complete` is the important one. It converts "did we forget a field?" from a review
question into a mechanical check against the vendored schemas, which is the only way this stays true
as the formats evolve.
