# Vendored assets

Pinned copies of third-party documents the build inlines. Nothing here is fetched at runtime
(`02-architecture.md` §3, REQ-IMP-003) — validation runs offline, and a schema update is a deliberate
vendoring act with a review, not something that changes underfoot (OQ-11).

## JSON Schemas

| File | Source | Version | Retrieved |
|---|---|---|---|
| `otm_schema.json` | `https://raw.githubusercontent.com/iriusrisk/OpenThreatModel/main/otm_schema.json` | OTM `0.2.0` | 2026-09-28 |
| `tml_schema.json` | `https://raw.githubusercontent.com/OWASP/www-project-threat-model-library/main/threat-model.schema.json` | TML `1.0.2` | 2026-09-28 |

### Schema drift, as the spec anticipates it

**OTM is vendored from `main`, not the `0.2.0` release tag.** The release tag places `required`
directly on array schemas with no `items` wrapper — invalid draft-07 — so per-item requirements are
silently unenforced. `main` corrects this. Validating against the tag would make the app accept
documents it should reject (`02-architecture.md` §3, `06-interchange.md` §1).

**TML `$schema` identifier.** The schema constrains its own `$schema` property to:

```
https://github\.com/OWASP/www-project-threat-model-library/blob/v[1-9][0-9]*\.[0-9]+\.[0-9]+/threat-model.schema.json
```

A `raw.githubusercontent.com` URL, or any self-hosted copy, **fails validation on the identifier
alone**. Export therefore emits the `github.com/.../blob/v1.0.2/...` form (REQ-EXP-002).

### Keyword surface

The hand-written validators (`src/app/10-import.js`, ADR-0012) implement exactly the JSON Schema
keywords these two documents use, and nothing else. Derived from the vendored copies rather than
guessed at:

`$ref` · `type` · `required` · `properties` · `items` · `enum` · `pattern` · `patternProperties` ·
`additionalProperties` · `minimum` · `maximum` · `default` · `format` · `title` · `description` ·
`$comment` · `$id` · `$schema` · `$defs`/`definitions`

Neither document uses `anyOf`, `allOf`, `not`, `const`, `minItems`/`maxItems`,
`minLength`/`maxLength`, or numeric `multipleOf`.

Two keywords in the list above are used exactly once each and are easy to miss, so they are called
out rather than left to the re-derivation:

- **`oneOf`** — TML's `date-or-datetime` is `oneOf: [{type: string, format: date}, {type: string,
  format: date-time}]`. A validator that ignores `oneOf` accepts every date, including malformed ones.
- **`minimum`/`maximum`** — TML's `risk-score` is an integer in `0..25`, which is the only numeric
  bound either document imposes.

`interop.lossiness-complete` and `interop.validator-vs-ajv` re-derive the keyword list from the
vendored files on every run, so an upstream schema that starts using a new keyword fails the suite
rather than being quietly ignored.

## Example corpora

Used by the interop tests (`06-interchange.md` §11) — round trips, referential-integrity warnings,
and the Ajv differential. Not shipped in the artifact.

| File | Source |
|---|---|
| `examples/otm_EXAMPLE.json` | `iriusrisk/OpenThreatModel` `main` `EXAMPLE.json` |
| `examples/tml_cryptocurrency-wallet.json` | OWASP TML `threat-models/web/` |
| `examples/tml_husky-ai.json` | OWASP TML `threat-models/ai-ml-systems/` |

## CDN assets (not vendored — referenced)

Recorded here so the pinning can be checked without reading the shell.

| Asset | URL | SRI (`sha384-`) |
|---|---|---|
| Carbon stylesheet | `https://cdn.jsdelivr.net/npm/@carbon/styles@1.116.0/css/styles.min.css` | `gYQeZbdal8FzOSXLJtbKBV3RR1DLpadVkckScRc/p+SMtKTLx1T2vrmokf34/s3k` |
| Mermaid | `https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js` | `xzghz1GQ5u9HCpVskeDPqMsdogD1yvuMQbEK53+wi+G70+6J1AG0L2cfi9PHjDWI` |

The Carbon stylesheet is 938,627 bytes minified — the ~939 KB figure ADR-0002's size arithmetic is
built on, confirming the decision's premise rather than assuming it.

Both are pinned to an exact version, carry `integrity`, and are the only two third-party assets the
app ever loads. `vendor/mermaid.version` holds the Mermaid pin, substituted into the artifact at build
time (REQ-UI-012). Mermaid is loaded lazily and only when a Mermaid diagram is displayed
(REQ-VIEW-005).
