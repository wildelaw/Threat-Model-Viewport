/*
 * container.test.mjs — the data block: escaping, discovery, shape, and what happens when it is wrong.
 *
 * The container is the only part of the file that is *parsed*, and it is parsed out of a document
 * this application did not necessarily write. Everything here is about the boundary: text that must
 * survive a round trip through an HTML script element, a block that must be found without a document
 * parser, and a version field that must produce an explanation rather than a guess.
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadApp, loadShell } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { container } = TMV;

/** The line and paragraph separators, written as code points so this file does not contain them. */
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** A page with one data block, as `index.html` carries it. */
function pageWith(jsonText, { id = 'tmv-data', attrs = '' } = {}) {
  const open = `<${'script'} type="application/json" id="${id}"${attrs ? ` ${attrs}` : ''}>`;
  const close = `</${'script'}>`;
  return `<html><body>${open}${jsonText}${close}</body></html>`;
}

specTest('data.escape-roundtrip', () => {
  // The property REQ-DATA-002 states, end to end: a model containing the sequences that change an
  // HTML tokenizer's state must survive serialize → escape → embed → extract → parse unchanged.
  //
  // The cases named in the requirement's own parenthetical, plus the ones a naive implementation
  // forgets.
  const cases = [
    ['close-script', '</script>'],
    ['close-script-case', '</SCRIPT >'],
    ['close-comment', '<!-- a comment -->'],
    ['line-separator', `before${LINE_SEP}after`],
    ['paragraph-separator', `before${PARA_SEP}after`],
    ['both-separators', `${LINE_SEP}${PARA_SEP}${LINE_SEP}`],
    ['nested', '</script><!--</script>-->'],
    ['mixed', `a<!--b${LINE_SEP}c</d`],
    ['empty', ''],
    ['slash-only', '</'],
    ['unicode', 'é€😀'],
  ];

  for (const [label, text] of cases) {
    const model = container.emptyModel('Escaping', '11111111-2222-4333-8444-555555555555');
    model.description = text;
    model.name = text || 'Escaping';
    const json = container.serialize(model);

    const escaped = container.escapeForScriptBlock(json);
    // Two properties, and both matter. The escape must not leave a sequence that ends the element or
    // starts a comment, and it must not be a lossy transformation — the text of the block has to
    // parse as JSON on its own.
    assert.equal(/<\/(script)/i.test(escaped), false, `${label}: no closing script tag survives`);
    assert.equal(escaped.indexOf('<!--'), -1, `${label}: no comment opener survives`);
    assert.equal(escaped.indexOf(LINE_SEP), -1, `${label}: no line separator survives`);
    assert.equal(escaped.indexOf(PARA_SEP), -1, `${label}: no paragraph separator survives`);

    const page = pageWith(escaped);
    const extracted = container.extractBlock(page);
    assert.notEqual(extracted, null, `${label}: the block is discoverable`);
    const reparsed = JSON.parse(extracted);
    same(reparsed, model, `${label}: round trip is lossless`);
  }
});

specTest('data.block-discoverable', () => {
  // REQ-DATA-001: the block is found by scanning, and the scan has to survive the ways a document can
  // put something *else* where the block appears to be.
  const json = '{"tmvFormat":"1.0","model":{},"history":{}}';
  assert.equal(container.extractBlock(pageWith(json)), json);

  // Attribute order, quote style and extra attributes.
  assert.equal(container.extractBlock(pageWith(json, { attrs: 'data-x="1"' })), json);
  assert.equal(
    container.extractBlock(`<${'script'} id='tmv-data' type='application/json'>${json}</${'script'}>`),
    json,
  );
  assert.equal(
    container.extractBlock(`<${'script'} type="application/json" defer id="tmv-data">${json}</${'script'}>`),
    json,
  );

  // An earlier look-alike must not make the real block unreachable: a decoy inside another script
  // element, and a mention inside a comment, both come before the block here.
  const decoy =
    `<${'script'}>var s = "id=\\"tmv-data\\"";</${'script'}>` +
    `<!-- id="tmv-data" -->` +
    pageWith(json);
  assert.equal(container.extractBlock(decoy), json);

  // An attribute that merely ends in the id is not the id — the whole of the reason `hasIdAttribute`
  // is hand-written rather than a loose regex.
  const trap =
    `<${'script'} type="application/json" data-id="tmv-data">${json}</${'script'}>`;
  assert.equal(container.extractBlock(trap), null, 'data-id is not id');
  const trap2 =
    `<${'script'} type="application/json" aria-describedby="field tmv-data">${json}</${'script'}>`;
  assert.equal(container.extractBlock(trap2), null, 'a mention inside another attribute is not the id');

  // A different id, and no block at all.
  assert.equal(container.extractBlock(pageWith(json, { id: 'other' })), null);
  assert.equal(container.extractBlock('<html><body>nothing here</body></html>'), null);
  assert.equal(container.extractBlock(''), null);

  // Unclosed: the rest of the page is returned rather than nothing, which lets the parse fail with a
  // JSON message instead of "there is no model here".
  assert.equal(container.extractBlock(`<${'script'} id="tmv-data">${json}`), json);
});

specTest('data.unknown-container-version', () => {
  // REQ-DATA-003. An unrecognised version opens read-only with an explanation. It must not throw, and
  // it must not be silently treated as current — the failure mode being avoided is a newer file's
  // semantics being guessed at and then written back.
  const base = container.buildSeedContainer({ appVersion: '0.1.0', appHash: 'sha256:x' });
  assert.equal(container.inspect(base).ok, true);
  assert.equal(container.inspect(base).readOnly, false);

  const newer = { ...base, tmvFormat: '9.0' };
  const newerVerdict = container.inspect(newer);
  assert.equal(newerVerdict.ok, true, 'an unknown version still opens');
  assert.equal(newerVerdict.readOnly, true);
  assert.equal(newerVerdict.unknownVersion, true);
  assert.match(newerVerdict.reason, /9\.0/);
  assert.match(newerVerdict.reason, new RegExp(TMV.CONTAINER_FORMAT.replace(/\./g, '\\.')));
  assert.match(newerVerdict.reason, /newer/);

  const older = { ...base, tmvFormat: '0.9' };
  const olderVerdict = container.inspect(older);
  assert.equal(olderVerdict.ok, true);
  assert.equal(olderVerdict.readOnly, true);
  assert.match(olderVerdict.reason, /older/);

  // Version comparison is numeric per segment, not lexicographic: "10.0" is newer than "9.0", which
  // a string comparison gets backwards.
  assert.equal(container.compareVersions('1.10', '1.9'), 1);
  assert.equal(container.compareVersions('1.9', '1.10'), -1);
  assert.equal(container.compareVersions('1.0', '1.0.0'), 0);
  assert.equal(container.compareVersions('1.0.1', '1.0'), 1);
  assert.equal(container.compareVersions('x.y', '0.0'), 0, 'a non-numeric segment counts as zero');
});

specTest('data.corrupt-block-nondestructive', () => {
  // REQ-DATA-005: invalid embedded data never destroys anything. The failure has to be an error the
  // caller can render, and nothing may be written on the way out — which is asserted here by
  // checking that the parse path has no writes at all: it returns a value or throws, and the
  // container it was handed is untouched.
  const throws = (fn, code) => {
    try {
      fn();
    } catch (err) {
      assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
      assert.ok(err.message.length > 10, 'the error explains itself in words');
      return err;
    }
    throw new Error(`expected ${code}`);
  };

  throws(() => container.parse('{not json'), 'CONTAINER_PARSE');
  throws(() => container.parse('[]'), 'CONTAINER_SHAPE');
  throws(() => container.parse('"a string"'), 'CONTAINER_SHAPE');
  throws(() => container.parse('null'), 'CONTAINER_SHAPE');
  throws(() => container.parse('42'), 'CONTAINER_SHAPE');

  // Oversize is refused *before* the parse, because a guard applied after a successful parse of a
  // hostile file is not a guard.
  const huge = `{"pad":"${'x'.repeat(TMV.LIMITS.containerRefuseBytes)}"}`;
  const err = throws(() => container.parse(huge), 'CONTAINER_TOO_LARGE');
  assert.equal(err.detail.bytes > TMV.LIMITS.containerRefuseBytes, true, 'the error carries the size it measured');
  // And it can be opened deliberately, which is what "limited import" means.
  assert.ok(container.parse(huge, { allowOversize: true }).container.pad.length > 0);

  // A structurally wrong container is reported by field name, read-only, and without throwing.
  const missing = container.inspect({ tmvFormat: '1.0' });
  assert.equal(missing.ok, false);
  assert.equal(missing.readOnly, true);
  same(missing.problems, ['history', 'model'], 'the missing fields are named');
  assert.match(missing.reason, /history, model/);
  const notObject = container.inspect(null);
  assert.equal(notObject.ok, false);
  same(notObject.problems, ['root'], 'a non-object root is reported as root');
  same(container.inspect({ tmvFormat: '1.0', history: {}, model: {} }).problems, ['history.commits']);
});

specTest('data.model-id-stable', () => {
  // REQ-DATA-006: the model id is a stable UUID that survives export and import unchanged. It is the
  // identity the storage registry keys on, so a re-generated id on load would make every reopen look
  // like a different model.
  const model = container.emptyModel('Stable', '11111111-2222-4333-8444-555555555555');
  assert.equal(model.modelId, '11111111-2222-4333-8444-555555555555');
  assert.equal(TMV.core.isUuid(model.modelId), true);

  const containerised = container.makeContainer(model, { keyframeInterval: 20, head: null, commits: [] });
  const again = container.parse(container.serialize(containerised)).container;
  assert.equal(again.model.modelId, model.modelId);

  // A missing id is generated, and then stays: two serializations of the same model agree, and a
  // second load of the same bytes does not mint a new one.
  const anonymous = container.emptyModel('Anonymous');
  assert.equal(TMV.core.isUuid(anonymous.modelId), true);
  const first = container.serialize(anonymous);
  assert.equal(container.serialize(container.parse(first).container), first, 'serialization is idempotent');
});

specTest('data.passthrough.otm', () => {
  // REQ-DATA-004: fields the canonical model does not interpret are carried in `x-otm` bags and come
  // back out. The DATA requirement is about the *canonical* side of that — the bag survives a
  // container round trip — and the mapping itself is the interop suite's business.
  const model = container.emptyModel('Bags', '11111111-2222-4333-8444-555555555555');
  model.x = Object.create(null);
  model.x.otm = Object.create(null);
  model.x.otm.someVendorField = { nested: [1, 2, 3], '</script>': 'value' };
  const zone = TMV.model.insert(model, 'trustZone', { id: 'z1', name: 'Internet' });
  zone.x = Object.create(null);
  zone.x.otm = Object.create(null);
  zone.x.otm.colour = '#eeeeee';

  const round = container.parse(container.serialize(container.makeContainer(model, { commits: [], head: null })));
  same(round.container.model.x.otm, model.x.otm, 'the top-level otm bag');
  assert.equal(round.container.model.trustZones[0].x.otm.colour, '#eeeeee');
});

specTest('data.passthrough.tml', () => {
  const model = container.emptyModel('Bags', '11111111-2222-4333-8444-555555555555');
  model.x = Object.create(null);
  model.x.tml = Object.create(null);
  model.x.tml.extensions = ['a', 'b'];
  const component = TMV.model.insert(model, 'component', { id: 'c1', name: 'Gateway' });
  component.x = Object.create(null);
  component.x.tml = Object.create(null);
  component.x.tml.customField = 'kept';

  const round = container.parse(container.serialize(container.makeContainer(model, { commits: [], head: null })));
  same(round.container.model.x.tml, { extensions: ['a', 'b'] }, 'the top-level tml bag');
  assert.equal(round.container.model.components[0].x.tml.customField, 'kept');
});

specTest('exp.self-verify', () => {
  // REQ-EXP-010 and REQ-EXP-008 share a subject here: the artifact verifies what it wrote by finding
  // its own block again, and the check is a comparison against the text it produced.
  const seed = container.buildSeedContainer({ appVersion: '0.1.0', appHash: 'sha256:test' });
  const text = container.serialize(seed);
  const page = pageWith(container.escapeForScriptBlock(text));

  const found = container.extractBlock(page, container.BLOCK_ID);
  assert.notEqual(found, null);
  same(JSON.parse(found), seed, 'what was written is what is read back');

  // A clean serialization of an ordinary model needs no escaping at all, which is what makes
  // `needsEscaping` worth having: it notices a serializer that started emitting something unexpected.
  assert.equal(container.needsEscaping(text), false);
  assert.equal(container.needsEscaping('{"a":"</script>"}'), true);
  assert.equal(container.needsEscaping('{"a":"<!--"}'), true);
  assert.equal(container.needsEscaping(`{"a":"${LINE_SEP}"}`), true);

  // The embedded text is written escaped, so a model carrying the hostile sequences can be re-exported
  // without breaking the page it is written into.
  const dom = loadShell({}).dom;
  const node = dom.createElement('script');
  container.writeEmbeddedText(node, '{"a":"</script>"}');
  assert.equal(node.textContent.indexOf('</' + 'script>'), -1);
});
