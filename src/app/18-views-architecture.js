/*
 * 18-views-architecture.js — the Architecture tab.
 *
 * Sections (`07-ui.md` §3): Trust Zones · Trust Boundaries · Components · Actors · Data Stores ·
 * Diagram.
 *
 * Three decisions are made here and are worth stating, because each of them is a place where the
 * obvious implementation is the wrong one:
 *
 * 1. **A column shows a stored field or a count of referrers — nothing else.** It is tempting to
 *    give Components a "Threats" column computed from the threat applications, and that is exactly
 *    what this does — but it is a *count of references to this entity*, not a judgement. Nothing on
 *    this tab says a component is well-defended; a column that looked like a verdict would be the
 *    application asserting something the model does not contain.
 *
 * 2. **`type` is a free string in both formats, so its filter is derived from the model.** OTM's
 *    trust-zone `type` and component `type` are unconstrained strings — the vendored schemas do not
 *    enumerate them, and `05-model.js` types them as `string` for that reason. A filter offering a
 *    fixed list of values would silently hide a model that used its own vocabulary, which is the
 *    failure mode of a filter: it looks like the data is not there.
 *
 * 3. **The zone hierarchy is a field, not a tree here.** Trust zones nest through `parentId`, and a
 *    tree control would be a second, differently-ordered rendering of the same rows the table
 *    already shows. The Diagram section draws the nesting as nesting; the table shows the parent in
 *    a column and lets sorting answer "what is in this zone".
 *
 * Registered with the shell as `architecture`. It has no finding sections, so `counts` returns an
 * empty object rather than a partial one — a missing count renders as `—`, and on this tab every
 * count would be one.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  // ---------------------------------------------------------------------------------------------
  // Shared local helpers
  // ---------------------------------------------------------------------------------------------

  /** Row scaffolding shared by all five lists: the entity, a search haystack, and a label. */
  function rowsOf(ctx, typeKey, haystack) {
    var list = M.collection(ctx.model, typeKey);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var row = { entity: list[i], __search: haystack(list[i], i) };
      out.push(row);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // 1. Trust zones
  // ---------------------------------------------------------------------------------------------

  var ZONES_NOTE =
    'Trust zones are the areas of different trust this model declares. A zone nested inside another ' +
    'inherits nothing — the nesting is a statement about the diagram, not a rule the application applies.';

  function trustZonesSection(ctx) {
    var rows = rowsOf(ctx, 'trustZone', function (zone) {
      return [zone.name, zone.type, zone.id].join(' ');
    });
    for (var i = 0; i < rows.length; i++) {
      var zone = rows[i].entity;
      rows[i].type = zone.type || '';
      rows[i].parent = V.labelFrom(ctx.model, zone.parentId);
      rows[i].components = M.collection(ctx.model, 'component').filter(function (c) {
        return c.trustZoneId === zone.id;
      }).length;
    }

    return V.listSection(ctx, 'Trust Zones', ZONES_NOTE, {
      key: 'architecture.zones',
      type: 'trustZone',
      entityRows: rows,
      plural: 'trust zones',
      singular: 'trust zone',
      pageSizes: [10, 25, 50],
      addLabel: 'Add trust zone',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'type',
          label: 'Zone type',
          options: V.distinctOptions(rows, function (row) { return row.type; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.type; }); },
        },
        {
          id: 'nested',
          label: 'Nesting',
          options: [
            { value: 'yes', label: 'Nested inside another zone' },
            { value: 'no', label: 'Top level' },
          ],
          test: function (row, value) {
            var nested = core.isString(row.entity.parentId);
            return value === 'yes' ? nested : !nested;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'trustZone') });
        } },
        { key: 'type', label: 'Type', sortable: true, render: function (row) {
          return row.type ? V.humanise(row.type) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'parent', label: 'Parent', sortable: true, render: function (row) {
          return row.parent || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'rating', label: 'Trust rating', numeric: true, sortable: true,
          // The column is labelled `rating` but the entity's field is `trustRating`, so the sort
          // declares where its value comes from rather than leaving the comparator to guess at a
          // mapping the column never stated.
          sortValue: function (row) { return core.isNumber(row.entity.trustRating) ? row.entity.trustRating : null; },
          render: function (row) {
          var rating = row.entity.trustRating;
          if (!core.isNumber(rating)) return core.el('span', { class: 'tmv-muted', text: '—' });
          return core.el('span', { 'data-rating': String(rating), text: String(rating) });
        } },
        { key: 'components', label: 'Components', numeric: true, sortable: true, render: function (row) {
          return String(row.components);
        } },
      ],
      empty: {
        title: 'No trust zones',
        body:
          'Neither format requires a model to declare trust zones, and this one does not. A model ' +
          'built only from TML may express its trust as boundaries and ratings rather than as zones.',
      },
      filteredEmpty: {
        title: 'No trust zones match these filters',
        body: 'This model has trust zones; none of them match what is selected.',
      },
      detail: function (c, row) {
        var zoneId = row.entity.id;
        // Every entity that names this zone in its own `trustZoneId`, grouped by type. Forward, not
        // reverse: `referrersOf` would also catch a boundary between two zones, which is a fact about
        // the crossing rather than about what the zone contains.
        var related = V.relatedBlock('Inside this zone', V.relatedGroup(c, [
          { typeKey: 'component', field: 'trustZoneId', id: zoneId },
          { typeKey: 'actor', field: 'trustZoneId', id: zoneId },
          { typeKey: 'dataStore', field: 'trustZoneId', id: zoneId },
        ]));
        return V.detailView(c, { type: 'trustZone', entity: row.entity, related: related });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Trust boundaries
  // ---------------------------------------------------------------------------------------------

  var BOUNDARIES_NOTE =
    'A trust boundary is a TML construct: it records the controls at a crossing point between two ' +
    'zones. OTM has no equivalent, so an OTM-only model has an empty section here rather than a ' +
    'derived one.';

  function trustBoundariesSection(ctx) {
    var rows = rowsOf(ctx, 'trustBoundary', function (b) {
      return [b.name, V.labelFrom(ctx.model, b.zoneAId), V.labelFrom(ctx.model, b.zoneBId), (b.accessControlMethods || []).join(' ')].join(' ');
    });
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i].entity;
      rows[i].zoneA = V.labelFrom(ctx.model, b.zoneAId);
      rows[i].zoneB = V.labelFrom(ctx.model, b.zoneBId);
      rows[i].acm = core.isArray(b.accessControlMethods) ? b.accessControlMethods : [];
    }

    return V.listSection(ctx, 'Trust Boundaries', BOUNDARIES_NOTE, {
      key: 'architecture.boundaries',
      type: 'trustBoundary',
      entityRows: rows,
      plural: 'trust boundaries',
      singular: 'trust boundary',
      pageSizes: [10, 25, 50],
      addLabel: 'Add trust boundary',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'access',
          label: 'Access control',
          options: V.optionsFromVocab('accessControlMethod'),
          test: function (row, value) { return row.acm.indexOf(value) !== -1; },
        },
        {
          id: 'crosses',
          label: 'Crosses',
          options: V.distinctOptions(rows, function (row) { return row.zoneA; }),
          test: function (row, value) {
            if (value === '@none') return !row.zoneA && !row.zoneB;
            return row.zoneA === value || row.zoneB === value;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'trustBoundary') });
        } },
        { key: 'zoneA', label: 'Zone A', sortable: true, render: zoneCell('zoneA') },
        { key: 'zoneB', label: 'Zone B', sortable: true, render: zoneCell('zoneB') },
        { key: 'access', label: 'Access control', render: function (row) {
          return row.acm.length ? V.tagList(row.acm) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'auth', label: 'Authentication', render: function (row) {
          var auth = row.entity.authenticationMethods;
          return core.isArray(auth) && auth.length ? V.tagList(auth) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'session', label: 'Session', render: function (row) {
          return sessionCell(row.entity);
        } },
      ],
      empty: {
        title: 'No trust boundaries',
        body:
          'A trust boundary is TML-only. If this model came from OTM, its crossings are expressed as ' +
          'flows between zones instead, and the Flows tab shows them.',
      },
      filteredEmpty: {
        title: 'No trust boundaries match these filters',
        body: 'This model has trust boundaries; none of them match what is selected.',
      },
      detail: function (c, row) { return V.detailView(c, { type: 'trustBoundary', entity: row.entity }); },
    });
  }

  /**
   * One side of a boundary.
   *
   * Both sides render the same way — a name, or a dash — but neither is derivable from the other, so
   * the renderer is a factory rather than one function the table would have to tell which column it
   * is in. A boundary whose two ends are the same zone is legal, if pointless, and showing each side
   * from its own field is the only way that becomes visible.
   */
  function zoneCell(which) {
    return function (row) {
      var value = which === 'zoneA' ? row.zoneA : row.zoneB;
      return value ? core.el('span', { text: value }) : core.el('span', { class: 'tmv-muted', text: '—' });
    };
  }

  /**
   * The session column, as a phrase rather than three separate columns.
   *
   * These four fields only mean anything together — an expiring access token with a non-expiring
   * refresh token is not two facts, it is one weakness — so they are rendered as one summary and
   * left individually visible in the detail.
   */
  function sessionCell(entity) {
    var parts = [];
    if (entity.accessTokenExpires === true) {
      parts.push('Access token' + (core.isNumber(entity.accessTokenTtl) ? ' ' + entity.accessTokenTtl + 's' : ''));
    } else if (entity.accessTokenExpires === false) {
      parts.push('Access token never expires');
    }
    if (entity.hasRefreshToken === true) {
      parts.push(entity.refreshTokenExpires === false ? 'refresh token never expires' : 'refresh token');
    }
    if (entity.canUserLogout === true) parts.push('user can log out');
    if (!parts.length) return core.el('span', { class: 'tmv-muted', text: '—' });
    var never = parts.indexOf('Access token never expires') !== -1 || parts.indexOf('refresh token never expires') !== -1;
    return core.el('span', never ? { class: 'tmv-cell-note', text: parts.join(', ') } : { text: parts.join(', ') });
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Components
  // ---------------------------------------------------------------------------------------------

  var COMPONENTS_NOTE =
    'Components are the units of this model that threats are applied to and controls cover. The flow ' +
    'count is how many flows start or end here.';

  function componentsSection(ctx) {
    var rows = rowsOf(ctx, 'component', function (c) {
      return [c.name, c.type, (c.tags || []).join(' '), c.id].join(' ');
    });
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].entity;
      rows[i].type = c.type || '';
      rows[i].zone = V.labelFrom(ctx.model, c.trustZoneId);
      rows[i].parent = V.labelFrom(ctx.model, c.parentId);
      // The count of flows that start or end here is the one number that tells a reader whether a
      // component is load-bearing in this model, and it is a fact about the file, not a score.
      rows[i].flows = 0;
    }
    var flows = M.collection(ctx.model, 'dataFlow');
    for (var f = 0; f < flows.length; f++) {
      for (var r = 0; r < rows.length; r++) {
        if (flows[f].sourceId === rows[r].entity.id || flows[f].destinationId === rows[r].entity.id) rows[r].flows++;
      }
    }

    return V.listSection(ctx, 'Components', COMPONENTS_NOTE, {
      key: 'architecture.components',
      type: 'component',
      entityRows: rows,
      plural: 'components',
      singular: 'component',
      addLabel: 'Add component',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'type',
          label: 'Component type',
          options: V.distinctOptions(rows, function (row) { return row.type; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.type; }); },
        },
        {
          id: 'zone',
          label: 'Trust zone',
          options: V.distinctOptions(rows, function (row) { return row.zone; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.zone; }); },
        },
        {
          id: 'flows',
          label: 'Flows',
          options: [
            { value: 'any', label: 'Has at least one flow' },
            { value: 'none', label: 'Has no flows' },
          ],
          test: function (row, value) { return value === 'any' ? row.flows > 0 : row.flows === 0; },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, {
            warning: V.warnUnresolved(ctx, 'component'),
            tags: function (r) { return r.entity.tags && r.entity.tags.length ? V.tagList(r.entity.tags) : null; },
          });
        } },
        { key: 'type', label: 'Type', sortable: true, render: function (row) {
          return row.type ? V.humanise(row.type) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'zone', label: 'Trust zone', sortable: true, render: function (row) {
          return row.zone || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'parent', label: 'Parent', sortable: true, render: function (row) {
          return row.parent || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'flows', label: 'Flows', numeric: true, sortable: true, render: function (row) { return String(row.flows); } },
      ],
      empty: {
        title: 'No components',
        body:
          'Nothing in this model is described as a component. In OTM a component is the thing threats ' +
          'are applied to; in TML it is a node in a data flow. A model with neither has no components ' +
          'to show.',
      },
      filteredEmpty: {
        title: 'No components match these filters',
        body: 'This model has components; none of them match what is selected.',
      },
      detail: function (c, row) {
        var id = row.entity.id;
        // A component with no threats and no diagram placement has no related panel at all — hence the
        // nulls being filtered rather than appended, since `core.el` would happily take a null child
        // and put a tagless node in the DOM.
        var blocks = [
          relatedApplications(c, id),
          V.relatedGroup(c, [{ typeKey: 'representationElement', field: 'ownerId', id: id }]),
        ].filter(function (node) { return node !== null; });
        var related = blocks.length ? core.el('div', {}, blocks) : null;
        return V.detailView(c, { type: 'component', entity: row.entity, related: related });
      },
    });
  }

  /**
   * The threats applied to a target, as read-only context inside the detail.
   *
   * Read-only on purpose: applying a threat to a component is a Threats-tab action with a target
   * picker that shows what it is about to point at, and repeating a reduced version of it here would
   * give the same write two entry points with different affordances.
   */
  function relatedApplications(ctx, targetId) {
    var applied = M.threatsForTarget(ctx.model, 'component', targetId);
    if (!applied.length) return null;
    return core.el('section', { class: 'tmv-detail__related' }, [
      core.el('h4', {
        class: 'tmv-detail__related-title',
        text: core.plural(applied.length, 'threat applied here', 'threats applied here'),
      }),
      core.el('ul', { class: 'tmv-dialog__list' }, applied.map(function (pair) {
        var state = core.el('span', { class: 'tmv-related__state' });
        var chip = V.stateTag(pair.application.state);
        if (chip) state.appendChild(chip);
        return core.el('li', {}, [
          core.el('span', { text: M.labelOf(pair.threat) }),
          core.el('span', { class: 'tmv-muted', text: ' ' }),
          state,
        ]);
      })),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Actors
  // ---------------------------------------------------------------------------------------------

  var ACTORS_NOTE = 'Actors are the people and systems that interact with the model. A flow may start at one.';

  function actorsSection(ctx) {
    var rows = rowsOf(ctx, 'actor', function (a) {
      return [a.name, a.type, (a.permissions || []).join(' '), a.id].join(' ');
    });
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i].entity;
      rows[i].type = a.type || '';
      rows[i].zone = V.labelFrom(ctx.model, a.trustZoneId);
      rows[i].permissions = core.isArray(a.permissions) ? a.permissions : [];
    }

    return V.listSection(ctx, 'Actors', ACTORS_NOTE, {
      key: 'architecture.actors',
      type: 'actor',
      entityRows: rows,
      plural: 'actors',
      singular: 'actor',
      pageSizes: [10, 25, 50],
      addLabel: 'Add actor',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'type',
          label: 'Actor type',
          options: V.optionsFromVocab('actorType'),
          test: function (row, value) { return row.type === value; },
        },
        {
          id: 'zone',
          label: 'Trust zone',
          options: V.distinctOptions(rows, function (row) { return row.zone; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.zone; }); },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'actor') });
        } },
        { key: 'type', label: 'Type', sortable: true, render: function (row) {
          return row.type ? core.el('span', { text: V.vocabLabel('actorType', row.type) }) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'zone', label: 'Trust zone', sortable: true, render: function (row) {
          return row.zone || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'permissions', label: 'Permissions', render: function (row) {
          return row.permissions.length ? V.tagList(row.permissions) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
      ],
      empty: {
        title: 'No actors',
        body:
          'Nothing in this model has a person or system on the outside of it. Actors are TML-only; an ' +
          'OTM model that starts its flows at components will have an empty section here.',
      },
      filteredEmpty: {
        title: 'No actors match these filters',
        body: 'This model has actors; none of them match what is selected.',
      },
      detail: function (c, row) { return V.detailView(c, { type: 'actor', entity: row.entity }); },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Data stores
  // ---------------------------------------------------------------------------------------------

  var STORES_NOTE =
    'A data store holds data sets. The placement — which data set sits in which store, and whether it ' +
    'is encrypted there — is recorded on the data set, so it is shown from both ends: here, and in ' +
    'the Data tab’s Placement section.';

  function dataStoresSection(ctx) {
    var rows = rowsOf(ctx, 'dataStore', function (d) {
      return [d.name, d.type, d.vendor, d.product, d.id].join(' ');
    });
    var dataSets = M.collection(ctx.model, 'dataSet');
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i].entity;
      rows[i].type = d.type || '';
      rows[i].zone = V.labelFrom(ctx.model, d.trustZoneId);
      // Which data sets are placed here, and whether each placement is encrypted. That is the join
      // the Data tab's Placement section reads the other way round; showing the count here is what
      // makes an empty data store visible as an empty data store.
      rows[i].holds = [];
      rows[i].unencrypted = 0;
      for (var s = 0; s < dataSets.length; s++) {
        var placements = core.isArray(dataSets[s].placements) ? dataSets[s].placements : [];
        for (var p = 0; p < placements.length; p++) {
          if (placements[p].dataStoreId !== d.id) continue;
          rows[i].holds.push(dataSets[s]);
          if (placements[p].encrypted !== true) rows[i].unencrypted++;
        }
      }
    }

    return V.listSection(ctx, 'Data Stores', STORES_NOTE, {
      key: 'architecture.stores',
      type: 'dataStore',
      entityRows: rows,
      plural: 'data stores',
      singular: 'data store',
      pageSizes: [10, 25, 50],
      addLabel: 'Add data store',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'type',
          label: 'Store type',
          options: V.optionsFromVocab('dataStoreType'),
          test: function (row, value) { return row.type === value; },
        },
        {
          id: 'zone',
          label: 'Trust zone',
          options: V.distinctOptions(rows, function (row) { return row.zone; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.zone; }); },
        },
        {
          id: 'holds',
          label: 'Contents',
          options: [
            { value: 'any', label: 'Holds at least one data set' },
            { value: 'none', label: 'Holds nothing' },
            { value: 'unencrypted', label: 'Holds an unencrypted data set' },
          ],
          test: function (row, value) {
            if (value === 'any') return row.holds.length > 0;
            if (value === 'none') return row.holds.length === 0;
            return row.unencrypted > 0;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'dataStore') });
        } },
        { key: 'type', label: 'Type', sortable: true, render: function (row) {
          return row.type ? core.el('span', { text: V.vocabLabel('dataStoreType', row.type) }) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'zone', label: 'Trust zone', sortable: true, render: function (row) {
          return row.zone || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'vendor', label: 'Vendor', sortable: true, render: function (row) {
          return row.entity.vendor || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'holds', label: 'Data sets', numeric: true, sortable: true, render: function (row) {
          if (!row.holds.length) return core.el('span', { class: 'tmv-muted', text: '0' });
          if (!row.unencrypted) return core.el('span', { text: String(row.holds.length) });
          return core.el('span', { class: 'tmv-cell-note', text: String(row.holds.length) + ' (' + row.unencrypted + ' unencrypted)' });
        } },
      ],
      empty: {
        title: 'No data stores',
        body:
          'This model declares no place where data rests. Data stores are TML-only, and a data set ' +
          'may exist without a placement — which the Data tab reports as its own finding.',
      },
      filteredEmpty: {
        title: 'No data stores match these filters',
        body: 'This model has data stores; none of them match what is selected.',
      },
      detail: function (c, row) {
        var list = row.holds.length
          ? core.el('ul', { class: 'tmv-dialog__list' }, row.holds.map(function (set) {
              return core.el('li', { text: M.labelOf(set) });
            }))
          : core.el('p', { class: 'tmv-muted', text: 'No data set is placed in this store.' });
        var related = core.el('section', { class: 'tmv-detail__related' }, [
          core.el('h4', { class: 'tmv-detail__related-title', text: 'Data sets placed here' }),
          list,
        ]);
        return V.detailView(c, { type: 'dataStore', entity: row.entity, related: related });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Diagram
  // ---------------------------------------------------------------------------------------------

  /**
   * The Diagram section is a host for `14-diagrams.js`, not a renderer of its own.
   *
   * That module owns the whole problem — choosing between a canvas representation and source text,
   * sanitising whatever Mermaid produces, and cloning the pinned loader out of its inert template
   * (REQ-SEC-002) — and a tab that reimplemented any part of it would be a second place for the
   * sanitising rules to be wrong.
   */
  function diagramSection(ctx) {
    var root = core.el('div', { class: 'tmv-section tmv-section--diagram' }, [
      V.sectionHeading(
        ctx,
        'Diagram',
        'A rendered view of what this model declares. Nothing here is drawn by hand — an OTM ' +
          'model supplies coordinates, a TML model supplies source text, and both are rendered from ' +
          'the file.'
      ),
    ]);
    root.appendChild(TMV.diagrams.panel(ctx.model));
    return root;
  }

  // ---------------------------------------------------------------------------------------------

  var SECTIONS = {
    'trust-zones': trustZonesSection,
    'trust-boundaries': trustBoundariesSection,
    components: componentsSection,
    actors: actorsSection,
    'data-stores': dataStoresSection,
    diagram: diagramSection,
  };

  function render(ctx) {
    var build = SECTIONS[ctx.section] || SECTIONS['trust-zones'];
    return build(ctx);
  }

  /**
   * No section on this tab is a finding, so no count is meaningful.
   *
   * Returning `{}` rather than `null` is deliberate: `null` is what a *failed* count produces
   * (`17-shell.js`'s `countsFor` swallows the error and returns null), and the two would be
   * indistinguishable in the side nav if a later change made one of these a finding.
   */
  function counts() {
    return {};
  }

  TMV.shell.register({ id: 'architecture', title: 'Architecture', render: render, counts: counts });
})(globalThis.TMV = globalThis.TMV || {});
