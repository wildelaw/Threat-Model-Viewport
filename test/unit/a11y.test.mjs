/*
 * a11y.test.mjs — REQ-UI-007, in its three testable halves.
 *
 * The requirement targets WCAG 2.1 AA and names three tests. They are deliberately different kinds of
 * check, because "accessible" is not one property:
 *
 *   `a11y.axe-core`        the automated pass, run over the built artifact. It catches the class of
 *                          defect a rule can decide — a control with no name, an invalid ARIA
 *                          relationship, contrast — across every element the artifact renders.
 *   `a11y.focus-management` the behaviour axe cannot see: a modal that traps focus and gives it back,
 *                          a menu that closes on Escape and returns focus to its trigger. These are
 *                          the hand-written obligations `07-ui.md` §8 lists, and the stub DOM can
 *                          drive them because they are attribute and focus movements, not layout.
 *   `a11y.keyboard-only`   the tab strip and the side nav operated by keyboard alone, including the
 *                          roving tabindex and the `aria-*` state that moves with it.
 *
 * **Why axe runs in a browser here.** `09-testing.md` puts the axe pass against *the built artifact*
 * (`§4`, and the tooling table in `§2`), and axe is a browser library: it needs `getComputedStyle`,
 * layout for the contrast rules, and a real event model. The unit harness's DOM (`lib/dom.mjs`) is a
 * deliberately small stub that has none of those, so running axe against it would produce a report
 * about the stub rather than about the application — the one outcome worse than no test. Chromium
 * through Playwright is already a dev dependency, so the artifact is opened as a browser opens it, on
 * `file://`, which is how it ships.
 *
 * **The artifact is injected, not added as a script tag.** The file's CSP is `script-src` with a
 * single hash (`REQ-SEC-001`), so `page.addScriptTag` is refused by the very policy the app relies
 * on. Axe is evaluated through the debugger protocol instead, which the policy does not govern —
 * this is a harness detail, not a hole in the app: the app's own scripts are still hash-checked.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

import { specTest } from '../lib/check.mjs';
import { loadShell, ROOT } from '../lib/app.mjs';

const require = createRequire(import.meta.url);

/** The artifact that ships. A stale or missing build must fail loudly, not skip. */
const DIST = join(ROOT, 'dist', 'threat-model-viewport.html');
if (!fs.existsSync(DIST)) {
  throw new Error(`the accessibility tests read the built artifact and ${DIST} does not exist — run \`node build.mjs\` first`);
}

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** WCAG 2.1 A and AA — the level REQ-UI-007 targets. axe's `best-practice` rules are not failures. */
const WCAG_AA = /^wcag2(?:1)?(?:a|aa)$/;

/**
 * Run axe over the artifact as a browser sees it, and hand back the raw report.
 *
 * Exported as a helper rather than inlined so the run can also be driven from a scratch script while
 * the assertions below are being written — the numbers a test asserts on should be readable before
 * they are asserted.
 */
export async function runAxe() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(DIST).href, { waitUntil: 'load' });
    // Wait for the shell to have rendered something, so axe is not run against an empty `<main>`.
    await page.waitForSelector('#tmv-content .tmv-view__title', { timeout: 15000 });
    await page.evaluate(AXE_SOURCE);
    return await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations', 'passes'] });
      return {
        axe: window.axe.version,
        elements: document.querySelectorAll('*').length,
        content: document.getElementById('tmv-content').querySelectorAll('*').length,
        title: (document.querySelector('#tmv-content .tmv-view__title') || {}).textContent || '',
        violations: r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          tags: v.tags,
          help: v.help,
          nodes: v.nodes.map((n) => ({ target: n.target, html: n.html, failure: n.failureSummary })),
        })),
        passes: r.passes.map((p) => ({ id: p.id, nodes: p.nodes.length })),
      };
    });
  } finally {
    await browser.close();
  }
}

specTest('a11y.axe-core', async () => {
  const report = await runAxe();

  // A report that analysed almost nothing is not a pass. If the artifact fails to boot — the script is
  // refused, the data block is unreadable — axe reports zero violations, and a test that accepted that
  // would turn every future boot failure into a green accessibility run. So assert the run saw a
  // rendered application first.
  //
  // The thresholds are measured, not chosen: with JavaScript disabled the artifact is 50 elements with
  // an empty `#tmv-content` (its static "JavaScript is required" notice); booted it is 160 elements
  // with 44 in the content region. The bars sit between those two, wide enough that ordinary growth
  // does not trip them and narrow enough that a dead page cannot clear them.
  assert.ok(
    report.elements > 100,
    `axe analysed only ${report.elements} elements — the unbooted artifact has 50, so this is not a rendered page`,
  );
  assert.ok(
    report.content > 20,
    `the content region holds only ${report.content} elements (an unbooted artifact holds 0), so axe ` +
      'analysed the shell without the view that state paints',
  );
  assert.ok(report.title.trim().length > 0, 'the content region has a view title');
  const passed = new Map(report.passes.map((p) => [p.id, p.nodes]));
  for (const rule of ['color-contrast', 'button-name', 'aria-required-attr']) {
    assert.ok(
      (passed.get(rule) || 0) > 0,
      `axe's "${rule}" rule found no passing checkpoints, so it did not really run over the document`,
    );
  }

  // The assertion REQ-UI-007 is about: nothing at WCAG 2.1 A or AA. A violation here is a
  // conformance failure by construction, and the messages carry enough to act on without a rerun.
  const violations = report.violations.filter((v) => v.tags.some((t) => WCAG_AA.test(t)));
  if (violations.length) {
    const detail = violations
      .map((v) => {
        const nodes = v.nodes.map((n) => `      ${n.target.join(' ')} — ${n.html}`).join('\n');
        return `  [${v.impact}] ${v.id}: ${v.help}\n${nodes}`;
      })
      .join('\n');
    assert.fail(`axe (${report.axe}) found ${violations.length} WCAG 2.1 A/AA violation(s) in the built artifact:\n${detail}`);
  }
});

specTest('a11y.focus-management', () => {
  const { dom, TMV } = loadShell();
  const W = TMV.widgets;
  const core = TMV.core;
  const layers = dom.getElementById('tmv-layers');

  // ---- a modal traps focus, and gives it back ----
  const opener = core.el('button', { id: 'a11y-opener', text: 'Delete' });
  dom.body.appendChild(opener);
  opener.focus();
  assert.equal(dom.activeElement, opener, 'the test needs focus on the invoking element to begin with');

  const closed = [];
  const dialog = W.modal({
    title: 'Discard changes?',
    danger: true,
    body: [core.el('p', { text: 'This cannot be undone.' })],
    actions: [
      { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
      { label: 'Discard', kind: 'danger', action: 'discard' },
    ],
    onClose: (reason) => closed.push(reason),
  });
  dialog.open();

  assert.equal(W.openLayers(), 1, 'opening a modal registers exactly one layer');
  assert.ok(layers.contains(dialog.element), 'the modal is mounted inside the layer root');
  assert.equal(dialog.container.getAttribute('role'), 'dialog');
  assert.equal(dialog.container.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.container.getAttribute('aria-labelledby'), 'a dialog names itself through aria-labelledby');

  // `07-ui.md` §8: a destructive dialog puts initial focus on the action that does *not* destroy, so
  // a stray Enter is safe. A dialog that focused "Discard" would pass every static check and be
  // dangerous anyway, which is why this is asserted rather than left to the markup.
  assert.equal(dom.activeElement.textContent, 'Cancel', 'focus starts on the cancel action of a destructive dialog');
  assert.ok(dom.body.classList.contains('tmv-scroll-locked'), 'an open modal locks the page behind it');

  // The trap: Tab from the last focusable wraps to the first, rather than escaping to the page.
  const focusables = W.focusables(dialog.container);
  assert.equal(focusables.length, 2, 'the dialog exposes exactly its two actions to the tab order');
  focusables[focusables.length - 1].focus();
  const tab = focusables[focusables.length - 1].dispatch('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, true, 'the dialog handles Tab rather than letting it leave');
  assert.equal(dom.activeElement, focusables[0], 'Tab from the last focusable wraps to the first');

  const escape = dom.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(closed, ['escape'], 'Escape closes the dialog and reports why');
  assert.equal(W.openLayers(), 0, 'the layer stack is empty again');
  assert.equal(dom.activeElement, opener, 'focus returns to the element that opened the dialog (REQ-UI-007 AC2)');
  assert.ok(!layers.contains(dialog.element), 'the closed dialog is removed, not left hidden in the DOM');
  assert.ok(!dom.body.classList.contains('tmv-scroll-locked'), 'closing the modal releases the scroll lock');

  // ---- a menu answers the keyboard, and restores focus ----
  const trigger = core.el('button', {
    id: 'a11y-menu-trigger',
    class: 'cds--overflow-menu',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    text: 'Actions',
  });
  dom.body.appendChild(trigger);
  trigger.focus();

  const menu = W.overflowMenu({
    trigger,
    id: 'a11y-menu',
    entries: [
      { label: 'Rename', action: 'rename' },
      { label: 'Delete', action: 'delete' },
    ],
  });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'a closed trigger says so');

  menu.open();
  assert.equal(W.openLayers(), 1, 'an open menu is a layer');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'opening moves aria-expanded');
  const items = menu.element.querySelectorAll('[role="menuitem"]');
  assert.equal(items.length, 2);
  assert.equal(menu.element.getAttribute('aria-activedescendant'), items[0].id, 'the first item starts highlighted');

  items[0].dispatch('keydown', { key: 'ArrowDown' });
  assert.ok(items[1].classList.contains('cds--overflow-menu-options__option--highlighted'), 'ArrowDown moves the highlight');
  assert.equal(menu.element.getAttribute('aria-activedescendant'), items[1].id, 'the highlight is announced, not just drawn');

  // Escape reaches the menu even though focus never leaves the trigger. Opening a menu moves the
  // *selection*, not focus (`highlight` sets classes and `aria-activedescendant`), so a handler that
  // only existed on the menu itself would miss the ordinary gesture entirely.
  trigger.dispatch('keydown', { key: 'Escape' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(W.openLayers(), 0, 'Escape closes the menu');
  assert.equal(dom.activeElement, trigger, 'focus is on the trigger, which is where it belongs after closing');

  // ---- one Escape closes one layer ----
  // A menu opened from inside a dialog is the state the layer stack exists for (`pushLayer`). The
  // menu closes as the key bubbles out of it, and the dialog's own handler runs afterwards — so the
  // dialog has to be able to tell that this Escape has already been answered. Without that, one
  // keystroke closes a menu and the dialog under it, which is the failure the stack is meant to stop.
  const inner = core.el('button', { id: 'a11y-inner-trigger', text: 'More' });
  const under = W.modal({ title: 'Edit', body: [inner], actions: [{ label: 'Close', kind: 'tertiary' }] });
  under.open();
  const innerMenu = W.overflowMenu({ trigger: inner, id: 'a11y-inner-menu', entries: [{ label: 'Duplicate', action: 'dup' }] });
  innerMenu.open();
  assert.equal(W.openLayers(), 2, 'a menu over a modal is two layers');

  innerMenu.element.querySelector('[role="menuitem"]').dispatch('keydown', { key: 'Escape' });
  assert.equal(W.openLayers(), 1, 'one Escape closed exactly one layer');
  assert.ok(layers.contains(under.element), 'the dialog underneath is still open');

  // A second Escape, now that the dialog is the top layer, closes it.
  under.container.dispatch('keydown', { key: 'Escape' });
  assert.equal(W.openLayers(), 0, 'the dialog closes on the next Escape');
});

specTest('a11y.keyboard-only', () => {
  const { dom, TMV, shell } = loadShell();

  // ---- the tab strip ----
  const strip = dom.getElementById('tmv-tabs');
  const list = strip.querySelector('[role="tablist"]');
  assert.ok(list, 'the strip has a role="tablist" element');
  assert.ok(list.getAttribute('aria-label'), 'the tablist has an accessible name');

  const tabs = () => strip.querySelectorAll('[role="tab"]');
  const active = () => tabs().filter((t) => t.getAttribute('aria-selected') === 'true')[0];
  const panelLabel = () => dom.getElementById('tmv-content').getAttribute('aria-labelledby');
  assert.ok(tabs().length >= 2, 'the strip has tabs to move between');

  for (const tab of tabs()) {
    // A native button is what makes Enter and Space work without a keydown handler of our own; a
    // `<div role="tab">` would look identical in a DOM dump and be unreachable from the keyboard.
    assert.equal(tab.tagName, 'BUTTON', 'a tab is a native button');
    assert.equal(tab.getAttribute('aria-controls'), 'tmv-content', 'every tab controls the one content panel');
    assert.ok(tab.textContent.trim().length > 0, 'a tab has an accessible name');
  }

  // Roving tabindex: exactly one tab is in the document's tab order at a time, which is what keeps
  // Tab from walking through nine tabs to reach the content.
  const inOrder = tabs().filter((t) => t.getAttribute('tabindex') === '0');
  assert.equal(inOrder.length, 1, 'exactly one tab is in the tab order');
  assert.equal(inOrder[0], active(), 'the tab in the tab order is the selected one');

  active().focus();
  const firstValue = active().getAttribute('data-value');
  active().dispatch('keydown', { key: 'ArrowRight' });
  assert.notEqual(active().getAttribute('data-value'), firstValue, 'ArrowRight moves to the next tab');
  assert.equal(dom.activeElement, active(), 'focus follows the selection');
  assert.equal(panelLabel(), active().id, 'the panel is relabelled on every switch (07-ui.md §1)');

  active().dispatch('keydown', { key: 'End' });
  assert.equal(active().getAttribute('data-value'), tabs()[tabs().length - 1].getAttribute('data-value'), 'End jumps to the last tab');
  active().dispatch('keydown', { key: 'Home' });
  assert.equal(active().getAttribute('data-value'), tabs()[0].getAttribute('data-value'), 'Home jumps to the first tab');
  active().dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(active().getAttribute('data-value'), tabs()[tabs().length - 1].getAttribute('data-value'), 'ArrowLeft from the first wraps to the last');
  active().dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(active().getAttribute('data-value'), tabs()[0].getAttribute('data-value'), 'ArrowRight from the last wraps to the first');

  // A key the strip does not own must pass through. Swallowing every keystroke on the strip would
  // break nothing that axe can see and would break the page for anyone typing.
  const valueBefore = active().getAttribute('data-value');
  const passthrough = active().dispatch('keydown', { key: 'a' });
  assert.equal(passthrough.defaultPrevented, false, 'the strip lets keys it does not own through');
  assert.equal(active().getAttribute('data-value'), valueBefore);

  // Clicking a tab is how Enter and Space arrive, once the browser has turned them into a click.
  const wanted = tabs().find((t) => t.getAttribute('data-value') !== active().getAttribute('data-value'));
  wanted.click();
  assert.equal(active().getAttribute('data-value'), wanted.getAttribute('data-value'), 'activating a tab selects it');
  assert.equal(panelLabel(), wanted.id);

  // ---- the side nav ----
  const nav = dom.getElementById('tmv-side-nav');
  assert.ok(nav.getAttribute('aria-label'), 'the side nav names the tab it belongs to');
  const links = () => nav.querySelectorAll('button[data-action="side-nav"]');
  assert.ok(links().length > 0, 'the active tab has side-nav rows');

  for (const link of links()) {
    assert.equal(link.tagName, 'BUTTON', 'a side-nav row is a native button, so Enter and Space activate it');
    assert.ok(link.textContent.trim().length > 0, 'a side-nav row has an accessible name');
  }

  const current = nav.querySelectorAll('[aria-current="true"]');
  assert.equal(current.length, 1, 'exactly one side-nav row is marked current');
  const moveTo = links()[1];
  const section = moveTo.getAttribute('data-value');
  moveTo.click();
  const nowCurrent = nav.querySelectorAll('[aria-current="true"]');
  assert.equal(nowCurrent.length, 1, 'activation leaves exactly one current row');
  assert.equal(nowCurrent[0].getAttribute('data-value'), section, 'activating a row changes the section');
  assert.ok(nowCurrent[0].classList.contains('cds--side-nav__link--current'), 'the current row carries Carbon’s class as well as aria-current');

  // ---- sortable column headers answer the keyboard ----
  // The threat list's columns are sortable and the header is the control: a `th` with `data-action`,
  // `tabindex="0"` and `aria-sort`, not a button inside the header. Being focusable is not the same as
  // being operable, so the key that activates it is pressed here rather than assumed.
  shell.go('threats');
  const sortHeader = dom.getElementById('tmv-content').querySelector('th[data-action="sort"]');
  assert.ok(sortHeader, 'the threat list has a sortable column header');
  assert.ok(/^-?\d+$/.test(sortHeader.getAttribute('tabindex') || ''), 'the sort header is in the tab order');
  assert.equal(sortHeader.getAttribute('aria-sort'), 'none', 'an unsorted column says so');
  const activated = sortHeader.dispatch('keydown', { key: 'Enter' });
  assert.equal(activated.defaultPrevented, true, 'Enter on the sort header is handled');
  assert.equal(
    dom.getElementById('tmv-content').querySelector('th[data-action="sort"]').getAttribute('aria-sort'),
    'ascending',
    'Enter on the sort header sorts the column, and the new state is announced through aria-sort',
  );

  // ---- controls outside the views ----
  // The header's icon-only controls are declared in `index.html`, so the harness cannot see them (it
  // builds its hosts as bare `<div>`s by id). Check the artifact's own markup instead: a real button
  // is what makes them reachable, and an `aria-label` is what gives an icon-only control a name.
  const indexHtml = fs.readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
  for (const id of ['tmv-commit', 'tmv-sidenav-trigger']) {
    const m = new RegExp(`<(button|a)\\b[^>]*\\bid="${id}"[^>]*>`).exec(indexHtml);
    assert.ok(m, `the artifact declares #${id} as a native button or link so it is keyboard reachable`);
  }
  const triggerMarkup = /<button\b[^>]*\bid="tmv-sidenav-trigger"[^>]*>/.exec(indexHtml)[0];
  assert.ok(/aria-label="[^"]+"/.test(triggerMarkup), 'the icon-only side-nav trigger has an accessible name');
  assert.ok(/aria-expanded="/.test(triggerMarkup), 'the trigger reports the nav’s collapsed state');

  // ---- everything else the application renders that carries a click action ----
  // Anything with a `data-action` is something a pointer can activate, so there has to be a way to
  // reach it without one. Two exclusions, both principled rather than convenient:
  //
  //   - a node inside a `hidden` subtree is not in the tab order and must not be: a closed overflow
  //     menu's `li[role="menuitem"]` items are `hidden`, and making them focusable would be the
  //     defect, not the fix. Carbon's own pattern gives them `tabindex="-1"` and puts focus on the
  //     container, which names the highlighted item with `aria-activedescendant` (see the menu case
  //     in `a11y.focus-management`).
  //   - the two host placeholders the harness supplies (`tmv-commit`, `tmv-sidenav-trigger`) are
  //     `data-action` carriers created as bare divs here and as buttons in the artifact — asserted
  //     just above — so they are excluded by id rather than by tag.
  const harnessPlaceholders = new Set(['tmv-commit', 'tmv-sidenav-trigger']);
  const native = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const interactiveRole = /button|tab|menuitem|option|link|checkbox|radio|switch/;
  const inHiddenSubtree = (node) => {
    for (let p = node; p && p.nodeType === 1; p = p.parentNode) if (p.hasAttribute('hidden')) return true;
    return false;
  };
  const unreachable = [];
  let examined = 0;
  for (const tab of tabs()) {
    shell.go(tab.getAttribute('data-value'));
    for (const node of dom.body.querySelectorAll('[data-action]')) {
      if (inHiddenSubtree(node)) continue;
      if (harnessPlaceholders.has(node.id)) continue;
      examined++;
      if (native.has(node.tagName)) continue;
      if (node.hasAttribute('tabindex')) continue;
      const role = node.getAttribute('role');
      if (role && interactiveRole.test(role)) continue;
      unreachable.push(`${node.tagName.toLowerCase()}#${node.id || '?'}[data-action="${node.getAttribute('data-action')}"]`);
    }
  }
  // A walk that examined nothing would pass the assertion below while checking nothing at all, so the
  // population is asserted first. The bar is well under what the nine tabs actually expose today.
  assert.ok(
    examined > 100,
    `only ${examined} rendered elements carry a click action across all nine tabs, which is too few for ` +
      'this walk to have traversed the views — the check would pass vacuously',
  );
  assert.deepEqual(
    [...new Set(unreachable)],
    [],
    `these elements carry a click action but cannot be reached from the keyboard (REQ-UI-007 AC1): ${[...new Set(unreachable)].join(', ')}`,
  );
});
