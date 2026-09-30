/*
 * edit.test.mjs — changing the working copy, and the four things that make a change safe.
 *
 * An edit is the only thing in this application that produces work rather than moving it, so it is
 * the only thing whose loss is unrecoverable. The requirements around it are all the same shape: a
 * change is in exactly one place (the working copy), that place is visibly different from the head
 * commit, and there is a way back until the moment there is not.
 *
 *   the working copy is visibly dirty, and leaving       REQ-EDIT-005
 *   warns
 *   a commit asks who and why, and says what changed      REQ-EDIT-006
 *   a discard restores the head exactly                   REQ-EDIT-007
 *   undo restores a deletion until the commit             REQ-EDIT-010
 *   bulk operations apply what they can and report        REQ-EDIT-008
 *   what they cannot
 *
 * Most of these are asserted through the DOM rather than through the shell's own API, because the
 * failure they exist to prevent is a wiring failure: `forms.undo` working perfectly while nothing
 * ever pushes onto it, or `bulkUpdate` reporting a failure into a region that is never rendered.
 * Both of those happened while this was being written, and neither is visible from a test that
 * calls the functions directly.
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadShell } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

/** The elements the shell declares in `src/index.html` and every edit test reaches for. */
function byId(dom, id) {
  return dom.body.querySelectorAll('[id="' + id + '"]')[0] || null;
}

function contentOf(dom) {
  return byId(dom, 'tmv-content');
}

/** The innermost modal is the one just opened; the stub keeps closed ones attached. */
function lastModal(dom) {
  const modals = dom.body.querySelectorAll('.cds--modal');
  return modals[modals.length - 1] || null;
}

/** Click the action a user would click, by its `data-action`. */
function press(root, action) {
  const node = root.querySelectorAll('[data-action="' + action + '"]')[0];
  assert.ok(node, `there is a [data-action="${action}"] to press`);
  node.click();
  return node;
}

/** Select every row of the list currently on screen, the way the checkbox column does. */
function selectAllRows(dom) {
  const boxes = contentOf(dom).querySelectorAll('[data-action="select-row"]');
  for (const box of boxes) {
    box.checked = true;
    box.dispatch('change', { target: box });
  }
  return boxes.length;
}

/** Put a working-copy change in, through the shell, without going near the DOM. */
function dirty(shell, edit) {
  const next = shell.core.deepCopy(shell.shell.state().model);
  edit(next, shell.TMV.model);
  assert.equal(shell.shell.edit(next, { reason: 'test' }), true, 'the edit was taken');
  return next;
}

// -----------------------------------------------------------------------------------------------

specTest('edit.dirty-indicator', () => {
  // REQ-EDIT-005 AC1: "the indicator appears within one interaction of a change". The indicator is
  // in the header, so this is a statement about the header and about `setDirty` — a shell that
  // computed the right answer and never wrote it to the element would satisfy every other test here.
  const shell = loadShell({});
  const { shell: s, dom, TMV: T } = shell;
  const flag = byId(dom, 'tmv-dirty');
  const text = byId(dom, 'tmv-dirty-text');
  const commitButton = byId(dom, 'tmv-commit');

  assert.ok(flag && text && commitButton, 'the header carries the indicator, its text and the commit button');
  assert.equal(flag.hasAttribute('hidden'), true, 'a fresh working copy is not dirty');
  assert.equal(commitButton.hasAttribute('disabled'), true, 'and there is nothing to commit');

  // One interaction: the edit is made, and nothing else is called.
  dirty(shell, (m, M) => M.insert(m, 'assumption', { id: 'asm-added-1', name: 'Not committed' }));

  assert.equal(flag.hasAttribute('hidden'), false, 'the indicator is visible in the same turn as the change');
  assert.equal(text.textContent, 'Uncommitted changes', 'and it says what it means');
  assert.equal(commitButton.hasAttribute('disabled'), false, 'the commit button became available with it');
  assert.equal(s.isDirty(), true);

  // The property that stops the indicator drifting: it is derived, never stored, so committing has
  // to put it back without anyone remembering to.
  const dialog = s.commit();
  const message = dialog.element.querySelectorAll('[data-action="commit-message"]')[0];
  message.value = 'Add an assumption';
  message.dispatch('input', { target: message });
  press(dialog.element, 'commit');

  assert.equal(s.isDirty(), false, 'the commit cleared the dirty state');
  assert.equal(flag.hasAttribute('hidden'), true, 'and the indicator went with it');
  assert.equal(commitButton.hasAttribute('disabled'), true);

  // A file opened read-only is never dirty, however it is used: there is no commit to be behind.
  const readOnly = loadShell({ editable: false, dirty: true });
  assert.equal(byId(readOnly.dom, 'tmv-dirty').hasAttribute('hidden'), true, 'a read-only file shows no dirty state');
  assert.equal(readOnly.shell.isDirty(), false);

  const state = T.shell.logic.dirtyState;
  assert.equal(state(null, {}, true).dirty, false, 'no history, no dirty state');
  assert.equal(state({ commits: {} }, { modelId: 'x' }, false).dirty, false, 'and a read-only one is never dirty');
});

specTest('edit.beforeunload', () => {
  // REQ-EDIT-005 AC2. The guard is the last thing standing between an afternoon's work and a closed
  // tab, and it is the one part of the shell that cannot be tested by looking at the DOM — so the
  // test supplies the window and fires the event itself.
  //
  // A `window` is injected and the shell remounted rather than stubbing the guard directly, because
  // the interesting question is whether the *shell* installs one at all. `mount` reads the global
  // `window`, and the unit context has none, which is why the harness's own shells are guarded by
  // nothing — a fact worth asserting so that a future change to `guardUnload` that stops tolerating
  // a window-less environment fails here rather than in a browser.
  const shell = loadShell({});
  const { shell: s, ctx, dom, TMV: T } = shell;

  assert.equal(typeof ctx.window, 'undefined', 'the unit context has no window, and mounting without one is safe');
  const off = T.forms.guardUnload(() => true, {});
  assert.equal(typeof off, 'function', 'a guard with no window is a no-op that can still be called off');

  const events = [];
  ctx.window = {
    addEventListener(type, handler) { events.push({ op: 'add', type, handler }); },
    removeEventListener(type, handler) { events.push({ op: 'remove', type, handler }); },
  };
  s.unmount();
  const before = s.state();
  s.mount({
    adapter: before.adapter,
    container: before.container,
    embedded: before.embedded,
    model: before.model,
    history: before.history,
    editable: true,
  });

  const added = events.filter((e) => e.op === 'add' && e.type === 'beforeunload');
  assert.equal(added.length, 1, 'mounting installs exactly one beforeunload guard');
  const handler = added[0].handler;

  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  assert.equal(handler(event), undefined, 'a clean working copy does not warn');
  assert.equal(prevented, 0);

  dirty(shell, (m, M) => M.insert(m, 'assumption', { id: 'asm-added-2', name: 'Still not committed' }));
  const answer = handler(event);
  assert.equal(prevented, 1, 'a dirty working copy asks the browser to confirm');
  assert.equal(typeof answer, 'string', 'and returns a reason, which browsers that still show one will show');
  assert.match(answer, /uncommitted/i, `the reason says why, got ${JSON.stringify(answer)}`);

  // Committing makes it stop asking, without the guard being reinstalled.
  const dialog = s.commit();
  const message = dialog.element.querySelectorAll('[data-action="commit-message"]')[0];
  message.value = 'Add another assumption';
  message.dispatch('input', { target: message });
  press(dialog.element, 'commit');
  assert.equal(handler({ preventDefault() { prevented++; } }), undefined, 'and stops once the work is committed');

  s.unmount();
  assert.ok(
    events.some((e) => e.op === 'remove' && e.type === 'beforeunload'),
    'unmounting takes the guard off again, rather than leaving a listener on a page it no longer owns',
  );
  assert.ok(byId(dom, 'tmv-content'), 'the shell still has its content host');
});

specTest('edit.commit-dialog', () => {
  // REQ-EDIT-006. The dialog is where a hash becomes a reason, so the three things the requirement
  // names — the author, a required message, and a summary of what changed — are each asserted, and
  // then the commit itself is made through the dialog's own button rather than by calling `vcs`.
  const shell = loadShell({ dirty: true });
  const { shell: s, TMV: T, core } = shell;
  const M = T.model;

  const first = s.commit();
  assert.ok(first, 'a dirty working copy offers a commit');

  // The author, and the note that says what an author is: self-asserted, never verified (ADR-0008).
  // With no identity stored the dialog says so rather than leaving the line blank, because a commit
  // with no author is the state a user is most likely to discover *after* making one.
  assert.equal(first.element.querySelectorAll('.tmv-dialog__value')[0].textContent, 'Not set', 'no identity is stored yet');
  assert.match(first.element.textContent, /Set a name in Settings/, 'and the dialog says where to set one');
  assert.match(first.element.textContent, /never checked/, 'and that a name is recorded rather than verified');

  press(first.element, 'cancel');
  s.state().prefs.identity = { name: 'Tester', email: 't@example.com' };
  const dialog = s.commit();
  assert.ok(dialog, 'and again, now that there is an identity');
  const root = dialog.element;
  assert.equal(
    root.querySelectorAll('.tmv-dialog__value')[0].textContent,
    'Tester <t@example.com>',
    'the dialog shows the stored identity',
  );
  assert.match(
    root.textContent,
    /asserted by you rather than checked/,
    'and says plainly that the name is a claim rather than a check',
  );

  // The summary counts, which are three tags rather than a sentence.
  const counts = root.querySelectorAll('.tmv-summary-counts')[0];
  assert.ok(counts, 'the dialog carries a change summary');
  assert.match(counts.textContent, /1 added/, 'the fixture added one assumption and nothing else');
  assert.match(counts.textContent, /0 modified/);
  assert.match(counts.textContent, /0 removed/);

  // The message is required, and the button says so by being unavailable until it is there.
  const message = root.querySelectorAll('[data-action="commit-message"]')[0];
  assert.ok(message, 'the message field is in the dialog');
  const commitButton = root.querySelectorAll('[data-action="commit"]')[0];
  assert.equal(commitButton.hasAttribute('disabled'), true, 'commit is unavailable with no message');

  message.value = '   ';
  message.dispatch('input', { target: message });
  assert.equal(commitButton.hasAttribute('disabled'), true, 'and whitespace is not a message');

  message.value = 'Record the new assumption';
  message.dispatch('input', { target: message });
  assert.equal(commitButton.hasAttribute('disabled'), false, 'a message enables it');

  const before = s.state().history.commits.length;
  const previousHead = s.state().history.head;
  const previousModel = T.vcs.headModel(s.state().history);
  press(root, 'commit');

  assert.equal(s.state().history.commits.length, before + 1, 'exactly one commit was written');
  assert.equal(s.isDirty(), false, 'the working copy is now the head');

  const record = s.state().history.commits.filter((c) => c.id === s.state().history.head)[0];
  assert.ok(record, 'the new head is in the log');
  assert.equal(record.message, 'Record the new assumption', 'the commit carries the message, as typed');
  assert.equal(record.author.name, 'Tester', 'and the author from the stored identity');
  assert.equal(record.parents[0], previousHead, 'and it is a child of the commit it replaced');
  assert.equal(record.modelId, s.state().model.modelId, 'the head commit holds the model that was on screen');

  // The summary is computed from the two models rather than written into the dialog, so the count it
  // showed and the diff the commit represents are the same fact — checked here against the two
  // models rather than against the dialog's own arithmetic.
  const summary = T.forms.summariseChanges(previousModel, s.state().model);
  assert.equal(summary.empty, false, 'the commit is the change the dialog counted');
  assert.equal(summary.added, 1, 'one entity added, which is what the dialog said');
  assert.equal(T.forms.summaryText(summary), '1 added');
  assert.equal(core.isString(record.id), true);

  // Committing with nothing to commit is refused rather than writing an empty commit.
  assert.equal(s.commit(), null, 'a clean working copy has nothing to commit');
});

specTest('edit.discard', () => {
  // REQ-EDIT-007. "Restores the head exactly" is true by construction — the dialog hands back
  // `vcs.headModel`, which materialises the commit rather than replaying the diff — so what is worth
  // asserting is that it is *wired* to that, and that undo goes with it.
  const shell = loadShell({ dirty: true });
  const { shell: s, TMV: T, dom } = shell;
  const M = T.model;

  const head = T.vcs.headModel(s.state().history);
  const dirtyModel = s.state().model;
  assert.equal(T.vcs.isDirty(s.state().history, dirtyModel), true, 'the fixture really is dirty');
  assert.notEqual(T.container.serialize(dirtyModel), T.container.serialize(head), 'and differs from the head');

  const dialog = s.discard();
  assert.ok(dialog, 'a discard is offered');
  const root = dialog.element;
  assert.match(root.textContent, /Discard the working copy/, 'the dialog says what is about to happen');
  assert.match(root.textContent, /not committed anywhere/, 'and that the changes are not recoverable');
  assert.match(root.textContent, /Undo is cleared/, 'including by undo, which is the part a user would assume otherwise');

  // Cancel leaves everything alone. A confirmation that discards on whichever button is pressed is
  // worse than no confirmation at all, and the two actions are one element apart in the footer.
  press(root, 'cancel');
  assert.equal(s.isDirty(), true, 'cancelling keeps the working copy');
  assert.equal(
    M.collection(s.state().model, 'assumptions').some((a) => a.id === 'asm-uncommitted'),
    true,
    'with the uncommitted entity still in it',
  );
  assert.equal(T.forms.undo.depth() > 0, true, 'and the edit still on the undo stack');

  const again = s.discard();
  assert.ok(again, 'the dialog opens again');
  press(again.element, 'discard');

  assert.equal(s.isDirty(), false, 'the working copy is clean');
  assert.equal(
    T.container.serialize(s.state().model),
    T.container.serialize(head),
    'and it is the head commit, byte for byte',
  );
  assert.equal(T.forms.undo.depth(), 0, 'undo went with it, so a stray undo cannot put back what was discarded');
  assert.equal(s.undo(), false, 'and calling it says there is nothing to undo rather than doing something odd');
  assert.equal(byId(dom, 'tmv-dirty').hasAttribute('hidden'), true, 'the indicator agrees');
  assert.equal(M.collection(s.state().model, 'assumptions').some((a) => a.id === 'asm-uncommitted'), false);
});

specTest('edit.delete-undo', () => {
  // REQ-EDIT-010. The AC is that undo restores the deleted entities *with their identifiers and
  // references*, which is the part a naive implementation loses: re-inserting a deep copy under a
  // fresh id looks right on screen and silently breaks every threat that pointed at it.
  const shell = loadShell({});
  const { shell: s, TMV: T, dom, core } = shell;
  const M = T.model;

  s.go('threats');
  const target = M.collection(s.state().model, 'threats')[0];
  // A threat with something pointing at it, so "references" is not a vacuous clause.
  const referrers = M.referrersOf(s.state().model, target.id);
  assert.ok(referrers.length > 0, `the fixture has something referring to ${target.id}`);
  const before = core.deepCopy(target);

  // The DOM path: open the row, ask to delete it, confirm. Nothing here calls `forms.deleteEntity`.
  press(contentOf(dom), 'open-entity');
  const deleter = contentOf(dom).querySelectorAll('[data-action="delete-entity"]')[0];
  assert.equal(deleter.getAttribute('data-value'), target.id, 'the row that opened is the row that deletes');
  deleter.click();
  press(lastModal(dom), 'confirm');

  assert.equal(M.get(s.state().model, 'threats', target.id), null, 'the entity is gone from the working copy');
  assert.equal(s.isDirty(), true, 'and the deletion is a change like any other');

  // Undo, through the shell, and the entity comes back whole.
  assert.equal(s.undo(), true, 'the deletion is undoable');
  const restored = M.get(s.state().model, 'threats', target.id);
  assert.ok(restored, 'the entity is back');
  assert.equal(restored.id, target.id, 'with its own identifier, not a fresh one');
  same(restored, before, 'and every field it had');
  assert.equal(
    T.vcs.isDirty(s.state().history, s.state().model),
    false,
    'so the working copy is the head commit again',
  );
  const stillReferred = M.referrersOf(s.state().model, target.id);
  assert.equal(stillReferred.length, referrers.length, 'and the things that pointed at it still resolve');

  // Recoverable *until commit*. After one, the deletion is history and undo is gone with it — which
  // is the boundary the requirement draws, and the reason a user is told to commit before leaving.
  press(contentOf(dom), 'open-entity');
  contentOf(dom).querySelectorAll('[data-action="delete-entity"]')[0].click();
  press(lastModal(dom), 'confirm');
  assert.ok(T.forms.undo.depth() > 0, 'there is a deletion on the undo stack');

  const dialog = s.commit();
  const message = dialog.element.querySelectorAll('[data-action="commit-message"]')[0];
  message.value = 'Remove the threat';
  message.dispatch('input', { target: message });
  press(dialog.element, 'commit');

  assert.equal(T.forms.undo.depth(), 0, 'the commit emptied the undo stack');
  assert.equal(s.undo(), false, 'so the deletion is no longer undoable');
  assert.equal(M.get(s.state().model, 'threats', target.id), null, 'and the entity stays deleted');
  assert.equal(s.isDirty(), false);
});

specTest('edit.bulk-update', () => {
  // REQ-EDIT-008. Driven entirely through the table, because the whole feature is a wiring question:
  // `forms.bulkUpdate` was correct and complete while no list view offered a checkbox, which meant
  // the requirement was unmet and every unit test of the function still passed.
  //
  // The *components* list, not the flows one. Its entities all validate, so the success path can be
  // asserted on its own; `edit.bulk-partial-failure` below uses the flows list, where the seed
  // deliberately contains a broken one, and asserts the opposite outcome from the same code path.
  const shell = loadShell({});
  const { shell: s, TMV: T, dom } = shell;
  const M = T.model;

  s.go('architecture', 'components');
  const rows = contentOf(dom).querySelectorAll('[data-action="select-row"]');
  assert.ok(rows.length >= 2, 'an entity list offers a checkbox on every row');

  const selected = selectAllRows(dom);
  assert.equal(selected, M.collection(s.state().model, 'components').length, 'every row was selected');

  // The batch actions are what the selection is *for*, and they are not on screen before there is
  // one — a toolbar offering "Delete" with nothing selected is a button that can do nothing.
  assert.equal(contentOf(dom).querySelectorAll('[data-action="bulk-update"]').length, 1, 'a bulk update action appeared');
  assert.equal(contentOf(dom).querySelectorAll('[data-action="bulk-delete"]').length, 1, 'and a bulk delete');

  // The dialog offers the type's editable fields and nothing else.
  press(contentOf(dom), 'bulk-update');
  const modal = lastModal(dom);
  const picker = modal.querySelectorAll('[role="combobox"]')[0];
  assert.ok(picker, 'the dialog offers a field picker');
  assert.equal(picker.getAttribute('aria-expanded'), 'false', 'closed to begin with');

  // The menu is mounted beside its trigger when it opens, which is how Carbon positions a list box —
  // so it is not in the document until the picker is used, and a test that queried for it before
  // clicking would find nothing and conclude the widget was missing.
  function openPicker() {
    // Idempotent: the trigger toggles, so clicking an already-open picker would close it. Picking
    // an option closes it again, which is why this is asked each time rather than once.
    if (picker.getAttribute('aria-expanded') === 'false') picker.click();
    const listbox = modal.querySelectorAll('[role="listbox"]')[0];
    assert.ok(listbox, 'opening the picker mounts its listbox');
    assert.equal(picker.getAttribute('aria-expanded'), 'true', 'and says so');
    assert.equal(listbox.getAttribute('aria-label'), 'Field', 'as an accessible control rather than a bare list');
    return listbox;
  }

  /** Choose `value`, returning the label now shown on the trigger. */
  function pickField(value) {
    const listbox = openPicker();
    const option = listbox.querySelectorAll('[data-value]').filter((n) => n.getAttribute('data-value') === value)[0];
    assert.ok(option, 'the picker offers ' + value);
    option.click();
    return picker.querySelectorAll('.cds--list-box__label')[0].textContent;
  }

  const choices = openPicker()
    .querySelectorAll('[data-value]')
    .map((n) => n.getAttribute('data-value'));
  assert.ok(choices.length > 0, 'the dialog offers fields to set');
  assert.equal(choices[0], 'name', 'and the first one is what a reader would call the entity');
  assert.equal(
    choices.indexOf('id'),
    -1,
    'the identifier is not among them — a bulk rename of ids is not an edit anybody wants',
  );

  // Choosing a field rebuilds the value control, because the control a field needs depends on what
  // it holds: a list of tags and a single reference are not the same input.
  assert.equal(pickField('tags'), 'Tags', 'the picker says what is selected');
  assert.equal(pickField('name'), 'Name', 'and can be changed back');

  // Type a value into the field the dialog actually renders and apply it.
  const input = modal.querySelectorAll('input')[0];
  assert.equal(input.getAttribute('id'), 'tmv-bulk-name', 'the first editable field of a data flow is its name');
  input.value = 'Renamed';
  input.dispatch('input', { target: input });

  T.notify.reset();
  press(modal, 'apply');

  const comps = M.collection(s.state().model, 'components');
  assert.equal(comps.every((c) => c.name === 'Renamed'), true, 'every selected entity took the value');
  assert.equal(s.isDirty(), true, 'and the change is in the working copy, uncommitted');

  const outcome = T.notify.entries().filter((e) => e.ref === 'view.bulk.architecture.components');
  assert.equal(outcome.length, 1, 'the outcome was reported');
  assert.equal(outcome[0].level, 'success', 'as a success, because nothing was refused');
  assert.match(outcome[0].title, /Updated 2 entities/, 'and it says how many');

  // A field the type does not have is refused rather than applied to nothing. This is the failure
  // mode where every entity reports as updated and none of them changed.
  assert.throws(
    () => T.forms.bulkUpdate(s.state().model, 'dataFlow', M.collection(s.state().model, 'dataFlows').map((f) => f.id), { severity: 'high' }),
    /no editable field named severity/,
  );
  assert.throws(() => T.forms.bulkUpdate(s.state().model, 'notAType', [], {}), /Unknown entity type/);

  // Nothing was committed, so the entity ids and the head are untouched.
  assert.equal(comps.every((c) => c.id.startsWith('comp-')), true, 'the identifiers survived a bulk edit');
  assert.equal(T.vcs.isDirty(s.state().history, T.vcs.headModel(s.state().history)), false);
});

specTest('edit.bulk-partial-failure', () => {
  // REQ-EDIT-008 AC1: "Bulk update reports per-entity validation failures without aborting the whole
  // operation." Both halves are asserted separately, because each can hold while the other does not:
  // an implementation can abort on the first failure *and* report it, and one can carry on and then
  // report only a count — which leaves the user with nothing to act on.
  const shell = loadShell({});
  const { shell: s, TMV: T, dom } = shell;
  const M = T.model;

  s.go('flows');
  const all = M.collection(s.state().model, 'dataFlows');
  // `flow-bad` ends at a component that does not exist, so any candidate for it is invalid and every
  // candidate for the others is not. That is the shape a per-entity failure has to survive.
  assert.equal(all.filter((f) => f.id === 'flow-bad').length, 1, 'the fixture carries its deliberately broken flow');
  assert.equal(all.length, 3, 'and two flows that are fine');

  selectAllRows(dom);
  press(contentOf(dom), 'bulk-update');
  const modal = lastModal(dom);
  const input = modal.querySelectorAll('input')[0];
  input.value = 'Renamed';
  input.dispatch('input', { target: input });

  T.notify.reset();
  press(modal, 'apply');

  // The operation did not abort: the two that could take it did.
  const after = M.collection(s.state().model, 'dataFlows');
  assert.equal(after.filter((f) => f.name === 'Renamed').length, 2, 'the healthy entities were updated');
  const untouched = after.filter((f) => f.id === 'flow-bad')[0];
  assert.equal(untouched.name, 'Orphan', 'and the one that could not was left exactly as it was');

  // And it reported the failure with its reason, per entity.
  const outcomes = T.notify.entries().filter((e) => e.ref === 'view.bulk.flows.all');
  assert.equal(outcomes.length, 1, 'one outcome, not one per entity');
  const outcome = outcomes[0];
  assert.equal(outcome.level, 'warning', 'reported as a warning rather than a success');
  assert.match(outcome.title, /Updated 2 of 3/, `the count is both numbers, got ${JSON.stringify(outcome.title)}`);
  assert.match(outcome.detail, /Orphan/, 'the refused entity is named');
  assert.match(outcome.detail, /comp-missing/, 'with the reason, which is the reference that goes nowhere');
  assert.match(outcome.detail, /2 entities were changed/, 'and the applied count in the same breath');
  assert.doesNotMatch(outcome.detail, /The rest were applied/, 'the copy does not claim more than it did');

  // The same report is available from the function itself, which is where a caller without a DOM
  // gets it — the problems are per entity and carry the field they are about.
  const result = T.forms.bulkUpdate(s.state().model, 'dataFlow', all.map((f) => f.id), { name: 'Set' });
  assert.equal(result.applied.length, 2, 'the function reports the same split');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'flow-bad', 'keyed by the entity it refused');
  assert.equal(result.failed[0].problems[0].path, 'destinationId', 'with the field at fault');
  assert.match(result.failed[0].problems[0].message, /comp-missing/);
  assert.equal(result.failed[0].label, 'Orphan', 'and a label a person can find in the list');

  // An id that names nothing is a failure too, and is reported rather than thrown — a row can go out
  // from under a selection between the render and the click, and a batch that crashed on that would
  // lose the edits to everything else in it.
  const stale = T.forms.bulkUpdate(s.state().model, 'dataFlow', [all[0].id, 'flow-deleted-in-another-tab'], { name: 'Set' });
  assert.equal(stale.applied.length, 1, 'the entity that is still there was updated');
  assert.equal(stale.failed.length, 1);
  assert.match(stale.failed[0].problems[0].message, /not in this model/i);
});

specTest('edit.model-fields', () => {
  // REQ-EDIT-011. The model's own name and description are fields of the document rather than of any
  // entity, so until this requirement no form could reach them: the only routes to a rename were
  // hand-editing the embedded JSON or exporting, renaming and re-importing — which collides on
  // `modelId` and is therefore not a rename at all.
  //
  // Four things are asserted, and three of them are the ones a careless implementation gets wrong:
  // the change is an ordinary working-copy edit and reaches the head only through a commit; an empty
  // name is refused at the field with `M.validate`'s own message; the passthrough bags and the entity
  // arrays are the objects they already were, which is what keeps a rename away from an imported
  // file's uninterpreted data (ADR-0004); and a read-only model is refused before a dialog exists.
  const shell = loadShell({});
  const { shell: s, TMV: T, core } = shell;

  // The model-level passthrough bag (`03-data-model.md` §2), which is the data a rename must not be
  // able to reach — an `otm` attribute nothing in the canonical model represents, and a `tml`
  // extension keyed by a vendor's domain. Committed first, so the working copy starts clean and
  // "dirty" below means the rename and nothing else.
  const bag = {
    otm: { attributes: { cmdbId: '1234' }, tags: ['external'] },
    tml: { extensions: { 'example.com/custom': { keep: true } } },
  };
  s.state().model.x = bag;
  const metadata = s.state().model.metadata;
  s.state().prefs.identity = { name: 'Tester', email: 't@example.com' };
  const setup = s.commit();
  const setupMessage = setup.element.querySelectorAll('[data-action="commit-message"]')[0];
  setupMessage.value = 'Carry uninterpreted fields';
  setupMessage.dispatch('input', { target: setupMessage });
  press(setup.element, 'commit');
  assert.equal(s.isDirty(), false, 'the setup commit is the head');

  const threats = s.state().model.threat;
  const headBefore = s.state().history.head;

  // Opening the dialog changes nothing on its own.
  const dialog = s.editModelDetails();
  assert.ok(dialog, 'the shell opens the model-details dialog');
  const root = dialog.element;

  const name = root.querySelectorAll('[data-action="model-name"]')[0];
  const description = root.querySelectorAll('[data-action="model-description"]')[0];
  assert.ok(name, 'there is a name field');
  assert.ok(description, 'and a description field');
  assert.equal(name.value, 'Payments Platform', 'showing the working copy’s name');

  // Nothing has changed, so there is nothing to save — and the button says why rather than sitting
  // there dead with no explanation (the read-only case is the only one that may say nothing).
  const save = () => root.querySelectorAll('[data-action="save"]')[0];
  assert.equal(save().hasAttribute('disabled'), true, 'Save is unavailable with no change');
  assert.match(save().getAttribute('title'), /Nothing has changed/, 'and says so');

  // An empty name is refused at the field. The check is `M.validate`'s own `MODEL_NAME` problem read
  // back by its path, so the sentence the user sees is the one the exporter would have produced —
  // and the dialog stays open with the field marked, rather than closing over a model that cannot
  // be exported.
  name.value = '   ';
  name.dispatch('input', { target: name });
  assert.equal(save().hasAttribute('disabled'), false, 'a change makes Save available');
  press(root, 'save');
  assert.equal(name.getAttribute('aria-invalid'), 'true', 'a blank name marks the field invalid');
  assert.match(root.textContent, /The model has no name/, 'with the checker’s own message');
  assert.equal(s.state().model.name, 'Payments Platform', 'and nothing was applied');
  assert.equal(s.state().history.head, headBefore, 'nor was anything committed');

  // A real rename, plus a description, through the dialog's own button.
  name.value = 'Payments Platform Rebuilt';
  name.dispatch('input', { target: name });
  description.value = 'Cards, settlement, and the rebuilt ledger.';
  description.dispatch('input', { target: description });
  press(root, 'save');

  assert.equal(s.state().model.name, 'Payments Platform Rebuilt', 'the rename is in the working copy');
  assert.equal(s.state().model.description, 'Cards, settlement, and the rebuilt ledger.');
  assert.equal(s.isDirty(), true, 'and it is an uncommitted change, not a commit');
  assert.equal(s.state().history.head, headBefore, 'the head commit was not touched');
  assert.equal(
    T.vcs.headModel(s.state().history).name,
    'Payments Platform',
    'the committed model keeps the old name until a commit says otherwise',
  );

  // The passthrough data and the entity arrays are the objects they already were: a rename has no
  // path by which it could reach either.
  assert.equal(s.state().model.x, bag, 'the passthrough bag is the same object');
  assert.equal(s.state().model.metadata, metadata, 'and so is the metadata block');
  assert.equal(s.state().model.threat, threats, 'the threat array is the same object');

  // Committing is what puts the new name into the history, through the ordinary commit flow — and
  // the summary names the field, because `MODEL_FIELD_LABELS` describes model-level changes too.
  const commitDialog = s.commit();
  assert.ok(commitDialog, 'a renamed working copy offers a commit');
  assert.match(commitDialog.element.textContent, /Model name/, 'the commit summary names the field');
  const message = commitDialog.element.querySelectorAll('[data-action="commit-message"]')[0];
  message.value = 'Rename the model';
  message.dispatch('input', { target: message });
  press(commitDialog.element, 'commit');

  assert.equal(s.isDirty(), false, 'the working copy matches the new head');
  assert.equal(s.state().history.head !== headBefore, true, 'a commit was written');
  assert.equal(T.vcs.headModel(s.state().history).name, 'Payments Platform Rebuilt', 'carrying the new name');
  assert.equal(
    T.vcs.headModel(s.state().history).x.otm.attributes.cmdbId,
    '1234',
    'and the passthrough bag travels with it',
  );
  assert.equal(
    T.vcs.headModel(s.state().history).x.tml.extensions['example.com/custom'].keep,
    true,
    'both halves of it, keyed by source format',
  );

  // A read-only model is refused before any dialog exists, which is where `07-ui.md` §9 puts the
  // decision: the affordances are absent, and the API behind them refuses as well rather than relying
  // on nothing having called it.
  const readOnly = loadShell({ editable: false });
  assert.equal(readOnly.shell.editModelDetails(), null, 'a read-only model opens no dialog');
  const complained = readOnly.TMV.notify.entries().filter((e) => e.ref === 'shell.edit-model.read-only');
  assert.equal(complained.length, 1, 'and says why, once');
  assert.match(complained[0].detail, /without a writable history/, 'with the shell’s own reason');
  assert.equal(core.isObject(readOnly.shell.state().model), true, 'leaving the model where it was');
});
