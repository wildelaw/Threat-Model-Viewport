/*
 * 18-views-data.js — the Data tab.
 *
 * Sections (`07-ui.md` §3): Data Sets · Assets · Sensitivity · Placement.
 *
 * The tab's whole subject is one fact that the two interchange formats express in two places at
 * once: TML records *where data rests* as a placement on the data set, and records *what the data is
 * worth* as an asset with confidentiality, integrity and availability ratings. Neither format makes
 * the other derivable, so the tab shows both and never infers one from the other.
 *
 * Three decisions:
 *
 * 1. **Sensitivity is a finding with a stated rule, not a score.** A data set is sensitive because
 *    its own `dataSensitivity` says so — the application does not guess a class from a name, and it
 *    does not rate anything. What makes the section a *finding* is the specific, checkable gap: a
 *    regulated data set sitting somewhere the model does not say is encrypted, or a regulated data
 *    set with no placement at all. The rule is printed on the screen so a user can disagree with it.
 *
 * 2. **Placement is a join table, and its rows are keyed by the pair.** One data set in three stores
 *    is three rows, so a row cannot be identified by the data set's id — the shared kit's `__key`
 *    exists for exactly this, and without it expanding one row would expand all of them.
 *
 * 3. **Unrated is not the same as zero.** An asset with no confidentiality rating is not an asset
 *    with zero confidentiality; it is one nobody has rated. The columns say "Not rated" rather than
 *    printing a number, and CIA Ratings on the Risk tab is where that gap is counted.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  /**
   * The classes this application treats as regulated, for the Sensitivity finding only.
   *
   * `pii`, `phi`, `pci`, `cred`, `fin` and `gov` are the ones with an outside authority behind them.
   * `ip`, `biz` and `op` are real and often valuable, but calling them regulated would be the
   * application inventing a rule that neither format states — so they are shown, tagged, and left out
   * of the finding. The list is here, in one place, and the section prints it.
   */
  var REGULATED = ['pii', 'phi', 'pci', 'cred', 'fin', 'gov'];

  function isRegulated(dataSet) {
    var classes = core.isArray(dataSet.dataSensitivity) ? dataSet.dataSensitivity : [];
    for (var i = 0; i < classes.length; i++) {
      if (REGULATED.indexOf(classes[i]) !== -1) return true;
    }
    return false;
  }

  function placementsOf(dataSet) {
    return core.isArray(dataSet.placements) ? dataSet.placements : [];
  }

  /** "3 stores, 1 unencrypted" — the summary a data set's placement column shows. */
  function placementSummary(dataSet) {
    var placements = placementsOf(dataSet);
    if (!placements.length) return null;
    var unencrypted = 0;
    for (var i = 0; i < placements.length; i++) {
      if (placements[i].encrypted !== true) unencrypted++;
    }
    return { count: placements.length, unencrypted: unencrypted };
  }

  // ---------------------------------------------------------------------------------------------
  // 1. Data sets
  // ---------------------------------------------------------------------------------------------

  var SETS_NOTE =
    'A data set is a kind of data this model holds. Its sensitivity classes and its placements are ' +
    'recorded on the data set itself, so both travel with it through either interchange format.';

  function dataSetsSection(ctx) {
    // Collecting `rows` first and deriving the filter options from it is the pattern the whole tab
    // uses: options come from what the model actually contains, never from a fixed list, because a
    // filter that cannot reach a value that is present reads as data that is missing.
    var rows = [];
    var list = M.collection(ctx.model, 'dataSet');
    for (var i = 0; i < list.length; i++) {
      var set = list[i];
      rows.push({
        entity: set,
        __search: [set.name, (set.dataSensitivity || []).join(' '), set.id].join(' '),
        classes: core.isArray(set.dataSensitivity) ? set.dataSensitivity : [],
        placement: placementSummary(set),
        regulated: isRegulated(set),
      });
    }

    return V.listSection(ctx, 'Data Sets', SETS_NOTE, {
      key: 'data.sets',
      type: 'dataSet',
      entityRows: rows,
      plural: 'data sets',
      singular: 'data set',
      addLabel: 'Add data set',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'class',
          label: 'Sensitivity',
          options: V.optionsFromVocab('dataSensitivity'),
          test: function (row, value) { return row.classes.indexOf(value) !== -1; },
        },
        {
          id: 'regulated',
          label: 'Regulated',
          options: [
            { value: 'yes', label: 'Carries a regulated class' },
            { value: 'no', label: 'Does not' },
          ],
          test: function (row, value) { return value === 'yes' ? row.regulated : !row.regulated; },
        },
        {
          id: 'placed',
          label: 'Placement',
          options: [
            { value: 'any', label: 'Placed in at least one store' },
            { value: 'none', label: 'Not placed anywhere' },
          ],
          test: function (row, value) {
            var placed = row.placement !== null;
            return value === 'any' ? placed : !placed;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'dataSet') });
        } },
        { key: 'sensitivity', label: 'Sensitivity', render: function (row) {
          return row.classes.length ? V.tagList(row.classes) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'records', label: 'Records', numeric: true, sortable: true, render: function (row) {
          var count = row.entity.recordCount;
          if (!core.isNumber(count)) return core.el('span', { class: 'tmv-muted', text: '—' });
          return core.el('span', { text: String(count) });
        } },
        { key: 'placement', label: 'Placement', sortable: true, render: function (row) {
          if (!row.placement) return core.el('span', { class: 'tmv-muted', text: 'Not placed' });
          var text = core.plural(row.placement.count, 'store', 'stores');
          if (!row.placement.unencrypted) return core.el('span', { text: text });
          return core.el('span', { class: 'tmv-cell-note', text: text + ' · ' + row.placement.unencrypted + ' unencrypted' });
        } },
      ],
      empty: {
        title: 'No data sets',
        body:
          'Neither format requires a model to describe its data. This one describes none, so the ' +
          'Sensitivity and Placement sections have nothing to work from either.',
      },
      filteredEmpty: {
        title: 'No data sets match these filters',
        body: 'This model has data sets; none of them match what is selected.',
      },
      detail: function (c, row) {
        var here = core.el('ul', { class: 'tmv-dialog__list' }, placementsOf(row.entity).map(function (placement) {
          return core.el('li', { text: describePlacement(c, placement) });
        }));
        var related = V.relatedBlock(
          'Where this data is placed',
          placementsOf(row.entity).length ? here : null
        );
        return V.detailView(c, { type: 'dataSet', entity: row.entity, related: related });
      },
    });
  }

  /** One placement, as a sentence. The unresolved case says so rather than printing a bare id. */
  function describePlacement(ctx, placement) {
    var storeId = placement && placement.dataStoreId;
    var name = core.isString(storeId) && M.findAnywhere(ctx.model, storeId)
      ? V.labelFrom(ctx.model, storeId)
      : String(storeId);
    var where = name || 'no data store';
    if (placement && placement.encrypted === true) return where + ' — encrypted';
    if (placement && placement.encrypted === false) return where + ' — not encrypted';
    return where + ' — encryption not stated';
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Assets
  // ---------------------------------------------------------------------------------------------

  var ASSETS_NOTE =
    'An asset is an OTM idea: a thing whose loss would matter, rated for confidentiality, integrity ' +
    'and availability. It is not the same thing as a data set, and neither format derives one from ' +
    'the other, so both are listed side by side.';

  function assetsSection(ctx) {
    var rows = [];
    var list = M.collection(ctx.model, 'asset');
    for (var i = 0; i < list.length; i++) {
      var asset = list[i];
      rows.push({
        entity: asset,
        __search: [asset.name, asset.riskComment, asset.id].join(' '),
        ratings: ['confidentiality', 'integrity', 'availability'].filter(function (key) {
          return core.isNumber(asset[key]);
        }).length,
        processed: core.isArray(asset.processedByIds) ? asset.processedByIds : [],
        stored: core.isArray(asset.storedByIds) ? asset.storedByIds : [],
      });
    }

    return V.listSection(ctx, 'Assets', ASSETS_NOTE, {
      key: 'data.assets',
      type: 'asset',
      entityRows: rows,
      plural: 'assets',
      singular: 'asset',
      addLabel: 'Add asset',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'rated',
          label: 'Rating',
          options: [
            { value: 'all', label: 'All three ratings set' },
            { value: 'some', label: 'Some ratings set' },
            { value: 'none', label: 'No ratings set' },
          ],
          test: function (row, value) {
            if (value === 'all') return row.ratings === 3;
            if (value === 'some') return row.ratings > 0 && row.ratings < 3;
            return row.ratings === 0;
          },
        },
        {
          id: 'used',
          label: 'Used by',
          options: [
            { value: 'any', label: 'Processed or stored somewhere' },
            { value: 'none', label: 'Not processed or stored anywhere' },
          ],
          test: function (row, value) {
            var used = row.processed.length + row.stored.length > 0;
            return value === 'any' ? used : !used;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Name', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'asset') });
        } },
        { key: 'c', label: 'Confidentiality', numeric: true, sortable: true, render: ratingCell('confidentiality') },
        { key: 'i', label: 'Integrity', numeric: true, sortable: true, render: ratingCell('integrity') },
        { key: 'a', label: 'Availability', numeric: true, sortable: true, render: ratingCell('availability') },
        { key: 'processed', label: 'Processed by', render: function (row) {
          return namesOrDash(ctx.model, row.processed);
        } },
        { key: 'stored', label: 'Stored by', render: function (row) {
          return namesOrDash(ctx.model, row.stored);
        } },
      ],
      empty: {
        title: 'No assets',
        body:
          'Assets are OTM-only. A TML model describes its data as data sets with placements instead, ' +
          'which is what the Data Sets section above shows.',
      },
      filteredEmpty: {
        title: 'No assets match these filters',
        body: 'This model has assets; none of them match what is selected.',
      },
      detail: function (c, row) { return V.detailView(c, { type: 'asset', entity: row.entity }); },
    });
  }

  /**
   * A CIA rating cell.
   *
   * "Not rated" rather than a dash, and never a zero: the difference between a rating nobody has
   * given and a rating of zero availability is the difference between a gap and a catastrophic
   * finding, and a table that rendered both as `0` would be actively misleading.
   */
  function ratingCell(key) {
    return function (row) {
      var value = row.entity[key];
      if (!core.isNumber(value)) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
      return core.el('span', { text: String(value) });
    };
  }

  function namesOrDash(model, ids) {
    if (!ids.length) return core.el('span', { class: 'tmv-muted', text: '—' });
    var names = [];
    for (var i = 0; i < ids.length; i++) {
      var name = V.labelFrom(model, ids[i]);
      names.push(name === null ? core.el('span', { class: 'tmv-unresolved__id', text: String(ids[i]) }) : name);
    }
    var wrap = core.el('span', { class: 'tmv-ref-list' });
    for (var n = 0; n < names.length; n++) {
      if (n) wrap.appendChild(core.text(', '));
      if (core.isString(names[n])) wrap.appendChild(core.el('span', { text: names[n] }));
      else wrap.appendChild(names[n]);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Sensitivity — the finding
  // ---------------------------------------------------------------------------------------------

  var SENSITIVITY_NOTE =
    'This section applies one rule: a data set that declares a regulated sensitivity class should ' +
    'have a placement that says it is encrypted, or should have a placement at all. Everything the ' +
    'rule flags is listed, with the rule it was judged by — nothing here is a score, and nothing has ' +
    'been inferred from a name.';

  function sensitivityRows(ctx) {
    var rows = [];
    var list = M.collection(ctx.model, 'dataSet');
    for (var i = 0; i < list.length; i++) {
      var set = list[i];
      if (!isRegulated(set)) continue;
      var placements = placementsOf(set);
      if (!placements.length) {
        rows.push({
          entity: set,
          __key: 'unplaced:' + set.id,
          kind: 'unplaced',
          kindLabel: 'No placement recorded',
          detailText:
            'This data set declares ' + classList(set) + ' and the model does not say where it is ' +
            'stored. That is not proof it is unprotected — it is the absence of a statement either way.',
        });
        continue;
      }
      for (var p = 0; p < placements.length; p++) {
        if (placements[p].encrypted === true) continue;
        rows.push({
          entity: set,
          __key: 'unencrypted:' + set.id + '@' + String(placements[p].dataStoreId),
          kind: 'unencrypted',
          kindLabel: 'Not encrypted where it rests',
          placement: placements[p],
          detailText:
            describePlacement(ctx, placements[p]) + '. This data set declares ' + classList(set) + '.',
        });
      }
    }
    return rows;
  }

  function classList(set) {
    var classes = core.isArray(set.dataSensitivity) ? set.dataSensitivity : [];
    var names = [];
    for (var i = 0; i < classes.length; i++) names.push(V.vocabLabel('dataSensitivity', classes[i]));
    return names.join(', ');
  }

  function sensitivitySection(ctx) {
    var rows = sensitivityRows(ctx);

    if (!rows.length) {
      var sets = M.collection(ctx.model, 'dataSet');
      if (!sets.length) {
        return V.section(ctx, 'Sensitivity', SENSITIVITY_NOTE, V.emptySection({
          title: 'Nothing to check',
          body:
            'This model has no data sets, so there is no sensitivity to check. The rule this section ' +
            'applies is described above it.',
        }));
      }
      return V.section(ctx, 'Sensitivity', SENSITIVITY_NOTE, V.emptySection({
        title: 'Nothing flagged',
        body:
          'Every data set in this model either carries no regulated class, or is placed with ' +
          'encryption stated. This is the rule being satisfied, not the model being verified — the ' +
          'application has checked its own rule and nothing else.',
      }));
    }

    return V.listSection(ctx, 'Sensitivity', SENSITIVITY_NOTE, {
      key: 'data.sensitivity',
      type: 'dataSet',
      entityRows: rows,
      plural: 'findings',
      singular: 'finding',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return [row.entity.name, row.kindLabel, classList(row.entity)].join(' '); },
      filters: [
        {
          id: 'kind',
          label: 'Finding',
          options: [
            { value: 'unencrypted', label: 'Not encrypted where it rests' },
            { value: 'unplaced', label: 'No placement recorded' },
          ],
          test: function (row, value) { return row.kind === value; },
        },
        {
          id: 'class',
          label: 'Sensitivity',
          options: V.optionsFromVocab('dataSensitivity'),
          test: function (row, value) {
            var classes = core.isArray(row.entity.dataSensitivity) ? row.entity.dataSensitivity : [];
            return classes.indexOf(value) !== -1;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Data set', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'dataSet') });
        } },
        { key: 'kind', label: 'Finding', sortable: true, render: function (row) {
          return core.el('span', { class: 'tmv-cell-note', text: row.kindLabel });
        } },
        { key: 'classes', label: 'Declares', render: function (row) {
          var classes = core.isArray(row.entity.dataSensitivity) ? row.entity.dataSensitivity : [];
          return V.tagList(classes);
        } },
        { key: 'where', label: 'Where it rests', render: function (row) {
          if (!row.placement) return core.el('span', { class: 'tmv-muted', text: 'Nowhere recorded' });
          var name = V.labelFrom(ctx.model, row.placement.dataStoreId);
          return name ? core.el('span', { text: name }) : core.el('span', { class: 'tmv-unresolved__id', text: String(row.placement.dataStoreId) });
        } },
      ],
      empty: { title: 'Nothing flagged' },
      filteredEmpty: {
        title: 'No findings match these filters',
        body: 'This model has findings here; none of them match what is selected.',
      },
      detail: function (c, row) {
        var related = V.relatedBlock('Why this was flagged', core.el('p', { text: row.detailText }));
        // The detail is the data set's own detail — the finding is a property of the data set in a
        // place, and showing anything else here would put a second copy of the entity on the screen.
        return V.detailView(c, { type: 'dataSet', entity: row.entity, related: related, referrers: false });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Placement — the join
  // ---------------------------------------------------------------------------------------------

  var PLACEMENT_NOTE =
    'One row per data set in a data store. This is the same information the Data Sets and Data ' +
    'Stores sections show from either end; it is here as its own table because "what is in this ' +
    'store" and "is it encrypted" are questions you ask about the pairing, not about either half of it.';

  function placementRows(ctx) {
    var rows = [];
    var sets = M.collection(ctx.model, 'dataSet');
    for (var i = 0; i < sets.length; i++) {
      var set = sets[i];
      var placements = placementsOf(set);
      for (var p = 0; p < placements.length; p++) {
        var storeId = placements[p].dataStoreId;
        var store = core.isString(storeId) ? M.get(ctx.model, 'dataStore', storeId) : null;
        rows.push({
          entity: set,
          __key: set.id + '@' + String(storeId),
          placement: placements[p],
          store: store,
          storeId: storeId,
          zone: store ? V.labelFrom(ctx.model, store.trustZoneId) : null,
          classes: core.isArray(set.dataSensitivity) ? set.dataSensitivity : [],
        });
      }
    }
    return rows;
  }

  function placementSection(ctx) {
    var rows = placementRows(ctx);
    var sets = M.collection(ctx.model, 'dataSet');

    if (!rows.length) {
      if (!sets.length) {
        return V.section(ctx, 'Placement', PLACEMENT_NOTE, V.emptySection({
          title: 'Nothing to place',
          body: 'This model has no data sets, so nothing is placed anywhere.',
        }));
      }
      return V.section(ctx, 'Placement', PLACEMENT_NOTE, V.emptySection({
        title: 'No placements recorded',
        body:
          core.plural(sets.length, 'data set is', 'data sets are') + ' declared but none has a ' +
          'placement. A placement is TML-only, so an OTM model is expected to be empty here — and a ' +
          'TML model with none has left the place its data rests unstated.',
      }));
    }

    return V.listSection(ctx, 'Placement', PLACEMENT_NOTE, {
      key: 'data.placement',
      type: 'dataSet',
      entityRows: rows,
      plural: 'placements',
      singular: 'placement',
      pageSizes: [10, 25, 50],
      searchText: function (row) {
        return [row.entity.name, row.store ? row.store.name : String(row.storeId), row.zone, row.classes.join(' ')].join(' ');
      },
      filters: [
        {
          id: 'encrypted',
          label: 'Encryption',
          options: [
            { value: 'yes', label: 'Stated as encrypted' },
            { value: 'no', label: 'Stated as not encrypted' },
            { value: 'unstated', label: 'Not stated' },
          ],
          test: function (row, value) {
            if (value === 'yes') return row.placement.encrypted === true;
            if (value === 'no') return row.placement.encrypted === false;
            return row.placement.encrypted !== true && row.placement.encrypted !== false;
          },
        },
        {
          id: 'zone',
          label: 'Trust zone',
          options: V.distinctOptions(rows, function (row) { return row.zone; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.zone; }); },
        },
        {
          id: 'resolved',
          label: 'Data store',
          options: [
            { value: 'yes', label: 'The data store is in this model' },
            { value: 'no', label: 'It is not' },
          ],
          test: function (row, value) { return value === 'yes' ? row.store !== null : row.store === null; },
        },
      ],
      columns: [
        { key: 'set', label: 'Data set', sortable: true, render: function (row) {
          // The detail behind this cell is the data set's, but the row that opens is *this* pairing.
          // Nothing is passed for the key: `V.nameCell` reads it off the row, so one data set placed
          // in three stores gives three rows that each open themselves.
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'dataSet') });
        } },
        { key: 'store', label: 'Data store', sortable: true, render: function (row) {
          if (row.store) return core.el('span', { text: V.labelFrom(ctx.model, row.storeId) });
          return core.el('span', { class: 'tmv-unresolved' }, [
            core.el('span', { class: 'tmv-unresolved__mark', 'aria-hidden': 'true', text: '!' }),
            core.el('span', { class: 'tmv-unresolved__id', text: String(row.storeId) }),
          ]);
        } },
        { key: 'zone', label: 'Trust zone', sortable: true, render: function (row) {
          return row.zone || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'encrypted', label: 'Encryption', sortable: true, render: function (row) {
          if (row.placement.encrypted === true) return core.el('span', { text: 'Encrypted' });
          if (row.placement.encrypted === false) return core.el('span', { class: 'tmv-cell-note', text: 'Not encrypted' });
          return core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'classes', label: 'Sensitivity', render: function (row) {
          return row.classes.length ? V.tagList(row.classes) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
      ],
      empty: { title: 'No placements recorded' },
      filteredEmpty: {
        title: 'No placements match these filters',
        body: 'This model has placements; none of them match what is selected.',
      },
      detail: function (c, row) {
        var related = V.relatedBlock(
          'This placement',
          core.el('p', { text: describePlacement(c, row.placement) })
        );
        return V.detailView(c, { type: 'dataSet', entity: row.entity, related: related, referrers: false });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------

  var SECTIONS = {
    'data-sets': dataSetsSection,
    assets: assetsSection,
    sensitivity: sensitivitySection,
    placement: placementSection,
  };

  function render(ctx) {
    var build = SECTIONS[ctx.section] || SECTIONS['data-sets'];
    return build(ctx);
  }

  /**
   * Only Sensitivity is a finding, and its count is the number of rows the rule flagged.
   *
   * The count is computed by the same function the section renders from, so the number in the side
   * nav and the number of rows on the screen cannot disagree — which is the failure a user would
   * notice, and the only one worth designing against here.
   */
  function counts(ctx) {
    return { sensitivity: sensitivityRows(ctx).length };
  }

  TMV.shell.register({ id: 'data', title: 'Data', render: render, counts: counts });
})(globalThis.TMV = globalThis.TMV || {});
