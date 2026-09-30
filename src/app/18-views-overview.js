/**
 * Overview — `07-ui.md` §2 and §3, `03-data-model.md` §3.
 * Requirements: REQ-VIEW-001, REQ-VIEW-003, REQ-VIEW-007, REQ-IMP-006, REQ-EXP-003.
 *
 * Five sections, and the grouping is deliberate rather than merely alphabetical:
 *
 *   Summary          what this model is, at a glance, and what is in it
 *   Scope            the model's own statement of what it covers — TML's `scope`, which OTM has no
 *                    equivalent of, and which the canonical model keeps because it is the richer of
 *                    the two (`03-data-model.md` §3.1)
 *   Contributors     who is named as having worked on it, which is *not* the same as who committed
 *                    to it — see the note on the Contributors section
 *   Export Readiness the one screen showing both formats' gaps at once (§3), which is why it lives
 *                    here and not in the export dialog alone
 *   Provenance       where the model came from, from the record the import path wrote (REQ-IMP-006)
 *
 * Two things this tab deliberately does not do.
 *
 * **It does not claim a model is valid.** It reports what is present and what an export would need;
 * `03-data-model.md` §6's validation report belongs to the import screen, where a document arrives
 * from outside and its problems are the point. A live model's "problems" are a to-do list, and that
 * is what Export Readiness says instead.
 *
 * **It does not conflate contributors with commits.** The metadata contributors list is a claim made
 * in the file by whoever wrote the file; the history records who committed, self-asserted, and
 * ADR-0008 is explicit that authorship is not verified. The two lists are shown as what they are —
 * one is the model's own statement, the other is the chain — and neither is presented as a record of
 * who really did anything.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  var ID = 'overview';

  // ---------------------------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------------------------

  /**
   * The model's own fields, for the heading of the screen that shows them (REQ-EDIT-011).
   *
   * Returned as a node rather than wired here, because the tab's click handling is one delegated
   * listener in `wire` — a listener per button would be one more thing to keep in step with the shell
   * rebuilding this node on every render.
   */
  function editButton() {
    return widgets.button({
      label: 'Edit model details',
      kind: 'tertiary',
      size: 'sm',
      action: 'edit-model',
      title: 'Change the model’s name and description',
    });
  }

  function summarySection(ctx) {
    var root = core.el('div', { class: 'tmv-overview' });
    var model = ctx.model;

    // Absent when the model is read-only, rather than present and dead (§9, REQ-VIEW-008). The model's
    // name is the heading of this screen, which makes this the first place someone looks to change it.
    root.appendChild(V.sectionHeading(
      ctx,
      model.name || 'Untitled threat model',
      null,
      ctx.editable ? editButton() : null,
    ));

    if (core.present(model.description)) {
      root.appendChild(core.el('p', { class: 'tmv-model__description', text: model.description }));
    }

    var counts = M.counts(model);
    root.appendChild(V.definitionSection(ctx, {
      title: 'At a glance',
      pairs: [
        { term: 'Model id', value: core.el('code', { class: 'tmv-code', text: String(model.modelId || '') }) },
        { term: 'Format version', value: String(model.tmvFormat || '') },
        { term: 'Entities', value: String(counts.total) },
        { term: 'Commits', value: String(ctx.history && core.isArray(ctx.history.commits) ? ctx.history.commits.length : 0) },
        { term: 'Head', value: ctx.history && ctx.history.head ? core.el('code', { class: 'tmv-code', text: core.shortId(ctx.history.head) }) : 'No commits yet' },
        { term: 'Working copy', value: ctx.editable ? (ctx.state.dirty ? 'Has uncommitted changes' : 'Matches the head commit') : 'Read-only' },
        { term: 'Source', value: ctx.state.source === 'file' ? 'The model embedded in this file' : 'A copy stored in this browser' },
      ],
    }));

    if (!counts.total) {
      root.appendChild(V.emptyModel(ctx, { add: false }));
      return root;
    }

    root.appendChild(core.el('h3', { class: 'tmv-subhead', text: 'What is in this model' }));
    root.appendChild(contentsTable(ctx, counts));
    return root;
  }

  /** A count per entity type, with a link to the tab that shows them and nothing where there are none. */
  function contentsTable(ctx, counts) {
    var rows = [];
    for (var i = 0; i < M.TYPES.length; i++) {
      var spec = M.TYPES[i];
      var n = counts[spec.key] || 0;
      var link = tabForEntity(spec.key);
      rows.push({
        id: spec.key,
        cells: [
          core.el('span', { class: 'tmv-detail__key' }, [
            link
              ? core.el('button', {
                  type: 'button',
                  class: 'tmv-link-button',
                  'data-action': 'go-section',
                  'data-tab': link.tab,
                  'data-section': link.section,
                  text: spec.plural,
                })
              : core.el('span', { text: spec.plural }),
          ]),
          core.el('span', { class: n ? 'tmv-count' : 'tmv-count tmv-count--zero', text: String(n) }),
        ],
      });
    }
    return widgets.structuredList({ label: 'Contents', rows: rows });
  }

  /**
   * Where a type's list lives, for the cross-links.
   *
   * Written out rather than derived, because the mapping is a design decision (`07-ui.md` §3's
   * side-nav table) and not a rule: threats are under Threats, but threat *applications* are a join
   * entity with no side-nav entry of their own and belong on By Target, which is the section that
   * shows them in context.
   */
  var TYPE_SECTION = {
    trustZones: { tab: 'architecture', section: 'trust-zones' },
    trustBoundaries: { tab: 'architecture', section: 'trust-boundaries' },
    components: { tab: 'architecture', section: 'components' },
    actors: { tab: 'architecture', section: 'actors' },
    dataStores: { tab: 'architecture', section: 'data-stores' },
    dataSets: { tab: 'data', section: 'data-sets' },
    assets: { tab: 'data', section: 'assets' },
    dataFlows: { tab: 'flows', section: 'all-flows' },
    threats: { tab: 'threats', section: 'all-threats' },
    threatPersonas: { tab: 'threats', section: 'personas' },
    threatApplications: { tab: 'threats', section: 'by-target' },
    controls: { tab: 'controls', section: 'all-controls' },
    risks: { tab: 'risk', section: 'risk-register' },
    mitigationPlans: { tab: 'controls', section: 'mitigation-plans' },
    assumptions: { tab: 'threats', section: 'assumptions' },
    diagrams: { tab: 'architecture', section: 'diagram' },
    representations: { tab: 'architecture', section: 'diagram' },
    representationElements: { tab: 'architecture', section: 'diagram' },
  };

  function tabForEntity(key) {
    return TYPE_SECTION[key] || null;
  }

  // ---------------------------------------------------------------------------------------------
  // Scope
  // ---------------------------------------------------------------------------------------------

  function scopeSection(ctx) {
    var scope = core.isObject(ctx.model.scope) ? ctx.model.scope : Object.create(null);
    var metadata = core.isObject(ctx.model.metadata) ? ctx.model.metadata : Object.create(null);
    var root = core.el('div', {});

    root.appendChild(V.sectionHeading(
      ctx,
      'Scope',
      'The model’s own statement of what it covers. TML carries these fields and OTM has no ' +
        'equivalent, so a model imported from OTM shows them empty — which is a fact about the source ' +
        'document, not something missing from this screen.',
    ));

    root.appendChild(V.definitionSection(ctx, {
      title: 'Scope',
      empty: {
        title: 'No scope is recorded',
        body:
          'This model does not state what it covers. That is legal in both interchange formats — the ' +
          'fields are optional everywhere they appear — but a threat model without a stated scope is ' +
          'hard for a reader to judge, so it is worth filling in before exporting.',
      },
      pairs: [
        { term: 'Title', value: scope.title },
        { term: 'Description', value: scope.description },
        { term: 'Business criticality', value: V.vocabLabel('businessCriticality', scope.businessCriticality) },
        { term: 'Data sensitivity', value: core.isArray(scope.dataSensitivity) && scope.dataSensitivity.length
            ? V.tagList(scope.dataSensitivity)
            : null },
        { term: 'Exposure', value: V.vocabLabel('exposure', scope.exposure) },
        { term: 'Tier', value: V.vocabLabel('tier', scope.tier) },
      ],
    }));

    root.appendChild(core.el('h3', { class: 'tmv-subhead', text: 'Model metadata' }));
    root.appendChild(V.definitionSection(ctx, {
      title: 'Metadata',
      empty: {
        title: 'No metadata is recorded',
        body: 'Owner, release and review fields are all optional. An empty set here is normal for a model that has not been published.',
      },
      pairs: [
        { term: 'Owner', value: metadata.owner },
        { term: 'Owner contact', value: metadata.ownerContact },
        { term: 'Tags', value: core.isArray(metadata.tags) && metadata.tags.length ? V.tagList(metadata.tags) : null },
        { term: 'Repository', value: linkValue(metadata.repoLink) },
        { term: 'Release docs', value: linkValue(metadata.releaseDocsLink) },
        { term: 'Released at', value: metadata.releasedAt },
        { term: 'Product release date', value: metadata.productReleaseDate },
        { term: 'Reviewed at', value: metadata.reviewedAt },
        { term: 'Model version', value: metadata.version },
        { term: 'Frozen', value: metadata.frozen === true ? core.el('span', { text: 'Yes — the source format marks this model frozen' }) : null },
      ],
    }));
    return root;
  }

  /** A URI rendered as a link only when `core.safeUrl` accepts it; otherwise as plain text. */
  function linkValue(value) {
    if (!core.present(value)) return null;
    var safe = core.safeUrl(value);
    if (!safe) return core.el('span', { text: String(value) });
    return core.el('a', { href: safe, rel: 'noreferrer noopener', target: '_blank', text: String(value) });
  }

  // ---------------------------------------------------------------------------------------------
  // Contributors
  // ---------------------------------------------------------------------------------------------

  function contributorsSection(ctx) {
    var metadata = core.isObject(ctx.model.metadata) ? ctx.model.metadata : Object.create(null);
    var list = core.isArray(metadata.contributors) ? metadata.contributors : [];
    var root = core.el('div', {});

    root.appendChild(V.sectionHeading(
      ctx,
      'Contributors',
      'Named in the model’s metadata. This is the file’s own statement — it travels with the model ' +
        'through both interchange formats’ extension points, and nothing here is verified.',
    ));

    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var person = list[i];
      if (!core.isObject(person)) continue;
      rows.push({
        id: 'contributor-' + i,
        cells: [
          core.el('span', { class: 'tmv-detail__key', text: person.name === undefined || person.name === null ? '(unnamed)' : String(person.name) }),
          core.el('span', { text: person.email === undefined || person.email === null ? '' : String(person.email) }),
          core.el('span', { text: person.role === undefined || person.role === null ? '' : String(person.role) }),
        ],
      });
    }

    if (!rows.length) {
      root.appendChild(V.emptySection({
        title: 'No contributors are named',
        body:
          'The metadata carries no contributor list. Contributors are a canonical-only field: neither ' +
          'interchange format has a home for them, so a model that has only been imported will not ' +
          'have any until someone adds them. The commit log on the History tab is a different thing — ' +
          'it records who committed, self-asserted.',
      }));
      return root;
    }

    root.appendChild(widgets.structuredList({
      label: 'Contributors',
      headers: ['Name', 'Email', 'Role'],
      rows: rows,
    }));
    return root;
  }

  // ---------------------------------------------------------------------------------------------
  // Export readiness
  // ---------------------------------------------------------------------------------------------

  /**
   * Both interchange formats' gaps, in one screen (`07-ui.md` §3).
   *
   * `06-interchange.md` §8 is emphatic that a blocked export is "a to-do list, not an error", so
   * this section is written that way: it says what would stop each format and what would be filled
   * in, and it never says the model is wrong. The same list appears inside the export dialog; this is
   * where it can be read while editing.
   */
  function readinessSection(ctx) {
    var root = core.el('div', {});
    root.appendChild(V.sectionHeading(
      ctx,
      'Export Readiness',
      'What each interchange format would do with this model right now. Blocked items are things ' +
        'neither format can carry without the application inventing a value, and inventing one would ' +
        'be a false statement rather than a default.',
    ));

    var entries = TMV.exporting.readiness(ctx.model, V.exportOptions(ctx));
    for (var i = 0; i < entries.length; i++) {
      root.appendChild(readinessBlock(ctx, entries[i]));
    }

    root.appendChild(core.el('p', {
      class: 'tmv-note',
      text:
        'Values the exporter fills in are disclosed, not hidden: every synthesized value is listed in ' +
        'the export report, so a recipient can tell what the tool inferred from what the author said.',
    }));
    return root;
  }

  function readinessBlock(ctx, entry) {
    var preview = TMV.exporting.preview(ctx.model, entry.format, V.exportOptions(ctx));
    var tone = entry.ok ? (entry.lossy ? 'warning' : 'success') : 'error';
    var root = core.el('section', { class: 'tmv-readiness tmv-readiness--' + tone });

    root.appendChild(core.el('h3', { class: 'tmv-readiness__title' }, [
      core.el('span', { text: entry.label }),
      widgets.tag({
        text: entry.ok ? (entry.lossy ? 'Exports with loss' : 'Exports without loss') : 'Needs attention',
        type: entry.ok ? (entry.lossy ? 'magenta' : 'green') : 'red',
      }),
    ]));
    root.appendChild(core.el('p', { class: 'tmv-readiness__summary', text: entry.summary }));

    if (preview.blocked.length) {
      root.appendChild(core.el('h4', { class: 'tmv-subhead', text: 'Before this can be exported' }));
      var list = core.el('ul', { class: 'tmv-dialog__list' });
      for (var i = 0; i < preview.blocked.length && i < 40; i++) {
        list.appendChild(blockedItem(ctx, preview.blocked[i]));
      }
      if (preview.blocked.length > 40) {
        list.appendChild(core.el('li', { text: 'and ' + (preview.blocked.length - 40) + ' more' }));
      }
      root.appendChild(list);
    }

    if (preview.lossiness.lossless === false) {
      root.appendChild(core.el('h4', { class: 'tmv-subhead', text: 'What will not survive' }));
      var losses = core.el('ul', { class: 'tmv-dialog__list' });
      var lossEntries = preview.lossiness.entries;
      for (var j = 0; j < lossEntries.length && j < 40; j++) {
        losses.appendChild(core.el('li', {
          text: lossEntries[j].count + ' × ' + lossEntries[j].describe + (lossEntries[j].field ? ' (' + lossEntries[j].field + ')' : ''),
        }));
      }
      if (lossEntries.length > 40) {
        losses.appendChild(core.el('li', { text: 'and ' + (lossEntries.length - 40) + ' more kinds of loss' }));
      }
      root.appendChild(losses);
      root.appendChild(core.el('p', {
        class: 'tmv-note',
        text: 'Loss here is the format’s, not the application’s: the value has no home in that schema, and it is still in this model.',
      }));
    }

    if (preview.synthesized.length) {
      root.appendChild(core.el('h4', { class: 'tmv-subhead', text: 'Values that will be filled in' }));
      var synth = core.el('ul', { class: 'tmv-dialog__list' });
      for (var k = 0; k < preview.synthesized.length && k < 40; k++) {
        var s = preview.synthesized[k];
        synth.appendChild(core.el('li', {
          text: (core.present(s.message) ? s.message : describeSynthesis(s)),
        }));
      }
      if (preview.synthesized.length > 40) {
        synth.appendChild(core.el('li', { text: 'and ' + (preview.synthesized.length - 40) + ' more' }));
      }
      root.appendChild(synth);
    }

    return root;
  }

  function describeSynthesis(entry) {
    if (!core.isObject(entry)) return String(entry);
    var where = core.present(entry.id) ? '“' + entry.id + '”' : core.present(entry.entity) ? entry.entity : 'a value';
    var what = core.present(entry.field) ? entry.field : 'a required field';
    return where + ': ' + what + ' is not set, and the format requires one.';
  }

  /** One blocked item: what it is, and the fix. §8 says each names the entity, the field, and the fix. */
  function blockedItem(ctx, entry) {
    var children = [core.el('span', { text: entry.message || String(entry) })];
    var where = [];
    if (core.present(entry.entity)) {
      var spec = M.typeFor(entry.entity);
      where.push(spec ? spec.label : String(entry.entity));
    }
    if (core.present(entry.id)) where.push(entry.id);
    if (core.present(entry.field)) where.push(entry.field);
    if (where.length) {
      children.push(core.el('span', { class: 'tmv-readiness__where', text: ' — ' + where.join(' · ') }));
    }
    return core.el('li', {}, children);
  }

  // ---------------------------------------------------------------------------------------------
  // Provenance
  // ---------------------------------------------------------------------------------------------

  /**
   * Where the model came from (REQ-IMP-006, `06-interchange.md` §9).
   *
   * The record describes **the hop that produced this model**, and it is regenerated on every import
   * rather than accumulated — so this screen shows one hop, and the history is where lineage lives.
   * Saying so matters: a user who imported a model that had already been through two other tools
   * should not read a single record as the whole story.
   */
  function provenanceSection(ctx) {
    var root = core.el('div', {});
    var record = TMV.importing.readProvenance(ctx.model);

    root.appendChild(V.sectionHeading(
      ctx,
      'Provenance',
      'The record written when this model was last imported. It describes one hop through one tool, ' +
        'not a lineage — earlier hops are in the history, where ancestry belongs.',
    ));

    if (!record) {
      root.appendChild(V.emptySection({
        title: 'This model was not imported',
        body:
          'No import record is attached. Either the model was created in this application, or it came ' +
          'from a document written before provenance was recorded. Nothing is wrong — there is simply ' +
          'nothing to say about where it came from.',
      }));
      root.appendChild(rootCommit(ctx));
      return root;
    }

    root.appendChild(V.definitionSection(ctx, {
      title: 'Import record',
      pairs: [
        { term: 'Source format', value: record.format },
        { term: 'Source file', value: record.filename ? String(record.filename) : null },
        { term: 'Source content hash', value: record.sourceHash ? core.el('code', { class: 'tmv-code', text: String(record.sourceHash) }) : null },
        { term: 'Imported at', value: core.present(record.importedAt) ? core.formatDateTime(record.importedAt) || String(record.importedAt) : null },
        { term: 'Imported by', value: record.tool ? String(record.tool) + (record.toolVersion ? ' ' + record.toolVersion : '') : null },
        { term: 'Container', value: record.container === 'exported-html' ? 'An exported HTML file' : null },
      ],
    }));

    if (record.format && String(record.format).indexOf('tml') === 0) {
      root.appendChild(core.el('p', {
        class: 'tmv-note',
        text:
          'This model came from TML, which has no identifier field of its own. The application keeps ' +
          'its identity in this record so that re-importing the file recognises the model rather than ' +
          'offering to create a duplicate.',
      }));
    }

    root.appendChild(rootCommit(ctx));
    return root;
  }

  /**
   * The root commit, which is where the file's own account of its origin lives.
   *
   * REQ-IMP-005 gives the root commit a message naming the source file, so this is the one place the
   * lineage is stated by the history rather than by a bag.
   */
  function rootCommit(ctx) {
    var commits = ctx.history && core.isArray(ctx.history.commits) ? ctx.history.commits : [];
    var root = null;
    for (var i = 0; i < commits.length; i++) {
      if (commits[i] && core.isArray(commits[i].parents) && commits[i].parents.length === 0) {
        root = commits[i];
        break;
      }
    }
    if (!root) return core.el('div', {});
    return core.el('section', { class: 'tmv-provenance__root' }, [
      core.el('h3', { class: 'tmv-subhead', text: 'The first commit' }),
      widgets.structuredList({
        label: 'Root commit',
        rows: V.definitionRows([
          { term: 'Message', value: root.message },
          { term: 'Commit', value: core.el('code', { class: 'tmv-code', text: core.shortId(root.id) }) },
          { term: 'Author', value: root.author && core.present(root.author.name) ? String(root.author.name) : 'Not recorded' },
          { term: 'Recorded at', value: root.timestamp ? core.formatDateTime(root.timestamp) || String(root.timestamp) : null },
        ]),
      }),
    ]);
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The cross-links on this tab are the only actions it owns that are not about its own entities, so
   * they are wired on the node this render produced. The shell rebuilds `#tmv-content` on every
   * render, which means the listener goes with the node it was attached to — there is nothing to
   * detach and nothing that can outlive what it points at.
   */
  function wire(root, ctx) {
    core.delegate(root, 'click', function (event, node) {
      var action = node.getAttribute('data-action');
      if (action === 'go-section') ctx.go(node.getAttribute('data-tab'), node.getAttribute('data-section'));
      else if (action === 'go-import') ctx.go('settings', 'import');
      else if (action === 'go-diagram') ctx.go('architecture', 'diagram');
      else if (action === 'edit-model') ctx.shell.editModelDetails();
    });
    // `core.delegate` returns the *remover*, not the node — returning its result from a render would
    // hand the shell a function to append, which is a bug that only shows up in a real DOM.
    return root;
  }

  function render(ctx) {
    if (!core.isObject(ctx.model)) {
      return V.emptySection({ title: 'No model is open', body: 'There is nothing to show.' });
    }
    var node;
    switch (ctx.section) {
      case 'scope':
        node = scopeSection(ctx);
        break;
      case 'contributors':
        node = contributorsSection(ctx);
        break;
      case 'export-readiness':
        node = readinessSection(ctx);
        break;
      case 'provenance':
        node = provenanceSection(ctx);
        break;
      case 'summary':
      default:
        node = summarySection(ctx);
        break;
    }
    return wire(node, ctx);
  }

  /**
   * The side nav's counts. Only Export Readiness is a `finding` entry on this tab, and §3 says a
   * filter's count is what makes it read as a finding — so it is the number of items that would stop
   * one of the two exports, which is the number the user can act on.
   */
  function counts(ctx) {
    var blocked = 0;
    try {
      var entries = TMV.exporting.readiness(ctx.model, V.exportOptions(ctx));
      for (var i = 0; i < entries.length; i++) blocked += entries[i].blocked;
    } catch (err) {
      return Object.create(null);
    }
    var out = Object.create(null);
    out['export-readiness'] = blocked;
    return out;
  }

  TMV.shell.register({
    id: ID,
    title: 'Overview',
    render: render,
    counts: counts,
  });
})(globalThis.TMV = globalThis.TMV || {});
