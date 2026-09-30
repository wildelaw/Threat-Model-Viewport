/*
 * interop.test.mjs — the nine differential tests of `06-interchange.md` §11.
 *
 * Interchange is where a bug is least visible: a dropped field produces a model that still validates
 * and still renders, just wrongly. So almost nothing here is an example-based assertion. Each test
 * either walks the vendored schemas as data, or drives the mappers over a corpus built from the
 * model's own field tables, so that a field added to a mapping without a decision about it — or a
 * reference type added to the model without a disclosure for it — fails rather than passing quietly.
 *
 * Two external tools are used and both are test-only (`package.json`): **Ajv**, so that
 * `interop.validator-vs-ajv` compares our hand-written validator against an independent
 * implementation instead of against itself, and the vendored schemas' own keywords, so that
 * `interop.lossiness-complete` asks the schema what fields exist rather than trusting a list.
 *
 * Ajv is instantiated twice, and the reason is a real difference between the two documents: OTM is
 * draft-07 and TML is 2020-12. A single `Ajv` compiles the first and refuses the second outright
 * ("no schema with key or ref https://json-schema.org/draft/2020-12/schema"), which would have made
 * the TML half of every comparison silently absent.
 */

import assert from 'node:assert/strict';

import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { specTest } from '../lib/check.mjs';
import { loadApp, schemas, seed, vendoredExamples } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

// -----------------------------------------------------------------------------------------------
// A shared, loaded application.
//
// One load for the whole file rather than one per test: the modules are side-effect-free at load
// (the shell is not mounted here), and `symbolicNames` writes to the model it is handed, so nothing
// below shares state through the app itself — only through the fixtures each test builds.
// -----------------------------------------------------------------------------------------------

const { TMV } = loadApp();
const M = TMV.model;
const core = TMV.core;
const SCHEMAS = schemas();
const EXAMPLES = vendoredExamples();

const ajv07 = new Ajv.default({ strict: false, allErrors: true });
addFormats.default(ajv07);
const ajv2020 = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv2020);

/** The reference a corpus dangles at. Deliberately a name no fixture contains. */
const MISSING = 'nothing-holds-this-id';

/** The id of the entity each reference case plants as a valid target. */
const PROBE_ID = 'reference-probe-target';

// -----------------------------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------------------------

/**
 * The seed model with its one deliberate defect repaired.
 *
 * `test/lib/app.mjs`'s seed ends `flow-bad` at an id nothing holds, because the Unresolved
 * References finding needs a row. That row is what `REQ-IMP-004` and §8 exist for, and it blocks
 * every export — so a round-trip test that started from the seed unmodified would be asserting that
 * a blocked export round-trips, which is a different claim from the one §10 makes.
 */
function cleanSeed() {
  const m = seed(M);
  M.remove(m, 'dataFlow', 'flow-bad');
  return m;
}

/**
 * A model carrying one instance of every §8 gap: each field the table says to synthesize is unset,
 * and each blocking case is absent.
 *
 * Built for `interop.synthesis-disclosed`, and built from the table rather than from a document so
 * that the assertion is "every row of §8 is disclosed" rather than "this document's fields are".
 */
function gapModel() {
  const m = M.createEmpty('S');
  M.insert(m, 'trustZone', { id: 'z', name: 'Z' }); // no trustRating
  M.insert(m, 'threatPersona', { id: 'p', name: 'P' });
  M.insert(m, 'component', { id: 'c', name: 'C' }); // no type
  M.insert(m, 'component', { id: 'c2', name: 'C2', type: 'process', trustZoneId: 'z' });
  M.insert(m, 'asset', { id: 'a', name: 'A', processedByIds: ['c2'] }); // no CIA
  M.insert(m, 'threat', { id: 't', name: 'T', personaId: 'p' }); // no event, no sources
  M.insert(m, 'threatApplication', { threatId: 't', targetType: 'component', targetId: 'c2' });
  M.insert(m, 'control', { id: 'k', name: 'K', threatIds: ['t'] }); // no status, priority, reduction
  M.insert(m, 'risk', { id: 'r', name: 'R', threatIds: ['t'], likelihood: 'likely', impact: 'major' });
  M.insert(m, 'mitigationPlan', { id: 'mp', name: 'MP', riskId: 'r', controlIds: ['k'] });
  return m;
}

/**
 * A model with no §8 gap at all, so that an export of it either succeeds or is blocked for a reason
 * the test put there.
 */
function fullModel() {
  const m = M.createEmpty('S');
  M.insert(m, 'trustZone', { id: 'z', name: 'Z', trustRating: 50 });
  M.insert(m, 'threatPersona', {
    id: 'p', name: 'P', skillLevel: 'insider', accessLevel: 'user',
    isPerson: true, maliciousIntent: false, applicabilityToOrg: 'low',
  });
  M.insert(m, 'component', { id: 'c', name: 'C', type: 'process', trustZoneId: 'z' });
  M.insert(m, 'component', { id: 'c2', name: 'C2', type: 'process', trustZoneId: 'z' });
  M.insert(m, 'threat', { id: 't', name: 'T', personaId: 'p', event: 'Something happens', sources: ['adversary'] });
  M.insert(m, 'threatApplication', { threatId: 't', targetType: 'component', targetId: 'c2' });
  M.insert(m, 'control', {
    id: 'k', name: 'K', threatIds: ['t'], status: 'active', priority: 'high', riskReduction: 30,
  });
  M.insert(m, 'risk', { id: 'r', name: 'R', threatIds: ['t'], likelihood: 'likely', impact: 'major', score: 16, level: 'high' });
  M.insert(m, 'mitigationPlan', { id: 'mp', name: 'MP', riskId: 'r', controlIds: ['k'] });
  return m;
}

// -----------------------------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------------------------

/**
 * Whether two documents are the same once an explicitly-null optional field is read as an absent one.
 *
 * This is the one normalisation `interop.otm-roundtrip` allows, and it is not a convenience. OTM's
 * schema types optional fields `["array", "null"]` and `["string", "null"]`, and the vendored example
 * uses that: it writes `"attributes": null` on most entities. The canonical model stores absence —
 * there is no third state between "has a value" and "does not" — so a null that survives import has
 * nowhere to be recorded and nothing to be restored from. Both spellings mean "not set" to every
 * reader of either document, and OTM's own tooling is the reason its schema permits both.
 *
 * Empty arrays are folded in with them. A field that is `[]` and a field that is absent say the same
 * thing about a list, and the model keeps only one of those states.
 *
 * The normalisation is applied to both sides and asserted to be the *only* difference, which is what
 * keeps it honest: a mapper that dropped a real value would still fail.
 */
function normalise(value) {
  if (Array.isArray(value)) {
    const out = value.map(normalise);
    return out.length ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const folded = normalise(value[key]);
      if (folded === undefined || folded === null) continue;
      out[key] = folded;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === null ? undefined : value;
}

/** Every path at which two documents differ, in dotted form. Used for failure messages. */
function diffPaths(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path} (length ${a.length} → ${b.length})`);
      return out;
    }
    for (let i = 0; i < a.length; i++) diffPaths(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}

// -----------------------------------------------------------------------------------------------
// 1. Round trips
// -----------------------------------------------------------------------------------------------

specTest('interop.otm-roundtrip', () => {
  // `06-interchange.md` §10: "OTM → canonical → OTM — **Lossless** for everything OTM can express.
  // Unmapped keys survive in `x.otm` and are re-emitted."
  //
  // Two kinds of model, because they fail differently. A vendored example tests the mapping against
  // a document this project did not write; a generated model tests the property that actually
  // matters for repeated use, which is that the *second* export is identical to the first. A mapper
  // that is lossless once but drifts on the second pass would pass the first check and corrupt a
  // model the second time someone exported it.
  for (const example of EXAMPLES.filter((e) => e.format === 'otm')) {
    const imported = TMV.otm.toCanonical(example.json);
    const back = TMV.otm.fromCanonical(imported.model, {});
    assert.equal(back.ok, true, `${example.file} re-exports`);
    const diffs = diffPaths(normalise(example.json), normalise(back.document));
    assert.deepEqual(diffs, [], `${example.file} round-trips with no difference but explicit nulls`);
  }

  const generated = cleanSeed();
  const first = TMV.otm.fromCanonical(generated, {});
  assert.equal(first.ok, true, 'the repaired seed exports');
  const second = TMV.otm.fromCanonical(TMV.otm.toCanonical(first.document).model, {});
  assert.equal(second.ok, true, 'and so does its own output');
  assert.deepEqual(
    diffPaths(first.document, second.document),
    [],
    'OTM → canonical → OTM is a fixed point: the second export is byte-for-byte the first',
  );
});

specTest('interop.tml-roundtrip', () => {
  // The two vendored TML examples are the two cases and they are not the same case. `wallet` has one
  // reference canonical cannot type but TML can write back verbatim, and `husky` has four whose
  // targets are genuinely gone. Both go out; the difference is what the import says about them.
  //
  // `wallet` first, because the interesting part is that it round-trips *despite* an unresolved
  // reference, which is not a contradiction. TML types `components_affected` as a bare
  // `symbolic-name` and the example lists a data store in it — the document is well-formed TML, and
  // TML can carry the name straight back. The canonical model cannot *type* it (`targetType`'s
  // vocabulary has no `dataStore` member), so the reference is flagged unresolved on the way in and
  // the UI says so — REQ-IMP-004's job. The export half resolves a name across every collection
  // precisely so that a reference which exists but is not of the expected type is not called
  // dangling, which is what keeps the round trip exact instead of blocking on a document that is
  // not broken.
  const wallet = EXAMPLES.filter((e) => e.file.startsWith('tml_cryptocurrency'))[0];
  const imported = TMV.tml.toCanonical(wallet.json);
  same(
    imported.report.unresolved,
    [{ path: '/threatApplications/1/targetId', type: 'threatApplications', field: 'targetId', id: 'store-wallet-file', expected: ['components'] }],
    'the wallet example has exactly one reference canonical cannot type, and it is disclosed rather than dropped',
  );
  const back = TMV.tml.fromCanonical(imported.model, {});
  assert.equal(back.ok, true, 'the unresolved reference does not block the export — it resolves in TML terms');
  assert.deepEqual(
    diffPaths(wallet.json, back.document),
    [],
    'and the document comes back byte-for-byte, with no normalisation applied at all',
  );

  // `husky` has four references whose targets are not in the document at all. §8 blocks those: writing
  // a name the recipient's tool cannot resolve hands them a broken document.
  const husky = EXAMPLES.filter((e) => e.file.startsWith('tml_husky'))[0];
  const huskyIn = TMV.tml.toCanonical(husky.json);
  const huskyOut = TMV.tml.fromCanonical(huskyIn.model, {});
  assert.ok(huskyIn.report.unresolved.length > 0, 'the husky example does have dangling references');
  assert.equal(huskyOut.ok, false, 'so its export is blocked rather than written (§8)');
  assert.equal(
    huskyOut.blocked.length,
    huskyIn.report.unresolved.length,
    'every reference the import disclosed is one the export refuses to write',
  );
  same(
    huskyOut.blocked.map((b) => b.target).sort(),
    huskyIn.report.unresolved.map((u) => u.id).sort(),
    'and they are the same references, named with the same targets',
  );

  const generated = cleanSeed();
  const first = TMV.tml.fromCanonical(generated, {});
  assert.equal(first.ok, true, 'the repaired seed exports to TML');
  const second = TMV.tml.fromCanonical(TMV.tml.toCanonical(first.document).model, {});
  assert.equal(second.ok, true, 'and so does its own output');
  assert.deepEqual(
    diffPaths(first.document, second.document),
    [],
    'TML → canonical → TML is a fixed point',
  );
});

// -----------------------------------------------------------------------------------------------
// 2. The hand-written validator against Ajv
// -----------------------------------------------------------------------------------------------

/*
 * The keywords a vendored schema may use to *assert* something, and which our validator implements
 * (`10-import.js`, `check`). Everything else either schema contains is an annotation — a title, a
 * description, a default — which states nothing about whether a document is valid.
 *
 * `interop.lossiness-complete` below walks the schemas for the ledger; this list is walked for the
 * validator, and it is a closed set on purpose. Our validator implements a deliberate subset of JSON
 * Schema, and agreement with Ajv is only promised over that subset: a schema that started using
 * `anyOf` would be under-validated by us and Ajv would disagree, and the honest failure is a test
 * that says so rather than a corpus that happens not to contain the case.
 */
const ASSERTION_KEYWORDS = [
  '$ref',
  'additionalProperties',
  'enum',
  'format',
  'items',
  'maximum',
  'minimum',
  'oneOf',
  'pattern',
  'patternProperties',
  'properties',
  'required',
  'type',
];

/**
 * The annotation keywords the two schemas use, which is every other keyword either of them has.
 *
 * `definitions` is here alongside `$defs`: the same container under its draft-07 name, which is what
 * the vendored OTM schema is written in. Neither asserts anything about a document.
 */
const ANNOTATION_KEYWORDS = [
  '$comment', '$defs', '$id', '$schema', 'default', 'definitions', 'description', 'title',
];

/**
 * The keywords a schema at `node` is *made of*.
 *
 * The walk has to know which keys are keywords and which are names, or `properties.components` would
 * be collected as though `components` were a keyword — which is how a first attempt at this returned
 * fifty-odd "unimplemented keywords" that were all field names. So the recursion is explicit: the
 * keys of a schema object are its keywords, and the keys *inside* `properties`, `patternProperties`,
 * `$defs` and `definitions` are names whose values are the schemas to descend into.
 *
 * `enum`, `required`, `const`, `default` and `examples` are deliberately not descended into: their
 * contents are data, and a document's data is not part of the vocabulary the schema is written in.
 */
function schemaKeywords(node, out) {
  const keywords = out || new Set();
  if (Array.isArray(node)) {
    for (const item of node) schemaKeywords(item, keywords);
    return keywords;
  }
  if (!node || typeof node !== 'object') return keywords;
  for (const key of Object.keys(node)) keywords.add(key);

  for (const mapKey of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const map = node[mapKey];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const name of Object.keys(map)) schemaKeywords(map[name], keywords);
  }
  for (const listKey of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(node[listKey])) for (const item of node[listKey]) schemaKeywords(item, keywords);
  }
  for (const singleKey of ['items', 'additionalProperties', 'additionalItems', 'not', 'contains', 'propertyNames']) {
    if (node[singleKey] && typeof node[singleKey] === 'object') schemaKeywords(node[singleKey], keywords);
  }
  return keywords;
}

specTest('interop.validator-vs-ajv', () => {
  // `06-interchange.md` §11: "Our validator's verdict matches Ajv's across a corpus including
  // deliberate violations (§3)."
  //
  // The claim is checked in three parts, because "matches Ajv" on its own is not falsifiable: a
  // validator that accepts everything matches Ajv on every valid document.
  //
  //  1. the schemas use no assertion keyword we do not implement, so the subset is honest;
  //  2. the corpus reaches both verdicts, so agreement is not agreement on one answer;
  //  3. every verdict agrees, exactly.
  for (const [name, schema] of [['otm', SCHEMAS.otm], ['tml', SCHEMAS.tml]]) {
    const used = schemaKeywords(schema);
    const unimplemented = [...used].filter(
      (k) => !ASSERTION_KEYWORDS.includes(k) && !ANNOTATION_KEYWORDS.includes(k),
    );
    assert.deepEqual(
      unimplemented.sort(),
      [],
      `the ${name} schema asserts with a keyword \`10-import.js\` does not implement, so our verdict ` +
        'is not comparable to Ajv\'s and the mapper is under-validating',
    );
  }

  const validateOtm = ajv07.compile(SCHEMAS.otm);
  const validateTml = ajv2020.compile(SCHEMAS.tml);
  const base = { otm: EXAMPLES.filter((e) => e.format === 'otm')[0].json, tml: EXAMPLES.filter((e) => e.format === 'tml')[0].json };
  const clone = (doc) => JSON.parse(JSON.stringify(doc));
  const mutate = (fmt, apply) => {
    const doc = clone(base[fmt]);
    apply(doc);
    return doc;
  };

  // Every entry names what it changes, and the corpus is built in two halves. The first half is
  // edits a person could make and the schema allows — a renamed project, a cleared optional, an
  // added extension — because agreeing with Ajv only on rejections would be satisfied by a validator
  // that rejected everything. The second half breaks one keyword each, so a failure names the part
  // of the validator to look at rather than only the document that disagreed.
  const accepts = [
    ['the example itself', 'otm', (d) => {}],
    ['a renamed project', 'otm', (d) => { d.project.name = 'Renamed'; }],
    ['an optional field removed', 'otm', (d) => { delete d.project.description; }],
    ['an optional nullable array set to null', 'otm', (d) => { d.representations = null; }],
    ['an array emptied', 'otm', (d) => { d.assets = []; }],
    ['a nested number changed', 'otm', (d) => { d.trustZones[0].risk.trustRating = 75; }],
    ['an optional string changed', 'otm', (d) => { d.components[0].type = 'process'; }],
    ['a required array emptied', 'otm', (d) => { d.dataflows = []; }],
    ['the example itself', 'tml', (d) => {}],
    ['a renamed scope', 'tml', (d) => { d.scope.title = 'Renamed'; }],
    ['an optional field removed', 'tml', (d) => { delete d.description; }],
    ['a required array emptied', 'tml', (d) => { d.data_flows = []; }],
    ['an optional boolean changed', 'tml', (d) => { d.frozen = true; }],
    ['an extension added', 'tml', (d) => { d.extensions = { 'example.com/ext/v1': { a: 1 } }; }],
    ['a nested optional string changed', 'tml', (d) => { d.trust_zones[0].description = 'edited'; }],
  ];
  const rejects = [
    ['required', 'otm', (d) => { delete d.project; }],
    ['type', 'otm', (d) => { d.otmVersion = 2; }],
    ['type', 'otm', (d) => { d.trustZones[0].name = 5; }],
    ['type', 'otm', (d) => { d.trustZones[0].risk = 'yes'; }],
    ['oneOf', 'otm', (d) => { d.components[0].parent = { neither: 'nor' }; }],
    ['required', 'tml', (d) => { delete d.version; }],
    ['required', 'tml', (d) => { delete d.scope.title; }],
    ['type', 'tml', (d) => { d.scope.title = 3; }],
    ['type', 'tml', (d) => { d.trust_zones = 'no'; }],
    ['type', 'tml', (d) => { d.trust_zones[0].title = 5; }],
    ['additionalProperties', 'tml', (d) => { d.extra = 1; }],
    ['additionalProperties', 'tml', (d) => { d.trust_zones[0].extra = 1; }],
    ['patternProperties', 'tml', (d) => { d.extensions = { 'no-domain': 'x' }; }],
  ];
  const corpus = accepts
    .map(([what, fmt, apply]) => [what, fmt, true, mutate(fmt, apply)])
    .concat(rejects.map(([keyword, fmt, apply]) => [keyword, fmt, false, mutate(fmt, apply)]));

  let valid = 0;
  let invalid = 0;
  for (const [what, fmt, expected, doc] of corpus) {
    const theirs = (fmt === 'otm' ? validateOtm : validateTml)(doc);
    const ours = TMV.importing.validateDocument(doc, fmt).valid;
    if (theirs) valid += 1;
    else invalid += 1;
    assert.equal(
      ours,
      theirs,
      `${fmt} corpus entry (\`${what}\`): our validator says ${ours ? 'valid' : 'invalid'} and Ajv says ` +
        `${theirs ? 'valid' : 'invalid'}`,
    );
    assert.equal(
      theirs,
      expected,
      `the corpus entry \`${what}\` no longer tests what it claims to — a schema that changed under ` +
        'the test is a reason to rewrite the entry, not to relax the comparison',
    );
    if (!theirs) {
      // A disagreement in the *messages* is not the claim; but a rejection with nothing to show the
      // user is REQ-IMP-003 failing even though the verdict is right.
      assert.ok(
        TMV.importing.validateDocument(doc, fmt).problems.length > 0,
        `${fmt} corpus entry \`${what}\` is rejected with at least one reported problem`,
      );
    }
  }

  assert.ok(valid >= 10, `the corpus only reached "valid" ${valid} times, so agreement proves little`);
  assert.ok(invalid >= 10, `the corpus only reached "invalid" ${invalid} times, so agreement proves little`);
});

// -----------------------------------------------------------------------------------------------
// 3. The lossiness ledger against the schemas
// -----------------------------------------------------------------------------------------------

/*
 * `06-interchange.md` §7's ledger, read as data.
 *
 * The path convention is the one the mapping tables document (`08-otm.js`, `09-tml.js`):
 * `f` for a root field, `f.p` for a nested one, `a` for a root array, `a[].p` for an item field,
 * `a[].p.q` for a field of a nested object, `a[].p[].q` for an array's items. So the walk below has
 * to reproduce exactly that spelling or every path would look unclassified.
 */

/** Resolve a `#/…` pointer inside a schema, or `null` when it does not resolve. */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || ref.charAt(0) !== '#') return null;
  let node = root;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return null;
    node = node[key];
  }
  return node;
}

/** Follow `$ref` chains to the node they name. */
function deref(root, node) {
  let current = node;
  for (let guard = 0; current && current.$ref && guard < 20; guard++) {
    const target = resolveRef(root, current.$ref);
    if (!target || target === current) break;
    current = target;
  }
  return current;
}

/** Whether a schema node's `type` admits `wanted` — it may be a string or a list (`["array","null"]`). */
function admitsType(node, wanted) {
  if (!node) return false;
  return node.type === wanted || (Array.isArray(node.type) && node.type.indexOf(wanted) !== -1);
}

/**
 * Every path the schema can reach, in the ledger's spelling.
 *
 * `bare` suppresses the path for a node that is an array's *item*: the item's fields are
 * `a[].p`, and `a[]` on its own is not a path the ledger names — the array itself is `a`.
 *
 * `oneOf` does not end the walk. OTM's `parent` is `{type: object, oneOf: [...], properties: {...}}`,
 * so treating the alternatives as the whole node loses the `trustZone`/`component` properties that
 * sit beside them.
 */
function collectPaths(root, node, path, out, bare) {
  const schema = deref(root, node);
  if (!schema || typeof schema !== 'object' || out.size > 4000) return;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    for (const alternative of schema.oneOf || schema.anyOf) {
      collectPaths(root, alternative, path, out, true);
    }
  }
  if ((admitsType(schema, 'array') || (!schema.type && schema.items)) && schema.items && !Array.isArray(schema.items)) {
    out.add(path);
    collectPaths(root, schema.items, `${path}[]`, out, true);
    return;
  }
  if (!bare) out.add(path);
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      collectPaths(root, schema.properties[key], path === '' ? key : `${path}.${key}`, out, false);
    }
  }
}

function schemaPaths(schema) {
  const out = new Set();
  for (const key of Object.keys(schema.properties)) {
    collectPaths(schema, schema.properties[key], key, out, false);
  }
  return out;
}

/**
 * Every `$ref` target anywhere in a schema, so "unreachable" can be checked rather than asserted.
 */
function referencedPointers(schema) {
  const out = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') out.add(value.$ref);
    for (const key of Object.keys(value)) visit(value[key]);
  };
  visit(schema);
  return out;
}

specTest('interop.lossiness-complete', () => {
  // `06-interchange.md` §11: "Every field in the vendored schemas is classified as mapped, folded, or
  // dropped — a field present in a schema but absent from §5.3/§6.3 fails the test", and §11's own
  // note that this is the test that converts "did we forget a field?" from a review question into a
  // mechanical check.
  //
  // Both directions are asserted. Unclassified is the one §11 names; *stale* is the other half of
  // the same defect — a ledger entry for a field the schema no longer has means the mapping is
  // handling something that is not there, and would keep passing if the field were renamed.
  const classifications = [TMV.otm.MAPPED, TMV.otm.FOLDED, TMV.otm.DROPPED, TMV.otm.UNREACHABLE];

  for (const [name, schema, tables] of [
    ['otm', SCHEMAS.otm, TMV.otm],
    ['tml', SCHEMAS.tml, TMV.tml],
  ]) {
    const reachable = schemaPaths(schema);
    const ledger = tables.FIELDS;
    const ledgerKeys = Object.keys(ledger);

    assert.ok(reachable.size > 100, `the ${name} walk found only ${reachable.size} paths`);
    assert.ok(ledgerKeys.length > 100, `the ${name} ledger has only ${ledgerKeys.length} entries`);

    const unclassified = [...reachable].filter((p) => !Object.prototype.hasOwnProperty.call(ledger, p));
    assert.deepEqual(
      unclassified.sort(),
      [],
      `these ${name} schema fields have no line in §7's ledger: add one in the ${name} mapping's ` +
        'FIELDS table, choosing mapped, folded or dropped deliberately',
    );

    const unknown = ledgerKeys.filter((k) => classifications.indexOf(ledger[k]) === -1);
    assert.deepEqual(unknown.sort(), [], `these ${name} ledger entries use a classification §7 does not define`);

    // An `UNREACHABLE` entry is the one kind of ledger line the walk cannot find, because the walk
    // starts at the root and follows `$ref`s and an unreachable definition is by definition never
    // referenced. That is the whole reason the classification exists — TML defines
    // `$defs/mitigation-plan` and then references it nowhere — so the exemption is checked rather
    // than trusted: the definition has to be there, and nothing has to point at it.
    const unreachable = ledgerKeys.filter((k) => ledger[k] === TMV.otm.UNREACHABLE);
    for (const key of unreachable) {
      assert.ok(!reachable.has(key), `${key} is classified UNREACHABLE but the walk reaches it`);
      const definition = key.split('.')[0];
      const pointers = referencedPointers(schema);
      const pointedAt = [...pointers].some((p) => p.endsWith(`/${definition}`) || p.endsWith(`/${definition.replace(/-/g, '-')}`));
      assert.equal(pointedAt, false, `${definition} is classified UNREACHABLE but something \$refs it`);
    }

    const stale = ledgerKeys.filter((k) => !reachable.has(k) && ledger[k] !== TMV.otm.UNREACHABLE);
    assert.deepEqual(
      stale.sort(),
      [],
      `these ${name} ledger entries name fields the schema does not have: the mapping classifies ` +
        'something that is not in the vendored document, so the ledger has drifted from it',
    );
  }
});

// -----------------------------------------------------------------------------------------------
// 4. Identifiers
// -----------------------------------------------------------------------------------------------

specTest('interop.slug-stability', () => {
  // `06-interchange.md` §4: "Regenerating on every export would rename entities whenever a title
  // changed, which for a shared model is a breaking change."
  //
  // The test does exactly the two things §4 says must not change a name: rename an entity, and
  // reorder its collection. Both are edits a user makes casually and neither is a change to the
  // entity's identity.
  const m = cleanSeed();
  const before = TMV.tml.symbolicNames(m, {}); // remembers
  assert.ok(core.isObject(M.bag(m, 'tml')), 'the first export records the assignment on the model');

  const components = M.collection(m, 'components');
  const first = components[0];
  M.update(m, 'component', first.id, { name: 'A completely different name' });
  components.push(components.shift());

  const after = TMV.tml.symbolicNames(m, { remember: false });
  assert.deepEqual(
    Object.keys(after).sort().map((k) => `${k}=${after[k]}`),
    Object.keys(before).sort().map((k) => `${k}=${before[k]}`),
    'renaming an entity and reordering its collection leaves every symbolic name where it was',
  );

  // The other half of determinism: a model that has never been exported must still allocate the same
  // names twice, or the map would only be stable after the first export.
  const fresh = cleanSeed();
  const once = TMV.tml.symbolicNames(fresh, { remember: false });
  const twice = TMV.tml.symbolicNames(fresh, { remember: false });
  assert.deepEqual(Object.keys(once).sort(), Object.keys(twice).sort(), 'and a fresh model allocates the same set twice');
  assert.equal(M.bag(fresh, 'tml'), null, 'a read does not write the map onto the model');
});

specTest('interop.slug-collisions', () => {
  // §4's derivation: "if base taken: suffix = 2, 3, ... until free", with candidates "processed in a
  // fixed order — sorted by canonical id — so the same model always yields the same assignment".
  //
  // Five ids chosen so that four of them collide under `slug` for four different reasons — case, a
  // space, a hyphen, and nothing sluggable at all — because the suffix counter and the fallback name
  // are separate branches and testing one of them tests one of them.
  const m = M.createEmpty('Collide');
  M.insert(m, 'component', { id: 'Comp A', name: 'A' });
  M.insert(m, 'component', { id: 'comp-a', name: 'B' });
  M.insert(m, 'component', { id: 'comp a', name: 'C' });
  M.insert(m, 'component', { id: '###', name: 'D' });
  M.insert(m, 'component', { id: 'Ünïcode Naïve', name: 'E' });

  const names = TMV.tml.symbolicNames(m, { remember: false });
  const values = Object.keys(names).map((k) => names[k]);

  assert.equal(new Set(values).size, values.length, 'every symbolic name is distinct');
  for (const value of values) {
    assert.match(value, /^[0-9a-z-]+$/, `"${value}" matches TML's ^[0-9a-z-]+$`);
  }
  assert.equal(names['components/Comp A'], 'comp-a', 'the first of the colliding ids takes the bare slug');
  assert.equal(names['components/comp a'], 'comp-a-2', 'the next takes the first free suffix');
  assert.equal(names['components/comp-a'], 'comp-a-3', 'and the next the one after that');
  assert.equal(names['components/###'], 'component', 'an id with nothing sluggable falls back to its type name');
  assert.equal(names['components/Ünïcode Naïve'], 'unicode-naive', 'and non-ASCII is transliterated');

  // Stable across a re-run *and* independent of array order, which is the property the suffix
  // numbering depends on: the ids are sorted before they are numbered.
  const reordered = M.createEmpty('Collide');
  for (const c of M.collection(m, 'component').slice().reverse()) {
    M.insert(reordered, 'component', core.deepCopy(c));
  }
  const again = TMV.tml.symbolicNames(reordered, { remember: false });
  assert.deepEqual(
    Object.keys(again).sort().map((k) => `${k}=${again[k]}`),
    Object.keys(names).sort().map((k) => `${k}=${names[k]}`),
    'reversing the collection changes nothing, so the numbering came from the sorted ids',
  );
});

// -----------------------------------------------------------------------------------------------
// 5. References, synthesis and blocking
// -----------------------------------------------------------------------------------------------

/**
 * The entity that carries a reference field, and whether the fixture has one to break.
 *
 * Built from `M.REFERENCE_FIELDS` rather than from a hand-written list of fields, so the corpus
 * cannot go stale: a reference field added to the model is in the corpus the next time this runs,
 * which is what `interop.referential-integrity`'s "every reference type" asks for. A container field
 * (`placements`, `controlStates`, `trustBoundary`) is created when the fixture does not have one,
 * because the reference *type* is what is being exercised, not the fixture's shape.
 */
function holderOf(m, rf) {
  for (const entity of M.collection(m, rf.type)) {
    if (!rf.container) return entity;
    const spec = rf.typeSpec.fields.filter((f) => f.key === rf.container)[0];
    if (spec && spec.kind === 'objectList') {
      if (!Array.isArray(entity[rf.container]) || !entity[rf.container].length) {
        entity[rf.container] = [Object.create(null)];
      }
      return entity[rf.container][0];
    }
    if (!core.isObject(entity[rf.container])) entity[rf.container] = Object.create(null);
    return entity[rf.container];
  }
  return null;
}

/** Point the field at `value`; `null` clears it, which for a list means an empty one. */
function pointAt(holder, rf, value) {
  if (rf.field.kind !== 'refList') {
    if (value === null) delete holder[rf.field.key];
    else holder[rf.field.key] = value;
    return;
  }
  holder[rf.field.key] = value === null ? [] : [value];
}

specTest('interop.referential-integrity', () => {
  // `06-interchange.md` §11: "Every reference type in both schemas is exercised with a dangling
  // target and reported."
  //
  // Three claims, and the third is the one worth having.
  //
  //   1. `M.validate` reports it — that is what REQ-IMP-004 and the Unresolved References view read,
  //      and it is why an import of a document like the vendored wallet is allowed to succeed.
  //   2. The dangling id is never written into the document we hand out. A mapper could report a
  //      problem and write the reference anyway, and every view in the application would look right.
  //   3. For a reference the format *does* carry, the loss is not silent: the export blocks (§8) or
  //      its report differs from the same model with the field intact (REQ-EXP-003).
  //
  // (3) is why the corpus is built in threes. The middle measurement — does this format carry this
  // reference at all? — is not hard-coded, because a table of "references OTM writes" in a test is a
  // second description of the mapping and would go stale exactly where it matters. It is measured:
  // plant an entity of the referenced type, point the field at it, and compare the document against
  // the same model with the field cleared. What differs is what the format writes *because of the
  // reference*. That excludes the references the format has no home for — a persona reference on the
  // way to OTM, say, where personas are dropped wholesale and disclosed as a collection — without
  // excusing the ones it does write.
  assert.ok(M.REFERENCE_FIELDS.length >= 20, `only ${M.REFERENCE_FIELDS.length} reference fields found`);

  let carriedPairs = 0;
  for (const rf of M.REFERENCE_FIELDS) {
    const label = `${rf.type}${rf.container ? '.' + rf.container : ''}.${rf.field.key}`;
    const targets = Array.isArray(rf.field.ref) ? rf.field.ref : [rf.field.ref];

    // The target type has to exist as a collection, or the field's own table is wrong.
    const collectionName = targets[0];
    assert.ok(M.collection(cleanSeed(), collectionName), `${label} names a collection that exists (\`${collectionName}\`)`);

    /** A clean fixture with a planted target of the referenced type. */
    const planted = () => {
      const m = cleanSeed();
      M.collection(m, collectionName).push({ id: PROBE_ID, name: 'Reference probe' });
      const holder = holderOf(m, rf);
      if (rf.field.typeField) holder[rf.field.typeField] = collectionName;
      return { m, holder };
    };

    const withValue = planted();
    assert.ok(withValue.holder, `${label}: the seed has an entity that carries this reference`);
    pointAt(withValue.holder, rf, PROBE_ID);
    const pointed = {};
    for (const format of ['otm', 'tml']) {
      pointed[format] = (format === 'otm' ? TMV.otm : TMV.tml).fromCanonical(withValue.m, {});
    }
    const cleared = planted();
    pointAt(cleared.holder, rf, null);
    const clearedDocs = {};
    for (const format of ['otm', 'tml']) {
      clearedDocs[format] = JSON.stringify((format === 'otm' ? TMV.otm : TMV.tml).fromCanonical(cleared.m, {}).document);
    }

    // The dangling model: same fixture, same planted target, field pointing at nothing.
    const dangling = planted();
    pointAt(dangling.holder, rf, MISSING);
    assert.ok(
      M.validate(dangling.m).unresolved.some((u) => u.path.indexOf('/' + rf.field.key) !== -1),
      `${label}: a dangling reference is reported by the model validator (REQ-IMP-004)`,
    );

    for (const format of ['otm', 'tml']) {
      const mapper = format === 'otm' ? TMV.otm : TMV.tml;
      const exported = mapper.fromCanonical(dangling.m, {});
      assert.equal(
        JSON.stringify(exported.document).indexOf(MISSING),
        -1,
        `${label}: exporting to ${format} does not write the dangling reference into the document`,
      );

      const carries = JSON.stringify(pointed[format].document) !== clearedDocs[format];
      if (!carries) continue;
      carriedPairs += 1;
      const disclosed = exported.blocked.length > 0 || JSON.stringify(exported.report) !== JSON.stringify(pointed[format].report);
      assert.equal(
        disclosed,
        true,
        `${label}: ${format} writes this reference and, handed a dangling one, neither blocked the export ` +
          'nor said anything in its report — the link disappears with nothing to tell the user (REQ-EXP-003)',
      );
    }
  }

  // The measurement above is itself the thing that could go wrong quietly: if the planted target
  // stopped being written, every case would skip the disclosure assertion and the test would pass
  // while checking nothing. A fifth of the corpus is what the reference fields are *for*; anything
  // near zero means the measurement broke, not that the mappers stopped losing references.
  assert.ok(
    carriedPairs >= 20,
    `only ${carriedPairs} of ${M.REFERENCE_FIELDS.length * 2} reference/format pairs were found to be carried ` +
      'by their mapper, so the disclosure half of this test barely ran',
  );
});

specTest('interop.synthesis-disclosed', () => {
  // §8: "Every synthesized value appears in the export report… An undisclosed synthesis is
  // indistinguishable from data loss."
  //
  // One model carrying every unset field §8's table names, and one assertion per row. Asserting the
  // *row* rather than "the list is non-empty" is the point: a mapper that synthesized silently and
  // disclosed one thing would satisfy the weaker claim.
  const m = gapModel();
  const expectation = [
    ['otm', 'trustRating', 'trust zone rating (synthesize 100)'],
    ['otm', 'risk.confidentiality', 'asset confidentiality (synthesize 0)'],
    ['otm', 'risk.integrity', 'asset integrity (synthesize 0)'],
    ['otm', 'risk.availability', 'asset availability (synthesize 0)'],
    ['otm', 'components[].type', 'component type (synthesize "unknown")'],
    ['otm', 'threats[].risk.likelihood', 'threat likelihood (synthesize 50)'],
    ['otm', 'threats[].risk.impact', 'threat impact (synthesize 50)'],
    ['otm', 'mitigations[].riskReduction', 'control risk reduction (synthesize 0)'],
    ['tml', 'controls[].status', 'control status (synthesize the format default)'],
    ['tml', 'controls[].priority', 'control priority (synthesize the format default)'],
    ['tml', 'threats[].sources', 'empty threat sources (synthesize ["adversary"])'],
    ['tml', 'threats[].event', 'required event string (emit "")'],
    ['tml', 'scope.title', 'required scope title (emit "")'],
  ];

  const reports = {
    otm: TMV.otm.fromCanonical(m, {}),
    tml: TMV.tml.fromCanonical(m, {}),
  };
  for (const [format, field, what] of expectation) {
    const synthesized = (reports[format].report.synthesized || []).map((s) => String(s.field));
    assert.ok(
      synthesized.indexOf(field) !== -1,
      `${format}: the synthesized ${what} (\`${field}\`) is in the export report — the report named ${JSON.stringify(synthesized)}`,
    );
  }
  for (const format of ['otm', 'tml']) {
    assert.equal(reports[format].ok, true, `${format}: every unset field §8 names is synthesized, not blocked`);
    // Counted through the export module rather than off the report, because that is the count the
    // export dialogue shows (REQ-EXP-003), and it is the one that must not fold syntheses into losses.
    const loss = TMV.exporting.lossiness(reports[format].report, format);
    assert.equal(
      loss.synthesized,
      reports[format].report.synthesized.length,
      `${format}: every disclosed synthesis is counted as a synthesis, not as a loss`,
    );
    assert.ok(loss.synthesized >= 8, `${format}: the gap model synthesizes ${loss.synthesized} values`);
    same(
      loss.entries.filter((e) => e.layer === 'synthesized'),
      [],
      `${format}: a synthesized value is never listed among the things that will not survive`,
    );
  }
});

specTest('interop.block-vs-synthesize', () => {
  // §8's two halves, on one model, so that the difference is the only thing that varies: "Synthesize
  // when a neutral default is honest… Block when any value the app could invent would be a false
  // statement."
  //
  // Each row below is a §8 row. `fullModel` has none of the gaps, which is why the synthesis half
  // can assert a clean export rather than the absence of an entry in a longer list.
  const cases = [
    ['a flow with no destination', (m) => M.insert(m, 'dataFlow', { id: 'f', name: 'F', sourceId: 'c', sourceType: 'component' })],
    ['a flow with no source', (m) => M.insert(m, 'dataFlow', { id: 'f', name: 'F', destinationId: 'c', destinationType: 'component' })],
    ['a control with no threats', (m) => M.update(m, 'control', 'k', { threatIds: [] })],
    ['a risk with no threats', (m) => M.update(m, 'risk', 'r', { threatIds: [] })],
    ['a threat with no persona', (m) => M.update(m, 'threat', 't', { personaId: 'nothing' })],
    ['a reference to an entity that is not there', (m) => M.insert(m, 'dataFlow', {
      id: 'f', name: 'F', sourceId: 'c', sourceType: 'component',
      destinationId: 'gone', destinationType: 'component',
    })],
  ];

  // The two formats block different subsets — TML requires a persona and threat references that OTM
  // does not have a field for — so each case names the formats it must block.
  const blocks = {
    'a flow with no destination': ['otm', 'tml'],
    'a flow with no source': ['otm', 'tml'],
    'a control with no threats': ['tml'],
    'a risk with no threats': ['tml'],
    'a threat with no persona': ['tml'],
    'a reference to an entity that is not there': ['otm', 'tml'],
  };

  for (const [what, apply] of cases) {
    for (const format of ['otm', 'tml']) {
      const m = fullModel();
      apply(m);
      const exported = (format === 'otm' ? TMV.otm : TMV.tml).fromCanonical(m, {});
      const shouldBlock = blocks[what].indexOf(format) !== -1;
      assert.equal(
        exported.ok,
        !shouldBlock,
        `${format}: ${what} ${shouldBlock ? 'blocks the export' : 'is exported, because §8 synthesizes rather than blocking'}`,
      );
      if (shouldBlock) {
        assert.ok(exported.blocked.length > 0, `${format}: ${what} says which entity and field to fix`);
        assert.equal(String(exported.blocked[0].message).length > 20, true, `${format}: ${what} explains itself in words`);
      }
    }
  }

  // And the other direction on the same model: a model with no gap at all must export cleanly to
  // both formats, or "blocks" above would be satisfied by a mapper that blocks everything.
  for (const format of ['otm', 'tml']) {
    const exported = (format === 'otm' ? TMV.otm : TMV.tml).fromCanonical(fullModel(), {});
    assert.equal(exported.ok, true, `${format}: a model with no §8 gap exports`);
    same(exported.blocked, [], `${format}: with nothing to report`);
  }
});
