/*
 * docs.test.mjs — the two requirements whose deliverable is a document.
 *
 * Both are marked *manual review* in `09-testing.md` §7, for the honest reason that a script cannot
 * judge whether prose is true. That is not the same as saying a script can check nothing: the part of
 * each requirement that is a *claim about coverage* can be checked mechanically, and that is what
 * these two tests do.
 *
 *   REQ-UI-010   `07-ui.md` §5 must list every component behaviour the code hand-writes, with the
 *                Carbon class contract it relies on. The list of behaviours is derived from the
 *                source here, not from the document — a test that read the required set out of the
 *                document it is checking would agree with any document at all.
 *   REQ-SEC-006  `08-security.md` must state the residual risk plainly. The test asserts the specific
 *                claims the requirement names, and the one absence that matters: the document must
 *                not leave the CSP reading as protection against a hostile file.
 *
 * Neither test can tell whether the prose is *good*. They can tell whether it is *present*, whether
 * it covers the code that exists, and whether it overclaims — and those are the failures that
 * actually happen when a document sits next to a moving implementation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { specTest } from './lib/check.mjs';
import { ROOT, sourceOf } from './lib/app.mjs';

const read = (rel) => fs.readFileSync(join(ROOT, rel), 'utf8');

/**
 * The rows of a table whose first cell is a bold component name.
 *
 * `07-ui.md` §5 is a two-table section: the components, then the "deliberately not used" list. Only
 * the first has bold first cells, and the second is excluded on purpose — a component that Carbon
 * ships and this application does not use has no behaviour to document.
 */
function componentRows(section) {
  const rows = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*\*\*(.+?)\*\*\s*\|(.*)\|(.*)\|\s*$/.exec(line);
    if (m) rows.push({ name: m[1].trim(), classes: m[2], work: m[3] });
  }
  return rows;
}

/** §5, from its heading to the next top-level heading. */
function behaviourInventory(doc) {
  const m = /## 5\. Component wiring inventory([\s\S]*?)\n## /.exec(doc);
  assert.ok(m, '`07-ui.md` no longer has a "## 5. Component wiring inventory" section, which ' +
    'REQ-UI-010 names as the place the hand-written behaviour is documented');
  return m[1];
}

/**
 * The public widgets `12-widgets.js` exports, read out of the source.
 *
 * Derived rather than listed, so that adding a widget and forgetting to document it fails here
 * instead of passing forever. `logic` (pure functions) and `CLS` (the class-name table) are values
 * rather than widgets and are dropped; the rest keep their own names in `WIDGET_COMPONENT` or
 * `WIDGET_HELPERS` below, and a name in neither is a widget somebody added without a decision.
 */
function exportedWidgets() {
  const src = sourceOf('12-widgets.js');
  const at = src.indexOf('TMV.widgets = {');
  assert.ok(at !== -1, '`12-widgets.js` no longer publishes `TMV.widgets`');
  const end = src.indexOf('\n  };', at);
  assert.ok(end !== -1, 'could not find the end of the `TMV.widgets` object literal');
  const block = src.slice(at, end).replace(/logic:\s*\{[\s\S]*?\n    \},/, '');
  const keys = [];
  for (const m of block.matchAll(/(?:^|\n)\s{4}([A-Za-z][A-Za-z0-9]*):/g)) keys.push(m[1]);
  return keys.filter((k) => k !== 'CLS');
}

/** Widget -> the §5 row that documents it. */
const WIDGET_COMPONENT = {
  tag: 'Tag',
  modal: 'Modal',
  confirm: 'Modal',
  // `popup` is the shared engine behind the overflow menu and the dropdown — it is where Escape,
  // outside-click dismissal and the arrow-key highlight live, and §5 documents both callers of it.
  popup: 'Overflow menu',
  overflowMenu: 'Overflow menu',
  dropdown: 'Dropdown',
  dataTable: 'Data table',
  accordion: 'Accordion',
  tree: 'Tree view',
  field: 'Text input / textarea / select',
  search: 'Search',
  fileDrop: 'File uploader',
  snippet: 'Code snippet',
  pagination: 'Pagination',
  contentSwitcher: 'Content switcher',
  progressSteps: 'Progress indicator',
  structuredList: 'Structured list',
  tooltip: 'Tooltip / definition tooltip',
};

/**
 * Widgets that carry no behaviour to document: an element builder, a helper that composes other
 * widgets, or a DOM primitive. §5 documents behaviours, and none of these toggles a state class on
 * its own.
 */
const WIDGET_HELPERS = new Set([
  'icon', 'button', 'labelled', 'emptyState',
  'layerRoot', 'lockScroll', 'focusables', 'closeTopLayer', 'openLayers',
  'readAll', 'copyText',
]);

specTest('docs.behaviour-inventory', () => {
  const doc = read(join('specs', '07-ui.md'));
  const section = behaviourInventory(doc);
  const rows = componentRows(section);
  assert.ok(rows.length >= 15, `§5 lists only ${rows.length} components; the inventory looks truncated`);

  const byName = new Map(rows.map((r) => [r.name, r]));

  // 1. Every widget the module exports is documented by name, or is an acknowledged helper. The
  //    mapping is explicit so that a new widget forces a decision rather than slipping past.
  const missing = [];
  for (const widget of exportedWidgets()) {
    if (WIDGET_HELPERS.has(widget)) continue;
    const label = WIDGET_COMPONENT[widget];
    if (!label) { missing.push(`${widget} (not classified as a component or a helper)`); continue; }
    if (!byName.has(label)) missing.push(`${widget} -> no §5 row named "${label}"`);
  }
  assert.deepEqual(missing, [], `§5 does not document every hand-written widget: ${missing.join('; ')}`);

  // 2. Tabs, the side nav and notifications are hand-written too, but they live in the shell and the
  //    notification module rather than in `12-widgets.js`. Each is required only if the module that
  //    owns it is actually wiring it — a check that the requirement is about the code that exists.
  const shell = sourceOf('17-shell.js');
  const notify = sourceOf('13-notify.js');
  if (shell.indexOf("role: 'tablist'") !== -1 || shell.indexOf('role: "tablist"') !== -1) {
    assert.ok(byName.has('Tabs'), 'the shell builds a tablist but §5 has no "Tabs" row');
  }
  if (shell.indexOf('cds--side-nav__link') !== -1) {
    assert.ok(byName.has('Side nav'), 'the shell wires the side nav but §5 has no "Side nav" row');
  }
  if (notify.indexOf('cds--inline-notification') !== -1) {
    assert.ok(byName.has('Notifications'), 'notifications are wired but §5 has no "Notifications" row');
  }

  // 3. Each documented component names the Carbon classes it relies on. "Lists each wired component
  //    with its state classes" is the requirement's acceptance criterion, and a row with an empty
  //    class column documents the behaviour without the contract it is written against.
  for (const row of rows) {
    if (/nothing/i.test(row.work) && row.classes.trim() === '') continue;
    assert.ok(
      /`cds--[a-z0-9-]+`/.test(row.classes),
      `§5's "${row.name}" row names no Carbon class in its second column`,
    );
  }

  // 4. The implementation points back at the inventory, so the two are read together. This is the
  //    citation the module header makes and the one a reader needs to find the contract.
  assert.ok(
    /07-ui\.md`? §5/.test(sourceOf('12-widgets.js')),
    '`12-widgets.js` no longer cites `07-ui.md` §5 as the inventory it implements (REQ-UI-010)',
  );
});

specTest('docs.threat-model', () => {
  const doc = read(join('specs', '08-security.md'));

  // REQ-SEC-006 names four things the document must say. Each is a claim, not a section title, so
  // each is checked as a phrase the prose actually contains rather than as a heading that might sit
  // above a paragraph saying something weaker.
  const required = [
    // "that an exported threat model is executable HTML"
    { re: /An exported threat model is an executable HTML file/, what: 'an exported model is executable HTML' },
    // "that opening one runs code with access to the origin's storage"
    { re: /threat model[\s\S]{0,40}means[\s\S]{0,10}running its\s+code/, what: 'opening one runs its code' },
    // "including the Chrome shared-origin case"
    { re: /Chrome and Edge, every `file:\/\/` page shares/, what: 'the Chrome/Edge shared file origin' },
    { re: /access to every other model in that origin's/, what: "code reaches the origin's stored models" },
    // "what the mitigations do and do not cover"
    { re: /The primary mitigation: import, do not open/, what: 'import-not-open is named as the primary mitigation' },
    { re: /A hostile file sets its own policy/, what: 'CSP does not constrain a hostile file' },
    { re: /## 11\. Residual risk/, what: 'a residual-risk section' },
    { re: /A hostile threat-model file opened directly can read all models/, what: 'the residual risk is stated, not implied' },
  ];
  for (const { re, what } of required) {
    assert.ok(re.test(doc), `\`08-security.md\` does not state that ${what} (REQ-SEC-006)`);
  }

  // The honest-claims rule from `CLAUDE.md`. The document may not present the CSP as a sandbox: the
  // structural problem is that a hostile file writes its own policy, and a security document that
  // omits that is the overclaim this requirement exists to prevent.
  assert.ok(
    /What it does not do/.test(doc) && /cannot constrain[\s\S]{0,40}the file's author/.test(doc),
    '`08-security.md` must say what the CSP does *not* do, or the policy reads as a sandbox',
  );
  assert.ok(
    /unconfirmed/i.test(doc),
    'the meta-CSP-on-`file://` platform question (V2) must stay marked unconfirmed in the document',
  );
});
