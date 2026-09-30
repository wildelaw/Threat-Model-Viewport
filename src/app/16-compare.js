/**
 * Compare and merge — `04-versioning.md` §6, `07-ui.md` §6, ADR-0003.
 * Requirements: REQ-VCS-009, REQ-VCS-010, REQ-VCS-011, REQ-VCS-012 (the refusal), REQ-SYNC-005.
 *
 * Six decisions shape this module, and each of them is a place a plausible-looking implementation goes
 * wrong.
 *
 * 1. **Nothing is written until the user confirms.** `plan`, `apply`, `screen` and every helper below
 *    read history and models and never touch either. The single write in the module is the confirm
 *    handler of `mergeDialog`, which calls `vcs.mergeCommit`. So "no commit is written before the user
 *    confirms a resolution" (REQ-VCS-009 AC2) and "the reconcile flow reaches the compare view without
 *    writing to storage" (REQ-SYNC-005 AC) hold by construction rather than by remembering not to
 *    save. The screen hands the resolved model to the caller through `onConfirm`; it never stores it.
 *
 * 2. **Three-way, always.** Base, A (the file) and B (local). A two-way comparison cannot tell a field
 *    that is absent on one side from a field deleted on that side, and that is the one distinction the
 *    user needs (`04-versioning.md` §6). The base is the lowest common ancestor, and when there is
 *    more than one — criss-cross history — the approximation is disclosed rather than hidden
 *    (REQ-VCS-010 AC1).
 *
 * 3. **A suggestion is never a decision.** `defaultResolution` fills in only the choices this module
 *    marked as suggestions, which are the non-overlapping ones. Conflicts and deletions get none, so
 *    `missingDecisions` stays non-empty until the user has answered each of them and the screen keeps
 *    Merge disabled while it is. A conflict cannot be merged without having been looked at.
 *
 *    The rule that keeps this honest is narrower than "suggest a change": **the pre-selected outcome is
 *    never a removal.** An entity only the file has is suggested for inclusion; an entity the file
 *    deleted, or a field one side deleted, is never pre-selected for deletion, even though only one
 *    side touched it. "Deletions are presented as an explicit choice, never as a default" is the same
 *    sentence as this one.
 *
 * 4. **Geometry is one choice, not four.** `position` and `size` on a `representationElement` form a
 *    single slot, so a layout conflict reads "the file's layout or local's", as §6's "Not in v1"
 *    describes. A list of x/y values is not a resolution interface (OQ-03). The same coarseness applies
 *    to the model-level object fields (`scope`, `metadata`, `x`), for the same reason: a form is where
 *    those get edited, not a diff.
 *
 * 5. **Derived fields are not decided.** `riskScore` and `riskLevel` are functions of `likelihood` and
 *    `impact`, so two sides changing a *different* input would otherwise read as a conflict on a field
 *    nobody edited. They are recomputed when one of their own inputs was itself resolved, and carried
 *    through untouched otherwise — so a merge never rewrites a recorded derived value it was not asked
 *    about, and never invents a conflict. They are still *shown* when the two sides disagree, marked
 *    read-only, because a disagreement about a value that is in the file is a fact about the model.
 *
 * 6. **Linear order, not a table.** `07-ui.md` §8 calls this out for this screen specifically. The
 *    comparison is a list of sections — heading, per-side definition list, one radio group per decided
 *    field — in DOM order, so tab order and screen-reader order are the reading order. Radio groups
 *    rather than the `[ A ] [ B ]` buttons of the ASCII sketch, because a native radio group gives
 *    arrow-key navigation and a group name for free, and because it can be rendered with *nothing*
 *    selected, which is exactly what a conflict needs.
 *
 * One deliberate extension to §6's table: a field decision offers the ancestor value as a third option
 * whenever an ancestor value exists, including for conflicts. §6 shows `[ A ] [ B ]` for a conflict,
 * and this adds `[ base ]` beside them. Keep-base is already part of the design's vocabulary (every
 * one-sided change offers it), and a conflict where both sides are wrong has no other answer.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var M = TMV.model;
  var vcs = TMV.vcs;
  var widgets = TMV.widgets;
  var forms = TMV.forms;
  var formLogic = forms && forms.logic ? forms.logic : null;

  // ---------------------------------------------------------------------------------------------
  // 0. Vocabulary
  // ---------------------------------------------------------------------------------------------

  var SIDE_BASE = 'base';
  var SIDE_A = 'a';
  var SIDE_B = 'b';

  /** Presence choices are about existence, not about a value, so they are not spelled 'a'/'b'. */
  var KEEP = 'keep';
  var OMIT = 'omit';

  /** A grouped slot whose two sides changed different parts of it: one choice that is neither side. */
  var COMBINED = 'combined';

  var FILTER_NEEDS = 'needs';
  var FILTER_ALL = 'all';

  var PRESENCE_SLOT = '@presence';

  /** Never a decision: identity and format are what the two histories already agree on. */
  var IDENTITY_KEYS = { tmvFormat: true, modelId: true };

  /**
   * Fields that are one choice rather than several. Keyed by entity type; `fields` are the model's own
   * property names, so the group is a view of the same data, not a second copy of it.
   */
  var GROUPED_FIELDS = {
    representationElements: [
      {
        key: 'layout',
        label: 'Layout',
        fields: ['position', 'size'],
        note:
          'Where the element sits on the diagram and how large it is. Resolved as one choice: a list of ' +
          'coordinates is not something anyone wants to review field by field.',
      },
    ],
  };

  /** Which fields a derived value is computed from. Kept beside the derivation, not inside it. */
  var DERIVED_INPUTS = {
    riskScore: ['likelihood', 'impact'],
    riskLevel: ['likelihood', 'impact'],
  };

  var MODEL_LABELS = {
    name: 'Model name',
    description: 'Model description',
    scope: 'Scope',
    metadata: 'Metadata',
    x: 'Passthrough fields (x)',
  };

  /**
   * How each shape of change is named. `kind` is what the summary line counts; `needsDecision` is
   * computed per decision rather than per shape, because "both changed different fields" is a
   * suggestion while "both changed the same field" is a conflict, and the difference is not visible
   * from here.
   */
  var STATUS = {
    'a-only': { kind: 'added', label: 'only in the file' },
    'b-only': { kind: 'added', label: 'only local' },
    'both-added': { kind: 'added', label: 'added on both sides' },
    'a-changed': { kind: 'changed', label: 'only the file changed it' },
    'b-changed': { kind: 'changed', label: 'only local changed it' },
    // "changed on both sides", not "both changed different fields": at this level all that is known
    // is that both sides moved the entity, and whether they moved the same field is decided one slot
    // down. The stronger wording would be flatly wrong on a same-field conflict — the one case where
    // the reader most needs the label to be accurate.
    'both-changed': { kind: 'changed', label: 'changed on both sides' },
    'both-changed-same': { kind: 'changed', label: 'both changed it the same way' },
    'removed-a': { kind: 'removed', label: 'removed from the file' },
    'removed-b': { kind: 'removed', label: 'removed locally' },
    'removed-both': { kind: 'removed', label: 'removed on both sides' },
    'removed-and-changed': { kind: 'removed', label: 'removed on one side, changed on the other' },
  };

  function sideName(side) {
    if (side === SIDE_A) return 'the file';
    if (side === SIDE_B) return 'local';
    return 'the base';
  }

  function sideTitle(side) {
    if (side === SIDE_A) return 'The file';
    if (side === SIDE_B) return 'Local';
    return 'Base';
  }

  // ---------------------------------------------------------------------------------------------
  // 1. Slots — what a single decision is about
  //
  // A "slot" is one thing the user can choose. It is usually one field, but it is a *list* of fields
  // when the fields only make sense together (geometry). Decisions, values and application all work
  // in slots, which is why the coarse cases cost nothing anywhere else in this module.
  // ---------------------------------------------------------------------------------------------

  var SLOT_CACHE = Object.create(null);

  function declaredSpec(typeSpec, key) {
    for (var i = 0; i < typeSpec.fields.length; i++) {
      if (typeSpec.fields[i].key === key) return typeSpec.fields[i];
    }
    return null;
  }

  function isDerivedKey(typeSpec, key) {
    var spec = declaredSpec(typeSpec, key);
    return !!(spec && spec.derived);
  }

  function slotLabel(typeSpec, key) {
    var spec = declaredSpec(typeSpec, key);
    if (spec) return spec.label;
    if (key === 'x') return 'Passthrough fields (x)';
    return key;
  }

  function keyUnion(entities) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < entities.length; i++) {
      var entity = entities[i];
      if (!core.isObject(entity)) continue;
      var keys = core.sortedKeys(entity);
      for (var j = 0; j < keys.length; j++) {
        if (seen[keys[j]]) continue;
        seen[keys[j]] = true;
        out.push(keys[j]);
      }
    }
    return out;
  }

  /**
   * The slots of one entity type, in registry order: name, description, the declared fields (a group
   * replacing its members), then anything else the three copies carry.
   *
   * That last part is not a nicety. Fields the registry does not know — passthrough keys, an OTM
   * `x-otm` bag, a field a future version added — are part of the model, and a merge that could not
   * express a difference in them would silently drop one side's work. They are ordinary slots here,
   * labelled by their own key.
   */
  function slotListFor(typeSpec, entities) {
    var cacheKey = typeSpec.key + '::' + keyUnion(entities).join(',');
    if (SLOT_CACHE[cacheKey]) return SLOT_CACHE[cacheKey];

    var defs = GROUPED_FIELDS[typeSpec.key] || [];
    var groupOf = Object.create(null);
    var i, j;
    for (i = 0; i < defs.length; i++) {
      for (j = 0; j < defs[i].fields.length; j++) groupOf[defs[i].fields[j]] = defs[i];
    }

    var slots = [];
    var placed = Object.create(null);
    function push(slot) {
      if (placed[slot.key]) return;
      placed[slot.key] = true;
      slots.push(slot);
    }

    push({ key: 'name', label: 'Name', fields: ['name'], spec: null });
    push({ key: 'description', label: 'Description', fields: ['description'], spec: null });

    for (i = 0; i < typeSpec.fields.length; i++) {
      var spec = typeSpec.fields[i];
      if (spec.derived) continue;
      var def = groupOf[spec.key];
      if (def) {
        push({ key: def.key, label: def.label, fields: def.fields.slice(), grouped: true, note: def.note, spec: null });
        continue;
      }
      push({ key: spec.key, label: spec.label, fields: [spec.key], spec: spec });
    }

    var keys = keyUnion(entities);
    for (i = 0; i < keys.length; i++) {
      var key = keys[i];
      // A grouped field is already represented by its group; adding it again would ask the same
      // question twice, once coarsely and once per sub-field.
      if (placed[key] || groupOf[key] || key === 'id' || isDerivedKey(typeSpec, key)) continue;
      push({ key: key, label: slotLabel(typeSpec, key), fields: [key], spec: declaredSpec(typeSpec, key) });
    }

    SLOT_CACHE[cacheKey] = slots;
    return slots;
  }

  /** The value a slot holds on one side, or `undefined` when it holds nothing. */
  function slotValue(entity, slot) {
    if (!core.isObject(entity)) return undefined;
    if (slot.fields.length === 1) return entity[slot.key];
    var out = Object.create(null);
    var any = false;
    for (var i = 0; i < slot.fields.length; i++) {
      var value = entity[slot.fields[i]];
      if (value !== undefined) {
        out[slot.fields[i]] = value;
        any = true;
      }
    }
    return any ? out : undefined;
  }

  /** Numbers as written, without inventing a default for a coordinate that is not there. */
  function coordinate(value) {
    return core.isNumber(value) ? String(value) : '—';
  }

  function describeLayout(value) {
    var parts = [];
    if (core.isObject(value.position)) {
      parts.push('at ' + coordinate(value.position.x) + ', ' + coordinate(value.position.y));
    }
    if (core.isObject(value.size)) {
      parts.push(coordinate(value.size.width) + ' × ' + coordinate(value.size.height));
    }
    return parts.length ? parts.join(' · ') : 'no coordinates';
  }

  function describeSlot(slot, value) {
    if (value === undefined || value === null) return 'Not set';
    if (slot && slot.grouped && slot.key === 'layout') return describeLayout(value);
    if (!formLogic) return String(value);
    return formLogic.describeValue(value);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Planning — everything the screen needs, computed without touching history
  // ---------------------------------------------------------------------------------------------

  function optionFor(decision, value) {
    if (value === undefined || value === null) return null;
    for (var i = 0; i < decision.options.length; i++) {
      if (decision.options[i].value === value) return decision.options[i];
    }
    return null;
  }

  function fieldOption(side, raw, slot) {
    return {
      value: side,
      side: side,
      raw: raw,
      omit: false,
      label: sideTitle(side),
      note: describeSlot(slot, raw),
    };
  }

  function presenceOption(value, side, label, note, omit) {
    return {
      value: value,
      // Which whole side this choice means, so that "use the file's version" can be answered for a
      // presence decision whose option values are about existence rather than about a side.
      side: side,
      raw: undefined,
      omit: omit === true,
      label: label,
      note: note,
    };
  }

  /**
   * Combine the two sides of a grouped slot when they changed *different* parts of it.
   *
   * This is what keeps grouping geometry from turning "one of us moved it, the other resized it" into a
   * conflict. §6 says combining non-overlapping changes is mechanically safe and suggests doing it;
   * grouping position and size into one layout choice means the combination has to happen inside the
   * choice, or the group would be strictly worse than the four separate rows it replaced. Returns null
   * when the changes overlap, which is a genuine conflict.
   */
  function combinedValue(vbase, va, vb, fields) {
    var out = Object.create(null);
    var any = false;
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var atBase = core.isObject(vbase) ? vbase[field] : undefined;
      var atA = core.isObject(va) ? va[field] : undefined;
      var atB = core.isObject(vb) ? vb[field] : undefined;
      var picked;
      if (core.deepEqual(atA, atB)) picked = atA;
      else if (core.deepEqual(atA, atBase)) picked = atB;
      else if (core.deepEqual(atB, atBase)) picked = atA;
      else return null;
      if (picked !== undefined) {
        out[field] = picked;
        any = true;
      }
    }
    return any ? out : null;
  }

  /**
   * One slot, three copies, one result. This is the whole of the classification in §6's table: the
   * entity-level shapes are decided in `entityStatus`, and every field-level row is decided here.
   */
  function compareSlot(opts) {
    var slot = opts.slot;
    var vbase = slotValue(opts.base, slot);
    var va = slotValue(opts.a, slot);
    var vb = slotValue(opts.b, slot);

    // The entity is carried by neither side. Its fields are neither a change nor a deletion, they are
    // simply not there; the existence decision already covers it and nothing is written from here.
    if (opts.goneA === true && opts.goneB === true) return { slot: slot, decision: null, value: undefined };

    // A side that does not carry the entity at all is not a side that deleted these fields. Comparing
    // its absent entity against a present base would ask the user to decide, once per field, whether to
    // delete fields they never touched. The existence decision owns that question; the remaining side
    // is compared against the base as an ordinary one-sided change.
    var aChanged = opts.goneA !== true && !core.deepEqual(va, vbase);
    var bChanged = opts.goneB !== true && !core.deepEqual(vb, vbase);

    if (!aChanged && !bChanged) return { slot: slot, decision: null, value: vbase };
    if (aChanged && bChanged && core.deepEqual(va, vb)) return { slot: slot, decision: null, value: va };

    var options = [];
    if (aChanged) options.push(fieldOption(SIDE_A, va, slot));
    if (bChanged) options.push(fieldOption(SIDE_B, vb, slot));

    // One real option is not a choice, it is the only thing that can happen. No decision is created,
    // so nothing appears to ask about and nothing can be answered wrongly.
    if (options.length === 1 && vbase === undefined) {
      return { slot: slot, decision: null, value: options[0].raw };
    }

    var conflict = aChanged && bChanged;
    var suggestion = conflict ? null : aChanged ? SIDE_A : SIDE_B;

    if (conflict && slot.fields.length > 1) {
      var combined = combinedValue(vbase, va, vb, slot.fields);
      if (combined) {
        conflict = false;
        suggestion = COMBINED;
        options.push({
          value: COMBINED,
          side: null,
          raw: combined,
          omit: false,
          label: 'Both',
          note: describeSlot(slot, combined),
        });
      }
    }

    if (vbase !== undefined) options.push(fieldOption(SIDE_BASE, vbase, slot));

    // Rule 3: a suggestion never deletes. If the side that changed is the side that removed the
    // value, there is no safe default and the user has to say so.
    if (suggestion && optionFor({ options: options }, suggestion).raw === undefined) suggestion = null;

    var removal = false;
    for (var i = 0; i < options.length; i++) if (options[i].raw === undefined) removal = true;

    return {
      slot: slot,
      value: undefined,
      decision: {
        key: opts.prefix + '#' + slot.key,
        kind: opts.kind,
        group: opts.group || null,
        type: opts.type || null,
        id: opts.id || null,
        slot: slot.key,
        slotSpec: slot,
        label: slot.label,
        note: slot.note || '',
        status: conflict ? 'conflict' : suggestion === COMBINED ? COMBINED : aChanged ? SIDE_A : SIDE_B,
        conflict: conflict,
        removal: removal,
        values: { base: vbase, a: va, b: vb },
        options: options,
        suggestion: suggestion,
      },
    };
  }

  function entityStatus(be, ae, bo) {
    var hasBase = core.isObject(be);
    var hasA = core.isObject(ae);
    var hasB = core.isObject(bo);

    if (!hasBase) {
      if (hasA && hasB) return { status: 'both-added' };
      if (hasA) return { status: 'a-only' };
      if (hasB) return { status: 'b-only' };
      return null;
    }
    if (!hasA && !hasB) return { status: 'removed-both' };
    if (!hasA) {
      return core.deepEqual(bo, be)
        ? { status: 'removed-a' }
        : { status: 'removed-and-changed', removedBy: SIDE_A, changedBy: SIDE_B };
    }
    if (!hasB) {
      return core.deepEqual(ae, be)
        ? { status: 'removed-b' }
        : { status: 'removed-and-changed', removedBy: SIDE_B, changedBy: SIDE_A };
    }

    var aChanged = !core.deepEqual(ae, be);
    var bChanged = !core.deepEqual(bo, be);
    if (!aChanged && !bChanged) return null;
    if (aChanged && !bChanged) return { status: 'a-changed' };
    if (!aChanged && bChanged) return { status: 'b-changed' };
    return { status: core.deepEqual(ae, bo) ? 'both-changed-same' : 'both-changed' };
  }

  function groupTitle(typeSpec, be, ae, bo) {
    var entity = ae || bo || be;
    return typeSpec.label + ' "' + (entity ? M.labelOf(entity) : '?') + '"';
  }

  function derivedRows(typeSpec, ae, bo) {
    if (!formLogic || !core.isObject(ae) || !core.isObject(bo)) return [];
    var specs = formLogic.derivedFields(typeSpec);
    var out = [];
    for (var i = 0; i < specs.length; i++) {
      var va = ae[specs[i].key];
      var vb = bo[specs[i].key];
      if (core.deepEqual(va, vb)) continue;
      out.push({ key: specs[i].key, label: specs[i].label, a: va, b: vb, derived: specs[i].derived });
    }
    return out;
  }

  function presenceDecision(group, meta, be, ae, bo) {
    var status = meta.status;
    var options = null;
    var note = '';

    if (status === 'a-only') {
      options = [
        presenceOption(KEEP, SIDE_A, 'Include it', 'Take the copy the file carries.', false),
        presenceOption(OMIT, null, 'Omit it', 'The merged model will not contain it.', true),
      ];
      note = 'The file added this; local never had it.';
    } else if (status === 'b-only') {
      options = [
        presenceOption(KEEP, SIDE_B, 'Include it', 'Take the copy local carries.', false),
        presenceOption(OMIT, null, 'Omit it', 'The merged model will not contain it.', true),
      ];
      note = 'Local added this; the file never had it.';
    } else if (status === 'removed-a') {
      options = [
        presenceOption(OMIT, null, 'Remove it', 'The file deleted it.', true),
        presenceOption(KEEP, SIDE_B, 'Keep it', 'Local still has it, and did not change it.', false),
      ];
      note = 'The file deleted this; local did not touch it.';
    } else if (status === 'removed-b') {
      options = [
        presenceOption(OMIT, null, 'Remove it', 'Local deleted it.', true),
        presenceOption(KEEP, SIDE_A, 'Keep it', 'The file still has it, and did not change it.', false),
      ];
      note = 'Local deleted this; the file did not touch it.';
    } else if (status === 'removed-and-changed') {
      var removed = meta.removedBy;
      var changed = meta.changedBy;
      options = [
        presenceOption(OMIT, null, 'Remove it', sideTitle(removed) + ' deleted it.', true),
        presenceOption(KEEP, changed, 'Keep it, with ' + sideName(changed) + "'s changes",
          'The deletion is overruled; the changed copy survives.', false),
      ];
      note = sideTitle(removed) + ' deleted this; ' + sideName(changed) + ' changed it. Neither is a safe default.';
    }

    if (!options) return null;

    return {
      key: group.key + '#' + PRESENCE_SLOT,
      kind: 'presence',
      group: group,
      type: group.type,
      id: group.id,
      slot: PRESENCE_SLOT,
      slotSpec: null,
      label: 'Existence',
      note: note,
      status: 'presence',
      conflict: false,
      removal: true,
      values: { base: !!be, a: !!ae, b: !!bo },
      options: options,
      // Every existence choice this module creates is either a deletion or the alternative to one,
      // so none of them is pre-selected. That is what "a deletion is never a default" means here.
      suggestion: status === 'a-only' || status === 'b-only' ? KEEP : null,
    };
  }

  function buildGroup(typeSpec, id, base, a, b) {
    var be = M.get(base, typeSpec.key, id);
    var ae = M.get(a, typeSpec.key, id);
    var bo = M.get(b, typeSpec.key, id);
    var meta = entityStatus(be, ae, bo);
    if (!meta) return null;

    var group = {
      key: typeSpec.key + '/' + id,
      scope: 'entity',
      type: typeSpec.key,
      typeSpec: typeSpec,
      id: id,
      status: meta.status,
      kind: STATUS[meta.status].kind,
      statusLabel: STATUS[meta.status].label,
      removedBy: meta.removedBy || null,
      changedBy: meta.changedBy || null,
      title: groupTitle(typeSpec, be, ae, bo),
      presence: null,
      slots: [],
      decisions: [],
      derived: derivedRows(typeSpec, ae, bo),
      conflict: false,
      needsDecision: false,
      auto: null,
    };

    group.presence = presenceDecision(group, meta, be, ae, bo);

    var decisions = [];
    if (group.presence) decisions.push(group.presence);

    var slots = slotListFor(typeSpec, [be, ae, bo]);
    // A side can only have "lost" the entity if there was one to lose. When the base has no entity the
    // sides are compared against an absent base, which is a different question and is handled by the
    // slot comparison itself.
    var goneA = core.isObject(be) && !core.isObject(ae);
    var goneB = core.isObject(be) && !core.isObject(bo);
    for (var i = 0; i < slots.length; i++) {
      var entry = compareSlot({
        slot: slots[i],
        base: be,
        a: ae,
        b: bo,
        goneA: goneA,
        goneB: goneB,
        prefix: group.key,
        kind: 'field',
        group: group,
        type: group.type,
        id: group.id,
      });
      if (!entry) continue;
      // A slot with no value anywhere and no decision is nothing to write and nothing to say.
      if (!entry.decision && entry.value === undefined) continue;
      group.slots.push(entry);
      if (entry.decision) decisions.push(entry.decision);
    }

    group.decisions = decisions;
    if (!group.presence) group.auto = meta.status === 'removed-both' ? OMIT : KEEP;

    for (var d = 0; d < decisions.length; d++) {
      if (decisions[d].conflict) group.conflict = true;
      if (!decisions[d].suggestion) group.needsDecision = true;
    }
    return group;
  }

  function orderedIds(typeSpec, base, a, b) {
    var seen = Object.create(null);
    var out = [];
    function addFrom(model) {
      var list = M.collection(model, typeSpec.key);
      for (var i = 0; i < list.length; i++) {
        var id = list[i] && list[i].id;
        if (!core.isString(id) || seen[id]) continue;
        seen[id] = true;
        out.push(id);
      }
    }
    // Base order first, so an entity that was already there stays where it was; then what each side
    // added, in that side's own order. Deterministic from the three models alone.
    addFrom(base);
    addFrom(a);
    addFrom(b);
    return out;
  }

  /**
   * The entities all three sides carry identically.
   *
   * They are not differences, so they are not groups and the screen never shows them — but they are
   * in the models, and a merge built from the differences alone would delete everything nobody
   * touched. They are carried from the base, which is the same entity as either side's.
   */
  function buildCarried(base, a, b) {
    var out = [];
    for (var i = 0; i < M.TYPES.length; i++) {
      var typeSpec = M.TYPES[i];
      var ids = orderedIds(typeSpec, base, a, b);
      for (var j = 0; j < ids.length; j++) {
        var be = M.get(base, typeSpec.key, ids[j]);
        if (!core.isObject(be)) continue;
        if (!entityStatus(be, M.get(a, typeSpec.key, ids[j]), M.get(b, typeSpec.key, ids[j]))) {
          out.push({ type: typeSpec.key, id: ids[j] });
        }
      }
    }
    return out;
  }

  function buildGroups(base, a, b) {
    var groups = [];
    for (var i = 0; i < M.TYPES.length; i++) {
      var typeSpec = M.TYPES[i];
      var ids = orderedIds(typeSpec, base, a, b);
      for (var j = 0; j < ids.length; j++) {
        var group = buildGroup(typeSpec, ids[j], base, a, b);
        if (group) groups.push(group);
      }
    }
    return groups;
  }

  var ENTITY_KEY_SET = (function () {
    var set = Object.create(null);
    for (var i = 0; i < M.ENTITY_KEYS.length; i++) set[M.ENTITY_KEYS[i]] = true;
    return set;
  })();

  function modelSlotKeys(base, a, b) {
    var seen = Object.create(null);
    var out = [];
    function add(key) {
      if (seen[key] || IDENTITY_KEYS[key] || ENTITY_KEY_SET[key]) return;
      seen[key] = true;
      out.push(key);
    }
    add('name');
    add('description');
    var rest = core.unique(core.sortedKeys(base).concat(core.sortedKeys(a), core.sortedKeys(b)));
    for (var i = 0; i < rest.length; i++) add(rest[i]);
    return out;
  }

  function buildModelEntries(base, a, b) {
    var keys = modelSlotKeys(base, a, b);
    var entries = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entry = compareSlot({
        slot: { key: key, label: MODEL_LABELS[key] || key, fields: [key], spec: null },
        base: base,
        a: a,
        b: b,
        prefix: 'model',
        kind: 'model',
      });
      if (!entry) continue;
      if (!entry.decision && entry.value === undefined) continue;
      entries.push(entry);
    }
    return entries;
  }

  function sideOf(history, commit, name, role, side) {
    return {
      side: side,
      id: commit.id,
      short: core.shortId(commit.id),
      hash: commit.modelHash,
      hashShort: core.isString(commit.modelHash) ? 'sha256:' + core.shortId(commit.modelHash) + '…' : '—',
      commit: commit,
      name: name,
      role: role,
      model: vcs.materialize(history, commit.id),
    };
  }

  function emptyCounts() {
    return { added: 0, changed: 0, removed: 0, conflicts: 0, needsDecision: 0, groups: 0, decisions: 0 };
  }

  /**
   * Everything the compare screen shows, and nothing that writes.
   *
   * Defined for any two commits in one history, not only for a divergence: for a fast-forward the
   * merge base is the older head, one side has no changes at all, and every slot lands on the agreed
   * branch. The shell only opens this screen for `vcs.DIVERGED`, but there is no reason for the
   * comparison to be wrong about the other verdicts.
   */
  function plan(history, aHead, bHead, options) {
    var opts = options || {};
    var out = {
      ok: false,
      reason: null,
      message: '',
      history: history || null,
      aHead: aHead || null,
      bHead: bHead || null,
      base: null,
      a: null,
      b: null,
      approximate: false,
      baseMultiple: false,
      baseCandidates: [],
      modelFields: [],
      groups: [],
      decisions: [],
      counts: emptyCounts(),
    };

    // REQ-VCS-012: a merge built on top of uncommitted edits is a merge built on a model that is in
    // neither history. The shell passes this in; the refusal and its wording live here so that the
    // requirement has one home.
    if (opts.workingDirty) {
      out.reason = 'dirty';
      out.message =
        'The working copy has uncommitted changes. Commit, stash or discard them first — a merge decided ' +
        'against edits that are in neither history would silently write over them.';
      return out;
    }
    if (!history || !core.isArray(history.commits)) {
      out.reason = 'history';
      out.message = 'There is no history to compare.';
      return out;
    }
    var aCommit = vcs.commitById(history, aHead);
    var bCommit = vcs.commitById(history, bHead);
    if (!aCommit || !bCommit) {
      out.reason = 'commit';
      out.message = 'One of the two commits to compare is not in this history.';
      return out;
    }
    if (!core.isString(aCommit.modelId) || aCommit.modelId !== bCommit.modelId) {
      out.reason = 'unrelated';
      out.message =
        'These two commits describe different models. They are kept side by side rather than combined ' +
        '(REQ-SYNC-006): merging unrelated lineages would produce a model that never existed.';
      return out;
    }

    var mb = vcs.mergeBase(history, aHead, bHead);
    if (!mb.base) {
      out.reason = 'unrelated';
      out.message =
        'These two histories share no common ancestor, so there is no base to compare against. They are ' +
        'kept side by side as separate models (REQ-SYNC-006).';
      return out;
    }

    out.baseMultiple = mb.multiple === true;
    out.baseCandidates = mb.candidates.slice();
    out.approximate = out.baseMultiple;

    out.base = sideOf(history, vcs.commitById(history, mb.base), 'Base', 'The lowest common ancestor', SIDE_BASE);
    out.a = sideOf(history, aCommit, opts.aName || 'The file', opts.aRole || 'The file being opened', SIDE_A);
    out.b = sideOf(history, bCommit, opts.bName || 'Local', opts.bRole || 'The history stored in this browser', SIDE_B);

    out.modelFields = buildModelEntries(out.base.model, out.a.model, out.b.model);
    out.groups = buildGroups(out.base.model, out.a.model, out.b.model);
    out.carried = buildCarried(out.base.model, out.a.model, out.b.model);

    var i, j;
    for (i = 0; i < out.modelFields.length; i++) {
      var md = out.modelFields[i].decision;
      if (!md) continue;
      out.decisions.push(md);
    }
    for (i = 0; i < out.groups.length; i++) {
      var group = out.groups[i];
      if (group.kind === 'added') out.counts.added++;
      else if (group.kind === 'removed') out.counts.removed++;
      else out.counts.changed++;
      for (j = 0; j < group.decisions.length; j++) out.decisions.push(group.decisions[j]);
    }
    for (i = 0; i < out.decisions.length; i++) {
      if (out.decisions[i].conflict) out.counts.conflicts++;
      if (!out.decisions[i].suggestion) out.counts.needsDecision++;
    }
    out.counts.groups = out.groups.length;
    out.counts.decisions = out.decisions.length;
    out.ok = true;
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Resolution — reading, filling and describing the user's answers
  // ---------------------------------------------------------------------------------------------

  function defaultResolution(thePlan) {
    var res = Object.create(null);
    if (!thePlan || !core.isArray(thePlan.decisions)) return res;
    for (var i = 0; i < thePlan.decisions.length; i++) {
      var d = thePlan.decisions[i];
      if (d.suggestion) res[d.key] = d.suggestion;
    }
    return res;
  }

  /** Decisions with no answer. Non-empty means the merge cannot be confirmed yet. */
  function missingDecisions(thePlan, resolution) {
    var res = resolution || Object.create(null);
    var out = [];
    if (!thePlan || !core.isArray(thePlan.decisions)) return out;
    for (var i = 0; i < thePlan.decisions.length; i++) {
      var d = thePlan.decisions[i];
      if (!optionFor(d, res[d.key])) out.push(d);
    }
    return out;
  }

  /**
   * "1 decision still needs an answer" / "3 decisions still need an answer".
   *
   * `core.plural` supplies only the noun, so the verb has to be chosen alongside the count — a shared
   * tail would read "1 decision still need an answer", which makes a screen that is being careful
   * about everything else look careless about the one sentence telling you what is left to do.
   */
  function decisionsNeeding(count) {
    return count === 1
      ? '1 decision still needs an answer'
      : count + ' decisions still need an answer';
  }

  function choiceCounts(thePlan, resolution) {
    var res = resolution || Object.create(null);
    var out = { fromA: 0, fromB: 0, fromBase: 0, combined: 0, omitted: 0, undecided: 0, total: 0 };
    if (!thePlan || !core.isArray(thePlan.decisions)) return out;
    out.total = thePlan.decisions.length;
    for (var i = 0; i < thePlan.decisions.length; i++) {
      var d = thePlan.decisions[i];
      var opt = optionFor(d, res[d.key]);
      if (!opt) {
        out.undecided++;
        continue;
      }
      if (opt.omit) {
        out.omitted++;
        continue;
      }
      // The side an option means, not the word it is spelled with: an existence decision's options
      // are keep and remove, and which side "keep" takes its copy from is carried on the option.
      var means = opt.side || opt.value;
      if (opt.value === COMBINED) out.combined++;
      else if (means === SIDE_A) out.fromA++;
      else if (means === SIDE_B) out.fromB++;
      else out.fromBase++;
    }
    return out;
  }

  function describeResolution(thePlan, resolution) {
    var c = choiceCounts(thePlan, resolution);
    var parts = [];
    if (c.fromA) parts.push(c.fromA + ' from the file');
    if (c.fromB) parts.push(c.fromB + ' from local');
    if (c.combined) parts.push(c.combined + ' combining both');
    if (c.fromBase) parts.push(c.fromBase + ' left at the base');
    if (c.omitted) parts.push(c.omitted + ' removed');
    if (c.undecided) parts.push(c.undecided + ' undecided');
    return parts.length ? parts.join(', ') : 'no differences to resolve';
  }

  /** §6: the merge commit's message describes the resolution, and the user can edit it. */
  function mergeMessage(thePlan, resolution) {
    return (
      'Merge ' + thePlan.a.name + ' (' + thePlan.a.short + ') with ' + thePlan.b.name + ' (' + thePlan.b.short +
      ') — ' + describeResolution(thePlan, resolution) + '.'
    );
  }

  function summaryLine(thePlan) {
    var c = thePlan.counts;
    return c.added + ' added · ' + c.changed + ' changed · ' + c.removed + ' removed';
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Applying — the plan plus the answers, into a model
  // ---------------------------------------------------------------------------------------------

  function pickValue(entry, res, unresolved) {
    var d = entry.decision;
    if (!d) return entry.value;
    var opt = optionFor(d, res[d.key]);
    if (!opt) {
      // Defensive only: the screen keeps Confirm disabled while anything is unanswered. Falling back
      // to the ancestor value keeps a partial resolution inspectable rather than destructive.
      if (unresolved && unresolved.indexOf(d.key) === -1) unresolved.push(d.key);
      return d.values.base;
    }
    return opt.raw;
  }

  function resolvePresence(group, res, unresolved) {
    if (!group.presence) return group.auto !== OMIT;
    var opt = optionFor(group.presence, res[group.presence.key]);
    if (!opt) {
      if (unresolved && unresolved.indexOf(group.presence.key) === -1) unresolved.push(group.presence.key);
      return true;
    }
    return !opt.omit;
  }

  function writeSlot(values, slot, raw) {
    if (raw === undefined || raw === null) return;
    if (slot.fields.length === 1) {
      values[slot.key] = core.deepCopy(raw);
      return;
    }
    for (var i = 0; i < slot.fields.length; i++) {
      var field = slot.fields[i];
      if (raw[field] !== undefined) values[field] = core.deepCopy(raw[field]);
    }
  }

  /**
   * Derived values (rule 5).
   *
   * Three things this must not do, each of which is a different way to get a derived field wrong:
   *
   *   - It must not **invent** one. A model that records no `riskScore` must not gain one by being
   *     merged, or the merged model would differ from both sides in a way nobody chose, hash
   *     differently, and show up as a change in the next comparison.
   *   - It must not **lose** one. A recorded value is part of the model, so it survives even when the
   *     inputs to it do not (an imported file can carry `score` with no `likelihood`).
   *   - It must not carry a **stale** one. Where a side recorded the value, the merge recomputes it from
   *     the inputs it just resolved, so the result is internally consistent — which is the whole point
   *     of merging `likelihood` and `impact` at all.
   *
   * So: nothing recorded anywhere means nothing written; something recorded means recomputed, and if it
   * is not computable from the resolved inputs, the recorded value is carried through instead.
   */
  function recomputeDerived(typeSpec, values, baseEntity, aEntity, bEntity) {
    if (!formLogic) return;
    var specs = formLogic.derivedFields(typeSpec);
    var sides = [baseEntity, aEntity, bEntity];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var recorded;
      for (var s = 0; s < sides.length; s++) {
        if (core.isObject(sides[s]) && sides[s][spec.key] !== undefined) {
          recorded = sides[s][spec.key];
          break;
        }
      }
      if (recorded === undefined) continue;

      var inputs = DERIVED_INPUTS[spec.derived];
      var computed = inputs ? formLogic.derivedValue(spec, values) : null;
      values[spec.key] = computed === undefined || computed === null ? core.deepCopy(recorded) : computed;
    }
  }

  function entityIdsOf(model) {
    var ids = Object.create(null);
    if (!core.isObject(model)) return ids;
    for (var i = 0; i < M.ENTITY_KEYS.length; i++) {
      var list = M.collection(model, M.ENTITY_KEYS[i]);
      for (var j = 0; j < list.length; j++) if (list[j] && core.isString(list[j].id)) ids[list[j].id] = true;
    }
    return ids;
  }

  /**
   * Reference slots whose chosen value names something the merged model does not contain.
   *
   * `M.validate(…, {referential: true})` already reports this, and it is the authority — it knows which
   * *type* each reference may point at, which this does not. What this adds is placement: the warning
   * lands on the row the user just chose, instead of in a list at the bottom, which is the difference
   * between a problem being actionable and being reported.
   */
  function danglingTargets(thePlan, resolution, model) {
    var out = Object.create(null);
    var ids = entityIdsOf(model);

    function check(entry) {
      var d = entry.decision;
      if (!d || !d.slotSpec || !d.slotSpec.spec) return;
      var kind = d.slotSpec.spec.kind;
      if (kind !== 'ref' && kind !== 'refList') return;
      var opt = optionFor(d, resolution[d.key]);
      if (!opt || opt.raw === undefined) return;
      var list = core.isArray(opt.raw) ? opt.raw : [opt.raw];
      var missing = [];
      for (var i = 0; i < list.length; i++) {
        if (core.isString(list[i]) && list[i] !== '' && !ids[list[i]]) missing.push(list[i]);
      }
      if (missing.length) out[d.key] = missing;
    }

    for (var i = 0; i < thePlan.modelFields.length; i++) check(thePlan.modelFields[i]);
    for (var g = 0; g < thePlan.groups.length; g++) {
      var group = thePlan.groups[g];
      if (!resolvePresence(group, resolution, null)) continue;
      for (var s = 0; s < group.slots.length; s++) check(group.slots[s]);
    }
    return out;
  }

  /**
   * Build the resolved model. Pure: it reads `thePlan` and `resolution`, allocates a new model and
   * touches neither the history nor the working copy.
   *
   * The result goes through `M.insert` per entity, so every value passes the same coercion the rest of
   * the application uses, unknown keys survive verbatim, and a field the merge never mentioned keeps
   * whatever the side it came from had.
   *
   * Three things go in: the model's own fields, one entity per group, and the entities in
   * `thePlan.carried` — the ones both sides left exactly as the base had them. Without the last of
   * those a merge would delete every entity nobody touched.
   */
  function apply(thePlan, resolution) {
    var res = resolution || Object.create(null);
    var unresolved = [];
    var out = Object.create(null);
    out.tmvFormat = thePlan.base.model.tmvFormat;
    out.modelId = thePlan.base.model.modelId;

    var i, j;
    for (i = 0; i < thePlan.modelFields.length; i++) {
      var entry = thePlan.modelFields[i];
      var picked = pickValue(entry, res, unresolved);
      if (picked !== undefined) out[entry.slot.key] = core.deepCopy(picked);
    }

    for (i = 0; i < M.ENTITY_KEYS.length; i++) out[M.ENTITY_KEYS[i]] = [];

    for (i = 0; i < thePlan.groups.length; i++) {
      var group = thePlan.groups[i];
      if (!resolvePresence(group, res, unresolved)) continue;
      var values = Object.create(null);
      values.id = group.id;
      for (j = 0; j < group.slots.length; j++) {
        writeSlot(values, group.slots[j].slot, pickValue(group.slots[j], res, unresolved));
      }
      recomputeDerived(
        group.typeSpec,
        values,
        M.get(thePlan.base.model, group.type, group.id),
        M.get(thePlan.a.model, group.type, group.id),
        M.get(thePlan.b.model, group.type, group.id),
      );
      M.insert(out, group.type, values);
    }

    // Everything neither side touched. Read from the base, because the base and both sides carry the
    // same entity: copying it here is not a decision, it is the absence of one.
    for (i = 0; i < thePlan.carried.length; i++) {
      var kept = M.get(thePlan.base.model, thePlan.carried[i].type, thePlan.carried[i].id);
      if (kept) M.insert(out, thePlan.carried[i].type, core.deepCopy(kept));
    }

    var report = M.validate(out, { referential: true });
    return {
      model: out,
      unresolved: unresolved,
      problems: report.problems,
      dangling: danglingTargets(thePlan, res, out),
    };
  }

  /** Errors, not warnings: a warning is a fact about the model, an error would block an export. */
  function errorProblems(applied) {
    var out = [];
    if (!applied || !core.isArray(applied.problems)) return out;
    for (var i = 0; i < applied.problems.length; i++) {
      if (applied.problems[i].severity !== M.SEVERITY_WARNING) out.push(applied.problems[i]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // 5. The screen (`07-ui.md` §6, §7, §8)
  // ---------------------------------------------------------------------------------------------

  var TAG_FOR_STATUS = {
    'a-only': 'blue',
    'b-only': 'teal',
    'both-added': 'green',
    'a-changed': 'blue',
    'b-changed': 'teal',
    'both-changed': 'purple',
    'both-changed-same': 'green',
    'removed-a': 'red',
    'removed-b': 'red',
    'removed-both': 'gray',
    'removed-and-changed': 'red',
  };

  function findAction(root, action) {
    var found = root.querySelectorAll('[data-action]');
    for (var i = 0; i < found.length; i++) {
      if (found[i].getAttribute('data-action') === action) return found[i];
    }
    return null;
  }

  function setChecked(root, value) {
    var inputs = root.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = value !== null && value !== undefined && inputs[i].getAttribute('value') === String(value);
    }
  }

  /**
   * The option a "use this side's version" button means.
   *
   * Falls back deliberately: if that side has no option of its own — because its copy is the base, or
   * because it does not have the entity at all — the answer is the omission, then the ancestor value.
   * So "use the file's version" on something only local has means "drop it", which is what the user is
   * asking for, rather than silently doing nothing.
   */
  function bestOptionFor(decision, side) {
    var i;
    for (i = 0; i < decision.options.length; i++) if (decision.options[i].side === side) return decision.options[i];
    for (i = 0; i < decision.options.length; i++) if (decision.options[i].omit) return decision.options[i];
    for (i = 0; i < decision.options.length; i++) if (decision.options[i].value === SIDE_BASE) return decision.options[i];
    return decision.options[0] || null;
  }

  function refusalBlock(thePlan) {
    var reason = thePlan && thePlan.reason ? thePlan.reason : 'unknown';
    return core.el('div', { class: 'tmv-compare tmv-compare--refused', 'data-reason': reason }, [
      core.el('h2', { class: 'tmv-compare__title', text: 'This comparison cannot be made' }),
      core.el('p', {
        class: 'tmv-compare__lead',
        text: (thePlan && thePlan.message) || 'There is nothing to compare.',
      }),
    ]);
  }

  /**
   * Render the comparison. Returns the element and the handle the caller needs; it does not open a
   * dialog and it does not write anything. `onConfirm` receives the resolved model — what happens to it
   * is the shell's business.
   */
  function screen(options) {
    var opts = options || {};
    var thePlan = opts.plan;
    var root = core.el('section', { class: 'tmv-compare', 'aria-labelledby': 'tmv-compare-title' });

    if (!thePlan || !thePlan.ok) {
      root.appendChild(refusalBlock(thePlan));
      return {
        element: root,
        plan: thePlan || null,
        resolution: function () { return Object.create(null); },
        refresh: function () {},
        applied: function () { return null; },
        missing: function () { return []; },
      };
    }

    var filter = opts.filter || FILTER_NEEDS;
    var rows = [];
    var groupNodes = [];
    var counters = { n: 0 };

    // ---- header: the three sides -----------------------------------------------------------------

    function paneNode(side) {
      var s = thePlan[side];
      // No `cds--col`: the pinned stylesheet is `@carbon/styles@1.116.0/css/styles.min.css`, and it
      // contains no `.cds--grid` rule at all — the package ships that one file and the 2× grid is not
      // in it. The two classes that used to be here matched nothing, so the panes were laid out by
      // `.tmv-compare__panes` in `00-app.css` regardless, and the Carbon names only made it look as
      // though something else was doing the work.
      return core.el('div', { class: 'tmv-compare__pane', 'data-side': s.side }, [
        core.el('h3', { class: 'tmv-compare__pane-name', text: s.name }),
        core.el('p', { class: 'tmv-compare__pane-role', text: s.role }),
        core.el('p', { class: 'tmv-compare__pane-commit', text: 'Commit ' + s.short }),
        core.el('p', { class: 'tmv-compare__pane-hash', text: s.hashShort }),
      ]);
    }

    // The base in use is `baseCandidates[0]`, so a list of "other candidates" has to leave it out —
    // as written, the sentence named the base it had just named as its own alternative.
    var otherBases = [];
    for (var bi = 0; bi < thePlan.baseCandidates.length; bi++) {
      if (thePlan.baseCandidates[bi] !== thePlan.base.id) {
        otherBases.push(core.shortId(thePlan.baseCandidates[bi]));
      }
    }

    var approximation = core.el('p', {
      class: 'tmv-compare__approximate',
      text:
        'This comparison is approximate. These two histories have more than one merge base — an earlier ' +
        'criss-cross of merges — and this comparison uses ' + core.shortId(thePlan.base.id) +
        (otherBases.length ? '. The other candidates are ' + otherBases.join(', ') : '') +
        '. Nothing is decided automatically, so the differences shown are real; a difference that exists ' +
        'only along another base may not appear.',
    });
    core.setHidden(approximation, !thePlan.approximate);

    var header = core.el('header', { class: 'tmv-compare__header' }, [
      core.el('h2', { id: 'tmv-compare-title', class: 'tmv-compare__title', text: 'Compare and merge' }),
      core.el('p', {
        class: 'tmv-compare__lead',
        text:
          'Nothing is written until you confirm. Every choice below is yours to make: the ones this ' +
          'comparison proposes are marked as suggestions, and the ones it cannot propose are left blank.',
      }),
      core.el('div', { class: 'tmv-compare__panes' }, [
        paneNode(SIDE_BASE),
        paneNode(SIDE_A),
        paneNode(SIDE_B),
      ]),
      approximation,
    ]);

    // ---- toolbar ---------------------------------------------------------------------------------

    var countsText = core.el('p', { class: 'tmv-compare__counts', text: summaryLine(thePlan) });
    var needsText = core.el('p', { class: 'tmv-compare__needs' });
    var switcher = widgets.contentSwitcher({
      label: 'Which rows to show',
      items: [
        { value: FILTER_NEEDS, label: 'Needs a decision' },
        { value: FILTER_ALL, label: 'Everything' },
      ],
      selected: filter,
      onChange: function (value) {
        filter = value;
        refresh();
      },
    });

    var toolbar = core.el('div', { class: 'tmv-compare__toolbar' }, [
      switcher.element,
      countsText,
      needsText,
      widgets.button({
        label: 'Accept all suggestions',
        kind: 'tertiary',
        action: 'accept-suggestions',
        title: 'Fill in the choices this comparison proposes. Conflicts and deletions are left for you.',
      }),
      widgets.button({
        label: 'Clear all choices',
        kind: 'ghost',
        action: 'clear-choices',
        title: 'Empty every choice, including the suggestions, so you can go through the list unaided.',
      }),
    ]);

    // ---- a row per decision ----------------------------------------------------------------------

    function valueRow(label, value, slot) {
      return core.el('div', { class: 'tmv-diff__value' }, [
        core.el('dt', { class: 'tmv-diff__value-label', text: label }),
        core.el('dd', { class: 'tmv-diff__value-text', text: describeSlot(slot, value) }),
      ]);
    }

    function decisionRow(decision) {
      counters.n++;
      var body = [];

      if (decision.kind !== 'presence') {
        body.push(core.el('dl', { class: 'tmv-diff__values' }, [
          valueRow(thePlan.base.name, decision.values.base, decision.slotSpec),
          valueRow(thePlan.a.name, decision.values.a, decision.slotSpec),
          valueRow(thePlan.b.name, decision.values.b, decision.slotSpec),
        ]));
      }

      var choice = forms.radioGroup({
        name: 'tmv-cmp-' + counters.n,
        options: decision.options.map(function (o) {
          return { value: o.value, label: o.label, note: o.note };
        }),
        // Only a suggestion is pre-selected. A conflict and a deletion render with nothing chosen, so
        // the user has to answer them rather than confirm an answer nobody gave.
        selected: decision.suggestion,
      });
      body.push(choice.element);

      if (decision.suggestion) {
        body.push(core.el('p', {
          class: 'tmv-diff__suggested',
          text: 'Suggested: ' + optionFor(decision, decision.suggestion).label + '. Change it if that is not what you want.',
        }));
      }

      var warning = core.el('p', { class: 'tmv-diff__warning', hidden: true });
      body.push(warning);

      var field = core.el('fieldset', {
        class: 'tmv-diff__field cds--fieldset' + (decision.conflict ? ' tmv-diff__field--conflict' : '') +
          (decision.removal ? ' tmv-diff__field--removal' : ''),
        'data-key': decision.key,
        'data-status': decision.status,
      }, [core.el('legend', { class: 'tmv-diff__legend', text: decision.label })].concat(body));

      var row = {
        decision: decision,
        element: field,
        warning: warning,
        read: function () { return choice.read(); },
        set: function (value) { setChecked(choice.element, value); },
      };
      rows.push(row);
      return row;
    }

    function derivedRow(spec, typeSpec) {
      return core.el('div', { class: 'tmv-diff__derived' }, [
        core.el('p', {
          class: 'tmv-diff__derived-label',
          text: spec.label + ' (derived)',
        }),
        core.el('dl', { class: 'tmv-diff__values' }, [
          valueRow(thePlan.a.name, spec.a, null),
          valueRow(thePlan.b.name, spec.b, null),
        ]),
        core.el('p', {
          class: 'tmv-diff__derived-note',
          text:
            'Computed from ' + (DERIVED_INPUTS[spec.derived] || []).join(' and ') +
            ', so it is not a choice. It is recomputed if those change, and left as recorded if they do not.',
        }),
      ]);
    }

    function groupSection(group) {
      var title = core.el('h3', { class: 'tmv-diff__title' }, [
        core.el('span', { class: 'tmv-diff__name', text: group.title }),
        widgets.tag({
          text: group.statusLabel,
          type: TAG_FOR_STATUS[group.status] || null,
          title: group.note || null,
        }),
      ]);

      var fieldNodes = [];
      // A change both sides agree on has no decision, but it is still part of what the merge does.
      if (!group.presence) fieldNodes.push(decisionRowless(group).element);
      if (group.presence) fieldNodes.push(decisionRow(group.presence).element);
      for (var i = 0; i < group.slots.length; i++) {
        var entry = group.slots[i];
        if (!entry.decision) continue;
        fieldNodes.push(decisionRow(entry.decision).element);
      }
      for (i = 0; i < group.derived.length; i++) fieldNodes.push(derivedRow(group.derived[i], group.typeSpec));

      var fieldsWrap = core.el('div', { class: 'tmv-diff__fields' }, fieldNodes);

      // `data-group` goes on the button, not on the wrapper: the delegated listener is handed the
      // nearest element carrying `data-action`, which is the button.
      function sideButton(side, label, title) {
        var node = widgets.button({ label: label, kind: 'ghost', size: 'sm', action: 'take-side', value: side, title: title });
        node.setAttribute('data-group', group.key);
        return node;
      }

      var bulk = core.el('div', { class: 'tmv-diff__bulk' }, [
        sideButton(SIDE_A, "Use the file's version", 'Take this whole entity from the file, for every field above.'),
        sideButton(SIDE_B, "Use local's version", 'Take this whole entity from local, for every field above.'),
      ]);

      var section = core.el('section', {
        class: 'tmv-diff',
        'data-key': group.key,
        'data-status': group.status,
        'data-kind': group.kind,
      }, [title, group.note ? core.el('p', { class: 'tmv-diff__note', text: group.note }) : null, fieldsWrap, bulk]);

      groupNodes.push({ group: group, node: section, fields: fieldsWrap });
      return section;
    }

    /**
     * A change both sides agree on has no decision to render, but it is still part of what the merge
     * does, so "everything" shows it as a plain statement.
     */
    function decisionRowless(group) {
      var text = group.auto === OMIT
        ? 'Both sides removed this, so the merged model does not contain it.'
        : 'Both sides made the same change, so the merged model takes it as it stands.';
      return {
        decision: null,
        element: core.el('p', { class: 'tmv-diff__agreed', text: text }),
        warning: null,
        read: function () { return null; },
        set: function () {},
      };
    }

    // ---- the model's own fields ------------------------------------------------------------------

    var modelSection = null;
    if (thePlan.modelFields.length) {
      var modelRows = [];
      for (var mf = 0; mf < thePlan.modelFields.length; mf++) {
        if (!thePlan.modelFields[mf].decision) continue;
        modelRows.push(decisionRow(thePlan.modelFields[mf].decision).element);
      }
      modelSection = core.el('section', { class: 'tmv-diff tmv-diff--model', 'data-kind': 'model' }, [
        core.el('h3', { class: 'tmv-diff__title' }, [
          core.el('span', { class: 'tmv-diff__name', text: 'The model itself' }),
        ]),
        core.el('div', { class: 'tmv-diff__fields' }, modelRows),
      ]);
    }

    var groups = core.el('div', { class: 'tmv-compare__groups' });
    if (modelSection) groups.appendChild(modelSection);
    for (var g = 0; g < thePlan.groups.length; g++) groups.appendChild(groupSection(thePlan.groups[g]));

    // Written out here rather than built with `widgets.emptyState` because this one node has to be
    // able to say two different things, and the widget takes its words as strings at construction.
    //
    // The distinction is not cosmetic. "Every difference is already agreed" is true when the two sides
    // happen to match; it is flatly false when they differ and the *filter* is what left the screen
    // empty — at that moment both sides did change things, and telling the reader otherwise would be
    // the screen lying about the model it is asking them to merge.
    var nothingTitle = core.el('h3', { class: 'tmv-empty__title' });
    var nothingBody = core.el('p', { class: 'tmv-empty__body' });
    var nothing = core.el('div', { class: 'tmv-empty' }, [nothingTitle, nothingBody]);

    // ---- footer -----------------------------------------------------------------------------------

    var progress = core.el('p', { class: 'tmv-compare__progress' });
    var problemList = core.el('ul', { class: 'tmv-compare__problems' });
    var problemBox = core.el('div', { class: 'tmv-compare__problem-box', hidden: true }, [
      core.el('p', { class: 'tmv-compare__problem-lead' }),
      problemList,
    ]);

    var footer = core.el('footer', { class: 'tmv-compare__footer' }, [
      progress,
      problemBox,
      core.el('div', { class: 'tmv-compare__actions' }, [
        widgets.button({
          label: 'Cancel',
          kind: 'tertiary',
          action: 'cancel',
          title: 'Leave both histories and the working copy exactly as they are.',
        }),
        widgets.button({
          label: 'Merge',
          kind: 'primary',
          action: 'confirm',
          name: 'confirm',
          disabled: true,
          title: 'Answer the decisions with no suggestion first',
        }),
      ]),
    ]);

    root.appendChild(header);
    root.appendChild(toolbar);
    root.appendChild(nothing);
    root.appendChild(groups);
    root.appendChild(footer);

    // ---- behaviour --------------------------------------------------------------------------------

    function resolution() {
      var res = Object.create(null);
      for (var i = 0; i < rows.length; i++) {
        var value = rows[i].read();
        if (value !== null && value !== undefined) res[rows[i].decision.key] = value;
      }
      return res;
    }

    function appliedNow(res) {
      try {
        return apply(thePlan, res);
      } catch (err) {
        return { model: null, unresolved: [], problems: [], dangling: Object.create(null), failed: err };
      }
    }

    function refresh() {
      var res = resolution();
      var missing = missingDecisions(thePlan, res);
      var applied = appliedNow(res);
      var c = choiceCounts(thePlan, res);

      countsText.textContent = summaryLine(thePlan);
      needsText.textContent = missing.length
        ? decisionsNeeding(missing.length)
        : 'every decision has an answer';

      var shownGroups = 0;
      var i, j;
      for (i = 0; i < groupNodes.length; i++) {
        var node = groupNodes[i];
        var show = filter === FILTER_ALL || node.group.needsDecision;
        core.setHidden(node.node, !show);
        if (show) shownGroups++;

        var keep = resolvePresence(node.group, res, null);
        core.setHidden(node.fields, !keep);
        core.setAttr(node.node, 'data-omitted', keep ? null : 'true');
      }
      var shownModel = false;
      if (modelSection) {
        var modelNeeds = false;
        for (i = 0; i < thePlan.modelFields.length; i++) {
          var md = thePlan.modelFields[i].decision;
          if (md && !md.suggestion) modelNeeds = true;
        }
        shownModel = filter === FILTER_ALL || modelNeeds;
        core.setHidden(modelSection, !shownModel);
      }

      // The empty state answers "is anything on screen", not "does anything differ" — those came apart
      // as soon as a filter could hide every group, and the filter that does it is the default one.
      var anyDiff = thePlan.groups.length > 0 || thePlan.modelFields.length > 0;
      var anyShown = shownGroups > 0 || shownModel;
      core.setHidden(nothing, anyShown);
      if (!anyShown) {
        if (anyDiff) {
          nothingTitle.textContent = 'Nothing needs a decision';
          nothingBody.textContent =
            'These histories do differ — the counts above are the differences — but every one of them ' +
            'already has an answer, either because it was suggested or because only one side changed ' +
            'it. Choose “Everything” to read them anyway.';
        } else {
          nothingTitle.textContent = 'Every difference is already agreed';
          nothingBody.textContent =
            'Both sides made the same changes, or only one side made any. The merged model is what you ' +
            'see described above; merging now records it with both histories as parents.';
        }
      }

      // Warnings land on the row that caused them, not only in a list at the bottom.
      for (i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row.decision || !row.warning) continue;
        var missingTargets = applied.dangling ? applied.dangling[row.decision.key] : null;
        if (missingTargets && missingTargets.length) {
          row.warning.textContent =
            'This points at ' + core.plural(missingTargets.length, 'entity', 'entities') +
            ' the merged model does not contain: ' + missingTargets.join(', ') + '.';
          core.setHidden(row.warning, false);
        } else {
          core.setHidden(row.warning, true);
        }
      }

      var errors = errorProblems(applied);
      problemBox.firstChild.textContent = errors.length
        ? core.plural(errors.length, 'problem') + ' in the merged model'
        : '';
      while (problemList.firstChild) problemList.removeChild(problemList.firstChild);
      for (i = 0; i < errors.length; i++) {
        problemList.appendChild(core.el('li', {
          class: 'tmv-compare__problem',
          text: (errors[i].path || '/') + ' — ' + errors[i].message,
        }));
      }
      core.setHidden(problemBox, errors.length === 0);

      progress.textContent = missing.length
        ? decisionsNeeding(missing.length) + ' before this can be merged. ' +
          'What is left is conflicts and deletions, and neither kind has a safe default.'
        : 'Ready to merge: ' + describeResolution(thePlan, res) + '.';

      var confirmButton = findAction(root, 'confirm');
      if (confirmButton) {
        if (missing.length) confirmButton.setAttribute('disabled', '');
        else confirmButton.removeAttribute('disabled');
        core.setAttr(confirmButton, 'title', missing.length
          ? 'Answer the decisions with no suggestion first'
          : 'Write a merge commit with both heads as parents');
      }
      return { missing: missing, applied: applied, counts: c, shown: shownGroups };
    }

    function takeSide(groupKey, side) {
      var node = null;
      for (var i = 0; i < groupNodes.length; i++) if (groupNodes[i].group.key === groupKey) node = groupNodes[i];
      if (!node) return;
      for (var j = 0; j < node.group.decisions.length; j++) {
        var decision = node.group.decisions[j];
        for (var k = 0; k < rows.length; k++) {
          if (rows[k].decision !== decision) continue;
          var opt = bestOptionFor(decision, side);
          if (opt) rows[k].set(opt.value);
        }
      }
      refresh();
    }

    core.on(root, 'change', refresh);
    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node) return;
      var action = node.getAttribute('data-action');

      if (action === 'take-side') {
        takeSide(node.getAttribute('data-group'), node.getAttribute('data-value'));
        return;
      }
      if (action === 'accept-suggestions') {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].decision && rows[i].decision.suggestion) rows[i].set(rows[i].decision.suggestion);
        }
        refresh();
        return;
      }
      if (action === 'clear-choices') {
        for (var j = 0; j < rows.length; j++) if (rows[j].decision) rows[j].set(null);
        refresh();
        return;
      }
      if (action === 'confirm') {
        var res = resolution();
        if (missingDecisions(thePlan, res).length) return;
        event.preventDefault();
        var applied = appliedNow(res);
        if (opts.onConfirm) {
          opts.onConfirm(applied.model, {
            plan: thePlan,
            resolution: res,
            applied: applied,
            counts: choiceCounts(thePlan, res),
          });
        }
      }
      if (action === 'cancel' && opts.onCancel) opts.onCancel();
    });

    refresh();

    return {
      element: root,
      plan: thePlan,
      resolution: resolution,
      refresh: refresh,
      applied: function () { return appliedNow(resolution()); },
      missing: function () { return missingDecisions(thePlan, resolution()); },
      filter: function () { return filter; },
      rows: rows,
      switcher: switcher,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Confirm — the one place in this module that writes
  // ---------------------------------------------------------------------------------------------

  /**
   * The confirmation step: the resolution read back, the default message the user can edit, and — only
   * on confirm — `vcs.mergeCommit`, which records both heads as parents (REQ-VCS-011) and never
   * discards either (ADR-0003).
   */
  function mergeDialog(options) {
    var opts = options || {};
    var thePlan = opts.plan;
    var res = opts.resolution || Object.create(null);
    var applied = opts.applied || apply(thePlan, res);
    var history = opts.history || thePlan.history;
    var author = opts.author || { name: '', email: '' };
    var errors = errorProblems(applied);

    var message = widgets.field({
      label: 'Merge message',
      kind: 'textarea',
      rows: 3,
      required: true,
      placeholder: 'What the resolution was',
      action: 'merge-message',
      hint: 'Required. It is part of the commit id, so it cannot be changed afterwards.',
      value: mergeMessage(thePlan, res),
    });

    var body = [
      core.el('div', { class: 'tmv-dialog__group' }, [
        core.el('p', { class: 'tmv-dialog__lead', text: 'Parents' }),
        core.el('p', {
          class: 'tmv-dialog__value',
          text: thePlan.a.name + ' (' + thePlan.a.short + ') and ' + thePlan.b.name + ' (' + thePlan.b.short + ')',
        }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'Both are recorded as parents of the new commit, and neither is discarded. Whichever side you ' +
            'did not choose stays in the history and can be inspected afterwards.',
        }),
      ]),
      core.el('div', { class: 'tmv-dialog__group' }, [
        core.el('p', { class: 'tmv-dialog__lead', text: 'Resolution' }),
        core.el('p', { class: 'tmv-dialog__value', text: describeResolution(thePlan, res) }),
      ]),
      message.element,
    ];

    var ack = null;
    if (errors.length) {
      ack = forms.checkboxGroup({
        id: 'tmv-merge-ack',
        options: [{
          value: 'ack',
          label: 'I have read the ' + core.plural(errors.length, 'problem') + ' above and want to merge anyway',
          checked: false,
        }],
      });
      var list = core.el('ul', { class: 'tmv-compare__problems' });
      for (var i = 0; i < errors.length; i++) {
        list.appendChild(core.el('li', {
          class: 'tmv-compare__problem',
          text: (errors[i].path || '/') + ' — ' + errors[i].message,
        }));
      }
      body.push(core.el('div', { class: 'cds--inline-notification cds--inline-notification--warning tmv-dialog__group' }, [
        core.el('p', {
          class: 'tmv-dialog__lead',
          text: 'The merged model has ' + core.plural(errors.length, 'problem'),
        }),
        list,
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'These come from the choices made above, not from the merge itself. A model with errors cannot ' +
            'be exported, so it is worth resolving them here rather than after the commit.',
        }),
        ack.element,
      ]));
    }

    var instance = widgets.modal({
      title: 'Confirm merge',
      size: 'sm',
      body: body,
      actions: [
        { label: 'Back', kind: 'tertiary', action: 'cancel' },
        {
          label: 'Merge',
          kind: 'primary',
          action: 'merge',
          name: 'confirm',
          disabled: errors.length > 0,
          title: errors.length ? 'The merged model has unresolved problems' : 'Write the merge commit',
        },
      ],
      initialFocus: 'first',
      onClose: function (reason) {
        if (opts.onClose) opts.onClose(reason);
      },
    });

    function sync() {
      var button = findAction(instance.element, 'merge');
      if (!button) return;
      var ready = message.value().trim() !== '' && (!ack || ack.read().length > 0);
      if (ready) button.removeAttribute('disabled');
      else button.setAttribute('disabled', '');
    }

    message.on('input', sync);
    if (ack) core.on(ack.element, 'change', sync);
    sync();

    forms.modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action !== 'merge') return;

      var text = message.value().trim();
      if (text === '') {
        message.setError('A merge commit needs a message.');
        return;
      }
      if (ack && ack.read().length === 0) return;

      instance.setBusy(true);
      var commit = null;
      try {
        commit = vcs.mergeCommit(history, applied.model, [thePlan.a.id, thePlan.b.id], author, text, opts.commitOptions);
      } catch (err) {
        instance.setBusy(false);
        message.setError(err && err.message ? err.message : 'The merge commit could not be written.');
        return;
      }
      instance.setBusy(false);
      instance.close('merged');
      if (opts.onMerged) opts.onMerged(commit, applied);
    });

    if (opts.open !== false) instance.open();
    return {
      element: instance.element,
      open: instance.open,
      close: instance.close,
      message: message,
      applied: applied,
      instance: instance,
    };
  }

  TMV.compare = {
    SIDE_BASE: SIDE_BASE,
    SIDE_A: SIDE_A,
    SIDE_B: SIDE_B,
    KEEP: KEEP,
    OMIT: OMIT,
    COMBINED: COMBINED,
    FILTER_NEEDS: FILTER_NEEDS,
    FILTER_ALL: FILTER_ALL,
    PRESENCE_SLOT: PRESENCE_SLOT,
    STATUS: STATUS,
    GROUPED_FIELDS: GROUPED_FIELDS,
    DERIVED_INPUTS: DERIVED_INPUTS,
    MODEL_LABELS: MODEL_LABELS,

    /**
     * Everything a unit test can reach without a document (`09-testing.md` §2). The classification, the
     * suggestion rule and the application of a resolution are all decidable here, and the screen is
     * checked structurally against them.
     */
    logic: {
      declaredSpec: declaredSpec,
      slotLabel: slotLabel,
      slotListFor: slotListFor,
      slotValue: slotValue,
      combinedValue: combinedValue,
      keyUnion: keyUnion,
      describeSlot: describeSlot,
      describeLayout: describeLayout,
      entityStatus: entityStatus,
      entityIdsOf: entityIdsOf,
      modelSlotKeys: modelSlotKeys,
      orderedIds: orderedIds,
      optionFor: optionFor,
      bestOptionFor: bestOptionFor,
      errorProblems: errorProblems,
      sideName: sideName,
      sideTitle: sideTitle,
    },

    plan: plan,
    defaultResolution: defaultResolution,
    missingDecisions: missingDecisions,
    choiceCounts: choiceCounts,
    describeResolution: describeResolution,
    mergeMessage: mergeMessage,
    summaryLine: summaryLine,
    apply: apply,
    danglingTargets: danglingTargets,

    screen: screen,
    refusalBlock: refusalBlock,
    mergeDialog: mergeDialog,
  };
})(globalThis.TMV = globalThis.TMV || {});
