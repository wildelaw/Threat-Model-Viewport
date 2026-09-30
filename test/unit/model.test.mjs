/*
 * model.test.mjs — the canonical model: entities, references, validation, passthrough.
 *
 * This is the layer every edit path goes through. The spec's claim is that referential integrity is
 * maintained "by construction" (REQ-EDIT-003), and the thing that makes that true is here rather
 * than in the forms: `insert` will not mint a duplicate id, `remove` drops the references that
 * pointed at what it removed, and `dropReferencesTo` handles references that live inside a nested
 * list as well as a plain field. A UI-only defence would be one forgotten edit path away from a
 * dangling reference.
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadApp } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

const { TMV } = loadApp();
const { model: M, core } = TMV;

/** An entity of `type` populated with only what the type declares, so `validate` has nothing to say. */
function sampleValues(type) {
  const values = { id: type.singular + '-1' };
  if (!type.link) values.name = type.label + ' one';
  for (const spec of type.fields) {
    if (spec.kind === 'enum') values[spec.key] = M.VOCAB[spec.vocab][0];
    else if (spec.kind === 'enumList') values[spec.key] = [M.VOCAB[spec.vocab][0]];
    else if (spec.kind === 'string' || spec.kind === 'uri') values[spec.key] = 'value';
    else if (spec.kind === 'stringList') values[spec.key] = ['one'];
    else if (spec.kind === 'number' || spec.kind === 'int') values[spec.key] = spec.min || 0;
    else if (spec.kind === 'boolean') values[spec.key] = true;
  }
  return values;
}

/** A model holding one entity of every type, built by satisfying each type's own field list. */
function populated() {
  const model = M.createEmpty('Populated');
  for (const type of M.TYPES) M.insert(model, type.key, sampleValues(type));
  return model;
}

// ---------------------------------------------------------------------------------------------

specTest('edit.crud-coverage', () => {
  // REQ-EDIT-001, parameterised over every entity type rather than spot-checked: a type that exists
  // in the registry but cannot be created is a type the UI cannot offer, and the failure would show
  // up as one tab quietly missing its Add button.
  const keys = M.TYPES.map((t) => t.key);
  assert.equal(keys.length, M.ENTITY_KEYS.length, 'every registered type has a collection');
  same(keys.slice().sort(), M.ENTITY_KEYS.slice().sort());

  for (const type of M.TYPES) {
    // Both spellings route to the same type, because the forms pass singulars and the model stores
    // plurals, and a mismatch between the two is a whole class of silent no-op.
    assert.equal(M.typeFor(type.key), type, `${type.key} is addressable by its collection key`);
    assert.equal(M.typeFor(type.singular), type, `${type.key} is addressable by its singular`);
    assert.ok(type.label && type.plural, `${type.key} has a label to show`);

    const model = M.createEmpty('CRUD');
    assert.ok(core.isArray(model[type.key]), `${type.key} starts as an empty array`);

    const values = sampleValues(type);
    const created = M.insert(model, type.key, values);
    assert.equal(created.id, values.id, 'insert returns the entity it created');
    assert.equal(M.collection(model, type.key).length, 1);
    assert.equal(M.get(model, type.key, created.id), created, 'and it is readable back by id');
    if (!type.link) assert.equal(M.labelOf(created), values.name, 'the label is the name');

    // Update, including the one field every type has.
    const patched = M.update(model, type.singular, created.id, { name: 'Renamed' });
    assert.equal(patched.name, 'Renamed', 'update is addressable by singular too');
    assert.equal(M.get(model, type.key, created.id).name, 'Renamed', 'and it changed the stored entity');

    // An update to a field nobody declared is kept rather than dropped — the same path the
    // passthrough bags ride on.
    M.update(model, type.key, created.id, { unrecognisedField: 'kept' });
    assert.equal(M.get(model, type.key, created.id).unrecognisedField, 'kept');

    // Delete.
    const result = M.remove(model, type.key, created.id);
    assert.equal(result.entity.id, created.id, 'remove returns what it removed');
    assert.equal(M.get(model, type.key, created.id), null);
    assert.equal(M.collection(model, type.key).length, 0);

    // Removing something that is not there is a no-op with an empty report, not a throw: the UI
    // calls this from a row action that may race with another.
    const again = M.remove(model, type.key, created.id);
    assert.equal(again.entity, null);
    same(again.cascaded, []);
  }

  // Unknown types are refused loudly, because a typo in a caller is a bug and not user input.
  assert.throws(() => M.insert(M.createEmpty('X'), 'notAType', {}), /Unknown entity type/);
  assert.equal(M.typeFor('notAType'), null);
  assert.equal(M.collection(M.createEmpty('X'), 'notAType').length, 0, 'an unknown type reads as empty');

  // The id rules, which every type above depends on: an id is minted when absent, a duplicate is
  // refused rather than silently overwriting, and `idAvailable` is the question the forms ask before
  // a rename.
  const ids = M.createEmpty('Ids');
  const first = M.insert(ids, 'component', { name: 'One' });
  const second = M.insert(ids, 'component', { name: 'Two' });
  assert.ok(core.isUuid(first.id), 'an id was minted');
  assert.notEqual(second.id, first.id);

  assert.throws(
    () => M.insert(ids, 'component', { id: first.id, name: 'Clash' }),
    (err) => err.code === 'MODEL_ID_TAKEN',
  );
  assert.equal(M.idAvailable(ids, 'component', 'free-id', null), true);
  assert.equal(M.idAvailable(ids, 'component', first.id, null), false);
  assert.equal(M.idAvailable(ids, 'component', first.id, first.id), true, 'the id it already has is free');

  // A rename onto a taken id is refused; a rename to its own id is allowed, because the entity
  // already holds it.
  assert.throws(
    () => M.update(ids, 'component', second.id, { id: first.id }),
    (err) => err.code === 'MODEL_ID_TAKEN',
  );
  M.update(ids, 'component', first.id, { id: first.id, name: 'One, renamed' });
  assert.equal(M.get(ids, 'components', first.id).name, 'One, renamed');
  assert.equal(M.collection(ids, 'components').length, 2, 'no entity was lost or duplicated');
});

specTest('edit.validation', () => {
  // REQ-EDIT-002. Validation is where "enumerations, score ranges and identifier formats" are
  // enforced, and the codes are asserted rather than the prose: the message is what the user reads
  // and may be reworded, the code is what a caller branches on.
  const model = M.createEmpty('Invalid');
  M.insert(model, 'trustZone', { id: 'z', name: 'Zone', trustRating: 900 });
  M.insert(model, 'actor', { id: 'a', name: 'Actor', type: 'not-a-real-type' });
  M.insert(model, 'component', { id: 'c', name: 'Component', trustZoneId: 'nowhere' });
  M.insert(model, 'risk', { id: 'r', name: 'Risk', likelihood: 'certain', impact: 'total' });

  const verdict = M.validate(model);
  assert.equal(verdict.valid, false);
  const codes = verdict.problems.map((p) => p.code);
  const find = (code, path) => verdict.problems.find((p) => p.code === code && (!path || p.path.indexOf(path) !== -1));

  const range = find('FIELD_RANGE', 'trustRating');
  assert.ok(range, `expected a range problem, got ${codes.join(',')}`);
  assert.equal(range.severity, 'error');
  assert.match(range.message, /900/);
  assert.match(range.message, /100/, 'the message names the limit it broke');

  // An unrecognised enum value is a *warning*: the canonical model is a superset, and a value that is
  // outside the vocabulary is likelier to be a newer file than a corrupt one.
  const vocab = find('VOCAB_OUTSIDE', 'actors');
  assert.ok(vocab, `expected a vocabulary warning, got ${codes.join(',')}`);
  assert.equal(vocab.severity, 'warning');

  // A dangling reference is an error, and it is also reported structurally in `unresolved` — which is
  // what the import path uses to tell the user which references did not come across.
  const dangling = find('REF_DANGLING', 'trustZoneId');
  assert.ok(dangling, `expected a dangling-reference problem, got ${codes.join(',')}`);
  assert.equal(dangling.severity, 'error');
  assert.equal(verdict.unresolved.length, 1);
  assert.equal(verdict.unresolved[0].id, 'nowhere');
  same(verdict.unresolved[0].expected, ['trustZone'], 'and says what it could have referred to');

  // Making the reference resolve clears it: the check is measuring the reference and not a defect
  // that is always present.
  const fixed = core.deepCopy(model);
  M.insert(fixed, 'trustZone', { id: 'nowhere', name: 'Now here' });
  const after = M.validate(fixed);
  assert.equal(
    after.problems.filter((p) => p.code === 'REF_DANGLING').length,
    0,
    'the dangling reference is gone once its target exists',
  );

  // A model with nothing wrong with it passes, so the assertions above are not passing because
  // `validate` refuses everything.
  const clean = M.validate(populated());
  same(clean.problems, [], `a well-formed model has no problems: ${JSON.stringify(clean.problems)}`);
  assert.equal(clean.valid, true);
  assert.equal(clean.unresolved.length, 0);

  // A missing name is an error and the message says what it blocks, because export is refused without
  // one and a user who is told "invalid" and nothing else has nowhere to go.
  const nameless = M.createEmpty('');
  const nameProblem = M.validate(nameless).problems.find((p) => p.code === 'MODEL_NAME');
  assert.ok(nameProblem);
  assert.match(nameProblem.message, /name/i);

  // Enumerations offer only valid values: every vocabulary a field names exists and is non-empty, so
  // the select has something to offer.
  for (const type of M.TYPES) {
    for (const spec of type.fields) {
      if (spec.kind !== 'enum' && spec.kind !== 'enumList') continue;
      assert.ok(core.isArray(M.VOCAB[spec.vocab]) && M.VOCAB[spec.vocab].length > 0,
        `${type.key}.${spec.key} names vocabulary "${spec.vocab}", which is missing or empty`);
    }
  }
});

specTest('edit.reference-selects', () => {
  // REQ-EDIT-003 AC2 — no edit path can create a dangling reference. The construction that makes that
  // true is that every reference field declares its targets, so a form can only ever offer entities
  // that exist. This asserts the declaration is complete, which is the part that rots.
  const targets = new Set();
  for (const type of M.TYPES) {
    for (const spec of type.fields) {
      if (spec.kind === 'ref' || spec.kind === 'refList') {
        targets.add(type.key);
        assert.ok(core.isArray(spec.ref) && spec.ref.length > 0,
          `${type.key}.${spec.key} is a reference but declares no target types`);
        for (const singular of spec.ref) {
          assert.ok(M.typeFor(singular), `${type.key}.${spec.key} names unknown target type "${singular}"`);
        }
      }
    }
  }
  // The declaration is checked for completeness in both directions. References that live *inside* an
  // object field — a flow endpoint is not one, but a representation element's target is — are the
  // ones a hand-written list forgets, so the flattened list is compared against the declaration
  // rather than sampled from it.
  const declared = [];
  for (const type of M.TYPES) {
    for (const spec of type.fields) {
      if (spec.kind === 'ref' || spec.kind === 'refList') declared.push(`${type.key}.${spec.key}`);
      for (const inner of spec.itemFields || []) {
        if (inner.kind === 'ref' || inner.kind === 'refList') declared.push(`${type.key}.${inner.key}`);
      }
    }
  }
  const flattened = M.REFERENCE_FIELDS.map((rf) => `${rf.type}.${rf.field.key}`);
  same(
    flattened.slice().sort(),
    declared.slice().sort(),
    'every declared reference field is in the flattened list, and nothing else is',
  );
  assert.ok(M.REFERENCE_FIELDS.length >= 10, `only ${M.REFERENCE_FIELDS.length} reference fields found`);

  for (const rf of M.REFERENCE_FIELDS) {
    assert.ok(M.typeFor(rf.type), `REFERENCE_FIELDS names unknown type ${rf.type}`);
    assert.ok(rf.field.kind === 'ref' || rf.field.kind === 'refList');
    assert.ok(core.isArray(rf.field.ref) && rf.field.ref.length > 0, `${rf.type}.${rf.field.key} declares no targets`);
    for (const singular of rf.field.ref) {
      assert.ok(M.typeFor(singular), `${rf.type}.${rf.field.key} names unknown target type "${singular}"`);
    }
  }

  // A flow endpoint is the awkward case — the target type is not fixed by the field but by a sibling
  // field — and it is why `FLOW_ENDPOINT_TARGET` exists rather than a plain `ref` list.
  const flow = M.typeFor('dataFlow');
  const source = flow.fields.find((f) => f.key === 'sourceId');
  same(source.ref, ['component', 'actor', 'dataStore']);
  assert.equal(source.typeField, 'sourceType');
  assert.equal(source.typeMap.component, 'components');
  assert.equal(source.typeMap.actor, 'actors');
  assert.equal(source.typeMap.data_store, 'dataStores');

  // The choices a form offers are the entities that exist, and they are filtered by the declared
  // targets rather than by a hand-written list in the view.
  const model = populated();
  const zone = M.collection(model, 'trustZones')[0];
  const choices = [];
  for (const singular of source.ref) for (const e of M.collection(model, singular)) choices.push(e.id);
  assert.equal(choices.length, 3, 'one component, one actor and one data store to choose from');
  assert.ok(choices.indexOf(zone.id) === -1, 'and a trust zone is not one of them');
});

specTest('edit.delete-referenced-entity', () => {
  // REQ-EDIT-003 AC1 and the second half of REQ-EDIT-004: deleting something other things point at
  // is an explicit act whose consequences are computed and reported, not discovered afterwards.
  const model = M.createEmpty('Refs');
  const zone = M.insert(model, 'trustZone', { id: 'z1', name: 'Zone' });
  const inner = M.insert(model, 'trustZone', { id: 'z2', name: 'Inner', parentId: 'z1' });
  const component = M.insert(model, 'component', { id: 'c1', name: 'Component', trustZoneId: 'z1' });
  const store = M.insert(model, 'dataStore', { id: 'd1', name: 'Store', trustZoneId: 'z1' });
  const flow = M.insert(model, 'dataFlow', {
    id: 'f1', name: 'Flow', sourceId: 'c1', sourceType: 'component', destinationId: 'd1', destinationType: 'data_store',
  });
  const threat = M.insert(model, 'threat', { id: 't1', name: 'Threat' });
  M.insert(model, 'threatApplication', { id: 'ta1', threatId: 't1', targetId: 'c1', targetType: 'component' });

  // Who points at the component, before anything is deleted. The UI's prompt is built from this.
  const referrers = M.referrersOf(model, 'c1').map((r) => `${r.type}.${r.entity.id}.${r.field.key}`).sort();
  same(referrers, ['dataFlows.f1.sourceId', 'threatApplications.ta1.targetId']);

  const result = M.remove(model, 'component', 'c1');
  assert.equal(result.entity.id, 'c1');

  // The flow survives: a component is not the only thing a flow can run from, and the reference is
  // dropped rather than the flow being quietly deleted. Its destination is untouched.
  assert.ok(M.get(model, 'dataFlows', 'f1'), 'the flow is still there');
  assert.equal(M.get(model, 'dataFlows', 'f1').sourceId, undefined, 'with its source reference dropped');
  assert.equal(M.get(model, 'dataFlows', 'f1').destinationId, 'd1');

  // The threat application does *not* survive. It exists only to relate a threat to a target, so with
  // the target gone there is no fact left to record — and it is reported, so the UI can say so.
  assert.equal(M.get(model, 'threatApplications', 'ta1'), null);
  same(result.cascaded, [{ type: 'threatApplications', id: 'ta1' }]);

  // Nothing dangling is left behind, which is the AC: the model still validates.
  const verdict = M.validate(model);
  assert.equal(
    verdict.problems.filter((p) => p.code === 'REF_DANGLING').length,
    0,
    `a delete left a dangling reference: ${JSON.stringify(verdict.problems)}`,
  );

  // Deleting the zone drops the references that pointed at it but keeps the entities they were on.
  // The child zone is *kept*: a trust zone is a thing in its own right, not a link, so what goes is
  // the `parentId`, not the zone — the same distinction as the component's optional `trustZoneId`.
  const second = M.remove(model, 'trustZone', 'z1');
  assert.equal(M.get(model, 'trustZones', 'z1'), null);
  assert.ok(M.get(model, 'trustZones', 'z2'), 'the child zone survives its parent');
  assert.equal(M.get(model, 'trustZones', 'z2').parentId, undefined, 'with its parent reference dropped');
  assert.equal(M.get(model, 'trustZones', 'z2').name, 'Inner', 'and nothing else about it changed');
  assert.equal(second.cascaded.length, 0, 'nothing depends on a zone by construction');
  assert.ok(M.get(model, 'dataStores', 'd1'), 'the store remains');
  assert.equal(M.get(model, 'dataStores', 'd1').trustZoneId, undefined, 'without its zone reference');
  assert.equal(M.get(model, 'components', 'c1'), null);
  assert.equal(M.get(model, 'dataFlows', 'f1').sourceId, undefined);
  assert.equal(M.get(model, 'dataFlows', 'f1').destinationId, 'd1', 'and its destination survived, because the store did');
  assert.equal(
    M.validate(model).problems.filter((p) => p.code === 'REF_DANGLING').length,
    0,
    'two deletes later, still nothing dangling',
  );

  // A reference inside an object's *item* fields is reached the same way, and the entry that named
  // only the deleted entity is pruned rather than left inert. `dataSets[].placements[]` is such a
  // reference: a placement whose data store is gone is not a placement, and a row naming nothing
  // would accumulate silently across an editing session.
  const withAssets = M.createEmpty('Nested');
  M.insert(withAssets, 'dataStore', { id: 'ds1', name: 'Store' });
  M.insert(withAssets, 'dataSet', { id: 'set1', name: 'Set', placements: [{ dataStoreId: 'ds1', ref: 'inside' }] });
  assert.equal(
    M.referrersOf(withAssets, 'ds1').length,
    1,
    'a reference nested in an item field is still reported as a referrer',
  );
  M.remove(withAssets, 'dataStore', 'ds1');
  same(M.get(withAssets, 'dataSets', 'set1').placements, [], 'the inert placement entry is pruned');

  // A *declared* list reference on the entity itself is emptied in place instead, because the
  // entity keeps its meaning without it: a flow is still a flow with no assets.
  M.insert(withAssets, 'asset', { id: 'as1', name: 'Asset' });
  M.insert(withAssets, 'dataFlow', { id: 'f2', name: 'F2', assetIds: ['as1'] });
  M.remove(withAssets, 'asset', 'as1');
  same(M.get(withAssets, 'dataFlows', 'f2').assetIds, [], 'a list reference is emptied, not left dangling');
  assert.ok(M.get(withAssets, 'dataFlows', 'f2'), 'and the flow itself survives');

  // The contrast that makes the previous two assertions mean something: a field the schema does not
  // declare is passthrough data, not a reference, so a string in it that happens to look like an id
  // is left alone. `threat` has no `assetIds` field; the value here is somebody else's vocabulary
  // that the app is carrying for a round trip, and it is not the app's to rewrite.
  const passthrough = M.createEmpty('Passthrough');
  M.insert(passthrough, 'asset', { id: 'as1', name: 'Asset' });
  M.insert(passthrough, 'threat', { id: 't2', name: 'T2', assetIds: ['as1'] });
  M.remove(passthrough, 'asset', 'as1');
  same(M.get(passthrough, 'threats', 't2').assetIds, ['as1'], 'an undeclared field is passthrough, and untouched');
  assert.equal(
    M.validate(passthrough).problems.filter((p) => p.code === 'REF_DANGLING').length,
    0,
    'and it is not reported as a dangling reference either',
  );
});

specTest('edit.structural-integrity', () => {
  // REQ-EDIT-004. Structural edits update what depends on them and preserve identity: the ids a
  // commit's history refers to must still mean the same entities after an edit, or a delta would
  // apply cleanly and mean something different.
  const model = M.createEmpty('Structure');
  const source = M.insert(model, 'component', { id: 'src', name: 'Source' });
  const destination = M.insert(model, 'component', { id: 'dst', name: 'Destination' });
  const flow = M.insert(model, 'dataFlow', {
    id: 'flow', name: 'Flow', sourceId: 'src', sourceType: 'component', destinationId: 'dst', destinationType: 'component',
  });

  // Removing a component that is the source of a flow does not orphan the flow silently: the removal
  // reports the flow as touched, and the reference — not the flow — is what goes.
  const reported = M.referrersOf(model, 'src');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].entity.id, 'flow');
  assert.equal(reported[0].field.key, 'sourceId');

  M.remove(model, 'component', 'src');
  assert.ok(M.get(model, 'components', 'dst'), 'the other end of the flow is untouched');
  assert.equal(M.get(model, 'components', 'dst').id, 'dst', 'and kept its id');
  assert.equal(M.get(model, 'components', 'dst').name, 'Destination', 'and its name');
  assert.equal(M.get(model, 'dataFlows', 'flow').id, 'flow', 'the flow kept its id too');
  assert.equal(flow.destinationId, 'dst');

  // A re-parent is an id-preserving operation: nothing downstream of the entity sees a different
  // entity, which is what "entity ids are stable across edits" means in practice.
  const zoneA = M.insert(model, 'trustZone', { id: 'za', name: 'A' });
  const zoneB = M.insert(model, 'trustZone', { id: 'zb', name: 'B' });
  const before = M.referrersOf(model, 'dst').length;
  M.update(model, 'component', 'dst', { trustZoneId: 'za' });
  assert.equal(M.get(model, 'components', 'dst').id, 'dst');
  assert.equal(M.get(model, 'components', 'dst').trustZoneId, 'za');
  M.update(model, 'component', 'dst', { trustZoneId: 'zb' });
  assert.equal(M.get(model, 'components', 'dst').id, 'dst', 'still the same entity after two moves');
  assert.equal(M.referrersOf(model, 'dst').length, before, 'and the same things still point at it');
  assert.equal(zoneA.id, 'za');
  assert.equal(zoneB.id, 'zb');
  same(M.referrersOf(model, 'zb').map((r) => r.entity.id), ['dst']);

  // A flow between the two components can be re-pointed without minting a new flow.
  M.update(model, 'dataFlow', 'flow', { sourceId: 'dst' });
  assert.equal(M.get(model, 'dataFlows', 'flow').sourceId, 'dst');
  assert.equal(M.get(model, 'dataFlows', 'flow').id, 'flow');

  // The structural check the model offers is the same one every edit path calls.
  assert.equal(M.validate(model).problems.filter((p) => p.code === 'REF_DANGLING').length, 0);
});

specTest('edit.passthrough-preserved', () => {
  // REQ-EDIT-009 and REQ-DATA-004 together. The edit forms know nothing about `x-otm` and `x-tml`,
  // which is exactly why the preservation has to be a property of the update path rather than of each
  // form: a form that rebuilds an entity from its fields loses the bag, and there are no fields for
  // the bag.
  const model = M.createEmpty('Bags');
  const zone = M.insert(model, 'trustZone', { id: 'z1', name: 'Zone' });
  M.setBag(zone, 'otm', { otmVendor: { nested: [1, 2, 3] }, colour: '#abc' });
  M.setBag(zone, 'tml', { customField: 'tmlish' });

  const bagBefore = core.deepCopy(zone.x);

  // The edit a form makes: one visible field.
  M.update(model, 'trustZone', 'z1', { name: 'Renamed' });
  assert.equal(M.get(model, 'trustZones', 'z1').name, 'Renamed');
  same(M.get(model, 'trustZones', 'z1').x, bagBefore, 'editing a title left the passthrough bags alone');

  // Even an edit that goes through the generic replace path for a declared field.
  M.update(model, 'trustZone', 'z1', { trustRating: 50 });
  same(M.get(model, 'trustZones', 'z1').x, bagBefore);

  // `bag` reads one format, and reports nothing when the bag is absent or empty.
  same(M.bag(zone, 'otm'), bagBefore.otm);
  same(M.bag(zone, 'tml'), { customField: 'tmlish' });
  assert.equal(M.bag(zone, 'nowhere'), null);
  assert.equal(M.bag(M.insert(model, 'trustZone', { id: 'z2', name: 'Plain' }), 'otm'), null);

  // An empty bag is omitted rather than written as `{}`, so a model that has been edited does not
  // grow a field that means "there is nothing here".
  M.setBag(zone, 'otm', {});
  assert.equal(zone.x.otm, undefined, 'setting an empty bag removes it');
  assert.equal(zone.x.tml.customField, 'tmlish', 'and leaves the other format alone');

  M.setBag(zone, 'tml', null);
  assert.equal(zone.x, undefined, 'the last bag going takes `x` with it');

  // `pruneBags` cleans up after a load or an import that produced empty bags rather than omitting
  // them, and it does the same at the entity level as at the model level.
  const scruffy = M.createEmpty('Scruffy');
  scruffy.x = Object.create(null);
  scruffy.x.otm = Object.create(null);
  scruffy.x.tml = { keep: true };
  const entity = M.insert(scruffy, 'component', { id: 'c1', name: 'C' });
  entity.x = Object.create(null);
  entity.x.otm = {};
  entity.x.tml = null;
  M.pruneBags(scruffy);
  same(scruffy.x, { tml: { keep: true } }, 'the empty model bag went, the full one stayed');
  assert.equal(entity.x, undefined, 'and the entity with only empty bags lost `x` entirely');
});
