/*
 * export.test.mjs — producing a file from a model.
 *
 * Export is the half of interchange this application cannot get wrong quietly. An import that
 * misreads a document leaves the mistake on screen where its owner can see it; an export that
 * misreads one hands the mistake to someone else, in a file that looks authoritative. So the tests
 * here are mostly about the two things the spec refuses to leave to chance:
 *
 *   The file validates, and it is checked before it is   REQ-EXP-001, REQ-EXP-002, REQ-EXP-010
 *   offered. A mapper bug must not become a delivered
 *   document.
 *   The loss is disclosed, and disclosed from the        REQ-EXP-003
 *   mapping rather than from prose, because a
 *   hand-written list of what does not survive is a
 *   second, unverified description of the mapper.
 *
 * Two of these tests read `dist/threat-model-viewport.html`, which makes them depend on the build
 * having run. That is deliberate rather than inconvenient: REQ-EXP-009 is a claim about *bytes* —
 * the exported file's script must be identical to the one the artifact carries, or the CSP hash in
 * the exported file is wrong and it opens to a content-security error instead of an application.
 * The only way to assert that is against the artifact that ships. `09-testing.md` §5 says the same
 * thing about static analysis for the same reason.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { specTest } from '../lib/check.mjs';
import { loadApp, loadShell, ROOT, seed } from '../lib/app.mjs';
import { makeDom } from '../lib/dom.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { exporting: E, importing: I, model: M, vcs, canonical, container, core } = TMV;

const ALICE = { name: 'Alice', email: 'alice@example.com' };
const NOW = '2020-06-01T00:00:00.000Z';
const EXAMPLES = join(ROOT, 'vendor', 'examples');
const DIST = join(ROOT, 'dist', 'threat-model-viewport.html');

/** The vendored schemas, read the way `build.mjs` inlines them, so a pattern can be quoted exactly. */
const SCHEMAS = {
  otm: JSON.parse(fs.readFileSync(join(ROOT, 'vendor', 'otm_schema.json'), 'utf8')),
  tml: JSON.parse(fs.readFileSync(join(ROOT, 'vendor', 'tml_schema.json'), 'utf8')),
};

/**
 * The built artifact, without which REQ-EXP-008 and REQ-EXP-009 cannot be asserted at all.
 *
 * Read once at module load: it is 1.4 MB, and every test that needs it needs all of it.
 */
if (!fs.existsSync(DIST)) {
  throw new Error(
    `the export tests read the built artifact and ${DIST} does not exist — run \`node build.mjs\` first`,
  );
}
const ARTIFACT = fs.readFileSync(DIST, 'utf8');
const ARTIFACT_SCRIPT = container.extractBlock(ARTIFACT, container.APP_SCRIPT_ID);
const ARTIFACT_BLOCK = container.extractBlock(ARTIFACT, container.BLOCK_ID);
const ARTIFACT_STYLE = /<style>([\s\S]*?)<\/style>/.exec(ARTIFACT)[1];
const ARTIFACT_HASH = E.declaredAppHash(ARTIFACT);

/**
 * The seeded model, minus its deliberately broken flow.
 *
 * `seed()` carries `flow-bad`, whose destination names nothing, because the "Unresolved References"
 * finding needs a row. Export is where that shows up as a *blocked* interchange export — correctly,
 * since a flow with one end missing cannot be written — so a test about the mapping tables has to
 * work from a model that resolves.
 */
function clean() {
  const m = seed(M);
  m.dataFlows = m.dataFlows.filter((f) => f.id !== 'flow-bad');
  return m;
}

function historyOf(m, when) {
  return vcs.initHistory(m, ALICE, 'root', { timestamp: when || NOW });
}

/**
 * The document element as it stands at boot: the static shell, an empty content host, and both
 * data blocks. This is what `exporting.capturePristine` takes a clone of in the real application,
 * and the unit harness does not run the boot sequence, so the test supplies it.
 *
 * The pieces are the artifact's own — the same script text, the same data block, the same declared
 * hash — because that is what makes the byte-identity assertion in `exp.script-byte-identical`
 * mean anything. The rest of the shell is reduced to the hosts the export is sensitive to.
 */
function pristineTree() {
  const doc = makeDom();
  const root = doc.createElement('html');
  const head = doc.createElement('head');
  const body = doc.createElement('body');
  root.appendChild(head);
  root.appendChild(body);

  const hashMeta = doc.createElement('meta');
  hashMeta.setAttribute('name', 'tmv-app-hash');
  hashMeta.setAttribute('content', ARTIFACT_HASH);
  head.appendChild(hashMeta);

  const style = doc.createElement('style');
  style.textContent = ARTIFACT_STYLE;
  head.appendChild(style);

  for (const id of ['tmv-header', 'tmv-content', 'tmv-banners', 'tmv-notifications']) {
    const el = doc.createElement('div');
    el.setAttribute('id', id);
    body.appendChild(el);
  }

  const block = doc.createElement('script');
  block.setAttribute('type', 'application/json');
  block.setAttribute('id', container.BLOCK_ID);
  block.textContent = ARTIFACT_BLOCK;
  body.appendChild(block);

  const app = doc.createElement('script');
  app.setAttribute('id', container.APP_SCRIPT_ID);
  app.textContent = ARTIFACT_SCRIPT;
  body.appendChild(app);

  return root;
}

/** Everything outside the two data blocks — the part a browser would render. */
function markupOf(text) {
  return text
    .replace(container.extractBlock(text, container.BLOCK_ID), '#BLOCK#')
    .replace(container.extractBlock(text, container.APP_SCRIPT_ID), '#APP#');
}

function entryFor(lossiness, kind) {
  return lossiness.entries.filter((e) => e.kind === kind);
}

// -----------------------------------------------------------------------------------------------

specTest('exp.otm-validates', () => {
  // REQ-EXP-001. The AC is about the *document*, so the assertion is made twice: once on the mapped
  // object, and once by re-parsing the text that would actually be written. A mapper can produce a
  // valid object and a broken file — a JSON round trip that drops a key, a serialization that
  // disagrees — and only the second check sees that.
  for (const m of [clean(), M.createEmpty('Untitled', '33333333-4444-4555-8666-777777777777')]) {
    const out = E.interchange(m, 'otm', { history: historyOf(m) });
    assert.equal(out.ok, true, 'an OTM export of this model is offered');
    assert.equal(out.checks.valid, true, JSON.stringify(out.checks.problems));
    assert.equal(out.document.otmVersion, '0.2.0', 'otmVersion names the schema version targeted');
    for (const key of ['otmVersion', 'project']) {
      assert.ok(SCHEMAS.otm.required.includes(key), `the vendored schema still requires ${key}`);
    }
    const reparsed = JSON.parse(out.text);
    const second = I.validateDocument(reparsed, 'otm');
    assert.equal(second.valid, true, JSON.stringify(second.problems));
    assert.equal(second.problems.length, 0, 'the written file validates, not only the mapped object');
  }
});

specTest('exp.tml-validates', () => {
  // REQ-EXP-002. Two models, because the interesting case is the empty one: TML requires nine root
  // arrays and an empty model is the model most likely to be missing one of them.
  const empty = M.createEmpty('Untitled', '44444444-5555-4666-8777-888888888888');
  const cases = [clean(), empty];
  for (const m of cases) {
    const out = E.interchange(m, 'tml', { history: historyOf(m) });
    assert.equal(out.ok, true, JSON.stringify(out.blocked));
    assert.equal(out.checks.valid, true, JSON.stringify(out.checks.problems));
    for (const key of SCHEMAS.tml.required) {
      assert.ok(key in out.document, `the required root property ${key} is emitted`);
    }
    assert.equal(I.validateDocument(JSON.parse(out.text), 'tml').valid, true, 'the written file validates');
  }
  // The nine arrays are emitted empty rather than omitted (06-interchange.md §6.2).
  const arrays = ['trust_zones', 'trust_boundaries', 'actors', 'components', 'data_stores', 'data_sets', 'data_flows'];
  const emptyOut = E.interchange(empty, 'tml', { history: historyOf(empty) });
  for (const key of arrays) {
    assert.ok(Array.isArray(emptyOut.document[key]), `${key} is present and an array even when empty`);
    assert.equal(emptyOut.document[key].length, 0, `${key} is empty for an empty model`);
  }
});

specTest('exp.tml-schema-identifier', () => {
  // REQ-EXP-002's second AC, which is the one that fails silently in other tools: a self-hosted or
  // `raw.githubusercontent.com` `$schema` satisfies the type and fails the pattern, and the failure
  // surfaces in whatever consumer opens the file rather than here.
  const pattern = new RegExp(SCHEMAS.tml.properties.$schema.pattern);
  const m = clean();
  const out = E.interchange(m, 'tml', { history: historyOf(m) });
  const id = out.document.$schema;

  assert.equal(typeof id, 'string');
  assert.ok(pattern.test(id), `$schema ${JSON.stringify(id)} matches the schema's own pattern`);
  assert.ok(!/raw\.githubusercontent\.com/.test(id), 'not a raw.githubusercontent.com URL');
  assert.ok(/^https:\/\/github\.com\/OWASP\//.test(id), 'it is the OWASP repository URL the pattern describes');
  assert.ok(/\/v\d+\.\d+\.\d+\//.test(id), 'and it carries a version segment, not a moving branch');

  // A value the pattern rejects is what the AC is really about, so the assertion above is shown not
  // to be vacuous: a nearby spelling of the same URL fails it.
  assert.equal(pattern.test('https://github.com/OWASP/www-project-threat-model-library/blob/master/threat-model.schema.json'), false);
  assert.equal(pattern.test('https://example.com/threat-model.schema.json'), false);
});

specTest('exp.lossiness-disclosed', () => {
  // REQ-EXP-003. The AC names the concepts a TML-imported model loses on the way to OTM, so the
  // corpus document is imported rather than hand-built: personas, assumptions and trust boundaries
  // are exactly what a TML file from another project carries.
  const TML_TEXT = fs.readFileSync(join(EXAMPLES, 'tml_cryptocurrency-wallet.json'), 'utf8');
  const imported = I.runImport({ text: TML_TEXT, filename: 'tml_cryptocurrency-wallet.json' }, { author: ALICE, now: NOW });
  assert.equal(imported.ok, true, imported.reason || '');

  const out = E.interchange(imported.model, 'otm', { history: imported.history, provenance: null });
  assert.equal(out.ok, true, JSON.stringify(out.blocked));
  const kinds = out.lossiness.entries.map((e) => e.kind);

  for (const concept of ['threatPersonas', 'assumptions', 'trustBoundaries', 'dataSets', 'diagrams']) {
    assert.ok(kinds.includes(concept), `${concept} is reported as not representable by OTM`);
  }
  // CWE / weakness links: the threats entry is the one that carries them, and its reason names them.
  const threats = out.lossiness.entries.find((e) => e.kind === 'threats');
  assert.ok(threats, 'threats carry fields OTM has no home for');
  assert.match(threats.reason, /weaknesses/, 'and the reason says which of them, rather than "some fields"');

  // The risk matrix needs a model that has one. TML's `risks[]` and OTM's per-threat likelihood and
  // impact are the same information in incompatible shapes (06-interchange.md §6.3), so the loss is
  // reported as its own concept rather than folded into the threat.
  const seeded = clean();
  const seededOut = E.interchange(seeded, 'otm', { history: historyOf(seeded) });
  const risks = seededOut.lossiness.entries.find((e) => e.kind === 'risks');
  assert.ok(risks, 'the risk matrix is listed as not representable');
  assert.match(risks.reason, /matrix|score|level/i, 'and the reason names what about it does not survive');

  // AC2: the list is derived from the mapping, not hard-coded. The proof is that it moves with the
  // model — remove the assumptions and the entry goes, because it is counted while the model is
  // walked rather than written down once.
  const before = entryFor(seededOut.lossiness, 'assumptions');
  assert.equal(before.length, 1);
  assert.equal(before[0].count, seeded.assumptions.length, 'the count is the model\'s own');
  const trimmed = core.deepCopy(seeded);
  trimmed.assumptions = [];
  const after = E.interchange(trimmed, 'otm', { history: historyOf(trimmed) });
  assert.equal(entryFor(after.lossiness, 'assumptions').length, 0, 'no assumptions, no entry');
  assert.ok(after.lossiness.total < seededOut.lossiness.total, 'and the total falls with it');
});

specTest('exp.passthrough-roundtrip', () => {
  // REQ-EXP-004. `x-otm` is the bag that makes import non-destructive (ADR-0004): a field the
  // canonical model does not interpret is kept verbatim and put back on export. Without it, opening
  // someone else's OTM file and saving it would silently delete everything this application did not
  // recognise — the failure mode the whole superset design exists to prevent.
  const OTM_TEXT = fs.readFileSync(join(EXAMPLES, 'otm_EXAMPLE.json'), 'utf8');
  const source = JSON.parse(OTM_TEXT);
  const imported = I.runImport({ text: OTM_TEXT, filename: 'otm_EXAMPLE.json' }, { author: ALICE, now: NOW });
  assert.equal(imported.ok, true, imported.reason || '');

  // The bag is populated: unmapped fields were kept rather than dropped at import.
  assert.ok(imported.model.x && imported.model.x.otm, 'the OTM bag survives the import');
  const threat = imported.model.threats.find((t) => t.id === source.threats[0].id);
  assert.ok(threat.x && threat.x.otm, 'a threat keeps the fields OTM does not interpret');

  const out = E.interchange(imported.model, 'otm', { history: imported.history, provenance: null });
  assert.equal(out.ok, true, JSON.stringify(out.blocked));

  // Round trip: what was in the source file is in the exported file.
  same(out.document.project.attributes, source.project.attributes, 'project.attributes comes back');
  const exportedThreat = out.document.threats.find((t) => t.id === source.threats[0].id);
  same(exportedThreat.tags, source.threats[0].tags, 'threat tags come back');

  // And every entity of every kind survives the trip, which is the property, not just those two.
  for (const array of ['trustZones', 'components', 'dataflows', 'assets', 'representations', 'threats', 'mitigations']) {
    const inSource = source[array] || [];
    const inExport = out.document[array] || [];
    assert.equal(inExport.length, inSource.length, `${array} keeps its length`);
    const byId = new Map(inExport.map((x) => [x.id, x]));
    for (const item of inSource) {
      const other = byId.get(item.id);
      assert.ok(other, `${array} keeps ${item.id}`);
      for (const key of Object.keys(item)) {
        if (item[key] === null || item[key] === undefined) continue;
        assert.ok(key in other, `${array}[${item.id}].${key} is re-emitted, not dropped`);
      }
    }
  }

  // AC2: a format whose bag is empty gets no empty bag object. An OTM-shaped hole in a TML document
  // would be worse than useless — a consumer reading it finds a key that means nothing.
  const m = clean();
  const tml = E.interchange(m, 'tml', { history: historyOf(m) });
  assert.equal(tml.ok, true, JSON.stringify(tml.blocked));
  assert.equal(tml.document.extensions, undefined, 'no empty extensions object is written');
  const emptyModel = M.createEmpty('Untitled', '55555555-6666-4777-8888-999999999999');
  const bare = E.interchange(emptyModel, 'otm', { history: historyOf(emptyModel) });
  assert.equal(bare.document.project.attributes, undefined, 'and no empty attributes object either');
});

specTest('exp.tml-id-slug', () => {
  // REQ-EXP-005. TML constrains `symbolic_name` to `^[0-9a-z-]+$`, and canonical ids are not
  // constrained to that. Every id therefore has to be transformed, deterministically, or the export
  // produces a document that fails the schema's own pattern in a field nothing else validates.
  const pattern = new RegExp(SCHEMAS.tml.$defs['symbolic-name'].pattern);
  const m = M.createEmpty('Awkward', '66666666-7777-4888-8999-aaaaaaaaaaaa');
  M.insert(m, 'trustZone', { id: 'Zone One', name: 'Zone One' });
  M.insert(m, 'component', { id: 'Comp.One', name: 'A component' });
  M.insert(m, 'actor', { id: 'Ünïcode Näme', name: 'An actor' });
  M.insert(m, 'dataStore', { id: 'DATA_STORE', name: 'A store' });
  M.insert(m, 'dataSet', { id: 'set/with/slashes', name: 'A set' });
  M.insert(m, 'component', { id: 'trailing---', name: 'Dashes' });

  const out = E.interchange(m, 'tml', { history: historyOf(m) });
  assert.equal(out.ok, true, JSON.stringify(out.blocked));
  assert.equal(out.checks.valid, true, JSON.stringify(out.checks.problems));

  const names = collect(out.document, 'symbolic_name');
  assert.ok(names.length >= 6, 'every entity that carries a symbolic name was reached');
  for (const [path, value] of names) {
    assert.ok(pattern.test(value), `${path} = ${JSON.stringify(value)} matches ${pattern}`);
  }

  // Deterministic: the same model exports to the same names, and the map is stored so that a later
  // export after a rename keeps them (06-interchange.md §4).
  const again = E.interchange(m, 'tml', { history: historyOf(m) });
  assert.deepEqual(collect(again.document, 'symbolic_name'), names, 'a second export allocates the same names');
  assert.ok(m.x && m.x.tml && m.x.tml.symbolicNames, 'the map is recorded in the model');
});

specTest('exp.tml-id-collision-stable', () => {
  // REQ-EXP-005's second AC. Three ids that slug to the same base must get three distinct names, and
  // the assignment must not depend on array order — which is why the allocator sorts by canonical id
  // before it starts. Without the sort the suffix a given entity receives would change when an
  // unrelated row moved, and every external reference to it would silently repoint.
  const m = M.createEmpty('Collide', '77777777-8888-4999-8aaa-bbbbbbbbbbbb');
  M.insert(m, 'component', { id: 'Comp One', name: 'First' });
  M.insert(m, 'component', { id: 'comp_one', name: 'Second' });
  M.insert(m, 'component', { id: 'COMP-ONE', name: 'Third' });

  const out = E.interchange(m, 'tml', { history: historyOf(m) });
  assert.equal(out.ok, true, JSON.stringify(out.blocked));
  const names = out.document.components.map((c) => c.symbolic_name);

  assert.equal(new Set(names).size, 3, `three colliding ids get three names, got ${JSON.stringify(names)}`);
  for (const name of names) assert.match(name, /^comp-one(-\d+)?$/, 'each is a suffixed form of the shared slug');
  assert.ok(names.includes('comp-one'), 'the first keeps the unsuffixed slug');

  // Stable across a re-export, and unchanged by array order.
  const again = E.interchange(m, 'tml', { history: historyOf(m) });
  assert.deepEqual(again.document.components.map((c) => c.symbolic_name), names, 'the same names again');
  const reordered = core.deepCopy(m);
  reordered.components.reverse();
  const shuffled = E.interchange(reordered, 'tml', { history: historyOf(reordered) });
  assert.deepEqual(
    shuffled.document.components.map((c) => c.symbolic_name).slice().sort(),
    names.slice().sort(),
    'reordering the model renames nothing',
  );
});

specTest('exp.native-roundtrip-full-history', () => {
  // REQ-EXP-006: model *and* history, and the AC is specific that the DAG comes back, not the head.
  // A head-only round trip would look correct on every screen and lose every earlier revision, which
  // is the one thing the history exists for.
  const m = clean();
  const history = historyOf(m);
  M.insert(m, 'threat', { id: 'threat-3', name: 'Third threat' });
  assert.equal(vcs.commit(history, m, ALICE, 'Second').ok, true);
  M.insert(m, 'threat', { id: 'threat-4', name: 'Fourth threat' });
  assert.equal(vcs.commit(history, m, ALICE, 'Third').ok, true);

  const out = E.exportNative(m, history);
  assert.equal(out.ok, true);
  assert.equal(out.filename.endsWith('.tmv.json'), true, 'the extension marks it as a container');

  const reparsed = JSON.parse(out.text);
  assert.equal(typeof reparsed.tmvFormat, 'string', 'the container identifies its own format');
  assert.ok(reparsed.history && reparsed.model, 'both the model and the history are in the file');

  const back = I.runImport({ text: out.text, filename: out.filename }, { author: ALICE, now: NOW });
  assert.equal(back.ok, true, back.reason || '');
  assert.equal(back.format, 'native');

  const ids = Object.keys(history.commits);
  assert.equal(ids.length, 3, 'three commits were made');
  assert.equal(Object.keys(back.history.commits).length, 3, 'and three came back');
  assert.equal(back.history.head, history.head, 'at the same head');
  for (const id of ids) {
    assert.ok(id in back.history.commits, `commit ${core.shortId(id)} survived`);
    assert.deepEqual(
      back.history.commits[id].parents,
      history.commits[id].parents,
      `the parent list of ${core.shortId(id)} is unchanged, so the DAG is a DAG and not a chain`,
    );
  }
  assert.equal(container.serialize(back.model), container.serialize(m), 'the head model is the model that was saved');
  assert.equal(vcs.verifyChain(back.history).ok, true, 'and the chain verifies after the trip');
});

specTest('exp.pristine-dom', () => {
  // REQ-EXP-008. The requirement exists because the failure is invisible: exporting the live DOM
  // produces a file that opens, looks right, and contains whatever the user had on screen — a
  // snapshot of a session rather than an application. So the test drives the two halves separately:
  // capture, then render, then export.
  // The live document is the boot-time tree, because that is what a session starts from and what
  // `capturePristine` is handed in the application. A stripped-down stand-in would not do: the
  // export path reads the data block and the app script out of the clone, and their absence is a
  // different test (`EXP_NO_BLOCK`) rather than this one.
  const live = pristineTree();
  const doc = live.ownerDocument;

  assert.equal(E.pristine(), null, 'nothing has been captured yet');
  assert.equal(E.hasPristine(), false);
  assert.equal(E.capturePristine({}), null, 'a document with no cloneable element captures nothing rather than throwing');
  const captured = E.capturePristine({ documentElement: live, doctype: { name: 'html' } });
  assert.ok(captured);
  assert.notEqual(captured, live, 'what is kept is a clone, not the live tree');
  assert.equal(E.hasPristine(), true);

  const m = clean();
  const history = historyOf(m);
  // `generatedAt` is pinned per export so that the two files differ in a known, deterministic way
  // instead of by however many milliseconds apart the two calls happened to land.
  const at = (generatedAt) => ({ expectScript: ARTIFACT_SCRIPT, build: { generatedAt } });
  const before = E.selfExport(m, history, at('2020-06-01T00:00:00.000Z'));

  // Now do to the live tree what a session does: build the rendered rows into it.
  const content = E.findById(live, 'tmv-content');
  assert.ok(content, 'the live tree has the host a session renders into');
  const table = doc.createElement('table');
  table.setAttribute('class', 'cds--data-table');
  const row = doc.createElement('tr');
  const cell = doc.createElement('td');
  cell.textContent = 'Card Store';
  row.appendChild(cell);
  table.appendChild(row);
  content.appendChild(table);
  E.findById(live, 'tmv-header').setAttribute('data-rendered', 'yes');

  const after = E.selfExport(m, history, at('2020-06-01T00:00:01.000Z'));

  // AC1: the exported file has no rendered rows, no table markup, no runtime attributes.
  //
  // Asserted on *elements*, not on the class name: the stylesheet is part of the exported file and
  // legitimately defines `.cds--data-table`, so a substring test for the class would fail against a
  // correct export. What must not be there is a table built out of that class.
  const markup = markupOf(after.text);
  assert.equal(/<table[\s>]/.test(markup), false, 'no rendered table reaches the export');
  assert.equal(/<tr[\s>]|<td[\s>]/.test(markup), false, 'no rendered row or cell reaches the export');
  assert.equal(markup.includes('Card Store'), false, 'no rendered entity row reaches the export');
  assert.equal(markup.includes('data-rendered'), false, 'no runtime-added attribute reaches the export');
  assert.match(markup, /<div id="tmv-content"><\/div>/, 'the content host is empty, as it was at boot');

  // AC2: exporting after extensive interaction produces the same application markup as exporting
  // immediately. The two exports differ only in their data block, which carries a build timestamp.
  assert.equal(markupOf(before.text), markup, 'the shell markup is identical before and after the session');
  assert.notEqual(
    container.extractBlock(before.text, container.BLOCK_ID),
    container.extractBlock(after.text, container.BLOCK_ID),
    'the data block is the only thing that differs, so the comparison above is not vacuous',
  );

  // The pristine copy is consumed by nobody: one export cannot change the next.
  assert.equal(E.pristine(), captured, 'the captured element is still the captured element');
  assert.equal(E.findById(E.pristine(), 'tmv-content').childNodes.length, 0, 'and it is still empty');
});

specTest('exp.script-byte-identical', () => {
  // REQ-EXP-009, and the reason it matters is in 02-architecture.md §5: `script-src` is a hash. If
  // the exported file's script is not byte-identical to the one the hash was computed over, the
  // exported file is an HTML page that refuses to run, and the user finds out by double-clicking it.
  E.setPristineForTest(pristineTree(), '<!DOCTYPE html>');
  const m = clean();
  const out = E.selfExport(m, historyOf(m), { expectScript: ARTIFACT_SCRIPT });

  assert.equal(out.ok, true, JSON.stringify(out.checks.problems));
  const roundScript = container.extractBlock(out.text, container.APP_SCRIPT_ID);
  assert.equal(roundScript, ARTIFACT_SCRIPT, 'the script in the exported file is the artifact\'s script, byte for byte');

  // AC2: the declaration agrees with the content. Both are checked against the artifact's own hash,
  // so the exported file and the artifact make the same claim about the same bytes.
  const declaredInExport = E.declaredAppHash(out.text);
  assert.equal(declaredInExport, E.appHashOf(roundScript), 'the exported file declares the hash of what it carries');
  assert.equal(declaredInExport, ARTIFACT_HASH, 'and it is the same hash the built artifact declares');
  assert.equal(out.checks.ok, true, 'so the pre-download check passes');

  // The style is raw text too, and a serializer that escaped it would invalidate the style hash in
  // exactly the same way. The artifact's style is what has to come back.
  const artifactStyle = /<style>([\s\S]*?)<\/style>/.exec(ARTIFACT);
  const exportStyle = /<style>([\s\S]*?)<\/style>/.exec(out.text);
  assert.ok(artifactStyle && exportStyle, 'both files carry a style element');
  assert.equal(exportStyle[1], artifactStyle[1], 'and the style text is byte-identical as well');
});

specTest('exp.self-verify', () => {
  // REQ-EXP-010. Four assertions, and each has its own failure code, because "the export failed" is
  // not something a user can act on. The AC's second half — a failure *blocks* the offer — is
  // asserted through `exportAs`, which is the path the download button takes.
  E.setPristineForTest(pristineTree(), '<!DOCTYPE html>');
  const m = clean();
  const out = E.selfExport(m, historyOf(m), { expectScript: ARTIFACT_SCRIPT });
  const good = E.verifyExport(out.text, out.container, { expectScript: ARTIFACT_SCRIPT });
  // Compared through primitives and a length rather than `deepEqual` on the object: the value came
  // out of the vm realm, so its `Array.prototype` is not this file's and `deepEqual` would fail with
  // a message about reference equality rather than about the check.
  assert.equal(good.ok, true, `a freshly assembled file verifies, got ${JSON.stringify(good.problems)}`);
  assert.equal(good.problems.length, 0);

  const codes = (html) => E.verifyExport(html, out.container, { expectScript: ARTIFACT_SCRIPT }).problems.map((p) => p.code);
  const block = container.extractBlock(out.text, container.BLOCK_ID);

  // The block re-parses, and re-parses to the same model. Both halves matter: a block that parses to
  // something else is the more dangerous of the two, because it opens.
  assert.ok(codes(out.text.replace(block, '{ not json')).includes('BLOCK_UNPARSEABLE'), 'a block that does not parse is reported');
  const other = JSON.parse(block);
  other.model.name = 'A different model';
  assert.ok(
    codes(out.text.replace(block, TMV.container.escapeForScriptBlock(JSON.stringify(other)))).includes('BLOCK_DIFFERS'),
    'a block that parses to a different model is reported',
  );
  assert.ok(codes(out.text.replace(block, '')).includes('BLOCK_UNPARSEABLE'), 'a file with no block at all is reported');

  // The script, and the hash it declares.
  assert.ok(codes(out.text.replace(ARTIFACT_SCRIPT, ARTIFACT_SCRIPT + '\n/* edited */')).includes('SCRIPT_DIFFERS'));
  assert.ok(codes(out.text.replace(/<meta name="tmv-app-hash"[^>]*>/, '')).includes('NO_DECLARED_HASH'));

  // A file whose declared hash disagrees with its own content is the case the check exists for: a
  // tampered file that otherwise looks perfect.
  const forged = out.text.replace(/name="tmv-app-hash" content="[^"]*"/, 'name="tmv-app-hash" content="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="');
  const forgedCodes = codes(forged);
  assert.ok(forgedCodes.includes('HASH_MISMATCH'), `a false declared hash is caught, got ${forgedCodes}`);

  // And a failure blocks the offer rather than warning about it (AC2).
  const pristine = pristineTree();
  pristine.childNodes[1].appendChild(
    (() => {
      const doc = makeDom();
      return doc.createElement('div');
    })(),
  );
  E.setPristineForTest(pristine, '<!DOCTYPE html>');
  const broken = E.exportAs('html', m, historyOf(m), { expectScript: 'not the artifact script' });
  assert.equal(broken.ok, false, 'a file that fails its check is not offered');
  assert.equal(broken.blocked.length, 0, 'and it is not reported as a model problem either');
  assert.ok(broken.checks.problems.some((p) => p.code === 'SCRIPT_DIFFERS'), 'the reason is the script, and it is reported');
});

specTest('exp.filename-safe', () => {
  // REQ-EXP-011. A filename is the one part of an export a user handles with something other than a
  // browser, so "safe" here means a whitelist: nothing gets through that is not a letter, a digit, a
  // dot or a hyphen.
  const m = clean();
  const history = historyOf(m);
  const name = E.filename(m, 'otm', history);

  assert.match(name, /^[a-z0-9.-]+$/, `${name} needs no escaping on any filesystem`);
  assert.equal(name, E.filename(m, 'otm', history), 'deterministic: the same inputs give the same name');
  assert.equal(name.endsWith('.otm.json'), true, 'the extension identifies the format');
  assert.equal(name.includes(core.shortId(history.head)), true, 'the head commit\'s short id is in the name');

  // Different heads and different models are distinguishable — the property that matters in a
  // downloads folder holding three of these.
  assert.notEqual(E.filename(m, 'tml', history), name, 'the format is part of the name');
  const renamed = core.deepCopy(m);
  renamed.name = 'Something else entirely';
  assert.notEqual(E.filename(renamed, 'otm', history), name, 'the model name is part of it');
  const second = core.deepCopy(m);
  M.insert(second, 'threat', { id: 'threat-9', name: 'Another' });
  const history2 = core.deepCopy(history);
  assert.equal(vcs.commit(history2, second, ALICE, 'Second').ok, true);
  assert.notEqual(E.filename(second, 'otm', history2), name, 'and so is the head, so two heads do not collide');

  // The transformations, including the two that a blacklist would get wrong: a name that is entirely
  // unusable still yields something, and `..` never does.
  assert.equal(E.safeName('Payments Platform'), 'payments-platform');
  assert.equal(E.safeName('  ../CON  '), 'con', 'traversal and separators do not survive');
  assert.equal(E.safeName('x/y\\z:q*?"<>|'), 'x-y-z-q', 'every reserved character becomes a hyphen');
  assert.equal(E.safeName('...'), '', 'and a name that is only dots yields nothing, not a hidden file');
  assert.equal(E.safeName('Ä Ö Ü'), '', 'a name with no ASCII at all yields nothing rather than a guess');
  assert.equal(E.safeName('a'.repeat(90)).length, 60, 'long names are truncated');
  assert.equal(E.safeName(undefined), '', 'a model with no name is not a crash');

  // Where `safeName` gives up, the caller substitutes a fixed base rather than shipping an unnamed file.
  const nameless = core.deepCopy(m);
  nameless.name = '...';
  assert.match(E.filename(nameless, 'otm', history), /^threat-model-otm-/, 'an unusable name falls back to a fixed base');
});

specTest('exp.available-in-degraded-modes', () => {
  // REQ-EXP-013. The AC is a state — storage disabled, working copy dirty — and the claim is that
  // export is unaffected. It is unaffected because nothing in the export path reads storage or the
  // working copy, which is a property that is easy to break by adding one helpful check.
  const shell = loadShell({ dirty: true });
  const { shell: s, TMV: T } = shell;

  // The state, asserted rather than assumed: uncommitted edits exist, and the model is dirty.
  assert.equal(T.shell.logic.dirtyState(s.state().history, s.state().model, true).dirty, true, 'the working copy is dirty');

  // Storage unavailable: the read-only adapter, which is what both a `file://` page opened read-only
  // and a browser refusing storage look like from the save path. It is built through `createAdapter`
  // rather than by replacing a live adapter's `write`, because the adapter closes over its backend at
  // construction — patching the method afterwards changes nothing, and a test that did would be
  // asserting against an adapter that still works.
  const readOnly = T.storage.createAdapter({ readOnly: true }).adapter;
  assert.equal(readOnly.writable(), false, 'the adapter really is unwritable');
  const refused = T.storage.saveModel(readOnly, s.state().history, { modelId: s.state().model.modelId });
  assert.equal(refused.ok, false, 'and a save through it is refused');
  assert.equal(refused.reason, 'read-only');

  // The interchange path and the application path both work anyway. The fixture carries `flow-bad`
  // on purpose (see `clean()` above), and §8 blocks an export that would write its dangling
  // destination into someone else's tool, so the flow it belongs to comes out first: this test is
  // about the export path not reading storage, not about the block.
  s.state().model.dataFlows = s.state().model.dataFlows.filter((f) => f.id !== 'flow-bad');
  T.exporting.setPristineForTest(pristineTree(), '<!DOCTYPE html>');
  const otm = T.exporting.exportAs('otm', s.state().model, s.state().history);
  assert.equal(otm.ok, true, JSON.stringify(otm.blocked));
  assert.ok(otm.text.length > 0, 'the OTM file was assembled');
  const native = T.exporting.exportAs('native', s.state().model, s.state().history);
  assert.equal(native.ok, true);
  assert.ok(native.text.length > 0, 'the container was assembled');

  // And through the screen a user actually has: the Export section renders, its button is enabled,
  // and pressing it is not refused. There is no Blob in this context, so the download falls back —
  // which is REQ-EXP-012's other half, and the path a user without downloads sees.
  s.go('settings', 'export');
  const content = shell.dom.body.querySelectorAll('#tmv-content')[0];
  const button = content.querySelectorAll('[data-action="export-download"]')[0];
  assert.ok(button, 'the export section offers a download');
  assert.equal(button.getAttribute('aria-disabled'), null, 'and it is not disabled in this state');

  T.notify.reset();
  button.click();
  const messages = T.notify.entries();
  assert.equal(
    messages.some((e) => e.ref === 'exp.blocked'),
    false,
    'the export was not refused for a reason to do with the model or the environment',
  );
  const outcome = messages.find((e) => e.ref === 'exp.done' || e.ref === 'exp.fallback');
  assert.ok(outcome, `the export produced an outcome, got ${JSON.stringify(messages.map((e) => e.ref))}`);
  assert.match(outcome.title, /Exported|download/, 'and the outcome names what happened');
});

// -----------------------------------------------------------------------------------------------

/** Every `symbolic_name` in a document, with the path it was found at, for a legible failure. */
function collect(node, key, path = '', acc = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collect(v, key, `${path}/${i}`, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (k === key && typeof node[k] === 'string') acc.push([`${path}/${k}`, node[k]]);
      collect(node[k], key, `${path}/${k}`, acc);
    }
  }
  return acc;
}
