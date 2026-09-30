/**
 * Forms and editing (REQ-EDIT-001 … REQ-EDIT-010).
 *
 * This module is the EDIT domain's implementation: one generic form driven by `TMV.model`'s `TYPES`
 * registry, the model-level operations the form performs, the dialogs those operations need, and the
 * undo stack that makes a delete recoverable until it is committed.
 *
 * Five decisions here are load-bearing, and each is a place where the obvious implementation is
 * wrong in a way that does not announce itself.
 *
 * **1. The working model is treated as immutable.** Every operation in this file takes a model and
 * returns a *new* one, sharing the arrays it did not touch and deep-copying the entities it did. It
 * never mutates the model it was handed. That is not fastidiousness — it is what makes undo exact.
 * `TMV.model.remove` is documented to drop the references pointing at what it removes, so an undo
 * implemented as an inverse insert would restore the entity and silently *not* restore the
 * references that had been cleared, which is precisely the half of REQ-EDIT-010's acceptance
 * criterion ("with their identifiers **and references**") that is easy to lose. Keeping the previous
 * model object needs no reverse patch at all, and the copy-on-write means the previous model object
 * is still the model as it was.
 *
 * **2. The form is generated from the registry, not written per entity type.** `05-model.js` says
 * `kind` drives both validation and the generic renderer; this is the renderer. Nineteen types times
 * an average of six fields is a hundred hand-written forms, and the hundredth is where a reference
 * field becomes a text input and dangling references become possible (REQ-EDIT-003 AC2).
 *
 * **3. Validation is `TMV.model.validate`, not a second copy of it.** The form builds the candidate
 * entity, substitutes it into a probe model, and reads the problems back. A form with its own range
 * checks would disagree with the model checker eventually, and the disagreement would show up as a
 * model that passes its form and fails its validation — or the reverse, which is worse.
 *
 * **4. Fields the form does not surface survive an edit byte for byte (REQ-EDIT-009).** The candidate
 * starts as a deep copy of the entity and only *changed* values are written into it, so an untouched
 * `tags: []` stays `[]` rather than disappearing, and the `x` passthrough bag is never reached. A
 * form that rebuilt the entity from its own controls would drop every field it had not heard of, and
 * the passthrough bags are exactly the fields it has not heard of.
 *
 * **5. Values the vocabulary does not contain are offered, not silently rewritten.** An imported
 * model may hold a `status` outside the default list, and `validate` reports that as a warning
 * rather than an error because the value is meant to round-trip. A select built from the vocabulary
 * alone would show some *other* value as chosen and write it back on save — a silent edit to a model
 * the user only opened. So the current value is added to every option list when it is not already
 * there, and the same is true of a reference whose target is missing.
 *
 * Everything untrusted reaches the DOM through `textContent` (REQ-SEC-003): there is no path in this
 * file that takes markup, and no control is built by assigning HTML.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var M = TMV.model;

  /**
   * How many operations the undo stack keeps.
   *
   * Each entry is a whole previous working model held by reference, which costs one object per
   * operation rather than a copy of the model, so the limit is about bounding a long editing session
   * rather than about memory pressure. Fifty is well past the point where a user is undoing a
   * deliberate mistake and into the territory of undoing their afternoon.
   */
  var UNDO_LIMIT = 50;

  /** Above this many candidates a reference list gains a filter box. */
  var REFERENCE_FILTER_AT = 10;

  // ---------------------------------------------------------------------------------------------
  // 1. Values
  //
  // A form reads strings out of controls and has to hand the model the types it declares. This
  // section is that translation, and it is pure — no DOM — because it is where an edit is actually
  // decided and therefore where the tests are worth having.
  // ---------------------------------------------------------------------------------------------

  /** `name` and `description` are canonical on every entity but are not in any `fields` array. */
  var NAME_SPEC = { key: 'name', label: 'Name', kind: 'string' };
  var DESCRIPTION_SPEC = { key: 'description', label: 'Description', kind: 'string', multiline: true };

  /** The kinds this module can render. A kind outside this set is preserved and shown read-only. */
  var RENDERED_KINDS = [
    'string', 'number', 'int', 'boolean', 'uri', 'date', 'datetime',
    'enum', 'enumList', 'stringList', 'ref', 'refList', 'object', 'objectList', 'state',
  ];

  function isRenderable(spec) {
    return RENDERED_KINDS.indexOf(spec.kind) !== -1;
  }

  function specFor(typeSpec, key) {
    if (key === 'name') return NAME_SPEC;
    if (key === 'description') return DESCRIPTION_SPEC;
    for (var i = 0; i < typeSpec.fields.length; i++) {
      if (typeSpec.fields[i].key === key) return typeSpec.fields[i];
    }
    return null;
  }

  /**
   * The fields a form asks for, in order.
   *
   * `name` and `description` come first because they are what the user is looking at. They are
   * omitted for a link entity (`05-model.js`: a threat application has no name and the UI never asks
   * for one) — but included when the entity *has* one, so a name that arrived by import can be seen
   * and corrected rather than being invisible and un-fixable.
   *
   * Derived fields are returned separately. They are computed from other fields and writing to them
   * would create a second, disagreeing source of truth, so they are displayed and never edited.
   */
  function editableFields(typeSpec, entity) {
    var out = [];
    var has = function (key) { return core.isObject(entity) && entity[key] !== undefined; };
    if (!typeSpec.link || has('name')) out.push(NAME_SPEC);
    if (!typeSpec.link || has('description')) out.push(DESCRIPTION_SPEC);
    for (var i = 0; i < typeSpec.fields.length; i++) {
      var spec = typeSpec.fields[i];
      if (spec.derived) continue;
      if (!isRenderable(spec)) continue;
      out.push(spec);
    }
    return out;
  }

  /** The fields the registry computes. Shown, never written. */
  function derivedFields(typeSpec) {
    var out = [];
    for (var i = 0; i < typeSpec.fields.length; i++) {
      if (typeSpec.fields[i].derived) out.push(typeSpec.fields[i]);
    }
    return out;
  }

  /** Fields the registry declares that this module cannot render; preserved, shown as a note. */
  function unrenderedFields(typeSpec) {
    var out = [];
    for (var i = 0; i < typeSpec.fields.length; i++) {
      var spec = typeSpec.fields[i];
      if (spec.derived || isRenderable(spec)) continue;
      out.push(spec);
    }
    return out;
  }

  function isEmptyValue(v) {
    if (v === undefined || v === null) return true;
    if (core.isString(v)) return v.trim() === '';
    if (core.isArray(v)) return v.length === 0;
    if (core.isObject(v)) {
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) {
        if (!isEmptyValue(v[keys[i]])) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * A control's value, as the model would hold it.
   *
   * `undefined` means "absent" and the caller deletes the key rather than storing an empty one. That
   * distinction is real in this model: an absent `encrypted` and an `encrypted: false` are different
   * documents, and a form that turned the first into the second would change the file's bytes on an
   * export the user did not edit anything for.
   *
   * A value the kind cannot hold — `abc` in a number field — comes back as `undefined` here. That is
   * safe only because `validateValues` reports the same input as a blocking error first, so the
   * lossy path is unreachable from the form. It is reachable from a test, which is how it is pinned.
   *
   * Note what this function deliberately does *not* decide: whether an empty list or an empty object
   * means "nothing here". It translates, and `applyDraft` decides, because only `applyDraft` knows
   * what the entity held before the user touched it.
   */
  function coerceInput(spec, raw) {
    if (!spec) return raw === undefined ? undefined : core.deepCopy(raw);
    switch (spec.kind) {
      case 'string':
      case 'uri':
      case 'date':
      case 'datetime':
      case 'state':
      case 'enum':
        // Enum-shaped kinds take no empty string: `''` is not a member of any vocabulary and
        // `validate` would report it as one the model does not contain. Absent is the empty answer.
        if (raw === undefined || raw === null) return undefined;
        if (!core.isString(raw)) return undefined;
        if (spec.kind === 'string' || spec.kind === 'uri') return raw;
        return raw === '' ? undefined : raw;
      case 'number':
      case 'int': {
        if (raw === undefined || raw === null || raw === '') return undefined;
        var n = core.isNumber(raw) ? raw : Number(String(raw).trim());
        if (!isFinite(n)) return undefined;
        return spec.kind === 'int' ? Math.round(n) : n;
      }
      case 'boolean':
        if (raw === undefined || raw === null || raw === '') return undefined;
        if (core.isBoolean(raw)) return raw;
        return String(raw) === 'true';
      case 'stringList':
      case 'enumList':
      case 'refList': {
        if (!core.isArray(raw)) return undefined;
        var list = [];
        for (var i = 0; i < raw.length; i++) {
          var item = raw[i];
          if (core.isString(item) && item !== '') list.push(item);
        }
        return list;
      }
      case 'ref':
        if (!core.isString(raw) || raw === '') return undefined;
        return raw;
      case 'object': {
        if (!core.isObject(raw)) return undefined;
        // Rebuilt key by key rather than merged: the object came from our own controls, but a form
        // that deep-merged would be a form where a `__proto__` key in a draft reached a live model
        // (REQ-SEC-003). Nothing here merges untrusted input into an object with a prototype.
        return rebuildObject(spec, raw);
      }
      case 'objectList': {
        if (!core.isArray(raw)) return undefined;
        var rows = [];
        for (var r = 0; r < raw.length; r++) {
          var row = raw[r];
          if (!core.isObject(row) || isEmptyValue(row)) continue;
          rows.push(rebuildObject(spec, row));
        }
        return rows;
      }
      default:
        return raw === undefined ? undefined : core.deepCopy(raw);
    }
  }

  function rebuildObject(spec, raw) {
    var out = Object.create(null);
    var inner = spec.itemFields || [];
    for (var i = 0; i < inner.length; i++) {
      var child = coerceInput(inner[i], raw[inner[i].key]);
      if (child !== undefined) out[inner[i].key] = child;
    }
    return out;
  }

  /**
   * The candidate entity: the entity with the form's values applied.
   *
   * Only *changed* values are written. Keys, ordering and every field the form did not surface are
   * left exactly as the deep copy found them, which is what REQ-EDIT-009 asks for and what makes the
   * passthrough bags survive without this function knowing they exist.
   *
   * The one rule that needs stating is what an *empty* control means, because a text box cannot tell
   * "this field was absent" from "this field is empty":
   *
   *   - a field that was absent and is still empty stays absent. Without this, opening an entity
   *     whose `description` is absent and saving it would write `description: ""` — an edit the user
   *     did not make, reported in the commit summary and visible in the exported bytes.
   *   - a field that was present stays present, holding whatever the control now says. Present-and-
   *     empty is a real state in this model ("an empty string is a value, not an absence"), so
   *     clearing a filled-in description must *not* delete the key; it writes `""`.
   *
   * `undefined` is the other case entirely and comes from the control's own kind — an unset enum, an
   * unset date, a number that will not parse — and that one does delete, because the user chose
   * "Not set" from a list that offered it.
   */
  function applyDraft(entity, typeSpec, raw) {
    var next = core.isObject(entity) ? core.deepCopy(entity) : Object.create(null);
    var values = raw || {};
    var specs = editableFields(typeSpec, entity);
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var value = coerceInput(spec, values[spec.key]);
      var current = next[spec.key];
      if (value === undefined) {
        if (current !== undefined) delete next[spec.key];
        continue;
      }
      if (isEmptyValue(value) && current === undefined) continue;
      if (!core.deepEqual(value, current)) next[spec.key] = value;
    }
    return next;
  }

  /** The values a form starts from: the entity's own, in control-shaped form. */
  function draftOf(entity, typeSpec) {
    var out = Object.create(null);
    var specs = editableFields(typeSpec, entity);
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var v = core.isObject(entity) ? entity[spec.key] : undefined;
      out[spec.key] = v === undefined ? null : core.deepCopy(v);
    }
    return out;
  }

  function fieldAt(typeSpec, path) {
    var parts = String(path).split('.');
    var spec = specFor(typeSpec, parts[0]);
    for (var i = 1; i < parts.length && spec; i++) {
      var inner = null;
      var list = spec.itemFields || [];
      // A list index is not an item field name, so it is skipped rather than looked up.
      if (/^\d+$/.test(parts[i])) continue;
      for (var j = 0; j < list.length; j++) {
        if (list[j].key === parts[i]) { inner = list[j]; break; }
      }
      spec = inner;
    }
    return spec;
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Option lists
  //
  // Every one of these puts the *current* value first if the vocabulary or the model does not
  // contain it. See decision 5 at the top of this file.
  // ---------------------------------------------------------------------------------------------

  /** A value outside the vocabulary, labelled so the user can see it is unusual without losing it. */
  function outsideOption(value, note) {
    return { value: value, label: value, note: note || 'Not one of the usual values — kept as written' };
  }

  function vocabularyOptions(spec) {
    var vocab = spec.vocab ? M.VOCAB[spec.vocab] : null;
    var out = [];
    if (!core.isArray(vocab)) return out;
    for (var i = 0; i < vocab.length; i++) out.push({ value: vocab[i], label: vocab[i] });
    return out;
  }

  /** The choices for an `enum`, `state` or `enumList`, including the value the entity already holds. */
  function enumOptions(spec, current) {
    var out = vocabularyOptions(spec);
    var held = core.isArray(current) ? current : current === undefined || current === null ? [] : [current];
    for (var i = 0; i < held.length; i++) {
      var seen = false;
      for (var j = 0; j < out.length; j++) if (out[j].value === held[i]) { seen = true; break; }
      if (!seen) out.push(outsideOption(held[i]));
    }
    return out;
  }

  /**
   * Which entity types a reference field may point at.
   *
   * A field with a `typeField` narrows by the value of that field on the same entity — a data flow's
   * source may be an actor, a component or a data store, and which one is decided by `sourceType`.
   * `05-model.js` owns that rule (`expectedTargets`) and this reads the same `typeMap` rather than
   * re-deriving it, so a change to one is a change to both.
   */
  function referenceTypes(spec, entity) {
    if (!spec.typeField || !spec.typeMap) return spec.ref || [];
    var t = core.isObject(entity) ? entity[spec.typeField] : undefined;
    var mapped = t && spec.typeMap[t];
    return mapped ? [mapped] : spec.ref || [];
  }

  function indexById(list) {
    var out = Object.create(null);
    if (!core.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      if (core.isObject(list[i]) && core.isString(list[i].id)) out[list[i].id] = list[i];
    }
    return out;
  }

  /**
   * The candidate entities for a reference field, plus the ids that are currently held but no longer
   * resolve.
   *
   * A dangling id is included rather than dropped. Dropping it would mean that saving a form the user
   * did not change silently repaired the model, and "no edit path can create a dangling reference"
   * (REQ-EDIT-003 AC2) is about not *creating* one — not about quietly deleting the ones an import
   * brought in. It is labelled as missing and can be cleared deliberately.
   */
  function referenceCandidates(model, typeSpec, spec, entity) {
    var types = referenceTypes(spec, entity);
    var options = [];
    var known = Object.create(null);
    var several = types.length > 1;
    for (var i = 0; i < types.length; i++) {
      // `spec.ref` names its targets by singular (`trustZone`) because that is how the field table
      // reads, while a `typeMap` names them by array (`trustZones`) because that is how the wire
      // vocabulary reads. `M.typeFor` accepts either — going through it is what keeps this from
      // being a third place the two spellings have to agree.
      var target = M.typeFor(types[i]);
      if (!target) continue;
      var list = M.collection(model, target.key);
      for (var j = 0; j < list.length; j++) {
        var candidate = list[j];
        if (!core.isObject(candidate) || !core.isString(candidate.id)) continue;
        if (known[candidate.id]) continue;
        known[candidate.id] = true;
        options.push({
          value: candidate.id,
          label: referenceLabel(candidate, target, several),
          note: candidate.id,
        });
      }
    }
    var held = spec.kind === 'refList' ? (entity && core.isArray(entity[spec.key]) ? entity[spec.key] : [])
      : (entity && core.isString(entity[spec.key]) ? [entity[spec.key]] : []);
    var missing = [];
    for (var h = 0; h < held.length; h++) {
      if (known[held[h]]) continue;
      known[held[h]] = true;
      missing.push(held[h]);
      options.push({
        value: held[h],
        label: held[h] + ' — not in this model',
        note: 'The entity this points at is not here. Keeping it preserves what the file said; clearing it removes the reference.',
      });
    }
    options.sort(function (a, b) {
      // Missing targets sort last whatever their names look like, so the list a user scrolls is the
      // entities that exist, with the anomalies parked at the bottom.
      var am = missing.indexOf(a.value) !== -1 ? 1 : 0;
      var bm = missing.indexOf(b.value) !== -1 ? 1 : 0;
      if (am !== bm) return am - bm;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
    return { options: options, missing: missing, types: types };
  }

  /**
   * A reference candidate's label.
   *
   * The type is prepended only when the field admits more than one, because only then is it doing
   * work: a flow's source list mixes actors, components and data stores, and "Payments API" means
   * three different things across those three. On a single-type field every entry would carry the
   * same redundant prefix.
   */
  function referenceLabel(entity, targetSpec, withType) {
    var label = M.labelOf(entity);
    return withType && targetSpec ? targetSpec.label + ' — ' + label : label;
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Validation
  // ---------------------------------------------------------------------------------------------

  /**
   * Input problems the model cannot see, because they are about the *control* rather than the value.
   *
   * Two rules live here and nowhere else, which is deliberate — the model's own checker is the source
   * of every other message. Each is a case where the form's control is stricter than the model:
   *
   *   - `name` is absent. The model reports it as a warning, because an imported entity without a
   *     name is not *invalid*, it is unnamed. But the form is the one place the user is being asked
   *     for a name, so accepting a blank one and then warning about it afterwards would be asking a
   *     question and ignoring the answer.
   *   - a non-integer in an `int` field. `coerceField` rounds; the form refuses. Rounding a typed
   *     `1.5` up to `2` is an edit the user did not make and cannot see.
   *
   * Both are recorded as UI rules in IMPLEMENTATION-STATUS.md.
   */
  function inputProblems(typeSpec, raw, entity) {
    var problems = [];
    var specs = editableFields(typeSpec, entity);
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var value = raw ? raw[spec.key] : undefined;
      if (spec.key === 'name' && !typeSpec.link && isEmptyValue(value)) {
        problems.push({ path: 'name', message: 'A ' + typeSpec.label.toLowerCase() + ' needs a name.' });
        continue;
      }
      if ((spec.kind === 'number' || spec.kind === 'int') && !isEmptyValue(value)) {
        var n = core.isNumber(value) ? value : Number(String(value).trim());
        if (!isFinite(n)) {
          problems.push({ path: spec.key, message: spec.label + ' must be a number.' });
        } else if (spec.kind === 'int' && Math.floor(n) !== n) {
          problems.push({ path: spec.key, message: spec.label + ' must be a whole number.' });
        }
      }
    }
    return problems;
  }

  function indexOfId(list, id) {
    if (!core.isArray(list)) return -1;
    for (var i = 0; i < list.length; i++) {
      if (core.isObject(list[i]) && list[i].id === id) return i;
    }
    return -1;
  }

  /**
   * Give a candidate entity an id if it has not got one.
   *
   * Every check the model makes is keyed by an id, and an entity being created does not have one until
   * it is inserted — so without this, checking a *new* entity produces a report with an unaddressable
   * entity in it and no way to tell the "no id" error apart from a real one. The id is the entity's
   * own (`M.insert` keeps a supplied id), so the one the form shows after a create is the one that was
   * validated.
   */
  function ensureId(entity) {
    if (core.isObject(entity) && (!core.isString(entity.id) || entity.id === '')) entity.id = core.uuid();
    return entity;
  }

  /**
   * A model with `entity` substituted into its own collection, for validation.
   *
   * Shallow: one array is copied and one element replaced, so checking an edit costs one array copy
   * rather than a copy of the model. The entity is placed at the position it already occupies, so the
   * paths in the report name the entity the user is looking at and nothing else.
   */
  function probeModel(model, typeKey, entity) {
    var probe = Object.create(null);
    var keys = Object.keys(model || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      probe[k] = model[k];
    }
    var list = core.isArray(probe[typeKey]) ? probe[typeKey].slice() : [];
    var at = indexOfId(list, entity.id);
    if (at < 0) {
      at = list.length;
      list.push(entity);
    } else {
      list[at] = entity;
    }
    probe[typeKey] = list;
    return { model: probe, at: at };
  }

  /**
   * The model's own problems with one entity, keyed by field path.
   *
   * The paths a report carries are `/typeKey/index/field/sub`, so the entity's own prefix is removed
   * and what is left is the path the controls use. A problem about the entity as a whole (a duplicate
   * id, a shape complaint) leaves an empty remainder and is attached to the form rather than a field.
   */
  function validateEntity(model, typeSpec, entity) {
    ensureId(entity);
    var probe = probeModel(model, typeSpec.key, entity);
    var report = M.validate(probe.model, { referential: 'error' });
    var prefix = '/' + typeSpec.key + '/' + probe.at;
    var out = { fields: [], form: [], problems: [], valid: true };
    for (var i = 0; i < report.problems.length; i++) {
      var p = report.problems[i];
      if (p.path !== prefix && p.path.indexOf(prefix + '/') !== 0) continue;
      var rest = p.path === prefix ? '' : p.path.slice(prefix.length + 1).replace(/\//g, '.');
      out.problems.push({ path: rest, code: p.code, message: p.message, severity: p.severity });
      if (p.severity === M.SEVERITY_ERROR) out.valid = false;
      if (rest === '') out.form.push(p);
      else out.fields.push({ path: rest, code: p.code, message: p.message, severity: p.severity });
    }
    return out;
  }

  /**
   * Everything wrong with a draft: the control rules, then the model's.
   *
   * Returns the candidate entity as well, because the caller needs to store exactly what was
   * validated — building it twice is how a form ends up saving something other than what it checked.
   */
  function validateValues(model, typeSpec, entity, raw) {
    var candidate = applyDraft(entity, typeSpec, raw);
    ensureId(candidate);
    var messages = Object.create(null);
    var list = [];

    function add(path, message, severity) {
      if (!message) return;
      list.push({ path: path, message: message, severity: severity || 'error' });
      if (!messages[path]) messages[path] = message;
    }

    var inputs = inputProblems(typeSpec, raw, entity);
    for (var i = 0; i < inputs.length; i++) add(inputs[i].path, inputs[i].message);

    var report = validateEntity(model, typeSpec, candidate);
    for (var j = 0; j < report.fields.length; j++) {
      add(report.fields[j].path, report.fields[j].message, report.fields[j].severity);
    }
    for (var k = 0; k < report.form.length; k++) {
      // A problem about the entity as a whole has no field to sit under, so it is keyed by the empty
      // path and the form shows it in its own summary region.
      add('', report.form[k].message, report.form[k].severity);
    }

    var valid = true;
    for (var m = 0; m < list.length; m++) {
      if (list[m].severity !== 'warning') valid = false;
    }
    return { valid: valid, candidate: candidate, messages: messages, problems: list, report: report };
  }

  /** A problem's field path, reduced to the control that should carry it. */
  function controlPath(specs, path) {
    if (path === '') return '';
    for (var i = 0; i < specs.length; i++) {
      if (specs[i] === path) return specs[i];
    }
    var first = String(path).split('.')[0];
    for (var j = 0; j < specs.length; j++) {
      if (specs[j] === first) return specs[j];
    }
    return '';
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Model operations
  //
  // Every function here returns a new model and leaves its argument alone. See decision 1.
  // ---------------------------------------------------------------------------------------------

  /** A new model object holding the same arrays. */
  function shareModel(model) {
    var next = Object.create(null);
    var keys = Object.keys(model || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      next[k] = model[k];
    }
    return next;
  }

  /** A new model object with one collection independently owned. */
  function fork(model, typeKey) {
    var next = shareModel(model);
    next[typeKey] = core.isArray(model[typeKey]) ? model[typeKey].slice() : [];
    return next;
  }

  /**
   * Replace each named entity in a forked model with its own copy.
   *
   * This is the whole of the aliasing defence: after it, mutating an entity through the model API
   * cannot be seen from the model we were given, which is what keeps the undo stack's snapshot of
   * that model as it was.
   */
  function isolate(next, touched) {
    for (var i = 0; i < touched.length; i++) {
      var key = touched[i].type;
      var id = touched[i].id;
      var list = next[key];
      if (!core.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        if (core.isObject(list[j]) && list[j].id === id) {
          list[j] = core.deepCopy(list[j]);
          break;
        }
      }
    }
    return next;
  }

  function createEntity(model, typeKey, values) {
    var typeSpec = M.typeFor(typeKey);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + typeKey);
    var next = fork(model, typeSpec.key);
    var entity = M.insert(next, typeSpec.key, values || {});
    return { model: next, entity: entity, type: typeSpec };
  }

  function editEntity(model, typeKey, id, values) {
    var typeSpec = M.typeFor(typeKey);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + typeKey);
    var next = fork(model, typeSpec.key);
    isolate(next, [{ type: typeSpec.key, id: id }]);
    var entity = M.update(next, typeSpec.key, id, values || {});
    return { model: next, entity: entity, type: typeSpec };
  }

  /**
   * Write a form's candidate entity into the model, creating or updating as the id decides.
   *
   * This is the join between `entityForm` and the model, and it is here rather than in each view
   * because the difference between creating and updating is not a difference the caller should have to
   * remember — it is whether the id is already in the model, and only the model knows.
   *
   * A whole candidate is written rather than a field-by-field patch, and that is what makes an edit
   * lose nothing: `applyDraft` already removed the keys the user cleared and left every key it did not
   * surface exactly as it found it, so the candidate *is* the entity as it should now be. What
   * `TMV.model.update` needs on top is the keys that vanished — a key in the entity that is not in the
   * candidate is passed as `undefined`, which is how `update` is told to delete rather than store.
   */
  function saveEntity(model, typeKey, candidate) {
    var typeSpec = M.typeFor(typeKey);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + typeKey);
    if (!core.isObject(candidate)) throw TMV.error('EDIT_ENTITY', 'There is nothing to save.');
    ensureId(candidate);
    var existing = M.get(model, typeSpec.key, candidate.id);

    if (!existing) {
      // `M.insert` keeps a supplied id, so the identifier the form minted and validated is the one
      // that ends up in the file — not a second one minted at the last moment.
      var created = fork(model, typeSpec.key);
      return { model: created, entity: M.insert(created, typeSpec.key, candidate), type: typeSpec, created: true };
    }

    var patch = Object.create(null);
    var keys = Object.keys(candidate);
    for (var i = 0; i < keys.length; i++) patch[keys[i]] = candidate[keys[i]];
    // A field the entity has and the candidate does not is one the user cleared. Naming it in the
    // patch with `undefined` is how `TMV.model.update` is told to remove the key rather than leave it
    // behind — without this, clearing a description would change nothing at all.
    var previous = Object.keys(existing);
    for (var j = 0; j < previous.length; j++) {
      // `in`, not a truthiness test: a null-prototype patch has no inherited keys, so this asks
      // exactly "did the candidate name this field". Assigning blindly would set every field the
      // candidate *did* name back to `undefined` and delete the entity's own id.
      if (!(previous[j] in patch)) patch[previous[j]] = undefined;
    }
    var next = fork(model, typeSpec.key);
    isolate(next, [{ type: typeSpec.key, id: candidate.id }]);
    return { model: next, entity: M.update(next, typeSpec.key, candidate.id, patch), type: typeSpec, created: false };
  }

  /**
   * What deleting an entity would do, without doing any of it.
   *
   * Three groups, and the distinction between the last two is the one REQ-EDIT-004 AC1 is about:
   *
   *   - `cascaded` — link entities that only exist to record a relationship involving this one. They
   *     go, because there is no fact left for them to record (`05-model.js` `cascadeDeletes`).
   *   - `orphaned` — entities that keep existing but lose a reference. The flow whose source this
   *     was is the case the requirement names; its endpoint becomes empty rather than the flow
   *     disappearing, and the user decides which they meant.
   *   - `endpoints` — the subset of `orphaned` that are flow endpoints. Named separately because a
   *     data flow with no source is a different kind of damage from a component with no parent, and
   *     the prompt should say so rather than counting them together.
   *
   * The cascade is computed on a copy because `cascadeDeletes` removes as it walks. Only the
   * collections it can touch are copied — the four link types — so this stays proportional to the
   * links in the model rather than its size.
   */
  function planDelete(model, typeKey, id) {
    var typeSpec = M.typeFor(typeKey);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + typeKey);
    var entity = M.get(model, typeSpec.key, id);
    if (!entity) return null;

    var probe = shareModel(model);
    for (var i = 0; i < M.TYPES.length; i++) {
      var t = M.TYPES[i];
      if (t.dependsOn || t.key === typeSpec.key) {
        probe[t.key] = core.isArray(model[t.key]) ? model[t.key].slice() : [];
      }
    }
    var raws = M.cascadeDeletes(probe, id);
    var cascaded = [];
    var gone = Object.create(null);
    gone[id] = true;
    for (var c = 0; c < raws.length; c++) {
      gone[raws[c].id] = true;
      var found = M.get(model, raws[c].type, raws[c].id);
      cascaded.push({
        type: raws[c].type,
        typeSpec: M.TYPE_BY_KEY[raws[c].type],
        entity: found,
        label: M.labelOf(found),
      });
    }

    var referrers = M.referrersOf(model, id);
    var orphaned = [];
    var endpoints = [];
    for (var r = 0; r < referrers.length; r++) {
      var ref = referrers[r];
      if (gone[ref.entity.id]) continue;
      var entry = {
        type: ref.type,
        typeSpec: ref.typeSpec,
        entity: ref.entity,
        field: ref.field,
        label: M.labelOf(ref.entity),
      };
      orphaned.push(entry);
      // The canonical model's one required endpoint pair. Not a general "required" concept — the
      // registry has none — so it is keyed to the fields that are actually endpoints of a flow.
      if (ref.type === 'dataFlows' && (ref.field.key === 'sourceId' || ref.field.key === 'destinationId')) {
        entry.endpoint = ref.field.key === 'sourceId' ? 'source' : 'destination';
        endpoints.push(entry);
      }
    }

    return {
      type: typeSpec.key,
      typeSpec: typeSpec,
      entity: entity,
      label: M.labelOf(entity),
      cascaded: cascaded,
      orphaned: orphaned,
      endpoints: endpoints,
      empty: cascaded.length === 0 && orphaned.length === 0,
    };
  }

  /**
   * Delete an entity.
   *
   * `options.alsoRemove` is the user's answer to the prompt: the ids of orphaned entities they chose
   * to delete rather than leave without their reference. Those go first, so their own links and
   * referrers are handled by the same rules rather than by a second pass with different behaviour.
   *
   * This is the one operation that copies the whole model rather than the parts it expects to touch,
   * and the reason is that the parts are not knowable in advance. `TMV.model.remove` splices the link
   * collections, drops the references pointing at what it removed, and then drops the references
   * pointing at each of *those* — so the entities it may reach is the transitive closure of the
   * referrer graph, not the set `planDelete` can name. Copying only what the plan lists leaves the
   * rest aliased, and the aliasing would surface as an undo that restores an entity whose references
   * were quietly cleared. A whole-model copy is one line, is complete by construction, and a delete
   * is a user action rather than a loop.
   */
  function deleteEntity(model, typeKey, id, options) {
    var opts = options || {};
    var plan = planDelete(model, typeKey, id);
    if (!plan) return null;

    var next = core.deepCopy(model);
    var also = opts.alsoRemove || [];
    for (var n = 0; n < also.length; n++) {
      // An orphaned entity is by definition of some *other* type — the flow whose component this was.
      // So each id is resolved against the whole model rather than assumed to share the root's type,
      // which is the mistake that makes "delete them too" quietly do nothing.
      var target = M.findAnywhere(next, also[n]);
      if (target) M.remove(next, target.type, target.entity.id);
    }
    var removed = M.remove(next, typeKey, id);
    return {
      model: next,
      plan: plan,
      entity: removed.entity,
      cascaded: removed.cascaded,
      alsoRemoved: also,
      referencesDropped: plan.orphaned.length,
    };
  }

  /**
   * A bulk patch over many entities (REQ-EDIT-008).
   *
   * Per-entity validation, and a failure skips that entity rather than the operation: one entity in a
   * selection that cannot take the value is a fact to report, not a reason to abandon the other
   * ninety-nine edits the user asked for and has no way to re-issue in one go.
   *
   * The patch is applied through the same `applyDraft`/`validateValues` pair the single-entity form
   * uses, so a bulk edit cannot reach a state a single edit could not.
   */
  function bulkUpdate(model, typeKey, ids, patch) {
    var typeSpec = M.typeFor(typeKey);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + typeKey);
    var specs = editableFields(typeSpec, null);
    var writable = Object.create(null);
    for (var s = 0; s < specs.length; s++) writable[specs[s].key] = true;
    var keys = Object.keys(patch || {});
    for (var q = 0; q < keys.length; q++) {
      // A key this type has no field for would otherwise be dropped by `applyDraft` on every entity,
      // and the operation would report every entity as updated while changing none of them. Refusing
      // is the only answer that does not amount to a silent lie about what happened.
      if (!writable[keys[q]]) {
        throw TMV.error('EDIT_FIELD', typeSpec.label + ' has no editable field named ' + keys[q] + '.');
      }
    }
    var next = model;
    var applied = [];
    var failed = [];
    for (var i = 0; i < (ids || []).length; i++) {
      var id = ids[i];
      var entity = M.get(next, typeSpec.key, id);
      if (!entity) {
        failed.push({ id: id, label: id, problems: [{ path: '', message: 'Not in this model.' }] });
        continue;
      }
      var raw = draftOf(entity, typeSpec);
      for (var k = 0; k < keys.length; k++) raw[keys[k]] = patch[keys[k]];
      var check = validateValues(next, typeSpec, entity, raw);
      if (!check.valid) {
        failed.push({ id: id, label: M.labelOf(entity), problems: check.problems });
        continue;
      }
      // One fork per entity would be wasteful; one fork for the whole operation is not, because each
      // `editEntity` would fork an array the previous one has already forked. So the loop forks once
      // — on the first entity that is actually accepted, which is why the fork is *here* and not
      // before the loop: a first entity that fails validation must not have left the caller's model
      // forked-but-unedited and, worse, must not let the second entity's update run against it.
      if (next === model) next = fork(next, typeSpec.key);
      isolate(next, [{ type: typeSpec.key, id: id }]);
      M.update(next, typeSpec.key, id, patch);
      applied.push(id);
    }
    return { model: next, applied: applied, failed: failed, changed: applied.length > 0 };
  }

  /**
   * Bulk delete (REQ-EDIT-008).
   *
   * One copy of the model and one `TMV.model.remove` per id, against the evolving copy — rather than
   * `deleteEntity` in a loop, which would copy the whole model once per selected row. What the
   * per-entity dialog decides for a single delete (whether to keep the referrers) is not asked here:
   * a multi-select is the user saying "these", and the answer to "and what about the things pointing
   * at them" is reported afterwards rather than put to a vote row by row.
   */
  function bulkDelete(model, typeKey, ids) {
    var next = core.deepCopy(model);
    var removed = [];
    var cascaded = [];
    var orphaned = [];
    var gone = Object.create(null);
    for (var i = 0; i < (ids || []).length; i++) {
      // The plan is what knows the difference between "this will be cascaded away" and "this will be
      // left without its reference" — an entity that is a referrer *and* a dependant, which a threat
      // application is to the component it is about, would otherwise be reported as orphaned and then
      // deleted, and the report would name something that no longer exists.
      var plan = planDelete(next, typeKey, ids[i]);
      if (!plan) continue;
      gone[plan.entity.id] = true;
      for (var c = 0; c < plan.cascaded.length; c++) gone[plan.cascaded[c].entity.id] = true;
      for (var o = 0; o < plan.orphaned.length; o++) {
        if (gone[plan.orphaned[o].entity.id]) continue;
        if (orphaned.indexOf(plan.orphaned[o].label) === -1) orphaned.push(plan.orphaned[o].label);
      }
      var result = M.remove(next, typeKey, plan.entity.id);
      if (result.entity) removed.push(result.entity);
      for (var k = 0; k < result.cascaded.length; k++) {
        gone[result.cascaded[k].id] = true;
        cascaded.push(result.cascaded[k]);
      }
    }
    return { model: next, removed: removed, cascaded: cascaded, orphaned: orphaned };
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Undo (REQ-EDIT-010)
  //
  // A stack of whole previous working models. See decision 1 for why this is not a reverse patch.
  // ---------------------------------------------------------------------------------------------

  var undoStack = [];

  function pushUndo(label, previousModel) {
    if (!core.isObject(previousModel)) return null;
    undoStack.push({ label: label, model: previousModel, at: new Date().toISOString(), size: undoStack.length });
    while (undoStack.length > UNDO_LIMIT) undoStack.shift();
    return undoStack[undoStack.length - 1];
  }

  function undoDepth() {
    return undoStack.length;
  }

  function undoPeek() {
    var top = undoStack[undoStack.length - 1];
    return top ? { label: top.label, at: top.at } : null;
  }

  /**
   * Undo the last operation.
   *
   * Returns the restored model, or null when there is nothing to undo. The stack is *not* cleared by
   * a commit — the caller clears it (`clearUndo`) when the history moves, because a commit does not
   * make the previous model wrong, it makes it a commit the user can already get back to. Leaving
   * that decision to the caller keeps this function honest about what it knows.
   */
  function undo() {
    var top = undoStack.pop();
    if (!top) return null;
    return { model: top.model, label: top.label };
  }

  function clearUndo() {
    undoStack = [];
  }

  // ---------------------------------------------------------------------------------------------
  // 6. The change summary (REQ-EDIT-006 AC)
  // ---------------------------------------------------------------------------------------------

  /** Model-level fields, labelled. Anything else at the top level is reported by its own key. */
  var MODEL_FIELD_LABELS = {
    name: 'Model name',
    description: 'Model description',
    scope: 'Scope',
    metadata: 'Metadata',
    tmvFormat: 'Format version',
    modelId: 'Model id',
  };

  /**
   * What changed between two models, counted three ways.
   *
   * By identity, never by position: a commit's own summary says "3 added, 1 modified, 2 removed", and
   * an array-index comparison would call every entity after an insertion "modified". The comparison
   * is `core.deepEqual`, which is the same equality the hasher uses, so the summary and the commit's
   * own decision about whether anything changed cannot disagree.
   *
   * A model-level change is reported separately from the entity counts. Renaming a model is a change
   * and it belongs in the dialog; counting it as an entity would make the three counts not add up to
   * the list underneath them.
   */
  function summariseChanges(headModel, workingModel) {
    var summary = {
      added: 0,
      modified: 0,
      removed: 0,
      total: 0,
      byType: [],
      modelFields: [],
      empty: true,
    };
    if (!core.isObject(headModel) || !core.isObject(workingModel)) return summary;

    for (var i = 0; i < M.TYPES.length; i++) {
      var t = M.TYPES[i];
      var before = indexById(M.collection(headModel, t.key));
      var after = indexById(M.collection(workingModel, t.key));
      var changes = [];
      var counts = { added: 0, modified: 0, removed: 0 };
      var ids = core.sortedKeys(after);
      for (var a = 0; a < ids.length; a++) {
        var added = after[ids[a]];
        if (!before[ids[a]]) {
          counts.added++;
          changes.push({ kind: 'added', id: ids[a], label: M.labelOf(added) });
        } else if (!core.deepEqual(before[ids[a]], added)) {
          counts.modified++;
          changes.push({ kind: 'modified', id: ids[a], label: M.labelOf(added) });
        }
      }
      var oldIds = core.sortedKeys(before);
      for (var r = 0; r < oldIds.length; r++) {
        if (after[oldIds[r]]) continue;
        counts.removed++;
        changes.push({ kind: 'removed', id: oldIds[r], label: M.labelOf(before[oldIds[r]]) });
      }
      if (!changes.length) continue;
      summary.added += counts.added;
      summary.modified += counts.modified;
      summary.removed += counts.removed;
      summary.byType.push({
        key: t.key,
        label: t.plural,
        singular: t.singular,
        added: counts.added,
        modified: counts.modified,
        removed: counts.removed,
        total: changes.length,
        changes: changes,
      });
    }

    summary.modelFields = modelFieldChanges(headModel, workingModel);
    summary.total = summary.added + summary.modified + summary.removed + summary.modelFields.length;
    summary.empty = summary.total === 0;
    return summary;
  }

  function modelFieldChanges(before, after) {
    var out = [];
    var known = Object.create(null);
    for (var e = 0; e < M.ENTITY_KEYS.length; e++) known[M.ENTITY_KEYS[e]] = true;
    var keys = core.sortedKeys(before).concat(core.sortedKeys(after));
    var seen = Object.create(null);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (seen[key] || known[key]) continue;
      seen[key] = true;
      var b = before[key];
      var a = after[key];
      if (core.deepEqual(b, a)) continue;
      out.push({
        key: key,
        label: MODEL_FIELD_LABELS[key] || key,
        from: describeValue(b),
        to: describeValue(a),
      });
    }
    return out;
  }

  /** A scalar as text for a summary line. `—` for absent, because an empty string and no value read alike. */
  function describeValue(v) {
    if (v === undefined || v === null) return '—';
    if (core.isString(v)) return v === '' ? '—' : core.truncate(v, 60);
    if (core.isBoolean(v)) return v ? 'Yes' : 'No';
    if (core.isNumber(v)) return String(v);
    if (core.isArray(v)) return core.plural(v.length, 'entry', 'entries');
    if (core.isObject(v)) return core.plural(Object.keys(v).length, 'field');
    return String(v);
  }

  /** "2 added · 1 modified · 3 removed", omitting the zeroes. */
  function summaryText(summary) {
    var parts = [];
    if (summary.added) parts.push(summary.added + ' added');
    if (summary.modified) parts.push(summary.modified + ' modified');
    if (summary.removed) parts.push(summary.removed + ' removed');
    if (summary.modelFields && summary.modelFields.length) {
      parts.push(core.plural(summary.modelFields.length, 'model field'));
    }
    return parts.length ? parts.join(' · ') : 'No changes';
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The action dispatcher for modals
  //
  // `widgets.modal` renders its actions and hands back the instance; it deliberately does not decide
  // what a button means, because "Cancel" cancels one dialog and discards a draft in another. So the
  // caller dispatches, and this is the dispatcher — shared rather than written three times here and
  // again in 16-compare.js. If a module beyond this one needs it, it belongs in 12-widgets.js.
  // ---------------------------------------------------------------------------------------------

  function modalActions(instance, handler) {
    return core.on(instance.element, 'click', function (event) {
      var node = core.closestAction(event.target, instance.element);
      if (!node || node.getAttribute('disabled') !== null) return;
      var action = node.getAttribute('data-action');
      if (!action) return;
      event.preventDefault();
      handler(action, {
        name: node.getAttribute('data-name'),
        value: node.getAttribute('data-value'),
        node: node,
        event: event,
      });
    });
  }

  /** The checked value of a radio group inside a dialog, or null. Not `:checked`, which is CSS. */
  function selectedRadio(root, name) {
    var found = root.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < found.length; i++) {
      if (found[i].getAttribute('name') === name && found[i].checked === true) {
        return found[i].getAttribute('value');
      }
    }
    return null;
  }

  function radioGroup(opts) {
    var options = opts || {};
    var name = options.name || ('tmv-radio-' + core.uuid().slice(0, 8));
    var group = core.el('div', { class: 'cds--radio-button-group tmv-choice-group' });
    var items = options.options || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = name + '-' + i;
      var input = core.el('input', {
        type: 'radio',
        class: widgets.CLS.radio,
        id: id,
        name: name,
        value: String(item.value),
      });
      input.checked = item.value === options.selected;
      var label = core.el('label', { class: 'cds--radio-button__label', for: id }, [
        core.el('span', { class: 'cds--radio-button__appearance' }),
        core.el('span', { text: item.label }),
      ]);
      var row = core.el('div', { class: 'cds--radio-button-wrapper tmv-choice' }, [input, label]);
      if (item.note) row.appendChild(core.el('p', { class: 'tmv-choice__note', text: item.note }));
      group.appendChild(row);
    }
    return { element: group, name: name, read: function () { return selectedRadio(group, name); } };
  }

  function checkboxGroup(opts) {
    var options = opts || {};
    var group = core.el('div', { class: 'cds--checkbox-group' });
    var boxes = [];
    var items = options.options || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = (options.id || 'tmv-checks') + '-' + i;
      var input = core.el('input', {
        type: 'checkbox',
        class: widgets.CLS.checkbox,
        id: id,
        value: String(item.value),
        'data-check': String(item.value),
      });
      input.checked = !!item.checked;
      var label = core.el('label', { class: 'cds--checkbox-label', for: id }, [
        core.el('span', { class: 'cds--checkbox-label-text', text: item.label }),
      ]);
      var row = core.el('div', {
        class: 'cds--form-item cds--checkbox-wrapper tmv-check' + (item.disabled ? ' tmv-check--disabled' : ''),
        'data-search': String(item.label).toLowerCase(),
      }, [input, label]);
      group.appendChild(row);
      boxes.push({ input: input, item: item, row: row });
    }
    return {
      element: group,
      rows: boxes,
      // Option order, not click order: the array a list field produces has to hash the same for two
      // models the user built the same way, and click order is not a property of the model.
      read: function () {
        var out = [];
        for (var i = 0; i < boxes.length; i++) if (boxes[i].input.checked === true) out.push(boxes[i].item.value);
        return out;
      },
      filter: function (text) {
        var needle = String(text || '').toLowerCase();
        for (var i = 0; i < boxes.length; i++) {
          core.setHidden(boxes[i].row, needle !== '' && boxes[i].row.getAttribute('data-search').indexOf(needle) === -1);
        }
      },
    };
  }

  /** A label + control + inline message, for controls that are not `widgets.field`. */
  function shell(opts) {
    var options = opts || {};
    var id = options.id || ('tmv-fld-' + core.uuid().slice(0, 8));
    var messageId = id + '-msg';
    var message = core.el('p', { class: 'cds--form-requirement', id: messageId, hidden: true });
    var label = options.legend
      ? core.el('legend', { class: 'cds--label', text: options.label })
      : core.el('label', { class: 'cds--label', for: id, text: options.label });
    var root = options.legend
      ? core.el('fieldset', { class: 'cds--fieldset tmv-field' + (options.className ? ' ' + options.className : '') }, [label])
      : core.el('div', { class: 'cds--form-item tmv-field' + (options.className ? ' ' + options.className : '') }, [label]);
    if (options.hint) root.appendChild(core.el('p', { class: 'cds--form__helper-text', text: options.hint }));
    root.appendChild(options.control);
    root.appendChild(message);
    core.setAttr(options.described, 'aria-describedby', messageId);
    return {
      element: root,
      id: id,
      messageId: messageId,
      setError: function (text) {
        message.textContent = text || '';
        core.setHidden(message, !text);
        core.setClass(root, 'cds--form-item--invalid', !!text);
        if (options.invalidOn) core.setAttr(options.invalidOn, 'data-invalid', text ? 'true' : null);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Field renderers
  //
  // Each returns a handle: a root to mount, a `read` that gives the model a value, `setError` to
  // attach a message, and a path. The form treats them uniformly, which is what makes a nested
  // object list no different from a text box.
  // ---------------------------------------------------------------------------------------------

  function scalarKind(spec) {
    if (spec.multiline) return 'textarea';
    if (spec.kind === 'string' || spec.kind === 'uri') return 'text';
    if (spec.kind === 'number' || spec.kind === 'int') return 'number';
    if (spec.kind === 'date') return 'date';
    if (spec.kind === 'datetime') return 'datetime';
    return 'text';
  }

  function renderScalar(spec, path, value, ctx) {
    var widget = widgets.field({
      label: spec.label,
      id: ctx.idPrefix + '-' + path.replace(/\./g, '-'),
      kind: scalarKind(spec),
      // `widgets.field` picks its element from `kind` and its input `type` from this — a date input is
      // native on purpose (`07-ui.md` §5), and the model's dates are day-granularity anyway.
      type: spec.kind === 'number' || spec.kind === 'int' ? 'number'
        : spec.kind === 'date' ? 'date'
          : spec.kind === 'datetime' ? 'datetime-local' : 'text',
      value: value === undefined || value === null ? '' : String(value),
      rows: spec.multiline ? 4 : null,
      inputmode: spec.kind === 'number' || spec.kind === 'int' ? 'decimal' : null,
      hint: fieldHint(spec),
      placeholder: spec.kind === 'uri' ? 'https://' : null,
      required: spec.key === 'name' && !ctx.typeSpec.link,
      action: 'field',
    });
    return {
      path: path,
      spec: spec,
      root: widget.element,
      control: widget.control,
      read: function () { return widget.value(); },
      setValue: function (v) { widget.setValue(v === undefined || v === null ? '' : String(v)); },
      setError: widget.setError,
      focus: function () { widget.control.focus(); },
    };
  }

  /**
   * The hint under a field: its declared constraints, said in words.
   *
   * The byte limit is stated as a limit and not as a running count, because the hint is built once
   * and a live count would either be stale or need a re-render per keystroke — and the count is
   * already reported where it matters, by validation, at the moment it is exceeded.
   */
  function fieldHint(spec) {
    var bits = [];
    if (spec.kind === 'uri') bits.push('A URL.');
    if (spec.kind === 'number' || spec.kind === 'int') {
      if (spec.min !== undefined && spec.max !== undefined) bits.push('Between ' + spec.min + ' and ' + spec.max + '.');
      else if (spec.min !== undefined) bits.push('At least ' + spec.min + '.');
      else if (spec.max !== undefined) bits.push('At most ' + spec.max + '.');
      if (spec.kind === 'int') bits.push('A whole number.');
    }
    if (spec.maxBytes) bits.push('Up to ' + core.bytes(spec.maxBytes) + '.');
    return bits.length ? bits.join(' ') : null;
  }

  function renderBoolean(spec, path, value, ctx) {
    var widget = widgets.field({
      label: spec.label,
      id: ctx.idPrefix + '-' + path,
      kind: 'select',
      // Three states, not a checkbox. The canonical model distinguishes an absent flag from a false
      // one, and a checkbox has no way to say "not set" — so using one would write `false` over the
      // absence of the first entity the user opened, changing the file on an edit nobody made.
      placeholder: 'Not set',
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
      value: value === true ? 'true' : value === false ? 'false' : '',
      action: 'field',
    });
    return {
      path: path,
      spec: spec,
      root: widget.element,
      control: widget.control,
      read: function () { return widget.value(); },
      setValue: function (v) { widget.setValue(v === undefined || v === null ? '' : String(v)); },
      setError: widget.setError,
      focus: function () { widget.control.focus(); },
    };
  }

  function renderChoice(spec, path, value, ctx) {
    var widget = widgets.field({
      label: spec.label,
      id: ctx.idPrefix + '-' + path,
      kind: 'select',
      placeholder: 'Not set',
      options: enumOptions(spec, value),
      value: value === undefined || value === null ? '' : String(value),
      action: 'field',
    });
    return {
      path: path,
      spec: spec,
      root: widget.element,
      control: widget.control,
      read: function () { return widget.value(); },
      setValue: function (v) { widget.setValue(v === undefined || v === null ? '' : String(v)); },
      setError: widget.setError,
      focus: function () { widget.control.focus(); },
    };
  }

  function renderMultiChoice(spec, path, value, ctx) {
    var held = core.isArray(value) ? value : [];
    var options = spec.kind === 'enumList'
      ? enumOptions(spec, held)
      : referenceCandidates(ctx.model, ctx.typeSpec, spec, ctx.entity).options;
    var items = [];
    for (var i = 0; i < options.length; i++) {
      items.push({
        value: options[i].value,
        label: options[i].label,
        checked: held.indexOf(options[i].value) !== -1,
      });
    }
    var group = checkboxGroup({ options: items, id: ctx.idPrefix + '-' + path.replace(/[.]/g, '-') });
    var filters = null;
    if (spec.kind === 'refList' && items.length > REFERENCE_FILTER_AT) {
      // A component list in a real model is long, and a checkbox list of five hundred is a scroll bar
      // with no way to search it. The filter hides rows; it never removes them, so nothing that was
      // checked can be filtered out of existence and lost on save.
      filters = widgets.search({
        placeholder: 'Filter ' + spec.label.toLowerCase(),
        label: 'Filter ' + spec.label.toLowerCase(),
        delay: 120,
        onChange: function (text) { group.filter(text); },
      });
    }
    var wrapper = core.el('div', { class: 'tmv-check-group' });
    if (filters) wrapper.appendChild(filters.element);
    wrapper.appendChild(group.element);
    var box = shell({
      label: spec.label,
      control: wrapper,
      legend: true,
      described: group.element,
      className: 'tmv-field--group',
    });
    return {
      path: path,
      spec: spec,
      root: box.element,
      control: group.element,
      read: function () { return group.read(); },
      setError: box.setError,
      focus: function () {
        var first = group.element.querySelectorAll('input[type="checkbox"]');
        if (first.length) first[0].focus();
      },
    };
  }

  function renderStringList(spec, path, value, ctx) {
    var rows = core.el('div', { class: 'tmv-list-editor' });
    var handles = [];

    function addRow(initial) {
      var widget = widgets.field({
        label: spec.label + ' ' + (handles.length + 1),
        id: ctx.idPrefix + '-' + path.replace(/[.]/g, '-') + '-' + handles.length,
        kind: 'text',
        value: initial === undefined || initial === null ? '' : String(initial),
        className: 'tmv-list-row',
        action: 'list-value',
      });
      var remove = widgets.button({
        label: 'Remove',
        kind: 'ghost',
        size: 'sm',
        action: 'remove-row',
        ariaLabel: 'Remove this ' + spec.label.toLowerCase() + ' entry',
        icon: 'close',
      });
      var row = core.el('div', { class: 'tmv-list-row-wrap' }, [widget.element, remove]);
      rows.appendChild(row);
      var handle = { widget: widget, row: row, remove: remove };
      handles.push(handle);
      return handle;
    }

    var values = core.isArray(value) ? value : [];
    for (var i = 0; i < values.length; i++) addRow(values[i]);

    var add = widgets.button({ label: 'Add ' + spec.label.toLowerCase().replace(/s$/, ''), kind: 'ghost', size: 'sm', action: 'add-row', icon: 'add' });
    var wrapper = core.el('div', { class: 'tmv-list-editor__body' }, [rows, add]);
    var box = shell({ label: spec.label, control: wrapper, legend: true, described: rows, className: 'tmv-field--group' });

    function indexOf(node) {
      for (var i = 0; i < handles.length; i++) if (handles[i].remove === node) return i;
      return -1;
    }

    core.on(wrapper, 'click', function (event) {
      var node = core.closestAction(event.target, wrapper);
      if (!node) return;
      if (node.getAttribute('data-action') === 'add-row') {
        addRow('');
        var last = handles[handles.length - 1];
        last.widget.control.focus();
        if (ctx.onChange) ctx.onChange();
      } else if (node.getAttribute('data-action') === 'remove-row') {
        var at = indexOf(node);
        if (at === -1) return;
        rows.removeChild(handles[at].row);
        handles.splice(at, 1);
        // The row labels are positional, so they are renumbered after a removal — otherwise the
        // fourth tag keeps calling itself "Tag 4" and the numbering stops meaning anything.
        for (var i = 0; i < handles.length; i++) {
          var label = handles[i].widget.element.querySelector('label');
          if (label) label.textContent = spec.label + ' ' + (i + 1);
        }
        if (ctx.onChange) ctx.onChange();
      }
    });

    return {
      path: path,
      spec: spec,
      root: box.element,
      control: rows,
      read: function () {
        var out = [];
        for (var i = 0; i < handles.length; i++) {
          var v = handles[i].widget.value();
          if (v !== '' && v !== null && v !== undefined) out.push(String(v));
        }
        return out;
      },
      setError: box.setError,
      focus: function () { if (handles.length) handles[0].widget.control.focus(); },
    };
  }

  function renderReference(spec, path, value, ctx) {
    var candidates = referenceCandidates(ctx.model, ctx.typeSpec, spec, ctx.entity);
    var options = [{ value: '', label: 'Not set' }].concat(candidates.options);
    var trigger = core.el('div', {
      class: 'cds--list-box__field',
      role: 'combobox',
      tabindex: '0',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });
    var picker = widgets.dropdown({
      trigger: trigger,
      options: options,
      selected: value === undefined || value === null ? '' : String(value),
      label: spec.label,
      placeholder: 'Not set',
      id: ctx.idPrefix + '-' + path.replace(/[.]/g, '-') + '-list',
      onSelect: function () { if (ctx.onChange) ctx.onChange(); },
    });
    var box = shell({
      label: spec.label,
      control: trigger,
      described: trigger,
      className: 'tmv-field--ref',
      hint: candidates.missing.length ? 'This points at something that is not in this model.' : null,
    });
    return {
      path: path,
      spec: spec,
      root: box.element,
      control: trigger,
      read: function () { var v = picker.value(); return v === '' || v === null || v === undefined ? '' : String(v); },
      setValue: function (v) { picker.setValue(v === undefined || v === null ? '' : String(v)); },
      setError: box.setError,
      focus: function () { trigger.focus(); },
    };
  }

  function renderObject(spec, path, value, ctx) {
    var inner = spec.itemFields || [];
    var current = core.isObject(value) ? value : null;
    var handles = [];
    var body = core.el('div', { class: 'tmv-object' });
    for (var i = 0; i < inner.length; i++) {
      var child = inner[i];
      var childPath = path + '.' + child.key;
      var handle = renderField(child, childPath, current ? current[child.key] : undefined, ctx);
      handles.push(handle);
      body.appendChild(handle.root);
    }
    var box = shell({ label: spec.label, control: body, legend: true, described: body, className: 'tmv-field--object' });
    return {
      path: path,
      spec: spec,
      root: box.element,
      control: body,
      read: function () {
        var out = Object.create(null);
        for (var i = 0; i < handles.length; i++) {
          var v = coerceInput(handles[i].spec, handles[i].read());
          if (v !== undefined) out[handles[i].spec.key] = v;
        }
        return out;
      },
      setError: box.setError,
      focus: function () { if (handles.length) handles[0].focus(); },
    };
  }

  function renderObjectList(spec, path, value, ctx) {
    var inner = spec.itemFields || [];
    var rows = core.el('div', { class: 'tmv-list-editor__rows' });
    var entries = [];

    function addRow(initial) {
      var index = entries.length;
      var handles = [];
      var body = core.el('div', { class: 'tmv-object' });
      for (var i = 0; i < inner.length; i++) {
        var child = inner[i];
        var handle = renderField(child, path + '.' + index + '.' + child.key, initial ? initial[child.key] : undefined, ctx);
        handles.push(handle);
        body.appendChild(handle.root);
      }
      var remove = widgets.button({
        label: 'Remove',
        kind: 'ghost',
        size: 'sm',
        action: 'remove-row',
        ariaLabel: 'Remove this ' + spec.label.toLowerCase().replace(/s$/, ''),
        icon: 'close',
      });
      var group = core.el('fieldset', { class: 'cds--fieldset tmv-object-row' }, [
        core.el('legend', { class: 'cds--label', text: spec.label.replace(/s$/, '') + ' ' + (index + 1) }),
        body,
        remove,
      ]);
      rows.appendChild(group);
      var entry = { handles: handles, group: group, remove: remove };
      entries.push(entry);
      return entry;
    }

    var list = core.isArray(value) ? value : [];
    for (var i = 0; i < list.length; i++) addRow(list[i]);

    var add = widgets.button({ label: 'Add ' + spec.label.toLowerCase().replace(/s$/, ''), kind: 'ghost', size: 'sm', action: 'add-row', icon: 'add' });
    var wrapper = core.el('div', { class: 'tmv-list-editor__body' }, [rows, add]);
    var box = shell({ label: spec.label, control: wrapper, legend: true, described: rows, className: 'tmv-field--group' });

    core.on(wrapper, 'click', function (event) {
      var node = core.closestAction(event.target, wrapper);
      if (!node) return;
      if (node.getAttribute('data-action') === 'add-row') {
        addRow(null);
        if (ctx.onChange) ctx.onChange();
      } else if (node.getAttribute('data-action') === 'remove-row') {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].remove !== node) continue;
          rows.removeChild(entries[i].group);
          entries.splice(i, 1);
          if (ctx.onChange) ctx.onChange();
          return;
        }
      }
    });

    return {
      path: path,
      spec: spec,
      root: box.element,
      control: rows,
      read: function () {
        var out = [];
        for (var i = 0; i < entries.length; i++) {
          var row = Object.create(null);
          for (var j = 0; j < entries[i].handles.length; j++) {
            var handle = entries[i].handles[j];
            var v = coerceInput(handle.spec, handle.read());
            if (v !== undefined) row[handle.spec.key] = v;
          }
          if (!isEmptyValue(row)) out.push(row);
        }
        return out;
      },
      setError: box.setError,
      focus: function () {
        if (entries.length && entries[0].handles.length) entries[0].handles[0].focus();
      },
    };
  }

  /** The derived value of a computed field, recomputed from the entity the form currently reads. */
  function derivedValue(spec, entity) {
    if (!core.isObject(entity)) return null;
    if (spec.derived === 'riskScore') return M.riskScore(entity.likelihood, entity.impact);
    if (spec.derived === 'riskLevel') return M.riskLevel(M.riskScore(entity.likelihood, entity.impact));
    return null;
  }

  function renderDerived(spec, entity) {
    var computed = derivedValue(spec, entity);
    var recorded = entity ? entity[spec.key] : undefined;
    var text = computed === null || computed === undefined ? 'Not computable' : String(computed);
    var conflicts = recorded !== undefined && !core.deepEqual(recorded, computed);
    var body = core.el('div', { class: 'tmv-derived' }, [
      core.el('p', {
        class: 'tmv-derived__value',
        text: spec.label + ': ' + text,
        'data-derived': spec.derived,
      }),
      // Shown rather than hidden: the value is in the file, and if it disagrees with what the model
      // computes from likelihood and impact, the disagreement is a fact about the model. Silently
      // displaying the computed one would hide a field the user exported.
      conflicts
        ? core.el('p', {
            class: 'tmv-derived__note',
            text: 'This file records ' + describeValue(recorded) + '. It is derived, so it is shown rather than edited.',
          })
        : null,
    ]);
    return core.el('div', { class: 'cds--form-item tmv-field tmv-field--derived' }, [
      core.el('span', { class: 'cds--label', text: spec.label + ' (derived)' }),
      body,
    ]);
  }

  function renderField(spec, path, value, ctx) {
    switch (spec.kind) {
      case 'boolean': return renderBoolean(spec, path, value, ctx);
      case 'enum':
      case 'state': return renderChoice(spec, path, value, ctx);
      case 'enumList':
      case 'refList': return renderMultiChoice(spec, path, value, ctx);
      case 'ref': return renderReference(spec, path, value, ctx);
      case 'stringList': return renderStringList(spec, path, value, ctx);
      case 'object': return renderObject(spec, path, value, ctx);
      case 'objectList': return renderObjectList(spec, path, value, ctx);
      default: return renderScalar(spec, path, value, ctx);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 9. The form
  // ---------------------------------------------------------------------------------------------

  /**
   * A form for one entity.
   *
   * `opts.entity` is the entity being edited, or null to create one. The form owns its controls and
   * reads them; it owns nothing else. In particular it does not touch the model — `onSubmit` receives
   * the validated candidate entity and the caller decides what to do with it, which is what lets the
   * same form serve a create, an edit and a bulk path without three code paths that can drift.
   */
  function entityForm(opts) {
    var options = opts || {};
    var typeSpec = M.typeFor(options.type);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + options.type);
    // Creating an entity still needs one, and it has to be the *same* one on every keystroke: an id
    // minted per validation would mean the entity that finally gets inserted is not the one that was
    // checked, and a duplicate-id report would depend on how many times the user pressed a key.
    var isNew = !core.isObject(options.entity);
    var entity = isNew ? { id: core.isString(options.id) ? options.id : core.uuid() } : options.entity;
    var model = options.model || M.createEmpty();
    var idPrefix = options.idPrefix || ('tmv-form-' + typeSpec.singular + '-' + core.uuid().slice(0, 6));
    var readOnly = options.disabled === true;

    var handles = [];
    var byPath = Object.create(null);
    var initial = null;

    var heading = core.el('h3', {
      class: 'tmv-form__title',
      text: isNew ? 'New ' + typeSpec.label.toLowerCase() : 'Edit ' + typeSpec.label.toLowerCase(),
    });
    // The id line is shown for an entity that exists. For one being created the id is real but not
    // yet anything the user can use — showing it before the entity is in the model claims an
    // identifier the file does not hold yet.
    var idLine = !isNew
      ? core.el('p', { class: 'tmv-form__id' }, [
          core.el('span', { class: 'tmv-form__id-label', text: 'Id ' }),
          core.el('code', { class: 'tmv-form__id-value', text: entity.id }),
          core.el('span', { class: 'tmv-form__id-note', text: ' — stable across edits, imports and exports' }),
        ])
      : null;

    var summary = core.el('div', { class: 'tmv-form__problems', role: 'alert', hidden: true });
    var fieldsNode = core.el('div', { class: 'tmv-form__fields' });
    var form = core.el('form', {
      class: 'cds--form tmv-form',
      id: idPrefix,
      novalidate: true,
      'data-type': typeSpec.key,
    }, [heading, idLine, summary, fieldsNode].concat(renderDerivedBlock()));

    function renderDerivedBlock() {
      var derived = derivedFields(typeSpec);
      if (!derived.length) return [];
      var block = core.el('div', { class: 'tmv-form__derived' });
      var nodes = [];
      for (var i = 0; i < derived.length; i++) {
        var node = renderDerived(derived[i], entity);
        nodes.push(node);
      }
      block.setAttribute('data-derived-block', 'true');
      for (var j = 0; j < nodes.length; j++) block.appendChild(nodes[j]);
      return [block];
    }

    var ctx = {
      model: model,
      typeSpec: typeSpec,
      entity: entity,
      idPrefix: idPrefix,
      values: {},
      onChange: function () { notifyChange(); },
    };

    function build(spec) {
      var value = entity ? entity[spec.key] : undefined;
      var handle = renderField(spec, spec.key, value, ctx);
      handles.push(handle);
      byPath[handle.path] = handle;
      fieldsNode.appendChild(handle.root);
      return handle;
    }

    var specs = editableFields(typeSpec, entity);
    for (var i = 0; i < specs.length; i++) build(specs[i]);

    var unrendered = unrenderedFields(typeSpec);
    if (unrendered.length) {
      var names = [];
      for (var u = 0; u < unrendered.length; u++) names.push(unrendered[u].label);
      fieldsNode.appendChild(core.el('p', {
        class: 'tmv-form__note',
        text: 'Not shown here, and kept exactly as the file has it: ' + names.join(', ') + '.',
      }));
    }

    if (readOnly) form.setAttribute('data-readonly', 'true');

    // -- change detection ------------------------------------------------------------------------

    function readAll() {
      var out = Object.create(null);
      for (var i = 0; i < handles.length; i++) out[handles[i].path] = handles[i].read();
      return out;
    }

    /** Values, in the shape the model holds them: what `applyDraft` consumes. */
    function values() {
      var raw = readAll();
      var out = Object.create(null);
      for (var i = 0; i < specs.length; i++) out[specs[i].key] = raw[specs[i].key];
      return out;
    }

    initial = JSON.stringify(values());

    function isDirty() {
      return JSON.stringify(values()) !== initial;
    }

    function markClean() {
      initial = JSON.stringify(values());
    }

    function notifyChange() {
      refreshDerived();
      if (options.onChange) options.onChange(isDirty());
    }

    function refreshDerived() {
      var derived = derivedFields(typeSpec);
      if (!derived.length) return;
      var draft = applyDraft(entity, typeSpec, values());
      var nodes = form.querySelectorAll('[data-derived]');
      for (var i = 0; i < nodes.length; i++) {
        var name = nodes[i].getAttribute('data-derived');
        for (var j = 0; j < derived.length; j++) {
          if (derived[j].derived !== name) continue;
          var v = derivedValue(derived[j], draft);
          nodes[i].textContent = derived[j].label + ': ' + (v === null || v === undefined ? 'Not computable' : String(v));
        }
      }
    }

    core.on(form, 'input', function () { notifyChange(); });
    core.on(form, 'change', function () { notifyChange(); });

    // -- errors ----------------------------------------------------------------------------------

    function clearErrors() {
      for (var path in byPath) byPath[path].setError(null);
      core.setHidden(summary, true);
      core.clear(summary);
      core.setAttr(form, 'aria-invalid', null);
    }

    function setErrors(messages) {
      clearErrors();
      var unplaced = [];
      var keys = Object.keys(messages || {});
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var control = key === '' ? '' : controlPath(Object.keys(byPath), key);
        if (control !== '' && byPath[control]) byPath[control].setError(messages[key]);
        else unplaced.push(messages[key]);
      }
      if (unplaced.length) {
        core.clear(summary);
        summary.appendChild(core.el('p', { class: 'cds--form-requirement', text: 'That change was not accepted:' }));
        var list = core.el('ul', { class: 'tmv-form__problem-list' });
        for (var j = 0; j < unplaced.length; j++) {
          list.appendChild(core.el('li', { text: unplaced[j] }));
        }
        summary.appendChild(list);
        core.setHidden(summary, false);
        core.setAttr(form, 'aria-invalid', 'true');
      }
      return unplaced.length === 0;
    }

    function validate() {
      var check = validateValues(model, typeSpec, entity, values());
      setErrors(check.messages);
      return check;
    }

    function focusFirst() {
      for (var path in byPath) {
        var node = byPath[path].control;
        if (node && node.focus) { node.focus(); return true; }
      }
      return false;
    }

    // Submit is intercepted rather than allowed: a form inside a page navigates on submit, and on
    // `file://` that means the app is gone. The button is `type="submit"` for the keyboard, and the
    // default action is cancelled here.
    core.on(form, 'submit', function (event) {
      if (event.preventDefault) event.preventDefault();
      submit();
    });

    function submit() {
      if (readOnly) return null;
      var check = validate();
      if (!check.valid) {
        focusFirst();
        if (options.onInvalid) options.onInvalid(check);
        return check;
      }
      if (options.onSubmit) options.onSubmit(check.candidate, check);
      else markClean();
      return check;
    }

    function setValues(next) {
      var valuesIn = next || {};
      var keys = Object.keys(valuesIn);
      for (var i = 0; i < keys.length; i++) {
        if (byPath[keys[i]] && byPath[keys[i]].setValue) byPath[keys[i]].setValue(valuesIn[keys[i]]);
      }
      notifyChange();
    }

    var element = options.wrap === false ? form : core.el('div', { class: 'tmv-form-wrap' }, [form]);

    var api = {
      element: element,
      form: form,
      typeSpec: typeSpec,
      // The id the candidate will carry — minted here for a create, so a caller can insert with the
      // same identifier the form validated rather than letting `M.insert` mint a second one.
      entityId: entity.id,
      isNew: isNew,
      fields: handles,
      paths: function () { return Object.keys(byPath); },
      field: function (path) { return byPath[path] || null; },
      values: values,
      setValues: setValues,
      validate: validate,
      submit: submit,
      setErrors: setErrors,
      clearErrors: clearErrors,
      isDirty: isDirty,
      markClean: markClean,
      focusFirst: focusFirst,
      readOnly: readOnly,
      /** The candidate entity as it stands, without validating it. Used by tests and by previews. */
      candidate: function () { return applyDraft(entity, typeSpec, values()); },
    };
    return api;
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Dialogs
  // ---------------------------------------------------------------------------------------------

  /**
   * The delete confirmation, which is also the prompt REQ-EDIT-003 AC1 asks for.
   *
   * One dialog for both requirements rather than two, because they are one decision: "this goes, and
   * here is what else goes with it" is exactly the question "how should the reference be handled".
   * Splitting them would put a modal on top of a modal to ask a single question in two halves.
   *
   * `danger: true` gives the Carbon danger styling, ignores backdrop clicks (a mis-aimed click must
   * not confirm a delete) and puts initial focus on Cancel, all of which `widgets.modal` does for a
   * destructive dialog.
   */
  function deleteDialog(opts) {
    var options = opts || {};
    var plan = options.plan;
    if (!plan) return null;
    var body = [core.el('p', { text: 'Delete ' + plan.typeSpec.label.toLowerCase() + ' “' + plan.label + '”?' })];

    if (plan.cascaded.length) {
      var cascaded = core.el('ul', { class: 'tmv-dialog__list' });
      for (var i = 0; i < plan.cascaded.length && i < 12; i++) {
        cascaded.appendChild(core.el('li', {
          text: plan.cascaded[i].typeSpec.label + ' “' + plan.cascaded[i].label + '”',
        }));
      }
      if (plan.cascaded.length > 12) {
        cascaded.appendChild(core.el('li', {
          text: 'and ' + (plan.cascaded.length - 12) + ' more',
        }));
      }
      body.push(core.el('div', { class: 'tmv-dialog__group' }, [
        core.el('p', {
          class: 'tmv-dialog__lead',
          text: core.plural(plan.cascaded.length, 'entry', 'entries') + ' that only record a relationship to this one will also be deleted:',
        }),
        cascaded,
      ]));
    }

    var choice = null;
    if (plan.orphaned.length) {
      var names = [];
      for (var o = 0; o < plan.orphaned.length && o < 8; o++) {
        names.push(plan.orphaned[o].typeSpec.label + ' “' + plan.orphaned[o].label + '”');
      }
      var more = plan.orphaned.length > names.length ? ' and ' + (plan.orphaned.length - names.length) + ' more' : '';
      var endpointNote = plan.endpoints.length
        ? 'A data flow with no ' + (plan.endpoints.length === 1 ? plan.endpoints[0].endpoint : 'source or destination') +
          ' can still be opened, but it no longer says where anything goes.'
        : null;
      choice = radioGroup({
        name: 'tmv-delete-references',
        selected: 'keep',
        options: [
          {
            value: 'keep',
            label: 'Keep them, without this reference',
            note: endpointNote,
          },
          {
            value: 'cascade',
            label: 'Delete them too',
            note: 'They go with it. Nothing is left pointing at something that is not here.',
          },
        ],
      });
      body.push(core.el('div', { class: 'tmv-dialog__group' }, [
        core.el('p', {
          class: 'tmv-dialog__lead',
          text: names.join(', ') + more + ' point at this ' + plan.typeSpec.label.toLowerCase() + '.',
        }),
        choice.element,
      ]));
    }

    var instance = widgets.modal({
      title: 'Delete ' + plan.typeSpec.label.toLowerCase(),
      size: 'sm',
      danger: true,
      body: body,
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Delete', kind: 'danger', action: 'confirm', name: 'confirm' },
      ],
      onClose: function (reason) {
        if (options.onClose) options.onClose(reason);
      },
    });

    modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action !== 'confirm') return;
      var answer = choice ? choice.read() || 'keep' : 'keep';
      instance.close('confirmed');
      if (options.onConfirm) options.onConfirm({ alsoRemove: answer === 'cascade' ? plan.orphaned.map(byId) : [] });
    });

    if (options.open !== false) instance.open();
    return { element: instance.element, open: instance.open, close: instance.close };
  }

  function byId(entry) {
    return entry.entity.id;
  }

  /**
   * The commit dialog (REQ-EDIT-006).
   *
   * The author is read-only and comes from stored preferences: a commit records who made it, and
   * `ADR-0008` is explicit that this is *self-asserted* — an editable field here would imply the app
   * was verifying something it has no way to verify. The message is required, because a commit
   * message is the only thing that turns a hash into a reason.
   */
  function commitDialog(opts) {
    var options = opts || {};
    var author = options.author || { name: '', email: '' };
    var summary = options.summary || summariseChanges(options.headModel, options.workingModel);

    var message = widgets.field({
      label: 'Message',
      kind: 'textarea',
      rows: 3,
      required: true,
      placeholder: 'What changed, and why',
      action: 'commit-message',
      hint: 'Required. This is what the History tab shows.',
    });

    var authorText = author.name || author.email
      ? (author.name || 'Unnamed') + (author.email ? ' <' + author.email + '>' : '')
      : 'Not set';

    var body = [
      core.el('div', { class: 'tmv-dialog__group' }, [
        core.el('p', { class: 'tmv-dialog__lead', text: 'Author' }),
        core.el('p', { class: 'tmv-dialog__value', text: authorText }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text: author.name || author.email
            ? 'Recorded in the commit, and asserted by you rather than checked by this application.'
            : 'Set a name in Settings so the commit says who made it. It is recorded as written, never checked.',
        }),
      ]),
      core.el('div', { class: 'tmv-dialog__group' }, [
        core.el('p', { class: 'tmv-dialog__lead', text: 'Changes since the head commit' }),
        summaryRow(summary),
      ]),
      message.element,
    ];

    var actions = [
      { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
      { label: 'Commit', kind: 'primary', action: 'commit', name: 'confirm', disabled: true, title: 'A message is required' },
    ];

    var instance = widgets.modal({
      title: 'Commit changes',
      size: 'sm',
      body: body,
      actions: actions,
      initialFocus: 'first',
      onClose: function (reason) {
        if (options.onClose) options.onClose(reason);
      },
    });

    function syncCommit() {
      var ready = message.value().trim() !== '';
      var button = findAction(instance, 'commit');
      if (!button) return;
      if (ready) button.removeAttribute('disabled');
      else button.setAttribute('disabled', '');
      core.setAttr(button, 'title', ready ? null : 'A message is required');
    }

    message.on('input', syncCommit);
    syncCommit();

    modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action !== 'commit') return;
      var text = message.value().trim();
      if (text === '') {
        message.setError('A commit needs a message.');
        return;
      }
      instance.setBusy(true);
      var result = TMV.vcs.commit(options.history, options.workingModel, author, text, options.commitOptions);
      instance.setBusy(false);
      if (!result || !result.ok) {
        // The only refusal `vcs.commit` makes is an empty one, and the Commit button is disabled when
        // there is nothing to commit — so reaching this means the working copy matched the head
        // without the UI noticing, which is worth saying out loud rather than closing on.
        message.setError(result && result.message ? result.message : 'The commit was refused.');
        if (options.onRefused) options.onRefused(result);
        return;
      }
      instance.close('committed');
      if (options.onCommit) options.onCommit(result.commit);
    });

    if (options.open !== false) instance.open();
    return { element: instance.element, open: instance.open, close: instance.close, message: message, summary: summary };
  }

  function findAction(instance, action) {
    var found = instance.element.querySelectorAll('[data-action]');
    for (var i = 0; i < found.length; i++) {
      if (found[i].getAttribute('data-action') === action) return found[i];
    }
    return null;
  }

  /** The three counts, as Carbon tags so each reads as a label rather than a number in a sentence. */
  function summaryRow(summary) {
    var counts = core.el('div', { class: 'tmv-summary-counts' });
    counts.appendChild(widgets.tag({ text: summary.added + ' added', type: summary.added ? 'green' : null, title: core.plural(summary.added, 'entity', 'entities') + ' added' }));
    counts.appendChild(widgets.tag({ text: summary.modified + ' modified', type: summary.modified ? 'blue' : null, title: core.plural(summary.modified, 'entity', 'entities') + ' modified' }));
    counts.appendChild(widgets.tag({ text: summary.removed + ' removed', type: summary.removed ? 'red' : null, title: core.plural(summary.removed, 'entity', 'entities') + ' removed' }));
    var wrap = core.el('div', { class: 'tmv-summary' }, [counts]);

    if (summary.modelFields.length) {
      var fields = core.el('ul', { class: 'tmv-dialog__list' });
      for (var i = 0; i < summary.modelFields.length; i++) {
        var f = summary.modelFields[i];
        fields.appendChild(core.el('li', { text: f.label + ': ' + f.from + ' → ' + f.to }));
      }
      wrap.appendChild(fields);
    }

    if (summary.byType.length) {
      var rows = [];
      for (var t = 0; t < summary.byType.length; t++) {
        var g = summary.byType[t];
        rows.push({
          id: g.key,
          cells: [
            core.el('span', { text: g.label }),
            core.el('span', { text: [g.added ? g.added + ' added' : null, g.modified ? g.modified + ' modified' : null, g.removed ? g.removed + ' removed' : null].filter(Boolean).join(', ') }),
          ],
        });
      }
      wrap.appendChild(widgets.structuredList({ rows: rows, label: 'Changes by entity type' }));
    }

    if (summary.empty) {
      wrap.appendChild(core.el('p', { class: 'tmv-dialog__note', text: 'Nothing has changed since the head commit.' }));
    }
    return wrap;
  }

  /**
   * The discard confirmation (REQ-EDIT-007).
   *
   * The restored model is `vcs.headModel`, which materializes the head commit rather than replaying
   * anything — so "restores the head exactly" is true by construction rather than by care, and the
   * dialog's summary is what is about to be thrown away.
   */
  function discardDialog(opts) {
    var options = opts || {};
    var summary = options.summary || summariseChanges(options.headModel, options.workingModel);
    var body = [
      core.el('p', {
        text: summary.empty
          ? 'The working copy already matches the head commit.'
          : 'Discard the working copy and go back to the last commit?',
      }),
    ];
    if (!summary.empty) {
      body.push(core.el('div', { class: 'tmv-dialog__group' }, [summaryRow(summary)]));
      body.push(core.el('p', {
        class: 'tmv-dialog__note',
        text: 'The changes are not committed anywhere. Undo is cleared as well, because it would otherwise put back what you just discarded.',
      }));
    }

    var instance = widgets.modal({
      title: 'Discard changes',
      size: 'sm',
      danger: !summary.empty,
      body: body,
      actions: [
        { label: 'Keep editing', kind: 'tertiary', action: 'cancel' },
        { label: 'Discard', kind: 'danger', action: 'discard', name: 'confirm', disabled: summary.empty },
      ],
      onClose: function (reason) {
        if (options.onClose) options.onClose(reason);
      },
    });

    modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action !== 'discard') return;
      var restored = TMV.vcs.headModel(options.history);
      instance.close('discarded');
      if (options.onDiscard) options.onDiscard(restored, summary);
    });

    if (options.open !== false) instance.open();
    return { element: instance.element, open: instance.open, close: instance.close };
  }

  /**
   * Bulk field update (REQ-EDIT-008).
   *
   * One field, one value, applied to the selection. The field list is deliberately the editable
   * fields of the type and nothing else: a bulk edit is the operation where a mistake scales, so what
   * it can touch is bounded to what a single edit could touch.
   *
   * The report is part of the dialog rather than a toast, because a partial failure is a list — "17
   * updated, 3 refused because priority is outside the vocabulary" is not a sentence a toast can hold
   * (REQ-EDIT-008 AC).
   */
  function bulkUpdateDialog(opts) {
    var options = opts || {};
    var typeSpec = M.typeFor(options.type);
    if (!typeSpec) throw TMV.error('EDIT_TYPE', 'Unknown entity type: ' + options.type);
    var ids = options.ids || [];
    var specs = editableFields(typeSpec, null);
    var fieldOptions = [];
    for (var i = 0; i < specs.length; i++) fieldOptions.push({ value: specs[i].key, label: specs[i].label });

    var picker = widgets.dropdown({
      options: fieldOptions,
      selected: fieldOptions.length ? fieldOptions[0].value : null,
      label: 'Field',
      placeholder: 'Choose a field',
      id: 'tmv-bulk-field',
      onSelect: function () { rebuildValue(); },
    });

    var valueHost = core.el('div', { class: 'tmv-dialog__value-host' });

    function currentSpec() {
      var key = picker.value();
      for (var i = 0; i < specs.length; i++) if (specs[i].key === key) return specs[i];
      return null;
    }

    var valueHandle = null;

    function rebuildValue() {
      core.clear(valueHost);
      var spec = currentSpec();
      if (!spec) return;
      // The value control is built from the kind, and validated by exactly the code path a normal
      // edit uses — so a bulk value that could not be typed into a single form cannot be applied here.
      valueHandle = renderField(spec, spec.key, undefined, {
        model: options.model || M.createEmpty(),
        typeSpec: typeSpec,
        entity: null,
        idPrefix: 'tmv-bulk',
        values: {},
      });
      valueHost.appendChild(valueHandle.root);
    }
    rebuildValue();

    var body = [
      core.el('p', {
        text: 'Set one field on ' + core.plural(ids.length, 'selected entity', 'selected entities') + '.',
      }),
      widgets.labelled('Field', picker.trigger, { id: 'tmv-bulk-field-label' }).wrapper,
      valueHost,
    ];

    var instance = widgets.modal({
      title: 'Update ' + core.plural(ids.length, 'entity', 'entities'),
      size: 'sm',
      body: body,
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Apply', kind: 'primary', action: 'apply', name: 'confirm', disabled: ids.length === 0 },
      ],
      onClose: function (reason) {
        if (options.onClose) options.onClose(reason);
      },
    });

    modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action !== 'apply') return;
      var spec = currentSpec();
      if (!spec || !valueHandle) return;
      var raw = valueHandle.read();
      var value = coerceInput(spec, raw);
      if (value === undefined && !isEmptyValue(raw)) {
        valueHandle.setError('That is not a ' + spec.label.toLowerCase() + ' this model can hold.');
        return;
      }
      var patch = Object.create(null);
      patch[spec.key] = value;
      var result = bulkUpdate(options.model, typeSpec.key, ids, patch);
      instance.close('applied');
      if (options.onApply) options.onApply(result);
    });

    if (options.open !== false) instance.open();
    // The outcome is *not* reported here. The dialog closes the moment the patch is applied, so a
    // report region inside it would be built and torn down in the same turn — which is what the one
    // this function used to carry did, and why `setReport` had no caller. REQ-UI-009 puts outcomes in
    // notifications, and the caller that opened this dialog is the one that knows which list is on
    // screen and what to put in the message.
    return {
      element: instance.element,
      open: instance.open,
      close: instance.close,
      /** Exposed so a caller can preselect a field, and so a test can see the choices. */
      fieldPicker: picker,
      valueHost: valueHost,
      currentField: currentSpec,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 11. Dirty state and the unload guard (REQ-EDIT-005)
  // ---------------------------------------------------------------------------------------------

  /**
   * Reflect the working copy's state in the shell's own indicator.
   *
   * The elements are the ones `src/index.html` declares — the header's `#tmv-dirty` and the Commit
   * button — rather than anything this module creates, because a shell that showed one dirty state
   * and a form that computed another would disagree at exactly the moment the user is deciding
   * whether to commit.
   */
  function setDirty(dirty, opts) {
    var options = opts || {};
    var flag = core.byId('tmv-dirty');
    if (flag) {
      core.setHidden(flag, !dirty);
      var text = core.byId('tmv-dirty-text');
      if (text) text.textContent = options.label || 'Uncommitted changes';
    }
    var commit = core.byId('tmv-commit');
    if (commit) {
      if (dirty) commit.removeAttribute('disabled');
      else commit.setAttribute('disabled', '');
      core.setAttr(commit, 'title', dirty
        ? (options.commitTitle || 'Commit the working copy')
        : 'Nothing to commit — the working copy matches the head commit');
    }
    if (options.announce && TMV.notify) TMV.notify.announce(dirty ? 'Uncommitted changes' : 'Working copy matches the head commit');
    return dirty;
  }

  /**
   * The `beforeunload` warning (REQ-EDIT-005 AC2).
   *
   * `preventDefault` alone is not enough in every browser that matters here, and returning a string
   * is still honoured although browsers no longer show it. Both are done, because the cost of the
   * second is one line and the cost of relying on one of them being honoured is a user losing an
   * afternoon to a tab they closed.
   */
  function guardUnload(isDirty, opts) {
    var view = (opts && opts.window) || (typeof window === 'undefined' ? null : window);
    if (!view || !view.addEventListener) return function () {};
    function handler(event) {
      if (!isDirty()) return undefined;
      if (event && event.preventDefault) event.preventDefault();
      return 'You have uncommitted changes.';
    }
    view.addEventListener('beforeunload', handler);
    return function () { view.removeEventListener('beforeunload', handler); };
  }

  // ---------------------------------------------------------------------------------------------

  TMV.forms = {
    UNDO_LIMIT: UNDO_LIMIT,
    REFERENCE_FILTER_AT: REFERENCE_FILTER_AT,
    NAME_SPEC: NAME_SPEC,
    DESCRIPTION_SPEC: DESCRIPTION_SPEC,

    /**
     * Everything a unit test can reach without a document (`09-testing.md` §2). The DOM half of this
     * module is checked structurally here and behaves-for-real under Playwright; the decisions an
     * edit is made of are checkable without either.
     */
    logic: {
      editableFields: editableFields,
      derivedFields: derivedFields,
      unrenderedFields: unrenderedFields,
      specFor: specFor,
      fieldAt: fieldAt,
      isEmptyValue: isEmptyValue,
      coerceInput: coerceInput,
      applyDraft: applyDraft,
      draftOf: draftOf,
      enumOptions: enumOptions,
      vocabularyOptions: vocabularyOptions,
      referenceTypes: referenceTypes,
      referenceCandidates: referenceCandidates,
      inputProblems: inputProblems,
      probeModel: probeModel,
      validateEntity: validateEntity,
      validateValues: validateValues,
      controlPath: controlPath,
      planDelete: planDelete,
      derivedValue: derivedValue,
      summariseChanges: summariseChanges,
      summaryText: summaryText,
      describeValue: describeValue,
    },

    // Model operations. Each returns a new model; none mutates its argument.
    shareModel: shareModel,
    fork: fork,
    isolate: isolate,
    createEntity: createEntity,
    editEntity: editEntity,
    saveEntity: saveEntity,
    deleteEntity: deleteEntity,
    planDelete: planDelete,
    bulkUpdate: bulkUpdate,
    bulkDelete: bulkDelete,

    undo: {
      push: pushUndo,
      undo: undo,
      clear: clearUndo,
      depth: undoDepth,
      peek: undoPeek,
      limit: UNDO_LIMIT,
    },

    summariseChanges: summariseChanges,
    summaryText: summaryText,

    entityForm: entityForm,
    deleteDialog: deleteDialog,
    commitDialog: commitDialog,
    discardDialog: discardDialog,
    bulkUpdateDialog: bulkUpdateDialog,
    modalActions: modalActions,
    radioGroup: radioGroup,
    checkboxGroup: checkboxGroup,

    setDirty: setDirty,
    guardUnload: guardUnload,
  };
})(globalThis.TMV = globalThis.TMV || {});
