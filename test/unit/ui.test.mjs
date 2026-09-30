/*
 * ui.test.mjs — the shell, its navigation, and the notifications.
 *
 * Every requirement in `07-ui.md` is a claim about *wiring*, because Carbon ships no JavaScript: the
 * classes on the shell, the ARIA on the tabs, the contents of the side nav and the behaviour of the
 * disclosure controls are all hand-written, and a hand-written control is exactly where a wrong
 * attribute or a stale class survives review. So these tests drive the DOM the way a user would —
 * clicking triggers, dispatching keydown — and read back what the shell built, rather than calling
 * the shell's internals and asserting on their return values.
 *
 * Two harness facts shape the file and are worth stating once:
 *
 *   - The stub's hosts are bare `<div id="...">` elements, not the authored frame in
 *     `src/index.html`. The static frame classes (`cds--header`, `cds--content`, `cds--side-nav`) are
 *     therefore not reachable from a unit test — `e2e.ui.shell` (REQ-UI-001's other cited test) runs
 *     against the real page — so what is asserted here is the Carbon class vocabulary the shell
 *     *builds*: the tab list and its tabs, the side-nav list and its rows, the header actions. That
 *     is the half of REQ-UI-001 that can regress when a module changes.
 *
 *   - `persistPrefs` writes through the adapter `loadShell` injects, and `mount` reads its
 *     preferences from the caller. So "survives a reload" is asserted as the two real halves:
 *     the choice reaches storage, and mounting again with what storage returned restores it. That is
 *     what boot does, and it is the only way to observe persistence in a context that survives for
 *     the length of one test.
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadShell } from '../lib/app.mjs';
import { same } from '../lib/compare.mjs';

/** The nine tabs in the order `07-ui.md` §2 fixes, and the four themes of §4. */
const TAB_LABELS = ['Overview', 'Architecture', 'Data', 'Flows', 'Threats', 'Controls', 'Risk', 'History', 'Settings'];
const ALL_THEMES = ['cds--white', 'cds--g10', 'cds--g90', 'cds--g100'];

/** The theme classes actually on the root, which is where every `cds--*` rule is scoped. */
function themesOn(dom) {
  return ALL_THEMES.filter((value) => dom.body.classList.contains(value));
}

/** The side nav renders its list into the nav; the harness's `#tmv-side-nav-items` host is a stand-in. */
function navList(dom) {
  return dom.body.querySelector('#tmv-side-nav .cds--side-nav__items');
}

function navRows(dom) {
  return dom.body.querySelectorAll('#tmv-side-nav .cds--side-nav__item');
}

function navLabels(dom) {
  return navRows(dom).map((row) => row.querySelector('.cds--side-nav__link-text').textContent);
}

/** Open a header menu the way a click does, and hand back the (now visible) menu element. */
function openMenu(dom, triggerId, menuId) {
  dom.body.querySelector(triggerId).click();
  return dom.body.querySelector(menuId);
}

/**
 * Mount the shell again against the same document and adapter.
 *
 * This is the reload `mount` models: the caller supplies the preferences, and passing what
 * `readPrefs` returned is what a second page load does. `prefs` is omitted only for the first-run
 * test, where mount's own default is the thing under test.
 */
function remount(shellState, prefs) {
  const { shell, adapter, model, history } = shellState;
  shell.unmount();
  shell.mount({
    adapter,
    container: { model, history },
    embedded: { model, history },
    model,
    history,
    editable: true,
    prefs,
  });
}

// -----------------------------------------------------------------------------------------------

specTest('ui.shell-structure', () => {
  // REQ-UI-001 AC: header, tabs, side nav and content use Carbon's documented class structure. The
  // assertion is on the runtime-built regions, which is what a module change can break; the static
  // frame is the e2e test's (see the file comment).
  const { dom } = loadShell({});

  const tablist = dom.body.querySelector('#tmv-tabs [role="tablist"]');
  assert.ok(tablist, 'the tab strip is a tablist');
  assert.ok(tablist.classList.contains('cds--tab--list'), 'built from Carbon’s tab list class');
  const tabs = tablist.querySelectorAll('[role="tab"]');
  assert.equal(tabs.length, 9);
  for (const tab of tabs) {
    assert.ok(tab.classList.contains('cds--tabs__nav-item'), 'each tab is a Carbon nav item');
    assert.ok(tab.classList.contains('cds--tabs__nav-link'), 'and a Carbon nav link');
  }

  const list = navList(dom);
  assert.ok(list, 'the side nav has an items list');
  assert.equal(list.tagName.toLowerCase(), 'ul', 'Carbon’s side nav is a list');
  assert.ok(list.classList.contains('cds--side-nav__items'));
  const rows = navRows(dom);
  assert.ok(rows.length > 0, 'and it is populated for the active tab');
  for (const row of rows) {
    assert.equal(row.tagName.toLowerCase(), 'li');
    assert.ok(row.classList.contains('cds--side-nav__item'));
    assert.ok(row.querySelector('.cds--side-nav__link'), 'each row is a link');
  }

  assert.ok(
    dom.body.querySelector('#tmv-model-switcher .cds--header__action'),
    'the model switcher is an element of the Carbon header',
  );
  const headerActions = dom.body.querySelectorAll('#tmv-header-actions .cds--header__action');
  assert.ok(headerActions.length >= 2, 'and so are the overflow menus beside it');

  // The content region is not one Carbon panel per tab (§1’s deliberate deviation), so the half of
  // REQ-UI-001 that matters for it is its role and that it is tied to the active tab.
  const content = dom.body.querySelector('#tmv-content');
  assert.equal(content.getAttribute('role'), 'tabpanel');
  assert.equal(content.getAttribute('aria-labelledby'), 'tmv-tab-overview');
});

specTest('ui.tabs', () => {
  // REQ-UI-002: nine tabs, correctly labelled and wired, and the selection survives a reload.
  const state = loadShell({});
  const { dom, shell, TMV, adapter, model, history } = state;
  const tabs = dom.body.querySelectorAll('#tmv-tabs [role="tab"]');

  assert.equal(tabs.length, 9, 'nine top-level tabs');
  same(
    tabs.map((tab) => tab.textContent),
    TAB_LABELS,
    'named and ordered as 07-ui.md §2 fixes them',
  );
  same(shell.TAB_IDS, tabs.map((tab) => tab.getAttribute('data-value')), 'and the shell names the same nine');

  // §1: the strip is a selector for one panel, so every tab controls it and only the active tab is
  // in the tab order.
  for (const tab of tabs) assert.equal(tab.getAttribute('aria-controls'), 'tmv-content');
  const roving = tabs.filter((tab) => tab.getAttribute('tabindex') === '0');
  assert.equal(roving.length, 1, 'exactly one tab is in the tab order');
  assert.equal(roving[0].getAttribute('aria-selected'), 'true', 'and it is the selected one');

  // Clicking moves the selection and re-points the panel's accessible name at the new tab (§1).
  tabs[7].click();
  assert.equal(shell.activeTab(), 'history');
  assert.equal(dom.body.querySelector('#tmv-content').getAttribute('aria-labelledby'), 'tmv-tab-history');
  const active = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('data-value'), 'history');

  // AC2: the tab is written to preferences, and mounting with them again is the reload.
  assert.equal(TMV.storage.readPrefs(adapter).activeTab, 'history', 'the active tab reaches preferences');
  remount(state, TMV.storage.readPrefs(adapter));
  assert.equal(shell.activeTab(), 'history', 'and the reload returns to it');
  assert.equal(
    dom.body.querySelector('#tmv-tabs [aria-selected="true"]').getAttribute('data-value'),
    'history',
    'with the right tab drawn as selected',
  );
  assert.equal(dom.body.querySelector('#tmv-content').getAttribute('aria-labelledby'), 'tmv-tab-history');
  assert.ok(model && history, 'the fixture is untouched');
});

specTest('ui.tabs-keyboard', () => {
  // REQ-UI-002 AC: the tabs are keyboard-navigable with roving tabindex. The events are dispatched on
  // the active tab and bubble to the shell's delegated listener, which is the wiring a browser uses.
  const { dom, shell } = loadShell({});
  const tab = (id) => dom.body.querySelector('#tmv-tab-' + id);
  const selected = () => dom.body.querySelector('#tmv-tabs [aria-selected="true"]');
  const tabindexes = () =>
    dom.body
      .querySelectorAll('#tmv-tabs [role="tab"]')
      .map((t) => t.getAttribute('tabindex'))
      .join(',');

  assert.equal(selected().getAttribute('data-value'), 'overview', 'the strip opens on the first tab');

  const right = tab('overview').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(shell.activeTab(), 'architecture', 'ArrowRight moves to the next tab');
  assert.equal(right.defaultPrevented, true, 'and the key is consumed rather than left to scroll the page');
  assert.equal(selected().getAttribute('data-value'), 'architecture');
  assert.equal(tab('architecture').getAttribute('tabindex'), '0', 'the moved-to tab is in the tab order');
  assert.equal(dom.activeElement, tab('architecture'), 'and it has focus, so the caret follows the selection');
  assert.equal(
    tabindexes(),
    '-1,0,-1,-1,-1,-1,-1,-1,-1',
    'roving tabindex leaves exactly one tab reachable by Tab',
  );

  tab('architecture').dispatch('keydown', { key: 'Home' });
  assert.equal(shell.activeTab(), 'overview', 'Home jumps to the first tab');
  tab('overview').dispatch('keydown', { key: 'End' });
  assert.equal(shell.activeTab(), 'settings', 'End jumps to the last');

  // Carbon wraps, and the strip is one control, so neither end dead-ends.
  tab('settings').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(shell.activeTab(), 'overview', 'ArrowRight from the last wraps to the first');
  tab('overview').dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(shell.activeTab(), 'settings', 'and ArrowLeft from the first wraps to the last');

  // A key the strip has no opinion about is not swallowed: it must reach whatever else wants it.
  const before = shell.activeTab();
  const letter = tab('settings').dispatch('keydown', { key: 'a' });
  assert.equal(shell.activeTab(), before, 'a letter key does not move the selection');
  assert.equal(letter.defaultPrevented, false, 'and is not prevented');
});

specTest('ui.sidenav-per-tab', () => {
  // REQ-UI-003 AC1 and AC2: the nav is the active tab’s sub-sections, one level deep.
  const { dom, shell } = loadShell({});
  same(navLabels(dom), ['Summary', 'Scope', 'Contributors', 'Export Readiness', 'Provenance'], 'Overview’s sections');

  shell.go('architecture');
  same(
    navLabels(dom),
    ['Trust Zones', 'Trust Boundaries', 'Components', 'Actors', 'Data Stores', 'Diagram'],
    'the nav is regenerated for the new tab',
  );
  assert.equal(dom.body.querySelector('#tmv-side-nav').getAttribute('aria-label'), 'Sections of the Architecture tab');

  // One level: a row is a link, and Carbon’s side nav has no third tier to nest into.
  for (const row of navRows(dom)) {
    assert.equal(row.querySelectorAll('.cds--side-nav__link').length, 1, 'a row is one link');
    assert.equal(row.querySelectorAll('ul').length, 0, 'and carries no nested list');
  }

  // Selecting a sub-section marks it, and only it, as current.
  const actors = navRows(dom).find((row) => row.querySelector('.cds--side-nav__link-text').textContent === 'Actors');
  actors.querySelector('.cds--side-nav__link').click();
  assert.equal(shell.activeSection(), 'actors', 'clicking a row moves to that section');
  const current = dom.body.querySelectorAll('#tmv-side-nav [aria-current="true"]');
  assert.equal(current.length, 1, 'exactly one row is current');
  assert.equal(current[0].querySelector('.cds--side-nav__link-text').textContent, 'Actors');
});

specTest('ui.sidenav-collapse-persist', () => {
  // REQ-UI-003 AC3: the collapsed state persists across tabs and across reloads.
  const state = loadShell({});
  const { dom, shell, TMV, adapter } = state;
  const nav = () => dom.body.querySelector('#tmv-side-nav');
  const trigger = () => dom.body.querySelector('#tmv-sidenav-trigger');

  assert.ok(nav().classList.contains('cds--side-nav--expanded'), 'the rail starts expanded');
  assert.equal(trigger().getAttribute('aria-expanded'), 'true', 'and the trigger says so');

  trigger().click();
  assert.ok(nav().classList.contains('cds--side-nav--collapsed'), 'the trigger collapses it');
  assert.equal(nav().classList.contains('cds--side-nav--expanded'), false, 'the two states are exclusive');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(TMV.storage.readPrefs(adapter).sideNavCollapsed, true, 'the choice reaches preferences');

  shell.go('threats');
  assert.ok(nav().classList.contains('cds--side-nav--collapsed'), 'switching tabs does not re-expand the rail');

  remount(state, TMV.storage.readPrefs(adapter));
  assert.ok(nav().classList.contains('cds--side-nav--collapsed'), 'and the reload keeps it collapsed');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');

  // Expanding again is a preference too, so the next reload is expanded rather than stuck collapsed.
  trigger().click();
  assert.equal(TMV.storage.readPrefs(adapter).sideNavCollapsed, false);
  assert.ok(nav().classList.contains('cds--side-nav--expanded'));
});

specTest('ui.model-switcher', () => {
  // REQ-UI-004 AC1: the header hosts a switcher over the registry plus the embedded model, and it
  // shows which entry comes from the file.
  const { dom, shell } = loadShell({ stored: true });

  const trigger = dom.body.querySelector('#tmv-model-trigger');
  assert.ok(trigger, 'the switcher is built into the header');
  assert.equal(trigger.getAttribute('role'), 'combobox', 'it is a listbox dropdown, not a menu');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'closed to begin with');

  const list = dom.body.querySelector('#tmv-model-list');
  assert.equal(list.getAttribute('role'), 'listbox');
  const options = list.querySelectorAll('[role="option"]');
  assert.equal(options.length, 2, 'the embedded model and the stored copy are two entries, not one');

  const fileOption = options.find((option) => option.getAttribute('data-value') === shell.FILE_VALUE);
  assert.ok(fileOption, 'the embedded model has its own entry');
  assert.match(fileOption.getAttribute('aria-label'), /from the file/, 'and is marked as coming from the file');
  const storedOption = options.find((option) => option.getAttribute('data-value') === shell.currentModelId());
  assert.ok(storedOption, 'the stored copy is listed by its model id');
  assert.ok(
    storedOption.classList.contains('cds--list-box__menu-item--selected'),
    'and is the entry marked current, because it is what is open',
  );

  // The disclosure is wired: opening it says so and shows the list.
  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(list.hasAttribute('hidden'), false, 'and the list is no longer hidden');

  // Choosing the file entry opens the embedded history rather than the stored copy.
  fileOption.click();
  assert.equal(shell.state().source, 'file', 'selecting the file entry opens what the file carries');
});

specTest('ui.delete-affordance', () => {
  // REQ-UI-004 AC2: delete lives in the header, is offered for stored models, and — for the embedded
  // entry — is *absent* with a reason, not present and disabled.
  const fileOnly = loadShell({});
  const fileMenu = openMenu(fileOnly.dom, '#tmv-menu-file-trigger', '#tmv-menu-file');
  assert.equal(
    fileMenu.querySelectorAll('[data-action="delete-stored"]').length,
    0,
    'a model that is only in the file has nothing stored to delete',
  );
  const heading = fileMenu.querySelector('.tmv-menu__heading');
  assert.ok(heading, 'and the menu explains the absence rather than leaving a gap');
  assert.match(heading.textContent, /came from the file/);
  assert.match(heading.textContent, /nothing here to delete/i);

  const stored = loadShell({ stored: true });
  const storedMenu = openMenu(stored.dom, '#tmv-menu-file-trigger', '#tmv-menu-file');
  assert.equal(
    storedMenu.querySelectorAll('[data-action="delete-stored"]').length,
    1,
    'a model with a stored copy can be deleted from the browser',
  );
  assert.equal(storedMenu.querySelector('.tmv-menu__heading'), null, 'and no explanation is needed');

  // The affordance follows the entry that is open, so switching to the file entry removes it in the
  // same session — it is not "is anything stored anywhere" but "is *this* model stored".
  stored.shell.switchModel(stored.shell.FILE_VALUE);
  const switched = openMenu(stored.dom, '#tmv-menu-file-trigger', '#tmv-menu-file');
  assert.equal(switched.querySelectorAll('[data-action="delete-stored"]').length, 0);
  assert.ok(switched.querySelector('.tmv-menu__heading'));
});

specTest('ui.theme-switch', () => {
  // REQ-UI-005 AC1: all four prebuilt themes apply, and only through the compiled `cds--*` classes.
  const { dom, shell } = loadShell({});
  same(shell.THEMES.map((theme) => theme.value), ALL_THEMES, 'the four Carbon themes are offered');
  assert.equal(themesOn(dom).length, 1, 'exactly one theme is applied to begin with');

  for (const value of ALL_THEMES) {
    const menu = openMenu(dom, '#tmv-menu-theme-trigger', '#tmv-menu-theme');
    const option = menu.querySelector(`[data-action="theme"][data-value="${value}"]`);
    assert.ok(option, `${value} is listed`);
    option.click();
    assert.deepEqual(themesOn(dom), [value], `${value} alone is applied to the root`);
  }

  // The trigger names the current theme, which is how the choice is readable while the menu is shut.
  assert.match(dom.body.querySelector('#tmv-menu-theme-trigger').getAttribute('aria-label'), /Gray 100/);

  // --- the header's light/dark switch (`07-ui.md` §4) --------------------------------------------
  // It is a two-state control, not a fifth theme: `role="switch"` with `aria-checked` is what tells a
  // screen reader there are two states and which one is current, and a switch that reported its state
  // only through an icon would be a picture the reader has to guess at.
  const toggle = () => dom.body.querySelector('#tmv-theme-toggle');
  assert.ok(toggle(), 'the header carries the switch');
  assert.equal(toggle().getAttribute('role'), 'switch');
  assert.equal(toggle().getAttribute('aria-checked'), 'true', 'Gray 100 is a dark theme, so it reads as checked');
  assert.ok(toggle().querySelector('[aria-hidden="true"]'), 'both glyphs are decoration, not the state');

  // It moves across the *family*, and the variant it lands on is the last one used in that family —
  // so the switch and the four-entry menu can never describe different themes.
  toggle().click();
  assert.deepEqual(themesOn(dom), ['cds--g10'], 'pressing it from Gray 100 lands on the default light theme');
  assert.equal(toggle().getAttribute('aria-checked'), 'false', 'and the switch reports the new state');

  // A variant chosen from the menu is remembered as that family's, so the round trip returns there
  // rather than to the default. This is session memory, deliberately not persisted: it is not a
  // preference the user stated, and the stored key holds the theme actually in use.
  openMenu(dom, '#tmv-menu-theme-trigger', '#tmv-menu-theme')
    .querySelector('[data-action="theme"][data-value="cds--g90"]').click();
  toggle().click();
  assert.deepEqual(themesOn(dom), ['cds--g10'], 'dark → light still returns to the light variant in use');
  toggle().click();
  assert.deepEqual(themesOn(dom), ['cds--g90'], 'and light → dark returns to Gray 90, the dark variant last used');
});

specTest('ui.theme-persist', () => {
  // REQ-UI-005 AC2: the choice is remembered, and first run follows the OS preference.
  const state = loadShell({});
  const { dom, shell, TMV, adapter, model, history, ctx } = state;

  const menu = openMenu(dom, '#tmv-menu-theme-trigger', '#tmv-menu-theme');
  menu.querySelector('[data-action="theme"][data-value="cds--g100"]').click();
  assert.equal(TMV.storage.readPrefs(adapter).theme, 'cds--g100', 'the choice is written to preferences');

  remount(state, TMV.storage.readPrefs(adapter));
  assert.deepEqual(themesOn(dom), ['cds--g100'], 'and the reload applies it');

  // The header switch is a theme choice like any other, and reaches the same stored key — there is
  // one theme in this application, not a switch state beside it that the four-way menu would disagree
  // with on the next load.
  dom.body.querySelector('#tmv-theme-toggle').click();
  assert.equal(TMV.storage.readPrefs(adapter).theme, 'cds--g10', 'the switch writes the same preference');
  remount(state, TMV.storage.readPrefs(adapter));
  assert.deepEqual(themesOn(dom), ['cds--g10'], 'and a reload opens in what the switch chose');

  // `osPreferredTheme` reads `matchMedia` off the app’s own global, which the unit realm does not
  // have. Supplying it before the mount is the first run on a machine with a stated preference.
  const mountDefault = () => {
    shell.unmount();
    shell.mount({ adapter, container: { model, history }, embedded: { model, history }, model, history, editable: true });
  };
  ctx.matchMedia = (query) => ({ matches: query.indexOf('prefers-color-scheme: dark') !== -1 });
  mountDefault();
  assert.deepEqual(themesOn(dom), ['cds--g100'], 'first run on a dark OS preference picks the dark theme');

  ctx.matchMedia = () => ({ matches: false });
  mountDefault();
  assert.deepEqual(themesOn(dom), ['cds--g10'], 'and on a light one, Gray 10');
});

specTest('ui.notifications', () => {
  // REQ-UI-009. Its AC is the one that has consequences: an error is not dismissible into oblivion,
  // so dismissing the message must leave the record. The other half of the requirement — that every
  // outcome arrives as a Carbon notification, with the right live-region role — is asserted alongside
  // it, because a message that renders as an unstyled div is a message the user never sees.
  const { dom, shell, TMV } = loadShell({ editable: false });
  const live = dom.body.querySelector('#tmv-live');
  TMV.notify.reset();

  // A real error path, not a synthetic call: editing a read-only model.
  shell.edit(shell.state().model);
  const toast = dom.body.querySelector('#tmv-notifications .tmv-toast');
  assert.ok(toast, 'the outcome is rendered as a notification');
  assert.ok(toast.classList.contains('cds--toast-notification'), 'with Carbon’s base toast class');
  assert.ok(toast.classList.contains('cds--toast-notification--error'), 'and the level modifier');
  assert.equal(toast.getAttribute('role'), 'alert', 'an error is announced assertively');
  assert.equal(live.getAttribute('aria-live'), 'assertive', 'through the live region set to match');
  assert.match(live.textContent, /cannot be edited/, 'and the live region carries the message');

  // AC: dismiss the notification, and the error is still retrievable.
  toast.querySelector('[data-action="dismiss-notification"]').click();
  assert.equal(dom.body.querySelectorAll('#tmv-notifications .tmv-toast').length, 0, 'the message is gone');
  const lastError = TMV.notify.latestError();
  assert.ok(lastError, 'but the last error is not');
  assert.match(lastError.title, /cannot be edited/);
  assert.match(
    TMV.notify.retainedPanel().textContent,
    /cannot be edited/,
    'and it is rendered from the retained log, which is where a user finds it again',
  );

  // A reconcile outcome is a toast; a condition that is still true is an inline banner, and both are
  // Carbon notifications with the role their level deserves.
  const second = loadShell({});
  second.TMV.notify.reset();
  second.shell.reportReconcile({ verdict: second.TMV.storage.NO_LOCAL });
  const info = second.dom.body.querySelector('#tmv-notifications .tmv-toast');
  assert.ok(info.classList.contains('cds--toast-notification'), 'an outcome is a toast');
  assert.ok(info.classList.contains('cds--toast-notification--info'));
  assert.equal(info.getAttribute('role'), 'status', 'and a non-error is announced politely');

  second.shell.reportStorage(second.TMV.storage.detectStorageContext({ available: false }));
  const banner = second.dom.body.querySelector('#tmv-banners .tmv-banner');
  assert.ok(banner.classList.contains('cds--inline-notification'), 'a live condition is an inline notification');
  assert.ok(banner.classList.contains('cds--inline-notification--warning'));
});

specTest('ui.model-details-affordance', () => {
  // REQ-EDIT-011 AC4: the model's own fields are reachable from where the user already is, and every
  // affordance is *absent* rather than disabled when the model is read-only (REQ-VIEW-008, `07-ui.md`
  // §9). Four places are named, and they are four separate wirings — a test that checked one would
  // pass while a user standing in Settings had no way to rename anything.
  const state = loadShell({ stored: true });
  const { dom, shell, model } = state;

  const content = () => dom.body.querySelector('#tmv-content');
  /** The innermost modal is the newest one; the stub keeps closed ones attached. */
  const lastModal = () => {
    const modals = dom.body.querySelectorAll('.cds--modal');
    return modals[modals.length - 1] || null;
  };
  /** Open the model-details dialog the way a click does, and hand back the dialog's node. */
  function clickAndReadDialog(node) {
    node.click();
    const modal = lastModal();
    assert.ok(modal, 'a dialog opened');
    assert.ok(modal.querySelectorAll('[data-action="model-name"]')[0], 'it is the model-details dialog');
    return modal;
  }

  // 1. The Overview heading, which is the first place someone looks for the model's name.
  shell.go('overview');
  const overviewButtons = content().querySelectorAll('[data-action="edit-model"]');
  assert.equal(overviewButtons.length, 1, 'the Overview heading offers model details');
  clickAndReadDialog(overviewButtons[0]);
  assert.equal(
    lastModal().querySelectorAll('[data-action="model-name"]')[0].value,
    'Payments Platform',
    'showing the model that is open',
  );

  // 2. The header's "Model and file actions" menu, which is where the file-level operations live —
  //    a per-entry control inside the switcher is not valid ARIA, which is why Delete is here too.
  const fileMenu = openMenu(dom, '#tmv-menu-file-trigger', '#tmv-menu-file');
  const headerItem = fileMenu.querySelectorAll('[data-action="edit-model"]');
  assert.equal(headerItem.length, 1, 'the header menu offers it');
  assert.match(headerItem[0].textContent, /Edit model details/, 'under its own name');
  clickAndReadDialog(headerItem[0]);

  // 3. Settings → Model, both the section itself and the row in the side nav.
  shell.go('settings', 'model');
  same(
    navLabels(dom).slice(0, 3),
    ['Model', 'Identity', 'Storage'],
    'the Settings nav opens with the model, because §3 does',
  );
  const settingsButtons = content().querySelectorAll('[data-action="edit-model"]');
  assert.equal(settingsButtons.length, 1, 'the Model section offers it');
  assert.match(content().textContent, /Payments Platform/, 'and shows the model’s name');
  assert.match(content().textContent, /Card payments and settlement/, 'and its description');
  clickAndReadDialog(settingsButtons[0]);

  // 4. The Storage table, one row per stored model, named by `data-value` so the click lands on the
  //    model the row is about rather than whichever one happens to be open.
  shell.go('settings', 'storage');
  const rowButtons = content().querySelectorAll('[data-action="edit-model"]');
  assert.equal(rowButtons.length, 1, 'the stored model’s row offers it');
  assert.equal(rowButtons[0].getAttribute('data-value'), model.modelId, 'carrying the row’s model id');
  assert.match(rowButtons[0].getAttribute('aria-label'), /Edit the details of/, 'and an accessible name that says which');
  clickAndReadDialog(rowButtons[0]);

  // The header follows the working copy before the commit, so a rename is visible where the user
  // already is rather than only after it is committed — but only for the current *registry* entry.
  const triggerName = (state) =>
    state.dom.body.querySelector('#tmv-model-trigger .tmv-switcher__name').textContent;
  const optionName = (state, value) => {
    const option = state.dom.body
      .querySelectorAll('#tmv-model-list [role="option"]')
      .find((o) => o.getAttribute('data-value') === value);
    return option.querySelector('.tmv-switcher__entry-name').textContent;
  };
  const embeddedBefore = optionName(state, shell.FILE_VALUE);
  shell.go('settings', 'model');
  content().querySelectorAll('[data-action="edit-model"]')[0].click();
  const nameField = lastModal().querySelectorAll('[data-action="model-name"]')[0];
  nameField.value = 'Renamed in the working copy';
  nameField.dispatch('input', { target: nameField });
  lastModal().querySelectorAll('[data-action="save"]')[0].click();
  assert.equal(triggerName(state), 'Renamed in the working copy', 'the header shows the uncommitted name');
  assert.equal(
    optionName(state, shell.FILE_VALUE),
    embeddedBefore,
    'while the embedded entry keeps the file’s name, which a rename never rewrites',
  );
  assert.equal(shell.isDirty(), true, 'and nothing has been committed');

  // With the file's own model open, the header keeps the file's name for that same reason: the entry
  // names the file, not the history a rename would be committed into.
  const fromFile = loadShell({});
  const fileTriggerBefore = triggerName(fromFile);
  openMenu(fromFile.dom, '#tmv-menu-file-trigger', '#tmv-menu-file')
    .querySelectorAll('[data-action="edit-model"]')[0]
    .click();
  const modals = fromFile.dom.body.querySelectorAll('.cds--modal');
  const fileModal = modals[modals.length - 1];
  const fileField = fileModal.querySelectorAll('[data-action="model-name"]')[0];
  fileField.value = 'Renamed while the file is open';
  fileField.dispatch('input', { target: fileField });
  fileModal.querySelectorAll('[data-action="save"]')[0].click();
  assert.equal(triggerName(fromFile), fileTriggerBefore, 'the file entry still names the file');
  assert.equal(
    fromFile.shell.state().model.name,
    'Renamed while the file is open',
    'though the working copy is renamed, so the difference is the point rather than a lag',
  );

  // A read-only model offers none of the four. Absent, not disabled: a dead control in a menu or a
  // table row invites the user to work out what would make it live, and the header banner has
  // already said what.
  const readOnly = loadShell({ editable: false, stored: true });
  const roContent = () => readOnly.dom.body.querySelector('#tmv-content');
  readOnly.shell.go('overview');
  assert.equal(roContent().querySelectorAll('[data-action="edit-model"]').length, 0, 'not on Overview');
  const roMenu = openMenu(readOnly.dom, '#tmv-menu-file-trigger', '#tmv-menu-file');
  assert.equal(roMenu.querySelectorAll('[data-action="edit-model"]').length, 0, 'not in the header menu');
  readOnly.shell.go('settings', 'model');
  assert.equal(roContent().querySelectorAll('[data-action="edit-model"]').length, 0, 'not in Settings → Model');
  assert.match(roContent().textContent, /read-only/, 'and the section says why instead of offering a dead button');
  readOnly.shell.go('settings', 'storage');
  assert.equal(
    roContent().querySelectorAll('[data-action="edit-model"]').length,
    0,
    'not in a Storage row either',
  );
});
