/*
 * 18-views-flows.js — the Flows tab.
 *
 * Sections (`07-ui.md` §3): All Flows · Unencrypted · Cross-Zone · Missing Endpoints.
 *
 * Three of the four sections are filters rather than entity types, and §3 says they are marked with a
 * count "so they read as findings, not sections". That has a consequence for this module: a count and
 * the rows on the screen have to come from one function, or the number in the side nav is a second
 * implementation of the rule and the two will eventually disagree. `UNENCRYPTED`, `CROSS_ZONE` and
 * `MISSING_ENDPOINTS` below are each a single predicate, and the finding sections and `counts` both
 * go through it.
 *
 * The other thing worth stating: **a finding here is a property of a flow, and the rule for it is
 * printed on the section.** An unencrypted flow that nothing declares to be sensitive is not flagged,
 * because flagging it would be the application deciding that all traffic is sensitive — which is a
 * judgement no format made and no user asked for. Each section says, in its own words, exactly what it
 * counted.
 *
 * Flow endpoints are typed. A flow records `sourceType` and `destinationType` alongside
 * `sourceId`/`destinationId`, and OTM omits them in some documents, so resolution goes through
 * `M.findAnywhere` and the declared type is used only for display.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  // ---------------------------------------------------------------------------------------------
  // Resolution — the one place a flow endpoint becomes an entity and a zone
  // ---------------------------------------------------------------------------------------------

  /**
   * An endpoint, resolved.
   *
   * `type` is what the flow says the endpoint is; `kind` is what the model actually holds. They
   * disagree when a flow says "component" and the id names an actor, which is legal input and a real
   * defect, so the mismatch is reported rather than silently resolved to the model's answer.
   */
  function endpoint(ctx, id, declaredType) {
    var out = { id: id, declaredType: declaredType || null, entity: null, typeKey: null, zone: null, mismatch: false };
    if (!core.isString(id) || id === '') return out;
    var found = M.findAnywhere(ctx.model, id);
    if (!found) return out;
    out.entity = found.entity;
    out.typeKey = found.type;
    if (core.isString(declaredType) && M.FLOW_ENDPOINT_TARGET[declaredType] && M.FLOW_ENDPOINT_TARGET[declaredType] !== found.type) {
      out.mismatch = true;
    }
    // Only components, actors and data stores carry a zone. An endpoint that resolves to anything
    // else has no zone by construction, and inventing one from the flow's other end would turn an
    // unknown into a claim.
    if (core.isString(found.entity.trustZoneId)) out.zone = found.entity.trustZoneId;
    return out;
  }

  function zoneName(ctx, zoneId) {
    return zoneId ? V.labelFrom(ctx.model, zoneId) : null;
  }

  /** Everything a flow's row and columns read, computed once. */
  function flowRow(ctx, flow) {
    var source = endpoint(ctx, flow.sourceId, flow.sourceType);
    var destination = endpoint(ctx, flow.destinationId, flow.destinationType);
    var assets = core.isArray(flow.assetIds) ? flow.assetIds : [];
    return {
      entity: flow,
      source: source,
      destination: destination,
      assets: assets,
      unencrypted: flow.encrypted !== true,
      sensitive: flow.hasSensitiveData === true || assets.length > 0,
      missing: !source.entity || !destination.entity,
      crossZone: !!(source.zone && destination.zone && source.zone !== destination.zone),
      __search: [
        flow.name,
        (flow.tags || []).join(' '),
        source.entity ? M.labelOf(source.entity) : String(flow.sourceId),
        destination.entity ? M.labelOf(destination.entity) : String(flow.destinationId),
        flow.id,
      ].join(' '),
    };
  }

  function flowRows(ctx) {
    var list = M.collection(ctx.model, 'dataFlow');
    var rows = [];
    for (var i = 0; i < list.length; i++) rows.push(flowRow(ctx, list[i]));
    return rows;
  }

  // ---------------------------------------------------------------------------------------------
  // The three rules, each in exactly one place
  // ---------------------------------------------------------------------------------------------

  /** Not encrypted, and something in the model says the payload matters. */
  function UNENCRYPTED(row) {
    return row.unencrypted && row.sensitive;
  }

  /** Both ends resolve to a zone, and they are not the same zone. */
  function CROSS_ZONE(row) {
    return row.crossZone;
  }

  /** At least one end does not resolve to anything this model holds. */
  function MISSING_ENDPOINTS(row) {
    return row.missing;
  }

  /**
   * A trust-zone filter over flows.
   *
   * A flow has two zones, so "which zone" can only mean "either end" — and the option list is the
   * union of both ends across every row. Matching either end is what makes the filter answer the
   * question a reader actually has, which is "show me everything that touches this zone".
   */
  function zoneFilter(ctx, rows) {
    var ends = [];
    for (var i = 0; i < rows.length; i++) {
      ends.push({ zone: zoneName(ctx, rows[i].source.zone) });
      ends.push({ zone: zoneName(ctx, rows[i].destination.zone) });
    }
    return {
      id: 'zone',
      label: 'Trust zone',
      options: V.distinctOptions(ends, function (row) { return row.zone; }),
      test: function (row, value) {
        return zoneMatches(ctx, row.source.zone, value) || zoneMatches(ctx, row.destination.zone, value);
      },
    };
  }

  function zoneMatches(ctx, zoneId, value) {
    return V.matchDistinct({ zone: zoneName(ctx, zoneId) }, value, function (r) { return r.zone; });
  }

  // ---------------------------------------------------------------------------------------------
  // Columns shared by all four sections
  // ---------------------------------------------------------------------------------------------

  /** An endpoint as a cell: a name, or the bare id marked as unresolvable. */
  function endpointCell(ctx, side, which) {
    return function (row) {
      var end = row[side];
      if (!end.entity) {
        var wrap = core.el('span', { class: 'tmv-unresolved' }, [
          core.el('span', { class: 'tmv-unresolved__mark', 'aria-hidden': 'true', text: '!' }),
          core.el('span', { class: 'tmv-unresolved__id', text: String(end.id) }),
        ]);
        if (end.declaredType) {
          wrap.appendChild(core.el('span', { class: 'cds--visually-hidden', text: ' — declared as a ' + V.humanise(end.declaredType) }));
        }
        return wrap;
      }
      var children = [core.el('span', { text: M.labelOf(end.entity) })];
      // The zone is the thing the Cross-Zone section is about, and a reader looking at a flow in the
      // main list is asking the same question — so it is on the endpoint rather than in a column of
      // its own, where it would need two.
      var zone = zoneName(ctx, end.zone);
      if (zone) children.push(core.el('span', { class: 'tmv-muted', text: ' (' + zone + ')' }));
      if (end.mismatch) {
        children.push(core.el('span', {
          class: 'tmv-cell-note',
          text: ' declared a ' + V.humanise(end.declaredType),
          title: 'This flow says the ' + which + ' is a ' + V.humanise(end.declaredType) + ', and the model holds a ' +
            V.humanise(end.typeKey) + ' with that id. The flow is shown as it is stored.',
        }));
      }
      return core.el('span', {}, children);
    };
  }

  function encryptionCell(row) {
    if (row.entity.encrypted === true) return core.el('span', { text: 'Encrypted' });
    if (row.entity.encrypted === false) return core.el('span', { class: 'tmv-cell-note', text: 'Not encrypted' });
    return core.el('span', { class: 'tmv-muted', text: 'Not stated' });
  }

  function sensitivityCell(row) {
    if (row.entity.hasSensitiveData === true) return V.tag({ text: 'Sensitive data', type: 'magenta' });
    if (row.assets.length) return V.tag({ text: core.plural(row.assets.length, 'asset', 'assets'), type: 'magenta' });
    if (row.entity.hasSensitiveData === false) return core.el('span', { class: 'tmv-muted', text: 'No' });
    return core.el('span', { class: 'tmv-muted', text: 'Not stated' });
  }

  function assetsCell(ctx, row) {
    if (!row.assets.length) return core.el('span', { class: 'tmv-muted', text: '—' });
    var wrap = core.el('span', { class: 'tmv-ref-list' });
    for (var i = 0; i < row.assets.length; i++) {
      if (i) wrap.appendChild(core.text(', '));
      var name = V.labelFrom(ctx.model, row.assets[i]);
      if (name) wrap.appendChild(core.el('span', { text: name }));
      else wrap.appendChild(core.el('span', { class: 'tmv-unresolved__id', text: String(row.assets[i]) }));
    }
    return wrap;
  }

  function directionCell(row) {
    if (row.entity.bidirectional === true) return V.tag({ text: 'Both ways', type: 'blue' });
    if (row.entity.bidirectional === false) return core.el('span', { class: 'tmv-muted', text: 'One way' });
    return core.el('span', { class: 'tmv-muted', text: 'Not stated' });
  }

  /** The columns every flow table uses, so the four sections cannot drift apart in what they show. */
  function flowColumns(ctx) {
    return [
      { key: 'name', label: 'Name', sortable: true, render: function (row) {
        return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'dataFlow') });
      } },
      { key: 'source', label: 'From', sortable: true, render: endpointCell(ctx, 'source', 'source') },
      { key: 'destination', label: 'To', sortable: true, render: endpointCell(ctx, 'destination', 'destination') },
      { key: 'encrypted', label: 'Encryption', sortable: true, render: encryptionCell },
      { key: 'sensitive', label: 'Sensitive', sortable: true, render: sensitivityCell },
      { key: 'assets', label: 'Assets', render: function (row) { return assetsCell(ctx, row); } },
      { key: 'direction', label: 'Direction', sortable: true, render: directionCell },
    ];
  }

  /** A rule's own columns: the shared ones minus what the rule already asserts for every row. */
  function ruleColumns(ctx, omit) {
    var all = flowColumns(ctx);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (omit.indexOf(all[i].key) !== -1) continue;
      out.push(all[i]);
    }
    return out;
  }

  /** The detail every flow section shows: the flow's fields, and where its ends sit. */
  function flowDetail(ctx, row, extra) {
    var blocks = [extra];
    var ends = V.relatedBlock('Endpoints', core.el('div', {}, [
      endpointSummary(ctx, 'From', row.source),
      endpointSummary(ctx, 'To', row.destination),
    ]));
    if (ends) blocks.push(ends);
    var related = core.el('div', {}, blocks.filter(function (node) { return node !== null; }));
    return V.detailView(ctx, { type: 'dataFlow', entity: row.entity, related: related });
  }

  function endpointSummary(ctx, label, end) {
    if (!end.entity) {
      return core.el('p', { class: 'tmv-nested__row' }, [
        core.el('span', { class: 'tmv-nested__key', text: label + ': ' }),
        core.el('span', { class: 'tmv-unresolved__id', text: String(end.id) }),
        core.el('span', { text: ' — not in this model' }),
      ]);
    }
    var text = M.labelOf(end.entity) + ' (' + (M.typeFor(end.typeKey) || { label: 'entity' }).label + ')';
    var zone = zoneName(ctx, end.zone);
    if (zone) text += ', in ' + zone;
    else text += ', in no trust zone';
    return core.el('p', { class: 'tmv-nested__row', text: label + ': ' + text });
  }

  // ---------------------------------------------------------------------------------------------
  // 1. All flows
  // ---------------------------------------------------------------------------------------------

  var ALL_NOTE =
    'Every flow the model declares. From and To name the endpoint and, in brackets, the trust zone it ' +
    'sits in — a flow whose ends are in different zones is the subject of the Cross-Zone section below.';

  function allFlowsSection(ctx) {
    var rows = flowRows(ctx);

    return V.listSection(ctx, 'All Flows', ALL_NOTE, {
      key: 'flows.all',
      type: 'dataFlow',
      entityRows: rows,
      plural: 'flows',
      singular: 'flow',
      addLabel: 'Add flow',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'encrypted',
          label: 'Encryption',
          options: [
            { value: 'yes', label: 'Stated as encrypted' },
            { value: 'no', label: 'Not stated as encrypted' },
          ],
          test: function (row, value) { return value === 'yes' ? row.entity.encrypted === true : row.unencrypted; },
        },
        {
          id: 'sensitive',
          label: 'Payload',
          options: [
            { value: 'yes', label: 'Sensitive data or assets' },
            { value: 'no', label: 'Neither' },
          ],
          test: function (row, value) { return value === 'yes' ? row.sensitive : !row.sensitive; },
        },
        {
          id: 'endpoints',
          label: 'Endpoints',
          options: [
            { value: 'both', label: 'Both ends resolve' },
            { value: 'missing', label: 'An end does not resolve' },
          ],
          test: function (row, value) { return value === 'both' ? !row.missing : row.missing; },
        },
        zoneFilter(ctx, rows),
      ],
      columns: flowColumns(ctx),
      empty: {
        title: 'No flows',
        body:
          'This model declares no movement between its parts. Flows are the join between architecture ' +
          'and data: nothing on this tab can be said about a model that has none.',
      },
      filteredEmpty: {
        title: 'No flows match these filters',
        body: 'This model has flows; none of them match what is selected.',
      },
      detail: function (c, row) { return flowDetail(c, row, null); },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Unencrypted — the finding
  // ---------------------------------------------------------------------------------------------

  var UNENCRYPTED_NOTE =
    'This section applies one rule: a flow that is not stated as encrypted, and that carries either ' +
    'sensitive data or at least one asset. A flow nothing declares to be carrying anything sensitive ' +
    'is not listed — that would be the application deciding that all traffic matters, which is not a ' +
    'judgement either format makes.';

  function unencryptedSection(ctx) {
    return ruleSection(ctx, {
      title: 'Unencrypted',
      note: UNENCRYPTED_NOTE,
      rule: UNENCRYPTED,
      key: 'flows.unencrypted',
      omit: ['encrypted'],
      emptyTitle: 'Nothing flagged',
      emptyBody:
        'No unencrypted flow in this model carries data the model itself calls sensitive. That is the ' +
        'rule being satisfied: flows whose encryption is not stated are only flagged when something ' +
        'says they matter.',
      detail: function (c, row) {
        return flowDetail(c, row, V.relatedBlock('Why this was flagged',
          core.el('p', {
            text:
              'This flow is ' + (row.entity.encrypted === false ? 'stated as not encrypted' : 'not stated as encrypted') +
              ' and ' + (row.assets.length
                ? 'carries ' + core.plural(row.assets.length, 'asset', 'assets')
                : 'is marked as carrying sensitive data') + '.',
          })));
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Cross-Zone — the finding
  // ---------------------------------------------------------------------------------------------

  var CROSS_ZONE_NOTE =
    'This section applies one rule: a flow whose two ends both sit in a trust zone, and whose zones ' +
    'differ. A flow with an end in no zone is not counted here — that is an absence of information, ' +
    'and it belongs in Missing Endpoints or in the model’s own gaps, not in a list that claims a ' +
    'zone was crossed.';

  function crossZoneSection(ctx) {
    return ruleSection(ctx, {
      title: 'Cross-Zone',
      note: CROSS_ZONE_NOTE,
      rule: CROSS_ZONE,
      key: 'flows.cross-zone',
      omit: [],
      emptyTitle: 'No zone crossings',
      emptyBody:
        'No flow in this model has both ends inside a zone and those zones differing. A model with no ' +
        'trust zones at all is empty here by construction, and the Architecture tab will say so.',
      detail: function (c, row) {
        var from = zoneName(c, row.source.zone);
        var to = zoneName(c, row.destination.zone);
        return flowDetail(c, row, V.relatedBlock('The crossing',
          core.el('p', {
            text:
              'This flow leaves ' + from + ' and arrives in ' + to + '. The model does not say whether a ' +
              'trust boundary covers this crossing; the Architecture tab lists the boundaries it does declare.',
          })));
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Missing Endpoints — the finding
  // ---------------------------------------------------------------------------------------------

  var MISSING_NOTE =
    'This section applies one rule: a flow with an end that does not resolve to anything in this ' +
    'model. It is the referential check from the Threats tab, applied to the one field where a broken ' +
    'reference changes what the model means: a flow to nowhere is not a flow.';

  function missingEndpointsSection(ctx) {
    return ruleSection(ctx, {
      title: 'Missing Endpoints',
      note: MISSING_NOTE,
      rule: MISSING_ENDPOINTS,
      key: 'flows.missing',
      omit: [],
      emptyTitle: 'Every endpoint resolves',
      emptyBody:
        'Both ends of every flow in this model name something the model holds. That is the check ' +
        'passing, on the flows that exist — a model with no flows has nothing to check and is empty ' +
        'here for that reason instead.',
      detail: function (c, row) {
        var missing = [];
        if (!row.source.entity) {
          missing.push(core.el('li', { text: 'From points at “' + row.source.id + '”, which is not in this model.' }));
        }
        if (!row.destination.entity) {
          missing.push(core.el('li', { text: 'To points at “' + row.destination.id + '”, which is not in this model.' }));
        }
        return flowDetail(c, row, V.relatedBlock('What does not resolve',
          core.el('ul', { class: 'tmv-dialog__list' }, missing)));
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The shape the three finding sections share
  // ---------------------------------------------------------------------------------------------

  /**
   * A section that is a filter over the flows.
   *
   * The rule arrives as a predicate and is used for the rows, for the filters and for the count, so
   * there is one implementation of "what counts as unencrypted" and the side nav cannot disagree with
   * the table. `omit` drops the columns the rule already asserts for every row — a column of identical
   * "Not encrypted" values is noise pretending to be information.
   */
  function ruleSection(ctx, opts) {
    var matched = [];
    var all = flowRows(ctx);
    for (var i = 0; i < all.length; i++) if (opts.rule(all[i])) matched.push(all[i]);

    if (!matched.length) {
      var total = all.length;
      return V.section(ctx, opts.title, opts.note, V.emptySection({
        title: opts.emptyTitle,
        body: total === 0
          ? 'This model declares no flows, so there is nothing for this rule to check.'
          : opts.emptyBody,
      }));
    }

    return V.listSection(ctx, opts.title, opts.note, {
      key: opts.key,
      type: 'dataFlow',
      entityRows: matched,
      plural: 'flows',
      singular: 'flow',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      filters: [
        zoneFilter(ctx, matched),
        {
          id: 'assets',
          label: 'Assets',
          options: [
            { value: 'yes', label: 'Carries at least one asset' },
            { value: 'no', label: 'Carries no assets' },
          ],
          test: function (row, value) { return value === 'yes' ? row.assets.length > 0 : row.assets.length === 0; },
        },
      ],
      columns: ruleColumns(ctx, opts.omit),
      empty: { title: opts.emptyTitle },
      filteredEmpty: {
        title: 'No flows match these filters',
        body: 'This model has flows this rule flagged; none of them match what is selected.',
      },
      detail: opts.detail,
    });
  }

  // ---------------------------------------------------------------------------------------------

  var SECTIONS = {
    'all-flows': allFlowsSection,
    unencrypted: unencryptedSection,
    'cross-zone': crossZoneSection,
    'missing-endpoints': missingEndpointsSection,
  };

  function render(ctx) {
    var build = SECTIONS[ctx.section] || SECTIONS['all-flows'];
    return build(ctx);
  }

  /** The three rules, counted through the same predicates the sections render from. */
  function counts(ctx) {
    var all = flowRows(ctx);
    var out = { unencrypted: 0, 'cross-zone': 0, 'missing-endpoints': 0 };
    for (var i = 0; i < all.length; i++) {
      if (UNENCRYPTED(all[i])) out.unencrypted++;
      if (CROSS_ZONE(all[i])) out['cross-zone']++;
      if (MISSING_ENDPOINTS(all[i])) out['missing-endpoints']++;
    }
    return out;
  }

  TMV.shell.register({ id: 'flows', title: 'Flows', render: render, counts: counts });
})(globalThis.TMV = globalThis.TMV || {});
