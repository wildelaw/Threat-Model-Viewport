/**
 * Settings — `07-ui.md` §3, `05-storage.md` §4–§7, `08-security.md` §3 and §9.
 * Requirements: REQ-VCS-015, REQ-STORE-004, REQ-STORE-005, REQ-STORE-006, REQ-STORE-007,
 * REQ-STORE-008, REQ-UI-005,
 * REQ-UI-009, REQ-SHELL-005, REQ-SHELL-007, REQ-SEC-006, REQ-SEC-008, REQ-EXP-010, REQ-EXP-012,
 * REQ-EXP-013, REQ-IMP-001, REQ-IMP-002, REQ-IMP-003, REQ-IMP-010.
 *
 * Eight sections, and the split between them is the split between *this tool* and *this file*:
 *
 *   Identity    who commits say they are, and the one place that claim is made
 *   Storage     what this browser is holding, how to open any of it, and the only actions that
 *               remove any of it
 *   Import      getting a model in, which is the safe path and says so
 *   Export      getting a model out, which is the path that always works
 *   Diagram     what the application draws itself and what it has to fetch
 *   Appearance  theme and the side nav rail
 *   About       the disclosures `08-security.md` and REQ-SHELL-005 oblige us to make
 *   Danger Zone the one destructive action that exists, and the ones that deliberately do not
 *
 * Two things this tab deliberately does not do.
 *
 * **It does not put a settings object in front of the user's model.** Every choice here is a fact
 * about the tool — the identity on future commits, where history is cached, what the diagram loader
 * is — or about the document the user is looking at. Nothing here edits the threat model. Editing
 * belongs to the tabs that own the entities, with one exception: Danger Zone deletes this browser's
 * copy of a model, which is not an edit to the model at all.
 *
 * **It does not report a storage number it cannot stand behind.** `05-storage.md` §5 is explicit that
 * browsers do not expose remaining quota reliably, so the gauge is this application's own tally and
 * the section says so. A confident-looking percentage that is really a guess is worse than a
 * disclosed estimate, because the whole point of the number is to decide whether to act on it.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  var ID = 'settings';

  // ---------------------------------------------------------------------------------------------
  // View state
  //
  // The shell rebuilds the whole content region on every refresh, so anything that has to survive a
  // commit or a preference write cannot live in the DOM. These are the two facts this tab remembers,
  // and both are choices the user made rather than anything derived from the model.
  // ---------------------------------------------------------------------------------------------

  /** The export target the user last picked. Not a preference: it is a choice about one download. */
  var chosenFormat = null;

  /** The last export that could not be downloaded, held so the fallback survives the re-render. */
  var fallback = null;

  var SECTION_IDS = [
    'identity', 'storage', 'import', 'export', 'diagram', 'appearance', 'about', 'danger-zone',
  ];

  // ---------------------------------------------------------------------------------------------
  // Small shared pieces
  // ---------------------------------------------------------------------------------------------

  function note(text, tone) {
    return core.el('p', { class: 'tmv-note' + (tone ? ' tmv-note--' + tone : ''), text: text });
  }

  function subhead(text) {
    return core.el('h3', { class: 'tmv-subhead', text: text });
  }

  function actionRow(children) {
    return core.el('div', { class: 'tmv-settings__actions' }, children);
  }

  /**
   * A bulleted list of plain sentences.
   *
   * Every string that reaches this function is written here, in this file — never assembled from model
   * data. That is not an accident of these eight sections: the whole tab is prose about the
   * application, and prose about the application has no untrusted input. Where a model value does
   * appear below (a size, a commit count, a schema version) it goes through `text:`, which is
   * `textContent`.
   */
  function bullets(items) {
    var list = core.el('ul', { class: 'tmv-dialog__list' });
    for (var i = 0; i < items.length; i++) list.appendChild(core.el('li', { text: items[i] }));
    return list;
  }

  /**
   * Whether the working copy has changes that are not in any commit.
   *
   * Asked of the shell rather than derived here. `dirtyState` is what the header's indicator uses, and
   * it encodes a rule this view would otherwise have to know: a read-only model is never dirty, because
   * there is no path by which it could be committed. A second implementation of that rule would be a
   * second answer, and the two would disagree on exactly the read-only case where the warning matters
   * least and the confusion is greatest.
   */
  function isDirty(ctx) {
    try {
      return TMV.shell.logic.dirtyState(ctx.history, ctx.model, ctx.editable).dirty === true;
    } catch (err) {
      return false;
    }
  }

  /** The name of the history currently open, for confirmations that have to name what they touch. */
  function modelName(ctx) {
    return ctx.model && core.isString(ctx.model.name) && ctx.model.name !== ''
      ? ctx.model.name
      : 'Untitled threat model';
  }

  // ---------------------------------------------------------------------------------------------
  // Identity (REQ-VCS-015, ADR-0008, `08-security.md` §8)
  // ---------------------------------------------------------------------------------------------

  /**
   * The identity is the one piece of personal data this application holds, and it is worth being
   * precise about what it does.
   *
   * It is *self-asserted*. ADR-0008 is emphatic that the hash chain proves the content of a history
   * has not changed, not who wrote it: an author name is a string inside a commit, and anyone can put
   * any string there. `08-security.md` §8 asks for exactly one thing here — that the self-asserted
   * nature is stated *where the identity is entered*, so a user is not surprised later by a log that
   * looks like a record of authorship. That is what the first note below is for, and it is not
   * decoration.
   *
   * The second thing this section has to make visible is REQ-VCS-015's forward-only rule: changing the
   * identity affects subsequent commits only. Asserting that in prose would be weak, so the current
   * head commit's own author is shown right next to the fields — the user can see the two disagree and
   * watch the disagreement resolve on the next commit.
   */
  function identitySection(ctx) {
    var prefs = ctx.prefs || {};
    var identity = core.isObject(prefs.identity) ? prefs.identity : { name: '', email: '' };
    var body = core.el('div', { class: 'tmv-settings__block' });

    body.appendChild(note(
      'This name and email are written into every commit you make from now on. They are not checked ' +
      'against anything and they are not sent anywhere: a commit records what you said your name was, ' +
      'and the history proves the commit has not changed since — not that the named person wrote it.'
    ));

    var nameField = widgets.field({
      id: 'tmv-identity-name',
      label: 'Name recorded on commits',
      value: identity.name || '',
      hint: 'Left empty, commits record no author name. That is allowed; it is just less useful later.',
      autocomplete: 'name',
    });
    var emailField = widgets.field({
      id: 'tmv-identity-email',
      label: 'Email recorded on commits',
      type: 'email',
      value: identity.email || '',
      hint: 'Also only ever stored in this browser and in files you export.',
      autocomplete: 'email',
    });

    // Saved on `change` — that is, when the field loses focus or the form is submitted — rather than
    // on every keystroke. A per-keystroke write would put a partial name into storage and make the
    // "affects subsequent commits only" rule look as though it applied to half-typed words.
    function save(report) {
      var next = {
        identity: {
          name: core.nfc(nameField.value() || '').trim(),
          email: core.nfc(emailField.value() || '').trim(),
        },
      };
      var result = ctx.shell.persistPrefs(next);
      if (report) {
        if (!result.saved) {
          // `persistPrefs` already raises its own banner once for an unwritable browser, so this says
          // only what is specific to the identity: the change is in effect for this page.
          TMV.notify.outcome({
            level: 'info',
            title: 'Identity changed for this page',
            detail:
              'Commits made now name ' + describeIdentity(next.identity) + '. This browser is not ' +
              'keeping preferences, so the next time the file is opened it will start empty again.',
            ref: 'identity.saved',
          });
        } else {
          TMV.notify.outcome({
            level: 'success',
            title: 'Identity saved',
            detail:
              'Commits made from now on name ' + describeIdentity(next.identity) + '. Commits already ' +
              'in this history keep the author they were made with.',
            ref: 'identity.saved',
          });
        }
      }
    }

    nameField.on('change', function () { save(true); });
    emailField.on('change', function () { save(true); });

    body.appendChild(nameField.element);
    body.appendChild(emailField.element);
    body.appendChild(actionRow([
      widgets.button({ label: 'Save the identity', kind: 'primary', action: 'identity-save' }),
    ]));

    // What the history currently says, so the forward-only rule is observable rather than promised.
    var head = ctx.history ? TMV.vcs.commitById(ctx.history, ctx.history.head) : null;
    var pairs = [];
    if (head) {
      pairs.push({ term: 'Head commit', value: core.shortId(head.id) + ' — ' + oneLine(head.message) });
      pairs.push({ term: 'Authored by', value: describeIdentity(head.author) });
      pairs.push({ term: 'Recorded on the commit', value: core.formatDateTime(head.timestamp) });
      if (core.present(head.timestamp)) {
        pairs.push({ term: 'When', value: core.relativeTime(head.timestamp) });
      }
    } else {
      pairs.push({ term: 'Head commit', value: 'This history has no commits yet' });
    }
    body.appendChild(subhead('What this history already says'));
    body.appendChild(V.definitionSection(ctx, {
      title: 'The head commit’s author',
      pairs: pairs,
      empty: { title: 'No commit to read', body: 'There is no commit in this history yet.' },
    }));
    body.appendChild(note(
      'Changing the fields above does not rewrite this. A commit is hashed with the author inside it, ' +
      'so editing an old author would break the chain — and a history that silently rewrote itself ' +
      'would prove nothing at all.'
    ));

    return V.section(
      ctx,
      'Identity',
      'The author recorded on commits made from this browser. Self-asserted, stored locally, and never ' +
        'presented as proof of who wrote anything.',
      body
    );
  }

  function describeIdentity(author) {
    var name = author && core.isString(author.name) ? author.name.trim() : '';
    var email = author && core.isString(author.email) ? author.email.trim() : '';
    if (name && email) return name + ' <' + email + '>';
    if (name) return name;
    if (email) return '<' + email + '>';
    return 'nobody in particular (no name or email set)';
  }

  function oneLine(text) {
    var value = core.isString(text) ? text : '';
    return value.length > 60 ? value.slice(0, 57) + '…' : value;
  }

  // ---------------------------------------------------------------------------------------------
  // Storage (REQ-STORE-005 … REQ-STORE-008, `05-storage.md` §4–§7)
  // ---------------------------------------------------------------------------------------------

  var QUOTA_LEVEL_TEXT = {
    normal: 'There is plenty of room left.',
    elevated:
      'Past 70% of the room this browser is likely to give this page. Nothing is wrong yet, and this ' +
      'is the point to decide what to do rather than the point to be told what to do.',
    warning:
      'Past 85%. A write that needs more room than is left will fail cleanly rather than half-finish, ' +
      'but it is worth acting before that happens. The options are below, in the order to prefer them.',
    exhausted:
      'Full. The next save will fail. Nothing has been removed and nothing will be removed without you ' +
      'saying so — the options below are the way out.',
  };

  /**
   * The storage section is the honest version of "where does my work live".
   *
   * Three things are kept deliberately apart. The **gauge** is this application's own accounting, and
   * §5 says browsers do not expose remaining quota reliably — so it is labelled as an estimate.
   * The **context** is which of §4's browser rows applies, which is the single most confusing thing in
   * the product when it is left unsaid. The **models** are what is actually stored, listed with their
   * sizes because §5's third recovery option is "remove another model — the user picks", and a user
   * cannot pick without seeing.
   *
   * The list is also the second place a model can be **opened** from, which is an interpretation
   * rather than a requirement: `07-ui.md` §4 puts the switcher in the header and says nothing about
   * this screen, but REQ-STORE-004 is about switching between registry entries and this is the one
   * screen that shows them by name, size and commit count. A user who goes looking for a stored model
   * goes here, and the first version of this table offered them a Delete button and no way to reach
   * what they had just found.
   */
  function storageSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });
    var adapter = ctx.adapter;

    if (!adapter) {
      body.appendChild(V.emptySection({
        title: 'This browser is not storing anything',
        body:
          'Storage is unavailable here, so this page works entirely from the file and from memory. ' +
          'Editing, exporting and the history all work; nothing survives a reload. That is ' +
          'REQ-STORE-007 working as designed rather than a fault.',
      }));
      var contextBlock = storageContextBlock(ctx);
      if (contextBlock) body.appendChild(contextBlock);
      body.appendChild(exportInsteadBlock(ctx));
      return V.section(ctx, 'Storage', 'Where this browser keeps a copy of the model, and how to get it out.',
        body);
    }

    body.appendChild(gaugeBlock(ctx, adapter));
    var context = storageContextBlock(ctx);
    if (context) body.appendChild(context);
    body.appendChild(storageModelsBlock(ctx, adapter));
    body.appendChild(collectionBlock(ctx));
    body.appendChild(recoveryBlock(ctx));

    return V.section(
      ctx,
      'Storage',
      'The copy of this model this browser is keeping. It is a cache, not the record — the file is the ' +
        'record, which is why export is the first option below and not the last.',
      body
    );
  }

  function gaugeBlock(ctx, adapter) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    var g = null;
    try {
      g = TMV.storage.gauge(adapter);
    } catch (err) {
      g = null;
    }
    if (!g) {
      wrap.appendChild(note('The amount stored could not be measured.', 'warning'));
      return wrap;
    }

    wrap.appendChild(subhead('How much is in use'));
    wrap.appendChild(V.definitionSection(ctx, {
      title: 'Storage in use',
      pairs: [
        { term: 'Stored by this page', value: core.bytes(g.bytes) },
        { term: 'Estimated room', value: core.bytes(g.budget) },
        { term: 'Used', value: Math.round(g.ratio * 100) + '%' },
        { term: 'Keys', value: String(g.keys) },
        { term: 'Level', value: levelLabel(g.level) },
      ],
    }));

    // The bar is a visual duplicate of the percentage above it, never the only carrier of the level
    // (REQ-UI-007 AC: colour is never the sole carrier of meaning). The level is in the table.
    wrap.appendChild(core.el('div', {
      class: 'tmv-meter tmv-meter--' + g.level,
      role: 'img',
      'aria-label': levelLabel(g.level) + ': ' + Math.round(g.ratio * 100) + '% of the estimated room used',
      'data-level': g.level,
    }, [
      core.el('div', { class: 'tmv-meter__fill', 'data-level': g.level }),
    ]));

    wrap.appendChild(note(QUOTA_LEVEL_TEXT[g.level] || '', g.level === 'normal' ? null : 'warning'));
    wrap.appendChild(note(
      'The estimate is this page’s own tally of what it has written, not a figure the browser ' +
      'reports: browsers do not expose remaining room reliably, and on a file opened from disk they ' +
      'do not expose it at all. Treat the number as a scale, not a measurement.'
    ));
    return wrap;
  }

  function levelLabel(level) {
    if (level === 'exhausted') return 'Full';
    if (level === 'warning') return 'Nearly full';
    if (level === 'elevated') return 'Past 70% of the estimate';
    return 'Normal';
  }

  /**
   * The applicable row of `05-storage.md` §4's table, and nothing when there is no row to state.
   *
   * Returning `null` rather than an empty block matters: a heading with no text under it reads as a
   * section that failed to load, and the reader is left to guess whether the application knows
   * something it is not saying.
   */
  function storageContextBlock(ctx) {
    var storage = ctx.storage || {};
    var hasMessage = core.present(storage.message);
    var uncertain = storage.certain === false;
    var unavailable = storage.available === false;
    if (!hasMessage && !uncertain && !unavailable) return null;

    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('How this browser is treating this file'));
    if (hasMessage) wrap.appendChild(note(storage.message));
    if (uncertain) {
      wrap.appendChild(note(
        'That is the likely explanation rather than a certainty. An empty store on a first visit looks ' +
        'exactly like a store this browser has partitioned, and there is no way to tell the two apart ' +
        'from inside the page. Either way the answer is the same: export the file to move the model.'
      ));
    }
    if (unavailable) {
      wrap.appendChild(note(
        'Storage is unavailable in this session, so nothing here can be saved and nothing above is ' +
        'holding anything. Everything else still works.',
        'warning'
      ));
    }
    return wrap;
  }

  function storageModelsBlock(ctx, adapter) {
    // `--wide`: the table below is wider than the block's 48rem reading measure.
    var wrap = core.el('div', { class: 'tmv-settings__block tmv-settings__block--wide' });
    wrap.appendChild(subhead('Models this browser is holding'));

    var entries = [];
    try {
      entries = TMV.storage.listModels(adapter);
    } catch (err) {
      entries = [];
    }

    if (!entries.length) {
      wrap.appendChild(note(
        'Nothing is stored yet. A model is saved here the first time you commit to it while this ' +
        'browser is willing to store things.'
      ));
      // An empty registry beside a file that carries history is the partitioned-origin case, and §4
      // says the app states the applicable row rather than saying "storage error".
      if (ctx.container && ctx.container.history) {
        wrap.appendChild(note(
          'This file carries its own history, and it is being shown from the file. That is the ' +
          'fallback working, not a problem to fix.'
        ));
      }
      return wrap;
    }

    // Which row, if any, is the copy this page has open.
    //
    // `source === 'stored'` is the load-bearing half. When the file's own model is on screen, the row
    // for the same model id is a *different history* rather than the thing being looked at — that is
    // the whole subject of `openEntry` in `17-shell.js` — so opening it is a real move and calling it
    // "already open" would be wrong.
    var openModelId =
      ctx.state && ctx.state.source === 'stored' && ctx.model && core.isString(ctx.model.modelId)
        ? ctx.model.modelId
        : null;

    var rows = [];
    for (var i = 0; i < entries.length; i++) {
      // One plain row per entry. `dataTable` draws each cell from a column's `render(row)`; a `cells`
      // array is `structuredList`'s shape, and passing one here renders a row of empty cells — a table
      // that looks like it loaded and has nothing in it.
      rows.push({ id: entries[i].modelId, entry: entries[i] });
    }

    // The complaint this note answers is the most reasonable one the screen can provoke: the table
    // says a model is here, so where is the control that shows it? Delete was the only action, which
    // reads as "the browser is holding this and you may not have it". Opening is not a special path —
    // it is the header switcher's own switch, reached from where the user is standing.
    wrap.appendChild(note(
      'Opening one of these shows the copy this browser is holding, which is the same move the model ' +
      'switcher in the header makes and asks the same question first if the working copy has ' +
      'uncommitted changes. A model can be listed here and carried by the file at the same time; those ' +
      'are two histories, not two names for one.'
    ));

    var table = widgets.dataTable({
      caption: 'Models stored in this browser',
      rowKey: function (row) { return row.id; },
      columns: [
        {
          key: 'name',
          label: 'Model',
          render: function (row) {
            var name = row.entry.name || core.shortId(row.entry.modelId);
            if (row.entry.modelId === openModelId) {
              // A tag as well as the disabled button, because a `title` is not reachable by touch or
              // by keyboard and "why is this one disabled" has to be answerable without hovering.
              return core.el('span', { class: 'tmv-stored-model' }, [
                core.el('span', { text: name }),
                widgets.tag({ text: 'open', type: 'blue', title: 'This is the copy the page is showing' }),
              ]);
            }
            return core.el('span', { text: name });
          },
        },
        {
          key: 'commits',
          label: 'Commits',
          numeric: true,
          render: function (row) {
            return core.el('span', { text: String(row.entry.commitCount) });
          },
        },
        {
          key: 'size',
          label: 'Size',
          numeric: true,
          render: function (row) {
            return core.el('span', { text: core.bytes(row.entry.bytes) });
          },
        },
        {
          key: 'opened',
          label: 'Last opened',
          render: function (row) {
            return core.el('span', {
              text: row.entry.lastOpenedAt ? core.relativeTime(row.entry.lastOpenedAt) : '—',
            });
          },
        },
        {
          key: 'actions',
          label: 'Actions',
          render: function (row) {
            var name = row.entry.name || row.entry.modelId;
            var isOpen = row.entry.modelId === openModelId;
            return core.el('span', { class: 'tmv-stored-actions' }, [
              widgets.button({
                label: 'Open',
                kind: 'ghost',
                size: 'sm',
                action: 'open-model',
                value: row.entry.modelId,
                // Disabled rather than absent, unlike the header's delete (REQ-UI-004 AC2). The two
                // cases are not the same: delete is *meaningless* for a model that is only in the
                // file, while open is meaningful for every row and merely already done for this one.
                // A gap in the column would read as a missing control instead of a satisfied one.
                disabled: isOpen,
                title: isOpen
                  ? 'This is the copy the page is already showing'
                  : 'Show the copy this browser is holding',
                ariaLabel: 'Open the stored copy of ' + name,
              }),
              widgets.button({
                label: 'Delete',
                kind: 'danger--ghost',
                size: 'sm',
                action: 'delete-model',
                value: row.entry.modelId,
                ariaLabel: 'Delete the stored copy of ' + name,
              }),
            ]);
          },
        },
      ],
      rows: rows,
      stickyHeader: false,
    });
    wrap.appendChild(table.element);
    wrap.appendChild(note(
      'Deleting removes this browser’s copy and its history. The file it came from is not touched, ' +
      'and neither is any other model.'
    ));
    return wrap;
  }

  /**
   * Collection (REQ-STORE-008).
   *
   * `04-versioning.md` §9 is the sentence that shapes this whole block: **reachable commits are never
   * removed.** So there is no "prune the history" control here, because there is no operation in the
   * design that prunes reachable history — `05-storage.md` §5 lists pruning as the fourth and last
   * resort, and the thing it actually reclaims is unreachable commits and keyframes that compaction
   * made redundant. Showing a button labelled "prune" that did something smaller than its name would
   * be worse than showing the button that does what it says.
   *
   * The report comes first, always, and it is the numbers here rather than a sentence promising them.
   */
  function collectionBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('Reclaiming space'));

    var preview = ctx.shell.collectionReport();
    if (!preview.ok) {
      wrap.appendChild(note(
        preview.reason === 'no-adapter'
          ? 'This browser is not storing anything, so there is nothing here to reclaim.'
          : 'The stored history could not be examined, so nothing is offered to remove.'
      ));
      return wrap;
    }

    var report = preview.report;
    var nothing = !report.unreachable.length && !report.redundantKeyframes.length;

    wrap.appendChild(V.definitionSection(ctx, {
      title: 'What collection would remove',
      pairs: [
        {
          term: 'Commits nothing refers to',
          value: report.unreachable.length
            ? core.plural(report.unreachable.length, 'commit') + ' · ' + core.bytes(report.unreachableBytes)
            : 'None',
        },
        {
          term: 'Keyframes that re-keyframing made redundant',
          value: report.redundantKeyframes.length
            ? core.plural(report.redundantKeyframes.length, 'keyframe') + ' · ' + core.bytes(report.redundantBytes)
            : 'None',
        },
        { term: 'Stored for this model now', value: core.bytes(report.before) },
        { term: 'Would be freed', value: core.bytes(report.bytes) },
      ],
    }));

    if (nothing) {
      wrap.appendChild(note(
        'Nothing to collect. Every commit stored here is reachable from this history’s head, and no ' +
        'keyframe is redundant at the current interval. That is the normal state — nothing in this ' +
        'application discards history, so unreachable commits only appear when a file was re-imported ' +
        'over an existing model or a history was replaced.'
      ));
      return wrap;
    }

    wrap.appendChild(note(
      'Every commit reachable from the head is kept, and its id does not change when the ' +
      'representation does — a compacted history and an uncompacted file still share commit ids and ' +
      'still reconcile. What goes is what nothing points at.'
    ));
    wrap.appendChild(actionRow([
      widgets.button({
        label: 'Compact the stored history',
        kind: ctx.editable ? 'primary' : 'tertiary',
        action: 'storage-compact',
        disabled: !ctx.editable,
        title: ctx.editable ? null : ctx.readOnlyReason,
      }),
    ]));
    return wrap;
  }

  /**
   * §5's recovery options, in §5's order, with the first one being the one that is always safe.
   *
   * The order is the point. Export removes nothing (REQ-EXP-013), compaction removes only what nothing
   * refers to, and removing a model removes a whole history. Presenting them as three equal buttons
   * would invite the third, so they are numbered.
   */
  function recoveryBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('If room runs out'));
    wrap.appendChild(bullets([
      '1. Export the model. This removes nothing from anywhere and always works, whether or not ' +
        'storage is working, whether or not the working copy is dirty, whether or not there are ' +
        'unresolved conflicts. Do this first.',
      '2. Compact the stored history, which is the control above. It rewrites the representation and ' +
        'keeps every reachable commit.',
      '3. Delete another model from the list above, if there is one you no longer need. Its size and ' +
        'commit count are shown before you decide.',
      '4. There is no fourth option that removes part of this model’s history. That is deliberate: ' +
        'the history may be the only copy, and a control that removed some of it would be the one ' +
        'mistake this application could not recover from.',
    ]));
    return wrap;
  }

  function exportInsteadBlock(ctx) {
    return core.el('div', { class: 'tmv-settings__block' }, [
      note('With no storage, exporting is the only way to keep anything. It does not need storage.'),
      actionRow([widgets.button({ label: 'Go to Export', kind: 'primary', action: 'go-export' })]),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // Import (REQ-IMP-001 … REQ-IMP-010, `08-security.md` §3)
  // ---------------------------------------------------------------------------------------------

  /**
   * The import screen, and the note on it is the mitigation.
   *
   * `08-security.md` §3 says so in as many words: the safe path for a file you did not write is to
   * *import* it rather than open it, and the import screen carries a note saying why. The reason is
   * that an exported threat model is executable HTML — opening one runs whatever it contains, with
   * access to this origin's storage — while importing reads it as text, finds the data block by
   * scanning rather than parsing, and never puts any part of it in this document. Opening a hostile
   * file is dangerous; importing one is not. That difference is the whole reason the note is here and
   * not in a help page, so it is stated plainly and first.
   */
  function importSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });

    body.appendChild(note(
      'Importing is safer than opening a file you did not write. A threat model exported from this ' +
      'application is an HTML file, and opening one in a browser runs whatever that file contains — ' +
      'including anything a hostile author put in it. This screen reads the file as text: the model is ' +
      'found by scanning the characters, the JSON is parsed, and no part of the incoming document is ' +
      'ever put into this page.'
    ));

    var drop = widgets.fileDrop({
      id: 'tmv-import-file',
      prompt: 'Drag a threat model here, or click to choose one',
      hint: 'Threat-Model-Viewport containers, exported application files, OTM and TML documents',
      onFiles: function (entries) {
        ctx.shell.importEntries(entries);
        ctx.refresh();
      },
    });
    body.appendChild(drop.element);

    body.appendChild(note(
      'The format is detected from what is inside the file, not from its name — a container, an ' +
      'exported application file, an OTM document and a TML document are told apart by their own ' +
      'structure, so an extension that lies about the contents changes nothing.'
    ));
    body.appendChild(note(
      'One model is imported at a time. Dropping several files imports the first that reads and says ' +
      'what happened to the rest, because otherwise it would not be clear which model you are looking at.'
    ));

    body.appendChild(reportBlock(ctx));
    return V.section(
      ctx,
      'Import',
      'Reading a model out of a file, without executing it. The file is treated as text and its ' +
        'contents are validated before anything is opened.',
      body
    );
  }

  /**
   * The retained report (REQ-IMP-010).
   *
   * A toast is the wrong place for this: the toast for a successful import is gone in five seconds and
   * the toast for a refused one is gone when it is dismissed, and the question "what did it actually
   * find in there" outlives both. `10-import.js` retains the last report until it is replaced or
   * dismissed, and this is where it is read.
   *
   * The progress indicator is doing real work here rather than decorating: the import path has three
   * stages that can each be the one that stopped, and the report says which. A bare failure message
   * would leave a user unable to tell a format they did not recognise from a schema violation from a
   * mapper problem.
   */
  function reportBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('The last import'));

    var report = TMV.importing.lastReport();
    if (!report || !report.summary) {
      wrap.appendChild(note('Nothing has been imported in this page yet.'));
      return wrap;
    }

    var summary = report.summary;
    var detected = core.present(summary.format) && summary.format !== TMV.importing.UNKNOWN;
    var validated = !!(report.validation && report.validation.valid) ||
      (report.checks && report.checks.ok === true) ||
      (detected && summary.problems === 0);
    var stage = !detected ? 0 : (validated ? 3 : 1);

    var steps = widgets.progressSteps({
      label: 'Stages of the last import',
      steps: [
        {
          label: 'Format detected',
          detail: detected ? (summary.formatLabel || summary.format) : 'Not recognised',
        },
        {
          label: 'Checked against the bundled schema',
          detail: summary.problems
            ? core.plural(summary.problems, 'violation') + ' found'
            : 'No violations',
        },
        {
          label: 'Mapped to the canonical model',
          detail: summary.ok
            ? entityCountText(summary.counts)
            : 'Not reached',
        },
      ],
      current: stage,
    });
    wrap.appendChild(steps.element);

    var pairs = [
      { term: 'File', value: summary.filename || '(no name)' },
      { term: 'Read as', value: summary.formatLabel || summary.format || 'unrecognised' },
      { term: 'Schema version in the file', value: summary.schemaVersion || 'not stated' },
      {
        term: 'How it was identified',
        value: summary.evidence ? String(summary.evidence) : 'not recorded',
      },
      {
        term: 'Result',
        value: summary.ok
          ? (summary.readOnly
            ? 'Opened read-only, because it did not pass validation in full'
            : 'Opened')
          : 'Not opened',
      },
      { term: 'Warnings', value: String(summary.warnings || 0) },
      { term: 'Unresolved references', value: String(summary.unresolved || 0) },
      { term: 'When', value: summary.at ? core.formatDateTime(summary.at) : 'unknown' },
    ];
    wrap.appendChild(V.definitionSection(ctx, { title: 'Import report', pairs: pairs }));

    if (report.problems && report.problems.length) {
      wrap.appendChild(subhead('What was wrong with it'));
      var rows = [];
      for (var i = 0; i < report.problems.length && i < 40; i++) {
        var p = report.problems[i];
        rows.push({
          id: 'p' + i,
          cells: [
            core.el('span', { class: 'tmv-code', text: String(p.path || '(document)') }),
            core.el('span', { text: String(p.message || '') }),
          ],
        });
      }
      wrap.appendChild(widgets.structuredList({
        label: 'Validation problems',
        headers: ['Where', 'What'],
        rows: rows,
      }));
      if (report.problems.length > 40) {
        wrap.appendChild(note('And ' + core.plural(report.problems.length - 40, 'more problem') + '.'));
      }
      wrap.appendChild(note(
        'Importing anyway keeps every field the document does have and leaves the rest empty. The model ' +
        'is then read-only for re-export to that format until the violations are resolved, because ' +
        'writing it back out would produce a document that still does not conform — and this time it ' +
        'would be this application’s fault.'
      ));
    }

    if (summary.unresolved) {
      wrap.appendChild(note(
        core.plural(summary.unresolved, 'reference does', 'references do') + ' not resolve inside the ' +
        'document. Neither interchange schema can express referential integrity, so they are checked ' +
        'here instead: the entities involved are kept and marked, never dropped.'
      ));
    }

    wrap.appendChild(actionRow([
      widgets.button({ label: 'Dismiss this report', kind: 'tertiary', action: 'import-clear' }),
    ]));
    return wrap;
  }

  function entityCountText(counts) {
    if (!core.isObject(counts)) return 'nothing to map';
    var parts = [];
    var keys = Object.keys(counts);
    for (var i = 0; i < keys.length; i++) {
      if (!counts[keys[i]]) continue;
      parts.push(core.plural(counts[keys[i]], keys[i]));
    }
    return parts.length ? parts.join(' · ') : 'nothing to map';
  }

  // ---------------------------------------------------------------------------------------------
  // Export (REQ-EXP-010 … REQ-EXP-013, `06-interchange.md` §9)
  // ---------------------------------------------------------------------------------------------

  /**
   * Four targets, and the differences that matter are stated rather than implied.
   *
   * The application file and the native container both carry the history; the two interchange formats
   * carry the model and no history, because neither schema has anywhere to put one. A user choosing
   * between them is choosing whether to keep the history, so that is what the labels say.
   *
   * REQ-EXP-013 is the constraint this whole section is built around: export is available regardless
   * of storage being broken, the working copy being dirty, or conflicts being pending. Nothing here
   * reads storage, checks dirty state, or consults the compare screen — and the section says so, so a
   * user in a degraded state does not go looking for permission they already have.
   */
  function exportSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });
    var keys = ['html', 'native', 'otm', 'tml'];
    var target = TMV.exporting.TARGETS[chosenFormat] ? chosenFormat : keys[0];
    chosenFormat = target;

    body.appendChild(note(
      'Every export here works whatever state the application is in. A full browser store, uncommitted ' +
      'changes and an unresolved comparison all leave this working, because none of them is consulted.'
    ));

    var switcher = widgets.contentSwitcher({
      label: 'Export format',
      items: keys.map(function (key) {
        var t = TMV.exporting.TARGETS[key];
        return { value: key, label: t.label };
      }),
      selected: target,
      onChange: function (value) {
        chosenFormat = value;
        ctx.refresh();
      },
    });
    body.appendChild(core.el('div', { class: 'tmv-settings__block' }, [
      subhead('What to export'),
      switcher.element,
      note(TARGET_NOTES[target]),
    ]));

    // The interchange preview: what would be blocked and what would not survive. This is the same
    // computation the Overview's Export Readiness section shows; here it is scoped to the format the
    // user has actually chosen, which is the moment the answer matters.
    if (target === 'otm' || target === 'tml') {
      body.appendChild(interchangePreviewBlock(ctx, target));
    } else {
      body.appendChild(historyExportBlock(ctx, target));
    }

    if (target === 'tml') body.appendChild(extensionDomainBlock(ctx));

    body.appendChild(downloadBlock(ctx, target));

    if (fallback && fallback.format === target) body.appendChild(fallbackBlock(ctx));

    return V.section(
      ctx,
      'Export',
      'Producing a file from the model and history in this page. Nothing is written anywhere until you ' +
        'say so, and the assembled file is checked before it is offered.',
      body
    );
  }

  var TARGET_NOTES = {
    html:
      'A complete application file: this programme, plus the model and its whole history embedded in ' +
      'it. Opening the result gives the same application with the data already in it. This is the ' +
      'format that carries everything, including the commits — and the one to hand to someone else, ' +
      'because they do not need to be told anything else.',
    native:
      'The model and its whole history as JSON, with no application around it. Smaller than the ' +
      'application file and re-importable with the history intact, which makes it the format for ' +
      'archiving one model or moving it between copies of the application.',
    otm:
      'Open Threat Model: the model in the other tool’s schema, with no history, because that ' +
      'schema has nowhere to put one. Readable by any OTM consumer.',
    tml:
      'OWASP Threat Model Library: the model in TML’s schema, again with no history. TML carries ' +
      'things OTM does not (personas, assumptions, trust boundaries, the likelihood/impact risk ' +
      'matrix) and lacks things OTM has, so the losses differ in each direction and are listed below.',
  };

  function interchangePreviewBlock(ctx, format) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    var preview;
    try {
      preview = TMV.exporting.preview(ctx.model, format, V.exportOptions(ctx));
    } catch (err) {
      wrap.appendChild(note('This format could not be previewed: ' + (err && err.message ? err.message : 'an unexpected error'), 'warning'));
      return wrap;
    }

    wrap.appendChild(subhead('What this file would contain'));
    wrap.appendChild(note(preview.ok
      ? (preview.lossiness.lossless
        ? 'Everything in this model has a home in that schema, so the export is complete.'
        : core.plural(preview.lossiness.total, 'value') + ' in this model has no home in that schema and will not appear in the file. They are listed below, and they stay in this model either way.')
      : core.plural(preview.blocked.length, 'item needs', 'items need') + ' attention first. These are things neither format can carry without this application inventing a value, and an invented value would be a false statement rather than a default.'));

    if (preview.blocked.length) {
      wrap.appendChild(subhead('Blocked'));
      var rows = [];
      for (var i = 0; i < preview.blocked.length && i < 40; i++) {
        var item = preview.blocked[i] || {};
        rows.push({
          id: 'b' + i,
          cells: [
            core.el('span', { class: 'tmv-code', text: String(item.code || 'blocked') }),
            core.el('span', { text: blockedSentence(item) }),
          ],
        });
      }
      wrap.appendChild(widgets.structuredList({
        label: 'Items that block this export',
        headers: ['Check', 'What has to happen'],
        rows: rows,
      }));
      if (preview.blocked.length > 40) {
        wrap.appendChild(note('And ' + core.plural(preview.blocked.length - 40, 'more item') + '.'));
      }
    }

    if (preview.lossiness.lossless === false) {
      wrap.appendChild(subhead('What will not survive'));
      var losses = [];
      for (var j = 0; j < preview.lossiness.entries.length && j < 40; j++) {
        var entry = preview.lossiness.entries[j];
        losses.push(entry.count + ' × ' + entry.describe + (entry.field ? ' (' + entry.field + ')' : ''));
      }
      wrap.appendChild(bullets(losses));
      wrap.appendChild(note(
        'The loss belongs to the format, not to the model: the value has no field in that schema to go ' +
        'in. Everything listed here is still in this model after the export.'
      ));
    }

    if (preview.synthesized.length) {
      wrap.appendChild(subhead('Values the exporter will fill in'));
      // Each of these is `{field, entity, id, why}` — a statement about one place in the document, not
      // a category. Naming the entity and the field is what makes it actionable; the reason is the
      // part that says whether it is a harmless default or an assertion the exporter is inventing.
      var filled = [];
      for (var k = 0; k < preview.synthesized.length && k < 40; k++) {
        filled.push(synthesizedSentence(preview.synthesized[k], ctx));
      }
      wrap.appendChild(bullets(filled));
      if (preview.synthesized.length > 40) {
        wrap.appendChild(note('And ' + core.plural(preview.synthesized.length - 40, 'more value') + '.'));
      }
      wrap.appendChild(note(
        'These are disclosed rather than hidden, and they are listed in the export report a recipient ' +
        'would see, so it is possible to tell what the author stated from what the tool inferred.'
      ));
    }
    return wrap;
  }

  /** A blocked item's sentence. The mapper's own message names the entity, so it is used as written. */
  function blockedSentence(item) {
    if (core.isString(item)) return item;
    if (!item) return 'Something needs attention.';
    if (core.present(item.message)) return String(item.message);
    var label = item.label || item.name || item.id || item.entity || 'An item';
    var field = core.present(item.field) ? ' (' + item.field + ')' : '';
    return String(label) + field + ' needs attention before this can be exported.';
  }

  /** A synthesized value, named by the entity it belongs to so it can be found and checked. */
  function synthesizedSentence(item, ctx) {
    if (core.isString(item)) return item;
    if (!item) return 'A value was filled in.';
    var entity = core.present(item.entity) ? String(item.entity) : 'value';
    var name = null;
    if (core.present(item.id) && ctx.model) {
      // The id is stable but unreadable; the label is what a user can find on screen. Where the
      // reference does not resolve — the entity may be one this export itself generates — the id is
      // shown rather than a guess at a name.
      name = V.labelFrom(ctx.model, item.id);
    }
    var where = entity + ' “' + (name || (core.present(item.id) ? core.shortId(item.id) : 'unnamed')) + '”';
    var field = core.present(item.field) ? item.field : 'a field';
    var why = core.present(item.why) ? ' — ' + String(item.why) : '';
    return where + ': ' + field + why;
  }

  function historyExportBlock(ctx, format) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    var commits = ctx.history && core.isArray(ctx.history.commits) ? ctx.history.commits.length : 0;
    wrap.appendChild(subhead('What this file would contain'));
    wrap.appendChild(V.definitionSection(ctx, {
      title: 'Export contents',
      pairs: [
        { term: 'Model', value: modelName(ctx) },
        { term: 'Commits carried', value: core.plural(commits, 'commit') },
        { term: 'Head', value: ctx.history && ctx.history.head ? core.shortId(ctx.history.head) : 'none' },
        {
          term: 'Working copy',
          value: isDirty(ctx)
            ? 'Has uncommitted changes, which are not in the file — commit first if they matter'
            : 'Matches the head commit',
        },
      ],
    }));
    if (isDirty(ctx)) {
      wrap.appendChild(note(
        'An export writes the history, and the history is what has been committed. Changes in the ' +
        'working copy are in the model on screen but not in any commit, so an exported file does not ' +
        'contain them. Commit first, or export the model and accept losing them.',
        'warning'
      ));
    }
    if (format === 'html' && !TMV.exporting.hasPristine()) {
      wrap.appendChild(note(
        'This page did not capture its own starting markup, so an application file cannot be built. ' +
        'That is a fault in the build rather than in the model, and the other three formats are ' +
        'unaffected.',
        'warning'
      ));
    }
    return wrap;
  }

  /**
   * The TML provenance namespace (`06-interchange.md` §9, OQ-02).
   *
   * TML requires extension keys to look like `domain.tld/extension-name`, so the provenance this
   * application records on import cannot be written back out under a key it invents — that would mean
   * claiming a domain the project does not own. Open question 02 records the consequence: provenance
   * is written only when a domain is configured, and omitted with a note in the report when it is not.
   * The field is here, next to the TML export it affects, rather than hidden in Identity, because that
   * is where a user would look when the report says provenance was omitted.
   */
  function extensionDomainBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    var current = core.isString(ctx.prefs && ctx.prefs.extensionDomain) ? ctx.prefs.extensionDomain : '';

    wrap.appendChild(subhead('Provenance namespace for TML'));
    wrap.appendChild(note(
      'TML requires the keys in a document’s extensions object to read as domain.tld/name. The ' +
      'record of where an imported model came from has to go somewhere, and there is no domain this ' +
      'project is entitled to write under, so the TML export leaves provenance out unless a domain is ' +
      'given here — and says so in the export report when it does. This is open question 02 in the ' +
      'specification rather than an oversight.'
    ));

    var field = widgets.field({
      id: 'tmv-extension-domain',
      label: 'Domain for the provenance namespace',
      value: current,
      placeholder: 'example.com',
      hint: 'A domain you are entitled to use. Left empty, TML exports carry no provenance record.',
    });
    field.on('change', function () {
      ctx.shell.persistPrefs({ extensionDomain: core.nfc(field.value() || '').trim() });
      ctx.refresh();
    });
    wrap.appendChild(field.element);
    wrap.appendChild(actionRow([
      widgets.button({ label: 'Save the domain', kind: 'primary', action: 'extension-domain-save' }),
    ]));
    return wrap;
  }

  function downloadBlock(ctx, target) {
    var t = TMV.exporting.TARGETS[target];
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('Get the file'));
    wrap.appendChild(note(
      'The file is assembled and then checked before it is offered: that it is well formed, that the ' +
      'embedded data parses back to the same model, that an application file still carries this ' +
      'application byte for byte, and that any hash it declares about itself is true. A file that fails ' +
      'any of those is not offered at all — a copy you believe in but do not have is worse than no copy.'
    ));
    wrap.appendChild(note(
      'Filenames come from the model name, the format and the head commit, so two exports of the same ' +
      'state produce the same name and neither contains anything a filesystem would object to.'
    ));
    wrap.appendChild(actionRow([
      widgets.button({
        label: 'Download ' + t.label,
        kind: 'primary',
        action: 'export-download',
        value: target,
      }),
    ]));
    return wrap;
  }

  /** REQ-EXP-012's fallback: the full text, in a form that can be selected and saved by hand. */
  function fallbackBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(note(
      'The download could not be started, so the whole file is below. Copy it and save it yourself — it ' +
      'is exactly the file that would have been downloaded.',
      'warning'
    ));
    wrap.appendChild(V.definitionSection(ctx, {
      title: 'The file that could not be downloaded',
      pairs: [
        { term: 'Filename', value: fallback.filename },
        { term: 'Size', value: core.bytes(fallback.bytes) },
      ],
    }));
    wrap.appendChild(widgets.snippet({ text: fallback.text, collapsible: true }));
    wrap.appendChild(actionRow([
      widgets.button({ label: 'Dismiss', kind: 'tertiary', action: 'export-fallback-clear' }),
    ]));
    return wrap;
  }

  /**
   * Assemble, check, offer.
   *
   * The whole of this is in `11-export.js`; what happens here is the refusal paths, and each of them
   * says which one it was. A single "export failed" for a blocked format, a missing pristine clone and
   * a download the browser refused would send a user looking in the wrong place.
   */
  function exportNow(ctx, format) {
    var out;
    try {
      out = TMV.exporting.exportAs(format, ctx.model, ctx.history, V.exportOptions(ctx));
    } catch (err) {
      TMV.notify.failure({
        title: 'The export could not be built',
        detail: err && err.message ? err.message : 'An unexpected error while assembling the file.',
        ref: 'exp.build',
      });
      return { ok: false, reason: 'built' };
    }
    if (!out || !out.ok) {
      var blocked = out && out.blocked ? out.blocked.length : 0;
      TMV.notify.failure({
        title: 'This model is not ready for that format',
        detail: blocked
          ? core.plural(blocked, 'item needs', 'items need') + ' attention before it can be exported. They are listed on this screen.'
          : 'The file was checked before download and did not pass, so it has not been offered.',
        ref: 'exp.blocked',
      });
      return { ok: false, reason: 'blocked' };
    }

    var dl = TMV.exporting.download(out.text, out.filename, out.mime);
    if (dl.ok) {
      fallback = null;
      TMV.notify.outcome({
        level: 'success',
        title: 'Exported ' + out.filename,
        detail: core.bytes(out.bytes) + ' written from the model and history in this page.',
        ref: 'exp.done',
      });
      return { ok: true, method: dl.method };
    }

    // REQ-EXP-012: under `file://` in some browsers, and with downloads blocked in others, the Blob
    // route is unavailable. The text is the export either way, so it is shown rather than lost.
    fallback = { format: format, filename: out.filename, text: out.text, bytes: out.bytes };
    TMV.notify.outcome({
      level: 'warning',
      title: 'The download could not be started',
      detail: (dl.reason || 'This browser would not start a download.') + ' The file is shown on this screen so it can be copied and saved by hand.',
      ref: 'exp.fallback',
    });
    return { ok: false, reason: 'download', fallback: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Diagram (REQ-VIEW-004, REQ-VIEW-005, REQ-SHELL-007)
  // ---------------------------------------------------------------------------------------------

  /**
   * Diagram behaviour, which is mostly a statement about the network.
   *
   * REQ-VIEW-005's promise is narrow and worth repeating exactly: Mermaid is fetched the first time a
   * Mermaid diagram is actually displayed, and not before. Everything else — a coordinate canvas from
   * an OTM file, sanitized SVG from a TML file, Graphviz and PlantUML shown as source text — is drawn
   * or displayed by this file alone. `08-security.md` §5 makes the SVG sanitisation mandatory because
   * an imported SVG can carry scripting, so the section says what is drawn and what is only shown.
   *
   * The loader's own record is read rather than restated: the version and the integrity hash come from
   * the build's placeholder in the file, so this screen cannot claim a version the file does not
   * actually pin. That is the whole point of reading it instead of writing it out in prose.
   */
  function diagramSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });

    body.appendChild(note(
      'This application draws what it can and shows the source of what it cannot. Nothing is fetched ' +
      'unless a diagram of a kind that needs it is actually displayed.'
    ));

    body.appendChild(subhead('What each kind of diagram does'));
    body.appendChild(V.definitionSection(ctx, {
      title: 'Diagram kinds',
      pairs: [
        {
          term: 'Coordinate canvas',
          value: 'Drawn here. Zones become labelled containers, the elements inside them are placed at ' +
            'their recorded coordinates, and flows become edges between their two ends.',
        },
        {
          term: 'SVG source',
          value: 'Drawn here, after being sanitized: scripting, event handlers and references to ' +
            'anything outside the document are removed before it is displayed. An imported SVG is ' +
            'model data like any other, and model data is untrusted.',
        },
        {
          term: 'Mermaid source',
          value: 'Fetched from a pinned address the first time one is displayed, and not before. If the ' +
            'fetch fails, the source text is shown with an explanation rather than an error.',
        },
        {
          term: 'Graphviz and PlantUML source',
          value: 'Shown as text with a copy action. Neither is rendered, because rendering either ' +
            'would mean fetching a renderer or shipping one, and the specification rules out both.',
        },
      ],
    }));

    var reps = [];
    var sources = [];
    try {
      reps = TMV.diagrams.representations(ctx.model);
      sources = TMV.diagrams.sourceDiagrams(ctx.model);
    } catch (err) {
      reps = [];
      sources = [];
    }
    var mermaidCount = 0;
    for (var i = 0; i < sources.length; i++) {
      var type = core.isString(sources[i].type) ? sources[i].type.toLowerCase() : '';
      if (type === 'mermaid') mermaidCount++;
    }

    body.appendChild(subhead('In this model'));
    body.appendChild(V.definitionSection(ctx, {
      title: 'Diagrams in this model',
      pairs: [
        { term: 'Coordinate canvases', value: core.plural(reps.length, 'canvas') },
        { term: 'Diagrams stored as source text', value: core.plural(sources.length, 'diagram') },
        {
          term: 'Of those, Mermaid',
          value: mermaidCount
            ? core.plural(mermaidCount, 'diagram') + ' — displaying one downloads the renderer'
            : 'None, so nothing will be downloaded for this model',
        },
      ],
      empty: {
        title: 'No diagrams in this model',
        body: 'Neither format stores a diagram here. That is a legal model, not a broken one.',
      },
    }));

    var info = TMV.diagrams.loaderInfo();
    var status = TMV.diagrams.mermaidStatus();
    body.appendChild(subhead('The diagram renderer'));
    if (info && info.version) {
      body.appendChild(V.definitionSection(ctx, {
        title: 'Mermaid as this file pins it',
        pairs: [
          { term: 'Version', value: info.version },
          { term: 'Address', value: core.el('code', { class: 'tmv-code', text: info.src }) },
          {
            term: 'Integrity check',
            value: info.integrity
              ? core.el('code', { class: 'tmv-code', text: info.integrity })
              : 'Not stated, so the browser cannot reject a substituted file',
          },
          { term: 'Loaded yet', value: loaderText(status.status) },
        ],
      }));
      if (!info.integrity) {
        body.appendChild(note(
          'This build pins the address but not a hash, so a substituted file at that address would be ' +
          'executed. That is worth knowing rather than glossing over.',
          'warning'
        ));
      }
    } else {
      body.appendChild(note(
        'This page has no pinned diagram renderer, so Mermaid diagrams are shown as source text. ' +
        'Everything else on this screen is unaffected — the other three kinds of diagram never needed ' +
        'it.'
      ));
    }
    if (status.reason) body.appendChild(note(status.reason));

    body.appendChild(note(
      'This is the whole of the network behaviour: the Carbon stylesheet, the IBM Plex font files that ' +
      'stylesheet asks for, and Mermaid when a Mermaid diagram is shown. No request carries any part ' +
      'of a threat model, and there is no telemetry of any kind.'
    ));
    body.appendChild(actionRow([
      widgets.button({ label: 'See this model’s diagrams', kind: 'tertiary', action: 'go-diagram' }),
    ]));

    return V.section(
      ctx,
      'Diagram',
      'What this application draws itself, what it shows as source, and the one case in which it ' +
        'fetches anything.',
      body
    );
  }

  function loaderText(status) {
    if (status === 'loaded') return 'Loaded already, so displaying another Mermaid diagram will not fetch it again';
    if (status === 'loading') return 'Being fetched now';
    if (status === 'failed') return 'The fetch failed, so Mermaid diagrams are shown as source text';
    return 'Not loaded. Nothing has been fetched for a diagram in this page.';
  }

  // ---------------------------------------------------------------------------------------------
  // Appearance (REQ-UI-005, REQ-UI-006, REQ-UI-007)
  // ---------------------------------------------------------------------------------------------

  /**
   * Theme and the side nav rail, and two things worth saying plainly.
   *
   * The theme is chosen once from the operating system's preference on first run and then remembered,
   * rather than following the system continuously — `07-ui.md` §10 records that as deliberate: a user
   * who picked Gray 100 on a light-mode machine meant it. And the collapsed rail persists across tabs,
   * because a user who collapsed it to see more table width does not want it re-expanded by switching
   * tabs (REQ-UI-003 AC3).
   */
  function appearanceSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });
    var currentTheme = ctx.prefs && ctx.prefs.theme ? ctx.prefs.theme : 'cds--g10';

    body.appendChild(subhead('Theme'));
    body.appendChild(note(
      'Four prebuilt Carbon themes, applied by class with no compiled stylesheet of our own. The ' +
      'choice is remembered in this browser, and on a first run it starts from whatever the operating ' +
      'system asks for.'
    ));

    var switcher = widgets.contentSwitcher({
      label: 'Colour theme',
      items: TMV.shell.THEMES.map(function (theme) {
        return { value: theme.value, label: theme.label };
      }),
      selected: currentTheme,
      onChange: function (value) {
        ctx.shell.setTheme(value);
        ctx.refresh();
      },
    });
    body.appendChild(switcher.element);
    body.appendChild(V.definitionSection(ctx, {
      title: 'Themes available',
      pairs: TMV.shell.THEMES.map(function (theme) {
        return { term: theme.label, value: theme.note };
      }),
    }));
    body.appendChild(note(
      'The theme does not follow the operating system after this point. It is a choice, not a ' +
      'preference that tracks something else — and the interface does not change layout with it, only ' +
      'colour, so nothing moves.'
    ));

    body.appendChild(subhead('Side navigation'));
    body.appendChild(note(
      'Collapsed, the navigation becomes a narrow rail that shows the tab list without their labels. ' +
      'The state is kept across tabs and across reloads, because it is a choice about how much room to ' +
      'give the tables rather than a per-screen setting.'
    ));
    var collapsed = !!(ctx.prefs && ctx.prefs.sideNavCollapsed);
    var navSwitcher = widgets.contentSwitcher({
      label: 'Side navigation width',
      items: [
        { value: 'expanded', label: 'Expanded' },
        { value: 'collapsed', label: 'Rail' },
      ],
      selected: collapsed ? 'collapsed' : 'expanded',
      onChange: function (value) {
        ctx.shell.setSideNavCollapsed(value === 'collapsed');
        ctx.refresh();
      },
    });
    body.appendChild(navSwitcher.element);

    body.appendChild(subhead('What the layout guarantees'));
    body.appendChild(bullets([
      'Nothing is conveyed by colour alone. Risk bands, states and warnings all carry the same ' +
        'information in words, so a theme change or a colour-vision difference cannot hide a finding.',
      'The layout follows Carbon’s grid, and at the narrowest breakpoint the navigation collapses ' +
        'and the tab row scrolls rather than the page overflowing sideways.',
      'Every control is reachable by keyboard, in an order that matches what is on screen, and a ' +
        'dialog gives focus back to whatever opened it.',
    ]));

    return V.section(
      ctx,
      'Appearance',
      'How this application looks, and the two layout choices that are remembered between visits.',
      body
    );
  }

  // ---------------------------------------------------------------------------------------------
  // About (REQ-SHELL-005, REQ-SHELL-007, REQ-SEC-006, REQ-SEC-008, ADR-0002, ADR-0008)
  // ---------------------------------------------------------------------------------------------

  /**
   * About is a disclosure obligation, not a credits page.
   *
   * Four specifications put something here and each says why. REQ-SHELL-005 requires the browser
   * support matrix and the `file://` caveat. `05-storage.md` §4 requires the row of its origin table
   * that applies to this session. `08-security.md` §9 requires the storage-exposure statement,
   * including the Chrome and Edge shared-origin case, and explicitly calls it a disclosure rather than
   * a warning dialog. ADR-0008 requires the chain's meaning to be stated here as well as in History:
   * it proves the content has not changed, not who wrote it.
   *
   * Two more things are stated because leaving them out would let a reader assume something untrue.
   * The application is **not** offline-capable — the Carbon stylesheet is fetched from a pinned
   * address (ADR-0002), which is the one recorded deviation from the stated requirements, and it is
   * recorded rather than quietly reinterpreted. And there is no URL routing (`07-ui.md` §10), because
   * `pushState` is unreliable on a file opened from disk — so a view cannot be linked to.
   *
   * Every claim in this section is either read from the build's own record in the file or checked
   * against it. Nothing here is a sentence someone wrote once and stopped verifying.
   */
  function aboutSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });

    body.appendChild(buildBlock(ctx));
    body.appendChild(chainBlock(ctx));
    body.appendChild(browserBlock(ctx));
    body.appendChild(securityBlock());
    body.appendChild(networkBlock());
    body.appendChild(limitsBlock());

    return V.section(
      ctx,
      'About',
      'What this application is, what it can and cannot promise, and what it does with what it holds. ' +
        'Several of these are disclosure obligations: they are here because leaving them out would let ' +
        'you assume something that is not true.',
      body
    );
  }

  function buildBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('This build'));

    var version = core.metaContent('tmv-app-version') || TMV.VERSION;
    var declared = core.metaContent('tmv-app-hash');
    var built = core.metaContent('tmv-build-time');
    var computed = null;
    var appNode = core.byId('tmv-app');
    if (appNode && core.isString(appNode.textContent) && appNode.textContent !== '') {
      try {
        computed = TMV.exporting.appHashOf(appNode.textContent);
      } catch (err) {
        computed = null;
      }
    }

    var pairs = [
      { term: 'Version', value: version },
      { term: 'Built', value: built ? core.formatDateTime(built) : 'not recorded' },
      { term: 'Model format', value: TMV.MODEL_FORMAT },
      { term: 'Container format', value: TMV.CONTAINER_FORMAT },
      { term: 'Declared code hash', value: hashText(declared) },
      { term: 'Hash of the code in this page', value: computed ? hashText(computed) : 'not measurable here' },
    ];
    wrap.appendChild(V.definitionSection(ctx, { title: 'Build', pairs: pairs }));

    if (declared && computed) {
      if (declared === computed) {
        wrap.appendChild(note(
          'The two agree, so the code running this page is the code this page says it is. That is a ' +
          'check this page makes about itself, and it is the same check an exported file makes before ' +
          'it is offered, which is what keeps a security policy pinned to this code valid in the file ' +
          'this page produces.'
        ));
      } else {
        wrap.appendChild(note(
          'These disagree, which means the code in this page is not what the file declares. The page ' +
          'was very likely edited or reassembled after it was built. Nothing has been changed by this ' +
          'observation; it is reported so the difference is not invisible.',
          'warning'
        ));
      }
      wrap.appendChild(note(
        'This check is about the code, not about the threat model. A model that has been edited by hand ' +
        'is caught by the history’s own chain, described next.'
      ));
    } else {
      // Neither figure is readable, so there is no comparison to report. Saying "not stated" and
      // stopping is honest; describing a check that did not run would not be.
      wrap.appendChild(note(
        'One of the two hashes is not readable on this screen, so the two cannot be compared here. ' +
        'That is a limitation of where this page is being run rather than a finding: a page that is ' +
        'not the built artifact has no build record to read.'
      ));
    }
    return wrap;
  }

  function hashText(value) {
    if (!core.isString(value) || value === '') return 'not stated';
    return core.el('code', { class: 'tmv-code', text: value });
  }

  /**
   * ADR-0008 in the two directions it matters, in the words `08-security.md` §8 requires.
   *
   * The specification says "chain intact" and never "verified" — and the reason for the distinction
   * is not pedantry. "Verified" reads as a statement about a person; what the chain actually
   * establishes is that the bytes have not changed since they were hashed. A history can be entirely
   * intact and entirely invented, because the author name and the timestamp are inside the data the
   * hash covers and are whatever the writer said they were.
   */
  function chainBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('What the history proves'));

    var verdict = null;
    if (ctx.history) {
      try {
        verdict = TMV.vcs.verifyChain(ctx.history);
      } catch (err) {
        verdict = null;
      }
    }

    var state;
    if (!verdict) {
      state = 'No history is open, so there is nothing to check.';
    } else if (verdict.ok) {
      state = 'Chain intact. Every stored commit hashes to the identifier it declares, and every ' +
        'parent it names is present.';
    } else {
      state = core.plural(verdict.errorCount || (verdict.problems || []).length, 'problem') +
        ' in the stored history. History reports which commit, and the model stays usable read-only.';
    }
    wrap.appendChild(note(state, verdict && verdict.ok === false ? 'warning' : null));
    wrap.appendChild(actionRow([
      widgets.button({ label: 'Open History → Integrity', kind: 'tertiary', action: 'go-integrity' }),
    ]));

    wrap.appendChild(bullets([
      'What it shows: the commits have not been altered since they were made, the history is ' +
        'internally consistent, and a missing or truncated commit is detected rather than quietly ' +
        'skipped.',
      'What it does not show: that the named author wrote anything. A name and a timestamp are inside ' +
        'the data the hash covers, so a history can be completely intact and still have been written ' +
        'by anyone, or regenerated wholesale with a different name on it.',
      'For that reason the interface says the chain is intact and never that a history is verified, ' +
        'and the identity on this screen is described as self-asserted rather than confirmed. Neither ' +
        'word is used loosely anywhere in this application.',
    ]));
    return wrap;
  }

  function browserBlock(ctx) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('Browsers'));
    wrap.appendChild(note(
      'The current and previous major versions of Chrome, Edge, Firefox and Safari are supported. No ' +
      'feature is used without checking at runtime that it is there and having something to do when it ' +
      'is not, which is why the storage behaviour below is detected rather than assumed.'
    ));
    wrap.appendChild(bullets([
      'From a file on disk, browsers disagree about storage. Chrome and Edge give every local file one ' +
        'shared storage area; Firefox since version 92 gives each file path its own; Safari is ' +
        'restrictive and inconsistent, so its behaviour is detected at runtime and never assumed.',
      'The practical consequence: a file that is moved, renamed or copied may not find history that an ' +
        'earlier copy of it stored. The file itself always carries its own history, which is why ' +
        'exporting is the reliable way to move a model between paths.',
      'The same model opened from a file and from a local web address lands in two unrelated stores. ' +
        'They are not the same copy and neither knows about the other.'
    ]));
    wrap.appendChild(note('What applies to this session: ' + (ctx.storage && core.present(ctx.storage.message)
      ? ctx.storage.message
      : 'This model is stored by this browser for the site it was opened from.')));
    return wrap;
  }

  function securityBlock() {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('What is stored, and who could read it'));
    wrap.appendChild(bullets([
      'A copy of the model and its history is kept in this browser’s local storage. It is a cache: ' +
        'the file is the record, and deleting this browser’s copy never touches the file.',
      'On Chrome and Edge, every file opened from disk shares one storage area. A hostile HTML file you ' +
        'save to disk and open could therefore read every model this browser has stored. This is the ' +
        'browser’s behaviour and nothing in this application can change it.',
      'That is the reason importing is safer than opening: importing reads a file as text, while ' +
        'opening one runs whatever it contains.',
      'No credentials, tokens or keys are stored anywhere. The only personal data this application ' +
        'holds is the name and email you typed on the Identity screen, and it goes nowhere.',
      'A security policy is attached to every exported file, pinning the application code by hash. It ' +
        'protects a genuine copy of this application from having something injected into it. It cannot ' +
        'protect you from a hostile file, because a hostile file writes its own policy.'
    ]));
    return wrap;
  }

  function networkBlock() {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('What this application talks to'));
    wrap.appendChild(bullets([
      'A pinned Carbon stylesheet, fetched from a fixed version at a fixed address with an integrity ' +
        'hash and a cross-origin attribute, so a substituted file is rejected rather than applied.',
      'The IBM Plex font files that stylesheet asks for. They are not bundled — the full family is far ' +
        'larger than the application — so the interface needs them from the network to look as ' +
        'intended.',
      'Mermaid, and only when a Mermaid diagram is actually displayed. Nothing else about the network ' +
        'is used, and no request of any kind carries any part of a threat model.',
      'There is no telemetry, no analytics, no crash reporting and no update check. This application ' +
        'collects nothing about you and sends nothing anywhere.',
      'Because the stylesheet and fonts come from the network, this application is not offline-capable. ' +
        'That is a deliberate trade recorded as the one deviation from the requirements: inlining them ' +
        'would add roughly a megabyte to every exported file. A build that inlines them is specified ' +
        'but not implemented.'
    ]));
    return wrap;
  }

  function limitsBlock() {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('What it deliberately does not do'));
    wrap.appendChild(bullets([
      'No address routing. A tab or a section cannot be linked to, and reloading returns you to where ' +
        'you were because the choice is remembered rather than encoded in the address. Opening from a ' +
        'file makes history-based routing unreliable, so it is not attempted.',
      'No editing of the diagram. Geometry from an imported file is preserved and re-exported exactly ' +
        'as it arrived; the diagram is read, not authored.',
      'No automatic merging of two histories. When a file and this browser disagree, the difference is ' +
        'shown and a person decides. Nothing is merged until someone chooses what happens.',
      'No keyboard shortcuts beyond the standard ones a browser and Carbon already give you. '
    ]));
    return wrap;
  }

  // ---------------------------------------------------------------------------------------------
  // Danger Zone (REQ-STORE-005)
  // ---------------------------------------------------------------------------------------------

  /**
   * The only destructive action in the application, and the ones that deliberately do not exist.
   *
   * `05-storage.md` §7 calls the misunderstanding this screen has to prevent the most likely one in
   * the product: the user's mental model is that the application *is* the file, so "delete" reads as
   * "delete my threat model". It does not, and the confirmation says so. `17-shell.js` owns that
   * dialog, because it is also reachable from the header, and this section does not duplicate it — it
   * opens it.
   *
   * The second half of the section is a list of absences. There is no "clear everything", no "reset to
   * defaults" that would discard the model, and no way to remove part of a history. Each absence has a
   * reason, and the reasons are the design: reachable commits are never removed, an export is always
   * available, and a single mis-click must not be able to destroy work that may be the only copy.
   */
  function dangerZoneSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });
    var entry = ctx.shell.state().switcherCurrent || null;
    var availability = TMV.shell.logic.deleteAvailability(entry);

    body.appendChild(subhead('Delete this browser’s copy'));
    body.appendChild(note(
      'This removes the model and its history from this browser. It does not touch the file it came ' +
      'from, and it does not touch any other model. If this browser holds the only copy — because the ' +
      'file you have is older, or came from somewhere else — export first, because deleting cannot be ' +
      'undone.'
    ));

    if (!availability.available) {
      // §4 says the delete affordance is *absent* rather than present-and-disabled for the embedded
      // model, with the menu explaining why. The same rule applies here: an explanation, not a dead
      // control.
      body.appendChild(note(availability.reason));
    } else {
      body.appendChild(V.definitionSection(ctx, {
        title: 'What would be removed',
        pairs: [
          { term: 'Model', value: modelName(ctx) },
          {
            term: 'Commits',
            value: core.plural(ctx.history && core.isArray(ctx.history.commits) ? ctx.history.commits.length : 0, 'commit'),
          },
          { term: 'File on disk', value: 'Not affected, and not deleted' },
        ],
      }));
      if (isDirty(ctx)) {
        body.appendChild(note(
          'The working copy has changes that are not committed. They are not stored anywhere yet, so ' +
            'deleting this browser’s copy loses them along with the history. Commit first if they matter.',
          'warning'
        ));
      }
      body.appendChild(actionRow([
        widgets.button({ label: 'Delete this browser’s copy', kind: 'danger', action: 'delete-model' }),
      ]));
    }

    body.appendChild(subhead('What is not here, and why'));
    body.appendChild(bullets([
      'No way to empty all storage at once. Each stored model is removed from the Storage screen by ' +
        'name, with its size and commit count in front of you, so a single mis-click cannot destroy ' +
        'several histories at once.',
      'No way to remove part of a history. Commits reachable from the history’s head are never ' +
        'removed by anything in this application, at any point, for any reason. The only thing that can ' +
        'be reclaimed is a commit nothing refers to, and even that is offered with a count and a size ' +
        'first.',
      'No way to reset the application in a manner that loses the model. Settings can be changed and ' +
        'storage can be emptied; the model in the file is never touched by either, and export is ' +
        'available in every one of those states.'
    ]));
    return V.section(
      ctx,
      'Danger Zone',
      'The one destructive action that exists — and the ones that deliberately do not, with the reason ' +
        'each is left out.',
      body
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------

  function wire(root, ctx) {
    core.delegate(root, 'click', function (event, node) {
      var action = node.getAttribute('data-action');
      if (action === 'identity-save') {
        // The fields saved themselves on change; this is for a user who typed and then clicked rather
        // than tabbed away, so it commits whatever is in them right now.
        var nameField = core.byId('tmv-identity-name');
        var emailField = core.byId('tmv-identity-email');
        ctx.shell.persistPrefs({
          identity: {
            name: core.nfc(nameField && nameField.value ? nameField.value : '').trim(),
            email: core.nfc(emailField && emailField.value ? emailField.value : '').trim(),
          },
        });
        TMV.notify.outcome({
          level: 'success',
          title: 'Identity saved',
          detail: 'Commits made from now on use it. Commits already in this history keep theirs.',
          ref: 'identity.saved',
        });
        return;
      }
      if (action === 'extension-domain-save') {
        var field = core.byId('tmv-extension-domain');
        var domain = core.nfc(field && field.value ? field.value : '').trim();
        ctx.shell.persistPrefs({ extensionDomain: domain });
        TMV.notify.outcome({
          level: 'info',
          title: domain ? 'Provenance namespace set' : 'Provenance namespace cleared',
          detail: domain
            ? 'TML exports will record where a model came from, under ' + domain + '.'
            : 'TML exports will omit the provenance record and say so in the report.',
          ref: 'exp.domain',
        });
        ctx.refresh();
        return;
      }
      if (action === 'open-model') {
        // The shell owns the switch for the same reason it owns the deletion: the header reaches the
        // same operation, and the guards — a dirty working copy, a session-only model this page would
        // otherwise throw away — have to be the same guards. `switchModel` looks the value up in the
        // switcher's own entry list, so choosing a row here and choosing the entry in the header
        // cannot come to different things.
        ctx.shell.switchModel(node.getAttribute('data-value') || undefined);
        return;
      }
      if (action === 'delete-model') {
        // The shell owns the confirmation and the deletion, because the header reaches the same
        // operation. Duplicating the dialog here would let the two drift apart in what they promise.
        ctx.shell.deleteStored(node.getAttribute('data-value') || undefined);
        return;
      }
      if (action === 'storage-compact') {
        compact(ctx);
        return;
      }
      if (action === 'import-clear') {
        TMV.importing.clearReport();
        ctx.refresh();
        return;
      }
      if (action === 'export-download') {
        exportNow(ctx, node.getAttribute('data-value') || chosenFormat || 'html');
        ctx.refresh();
        return;
      }
      if (action === 'export-fallback-clear') {
        fallback = null;
        ctx.refresh();
        return;
      }
      if (action === 'go-export') {
        ctx.go('settings', 'export');
        return;
      }
      if (action === 'go-diagram') {
        ctx.go('architecture', 'diagram');
        return;
      }
      if (action === 'go-integrity') {
        ctx.go('history', 'integrity');
        return;
      }
    });
    return root;
  }

  /**
   * Compaction, with the report shown before anything is removed (REQ-STORE-006, REQ-STORE-008).
   *
   * The numbers in the dialog are the numbers the collection itself computed a moment earlier, so what
   * the user agrees to and what happens are the same report rather than two similar ones.
   */
  function compact(ctx) {
    var preview = ctx.shell.collectionReport();
    if (!preview.ok) {
      TMV.notify.failure({
        title: 'The stored history could not be examined',
        detail: 'Nothing has been removed.',
        ref: 'store.collect.preview',
      });
      return null;
    }
    var report = preview.report;
    if (!report.unreachable.length && !report.redundantKeyframes.length) {
      TMV.notify.outcome({
        level: 'info',
        title: 'Nothing to collect',
        detail: 'Every commit stored here is reachable from the head, and no keyframe is redundant.',
        ref: 'store.collect',
      });
      return null;
    }

    var instance = widgets.modal({
      title: 'Compact the stored history',
      size: 'sm',
      body: [
        core.el('p', {
          text:
            'This removes ' + core.plural(report.unreachable.length, 'commit') + ' that nothing refers to' +
            (report.redundantKeyframes.length
              ? ' and ' + core.plural(report.redundantKeyframes.length, 'keyframe') + ' made redundant by re-keyframing'
              : '') + ', freeing about ' + core.bytes(report.bytes) + '.',
        }),
        V.definitionSection(ctx, {
          title: 'What collection will remove',
          pairs: [
            { term: 'Commits nothing refers to', value: core.plural(report.unreachable.length, 'commit') + ' · ' + core.bytes(report.unreachableBytes) },
            { term: 'Redundant keyframes', value: core.plural(report.redundantKeyframes.length, 'keyframe') + ' · ' + core.bytes(report.redundantBytes) },
            { term: 'Stored now', value: core.bytes(report.before) },
          ],
        }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'Every commit reachable from the head is kept, and commit identifiers do not change — so a ' +
            'compacted history still reconciles with an uncompacted copy of the same file. The file on ' +
            'disk is not touched.',
        }),
      ],
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Compact', kind: 'danger', action: 'confirm' },
      ],
    });
    instance.open();

    TMV.forms.modalActions(instance, function (action) {
      if (action !== 'confirm') {
        instance.close('cancel');
        return;
      }
      instance.close('confirm');
      var result = ctx.shell.runCollection();
      if (!result.ok) {
        TMV.notify.failure({
          title: 'The stored history was not compacted',
          detail: result.message || 'Nothing was removed.',
          ref: 'store.collect',
        });
        return;
      }
      TMV.notify.outcome({
        level: 'success',
        title: 'Stored history compacted',
        detail:
          core.plural(result.report.removed || 0, 'key') + ' removed, freeing about ' +
          core.bytes(Math.max(0, result.report.before - result.report.after)) + '.',
        ref: 'store.collect',
      });
      ctx.refresh();
    });
    return instance;
  }

  // ---------------------------------------------------------------------------------------------
  // Render and registration
  // ---------------------------------------------------------------------------------------------

  function render(ctx) {
    if (!core.isObject(ctx.model)) {
      return V.emptySection({ title: 'No model is open', body: 'There is nothing to configure.' });
    }
    var node;
    switch (ctx.section) {
      case 'storage':
        node = storageSection(ctx);
        break;
      case 'import':
        node = importSection(ctx);
        break;
      case 'export':
        node = exportSection(ctx);
        break;
      case 'diagram':
        node = diagramSection(ctx);
        break;
      case 'appearance':
        node = appearanceSection(ctx);
        break;
      case 'about':
        node = aboutSection(ctx);
        break;
      case 'danger-zone':
        node = dangerZoneSection(ctx);
        break;
      case 'identity':
      default:
        node = identitySection(ctx);
        break;
    }
    return wire(node, ctx);
  }

  /**
   * No findings on this tab.
   *
   * None of the eight sections is a filter over the model, so there is no count that would read as a
   * finding — and an empty object rather than a number here is what makes the side nav render no badge
   * at all instead of a zero. A storage warning is a *banner* in the header, visible from every tab
   * (`07-ui.md` §9), because it is a condition and not a count.
   */
  function counts() {
    return Object.create(null);
  }

  TMV.shell.register({
    id: ID,
    title: 'Settings',
    render: render,
    counts: counts,
  });

  // Exported for the tests: the section list is a fact about this tab that a test should be able to
  // assert against the shell's own tab definition rather than reaching into the DOM.
  TMV.settings = { SECTIONS: SECTION_IDS };
})(globalThis.TMV = globalThis.TMV || {});
