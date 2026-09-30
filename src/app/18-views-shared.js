/**
 * The view kit — the parts every tab renders through.
 * Requirements: REQ-VIEW-001..009, REQ-EDIT-001..010.
 *
 * Nine tabs each want the same screen: a title, a search box, some filters, a table that sorts and
 * pages and selects, an expanded row that shows every field an entity has, a warning where a
 * reference does not resolve, and edit affordances that vanish when the model is read-only. Written
 * nine times that is nine slightly different answers to "what does a missing reference look like",
 * and `07-ui.md` §9 lists unresolved references as one of the cross-cutting states — cross-cutting
 * means one home.
 *
 * So this module is the one home, and the tab modules are declarative: a type, a column list, a
 * couple of filter predicates, and the sentences for its empty states. Nothing here knows what a
 * threat is.
 *
 * Five decisions are worth stating, because each of them could reasonably have gone the other way.
 *
 * 1. **A detail view is an expanded row, not a separate screen.** `07-ui.md` §6 lists "Entity
 *    detail" as its own screen, and it is one — a `cds--structured-list` of every populated field —
 *    but it is reached by expanding the row rather than by navigating away from the list. The list
 *    stays on screen behind it, so the user keeps the context they were reading in, and
 *    `dataTable`'s expandable-row support already implements the disclosure. The composition §6
 *    describes is exactly what `detailView` builds; only the route differs, and there was no route
 *    to have (there is no URL routing — `07-ui.md` §10).
 *
 * 2. **Search and every filter compose, and all of them live in one predicate.** REQ-VIEW-002 AC2
 *    says filters compose with search "rather than replacing it". The way that requirement gets
 *    broken in practice is by having search call `setRows(filtered)` and each filter call
 *    `setRows(searched)` — two states fighting over one table. Here there is one `apply()` that
 *    reads both and always rewrites the whole row list from the model, so there is no order in which
 *    applying them produces a different answer.
 *
 * 3. **A filter chip that matches nothing still shows `0`.** `07-ui.md` §3: filters are findings,
 *    not sections, and an empty filter showing nothing at all reads as broken. The same rule governs
 *    the section's own empty state, which says which filter is responsible and offers to clear it —
 *    §9 distinguishes "no threats matching *unencrypted*" from "this model has no threats".
 *
 * 4. **Passthrough values are shown, and attributed.** REQ-VIEW-003 AC1: a field that exists only in
 *    a passthrough bag is displayed and attributed to its source format. The bags are the whole
 *    reason an import is non-destructive (`03-data-model.md` §1, ADR-0004), so a detail view that
 *    showed only interpreted fields would hide exactly the data the design went out of its way to
 *    keep. They are rendered under their format's name, never merged into the interpreted fields,
 *    because a value the application does not interpret deserves to look different from one it does.
 *
 * 5. **View state is kept outside the render, keyed by section.** The shell re-renders the active
 *    view on every edit, and a search box that emptied itself on every keystroke's commit would make
 *    the search box useless in the one workflow it exists for — find a thing, fix it, keep looking.
 *    So the search text, the filter values, the page size and the expanded row live in `listState`,
 *    which survives the re-render. Only the row *selection* is dropped, and that is deliberate: a
 *    selection is an intention to act, and carrying it across a render would leave a bulk action
 *    pointed at rows the user can no longer see (`12-widgets.js` drops the same state for the same
 *    reason).
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var M = TMV.model;

  // ---------------------------------------------------------------------------------------------
  // 1. Labels
  // ---------------------------------------------------------------------------------------------

  /**
   * Values that are spelled in capitals and would be mangled by title-casing.
   *
   * `VOCAB.dataSensitivity` is `pii phi fin ip cred biz gov pci op` — an abbreviation list, not a
   * word list — and `humanise('pii')` producing "Pii" is the kind of small wrongness that makes a
   * security screen look untrustworthy. The map is keyed on the whole token, never as a substring
   * replacement, so `ip` does not reach into `pip`.
   */
  var ACRONYMS = {
    pii: 'PII', phi: 'PHI', pci: 'PCI', ip: 'IP', sql: 'SQL', sso: 'SSO', otp: 'OTP', mac: 'MAC',
    dac: 'DAC', acl: 'ACL', rbac: 'RBAC', abac: 'ABAC', ttls: 'TTLs', ttl: 'TTL', otm: 'OTM',
    tml: 'TML', cwe: 'CWE', cwes: 'CWEs', capec: 'CAPEC', uri: 'URI', url: 'URL', id: 'ID',
    ids: 'IDs', uuid: 'UUID', tmv: 'TMV', api: 'API', http: 'HTTP', https: 'HTTPS',
  };

  /** `mission_critical` → `Mission critical`, `very_low` → `Very low`, `pii` → `PII`. */
  function humanise(value) {
    if (value === null || value === undefined) return '';
    if (core.isBoolean(value)) return value ? 'Yes' : 'No';
    var text = String(value);
    if (text === '') return '';
    var tokens = text.split('_');
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (token === '') continue;
      if (ACRONYMS[token.toLowerCase()]) out.push(ACRONYMS[token.toLowerCase()]);
      else out.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
    if (!out.length) return text;
    // Only the first word is capitalised: "Mission critical", not "Mission Critical". These are
    // sentences read aloud by a screen reader, and title case reads as shouting.
    out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
    return out.join(' ');
  }

  /** A vocabulary value with its name, for `title` attributes and accessible names. */
  function vocabLabel(vocabName, value) {
    if (value === null || value === undefined || value === '') return '';
    var vocab = M.VOCAB[vocabName];
    var known = vocab && vocab.indexOf(value) !== -1;
    return humanise(value) + (known ? '' : ' (outside the canonical vocabulary)');
  }

  /**
   * Where a vocabulary value sits in its own list, for sorting a column of enum values.
   *
   * `REQ-VIEW-002` asks that a sortable column sort by what it shows, and for a vocabulary column
   * what it shows is an ordering the vocabulary already states: `low` below `critical`, `unlikely`
   * below `certain`. Sorting the strings instead would put `critical` under `c` and `very_low` under
   * `v` — an order that is stable, reproducible, and means nothing to the person reading it.
   *
   * `null` for a value the vocabulary does not carry, so `sortRows` treats it as absent and parks it
   * at the end of either direction rather than assigning it a rank it was never given.
   */
  function vocabRank(vocabName, value) {
    if (!core.isString(value) || value === '') return null;
    var vocab = M.VOCAB[vocabName];
    if (!core.isArray(vocab)) return null;
    var at = vocab.indexOf(value);
    return at === -1 ? null : at;
  }

  /** A list rendered for a table cell or a detail row: comma-joined, capped, never silently cut. */
  function listText(values) {
    if (!core.isArray(values) || !values.length) return '';
    var out = [];
    for (var i = 0; i < values.length && i < 4; i++) out.push(String(values[i]));
    var text = out.join(', ');
    if (values.length > out.length) text += ' and ' + (values.length - out.length) + ' more';
    return text;
  }

  /** A boolean or number as text, with `null` becoming empty rather than "null". */
  function scalarText(value) {
    if (value === null || value === undefined || value === '') return '';
    if (core.isBoolean(value)) return value ? 'Yes' : 'No';
    return String(value);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. References, and the ones that do not resolve
  // ---------------------------------------------------------------------------------------------

  /**
   * Every reference a type declares, flattened, including the ones nested one level down.
   *
   * The nesting is not optional. `dataSets.placements[].dataStoreId`, `controls.trustBoundary.zoneAId`
   * and `threatApplications.controlStates[].controlId` are all references, and a checker that only
   * looked at top-level fields would report a model as fully resolved while three of its five
   * relationship kinds pointed at nothing.
   *
   * Returns `[{field, label, container, kind}]`, where `container` is the field key the reference
   * lives inside (`null` for a top-level reference, `'placements'` for one inside a list).
   */
  function referenceFields(typeSpec) {
    var out = [];
    if (!typeSpec) return out;
    for (var i = 0; i < typeSpec.fields.length; i++) {
      var field = typeSpec.fields[i];
      if (field.kind === 'ref' || field.kind === 'refList') {
        out.push({ field: field, label: field.label, container: null, kind: field.kind });
        continue;
      }
      var inner = field.itemFields || null;
      if (!inner) continue;
      for (var j = 0; j < inner.length; j++) {
        if (inner[j].kind !== 'ref' && inner[j].kind !== 'refList') continue;
        out.push({ field: inner[j], label: field.label + ' · ' + inner[j].label, container: field.key, kind: inner[j].kind });
      }
    }
    return out;
  }

  /** The ids a reference field holds on one entity, as a flat list. */
  function referenceValues(entity, ref) {
    if (!core.isObject(entity)) return [];
    var source = ref.container ? entity[ref.container] : entity;
    if (ref.container && core.isArray(source)) {
      // An `objectList` container: gather from every item. A plain `object` container is not an
      // array and falls through to the single-value branch below.
      var many = [];
      for (var i = 0; i < source.length; i++) {
        var v = source[i] && source[i][ref.field.key];
        if (ref.kind === 'refList' && core.isArray(v)) many = many.concat(v);
        else if (core.isString(v)) many.push(v);
      }
      return many;
    }
    if (!core.isObject(source)) return [];
    var value = source[ref.field.key];
    if (ref.kind === 'refList') return core.isArray(value) ? value.slice() : [];
    return core.isString(value) ? [value] : [];
  }

  /**
   * The references on an entity that point at nothing (REQ-VIEW-007).
   *
   * Returns `[{label, id, text}]`, where `text` is the explanation §9 asks for — it names the
   * missing target, not just the fact that something is missing. A dangling reference is normal
   * after an import (`10-import.js` treats it as a warning rather than an error precisely so the
   * document can be brought in and repaired), so this is a finding to surface, not a failure state.
   */
  function unresolvedOf(ctx, typeKey, entity) {
    var out = [];
    var typeSpec = M.typeFor(typeKey);
    var refs = referenceFields(typeSpec);
    for (var i = 0; i < refs.length; i++) {
      var ids = referenceValues(entity, refs[i]);
      for (var j = 0; j < ids.length; j++) {
        if (M.findAnywhere(ctx.model, ids[j])) continue;
        out.push({
          label: refs[i].label,
          id: ids[j],
          text: refs[i].label + ' points at “' + ids[j] + '”, which is not in this model.',
        });
      }
    }
    return out;
  }

  /** A one-line warning for a list cell: the count, or nothing when everything resolves. */
  function unresolvedTag(ctx, typeKey, entity) {
    var missing = unresolvedOf(ctx, typeKey, entity);
    if (!missing.length) return null;
    return tag({
      text: missing.length === 1 ? 'Unresolved reference' : missing.length + ' unresolved references',
      type: 'red',
      title: missing[0].text + (missing.length > 1 ? ' And ' + (missing.length - 1) + ' more.' : ''),
    });
  }

  /** How an entity is named in a list, a detail heading, or a reference row. */
  function labelOf(entity) {
    return M.labelOf(entity);
  }

  /** A reference rendered as text: the target's label, or the raw id when it does not resolve. */
  function refText(ctx, id) {
    if (!core.isString(id) || id === '') return '';
    var found = M.findAnywhere(ctx.model, id);
    return found ? labelOf(found.entity) : id;
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Tags
  // ---------------------------------------------------------------------------------------------

  /**
   * A Carbon tag. `type` is one of Carbon's colour names, and it is decoration only: REQ-UI-007 AC4
   * says colour is never the sole carrier of meaning, so every caller passes text that already says
   * what the colour suggests, and `title` carries the expanded form for the ones that need it.
   */
  function tag(opts) {
    return widgets.tag({ text: opts.text, type: opts.type || null, title: opts.title || null });
  }

  /**
   * The six risk levels as Carbon tag colours. `07-ui.md` §5 says the tag colour set maps cleanly
   * onto the six levels and that the whole matrix is built from tokens rather than a chart library.
   */
  /**
   * A risk's score and level, what its own inputs compute to, and whether the two agree.
   *
   * `03-data-model.md` §4.12 keeps `score` and `level` as *stored* fields, and says the editor
   * "recomputes and flags a mismatch rather than overwriting" it, because the banding is this
   * application's interpretation and the model's own number is its author's assessment. So there are
   * up to four values and the view has to keep them apart:
   *
   * - `score`/`level` — what to display: the stored value when the model states one, otherwise what
   *   the inputs compute to. A TML risk carries `likelihood` and `impact` and may carry no score at
   *   all, and a table showing only stored values would show nothing for a model that holds
   *   everything needed to compute them.
   * - `computedScore`/`computedLevel` — what the inputs compute to, always, and `null` when the risk
   *   does not state both enums.
   * - `derived` — true when at least one of the displayed values is this application's, so the UI can
   *   say which it is showing.
   * - `mismatch` — true when the model states a value that disagrees with its own inputs. This is
   *   reported and never corrected.
   *
   * The derivation lives in `M.riskScore`/`M.riskLevel` and nowhere else, so a change to the banding
   * is still a one-line change.
   */
  function riskOf(risk) {
    var out = {
      score: null, level: null, computedScore: null, computedLevel: null,
      stated: false, derived: false, mismatch: false,
    };
    if (!risk) return out;
    out.computedScore = M.riskScore(risk.likelihood, risk.impact);
    out.computedLevel = M.riskLevel(out.computedScore);
    var storedScore = core.isNumber(risk.score);
    var storedLevel = core.isString(risk.level) && risk.level !== '';
    out.stated = storedScore || storedLevel;
    out.score = storedScore ? risk.score : out.computedScore;
    out.level = storedLevel ? risk.level : out.computedLevel;
    out.derived = !storedScore || !storedLevel;
    out.mismatch =
      (storedScore && core.isNumber(out.computedScore) && risk.score !== out.computedScore) ||
      (storedLevel && out.computedLevel !== null && risk.level !== out.computedLevel);
    return out;
  }

  var RISK_TAG = {
    very_low: 'green',
    low: 'teal',
    medium: 'gray',
    high: 'magenta',
    very_high: 'red',
    critical: 'red',
  };

  function riskTag(level) {
    if (!core.isString(level) || level === '') return null;
    return tag({ text: humanise(level), type: RISK_TAG[level] || 'gray', title: 'Risk level: ' + humanise(level) });
  }

  /** Threat and control states, coloured by whether the state needs attention. */
  var STATE_TAG = {
    // Threat states
    exposed: 'red',
    mitigated: 'green',
    accepted: 'gray',
    not_applicable: 'gray',
    // Control states
    required: 'red',
    implemented: 'green',
    planned: 'teal',
    retired: 'gray',
    wont_do: 'gray',
  };

  /**
   * `label` replaces the tag's text but not its colour, for a cell that shows a state beside the
   * thing it is the state *of* — "Parameterised queries: Planned". The colour map stays in one place
   * (REQ-UI-007 AC4: the text always says what the colour suggests, so the colour is decoration and
   * must not be the only thing carrying the vocabulary).
   */
  function stateTag(value, label) {
    if (!core.isString(value) || value === '') return null;
    return tag({
      text: label || humanise(value),
      type: STATE_TAG[value] || 'gray',
      title: 'State: ' + humanise(value),
    });
  }

  /** Control status (`VOCAB.controlStatus`), which is a different vocabulary from its state. */
  var STATUS_TAG = {
    assumed: 'gray',
    active: 'green',
    suggested: 'teal',
    under_review: 'purple',
    approved: 'green',
    scheduled: 'blue',
    retired: 'gray',
    wont_do: 'gray',
  };

  /** `label` overrides the tag's text but not its colour — see `stateTag`, which explains why. */
  function statusTag(value, label) {
    if (!core.isString(value) || value === '') return null;
    return tag({
      text: label || humanise(value),
      type: STATUS_TAG[value] || 'gray',
      title: 'Status: ' + humanise(value),
    });
  }

  var PRIORITY_TAG = { none: 'gray', low: 'gray', medium: 'blue', high: 'magenta', critical: 'red' };

  function priorityTag(value) {
    if (!core.isString(value) || value === '') return null;
    return tag({ text: humanise(value), type: PRIORITY_TAG[value] || 'gray', title: 'Priority: ' + humanise(value) });
  }

  /** The chip list a table cell shows for an enumList or stringList field. */
  function tagList(values, type) {
    var wrap = core.el('span', { class: 'tmv-tags' });
    if (!core.isArray(values) || !values.length) return wrap;
    for (var i = 0; i < values.length; i++) {
      wrap.appendChild(tag({ text: humanise(values[i]), type: type || null }));
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Detail: every populated field, and every passthrough value
  // ---------------------------------------------------------------------------------------------

  /**
   * One field's value, rendered.
   *
   * `ref` and `refList` fields render the target's name rather than its id, because an id is a
   * machine's handle for a thing and the user is reading about the thing. When the reference does
   * not resolve the id is shown *and* marked — the id is the only useful information left at that
   * point, since it is what a repair needs.
   */
  function fieldValue(ctx, typeKey, field, value) {
    if (value === null || value === undefined || value === '') return core.el('span', { class: 'tmv-muted', text: 'Not set' });
    if (field.kind === 'ref') {
      var resolved = M.findAnywhere(ctx.model, value);
      if (!resolved) return unresolvedValue(value);
      return core.el('span', { text: labelOf(resolved.entity) });
    }
    if (field.kind === 'refList') {
      var wrap = core.el('span', { class: 'tmv-ref-list' });
      for (var i = 0; i < value.length; i++) {
        if (i) wrap.appendChild(core.text(', '));
        var target = M.findAnywhere(ctx.model, value[i]);
        if (target) wrap.appendChild(core.el('span', { text: labelOf(target.entity) }));
        else wrap.appendChild(unresolvedValue(value[i]));
      }
      return wrap;
    }
    if (field.kind === 'boolean') return core.el('span', { text: value ? 'Yes' : 'No' });
    if (field.kind === 'enum' || field.kind === 'state') {
      return core.el('span', { text: vocabLabel(field.vocab, value) });
    }
    if (field.kind === 'enumList') return tagList(core.isArray(value) ? value : [value]);
    if (field.kind === 'stringList') return core.el('span', { text: listText(value) });
    if (field.kind === 'uri') {
      var safe = core.safeUrl(value);
      // A URI the application will not treat as a link is still shown — as text. Refusing to show
      // it would lose information; making it clickable would be a link-injection path (REQ-SEC-003).
      if (!safe) return core.el('span', { text: String(value) });
      return core.el('a', { href: safe, rel: 'noreferrer noopener', target: '_blank', text: String(value) });
    }
    if (field.kind === 'object' || field.kind === 'objectList') return nestedValue(ctx, field, value);
    if (core.isObject(value) || core.isArray(value)) return codeValue(value);
    return core.el('span', { text: scalarText(value) });
  }

  function unresolvedValue(id) {
    return core.el('span', { class: 'tmv-unresolved' }, [
      core.el('span', { class: 'tmv-unresolved__mark', 'aria-hidden': 'true', text: '!' }),
      core.el('span', { class: 'tmv-unresolved__id', text: String(id) }),
      core.el('span', { class: 'cds--visually-hidden', text: ' — this reference does not resolve to anything in the model' }),
    ]);
  }

  /**
   * A structured value — `{zoneAId, zoneBId}`, or the item list of a `placements` field — rendered
   * as a small key/value list rather than as JSON.
   *
   * Keys the descriptor does not name are still shown, and labelled with their own key. They are the
   * nested passthrough that `05-model.js`'s `coerceObject` deliberately keeps, and a detail view
   * that dropped them would be hiding imported data at exactly the depth the lossiness ledger is
   * least able to see.
   */
  function nestedValue(ctx, field, value) {
    var items = field.kind === 'objectList' ? (core.isArray(value) ? value : []) : [value];
    var wrap = core.el('div', { class: 'tmv-nested' });
    if (!items.length) return core.el('span', { class: 'tmv-muted', text: 'None' });
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!core.isObject(item)) {
        wrap.appendChild(core.el('p', { class: 'tmv-nested__row', text: scalarText(item) }));
        continue;
      }
      var known = Object.create(null);
      var inner = field.itemFields || [];
      for (var j = 0; j < inner.length; j++) {
        known[inner[j].key] = true;
        if (item[inner[j].key] === undefined || item[inner[j].key] === null) continue;
        wrap.appendChild(nestedRow(inner[j].label, fieldValue(ctx, null, inner[j], item[inner[j].key])));
      }
      var keys = core.sortedKeys(item);
      for (var k = 0; k < keys.length; k++) {
        if (known[keys[k]] || keys[k] === 'x') continue;
        if (item[keys[k]] === undefined || item[keys[k]] === null) continue;
        wrap.appendChild(nestedRow(keys[k], fieldValue(ctx, null, { kind: 'string', key: keys[k] }, item[keys[k]])));
      }
    }
    return wrap;
  }

  function nestedRow(label, valueNode) {
    return core.el('p', { class: 'tmv-nested__row' }, [
      core.el('span', { class: 'tmv-nested__key', text: label + ': ' }),
      valueNode,
    ]);
  }

  /** Anything left that is shaped like data rather than text. Shown as JSON source, never executed. */
  function codeValue(value) {
    var text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch (err) {
      text = String(value);
    }
    return core.el('code', { class: 'tmv-code', text: text === undefined ? 'null' : text });
  }

  /** The format a passthrough bag came from, as the user should see it named. */
  var BAG_LABEL = {
    otm: 'OTM — Open Threat Model',
    tml: 'TML — Threat Model Language',
    tmv: 'This application',
  };

  /**
   * Every populated field of an entity, plus its passthrough values (REQ-VIEW-003).
   *
   * Populated only: §6's detail screen is a list of fields, and a form is where the unset ones
   * matter. `structuredList` is the right component for both the interpreted and the passthrough
   * rows, so they share a table and are separated by a heading — the passthrough values are
   * attributed in their own row labels *and* under their own heading, because the one thing the
   * heading could be missed under is a reader scrolling to the middle.
   */
  function detailRows(ctx, typeKey, entity) {
    var typeSpec = M.typeFor(typeKey);
    var rows = [];

    rows.push({ id: 'id', cells: [core.el('span', { class: 'tmv-detail__key', text: 'Id' }), core.el('code', { class: 'tmv-code', text: String(entity.id) })] });

    var fields = typeSpec ? typeSpec.fields : [];
    var populated = 0;
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var value = entity[field.key];
      if (value === undefined || value === null || value === '' || (core.isArray(value) && !value.length)) continue;
      populated++;
      var label = field.label;
      // A derived field is computed, not stored (`03-data-model.md` §4.12), and saying so is the
      // difference between "the file says this" and "the application worked this out".
      if (field.derived) label += ' (derived)';
      rows.push({ id: field.key, cells: [core.el('span', { class: 'tmv-detail__key', text: label }), fieldValue(ctx, typeKey, field, value)] });
    }

    var bags = core.isObject(entity.x) ? core.sortedKeys(entity.x) : [];
    for (var b = 0; b < bags.length; b++) {
      var bagKey = bags[b];
      var bag = entity.x[bagKey];
      if (!core.isObject(bag)) continue;
      var keys = core.sortedKeys(bag);
      if (!keys.length) continue;
      var label2 = (BAG_LABEL[bagKey] || bagKey) + ' — not interpreted by this application';
      for (var k = 0; k < keys.length; k++) {
        populated++;
        rows.push({
          id: bagKey + '.' + keys[k],
          cells: [
            core.el('span', { class: 'tmv-detail__key tmv-detail__key--bag', text: label2 + ' · ' + keys[k] }),
            fieldValue(ctx, typeKey, { kind: 'string', key: keys[k] }, bag[keys[k]]),
          ],
        });
      }
    }

    return { rows: rows, populated: populated, bags: bags.length };
  }

  /**
   * The expanded-row detail: name, unresolved references, every field, and the edit affordances.
   *
   * The actions are *absent* in read-only mode rather than disabled (REQ-VIEW-008), and the reason
   * is in `07-ui.md` §9: a disabled button invites the user to work out why it is disabled, and the
   * shell's banner has already said why.
   */
  function detailView(ctx, opts) {
    var typeSpec = M.typeFor(opts.type);
    var entity = opts.entity;
    var root = core.el('div', { class: 'tmv-detail' });

    var missing = unresolvedOf(ctx, opts.type, entity);
    if (missing.length) {
      var warning = core.el('div', { class: 'cds--inline-notification cds--inline-notification--warning', role: 'status' }, [
        core.el('div', { class: 'cds--inline-notification__details' }, [
          core.el('h3', { class: 'cds--inline-notification__title', text: 'This entity has references that do not resolve' }),
          core.el('div', { class: 'cds--inline-notification__subtitle' }, [
            core.el('ul', { class: 'tmv-dialog__list' }, missing.map(function (m) {
              return core.el('li', { text: m.text });
            })),
          ]),
        ]),
      ]);
      root.appendChild(warning);
    }

    var detail = detailRows(ctx, opts.type, entity);
    var list = widgets.structuredList({
      label: typeSpec ? typeSpec.label + ' fields' : 'Fields',
      rows: detail.rows,
    });

    if (opts.actions !== false && ctx.editable) {
      var actions = core.el('div', { class: 'tmv-detail__actions' }, [
        widgets.button({
          label: 'Edit ' + (typeSpec ? typeSpec.label.toLowerCase() : 'entity'),
          kind: 'tertiary',
          action: 'edit-entity',
          name: opts.type,
          value: entity.id,
        }),
        widgets.button({
          label: 'Delete',
          kind: 'danger--tertiary',
          action: 'delete-entity',
          name: opts.type,
          value: entity.id,
        }),
      ]);
      root.appendChild(actions);
    }

    root.appendChild(list);
    if (opts.related) root.appendChild(opts.related);

    if (opts.referrers !== false) {
      var used = referrersPanel(ctx, entity.id);
      if (used) root.appendChild(used);
    }
    return root;
  }

  /**
   * "Used by" — everything that points at this entity (`M.referrersOf`).
   *
   * Without it, deleting an entity looks like deleting one row; with it, the user can see the flows
   * that will be orphaned before they are asked about them (REQ-EDIT-003 AC1, REQ-EDIT-004 AC1).
   */
  function referrersPanel(ctx, id) {
    var list = M.referrersOf(ctx.model, id);
    if (!list.length) return null;
    var items = [];
    for (var i = 0; i < list.length && i < 20; i++) {
      items.push(core.el('li', { text: list[i].typeSpec.label + ' “' + labelOf(list[i].entity) + '” (' + list[i].field.label + ')' }));
    }
    if (list.length > 20) items.push(core.el('li', { text: 'and ' + (list.length - 20) + ' more' }));
    return core.el('section', { class: 'tmv-detail__related' }, [
      core.el('h4', { class: 'tmv-detail__related-title', text: 'Used by ' + core.plural(list.length, 'entity', 'entities') }),
      core.el('ul', { class: 'tmv-dialog__list' }, items),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. List sections — the workhorse
  // ---------------------------------------------------------------------------------------------

  /**
   * Per-section interaction state, kept across re-renders (decision 5 in the module header).
   *
   * Keyed by a caller-supplied key rather than by section id, because two sections of the same tab
   * can both list entities — Threats' *All Threats* and *Unresolved References* — and sharing a
   * search box between them would mean typing in one silently filtered the other.
   */
  var listState = Object.create(null);

  function stateFor(key) {
    if (!listState[key]) {
      listState[key] = { search: '', filters: Object.create(null), page: 1, pageSize: 25, openId: null };
    }
    return listState[key];
  }

  /** The kit's own state, for tests and for the one case that legitimately resets it. */
  function resetState(key) {
    if (key === undefined) listState = Object.create(null);
    else delete listState[key];
  }

  /** Does a row match the free-text search? Substring, case-insensitive, over the caller's haystack. */
  function matches(row, text) {
    if (text === '') return true;
    var hay = row.__search;
    if (!core.isString(hay)) hay = '';
    return hay.toLowerCase().indexOf(text.toLowerCase()) !== -1;
  }

  /** Is a row selected by the current filter values? Every filter is a predicate over the row. */
  /**
   * A row's identity.
   *
   * Most rows are one entity, and the entity's id is the identity. A row that is a *join* is not:
   * a placement is a data set in a data store, so one data set in three stores is three rows, and
   * keying those by the data set's id would make expanding one expand all three and selecting one
   * select all three. A caller building such a row gives it a `__key`, and this is the only place
   * that has to know the difference.
   */
  function rowKeyOf(row, fallback) {
    if (core.isString(row.__key)) return row.__key;
    if (row.entity && core.isString(row.entity.id)) return row.entity.id;
    return fallback;
  }

  function passes(row, filters, specs) {
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var value = filters[spec.id];
      if (value === undefined || value === null || value === '') continue;
      if (!spec.test(row, value)) return false;
    }
    return true;
  }

  /**
   * The list screen.
   *
   * `opts` is the whole contract a tab needs:
   *   key          stable id for the persisted view state
   *   type         entity key, or null for a section that is not one entity type's list
   *   entityRows   `[{entity, ...}]` — extras travel with the entity and are what the columns read
   *   columns      `dataTable` columns; `key` is the column's identity for sorting
   *   searchText   `(row) => string` — what free-text search looks at. Omit to disable the box
   *   filters      `[{id, label, options, test(row, value)}]`
   *   empty        `{title, body}` for "this model has none"
   *   filteredEmpty `{title, body}` for "none match"; defaults to a sentence naming the cause
   *   addLabel     the label for the create button. Omit to have no create affordance
   *   detail       `(ctx, row) => node` for the expanded row
   *   bulk         `{update: true, delete: true}` — which batch actions to offer
   *   summary      a node rendered above the table
   *   intro        a sentence rendered below the section title
   */
  function listView(ctx, opts) {
    var state = stateFor(opts.key);
    var specs = opts.filters || [];

    // -- state that outlives a render -----------------------------------------------------------

    var selected = [];
    var searchBox = null;
    var filterFields = [];
    var table = null;
    var pager = null;

    var root = core.el('div', { class: 'tmv-list', 'data-key': opts.key });
    var countLine = core.el('p', { class: 'tmv-list__count', role: 'status' });
    var detailHost = core.el('div', { class: 'tmv-detail-host', hidden: true });
    var page = { page: state.page, pageSize: state.pageSize };
    var rows = [];

    if (opts.intro) root.appendChild(core.el('p', { class: 'tmv-intro', text: opts.intro }));
    if (opts.summary) root.appendChild(opts.summary);

    /**
     * The open detail is looked up on every render, and an id that has since been deleted closes it
     * rather than rendering a detail for something that is not there.
     */
    function openRow() {
      if (!core.isString(state.openId)) return null;
      for (var i = 0; i < opts.entityRows.length; i++) {
        if (rowKeyOf(opts.entityRows[i], '') === state.openId) return opts.entityRows[i];
      }
      state.openId = null;
      return null;
    }

    function activeFilterCount() {
      var n = 0;
      for (var i = 0; i < specs.length; i++) {
        var v = state.filters[specs[i].id];
        if (v !== undefined && v !== null && v !== '') n++;
      }
      return n;
    }

    function visibleRows() {
      var out = [];
      for (var i = 0; i < opts.entityRows.length; i++) {
        var row = opts.entityRows[i];
        if (opts.searchText && !matches(row, state.search)) continue;
        if (!passes(row, state.filters, specs)) continue;
        out.push(row);
      }
      return out;
    }

    function clearFilters() {
      state.search = '';
      state.filters = Object.create(null);
      state.page = 1;
      if (searchBox) searchBox.setValue('');
      for (var i = 0; i < filterFields.length; i++) filterFields[i].setValue('');
    }

    function resetPage() {
      state.page = 1;
      page.page = 1;
    }

    // -- the toolbar ----------------------------------------------------------------------------

    var toolbar = [];

    if (opts.searchText) {
      searchBox = widgets.search({
        label: 'Search ' + (opts.plural || 'rows'),
        placeholder: opts.searchPlaceholder || ('Search ' + (opts.plural || 'rows')),
        delay: 150,
        onChange: function (value) {
          state.search = value;
          resetPage();
          apply();
        },
      });
      searchBox.setValue(state.search);
      toolbar.push(searchBox.element);
    }

    for (var f = 0; f < specs.length; f++) {
      var spec = specs[f];
      var control = widgets.field({
        kind: 'select',
        label: spec.label,
        id: 'tmv-filter-' + opts.key + '-' + spec.id,
        placeholder: spec.placeholder || ('Any ' + spec.label.toLowerCase()),
        options: spec.options,
        value: state.filters[spec.id] || '',
      });
      control.element.setAttribute('data-filter', spec.id);
      // A closure per iteration, so each control's handler reads its own spec rather than whichever
      // one the loop happened to finish on.
      onFilterChange(control, spec);
      filterFields.push(control);
      toolbar.push(control.element);
    }

    if (opts.addLabel !== undefined && ctx.editable) {
      toolbar.push(widgets.button({
        label: opts.addLabel || 'Add',
        kind: 'primary',
        action: 'add-entity',
        name: opts.type,
      }));
    }
    if (opts.searchText || specs.length) {
      toolbar.push(widgets.button({ label: 'Clear filters', kind: 'ghost', action: 'clear-filters' }));
    }

    function onFilterChange(control, spec) {
      control.on('change', function () {
        var value = control.value();
        if (value === '') delete state.filters[spec.id];
        else state.filters[spec.id] = value;
        resetPage();
        apply();
      });
    }

    // -- the table ------------------------------------------------------------------------------

    /**
     * REQ-EDIT-008. Multi-select with bulk delete and bulk field update is a property of *entity*
     * lists, so it is the default for any list that names a type rather than something each of the
     * twenty-six call sites has to remember to ask for. Forgetting it is invisible — the table simply
     * renders without a checkbox column and nothing anywhere says why — which is exactly the kind of
     * gap a default fixes and a convention does not.
     *
     * A list whose rows are not entities opts out by not naming a type: the Unresolved References
     * finding is a list of dangling *references*, not of things, so there is nothing to bulk-edit or
     * delete and `bulkDelete` would be handed ids that name no entity at all. `opts.bulk` is still
     * honoured for a caller that wants one of the two actions rather than both.
     */
    var bulk = opts.bulk || (opts.type ? { update: true, delete: true } : {});

    function bulkEnabled() {
      return ctx.editable === true && (bulk.delete === true || bulk.update === true);
    }

    function batchActions() {
      var out = [];
      if (bulk.update) out.push({ label: 'Update field', kind: 'ghost', action: 'bulk-update', name: opts.type });
      if (bulk.delete) out.push({ label: 'Delete', kind: 'danger--ghost', action: 'bulk-delete', name: opts.type });
      return out;
    }

    /**
     * Give every sortable column a comparator that knows what a `listView` row is.
     *
     * `dataTable`'s default comparator reads `row[column.key]`, and a `listView` row is
     * `{entity, ...extras}` rather than the entity itself. For a column whose key names an entity
     * field — `name` on almost every list — that default reads `undefined` for every row, and
     * `sortRows` treats `undefined` as "absent": the header toggles its `aria-sort` and the rows
     * never move, which is REQ-VIEW-002's sorting failing while looking like it worked. The derived
     * keys a caller sets on the row win when they are present; otherwise the column reads through to
     * the entity it stands for.
     */
    function sortableColumns(columns) {
      var out = [];
      for (var i = 0; i < columns.length; i++) {
        var column = columns[i];
        if (!column.sortable || column.sortValue) {
          out.push(column);
          continue;
        }
        var copy = {};
        var keys = Object.keys(column);
        for (var k = 0; k < keys.length; k++) copy[keys[k]] = column[keys[k]];
        copy.sortValue = columnSortValue(column.key);
        out.push(copy);
      }
      return out;
    }

    function columnSortValue(key) {
      return function (row) {
        if (core.has(row, key)) return row[key];
        return core.isObject(row.entity) ? row.entity[key] : undefined;
      };
    }

    table = widgets.dataTable({
      caption: opts.plural ? 'Table of ' + opts.plural : null,
      columns: sortableColumns(opts.columns || []),
      rows: rows,
      toolbar: toolbar,
      stickyHeader: opts.stickyHeader !== false,
      selectable: bulkEnabled(),
      batchActions: batchActions(),
      expandable: typeof opts.detail === 'function',
      expand: function (row) { return opts.detail(ctx, row); },
      rowKey: function (row) {
        return rowKeyOf(row, String(rows.indexOf(row)));
      },
      page: page,
      empty: opts.empty || { title: 'Nothing here yet' },
      onSelectionChange: function (ids) { selected = ids; },
    });

    pager = widgets.pagination({
      total: 0,
      page: state.page,
      pageSize: state.pageSize,
      pageSizes: opts.pageSizes || [10, 25, 50, 100],
      onChange: function (next) {
        state.page = next.page;
        state.pageSize = next.pageSize;
        page.page = next.page;
        page.pageSize = next.pageSize;
        apply();
      },
    });

    /**
     * The filter-result empty state, which §9 says must be distinct from the empty-model one. It
     * names the cause and offers the fix, because "no rows" and "no rows *matching*" are different
     * facts and only one of them means the model is empty.
     */
    var emptyNote = core.el('div', { class: 'tmv-empty tmv-empty--filtered', hidden: true }, [
      core.el('h3', {
        class: 'tmv-empty__title',
        text: (opts.filteredEmpty && opts.filteredEmpty.title) || 'Nothing matches this filter',
      }),
      core.el('p', {
        class: 'tmv-empty__body',
        text: (opts.filteredEmpty && opts.filteredEmpty.body) ||
          'This model has rows of this kind; none of them match what is selected. Clearing the filters brings them back.',
      }),
      widgets.button({ label: 'Clear filters', kind: 'tertiary', action: 'clear-filters' }),
    ]);

    // -- one render path ------------------------------------------------------------------------

    /**
     * Rewrite the table from the model. Every interaction calls this and only this (decision 2 in
     * the module header), so search, filters and paging cannot disagree about what is showing.
     */
    function apply() {
      var matching = visibleRows();
      rows.length = 0;
      for (var i = 0; i < matching.length; i++) rows.push(matching[i]);
      table.setRows(rows);
      pager.set(state.page, matching.length, state.pageSize);
      // The widget clamps a page number that filtering has pushed past the end; reading the clamped
      // value back keeps the stored page in step with the one actually showing.
      state.page = pager.window().page;
      page.page = state.page;
      countLine.textContent = countText(matching.length);
      root.setAttribute('data-visible', String(matching.length));
      root.setAttribute('data-total', String(opts.entityRows.length));
      core.setHidden(emptyNote, matching.length > 0 || opts.entityRows.length === 0);
    }

    function countText(n) {
      var total = opts.entityRows.length;
      var noun = opts.singular || 'row';
      if (total === 0) return opts.emptyCountText || 'Nothing in this model yet.';
      if (n === total) return core.plural(total, noun) + ' in this model.';
      return n + ' of ' + core.plural(total, noun) + ' shown.';
    }

    // -- the detail host ------------------------------------------------------------------------

    function renderDetail() {
      core.clear(detailHost);
      var row = openRow();
      core.setHidden(detailHost, !row);
      if (!row) return;
      detailHost.appendChild(opts.detail(ctx, row));
      detailHost.appendChild(widgets.button({ label: 'Close', kind: 'ghost', action: 'close-entity' }));
    }

    // -- interaction ----------------------------------------------------------------------------

    core.delegate(root, 'click', function (event, node) {
      var action = node.getAttribute('data-action');
      if (action === 'clear-filters') {
        clearFilters();
        resetPage();
        apply();
        return;
      }
      if (action === 'open-entity') {
        state.openId = node.getAttribute('data-value');
        renderDetail();
        return;
      }
      if (action === 'close-entity') {
        state.openId = null;
        renderDetail();
        return;
      }
      if (!ctx.editable) return;
      if (action === 'add-entity') return openForm(null);
      if (action === 'edit-entity') return openForm(node.getAttribute('data-value'));
      if (action === 'delete-entity') return confirmDelete(node.getAttribute('data-value'));
      if (action === 'bulk-delete') return confirmBulkDelete();
      if (action === 'bulk-update') return openBulkUpdate();
    });

    root.appendChild(countLine);
    root.appendChild(detailHost);
    root.appendChild(table.element);
    root.appendChild(emptyNote);
    root.appendChild(pager.element);

    renderDetail();
    apply();

    // ---------------------------------------------------------------------------------------------
    // Writes. Every one of them ends in `ctx.edit`, which is the only way the working copy changes.
    // ---------------------------------------------------------------------------------------------

    function openForm(id) {
      var entity = id ? M.get(ctx.model, opts.type, id) : null;
      if (id && !entity) return;

      var form = TMV.forms.entityForm({
        type: opts.type,
        entity: entity,
        model: ctx.model,
        disabled: !ctx.editable,
        onSubmit: function (candidate) {
          var next = core.deepCopy(ctx.model);
          if (entity) M.update(next, opts.type, entity.id, withoutId(candidate));
          else M.insert(next, opts.type, candidate);
          instance.close('saved');
          ctx.edit(next, { reason: 'edit-' + opts.type });
          // A created entity is opened, because a create with nothing to show for it looks like it
          // did not happen.
          if (!entity) state.openId = candidate.id;
          ctx.refresh();
        },
      });

      var instance = widgets.modal({
        title: (entity ? 'Edit ' : 'New ') + (M.typeFor(opts.type) || { label: 'entity' }).label.toLowerCase(),
        size: 'lg',
        body: [form.element],
        actions: [
          { label: 'Cancel', kind: 'ghost', action: 'form-cancel' },
          { label: entity ? 'Save changes' : 'Create', kind: 'primary', action: 'form-save' },
        ],
      });

      // The form is a real `<form>`, so its own submit button is the keyboard path; this is the
      // button in the modal footer. Both land in `onSubmit`, which is the only place a write happens.
      core.on(instance.element, 'click', function (event) {
        var node = core.closestAction(event.target, instance.element);
        if (!node) return;
        var action = node.getAttribute('data-action');
        if (action === 'form-cancel') instance.close('cancel');
        else if (action === 'form-save') form.submit();
      });

      instance.open();
    }

    /**
     * Drop the id from a candidate before it becomes an update patch.
     *
     * `M.update` copies field by field, so an `id` in the patch is already ignored — but a patch that
     * carries one reads like a rename, and REQ-EDIT-004 AC2 says entity ids are stable across edits.
     * Removing it makes that structural rather than incidental.
     */
    function withoutId(candidate) {
      var patch = Object.create(null);
      var keys = Object.keys(candidate);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== 'id') patch[keys[i]] = candidate[keys[i]];
      }
      return patch;
    }

    function confirmDelete(id) {
      var plan = TMV.forms.planDelete(ctx.model, opts.type, id);
      if (!plan) return;
      // The dialog opens itself, and its buttons are already wired — so this only has to say what
      // happens to the answer.
      TMV.forms.deleteDialog({
        plan: plan,
        onConfirm: function (answer) {
          var result = TMV.forms.deleteEntity(ctx.model, opts.type, id, answer);
          if (!result) return;
          if (state.openId === id) state.openId = null;
          ctx.edit(result.model, { reason: 'delete-' + opts.type });
          ctx.refresh();
        },
      });
    }

    function confirmBulkDelete() {
      if (!selected.length) return;
      var ids = selected.slice();
      var typeSpec = M.typeFor(opts.type) || { plural: 'Entities' };
      var modal = widgets.modal({
        title: 'Delete ' + core.plural(ids.length, typeSpec.label ? typeSpec.label.toLowerCase() : 'entity', typeSpec.plural.toLowerCase()) + '?',
        size: 'sm',
        danger: true,
        body: [
          core.el('p', {
            text:
              'This removes ' + core.plural(ids.length, 'entity', 'entities') + ' from the working copy. ' +
              'Nothing reaches the file until the change is committed, and Undo restores them until then.',
          }),
          core.el('p', {
            class: 'tmv-muted',
            text:
              'Entries that only record a relationship to these are removed with them. Anything left ' +
              'pointing at one of them is reported afterwards, so nothing is orphaned silently.',
          }),
        ],
        actions: [
          { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
          { label: 'Delete', kind: 'danger', action: 'confirm' },
        ],
      });

      core.on(modal.element, 'click', function (event) {
        var node = core.closestAction(event.target, modal.element);
        if (!node) return;
        var action = node.getAttribute('data-action');
        if (action === 'cancel') return void modal.close('cancel');
        if (action !== 'confirm') return;
        var result = TMV.forms.bulkDelete(ctx.model, opts.type, ids);
        modal.close('deleted');
        state.openId = null;
        ctx.edit(result.model, { reason: 'bulk-delete-' + opts.type });
        if (result.orphaned.length) {
          TMV.notify.outcome({
            title: 'Deleted ' + core.plural(result.removed.length, 'entity', 'entities'),
            detail: core.plural(result.orphaned.length, 'entity', 'entities') + ' now point at something that is not here: ' +
              listText(result.orphaned) + '. They are marked in the list.',
            level: 'warning',
            ref: 'view.bulk.delete.' + opts.key,
          });
        }
        ctx.refresh();
      });
      modal.open();
    }

    function openBulkUpdate() {
      if (!selected.length) return;
      // This dialog applies the patch itself and hands back the result — the per-entity validation
      // lives in `forms.bulkUpdate`, and re-doing it here is how the two would come to disagree.
      TMV.forms.bulkUpdateDialog({
        type: opts.type,
        ids: selected.slice(),
        model: ctx.model,
        onApply: function (result) {
          ctx.edit(result.model, { reason: 'bulk-update-' + opts.type });
          reportBulk(result);
          ctx.refresh();
        },
      });
    }

    /**
     * REQ-EDIT-008 AC1: report per-entity failures **without aborting the whole operation**. The
     * accepted edits are already applied by the time this runs, so the message has to give both
     * numbers — a bare "some failed" leaves the user unable to tell what to retry.
     *
     * It also has to give the *reasons*, which is the half that is easy to write and not deliver:
     * each refused entity produced a problem with a message naming its own field, and a count of how
     * many failed is not something anyone can act on. They go in the notification's detail, which is
     * the retained panel's text as well as the banner's — so "listed with its own reason" is a
     * promise the message keeps rather than one it makes on behalf of a screen that never renders.
     */
    var BULK_REASONS_SHOWN = 5;

    function reportBulk(result) {
      var ok = result.applied.length;
      var failed = result.failed.length;
      if (!failed) {
        TMV.notify.outcome({
          title: 'Updated ' + core.plural(ok, 'entity', 'entities'),
          detail: 'The change is in the working copy. It is not in the file until you commit.',
          level: 'success',
          ref: 'view.bulk.' + opts.key,
        });
        return;
      }
      // Both halves are conditional. "The rest were applied" is a lie when nothing was, and a
      // selection where every entity was refused is not a rare case — it is what happens when the
      // field chosen has a rule the whole selection breaks.
      var reasons = result.failed.slice(0, BULK_REASONS_SHOWN).map(describeFailure).join(' ') + bulkRemainder(failed);
      var applied = ok
        ? ' The other ' + core.plural(ok, 'entity was', 'entities were') + ' changed in the working copy.'
        : ' Nothing was changed.';
      TMV.notify.outcome({
        title: 'Updated ' + ok + ' of ' + core.plural(ok + failed, 'entity', 'entities'),
        detail: reasons + applied + ' None of it is in the file until you commit.',
        level: 'warning',
        ref: 'view.bulk.' + opts.key,
      });
    }

    /** `Payments database — Reference to "x", which is not a component.` One line per refused entity. */
    function describeFailure(entry) {
      var problem = entry.problems && entry.problems.length ? entry.problems[0] : null;
      var why = problem ? problem.message : 'Not accepted.';
      var where = problem && problem.path ? problem.path + ': ' : '';
      return entry.label + ' — ' + where + why;
    }

    function bulkRemainder(failed) {
      if (failed <= BULK_REASONS_SHOWN) return '';
      return ' And ' + (failed - BULK_REASONS_SHOWN) + ' more of the same kind.';
    }

    return { element: root, apply: apply, state: state, table: table, detailHost: detailHost };
  }

  /**
   * The list's "open" cell: the entity's name as a button that reveals its detail.
   *
   * `07-ui.md` §6's entity list is a table, and a table row that is only clickable with a mouse is
   * the accessibility gap §8 names — this is the keyboard path, and the expand control beside it is
   * the documented one.
   *
   * The button's `data-value` is the row's key, and it has to be *the same key* `listView` looks the
   * row up by or the click opens nothing. Both go through `rowKeyOf`, so a join row — one data set
   * placed in three stores is three rows — opens only itself without each caller having to remember
   * to say so. `options.value` overrides it for the rare row whose key is not on the row at all.
   */
  function nameCell(row, opts) {
    var options = opts || {};
    var children = [
      core.el('button', {
        type: 'button',
        class: 'tmv-link-button',
        'data-action': 'open-entity',
        'data-value': options.value || rowKeyOf(row, row.entity.id),
        text: labelOf(row.entity),
      }),
    ];
    var warnings = options.warning ? options.warning(row) : null;
    if (warnings) children.push(core.el('span', { class: 'tmv-cell-tags' }, [warnings]));
    if (options.tags) {
      var tags = options.tags(row);
      if (tags && tags.length) children.push(core.el('span', { class: 'tmv-cell-tags' }, tags));
    }
    return core.el('span', { class: 'tmv-cell-name' }, children);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Smaller shared pieces
  // ---------------------------------------------------------------------------------------------

  /** The heading a section renders under. The shell owns the single `h1` (the tab name). */
  function sectionHeading(ctx, text, note) {
    var heading = core.el('h2', { class: 'tmv-section__title', text: text });
    if (!note) return heading;
    return core.el('div', { class: 'tmv-section__head' }, [heading, core.el('p', { class: 'tmv-section__note', text: note })]);
  }

  /**
   * The empty state for a section the model simply has none of (REQ-VIEW-001 AC2).
   *
   * Both formats make most sections optional, so "absent" is the normal case, not an error — and the
   * state says what the section would hold and where it comes from, so a user who expected content
   * learns why there is none rather than assuming the application lost it.
   */
  function emptySection(opts) {
    return widgets.emptyState({
      title: opts.title,
      body: opts.body,
      action: opts.action,
    });
  }

  /**
   * The empty state for the whole model, which §9 says Overview owns and other tabs point at.
   *
   * `opts.add === false` omits the create button, and Overview passes it: that tab is not an entity
   * list, so an "add the first entity" button there would have nothing to add. A button that does
   * nothing is worse than no button — it teaches the user that the application is unresponsive.
   */
  function emptyModel(ctx, opts) {
    var options = opts || {};
    var actions = core.el('div', { class: 'tmv-empty__actions' });
    if (ctx.editable && options.add !== false) {
      actions.appendChild(widgets.button({ label: 'Add the first entity', kind: 'primary', action: 'add-entity' }));
    }
    actions.appendChild(widgets.button({ label: 'Go to Import', kind: 'tertiary', action: 'go-import' }));
    return core.el('div', { class: 'tmv-empty' }, [
      core.el('h3', { class: 'tmv-empty__title', text: 'This model is empty' }),
      core.el('p', {
        class: 'tmv-empty__body',
        text:
          'The file carries a model with no entities in it yet. Both interchange formats make most ' +
          'sections optional, so this is a legal model — it just has nothing to show. Everything is ' +
          'here for when it does.',
      }),
      actions,
    ]);
  }

  /** A definition row: term on the left, value on the right, in a `structuredList`. */
  function definitionRows(pairs) {
    var rows = [];
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      if (pair === null || pair === undefined) continue;
      if (pair.value === null || pair.value === undefined || pair.value === '') continue;
      rows.push({
        id: pair.id || 'row-' + i,
        cells: [
          core.el('span', { class: 'tmv-detail__key', text: pair.term }),
          core.isString(pair.value) || core.isNumber(pair.value) ? core.el('span', { text: String(pair.value) }) : pair.value,
        ],
      });
    }
    return rows;
  }

  /** A section rendered as a definition list, with an empty state when every value is unset. */
  function definitionSection(ctx, opts) {
    var rows = definitionRows(opts.pairs);
    if (!rows.length) return emptySection(opts.empty || { title: opts.title, body: opts.emptyBody });
    return widgets.structuredList({ label: opts.title, rows: rows });
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Section composition — the shape nine tabs share
  // ---------------------------------------------------------------------------------------------

  /**
   * A section: its heading, and whatever renders under it.
   *
   * The heading belongs here rather than inside `listView` because a `listView` is not always a whole
   * section — a summary can embed one — and a table that rendered its own `h2` would give that case
   * two. The note is the section's one explanation, and callers that would otherwise also pass
   * `listView`'s `intro` should pass this instead: two paragraphs saying the same thing on one screen
   * is how a documentation habit turns into clutter.
   */
  function section(ctx, title, note, body) {
    var root = core.el('div', { class: 'tmv-section' }, [sectionHeading(ctx, title, note)]);
    if (body) root.appendChild(body);
    return root;
  }

  /**
   * A section that is one list.
   *
   * `.element` matters: `listView` returns the widget bag — `{element, apply, state, table,
   * detailHost}` — not a node. Appending the bag itself puts an object with no tag into the DOM, which
   * renders as nothing at all and throws nowhere, so the section silently loses its table.
   */
  function listSection(ctx, title, note, opts) {
    return section(ctx, title, note, listView(ctx, opts).element);
  }

  /** The per-row "this has a reference that goes nowhere" marker, for a column or a name cell. */
  function warnUnresolved(ctx, typeKey) {
    return function (row) { return unresolvedTag(ctx, typeKey, row.entity); };
  }

  /** A reference resolved to the name a reader would recognise, or `null` if it does not resolve. */
  function labelFrom(model, id) {
    if (!core.isString(id)) return null;
    var found = M.findAnywhere(model, id);
    return found ? M.labelOf(found.entity) : null;
  }

  /** Filter options from a vocabulary, in the vocabulary's own order. */
  function optionsFromVocab(vocab) {
    var values = M.VOCAB[vocab] || [];
    var out = [];
    for (var i = 0; i < values.length; i++) out.push({ value: values[i], label: vocabLabel(vocab, values[i]) });
    return out;
  }

  /**
   * Filter options from the values actually present in the rows.
   *
   * This exists because several fields are free strings in both formats — trust-zone `type`,
   * component `type`, tags, vendors — and the vendored schemas do not enumerate them. A filter
   * offering a fixed list would silently hide a model that used its own vocabulary, which is the
   * characteristic failure of a filter: it looks like the data is not there.
   *
   * The `(none)` entry is not the same as the empty option. An entity that has no type is a different
   * fact from one whose type is something, and without it those rows would be reachable only through
   * the search box.
   */
  /** The sentinel `distinctOptions` emits for "this field is unset", so the predicate can agree. */
  var NONE_VALUE = '@none';

  function distinctOptions(rows, getter) {
    var seen = Object.create(null);
    var values = [];
    var none = false;
    for (var i = 0; i < rows.length; i++) {
      var value = getter(rows[i]);
      if (value === null || value === undefined || value === '') {
        none = true;
        continue;
      }
      var text = String(value);
      if (seen[text]) continue;
      seen[text] = true;
      values.push(text);
    }
    values.sort(function (a, b) { return a.localeCompare(b); });
    var out = [];
    for (var v = 0; v < values.length; v++) out.push({ value: values[v], label: humanise(values[v]) });
    if (none) out.push({ value: NONE_VALUE, label: 'Not set' });
    return out;
  }

  /** The predicate that goes with `distinctOptions`, so the two cannot disagree about the sentinel. */
  function matchDistinct(row, value, getter) {
    var actual = getter(row);
    if (value === NONE_VALUE) return actual === null || actual === undefined || actual === '';
    return String(actual) === value;
  }

  /**
   * `distinctOptions` for a field that holds a *list* rather than a single value.
   *
   * `topics`, `tags` and `sources` are lists on one entity, so the options are the union of what the
   * rows carry and the predicate is membership. The sentinel stays `NONE_VALUE` and here it means the
   * list is empty, which is a different fact from "has a topic that is not on the list" — the same
   * distinction `distinctOptions` makes for a scalar, and the reason both live here rather than each
   * caller picking its own sentinel string.
   */
  function listOptions(rows, getter) {
    var pseudo = [];
    var anyEmpty = false;
    for (var i = 0; i < rows.length; i++) {
      var values = getter(rows[i]);
      if (!values || !values.length) {
        anyEmpty = true;
        continue;
      }
      for (var v = 0; v < values.length; v++) pseudo.push({ value: values[v] });
    }
    var out = distinctOptions(pseudo, function (row) { return row.value; });
    if (anyEmpty) out.push({ value: NONE_VALUE, label: 'None' });
    return out;
  }

  /** The predicate that goes with `listOptions`. */
  function matchList(row, value, getter) {
    var values = getter(row) || [];
    if (value === NONE_VALUE) return values.length === 0;
    return values.indexOf(value) !== -1;
  }

  /**
   * A "here is what sits inside this" block for a detail panel.
   *
   * Forward-looking by design: `M.referrersOf` answers "who points at this id", which is the reverse
   * question, and only this direction composes into a list with headings per type.
   */
  function relatedGroup(ctx, specs) {
    var groups = [];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var matches = M.collection(ctx.model, spec.typeKey).filter(function (entity) {
        return entity[spec.field] === spec.id;
      });
      if (!matches.length) continue;
      var typeSpec = M.typeFor(spec.typeKey);
      groups.push(core.el('div', { class: 'tmv-related__group' }, [
        core.el('p', { class: 'tmv-related__label', text: core.plural(matches.length, typeSpec.label, typeSpec.plural) }),
        core.el('ul', { class: 'tmv-dialog__list' }, matches.map(function (entity) {
          return core.el('li', { text: M.labelOf(entity) });
        })),
      ]));
    }
    if (!groups.length) return null;
    return core.el('div', { class: 'tmv-related' }, groups);
  }

  /** A labelled block for a detail panel, so callers do not each invent the same four lines. */
  function relatedBlock(title, body) {
    if (!body) return null;
    return core.el('section', { class: 'tmv-detail__related' }, [
      core.el('h4', { class: 'tmv-detail__related-title', text: title }),
      body,
    ]);
  }

  /** A count as a sentence, for the summary lines the tabs print above their content. */
  function countSentence(counts, keys) {
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var spec = M.typeFor(keys[i]);
      var n = counts[keys[i]] || 0;
      if (!n) continue;
      parts.push(n + ' ' + (n === 1 ? spec.label.toLowerCase() : spec.plural.toLowerCase()));
    }
    if (!parts.length) return 'No entities yet.';
    return parts.join(' · ');
  }

  /**
   * What an export records about the application that produced it (`03-data-model.md` §7).
   *
   * The container carries a `build` block, and until this existed an export filled two of its three
   * fields with `null` and the current time. Both halves of that were wrong in a way that only shows
   * up later: a file exported from a build could not be recognised as coming from a build, so
   * `19-boot.js`'s foreign-build notice — the one that says "this file was written by a different
   * build of the application" and offers to trust it — could never fire for a file this application
   * wrote itself. The artifact's own seed container has carried a real hash since the first build;
   * exports of it did not.
   *
   * The values are read from the page's own `<meta>` elements rather than recomputed, for the same
   * reason `runningAppHash()` does it that way: the question is what this file *declares*, and a page
   * that recomputes its own hash from its own text can only ever agree with itself. `generatedAt` is
   * deliberately left to `makeContainer`, which stamps the moment of the export — the file's build
   * record is when the file was written, and the version and hash are which build wrote it.
   */
  function runningBuild() {
    return {
      appVersion: core.metaContent('tmv-app-version') || TMV.VERSION,
      appHash: core.metaContent('tmv-app-hash'),
    };
  }

  /**
   * The options an export preview or readiness check needs from preferences.
   *
   * One function rather than two call sites reading `prefs.extensionDomain` independently, because the
   * Overview tab's Export Readiness and the Settings tab's Export section render the same list from
   * the same mapper: if they built their options differently they could report different things about
   * the same model, and the user would have no way to tell which screen was lying.
   */
  function exportOptions(ctx) {
    return {
      extensionDomain: core.isString(ctx.prefs && ctx.prefs.extensionDomain) ? ctx.prefs.extensionDomain : '',
      build: runningBuild(),
    };
  }

  // ---------------------------------------------------------------------------------------------

  TMV.views = {
    humanise: humanise,
    exportOptions: exportOptions,
    vocabLabel: vocabLabel,
    vocabRank: vocabRank,
    listText: listText,
    scalarText: scalarText,

    referenceFields: referenceFields,
    referenceValues: referenceValues,
    unresolvedOf: unresolvedOf,
    unresolvedTag: unresolvedTag,
    labelOf: labelOf,
    refText: refText,

    RISK_TAG: RISK_TAG,
    STATE_TAG: STATE_TAG,
    STATUS_TAG: STATUS_TAG,
    tag: tag,
    riskTag: riskTag,
    riskOf: riskOf,
    stateTag: stateTag,
    statusTag: statusTag,
    priorityTag: priorityTag,
    tagList: tagList,

    BAG_LABEL: BAG_LABEL,
    fieldValue: fieldValue,
    detailRows: detailRows,
    detailView: detailView,
    referrersPanel: referrersPanel,

    listView: listView,
    nameCell: nameCell,
    stateFor: stateFor,
    resetState: resetState,

    sectionHeading: sectionHeading,
    emptySection: emptySection,
    emptyModel: emptyModel,
    definitionRows: definitionRows,
    definitionSection: definitionSection,
    countSentence: countSentence,

    NONE_VALUE: NONE_VALUE,
    section: section,
    listSection: listSection,
    warnUnresolved: warnUnresolved,
    labelFrom: labelFrom,
    optionsFromVocab: optionsFromVocab,
    distinctOptions: distinctOptions,
    matchDistinct: matchDistinct,
    listOptions: listOptions,
    matchList: matchList,
    relatedGroup: relatedGroup,
    relatedBlock: relatedBlock,
  };
})(globalThis.TMV = globalThis.TMV || {});
