/**
 * History — `04-versioning.md`, `07-ui.md` §3, and the integrity obligations in `08-security.md` §8.
 * Requirements: REQ-VCS-002, REQ-VCS-007, REQ-VCS-008, REQ-VCS-009, REQ-VCS-010, REQ-VCS-011,
 * REQ-VCS-012, REQ-VCS-013, REQ-SYNC-005, REQ-EDIT-007, REQ-VIEW-008.
 *
 * Five sections, and each one answers a question that the other four cannot:
 *
 *   Log        what happened, in an order that is derived rather than claimed
 *   Compare    what two of those states differ by, and what merging them would produce
 *   Conflicts  which of those differences still has no decision behind it
 *   Stashes    work that is not in any commit and would otherwise be invisible
 *   Integrity  whether the stored history is the history that was written
 *
 * Three things shape the whole tab.
 *
 * **Timestamps are shown and never decisive** (REQ-VCS-007, REQ-VCS-008, ADR-0003). The log is ordered
 * by ancestry — `vcs.log` sorts by depth and then by id — and the date column is labelled as
 * informational. A clock-skewed commit cannot outrank its own descendant here, because nothing in this
 * view compares dates at all. That is worth stating on screen as well as in the code, because a user
 * who assumes the top row is the newest by time will misread a history whose dates are wrong.
 *
 * **Nothing is merged without a person** (REQ-VCS-009, ADR-0003). The Compare section builds a plan,
 * pre-selects the non-overlapping choices as a suggestion, and then waits. The only write in this whole
 * tab is `compare.mergeDialog`, which is reached from a confirm button that stays disabled until every
 * decision that needs one has an answer.
 *
 * **The chain proves integrity, not authorship** (ADR-0008, `08-security.md` §8). The Integrity section
 * says "chain intact" and never "verified", and it says what that does and does not establish. The
 * distinction is not pedantry: a completely intact history can be entirely invented, because the author
 * name is inside the data the hash covers.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;
  var vcs = TMV.vcs;

  var ID = 'history';

  // ---------------------------------------------------------------------------------------------
  // View state
  //
  // The shell rebuilds the content region on every refresh, so the two commits a user has picked in the
  // log have to live outside the DOM or they would be forgotten the first time anything refreshed.
  // ---------------------------------------------------------------------------------------------

  /** The two commits selected in the log, oldest and newest. Ids, not rows — rows are rebuilt. */
  var picked = { a: null, b: null };

  /** The commit a revert confirmation is open for, so a re-render does not offer it twice. */
  var revertTarget = null;

  var FILTER_ALL = 'all';
  var FILTER_CHANGED = 'changed';

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

  function bullets(items) {
    var list = core.el('ul', { class: 'tmv-dialog__list' });
    for (var i = 0; i < items.length; i++) list.appendChild(core.el('li', { text: items[i] }));
    return list;
  }

  function commitOf(ctx, id) {
    return id && ctx.history ? vcs.commitById(ctx.history, id) : null;
  }

  function reachable(ctx) {
    if (!ctx.history || !core.isString(ctx.history.head)) return [];
    try {
      return vcs.log(ctx.history);
    } catch (err) {
      return [];
    }
  }

  /** A commit's message, or a statement that it has none rather than an empty cell. */
  function messageOf(commit) {
    var text = commit && core.isString(commit.message) ? commit.message.trim() : '';
    if (text === '') return '(no message)';
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  }

  function authorOf(commit) {
    var author = commit && core.isObject(commit.author) ? commit.author : null;
    var name = author && core.isString(author.name) ? author.name.trim() : '';
    return name === '' ? 'not stated' : name;
  }

  /** The badges a commit earns. Rendered as tags with text, never as colour alone (REQ-UI-007). */
  function badgesFor(row) {
    var tags = [];
    if (row.isHead) tags.push(['blue', 'head']);
    if (row.isMerge) tags.push(['purple', 'merge']);
    if (row.isRoot) tags.push(['gray', 'root']);
    if (row.commit && row.commit.isKeyframe) tags.push(['cool-gray', 'keyframe']);
    return tags;
  }

  // ---------------------------------------------------------------------------------------------
  // Log (REQ-VCS-007, REQ-VCS-008)
  // ---------------------------------------------------------------------------------------------

  /**
   * The commit log.
   *
   * Ordered by ancestry, and the section says so, because the alternative reading — "newest first" —
   * looks identical on a linear history and gives a different answer on a diverged one. The date column
   * is there because a person needs it to recognise their own work, and it is labelled as informational
   * for exactly the reason REQ-VCS-007 gives: a wrong clock in one copy of a file must not be able to
   * change which history an application considers newer.
   *
   * Selection is what feeds Compare. Two commits, and only two: the compare screen is a three-way diff
   * against a merge base, and a third selection would have no meaning in it.
   */
  function logSection(ctx) {
    // `--wide`: this block holds a nine-column table, and the block's 48rem reading measure is
    // narrower than the table's own columns (see the rule in `00-app.css`).
    var body = core.el('div', { class: 'tmv-settings__block tmv-settings__block--wide' });
    var rows = reachable(ctx);

    body.appendChild(note(
      'Newest first, in the order the commits actually descend from one another. The dates are shown ' +
      'because you need them to recognise your own work, and they are never used to decide which ' +
      'history is newer: a commit whose clock was wrong cannot outrank the commit that came after it.'
    ));

    if (!rows.length) {
      body.appendChild(V.emptySection({
        title: 'This history has no commits',
        body:
          'Nothing has been committed from this page yet. Editing works and nothing is lost — a commit ' +
          'is what turns the working copy into a record, and it is made when you ask for one.',
      }));
      return V.section(ctx, 'Log', 'Every commit reachable from the head, and what each one changed.',
        body);
    }

    var tableRows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var commit = row.commit;
      tableRows.push({ entity: commit, row: row, commit: commit });
    }

    var table = widgets.dataTable({
      caption: 'Commits reachable from the head',
      rowKey: function (row) { return row.commit.id; },
      selectable: true,
      selectAllLabel: 'Select all commits',
      batchActions: [{ label: 'Compare the two selected', kind: 'primary', action: 'compare-picked' }],
      columns: [
        {
          key: 'id',
          label: 'Commit',
          render: function (row) {
            return core.el('code', { class: 'tmv-code', text: core.shortId(row.commit.id) });
          },
        },
        {
          key: 'message',
          label: 'Message',
          render: function (row) { return core.el('span', { text: messageOf(row.commit) }); },
        },
        {
          key: 'author',
          label: 'Author',
          render: function (row) { return core.el('span', { text: authorOf(row.commit) }); },
        },
        {
          key: 'when',
          label: 'Committed',
          // Two lines rather than one: the relative time is what a reader scans for, and the absolute
          // one is what they quote. Run together they made the widest cell in the table — the
          // unbreakable date token alone was 106px — and the column was paid for out of every other
          // column's width. `title` keeps the whole thing on one line for hover, and the ordering the
          // log uses is ancestry, so nothing here decides anything.
          render: function (row) {
            if (!row.commit.timestamp) return core.el('span', { class: 'tmv-muted', text: 'no timestamp' });
            return core.el('span', {
              class: 'tmv-when',
              title: core.relativeTime(row.commit.timestamp) + ' · ' + core.formatDateTime(row.commit.timestamp),
            }, [
              core.el('span', { class: 'tmv-when__rel', text: core.relativeTime(row.commit.timestamp) }),
              core.el('span', { class: 'tmv-when__abs', text: core.formatDateTime(row.commit.timestamp) }),
            ]);
          },
        },
        {
          key: 'depth',
          label: 'Depth',
          numeric: true,
          // Depth is the log row's, not the table row's — the table row wraps it as `.row`, and the
          // distinction matters: ancestry distance is what orders the log, so a wrong depth would be a
          // wrong order as well as a wrong number.
          render: function (row) { return core.el('span', { text: String(row.row ? row.row.depth : 0) }); },
        },
        {
          key: 'tags',
          label: 'Kind',
          render: function (row) {
            var tags = badgesFor(row.row);
            if (!tags.length) return core.el('span', { class: 'tmv-muted', text: '—' });
            var wrap = core.el('span', { class: 'tmv-tags' });
            for (var t = 0; t < tags.length; t++) {
              wrap.appendChild(widgets.tag({ type: tags[t][0], text: tags[t][1] }));
            }
            return wrap;
          },
        },
        {
          key: 'actions',
          label: 'Actions',
          render: function (row) {
            return widgets.button({
              label: 'Revert to this',
              kind: 'ghost',
              size: 'sm',
              action: 'revert-ask',
              value: row.commit.id,
              disabled: !ctx.editable || row.row.isHead,
              title: !ctx.editable
                ? ctx.readOnlyReason
                : row.row.isHead
                  ? 'This is the head. There is nothing to revert to it from.'
                  : 'Make a new commit whose content is this commit’s, without removing anything',
            });
          },
        },
      ],
      expandable: true,
      expand: function (row) { return commitDetail(ctx, row); },
      empty: { title: 'No commits', body: 'This history has no commits.' },
      rows: tableRows,
    });
    body.appendChild(table.element);

    body.appendChild(pickBlock(ctx, rows));

    return V.section(
      ctx,
      'Log',
      'Every commit reachable from the head. Select two and compare them, or expand one to see what it ' +
        'changed.',
      body
    );
  }

  /** What one commit changed, against its parent. Used for the expanded row. */
  function commitDetail(ctx, row) {
    var wrap = core.el('div', { class: 'tmv-commit-detail' });
    var commit = row.commit;

    var pairs = [
      { term: 'Full id', value: core.el('code', { class: 'tmv-code', text: commit.id }) },
      { term: 'Parents', value: parentText(commit) },
      { term: 'Author', value: describeAuthor(commit.author) },
      { term: 'Timestamp', value: commit.timestamp ? core.formatDateTime(commit.timestamp) : 'not recorded' },
      { term: 'Model hash', value: core.el('code', { class: 'tmv-code', text: String(commit.modelHash || '') }) },
      {
        term: 'Stored as',
        value: commit.isKeyframe
          ? 'A full keyframe · ' + core.bytes(core.utf8Length(JSON.stringify(commit.snapshot || null)))
          : 'A delta from its parent · ' + core.plural((commit.delta || []).length, 'change') +
            ' · ' + core.bytes(vcs.patchBytes(commit.delta || [])),
      },
    ];
    wrap.appendChild(V.definitionSection(ctx, { title: 'Commit ' + core.shortId(commit.id), pairs: pairs }));

    // The change summary is derived from stored deltas rather than by reconstructing and diffing both
    // sides: a delta is what the commit actually records, and reconstructing two models to recompute a
    // difference the file already states would be slower and would agree with the file only by
    // coincidence if the file were wrong.
    if (!commit.isKeyframe && core.isArray(commit.delta)) {
      wrap.appendChild(subhead('What it changed'));
      if (!commit.delta.length) {
        wrap.appendChild(note('This commit records no changes. That should not happen — committing an ' +
          'unchanged working copy is refused — but the file says it did, so it is reported rather than hidden.'));
      } else {
        var rows = [];
        var limit = Math.min(commit.delta.length, 40);
        for (var i = 0; i < limit; i++) {
          var op = commit.delta[i] || {};
          rows.push({
            id: 'd' + i,
            cells: [
              core.el('span', { text: operationLabel(op.op) }),
              core.el('code', { class: 'tmv-code', text: String(op.path || '/') }),
              core.el('span', { text: operationValue(op) }),
            ],
          });
        }
        wrap.appendChild(widgets.structuredList({
          label: 'Changes recorded by this commit',
          headers: ['Operation', 'Path', 'Value'],
          rows: rows,
        }));
        if (commit.delta.length > limit) {
          wrap.appendChild(note('And ' + core.plural(commit.delta.length - limit, 'more change') + '.'));
        }
      }
    }

    if (row.isMerge) {
      wrap.appendChild(note(
        'This is a merge. Both of its parents are still in the history and both are still reachable — ' +
        'nothing was discarded to produce it, which is what makes a merge the safe way to combine two ' +
        'diverged copies rather than a choice between them.'
      ));
    }
    if (row.isHead) {
      wrap.appendChild(note('This is the head commit. The working copy is derived from it.'));
    }
    return wrap;
  }

  function operationLabel(op) {
    if (op === 'add') return 'Add';
    if (op === 'remove') return 'Remove';
    if (op === 'replace') return 'Replace';
    if (op === 'move') return 'Move';
    if (op === 'copy') return 'Copy';
    if (op === 'test') return 'Test';
    return String(op || 'Change');
  }

  function operationValue(op) {
    if (op.op === 'remove') return 'removed';
    if (core.isString(op.value)) return op.value;
    if (op.value === null || op.value === undefined) return '—';
    if (core.isArray(op.value)) return core.plural(op.value.length, 'item') + ' in a list';
    if (core.isObject(op.value)) return 'an object with ' + core.plural(Object.keys(op.value).length, 'field');
    if (core.isBoolean(op.value)) return op.value ? 'true' : 'false';
    return String(op.value);
  }

  function parentText(commit) {
    var parents = commit && core.isArray(commit.parents) ? commit.parents : [];
    if (!parents.length) return 'None — this is a root commit';
    var list = [];
    for (var i = 0; i < parents.length; i++) list.push(core.shortId(parents[i]));
    return list.join(' and ') + (parents.length > 1 ? ' · a merge' : '');
  }

  function describeAuthor(author) {
    var name = author && core.isString(author.name) ? author.name.trim() : '';
    var email = author && core.isString(author.email) ? author.email.trim() : '';
    if (name && email) return name + ' <' + email + '> (self-asserted)';
    if (name) return name + ' (self-asserted)';
    if (email) return '<' + email + '> (self-asserted)';
    return 'nobody recorded (self-asserted)';
  }

  /**
   * Which two commits are picked, and the one rule about picking them that is worth a sentence.
   *
   * A commit and its own ancestor compare fine — that is the common "what changed since Tuesday" case.
   * Two commits from unrelated histories do not, and `compare.plan` refuses them; the note says so
   * before the refusal rather than after it.
   */
  function pickBlock(ctx, rows) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('Compare two commits'));

    var a = commitOf(ctx, picked.a);
    var b = commitOf(ctx, picked.b);
    var pair = [];
    if (a) pair.push({ term: 'A', value: core.shortId(a.id) + ' — ' + messageOf(a) });
    if (b) pair.push({ term: 'B', value: core.shortId(b.id) + ' — ' + messageOf(b) });

    if (pair.length) {
      wrap.appendChild(V.definitionSection(ctx, { title: 'Picked commits', pairs: pair }));
    } else {
      wrap.appendChild(note('Nothing is picked yet.'));
    }

    wrap.appendChild(note(
      pair.length === 2
        ? 'Ready to compare. The comparison uses the lowest common ancestor of the two as its base, ' +
          'which is the only state both sides started from.'
        : 'Expand the log and use the checkboxes: pick exactly two commits, then choose ' +
          '“Compare the two selected” from the bar that appears above the table.'
    ));
    wrap.appendChild(note(
      'A commit and one of its own ancestors compare normally. Two commits from histories that never ' +
      'met do not — there is no state both started from, so there is nothing to diff them against, and ' +
      'this view will say that rather than inventing a base.'
    ));
    if (pair.length) {
      wrap.appendChild(actionRow([
        widgets.button({ label: 'Compare these two', kind: 'primary', action: 'compare-picked' }),
        widgets.button({ label: 'Clear the selection', kind: 'tertiary', action: 'pick-clear' }),
      ]));
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------------------------
  // Compare & Merge (REQ-VCS-009, REQ-VCS-010, REQ-VCS-011, REQ-SYNC-005)
  // ---------------------------------------------------------------------------------------------

  /**
   * The plan this section is showing, or null.
   *
   * Two things can put a plan here, and they are not the same event. A reconcile that found divergence
   * arrives from the shell with `ctx.compare` set — the user did not ask for this comparison, the file
   * did — and it is shown first and named as such. A plan the user built by picking two commits in the
   * log is the other.
   *
   * Built fresh on each render rather than cached: `compare.plan` is pure over the two heads, so
   * caching it would only create the possibility of showing a plan for heads that are no longer the
   * ones on screen.
   */
  function currentPlan(ctx) {
    if (!ctx.history || !ctx.history.head) return null;
    var pending = ctx.compare;
    if (pending && core.isString(pending.aHead) && core.isString(pending.bHead)) {
      return {
        source: 'reconcile',
        plan: vcs.compare
          ? TMV.compare.plan(ctx.history, pending.aHead, pending.bHead, planOptions(ctx, pending))
          : null,
        request: pending,
      };
    }
    if (picked.a && picked.b) {
      return {
        source: 'picked',
        plan: TMV.compare.plan(ctx.history, picked.a, picked.b, planOptions(ctx, null)),
        request: { aHead: picked.a, bHead: picked.b, aName: 'A', aRole: 'The first commit you picked',
          bName: 'B', bRole: 'The second commit you picked' },
      };
    }
    return null;
  }

  /**
   * The options `compare.plan` takes.
   *
   * `workingDirty` is the load-bearing one: REQ-VCS-012 says a merge cannot be built on top of
   * uncommitted edits, and it is the shell's own definition of dirty that is passed, so the refusal
   * here cannot disagree with the header indicator that offers to commit.
   */
  function planOptions(ctx, request) {
    var dirty = false;
    try {
      dirty = TMV.shell.logic.dirtyState(ctx.history, ctx.model, ctx.editable).dirty === true;
    } catch (err) {
      dirty = false;
    }
    var req = request || pickedRequest(ctx);
    return {
      workingDirty: dirty,
      aName: req.aName,
      aRole: req.aRole,
      bName: req.bName,
      bRole: req.bRole,
    };
  }

  function pickedRequest(ctx) {
    var head = ctx.history ? ctx.history.head : null;
    var other = picked.a === head ? picked.b : picked.a;
    return {
      aHead: picked.a,
      bHead: picked.b,
      aName: picked.a === head ? 'This browser' : 'Commit ' + core.shortId(picked.a || ''),
      aRole: picked.a === head ? 'The head of the history on screen' : 'The commit you picked first',
      bName: picked.b === head ? 'This browser' : 'Commit ' + core.shortId(picked.b || ''),
      bRole: picked.b === head ? 'The head of the history on screen' : 'The second commit you picked',
      other: other,
    };
  }

  function compareSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });
    var current = currentPlan(ctx);

    if (!current || !current.plan) {
      body.appendChild(V.emptySection({
        title: 'Nothing to compare yet',
        body:
          'Pick two commits in the Log and choose “Compare the two selected”. A comparison opened by a ' +
          'file whose history has diverged from this browser’s appears here on its own.',
      }));
      body.appendChild(note(
        'When a file arrives with a history that has diverged, this is where it lands. Nothing is ' +
        'merged automatically and nothing is chosen for you: the two sides are shown side by side and a ' +
        'person decides what the result should be.'
      ));
      body.appendChild(actionRow([
        widgets.button({ label: 'Go to the log', kind: 'tertiary', action: 'go-log' }),
      ]));
      return V.section(ctx, 'Compare & Merge', 'What two histories differ by, and what merging them would produce.',
        body);
    }

    if (current.source === 'reconcile') {
      body.appendChild(note(
        'This comparison was opened because the file you loaded and the copy in this browser have ' +
        'diverged. Neither is wrong and neither is newer: they are two sets of work that share an ' +
        'ancestor and then went different ways. Nothing has been written and nothing will be until you ' +
        'confirm a resolution.',
        'warning'
      ));
    }

    var plan = current.plan;
    if (!plan.ok) {
      // The plan's own refusal, shown as written. `compare` owns this wording because the same refusal
      // is reached from the reconcile path, and two copies of it would eventually disagree.
      body.appendChild(widgets.emptyState({
        title: 'These two cannot be compared',
        body: plan.message || 'The comparison could not be built.',
      }));
      if (plan.reason === 'dirty') {
        body.appendChild(actionRow([
          widgets.button({ label: 'Commit the changes', kind: 'primary', action: 'go-commit' }),
          widgets.button({ label: 'See the stashes', kind: 'tertiary', action: 'go-stashes' }),
        ]));
      }
      if (current.source === 'picked') {
        body.appendChild(actionRow([
          widgets.button({ label: 'Clear the selection', kind: 'tertiary', action: 'pick-clear' }),
        ]));
      }
      return V.section(ctx, 'Compare & Merge', 'What two histories differ by, and what merging them would produce.',
        body);
    }

    if (plan.approximate || plan.baseMultiple) {
      body.appendChild(note(
        'This history has more than one common ancestor for these two commits — a criss-cross. The ' +
        'comparison uses one of them, so the differences shown may include changes that were already ' +
        'agreed on both sides. It is disclosed rather than hidden because it changes what the diff means.',
        'warning'
      ));
    }

    body.appendChild(compareScreen(ctx, current));

    return V.section(
      ctx,
      'Compare & Merge',
      'What two histories differ by, and what merging them would produce. The choices are suggestions ' +
        'until you confirm them.',
      body
    );
  }

  /**
   * The three-pane screen, wired to the confirm step.
   *
   * The screen itself is `16-compare.js`'s — it owns the diff layout, the suggestion rule and the
   * classification, and a second implementation here would be a second answer to the same question.
   * What this function adds is the two things only the hosting view can do: settle the shell after the
   * merge commit is written, and clear the reconcile request that started it.
   */
  function compareScreen(ctx, current) {
    var host = core.el('div', { class: 'tmv-compare-host' });

    var screen = TMV.compare.screen({
      plan: current.plan,
      filter: TMV.compare.FILTER_NEEDS,
      onCancel: function () {
        if (current.source === 'reconcile') {
          // Dismissing leaves both histories and the working copy exactly as they are (REQ-VCS-009
          // AC3). Clearing the request is what stops the same comparison reopening on the next render;
          // it writes nothing.
          ctx.shell.setCompare(null);
          TMV.notify.outcome({
            level: 'info',
            title: 'Comparison dismissed',
            detail: 'Both histories and the working copy are unchanged, and the stored copy is untouched.',
            ref: 'compare.dismiss',
          });
        } else {
          clearPick();
        }
        ctx.refresh();
      },
      onConfirm: function (mergedModel, info) {
        openMergeDialog(ctx, {
          plan: info.plan,
          resolution: info.resolution,
          applied: info.applied,
        });
      },
    });
    host.appendChild(screen.element);

    return host;
  }

  /**
   * The confirm step, and the only place this tab writes.
   *
   * `mergeDialog` calls `vcs.mergeCommit`, which appends a commit with both heads as parents
   * (REQ-VCS-011) directly into the history object the shell is holding. Everything after that is
   * settlement: the new head has to be saved, the registry entry has to learn its new count, and the
   * working copy has to become the merged model *without* being marked as an uncommitted change — which
   * is what `resetToHead` is for, and why `edit()` would be wrong here.
   *
   * The reconcile request is cleared on the way out. The divergence has been resolved; leaving it set
   * would have the tab offer to merge again a moment after it was merged.
   */
  function openMergeDialog(ctx, options) {
    var author = ctx.prefs && core.isObject(ctx.prefs.identity)
      ? ctx.prefs.identity
      : { name: '', email: '' };

    return TMV.compare.mergeDialog({
      plan: options.plan,
      resolution: options.resolution,
      applied: options.applied,
      history: ctx.history,
      author: author,
      onMerged: function (commit) {
        ctx.shell.setCompare(null);
        clearPick();
        ctx.shell.persistHistory('merge');
        ctx.shell.reloadRegistry();
        ctx.shell.resetToHead();
        TMV.notify.outcome({
          level: 'success',
          title: 'Merged as ' + core.shortId(commit.id),
          detail:
            'Both histories are parents of this commit and both are still reachable, so neither side ' +
            'was discarded. Export the file to give the other copy the same result.',
          ref: 'compare.merged',
        });
        ctx.refresh();
      },
      onClose: function (reason) {
        if (reason === 'cancel' || reason === 'escape' || reason === 'dismiss') {
          // Backing out of the confirmation is not a decision — the screen behind it still holds the
          // choices, and the histories are untouched.
          return;
        }
      },
    });
  }

  function clearPick() {
    picked = { a: null, b: null };
  }

  // ---------------------------------------------------------------------------------------------
  // Conflicts (REQ-VCS-009, REQ-VCS-010)
  // ---------------------------------------------------------------------------------------------

  /**
   * The decisions the current comparison still needs an answer for, on their own screen.
   *
   * This exists because "conflicts" is the thing a user is actually looking for when they open History
   * after a divergence, and making them find it by scanning a long diff is the wrong shape. It is the
   * same computation the Compare screen's confirm button is gated on — `compare.missingDecisions` — so
   * the count in the side nav and the list here cannot disagree with the button.
   *
   * The empty state is not an empty screen: "no conflicts" is a meaningful, reassuring answer, and it
   * should say what it means rather than showing a table with no rows.
   */
  function conflictsSection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });
    var current = currentPlan(ctx);

    if (!current) {
      body.appendChild(V.emptySection({
        title: 'No comparison is open',
        body:
          'There is nothing to conflict. Conflicting changes can only be seen against a comparison, and ' +
          'one is opened either by picking two commits in the Log or by loading a file whose history has ' +
          'diverged from this browser’s.',
      }));
      return V.section(ctx, 'Conflicts', 'The decisions a comparison still needs, listed on their own.',
        body);
    }

    // A comparison can be open and still not produce anything to list. Saying "no comparison is open"
    // here would flatly contradict the Compare section, which at that same moment is showing the
    // refusal and the reason for it — so the refusal is repeated rather than overwritten.
    if (!current.plan || !current.plan.ok) {
      body.appendChild(V.emptySection({
        title: 'This comparison cannot be planned',
        body: (current.plan && current.plan.message)
          || 'The comparison could not be built, so there are no decisions to list.',
      }));
      if (current.plan && current.plan.reason === 'dirty') {
        body.appendChild(actionRow([
          widgets.button({ label: 'Commit the changes', kind: 'primary', action: 'go-commit' }),
          widgets.button({ label: 'See the stashes', kind: 'tertiary', action: 'go-stashes' }),
        ]));
      }
      body.appendChild(actionRow([
        widgets.button({ label: 'Open the comparison', kind: 'tertiary', action: 'go-compare' }),
      ]));
      return V.section(ctx, 'Conflicts', 'The decisions a comparison still needs, listed on their own.',
        body);
    }

    var plan = current.plan;
    // Started from the suggestions, not from nothing. The Compare screen opens with non-overlapping
    // changes pre-selected (REQ-VCS-009 AC2), so a resolution of `{}` here would report every decision
    // as unanswered and contradict the screen one section away.
    var resolution = TMV.compare.defaultResolution(plan);
    var missing = TMV.compare.missingDecisions(plan, resolution);

    body.appendChild(V.definitionSection(ctx, {
      title: 'The comparison',
      pairs: [
        { term: 'Base', value: plan.base ? 'Commit ' + plan.base.short + ' — ' + plan.base.role : 'no common ancestor' },
        { term: 'A', value: plan.a.name + ' — ' + plan.a.short },
        { term: 'B', value: plan.b.name + ' — ' + plan.b.short },
        { term: 'Summary', value: TMV.compare.summaryLine(plan) },
        { term: 'Approximate', value: plan.approximate ? 'Yes — more than one common ancestor' : 'No' },
      ],
    }));

    if (!missing.length) {
      body.appendChild(widgets.emptyState({
        title: 'No conflicts',
        body:
          plan.decisions && plan.decisions.length
            ? 'Every difference in this comparison has an answer, either because it was suggested or ' +
              'because only one side changed anything. Nothing is blocked.'
            : 'These two sides made the same changes, or only one of them changed anything at all. ' +
              'There is nothing to decide.',
      }));
      return V.section(ctx, 'Conflicts', 'The decisions a comparison still needs, listed on their own.',
        body);
    }

    body.appendChild(note(
      // `core.plural` prepends the count, so the verb has to be chosen with it: "1 decision still
      // needs" and "2 decisions still need" cannot share one ending.
      (missing.length === 1 ? '1 decision still needs' : missing.length + ' decisions still need') +
      ' an answer before this can be merged. Each of these is a place where both sides changed the ' +
      'same thing, so there is no suggestion that would not be a guess.'
    ));

    var rows = [];
    for (var i = 0; i < missing.length; i++) {
      var decision = missing[i];
      rows.push({
        id: 'c' + i,
        cells: [
          core.el('span', { text: decision.kind ? String(decision.kind) : 'change' }),
          core.el('span', { text: decision.label || decision.key || '(unnamed)' }),
          core.el('code', { class: 'tmv-code', text: String(decision.label ? decision.key : '') }),
          core.el('span', {
            text: (decision.sides || []).length
              ? core.plural(decision.sides.length, 'side') + ' changed it'
              : 'both sides changed it',
          }),
        ],
      });
    }
    body.appendChild(widgets.structuredList({
      label: 'Decisions without an answer',
      headers: ['Kind', 'What', 'Key', 'Why it is here'],
      rows: rows,
    }));

    body.appendChild(actionRow([
      widgets.button({ label: 'Open the comparison', kind: 'primary', action: 'go-compare' }),
    ]));
    return V.section(ctx, 'Conflicts', 'The decisions a comparison still needs, listed on their own.', body);
  }

  // ---------------------------------------------------------------------------------------------
  // Stashes (REQ-VCS-012, `04-versioning.md` §5)
  // ---------------------------------------------------------------------------------------------

  /**
   * Stashes, which are the reason a reconcile can proceed without losing work.
   *
   * `04-versioning.md` §5 is emphatic about why this screen is prominent: "a forgotten stash is a lost
   * edit". A stash lives only in this browser, is never exported, and is dropped when the page is
   * closed — so the section says all three, in that order, and the side nav carries a count so the
   * stash is visible from every other tab without the user having to remember it exists.
   *
   * A stash is not a commit and is deliberately not presented as one. It is a delta from the head with
   * no id, no author and no place in the chain, and calling it a commit would invite the reader to
   * assume it is backed up somewhere.
   */
  function stashesSection(ctx) {
    // `--wide` for the same reason as the log: the block holds a table, not prose.
    var body = core.el('div', { class: 'tmv-settings__block tmv-settings__block--wide' });
    var stashes = [];
    try {
      stashes = ctx.shell.stashList() || [];
    } catch (err) {
      stashes = [];
    }

    body.appendChild(note(
      'A stash is work that is not in any commit. When reconciling with a file is blocked by uncommitted ' +
      'changes, stashing puts those changes aside so the reconcile can proceed, and this screen is where ' +
      'they are picked back up.'
    ));

    if (!stashes.length) {
      body.appendChild(widgets.emptyState({
        title: 'Nothing is stashed',
        body:
          'No work is being held aside. If a reconcile is ever blocked by uncommitted changes, one of ' +
          'the options offered is to stash them, and whatever is stashed will appear here.',
      }));
      return V.section(ctx, 'Stashes', 'Work set aside so a reconcile could proceed, and where it is picked back up.',
        body);
    }

    var rows = [];
    for (var i = 0; i < stashes.length; i++) {
      var stash = stashes[i] || {};
      var delta = core.isArray(stash.delta) ? stash.delta : [];
      // One wrapper per stash, carrying the index the Reapply button needs. `dataTable` renders cells
      // from a `render(row)` per column, so the row has to be data the columns can read — a `cells`
      // array is `structuredList`'s shape and would render an empty table here.
      rows.push({ id: 'stash-' + i, index: i, stash: stash, delta: delta });
    }

    body.appendChild(widgets.dataTable({
      caption: 'Stashes held in this browser',
      rowKey: function (row) { return row.id; },
      columns: [
        {
          key: 'contents',
          label: 'Contents',
          render: function (row) {
            return core.el('span', {
              text: row.delta.length ? core.plural(row.delta.length, 'change') : 'No recorded changes',
            });
          },
        },
        {
          key: 'base',
          label: 'Based on',
          render: function (row) {
            return core.el('code', {
              class: 'tmv-code',
              text: row.stash.base ? core.shortId(row.stash.base) : 'unknown',
            });
          },
        },
        {
          key: 'stashed',
          label: 'Stashed',
          render: function (row) {
            return core.el('span', {
              text: row.stash.createdAt
                ? core.relativeTime(row.stash.createdAt)
                : 'time not recorded',
            });
          },
        },
        {
          key: 'reason',
          label: 'Why',
          render: function (row) {
            return core.el('span', { text: row.stash.reason || 'no reason recorded' });
          },
        },
        {
          key: 'actions',
          label: 'Actions',
          render: function (row) {
            return widgets.button({
              label: 'Reapply',
              kind: 'primary',
              size: 'sm',
              action: 'stash-apply',
              value: String(row.index),
            });
          },
        },
      ],
      rows: rows,
      stickyHeader: false,
    }).element);

    body.appendChild(note(
      'Reapplying puts the changes back into the working copy, where they are editable but still not ' +
      'committed — the stash is not a commit and applying it does not create one.'
    ));
    body.appendChild(bullets([
      'A stash is kept in this browser only. It is never written into an exported file, so it does not ' +
        'travel with the model and is not visible to anyone else.',
      'It is held for this session. Closing the page loses it, which is why this screen says so plainly ' +
        'and why the count appears in the navigation.',
      'If the head has moved too far since the stash was taken for it to apply cleanly, the application ' +
        'says so rather than applying part of it — a half-applied stash would be worse than none.'
    ]));
    return V.section(ctx, 'Stashes', 'Work set aside so a reconcile could proceed, and where it is picked back up.',
      body);
  }

  // ---------------------------------------------------------------------------------------------
  // Integrity (REQ-VCS-002, REQ-VIEW-008, ADR-0008, `08-security.md` §8)
  // ---------------------------------------------------------------------------------------------

  /**
   * Two separate checks, reported separately, because they fail for different reasons.
   *
   * `verifyChain` recomputes each commit's id from its own stored fields and checks that every parent
   * it names exists. That catches a commit that has been edited, a commit that has been removed, and a
   * history assembled from two files that do not belong together.
   *
   * `verifyModel` reconstructs the head from its nearest keyframe plus the intervening deltas and checks
   * the result against the recorded model hash. That catches a delta that does not apply cleanly or a
   * snapshot that has been altered — a failure the chain check alone would not see, because a delta is
   * inside a commit that still hashes correctly.
   *
   * **The wording is the point.** `08-security.md` §8 requires "chain intact" and never "verified", and
   * ADR-0008 explains why: the chain establishes that the content has not changed, not who wrote it.
   * The author name and the timestamp are inside the data the hash covers, so a history can be entirely
   * intact and entirely invented. `04-versioning.md`'s own wording is looser than this; the security
   * document and the ADR govern, and the interface follows them.
   *
   * A failure does not throw the user out. REQ-VCS-002 AC2 requires the app to remain usable read-only,
   * and REQ-VIEW-008 requires the failing commit to be named and the export offered — because a
   * damaged history may still contain the only copy of the model, and the way to keep it is to get it
   * out of the page.
   */
  function integritySection(ctx) {
    var body = core.el('div', { class: 'tmv-settings__block' });

    if (!ctx.history) {
      body.appendChild(V.emptySection({
        title: 'There is no history to check',
        body: 'This page has no stored history, so there is nothing whose integrity could be established.',
      }));
      return V.section(ctx, 'Integrity', 'Whether the stored history is the history that was written.', body);
    }

    var chain = null;
    var head = null;
    try {
      chain = vcs.verifyChain(ctx.history);
    } catch (err) {
      chain = { ok: false, problems: [{ message: err && err.message ? err.message : 'The chain could not be checked.' }], errorCount: 1 };
    }
    try {
      head = ctx.history.head ? vcs.verifyModel(ctx.history, ctx.history.head) : null;
    } catch (err) {
      head = { ok: false, problems: [{ message: err && err.message ? err.message : 'The head could not be reconstructed.' }] };
    }

    body.appendChild(verdictBlock(ctx, chain, head));
    var chainProblems = chainProblemsBlock(ctx, chain);
    if (chainProblems) body.appendChild(chainProblems);
    if (head && head.problems && head.problems.length) body.appendChild(headProblemsBlock(ctx, head));

    body.appendChild(subhead('What this check does and does not establish'));
    body.appendChild(bullets([
      'It establishes that every stored commit hashes to the identifier it declares, that every parent ' +
        'a commit names is present, and that the head reconstructs from its keyframe and deltas to the ' +
        'model content it claims. In short: the stored bytes are the bytes that were written.',
      'It does not establish who wrote anything. The author name and the timestamp are inside the data ' +
        'the hash covers, so a history can be completely intact and still have been written by someone ' +
        'else entirely, or generated wholesale with a different name on every commit.',
      'For that reason the interface says the chain is intact and never that a history is verified. ' +
        'Authorship in this application is self-asserted, and the Identity screen says the same thing in ' +
        'the same words.'
    ]));

    body.appendChild(subhead('If something is wrong'));
    body.appendChild(bullets([
      'The model stays usable. A history that does not check out is opened read-only (REQ-VCS-002 AC2): ' +
        'editing is removed rather than disabled, and the reason is on screen.',
      'Export still works, and it is the first thing to do. A damaged history may hold the only copy of ' +
        'the model, and exporting gets the content out of the page before anything else touches it.',
      'Nothing is repaired automatically. An application that silently corrected a history would destroy ' +
        'the evidence of what happened to it, and the correction would be indistinguishable from the ' +
        'damage.'
    ]));

    if (chain && chain.ok === false) {
      body.appendChild(actionRow([
        widgets.button({ label: 'Go to Export', kind: 'primary', action: 'go-export' }),
      ]));
    }

    return V.section(
      ctx,
      'Integrity',
      'Whether the stored history hashes to itself. It establishes integrity, and never authorship.',
      body
    );
  }

  function verdictBlock(ctx, chain, head) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    var errors = chain && core.isNumber(chain.errorCount)
      ? chain.errorCount
      : (chain && core.isArray(chain.problems) ? chain.problems.length : 0);
    var warnings = 0;
    if (chain && core.isArray(chain.problems)) {
      for (var i = 0; i < chain.problems.length; i++) {
        if (chain.problems[i].severity === 'warning') warnings++;
      }
    }

    // The headline sentence is the one place the vocabulary is fixed, so it is written here as a
    // literal rather than assembled — there is no string in this view that could turn it into
    // "verified", and a test can assert the exact phrase.
    var headline = chain && chain.ok
      ? 'Chain intact.'
      : 'The chain does not check out.';

    wrap.appendChild(core.el('p', {
      class: 'tmv-verdict' + (chain && chain.ok ? '' : ' tmv-verdict--error'),
      'data-verdict': chain && chain.ok ? 'intact' : 'broken',
      text: headline,
    }));

    var commits = ctx.history && core.isArray(ctx.history.commits) ? ctx.history.commits.length : 0;
    wrap.appendChild(V.definitionSection(ctx, {
      title: 'Integrity check',
      pairs: [
        {
          term: 'Result',
          value: chain && chain.ok
            ? 'Every commit hashes to the identifier it declares, and every parent it names is present.'
            : core.plural(errors, 'commit or field', 'commits or fields') + ' could not be verified.',
        },
        { term: 'Commits stored', value: String(commits) },
        { term: 'Commits reachable from the head', value: String(reachable(ctx).length) },
        { term: 'Errors', value: String(errors) },
        { term: 'Notes', value: warnings ? core.plural(warnings, 'note') : 'None' },
        {
          term: 'Head reconstruction',
          value: !head
            ? 'No head to reconstruct'
            : head.ok
              ? 'The head reconstructs to the model content its commit records'
              : 'The head does not reconstruct to what its commit records',
        },
        { term: 'What this establishes', value: 'That the content has not changed since it was hashed' },
        { term: 'What it does not establish', value: 'Who wrote it. Authorship is self-asserted.' },
      ],
    }));
    return wrap;
  }

  /**
   * The problems the chain check found, or `null` when it found none.
   *
   * Returning null rather than an empty block: a heading with nothing under it reads as a section
   * that failed to load, and a reader cannot tell that from a check that had nothing to report.
   */
  function chainProblemsBlock(ctx, chain) {
    var problems = chain && core.isArray(chain.problems) ? chain.problems : [];
    if (!problems.length) return null;

    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('What the check found'));
    var rows = [];
    for (var i = 0; i < problems.length && i < 50; i++) {
      var p = problems[i] || {};
      rows.push({
        id: 'p' + i,
        cells: [
          core.el('code', { class: 'tmv-code', text: String(p.code || 'problem') }),
          core.el('span', {
            text: p.id ? core.shortId(p.id) + (p.path ? ' · ' + p.path : '') : String(p.path || '(history)'),
          }),
          core.el('span', { text: String(p.message || '') }),
          core.el('span', { text: p.severity === 'warning' ? 'Note' : 'Error' }),
        ],
      });
    }
    wrap.appendChild(widgets.structuredList({
      label: 'Problems found in the chain',
      headers: ['Check', 'Where', 'What', 'Severity'],
      rows: rows,
    }));
    if (problems.length > 50) {
      wrap.appendChild(note('And ' + core.plural(problems.length - 50, 'more problem') + '.'));
    }
    wrap.appendChild(note(
      'A commit listed here as unreachable is not damage. Nothing in this application removes commits, ' +
      'but a file assembled from two sources can carry one whose parent is no longer in the file — that ' +
      'is a note, not an error, and it does not make the readable history wrong.'
    ));
    return wrap;
  }

  function headProblemsBlock(ctx, head) {
    var wrap = core.el('div', { class: 'tmv-settings__block' });
    wrap.appendChild(subhead('The head did not reconstruct'));
    var rows = [];
    for (var i = 0; i < head.problems.length && i < 50; i++) {
      var p = head.problems[i] || {};
      rows.push({
        id: 'h' + i,
        cells: [
          core.el('code', { class: 'tmv-code', text: String(p.code || 'problem') }),
          core.el('span', { text: String(p.message || '') }),
        ],
      });
    }
    wrap.appendChild(widgets.structuredList({
      label: 'Problems reconstructing the head',
      headers: ['Check', 'What'],
      rows: rows,
    }));
    wrap.appendChild(note(
      'This is the check the chain check cannot make. A commit can hash to its own identifier and still ' +
        'carry a delta that does not apply, and this is where that is caught.',
      'warning'
    ));
    return wrap;
  }

  // ---------------------------------------------------------------------------------------------
  // Revert (REQ-VCS-013)
  // ---------------------------------------------------------------------------------------------

  /**
   * Revert, which is forward-only, and the confirmation says so in those words.
   *
   * REQ-VCS-013 and `04-versioning.md` §7: reverting to commit *X* creates a *new* commit whose content
   * equals *X*'s. Nothing becomes unreachable, no id changes, and every previously exported copy still
   * reconciles against the result. A user who expects "go back to how it was" to mean "make it as
   * though the later commits never happened" will be surprised by the log, so the dialog says what will
   * appear there rather than leaving them to discover it.
   */
  function askRevert(ctx, targetId) {
    var target = commitOf(ctx, targetId);
    if (!target) {
      TMV.notify.failure({
        title: 'That commit is not in this history',
        detail: 'It may have been removed from the file since the log was drawn.',
        ref: 'revert.missing',
      });
      return null;
    }
    revertTarget = targetId;

    var instance = widgets.modal({
      title: 'Revert to commit ' + core.shortId(targetId),
      size: 'sm',
      body: [
        core.el('p', {
          text:
            'This creates a new commit whose content is exactly this one’s. It does not remove the ' +
            'commits that came after it, and it does not change any commit identifier.',
        }),
        V.definitionSection(ctx, {
          title: 'The commit being reverted to',
          pairs: [
            { term: 'Commit', value: core.el('code', { class: 'tmv-code', text: target.id }) },
            { term: 'Message', value: messageOf(target) },
            { term: 'Author', value: authorOf(target) },
            { term: 'Committed', value: target.timestamp ? core.formatDateTime(target.timestamp) : 'no timestamp' },
          ],
        }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'The new commit records what it reverts to, so the reason survives in the log next to the ' +
            'commit it undoes. Nothing is lost: every commit in this history stays reachable, and any ' +
            'file already exported still reconciles against the result.',
        }),
      ],
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Revert', kind: 'danger', action: 'confirm' },
      ],
    });
    instance.open();

    TMV.forms.modalActions(instance, function (action) {
      if (action !== 'confirm') {
        revertTarget = null;
        instance.close('cancel');
        return;
      }
      instance.close('confirm');
      doRevert(ctx, targetId);
    });
    return instance;
  }

  function doRevert(ctx, targetId) {
    revertTarget = null;
    var author = ctx.prefs && core.isObject(ctx.prefs.identity)
      ? ctx.prefs.identity
      : { name: '', email: '' };
    var record;
    try {
      record = vcs.revertTo(ctx.history, targetId, author, undefined, {
        keyframeInterval: ctx.history.keyframeInterval,
      });
    } catch (err) {
      TMV.notify.failure({
        title: 'The revert could not be written',
        detail: err && err.message ? err.message : 'An unexpected error while writing the commit.',
        ref: 'revert.write',
      });
      return null;
    }

    ctx.shell.persistHistory('revert');
    ctx.shell.reloadRegistry();
    ctx.shell.resetToHead();
    TMV.notify.outcome({
      level: 'success',
      title: 'Reverted as ' + core.shortId(record.id),
      detail:
        'A new commit now holds the content of ' + core.shortId(targetId) + '. Nothing was removed — ' +
        'the commits in between are still in the log, and export the file to share the result.',
      ref: 'revert.done',
    });
    ctx.refresh();
    return record;
  }

  // ---------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------

  function wire(root, ctx) {
    core.delegate(root, 'click', function (event, node) {
      var action = node.getAttribute('data-action');
      if (action === 'compare-picked') {
        // The batch action's selection lives in the table, not in this view, so it is read back from
        // the table the button belongs to. Two ids are what the compare screen can use; anything else
        // is a mis-click and is answered rather than ignored.
        var ids = selectedIds(root);
        if (ids.length !== 2) {
          TMV.notify.outcome({
            level: 'info',
            title: ids.length < 2 ? 'Two commits are needed' : 'Only two commits can be compared',
            detail: ids.length < 2
              ? 'Select exactly two commits in the log, then compare them. A comparison is a three-way ' +
                'diff, so it needs two endpoints.'
              : 'Three or more commits cannot be compared at once. Clear the selection and pick two.',
            ref: 'compare.pick',
          });
          return;
        }
        // Oldest as A, newest as B, so the diff reads in the order the history happened. Depth is the
        // only ordering that means anything here — the timestamps are not consulted (REQ-VCS-007).
        var ordered = orderByAncestry(ctx, ids[0], ids[1]);
        picked = { a: ordered[0], b: ordered[1] };
        ctx.go('history', 'compare');
        return;
      }
      if (action === 'pick-clear') {
        clearPick();
        ctx.refresh();
        return;
      }
      if (action === 'revert-ask') {
        askRevert(ctx, node.getAttribute('data-value'));
        return;
      }
      if (action === 'stash-apply') {
        ctx.shell.applyStash();
        ctx.refresh();
        return;
      }
      if (action === 'go-log') {
        ctx.go('history', 'log');
        return;
      }
      if (action === 'go-compare') {
        ctx.go('history', 'compare');
        return;
      }
      if (action === 'go-stashes') {
        ctx.go('history', 'stashes');
        return;
      }
      if (action === 'go-commit') {
        ctx.shell.commit();
        return;
      }
      if (action === 'go-export') {
        ctx.go('settings', 'export');
        return;
      }
    });
    return root;
  }

  /** The ids the log's checkboxes currently hold. Read from the DOM; the table owns that state. */
  function selectedIds(root) {
    var boxes = root.querySelectorAll('input[data-action="select-row"]');
    var ids = [];
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked === true) ids.push(boxes[i].getAttribute('data-row'));
    }
    return ids;
  }

  /**
   * Put two commits in ancestry order, so the diff reads A → B rather than backwards.
   *
   * Where neither is an ancestor of the other — a genuine divergence — the order is decided by depth
   * and then by id, which is the same tie-break `vcs.log` uses. Depth is derived from ancestry, so this
   * never consults a timestamp (REQ-VCS-007).
   */
  function orderByAncestry(ctx, one, two) {
    if (!ctx.history) return [one, two];
    var depth = {};
    try {
      depth = vcs.depths(ctx.history) || {};
    } catch (err) {
      depth = {};
    }
    if (vcs.isAncestor && ctx.history) {
      try {
        if (vcs.isAncestor(ctx.history, one, two)) return [one, two];
        if (vcs.isAncestor(ctx.history, two, one)) return [two, one];
      } catch (err) {
        // Fall through to the depth tie-break.
      }
    }
    var da = depth[one] === undefined ? 0 : depth[one];
    var db = depth[two] === undefined ? 0 : depth[two];
    if (da !== db) return da < db ? [one, two] : [two, one];
    return one < two ? [one, two] : [two, one];
  }

  // ---------------------------------------------------------------------------------------------
  // Render and registration
  // ---------------------------------------------------------------------------------------------

  function render(ctx) {
    if (!core.isObject(ctx.model)) {
      return V.emptySection({ title: 'No model is open', body: 'There is no history to show.' });
    }
    var node;
    switch (ctx.section) {
      case 'compare':
        node = compareSection(ctx);
        break;
      case 'conflicts':
        node = conflictsSection(ctx);
        break;
      case 'stashes':
        node = stashesSection(ctx);
        break;
      case 'integrity':
        node = integritySection(ctx);
        break;
      case 'log':
      default:
        node = logSection(ctx);
        break;
    }
    return wire(node, ctx);
  }

  /**
   * The two counts this tab contributes to the side nav.
   *
   * Both are things a user should be able to see without opening the tab, and both are things that can
   * be true and forgotten: a decision that needs an answer, and work held aside. The shell renders a
   * badge only for sections flagged as findings, so returning `{}` — rather than a number — when there
   * is no comparison at all is what keeps the tab from advertising a conflict count of zero, which
   * would read as "there is a problem and it is nothing".
   */
  function counts(ctx) {
    var out = Object.create(null);
    try {
      var current = currentPlan(ctx);
      if (current && current.plan && current.plan.ok) {
        // Counted from the same starting point the Compare screen uses, so the badge and the screen
        // agree. Anything else would show a conflict count that the Conflicts section then denies.
        out.conflicts = TMV.compare.missingDecisions(
          current.plan,
          TMV.compare.defaultResolution(current.plan)
        ).length;
      }
      out.stashes = (ctx.shell.stashList() || []).length;
    } catch (err) {
      // A count that cannot be computed is left absent, which the shell renders as a dash rather than
      // as zero. A failing count must not be able to say "no conflicts" when the truth is unknown.
      return Object.create(null);
    }
    return out;
  }

  TMV.shell.register({
    id: ID,
    title: 'History',
    render: render,
    counts: counts,
  });

  /**
   * The parts of this tab worth asserting without a document: that two commits are ordered by ancestry
   * and never by timestamp, and that the integrity vocabulary is the fixed phrase.
   */
  TMV.history = {
    VERDICT_INTACT: 'Chain intact.',
    VERDICT_BROKEN: 'The chain does not check out.',
    FILTER_ALL: FILTER_ALL,
    FILTER_CHANGED: FILTER_CHANGED,
    orderByAncestry: orderByAncestry,
  };
})(globalThis.TMV = globalThis.TMV || {});
