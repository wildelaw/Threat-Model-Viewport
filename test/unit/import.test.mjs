/*
 * import.test.mjs — reading a threat model in from a file someone else made.
 *
 * Import is where this application meets data it did not write, and every REQ-IMP decision follows
 * from one fact: the incoming text is untrusted, and so is everything derived from it. So the tests
 * here are less about the happy path than about the three properties the spec buys by refusing to be
 * clever.
 *
 *   Detection is structural, and says what it expected.   REQ-IMP-002
 *   Validation refuses by default, and the refusal says   REQ-IMP-003
 *   where — the override exists, is explicit, and opens
 *   the model read-only rather than guessing.
 *   Nothing is merged without being asked.                REQ-IMP-007
 *
 * The vendored OTM and TML documents are the corpus. They are real files from real projects, which is
 * what makes them worth importing in a test: they carry the shapes a hand-written fixture would not
 * think to include — nulls where an array belongs, an entity referenced from a place the schema does
 * not reach, a name that is absent rather than empty.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { specTest } from '../lib/check.mjs';
import { loadApp, loadShell, ROOT } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { importing: I, exporting: E, model: M, vcs, canonical, core } = TMV;

const ALICE = { name: 'Alice', email: 'alice@example.com' };
const NOW = '2020-06-01T00:00:00.000Z';
const EXAMPLES = join(ROOT, 'vendor', 'examples');
const OTM_TEXT = fs.readFileSync(join(EXAMPLES, 'otm_EXAMPLE.json'), 'utf8');
const TML_TEXT = fs.readFileSync(join(EXAMPLES, 'tml_husky-ai.json'), 'utf8');
const WALLET_TEXT = fs.readFileSync(join(EXAMPLES, 'tml_cryptocurrency-wallet.json'), 'utf8');

/** A page carrying one data block, spelled so this file contains no script tag of its own. */
function page(jsonText) {
  return (
    `<html><body><${'script'} type="application/json" id="${I.DATA_BLOCK_ID}">` +
    jsonText +
    `</${'script'}></body></html>`
  );
}

/**
 * Let queued `setTimeout` work run — `widgets.readAll` is asynchronous because a real `FileReader`
 * is, and a test that does not wait observes the shell mid-import.
 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The smallest thing that is enough of a `FileReader` for the widget that uses one.
 *
 * The reader is supplied by the page in a browser and by nobody in the `node:vm` context, so the
 * picker and drop paths cannot be exercised without one. Giving the stub a `__text` on the file
 * object is how the test says what the file contains — the widget only ever passes the object
 * straight through.
 */
function installReader(ctx) {
  ctx.FileReader = function FileReader() {
    this.readAsText = (file) => {
      this.result = file.__text;
      setTimeout(() => {
        if (this.onload) this.onload();
      }, 0);
    };
  };
}

/** A `File`-like object: what the reader is handed, and what `readAll` reads off it. */
function file(name, text) {
  return { name, size: text.length, __text: text };
}

function seededHistory(model) {
  return vcs.initHistory(model, ALICE, 'root', { timestamp: NOW });
}

// ---------------------------------------------------------------------------------------------
// Detection — REQ-IMP-002
// ---------------------------------------------------------------------------------------------

specTest('imp.detect-native', () => {
  // REQ-IMP-002's first AC is that detection is structural, "not the filename extension alone". The
  // container is the format the extension lies about most often — it is a `.json` and so is OTM — so
  // the test is the marker pair itself: `tmvFormat` together with a `history`, which no other format
  // has, and which is what makes a native file the only one that can carry a DAG.
  const model = M.createEmpty('Native', '11111111-2222-4333-8444-555555555555');
  const history = seededHistory(model);
  const text = E.exportNative(model, history).text;
  const found = I.detect(text);
  assert.equal(found.format, I.NATIVE, 'a native container is recognised from its own bytes');
  assert.equal(found.html, false, 'and it is not an HTML file');
  assert.equal(found.evidence, 'tmvFormat + history', 'and the markers it used are reported, not just the verdict');

  // The detection takes text and nothing else. That is the AC's "not the filename extension alone"
  // made structural: there is no filename in scope for a later change to start consulting.
  assert.equal(I.detect.length, 1, 'detection is a function of the bytes');

  // And the marker pair is a pair. `tmvFormat` alone is a native-looking JSON document, not a
  // container: without a history there is no DAG, and `runImport` should say it does not recognise
  // this rather than adopt a model with no history to put it in.
  assert.equal(
    I.detect(JSON.stringify({ tmvFormat: '1.0.0', model: { name: 'Half a container' } })).format,
    I.UNKNOWN,
    'a version field with no history is not a container',
  );
});

specTest('imp.detect-html', () => {
  // REQ-IMP-002 names exported HTML as a format in its own right, and REQ-IMP-008 makes the reason
  // concrete: an exported threat model is an HTML file, so a user who opens one in a text editor and
  // imports it is doing the most natural thing in the world. `html` is a *modifier* on the detection
  // rather than a format — the payload inside is a native container — so both facts are asserted.
  const model = M.createEmpty('Embedded', '11111111-2222-4333-8444-555555555555');
  const history = seededHistory(model);
  const container = E.exportNative(model, history).container;
  const html = page(canonical.serialize(container));

  const found = I.detect(html);
  assert.equal(found.html, true, 'the file is an HTML document');
  assert.equal(found.format, I.NATIVE, 'and the model inside it is a native container');
  assert.match(found.evidence, /html/, 'the evidence says the container was found inside a page');
  assert.match(found.evidence, /tmvFormat/, 'and that the markers were found, rather than assumed');

  // The block is extracted as text and parsed as JSON. Nothing in this path builds a document
  // (REQ-IMP-008), and the extraction is the assertion that says so: it returns a string.
  const block = I.extractDataBlock(html);
  assert.equal(typeof block, 'string', 'the block is handed back as text, never as parsed markup');
  assert.equal(JSON.parse(block).model.name, 'Embedded');

  // An HTML file with no block is HTML and not a model. That distinction is the whole of
  // `imp.detect-unknown`'s "clear error naming what was expected" for this case: the user is told the
  // file looks like a page but has no data block, rather than that it is unparseable.
  const bare = I.detect('<html><head><title>Notes</title></head><body><p>Hi</p></body></html>');
  assert.equal(bare.format, I.UNKNOWN);
  assert.equal(bare.html, true, 'still recognised as HTML…');
  assert.ok(
    /data block/i.test(bare.reason) && bare.reason.includes(I.DATA_BLOCK_ID),
    'and the reason names the block id it looked for',
  );
});

specTest('imp.detect-otm', () => {
  const found = I.detect(OTM_TEXT);
  assert.equal(found.format, I.OTM, 'the vendored OTM document is recognised as OTM');
  assert.equal(found.html, false);

  // Detection reads structure, so it works before the schema has been consulted — which is what
  // REQ-IMP-002 asks for when it says "before parsing to a model". A document that detects as OTM and
  // then fails validation is a *validation* failure, and `imp.invalid-reports-paths` covers that.
  assert.equal(
    I.detect(JSON.stringify({ otmVersion: '0.2.0', project: { name: 'P' } })).format,
    I.OTM,
    'a bare version field is enough to know which schema to check against',
  );

  // The second marker: `trustZones` and `dataflows` together identify OTM even with the version
  // field missing, which is what an older exporter's output looks like.
  const unversioned = JSON.parse(OTM_TEXT);
  delete unversioned.otmVersion;
  const found2 = I.detect(JSON.stringify(unversioned));
  assert.equal(found2.format, I.OTM, 'structure identifies the format when the version field does not');
  assert.match(found2.evidence, /trustZones|dataflows/);
});

specTest('imp.detect-tml', () => {
  const found = I.detect(TML_TEXT);
  assert.equal(found.format, I.TML, 'the vendored TML document is recognised as TML');
  assert.equal(found.html, false);

  // TML identifies itself by `$schema` naming the threat-model-library, and by `trust_zones` when
  // the `$schema` has been stripped — two markers because a TML document is the one most likely to
  // arrive after a round trip through something that drops the `$schema` key.
  const doc = JSON.parse(TML_TEXT);
  assert.match(String(doc.$schema), /threat-model-library/, 'the vendored document names the schema');

  const stripped = JSON.parse(TML_TEXT);
  delete stripped.$schema;
  const found2 = I.detect(JSON.stringify(stripped));
  assert.equal(found2.format, I.TML, 'the snake_case structural marker is enough on its own');
  assert.match(found2.evidence, /trust_zones/);
});

specTest('imp.detect-unknown', () => {
  // REQ-IMP-002: "An unrecognised format produces a clear error naming what was expected." The
  // assertion is on the *content* of the message, not its presence: a failure that says "invalid
  // file" makes the user guess, and guessing is what the requirement exists to prevent.
  //
  // There are two kinds of not-a-threat-model and they have different fixes, so they get different
  // messages. Conflating them is the common failure — "invalid file" for both leaves the user
  // unable to tell a corrupt download from a file that was never a threat model.
  const unparseable = [
    ['prose', 'this is a README, not a threat model'],
    ['empty', ''],
    ['truncated JSON', '{"tmvFormat":"1.0.0",'],
  ];
  for (const [label, text] of unparseable) {
    const found = I.detect(text);
    assert.equal(found.format, I.UNKNOWN, `${label} is not recognised`);
    assert.equal(found.parseError, true, `${label} is reported as unparseable`);
    assert.match(found.reason, /not valid JSON/i, `${label}: and the message says which problem it is`);
  }

  const wrongShape = [
    ['JSON of the wrong shape', JSON.stringify({ hello: 'world' })],
    ['a version with no history', JSON.stringify({ tmvFormat: '1.0.0' })],
  ];
  for (const [label, text] of wrongShape) {
    const found = I.detect(text);
    assert.equal(found.format, I.UNKNOWN, `${label} is not recognised`);
    assert.equal(found.parseError, undefined, `${label} parsed; the problem is what it is`);
    assert.match(
      found.reason,
      /native file/i,
      `${label}: the message names the formats that were expected`,
    );
    assert.match(found.reason, /Threat Model Library/, `${label}: including TML`);
    assert.match(found.reason, /Open Threat Model/, `${label}: and OTM`);
  }

  // A third kind, and the message for it is different again: JSON that parses to something that is
  // not an object cannot be compared against any of the three shapes, so naming them would be noise.
  for (const [label, value] of [['a JSON array', [1, 2, 3]], ['a JSON string', 'hello'], ['null', null]]) {
    const found = I.detect(JSON.stringify(value));
    assert.equal(found.format, I.UNKNOWN, `${label} is not recognised`);
    assert.match(found.reason, /not a JSON object/i, `${label}: and it says which problem that is`);
  }

  // The two markers each format is recognised by are named in the message, so the user can look at
  // their file and see which one is missing.
  const wrong = I.detect(JSON.stringify({ tmvFormat: '1.0.0' }));
  assert.match(wrong.reason, /history/, 'a native-looking document is told what it is missing');
  assert.match(wrong.reason, /trustZones/, 'and what the other two look like');
  assert.match(wrong.reason, /trust_zones/, 'in both spellings, since that is the difference');
});

// ---------------------------------------------------------------------------------------------
// Validation — REQ-IMP-003
// ---------------------------------------------------------------------------------------------

specTest('imp.validate-offline', () => {
  // REQ-IMP-003 AC1: "Validation runs offline with no schema fetch." Two assertions, because either
  // alone is satisfiable by accident.
  //
  // First: the schema in use is the vendored file, byte for byte. A copy that had been edited, or a
  // subset the app invented, would pass a test that only checked "a schema exists".
  const vendored = JSON.parse(fs.readFileSync(join(ROOT, 'vendor', 'otm_schema.json'), 'utf8'));
  const bundled = I.schemaFor(I.OTM);
  same(bundled, vendored, 'the OTM schema the app validates against is the vendored one');

  // Second: validation completes with every network primitive removed from the context. This is the
  // assertion that has teeth — it cannot pass by the fetch simply not having been reached yet on a
  // fast connection, because there is nothing left to reach for.
  const { TMV: fresh, context } = loadApp();
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
    delete context[name];
  }
  if (context.navigator) delete context.navigator.sendBeacon;

  const good = fresh.importing.validateDocument(JSON.parse(OTM_TEXT), 'otm');
  assert.equal(good.valid, true, 'a valid document validates with no network available');
  assert.equal(good.problems.length, 0);

  const bad = fresh.importing.validateDocument({ otmVersion: '0.2.0', project: { name: 'P' } }, 'otm');
  assert.equal(bad.valid, false, 'and an invalid one is still caught, so the check ran');

  // A format with no schema is refused outright rather than validated against nothing. The native
  // container is checked structurally by `container.inspect`, not by a JSON Schema, and saying so is
  // better than silently returning `valid: true` for a document nobody checked.
  assert.throws(() => I.schemaFor(I.NATIVE), (err) => err.code === 'SCHEMA_UNKNOWN');
});

specTest('imp.invalid-reports-paths', () => {
  // REQ-IMP-003 AC2: "a document failing validation reports the failing paths and imports nothing."
  // The second half is the load-bearing one — an import that half-succeeds is worse than one that
  // refuses, because the user cannot tell which half they have.
  const broken = JSON.parse(OTM_TEXT);
  broken.project = { name: 'No id here' };
  delete broken.trustZones[0].risk; // the schema requires a risk on every trust zone
  const text = JSON.stringify(broken);

  const result = I.runImport({ text, filename: 'broken.otm.json' }, {});
  assert.equal(result.ok, false, 'an invalid document is not imported');
  assert.equal(result.blocked, true);
  assert.equal(result.model, null, 'and no model is produced at all');
  assert.equal(result.history, null);
  assert.ok(result.problems.length >= 2, 'both violations are reported, not just the first');
  assert.match(result.reason, /does not match its schema \(2 problems\)/);

  // A problem is a path, a keyword and a sentence. The path is what makes it actionable — the user
  // can go and look at `/project` — and the keyword is what makes it *checkable* rather than a
  // second guess at what the schema meant.
  for (const problem of result.problems) {
    assert.equal(typeof problem.path, 'string');
    assert.ok(problem.path.startsWith('/'), `${problem.path} is a JSON pointer`);
    assert.equal(typeof problem.keyword, 'string');
    assert.ok(problem.message.length > 0);
  }
  assert.ok(
    result.problems.some((p) => p.path === '/project' && p.keyword === 'required'),
    'the missing id is reported where it is missing',
  );
  assert.ok(
    result.problems.some((p) => p.path === '/trustZones/0' && p.keyword === 'required'),
    'and so is the second violation, which is the point of reporting all of them',
  );

  // "Imports nothing" is a claim about the shell as well as about the mapper: the model on screen is
  // the one that was there before, untouched.
  const { dom, TMV: shellTMV, shell } = loadShell({});
  const before = shell.state().model;
  const refusal = shell.importEntries([{ name: 'broken.otm.json', size: text.length, text }]);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'invalid');
  assert.equal(shell.state().model, before, 'the model on screen is the same object it was');
  assert.equal(shell.state().history.commits.length, 1, 'and its history is untouched');

  // The refusal is a screen, not a toast: it has to be read before it can be answered, so it holds
  // the failures, the override and the cancel until the user chooses one. A notification that
  // scrolled away would leave an unexplained missing model behind it.
  assert.ok(dom.body.textContent.includes('does not match its schema'));
  const failureScreen = dom.body.querySelector('.cds--modal');
  assert.ok(failureScreen, 'the refusal is shown where it can be answered');
  assert.ok(failureScreen.textContent.includes('/project'), 'with the failing path in it');
  same(
    dom.body.querySelectorAll('.cds--modal [data-action]').map((node) => node.getAttribute('data-action')),
    ['cancel', 'override'],
    'and the two answers it offers',
  );
  assert.equal(shellTMV.importing.lastReport(), refusal.result, 'the report is retained even for a refusal');
});

specTest('imp.invalid-override-readonly', () => {
  // REQ-IMP-003 AC3: the refusal offers "Import anyway (limited)", which states that the model will
  // be read-only **for re-export to that format** until the violations are resolved.
  //
  // The mechanism the app uses to make that true is `setEditable(false)`: the model cannot be edited
  // or committed, so the invalid data cannot be quietly mutated into something that looks fixed, and
  // what is exported is exactly what arrived. So the test asserts the editable state and the reason
  // the user is shown — and then asserts the thing that must *not* be restricted, because a viewport
  // whose purpose is to read what someone sent would be useless if it refused to pass it on.
  const broken = JSON.stringify({
    otmVersion: '0.2.0',
    project: { name: 'P' },
    trustZones: [{ id: 'z', name: 'Z', trustRating: 'high' }],
  });

  const { dom, TMV: shellTMV, shell } = loadShell({});
  const refusal = shell.importEntries([{ name: 'broken.otm.json', size: broken.length, text: broken }]);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'invalid');
  assert.equal(refusal.result.readOnly, false, 'the refusal itself is not read-only — nothing was opened');

  // The offer is a real offer, with the sentence the requirement specifies.
  const override = dom.body.querySelector('.cds--modal [data-action="override"]');
  assert.ok(override, 'the refusal offers an override');
  assert.equal(override.textContent.trim(), 'Import anyway (limited)');
  assert.ok(dom.body.textContent.includes('does not match its schema'));

  const editableBefore = shell.state().editable;
  assert.equal(editableBefore, true, 'and until it is taken, the model on screen is still editable');

  override.click();

  assert.equal(shell.state().model.name, 'P', 'taking the override opens the model');
  assert.equal(shell.state().editable, false, 'read-only');
  assert.match(
    shell.state().readOnlyReason,
    /read-only for re-export to that format/,
    'and the reason says which restriction this is',
  );

  // Read-only means the editing surface is closed, at the point where consent would be given: no
  // dialog is even opened, and the refusal says why rather than the button being quietly dead.
  const before = shell.state().history.head;
  assert.equal(shell.commit(), null, 'committing a read-only model opens no dialog');
  assert.equal(shell.state().history.head, before, 'and nothing was committed');
  const refusalNotice = shellTMV.notify.latestError();
  assert.ok(refusalNotice, 'the refusal is reported rather than silently doing nothing');
  assert.match(refusalNotice.title, /cannot be committed here/);
  assert.match(String(refusalNotice.detail), /read-only for re-export to that format/);

  // And the model is still readable and still exportable, which is the whole reason the override
  // exists. Exporting does not add anything the incoming document did not already contain.
  const out = shellTMV.exporting.interchange(shell.state().model, 'otm', { history: shell.state().history });
  assert.equal(out.ok, true, 'the model can still be passed on to whatever comes next');
  assert.equal(out.document.trustZones[0].name, 'Z', 'carrying what arrived, unchanged');
});

// ---------------------------------------------------------------------------------------------
// Integrity, history and provenance — REQ-IMP-004 … 006
// ---------------------------------------------------------------------------------------------

specTest('imp.dangling-refs-warn', () => {
  // REQ-IMP-004: neither interchange schema enforces referential integrity, so the app checks it
  // itself, imports anyway, and marks the reference unresolved. Importing anyway is the point —
  // refusing would reject many real documents — and marking it is what stops the reference becoming
  // invisible.
  //
  // The vendored TML document has a real one: a `threatApplication` targeting a component that is not
  // in the file. That is the case the requirement is about, and the mapper's answer to it is the one
  // worth asserting — the reference *value* stays in the model, with a warning that says what it
  // expected to find.
  const result = I.runImport({ text: WALLET_TEXT, filename: 'wallet.tml.json' }, {});
  assert.equal(result.ok, true, 'a dangling reference does not stop the document importing');
  assert.equal(result.problems.length, 0, 'and it is not reported as an error');
  assert.equal(result.readOnly, false, 'nor does it make the model read-only — that is for schema failures');

  const warning = result.warnings.find((w) => w.keyword === 'REF_DANGLING');
  assert.ok(warning, 'the reference is reported as a warning');
  assert.equal(warning.severity, 'warning', 'a warning, not an error');
  assert.equal(warning.path, '/threatApplications/1/targetId');
  assert.match(warning.message, /store-wallet-file/, 'the message names what could not be resolved');

  const unresolved = result.unresolved[0];
  assert.equal(unresolved.type, 'threatApplications', 'which entity');
  assert.equal(unresolved.field, 'targetId', 'which field');
  assert.equal(unresolved.id, 'store-wallet-file', 'and what it names');
  same(unresolved.expected, ['components'], 'including what it could have named instead');

  // "Visible in the UI, not silently dropped" is a claim about the model, not only the report: the
  // application that points at the absent component is still there, still pointing at it. A mapper
  // that pruned the row would leave a threat that appears to apply to nothing, which is a different
  // and worse lie than a reference the reader is told about.
  const application = result.model.threatApplications.find((a) => a.targetId === 'store-wallet-file');
  assert.ok(application, 'the entity carrying the dangling reference is still in the model');
  assert.equal(application.targetType, 'component', 'with what it expected to be');
  assert.equal(application.threatId, 'wallet-file-theft', 'and the rest of the row intact');

  // The OTM mapper answers the same situation differently, and deliberately: an OTM flow endpoint
  // that names an absent component has no *type* to derive, so there is nothing to keep — the end is
  // removed and recorded. Reported either way, which is what the requirement asks for; the assertion
  // here is that the report is what tells the two cases apart.
  const doc = JSON.parse(OTM_TEXT);
  doc.dataflows[0].destination = 'component-that-is-not-there';
  const otm = I.runImport({ text: JSON.stringify(doc), filename: 'dangling.otm.json' }, {});
  assert.equal(otm.ok, true, 'the OTM document imports too');
  assert.equal(otm.model.dataFlows.length, doc.dataflows.length, 'and its flows survive');
  const dangling = otm.unresolved.find((u) => u.target === 'component-that-is-not-there');
  assert.ok(dangling, 'with the removed reference named in the report rather than vanishing');
  assert.equal(dangling.field, 'destinationId');
  assert.match(dangling.path, /^\/dataFlows\/\d+\/destinationId$/, 'at a path the UI can point at');
});

specTest('imp.root-commit', () => {
  // REQ-IMP-005: "an imported interchange model shall become a new model with a single root commit.
  // No history shall be fabricated." Interchange has no history to carry, so inventing one — a
  // "first draft" commit, an "import" commit before the import — would be inventing a claim about
  // what happened. There is exactly one commit and it is the root.
  const result = I.runImport({ text: OTM_TEXT, filename: 'otm_EXAMPLE.json' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.history.commits.length, 1, 'exactly one commit');

  const root = result.history.commits[0];
  assert.deepEqual(Array.from(root.parents || []), [], 'and it has no parents, so it is a root');
  assert.equal(result.history.head, root.id, 'which is the head');
  assert.equal(vcs.verifyChain(result.history).ok, true, 'and the chain verifies');
  assert.equal(vcs.isAncestor(result.history, root.id, root.id), true);

  // A native container is the other half of the rule, and it is the contrast that makes "no
  // fabrication" mean something: a container *has* history, so the app adopts it rather than
  // rebuilding it — the DAG is the thing the user is trying to preserve.
  const model = M.createEmpty('Carried', '11111111-2222-4333-8444-555555555555');
  const history = seededHistory(model);
  const working = core.deepCopy(vcs.headModel(history));
  M.insert(working, 'threat', { id: 't-1', name: 'A threat' });
  vcs.commit(history, working, ALICE, 'add a threat', { timestamp: NOW });
  const nativeText = E.exportNative(model, history).text;

  const carried = I.runImport({ text: nativeText, filename: 'carried.tmv.json' }, {});
  assert.equal(carried.ok, true);
  assert.equal(carried.history.commits.length, 2, 'a container keeps the history it arrived with');
  assert.equal(carried.history.head, history.head, 'at the same head');
  assert.equal(carried.model.threats.length, 1, 'and the head model is the one that was committed');
});

specTest('imp.provenance-recorded', () => {
  // REQ-IMP-006: format, schema version, filename, content hash and timestamp are recorded in the
  // model's passthrough bag, so provenance survives re-export. Recording it *on the model* rather
  // than in a side table is what makes it survive: the model is the thing that gets saved, exported
  // and copied between machines.
  const result = I.runImport({ text: OTM_TEXT, filename: 'otm_EXAMPLE.json' }, {});
  const recorded = result.provenance;
  assert.equal(recorded.format, 'otm/0.2.0', 'the format and the version it was written to');
  assert.equal(recorded.sourceHash, 'sha256:' + TMV.hash.hex(OTM_TEXT), 'the hash is of the bytes that arrived');
  assert.match(recorded.importedAt, /^\d{4}-\d{2}-\d{2}T/, 'and when');
  assert.equal(recorded.tool, 'threat-model-viewport');
  assert.equal(recorded.modelId, result.model.modelId, 'naming the model it was read into');

  // It is in the passthrough bag, under the format's own prefix, so a reader of either interchange
  // format sees it without knowing anything about this application.
  assert.ok(result.model.x && result.model.x.tmv, 'recorded in the passthrough bag');
  assert.equal(result.model.x.tmv.format, 'otm/0.2.0');

  // And re-export emits it, namespaced with the prefix the OTM mapper declares — which is asserted
  // rather than assumed, because a provenance record written under one prefix and read under another
  // is a round trip that silently loses it.
  assert.equal(TMV.otm.PROVENANCE_PREFIX, 'tmv:');
  const out = E.interchange(result.model, 'otm', { history: result.history });
  assert.equal(out.ok, true);
  const attributes = out.document.project.attributes;
  assert.equal(attributes['tmv:format'], 'otm/0.2.0');
  assert.equal(attributes['tmv:sourceHash'], recorded.sourceHash);
  assert.equal(attributes['tmv:modelId'], result.model.modelId);

  // The filename travels too. It is the only record of which file on disk this model came from, and
  // it is stored in the bag rather than in a side table so that a model copied to another machine
  // still says where it started.
  assert.equal(attributes['tmv:filename'], 'otm_EXAMPLE.json');

  // Reading that export back restores the model id, which is what makes an export re-adoptable
  // rather than a new model every time it is passed around.
  const again = I.runImport({ text: out.text, filename: 'again.otm.json' }, {});
  assert.equal(again.model.modelId, result.model.modelId, 'the model id survives the round trip');
  assert.equal(again.modelIdRestored, true, 'and the report says it was restored rather than minted');
});

// ---------------------------------------------------------------------------------------------
// The shell's part — REQ-IMP-001, 007, 009, 010
// ---------------------------------------------------------------------------------------------

specTest('imp.picker', async () => {
  // REQ-IMP-001's first path. The picker is a hidden `input[type=file]` behind a drop-styled button,
  // which is the Carbon idiom and also the only one that works: `file://` pages cannot open a native
  // chooser any other way.
  const { dom, ctx, TMV: shellTMV, shell } = loadShell({});
  installReader(ctx);
  shell.go('settings', 'import');

  const input = dom.body.querySelector('#tmv-import-file');
  assert.ok(input, 'the settings view renders the file input');
  assert.equal(input.getAttribute('type'), 'file');
  assert.ok(
    input.getAttribute('class').includes('cds--visually-hidden'),
    'hidden, because the visible affordance is the styled button',
  );
  const accept = input.getAttribute('accept');
  assert.match(accept, /\.json/, 'the chooser filters to the formats that can be read');
  assert.match(accept, /\.html/, 'including exported application files');
  assert.ok(!/\*/.test(accept), 'and it does not accept everything, so the filter means something');

  // The visible affordance is a button in everything but tag name, and activating it opens the
  // chooser. Asserted by counting clicks on the input, because that is the only observable effect a
  // native file chooser has in a test.
  const button = dom.body.querySelector('.cds--file__drop-container');
  assert.equal(button.getAttribute('role'), 'button');
  assert.equal(button.getAttribute('tabindex'), '0', 'and it is reachable by keyboard');
  let opened = 0;
  const count = () => {
    opened++;
  };
  input.addEventListener('click', count);
  button.click();
  assert.equal(opened, 1, 'clicking the button opens the chooser');
  button.dispatch('keydown', { key: 'Enter' });
  assert.equal(opened, 2, 'and so does Enter, for a keyboard user');

  // Choosing a file runs the real path: read, detect, validate, adopt.
  const before = shell.state().model;
  input.files = [file('otm_EXAMPLE.json', OTM_TEXT)];
  input.dispatch('change');
  await settle();
  await settle();

  assert.notEqual(shell.state().model, before, 'the chosen file replaced the model on screen');
  assert.equal(shell.state().model.name, 'Test project');
  assert.equal(shell.state().history.commits.length, 1, 'as a new model with one root commit');
  assert.equal(shellTMV.importing.lastReport().format, 'otm', 'and the import report was retained');
});

specTest('imp.drag-drop', async () => {
  // REQ-IMP-001's second path. A drop target has one job beyond accepting the drop: saying that it
  // will, before the user lets go — so the highlight is asserted on the way in and its removal on the
  // way out, including the case that a naive implementation gets wrong, a drag leaving the element
  // for one of its own children.
  const { dom, ctx, TMV: shellTMV, shell } = loadShell({});
  installReader(ctx);
  const zone = dom.body.querySelector('#tmv-content');
  assert.ok(zone, 'the content area is the drop target');

  const highlighted = () => String(zone.getAttribute('class') || '').includes('tmv-drop-target');
  assert.equal(highlighted(), false, 'nothing is highlighted to begin with');

  zone.dispatch('dragover', { dataTransfer: {} });
  assert.equal(highlighted(), true, 'dragging over the content area says a drop will be accepted');

  zone.dispatch('dragleave', {});
  assert.equal(highlighted(), false, 'and leaving takes it back');

  zone.dispatch('dragover', { dataTransfer: {} });
  const before = shell.state().model;
  zone.dispatch('drop', { dataTransfer: { files: [file('otm_EXAMPLE.json', OTM_TEXT)] } });
  assert.equal(highlighted(), false, 'the highlight goes when the drop lands');

  await settle();
  await settle();
  assert.notEqual(shell.state().model, before, 'and the dropped file is imported');
  assert.equal(shell.state().model.name, 'Test project');

  // A drop of something unreadable is refused with the same reasoning the picker would give. The
  // drop path is not a way around detection.
  const refusal = shell.importEntries([{ name: 'notes.txt', size: 12, text: 'hello there' }]);
  assert.equal(refusal.ok, false);
  assert.match(String(refusal.reason), /not valid JSON/i, 'and it says why');
  assert.equal(shell.state().model.name, 'Test project', 'the model is unchanged');
  assert.equal(shellTMV.importing.lastReport().ok, false, 'the refusal is the retained report now');
});

specTest('imp.no-silent-merge', () => {
  // REQ-IMP-007. Importing a document whose model id is already in this browser is the one case
  // where "just open it" is destructive: the stored copy is the user's, and the incoming document
  // may be older, newer, or unrelated-but-same-id. So it cannot be resolved by looking at the
  // content — it needs a decision only the user can make.
  //
  // The document used here is an interchange export rather than a container, because that is the
  // case where the question has two workable answers. A container's model id is inside every commit
  // it carries, so "import as a new model" would mean rewriting the chain — the contrast at the end
  // asserts that the app refuses rather than doing that.
  const { dom, TMV: shellTMV, shell, adapter } = loadShell({});
  const model = M.createEmpty('Shared id', '11111111-2222-4333-8444-555555555555');
  const history = seededHistory(model);
  const exported = E.interchange(model, 'otm', { history });
  assert.equal(exported.ok, true, 'the fixture exports, so its provenance carries the id');

  const first = shell.importEntries([{ name: exported.filename, size: exported.bytes, text: exported.text }]);
  assert.equal(first.ok, true, 'the first import of an id nobody has seen just opens it');
  assert.equal(first.stored, true, 'and it is stored');
  assert.equal(shell.state().model.modelId, '11111111-2222-4333-8444-555555555555', 'under the id it arrived with');
  same(
    shellTMV.storage.listModels(adapter).map((entry) => entry.modelId),
    ['11111111-2222-4333-8444-555555555555'],
    'the registry has it',
  );

  // The second import of the *same id* prompts. It does not merge, and it does not overwrite.
  const storedBefore = TMV.storage.loadModel(adapter, '11111111-2222-4333-8444-555555555555');
  const second = shell.importEntries([{ name: exported.filename, size: exported.bytes, text: exported.text }]);
  assert.equal(second.ok, false, 'the second import is not performed on its own');
  assert.equal(second.reason, 'prompted', 'it asks first');

  const actions = dom.body.querySelectorAll('.cds--modal [data-action]').map((node) => node.getAttribute('data-action'));
  same(actions, ['cancel', 'replace', 'new'], 'both answers are offered, and cancel is one of them');
  assert.ok(dom.body.textContent.includes('That model is already open in this browser'));

  // Nothing has happened yet. A prompt that had already changed something would not be a prompt.
  const storedAfterPrompt = TMV.storage.loadModel(adapter, '11111111-2222-4333-8444-555555555555');
  assert.equal(storedAfterPrompt.history.head, storedBefore.history.head, 'nothing was written while it waited');

  // Cancel is the default answer and it leaves both copies alone — the honest outcome, since the one
  // thing the app can be sure of is that it does not know which copy the user wants.
  dom.body.querySelector('.cds--modal [data-action="cancel"]').click();
  const afterCancel = TMV.storage.loadModel(adapter, '11111111-2222-4333-8444-555555555555');
  assert.equal(afterCancel.history.head, storedBefore.history.head, 'cancelling changed nothing');
  assert.equal(shellTMV.storage.listModels(adapter).length, 1, 'and the registry still has one entry');

  // "Import as a new model" is the explicit answer that says: keep both. A new id is minted, so the
  // registry can hold both entries — `05-storage.md` keys stored models by id, and two entries
  // sharing one would be a collision the registry cannot represent.
  const third = shell.importEntries([{ name: exported.filename, size: exported.bytes, text: exported.text }]);
  assert.equal(third.reason, 'prompted');
  dom.body.querySelector('.cds--modal [data-action="new"]').click();
  assert.equal(shellTMV.storage.listModels(adapter).length, 2, '"Import as a new model" made a second entry');
  assert.notEqual(
    shell.state().model.modelId,
    '11111111-2222-4333-8444-555555555555',
    'with an id of its own',
  );
  const kept = TMV.storage.loadModel(adapter, '11111111-2222-4333-8444-555555555555');
  assert.equal(kept.ok, true, 'and the saved copy is still there');
  assert.equal(kept.history.head, storedBefore.history.head, 'unchanged');

  // The container case, which is the one that cannot be answered. A container carries its own
  // history, and its model id is hashed into every commit in it: relabelling the head would make
  // every commit id a lie. Importing it as a new model is refused, and refused with an explanation —
  // silently rewriting the chain would destroy the one thing the format exists to carry.
  const native = E.exportNative(model, history);
  const fourth = shell.importEntries([{ name: native.filename, size: native.bytes, text: native.text }]);
  assert.equal(fourth.reason, 'prompted', 'a container with a known id prompts too');
  dom.body.querySelector('.cds--modal [data-action="new"]').click();
  assert.equal(shellTMV.storage.listModels(adapter).length, 2, 'and it is not stored under a second id');
  const refusal = shellTMV.notify.latestError();
  assert.ok(refusal, 'the refusal is reported rather than the button quietly doing nothing');
  assert.match(refusal.title, /could not be imported/i);
  assert.match(String(refusal.detail), /cannot replace this one|different model/i);

  // Replacing, by contrast, is exactly what a container is for, and it keeps the chain it arrived
  // with rather than rebuilding it.
  const fifth = shell.importEntries([{ name: native.filename, size: native.bytes, text: native.text }]);
  assert.equal(fifth.reason, 'prompted');
  dom.body.querySelector('.cds--modal [data-action="replace"]').click();
  assert.equal(shellTMV.storage.listModels(adapter).length, 2, 'replacing does not add an entry');
  assert.equal(shell.state().model.modelId, '11111111-2222-4333-8444-555555555555', 'the id is the one that arrived');
  assert.equal(shell.state().history.head, history.head, 'and so is the head');
});

specTest('imp.roundtrip-stable', () => {
  // REQ-IMP-009: "Importing a document that the application itself exported shall reproduce the same
  // canonical model, so repeated round trips do not drift."
  //
  // There is one honest exception, and it is the one the mapper reports rather than hides: OTM's
  // nested threat instance carries no id, so the `threatApplication` join entity is given a fresh one
  // on every import (`generatedIds` in the mapping report). A test that asserted byte equality would
  // fail, and a test that asserted nothing would be worthless — so this masks exactly the ids the
  // report declares, and asserts full equality of everything else, over *three* passes rather than
  // two. Three is what makes "does not drift" mean something: two passes can agree by luck, and a
  // first conversion that is already a fixed point is a much stronger statement than an eventual one.
  const generatedIdsOf = (result) => new Set(result.mapping.generatedIds || []);

  function mask(value, ids) {
    if (typeof value === 'string') return ids.has(value) ? '\u0000generated' : value;
    if (Array.isArray(value)) return value.map((v) => mask(v, ids));
    if (value && typeof value === 'object') {
      const out = Object.create(null);
      for (const key of Object.keys(value)) out[ids.has(key) ? '\u0000generated' : key] = mask(value[key], ids);
      return out;
    }
    return value;
  }

  /** The model as the canonical serialization sees it, minus the parts that describe the copy. */
  function comparable(model, ids) {
    const plain = JSON.parse(canonical.serialize(model));
    delete plain.modelId; // a copy's own identity
    delete plain.x; // provenance: the source hash and timestamp of *this* import
    return JSON.stringify(mask(plain, ids));
  }

  const passes = [];
  let text = OTM_TEXT;
  for (let pass = 0; pass < 3; pass++) {
    const result = I.runImport({ text, filename: 'roundtrip.otm.json' }, {});
    assert.equal(result.ok, true, `pass ${pass} imports`);
    const ids = generatedIdsOf(result);
    assert.equal(ids.size, 2, `pass ${pass} reports the two generated join ids`);
    passes.push(comparable(result.model, ids));
    const out = E.interchange(result.model, 'otm', { history: result.history });
    assert.equal(out.ok, true, `pass ${pass} exports`);
    assert.equal(out.blocked.length, 0);
    text = out.text;
  }

  assert.equal(passes[0], passes[1], 'the first conversion is already a fixed point');
  assert.equal(passes[1], passes[2], 'and it stays one, so repeated round trips do not drift');

  // The exception is real and bounded: the two ids differ between passes, they are the only thing
  // that differs, and the report named them in advance rather than leaving the user to find out by
  // diffing two files.
  const first = I.runImport({ text: OTM_TEXT, filename: 'a.otm.json' }, {});
  const second = I.runImport({ text: OTM_TEXT, filename: 'a.otm.json' }, {});
  same(first.mapping.generatedIds.length, second.mapping.generatedIds.length);
  assert.notEqual(
    first.mapping.generatedIds[0],
    second.mapping.generatedIds[0],
    'the generated ids really are generated, not derived from the content',
  );
  assert.equal(
    first.model.threatApplications.length,
    second.model.threatApplications.length,
    'but there are the same number of them, so nothing is accumulating across imports',
  );
});

specTest('imp.report-retained', () => {
  // REQ-IMP-010: the report is retained until replaced or dismissed. The distinction the test draws
  // is between the *notification* and the *report*: a toast is transient by design, and a user who
  // was looking at the model rather than the corner of the screen must still be able to find out what
  // happened to the file they chose.
  const { dom, ctx, TMV: shellTMV, shell } = loadShell({});
  installReader(ctx);
  assert.equal(shellTMV.importing.lastReport(), null, 'nothing has been imported yet');

  shell.go('settings', 'import');
  const input = dom.body.querySelector('#tmv-import-file');
  input.files = [file('otm_EXAMPLE.json', OTM_TEXT)];
  input.dispatch('change');
  return settle()
    .then(settle)
    .then(() => {
      const report = shellTMV.importing.lastReport();
      assert.ok(report, 'the report is retained');
      assert.equal(report.format, 'otm');
      assert.equal(report.counts.total, 23, 'with the entity counts');

      // Dismissing the notification does not dismiss the report. This is the assertion the
      // requirement is about: the toast is gone and the report is not.
      const toasts = shellTMV.notify.entries();
      assert.ok(toasts.length > 0, 'the import raised a notification');
      shellTMV.notify.reset();
      assert.equal(shellTMV.notify.entries().length, 0, 'the notification is gone');
      assert.equal(shellTMV.importing.lastReport().format, 'otm', 'and the report is not');

      // It is reachable, not merely held: the settings view renders it from `lastReport`, so the
      // user can read it after the fact.
      assert.ok(
        dom.body.textContent.includes('Open Threat Model'),
        'the import section still shows what was imported',
      );

      // A second import replaces it rather than accumulating, which is what "the last report" means.
      const refusal = shell.importEntries([{ name: 'notes.txt', size: 3, text: 'hi' }]);
      assert.equal(refusal.ok, false);
      assert.equal(shellTMV.importing.lastReport().ok, false, 'the newer report replaced the older');
      assert.equal(shellTMV.importing.lastReport().format, 'unknown');

      // And dismissing it is explicit. Nothing else clears it, including opening another view.
      shell.go('architecture');
      assert.ok(shellTMV.importing.lastReport(), 'changing view does not clear it');
      shellTMV.importing.clearReport();
      assert.equal(shellTMV.importing.lastReport(), null, 'dismissing it does');
    });
});
