# 03 — Data Model

Two models live here, and conflating them causes bugs:

1. The **canonical model** — how the application represents a threat model internally, format-neutral.
   Edited, versioned, rendered. §2–§6.
2. The **container** — the JSON actually embedded in the HTML: canonical model **plus history**.
   §7.

Interchange formats (OTM, TML) are *mappings* to and from the canonical model, defined in
`06-interchange.md`. Related: ADR-0004 (neutral superset), ADR-0005 (history storage).

---

## 1. Design principles

**P1 — Neutral superset, never a lowest common denominator.** The canonical model represents the
union of what OTM and TML can express. Where only one format has a concept, the concept still exists
canonically; the other format's export reports it as unrepresentable.

**P2 — Nothing is dropped on import.** Every field the canonical model does not natively represent is
preserved in a **passthrough bag**. Round trips are therefore lossless *when the target format can
express the same thing* — the loss is the format's, not the application's.

**P3 — Canonical requires almost nothing.** Only an id and a name/title. Requirements come from
*interchange*: TML demands nine root arrays and six scope fields, OTM demands per-entity `risk`
objects. Those are satisfied by **synthesis at export**, and every synthesized value is disclosed
(REQ-EXP-003). Encoding TML's requirements into the canonical model would make OTM-only models
invalid for no reason.

**P4 — Identity is stable and format-independent.** An entity's canonical id never changes because of
an export. Format-specific identifiers are derived, and the derivation is deterministic
(REQ-EXP-005).

**P5 — Structure follows the model, not the wire.** OTM nests threat instances inside components and
data flows. Canonically those are a flat join entity (§4.7), and the OTM mapper does the nesting. A
canonical model must never require a specific wire shape.

### The passthrough bag

Every entity carries an optional `x` object:

```json
"x": {
  "otm": { "attributes": { "cmdbId": "1234" }, "tags": ["external"] },
  "tml": { "extensions": { "example.com/custom": { } } }
}
```

| Rule | |
|---|---|
| Bags are keyed by source format: `otm`, `tml` | |
| A bag holds only fields the canonical model does not represent natively | |
| Bags are preserved verbatim through edits (REQ-EDIT-009) | |
| Export re-emits the matching bag (REQ-EXP-004) | |
| An empty bag is omitted, never emitted as `{}` | |
| Bags are opaque to the UI except in detail views, where they are shown and attributed (REQ-VIEW-003) | |

Bags exist at **model level** (`model.x`) and on **every entity**.

### Identifiers

| Concern | Decision |
|---|---|
| Canonical id | Opaque, stable string. UUID on creation; the source format's id when imported |
| Human-facing key | Separate optional `slug`, used for TML export |
| Uniqueness | Unique within an entity type, enforced on import and edit |
| Never reused | Deleting an entity retires its id |

TML ids are `^[0-9a-z-]+$`; OTM ids are unconstrained. On TML import the symbolic name becomes the
canonical id directly. On OTM import the OTM id becomes the canonical id, and `slug` is derived. Slug
derivation and collision handling are in `06-interchange.md` §4.

---

## 2. Model root

```json
{
  "tmvFormat": "1.0.0",
  "modelId": "8f14e45f-ea0d-4b3c-9a1e-2b3c4d5e6f70",
  "name": "Payments Platform",
  "description": "…",
  "scope": { },
  "metadata": { },
  "trustZones": [], "trustBoundaries": [], "components": [], "actors": [],
  "dataStores": [], "dataSets": [], "assets": [], "dataFlows": [],
  "threats": [], "threatPersonas": [], "threatApplications": [],
  "controls": [], "risks": [], "mitigationPlans": [], "assumptions": [],
  "diagrams": [], "representations": [],
  "x": { }
}
```

| Field | Type | Req | Notes |
|---|---|---|---|
| `tmvFormat` | string | ✔ | Canonical model format version. Distinct from the container's `$schema` and from any interchange version |
| `modelId` | uuid | ✔ | Stable across copies and exports (REQ-DATA-006) |
| `name` | string | ✔ | Model title. Editable in the app (REQ-EDIT-011) and required — a model cannot be left unnamed |
| `description` | string | | Editable in the app (REQ-EDIT-011) |
| `scope` | object | | §3.1 |
| `metadata` | object | | §3.2 |
| entity arrays | object[] | | §4 — always present, possibly empty |

All entity arrays are **always present**, defaulting to `[]`. This removes an entire class of
undefined-vs-empty bugs and makes TML's required-array rule (P3) trivial to satisfy.

---

## 3. Scope and metadata

### 3.1 `scope`

TML has a rich `scope`; OTM has none. Canonical keeps TML's shape — the richer of the two — with every
field optional.

| Field | Type | Cardinality | Values |
|---|---|---|---|
| `title` | string | 1 | |
| `description` | string | 1 | |
| `businessCriticality` | enum | 1 | `minimal` `low` `moderate` `high` `maximal` |
| `dataSensitivity` | enum[] | 0..n | `pii` `phi` `fin` `ip` `cred` `biz` `gov` `pci` `op` |
| `exposure` | enum | 1 | `internal` `external` |
| `tier` | enum | 1 | `missionCritical` `businessCritical` `important` `nonCritical` |

### 3.2 `metadata`

TML and OTM each hold different project metadata; canonical holds the union. Neither format records
timestamps of its own, and neither does this — document timestamps belong to commits, not to the
model (see `04-versioning.md`).

| Field | Type | Source | Notes |
|---|---|---|---|
| `owner` | string | OTM | |
| `ownerContact` | string | OTM | |
| `tags` | string[] | OTM | |
| `repoLink` | uri | TML | |
| `releaseDocsLink` | uri | TML | |
| `releasedAt` | date | TML | |
| `productReleaseDate` | date | TML | |
| `reviewedAt` | datetime | TML | |
| `version` | string | TML | Model's own version, `^\d+(\.\d+)*$` on export |
| `frozen` | boolean | TML | Default `false` |
| `contributors` | object[] | — | `{name, email, role?}`. Canonical-only: lets an imported model name its authors without inventing history |

---

## 4. Entities

Every entity has `id` (required), `name` (required), `description?`, `x?`. Those three columns are
omitted from the tables below to reduce noise. `Source` marks which format natively has the field:
**O** = OTM, **T** = TML, **B** = both, **—** = canonical-only (no interchange representation).

### 4.1 `trustZones`

| Field | Type | Source | Notes |
|---|---|---|---|
| `type` | string | O | OTM's zone type (`internet`, `private`, …). Unconstrained upstream |
| `trustRating` | number 0–100 | O | OTM only. **No TML equivalent** |
| `parentId` | id→trustZone\|component | O | OTM allows nesting. Canonical holds a zone-or-component reference |
| `x` | | | |

### 4.2 `trustBoundaries`

| Field | Type | Source |
|---|---|---|
| `zoneAId`, `zoneBId` | id→trustZone | T |
| `accessControlMethods` | enum[] `none` `acl` `rbac` `mac` `dac` `abac` | T |
| `authenticationMethods` | enum[] `none` `password` `otp` `challenge_response` `public_key` `token` `biometrics` `sso` `social` | T |
| `accessTokenExpires` | boolean | T |
| `accessTokenTtl` | number | T |
| `hasRefreshToken` | boolean | T |
| `refreshTokenExpires` | boolean | T |
| `refreshTokenTtl` | number | T |
| `canUserLogout`, `canSystemLogout` | boolean | T |

First-class in TML; **no OTM equivalent** — OTM models boundaries implicitly at zone edges. Canonical
keeps them first-class, and OTM export reports them as unrepresentable.

### 4.3 `components`

| Field | Type | Source | Notes |
|---|---|---|---|
| `parentId` | id→trustZone\|component | O | OTM nesting: zone or another component |
| `trustZoneId` | id→trustZone | T | TML's single-zone membership |
| `type` | string | O | Unconstrained upstream. **No TML equivalent** |
| `repoLink` | uri | T | |
| `tags` | string[] | O | |

`parentId` and `trustZoneId` are both retained. They usually agree; an OTM-imported model has only the
former, a TML-imported model only the latter. The UI shows whichever is populated, and export to each
format uses its own field.

### 4.4 `actors`

| Field | Type | Source |
|---|---|---|
| `type` | enum `system` `user` `power_user` `administrator` `engineer` `third_party` | T |
| `trustZoneId` | id→trustZone | T |
| `permissions` | string[] | T |

**TML-only.** OTM models actors as components, so OTM export reports actors as unrepresentable or
folds them into components with a disclosed conversion — see `06-interchange.md` §5.

### 4.5 `dataStores`

| Field | Type | Source |
|---|---|---|
| `type` | enum `sql` `key_value` `document` `object` `graph` `time_series` | T |
| `trustZoneId` | id→trustZone | T |
| `vendor`, `product` | string | T |

**TML-only.** OTM models stores as components with a database type.

### 4.6 `dataSets` and `assets`

These are the same idea in two formats and are kept as **two entities**, because their shapes share no
fields and merging them would produce a table where every model has half the columns empty.

**`dataSets`** (TML):

| Field | Type | Source |
|---|---|---|
| `placements` | object[] `{dataStoreId?, encrypted?, x?}` | T |
| `dataSensitivity` | enum[] (same vocabulary as `scope.dataSensitivity`) | T |
| `accessControlMethods` | enum[] (same vocabulary as trust boundaries) | T |
| `recordCount` | number | T |

**`assets`** (OTM):

| Field | Type | Source | Notes |
|---|---|---|---|
| `confidentiality`, `integrity`, `availability` | number 0–100 | O | OTM's CIA scoring. **No TML equivalent** |
| `riskComment` | string | O | |
| `processedByIds` / `storedByIds` | id[]→component | O | Derived from OTM's component-side `assets.processed`/`.stored` |

### 4.7 `dataFlows`

| Field | Type | Source | Notes |
|---|---|---|---|
| `sourceId`, `destinationId` | id→component\|actor\|dataStore | B | |
| `sourceType`, `destinationType` | enum `actor` `component` `data_store` | T | TML's typed reference; derived from the target's entity type |
| `bidirectional` | boolean | O | **No TML equivalent** — export reports it |
| `hasSensitiveData` | boolean | T | |
| `encrypted` | boolean | T | |
| `assetIds` | id[]→asset | O | |
| `tags` | string[] | O | |

### 4.8 `threats`

| Field | Type | Source | Notes |
|---|---|---|---|
| `personaId` | id→threatPersona | T | |
| `event` | string | T | |
| `sources` | enum[] `adversary` `human_error` `failure` `events_beyond_org_control` | T | |
| `categories` | string[] | O | OTM free-form (e.g. `Tampering`). **No TML equivalent** |
| `cwes` | string[] | O | OTM `CWE-89`; TML uses structured `weaknesses` |
| `weaknesses` | object[] `{cweId:int, cweTitle?}` | T | |
| `attackMechanisms` | object[] `{capecId:int, capecTitle?}` | T | **No OTM equivalent** |
| `likelihood`, `impact` | number 0–100 | O | OTM's per-threat risk inputs |
| `likelihoodComment`, `impactComment` | string | O | |

OTM's `cwes` and TML's `weaknesses` describe the same thing in different shapes. Both are kept;
`06-interchange.md` §5 defines the lossy correspondence and how a converter normalizes between them.

### 4.9 `threatPersonas`

TML-only, entirely. Fields: `isPerson`, `skillLevel` (`script_kid` `insider` `engineer`
`expert_engineer` `oc_sponsored` `state_sponsored`), `accessLevel` (`anonymous` `user` `admin`),
`maliciousIntent`, `applicabilityToOrg` (degree vocabulary). **No OTM equivalent.**

### 4.10 `threatApplications` — the join entity

This is the entity that makes a neutral model possible, and the one most likely to be got wrong.

OTM and TML relate threats to architecture completely differently:

| | OTM | TML |
|---|---|---|
| Where the link lives | Nested **inside** the component or data flow | On the **threat**, as `components_affected[]` |
| Per-link state | Yes — `state` (free-form string) | No |
| Per-link mitigations | Yes — `{mitigation, state}` | No — controls reference threats at root |

Canonical represents the link as a flat entity:

```json
{
  "id": "…",
  "threatId": "…",
  "targetType": "component" | "dataFlow",
  "targetId": "…",
  "state": "…",
  "controlStates": [ { "controlId": "…", "state": "…" } ],
  "x": { "otm": { "…unmapped instance fields…" } }
}
```

- **TML → canonical:** each entry of `threat.components_affected[]` becomes one `threatApplication`
  with `targetType: "component"`, no `state`.
- **Canonical → TML:** applications are regrouped into each threat's `components_affected[]`. States
  and per-application controls are reported as dropped.
- **OTM → canonical:** `component.threats[]` and `dataflow.threats[]` instances are flattened out.
- **Canonical → OTM:** applications are re-nested into the target component or data flow.

#### The `state` vocabulary problem

OTM types `state` as a bare string with **no enum**, and the official examples use `exposed`,
`mitigated`, `implemented`, and `required` interchangeably. Upstream has not defined the vocabulary,
so the application must, or the UI cannot offer a picker.

Canonical defines a **default vocabulary** while preserving anything else:

| Canonical state | Meaning |
|---|---|
| `exposed` | Threat applies and is not mitigated |
| `mitigated` | A control is in place |
| `accepted` | Risk knowingly accepted |
| `not_applicable` | Reviewed and ruled out |
| `required` | Control required, not yet in place *(control states only)* |
| `implemented` | Control in place *(control states only)* |
| `planned` | Control scheduled *(control states only)* |

Rules:

- The picker offers these values plus **"Other"** with a free-text field.
- A value imported from OTM that is outside the vocabulary is preserved verbatim, displayed as-is, and
  round-tripped unchanged. It is never silently coerced.
- Export writes the stored string, so an unrecognized value survives a round trip.

This is a case where the *format* is underspecified and the application has to be opinionated without
becoming lossy. The rule to remember: **the vocabulary is a UI convenience, never a validation gate.**

### 4.11 `controls`

OTM `mitigations` and TML `controls` are the same concept with almost no shared fields. They are
**unified**, because keeping two parallel entities would force every model to duplicate its
countermeasures.

| Field | Type | Source | Notes |
|---|---|---|---|
| `threatIds` | id[]→threat | T | TML links controls to threats at root |
| `status` | enum `assumed` `active` `suggested` `under_review` `approved` `scheduled` `retired` `wont_do` | T | |
| `priority` | enum `none` `low` `medium` `high` `critical` | T | |
| `trustBoundary` | object `{zoneAId, zoneBId}` | T | |
| `riskReduction` | number 0–100 | O | **No TML equivalent** |

Unification consequences, both disclosed on export:

- **→ OTM:** one control becomes one `mitigation`. `status`, `priority`, and `trustBoundary` are
  dropped. `riskReduction` is required by OTM, so a missing value is synthesized as `0` **and
  disclosed** — a silent `0` would understate the model.
- **→ TML:** `riskReduction` is dropped. `status` and `priority` are required by TML and synthesized
  from a documented default when absent, also disclosed.

The per-target application of a control lives on `threatApplications[].controlStates`, mirroring OTM's
instance model; TML's root-level `threatIds` link is preserved on the control itself. Both survive.

### 4.12 `risks`

TML-only, and structurally richer than OTM's per-threat inputs.

| Field | Type | Notes |
|---|---|---|
| `threatIds` | id[]→threat | |
| `likelihood` | enum `rare` `unlikely` `possible` `likely` `certain` | |
| `impact` | enum `negligible` `minor` `moderate` `major` `severe` | |
| `impactDescription` | string | |
| `score` | int 0–25 | Derived: likelihood × impact, on the 5×5 matrix |
| `level` | enum `very_low` `low` `medium` `high` `very_high` `critical` | Derived from `score` |

`score` and `level` are **stored, not computed on read**, so an imported model's values are preserved
even if they disagree with its own inputs. The editor recomputes and flags a mismatch rather than
overwriting. Imported models are not always internally consistent, and silently "correcting" them
would misrepresent someone's assessment.

### 4.13 `mitigationPlans`

TML-only. `{riskId, controlIds[]}`. Preserved as an entity for round-trip fidelity.

### 4.14 `assumptions`

TML-only. `{description, validity: unconfirmed|confirmed|rejected, topics?}`.

> `topics` is defined in the TML schema but its specification states no topic taxonomy is
> standardized and that the property **must not be specified**. The application preserves a `topics`
> value if imported, and never writes one.

### 4.15 `diagrams` and `representations`

The two formats model diagrams incompatibly, so canonical holds both shapes.

**`diagrams`** (TML) — source text:

| Field | Type | Notes |
|---|---|---|
| `type` | enum `graphviz` `mermaid` `plantuml` `svg` | |
| `source` | string | The diagram's source, or inline SVG |
| `link` | uri | |

**`representations`** (OTM) — coordinate canvases:

| Field | Type | Notes |
|---|---|---|
| `type` | string `diagram` `code` `threat-model` | Unconstrained upstream |
| `width`, `height` | number | Canvas size |
| `repositoryUrl` | uri | For `code` type |

**`representationElements`** are held on the model, not nested under their parent entity, so an
element survives even if its owner is edited:

| Field | Type | Notes |
|---|---|---|
| `representationId` | id→representation | |
| `ownerId`, `ownerType` | id→trustZone\|component | What the element depicts |
| `x`, `y`, `width`, `height` | number | Geometry |
| `file`, `line`, `codeSnippet` | | For `code` representations |

The two shapes do not convert. A TML model has no coordinates, so its canonical `representations` is
empty; an OTM model has no diagram source, so its canonical `diagrams` is empty. The Diagram tab
renders whichever is populated (`07-ui.md` §6). Neither export invents the other's shape.

---

## 5. Canonical serialization

Hashing depends on this (REQ-VCS-003), so it is specified, not left to `JSON.stringify`.

| Rule | |
|---|---|
| Object keys sorted by UTF-16 code unit | Deterministic regardless of insertion order |
| No insignificant whitespace | `{"a":1}` not `{ "a": 1 }` |
| Arrays keep their order | Order is meaningful |
| `undefined` and functions omitted | |
| `null` preserved | Distinguishable from absent |
| Numbers: shortest round-trippable form | `1` not `1.0`; no `NaN`/`Infinity` — rejected |
| Strings: NFC-normalized | So visually identical text hashes identically |
| Empty arrays and objects preserved | `[]` is not the same as absent |

Two implementations must agree: the app's (`src/app/02-canonical.js`) and the test harness's. The
harness imports the same source file, so they cannot drift.

---

## 6. Validation

Two layers, deliberately separate.

**Layer 1 — structural.** The canonical model's shape: required `id` and `name`, correct types, enums
within their vocabulary, references resolving to an existing entity of the right type. Failing
structural validation means the data is broken; the app refuses to edit it and says why.

**Layer 2 — export readiness.** Advisory, per target format, driven from the mapping tables in
`06-interchange.md`.

| Example | Layer |
|---|---|
| A component with no `id` | Structural — blocking |
| A threat application pointing at a deleted component | Structural — blocking, marked unresolved |
| `scope.businessCriticality` unset, but the user wants TML export | Export readiness — advisory |
| A control with no `riskReduction`, exporting to OTM | Export readiness — advisory; will synthesize `0` |

The UI surfaces Layer 2 as **export readiness** in the export dialog and in the affected entity's
detail view, listing each gap and its consequence. It never blocks saving, because a model that
cannot be exported to one format is still a valid model — and may be intended for the other.

This split is what keeps P3 honest: the canonical model stays permissive, and format requirements are
enforced where they actually apply.

---

## 7. The container

What is embedded in the HTML, and what native export writes (REQ-EXP-006).

```json
{
  "$schema": "https://example.org/threat-model-viewport/container-1.0.0.schema.json",
  "tmvFormat": "1.0.0",
  "model": { },
  "history": {
    "keyframeInterval": 20,
    "head": "sha256:…",
    "commits": [ ]
  },
  "build": {
    "appVersion": "0.1.0",
    "appHash": "sha256-…",
    "generatedAt": "2026-09-28T00:00:00Z"
  }
}
```

| Field | Notes |
|---|---|
| `$schema` | Identifies the **container** format. Never confused with an interchange `$schema` |
| `tmvFormat` | Container format version. Unknown versions load read-only (REQ-DATA-003) |
| `model` | The canonical model at `history.head` |
| `history.commits` | The commit DAG, in topological order |
| `build.generatedAt` | Informational. **Not** used for precedence (REQ-VCS-007) |

### Commit records

```json
{
  "id": "sha256:…",
  "parents": ["sha256:…"],
  "modelId": "8f14e45f-…",
  "author": { "name": "…", "email": "…" },
  "timestamp": "2026-09-28T12:00:00Z",
  "message": "Add SQL injection threat to payments service",
  "modelHash": "sha256:…",
  "isKeyframe": true,
  "snapshot": { },
  "delta": null
}
```

Exactly one of `snapshot` (keyframe) or `delta` (non-keyframe) is present.

### How a commit id is computed

```
modelHash  = sha256( canonicalSerialize(model) )
commitHash = sha256( canonicalSerialize({
               parents:   sorted(commit.parents),
               modelId, author, timestamp, message, modelHash
             }) )
```

**The hash covers the model, never the storage representation.** `snapshot` and `delta` are not
inputs. This is what lets the app re-keyframe or compact history without rewriting commit ids — if the
hash covered a delta, compaction would invalidate every subsequent id and the DAG would have to be
rebuilt, which would break REQ-VCS-013 and make reconciliation against an older file impossible.

Consequences worth stating:

| Property | Reason |
|---|---|
| Identical model, parents, author, timestamp, and message → identical id | REQ-VCS-001 AC2 |
| A changed timestamp alone produces a different id | Correct: it is a different commit event |
| Verification requires reconstructing the model | Hence REQ-VCS-006's fidelity requirement |
| Storage representation is free to change | Compaction, re-keyframing, delta-to-snapshot conversion |

Commit ids are written as `sha256:<hex>`. The prefix is retained for future algorithm agility.

---

## 8. What the container deliberately omits

- **No working copy.** Only committed state is embedded. Uncommitted edits exist solely in memory and
  in the local store, and are never silently written into an exported file. Exporting writes the head
  commit; if the working copy is dirty, the export dialog says so and offers to commit first
  (REQ-EXP-013 keeps export available either way).
- **No storage metadata.** Registry entries, keyframes' storage keys, and quota bookkeeping are
  local-store concerns (`05-storage.md`), not part of a portable document.
- **No UI preferences.** Theme, active tab, and side-nav state are per-user, not per-model.
- **No author identity.** Who *made* the commits is in the history; who is *currently using* the app is
  in local preferences, and is not exported.
