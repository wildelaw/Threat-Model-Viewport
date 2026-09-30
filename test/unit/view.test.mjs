/*
 * view.test.mjs — what the screens actually show.
 *
 * REQ-VIEW-001..008 are requirements about presentation, and a presentation requirement is the
 * easiest kind to test vacuously. "A heading exists" passes just as well after the table beneath it
 * stopped rendering, and "no edit affordance is present" passes just as well on a screen that renders
 * nothing at all. So everything here is asserted against what a person would see — the rows in the
 * table, the text of a cell, the attribute a screen reader reads — and where the claim is a negative
 * (a model with no risks shows no matrix; read-only mode has no edit affordance) the positive half is
 * asserted too, so the negative is known not to be a property of every model and every mode.
 *
 * The shell is mounted against the stub DOM in `test/lib/dom.mjs`. That DOM has no layout and does
 * not deliver events beyond a click's own handlers, so nothing below depends on either. The one
 * piece of real time it does have is the search field's 150 ms debounce (`12-widgets.js`), which is
 * waited out rather than stubbed — the debounce is behaviour the user experiences, and a test that
 * reaches past it would keep passing if the field stopped debouncing entirely.
 */

import assert from 'node:assert/strict';

import { specTest } from '../lib/check.mjs';
import { loadShell } from '../lib/app.mjs';

/** A model id for the models built inside a test. Any well-formed id will do; nothing reads it. */
const BUILT_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

/** Go to a section and hand back the content host, which is what every screen is rendered into. */
function view(shell, dom, tab, section) {
  shell.go(tab, section);
  return dom.getElementById('tmv-content');
}

/** A node's text with the whitespace collapsed, which is how it reads on screen. */
function textOf(node) {
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The title of the empty state a reader would actually see.
 *
 * A list screen carries two of them — one for "this model has none" and one for "none match what is
 * selected" (`07-ui.md` §9 says they are different facts and only one of them means the model is
 * empty) — and the one that does not apply is still in the document, hidden. Reading the first
 * `.tmv-empty__title` blindly would report the hidden one about half the time, so the walk goes up
 * from the title looking for a hidden ancestor, which is what a reader does by not seeing it.
 */
function emptyTitle(content) {
  for (const title of content.querySelectorAll('.tmv-empty__title')) {
    let hidden = false;
    for (let node = title; node; node = node.parentNode) {
      if (node.hasAttribute && node.hasAttribute('hidden')) {
        hidden = true;
        break;
      }
    }
    if (!hidden) return textOf(title);
  }
  return null;
}

/** The ids of the rows a table is currently showing, in the order it is showing them. */
function rowIds(content) {
  return content.querySelectorAll('tr[data-row]').map((n) => n.getAttribute('data-row'));
}

/** The sub-section links the side nav is offering for the active tab. */
function navSections(dom) {
  return dom
    .getElementById('tmv-side-nav')
    .querySelectorAll('[data-action="side-nav"]')
    .map((n) => n.getAttribute('data-value'));
}

/** A sortable column's header. Re-queried after every interaction: sorting rebuilds the `thead`. */
function sortHeader(content, key) {
  return content.querySelector('th[data-action="sort"][data-key="' + key + '"]');
}

/** The two keys a header answers to, because a header is a button and a button takes both. */
function press(node, key) {
  node.dispatch('keydown', { key: key, preventDefault() {} });
}

/** Past the search field's debounce. */
function settled() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

/**
 * The model the seed builds, with one change applied, installed as the working copy.
 *
 * `shell.edit` returns true for a real change and false for a no-op, so asserting on it keeps a test
 * from passing when the edit silently did nothing — which would make every assertion after it an
 * assertion about the seeded model instead.
 */
function withModel(shell, core, M, build) {
  const m = core.deepCopy(shell.state().model);
  build(m);
  assert.equal(shell.edit(m), true, 'the test model was accepted into the working copy');
  return m;
}

// -----------------------------------------------------------------------------------------------

specTest('view.empty-states', () => {
  // REQ-VIEW-001 AC2. Both schemas make most sections optional, so a model with nothing in it is the
  // normal case for a new file rather than an error case, and every screen has to say so in its own
  // words. The sweep is over every tab and every sub-section the navigation offers, because the
  // section that gets forgotten is always one nobody navigated to in a test.
  //
  // Three screens are legitimately neither a table nor an empty state, and the exclusion is narrow on
  // purpose: Export Readiness renders a per-format report, Integrity renders a verdict, and the
  // Settings sub-sections are configuration rather than model data. A fourth way of being allowed
  // through — "it rendered a table" — covers the history log, which has the initial commit in it and
  // therefore is not empty.
  const { dom, shell, TMV } = loadShell({ empty: true });
  const content = dom.getElementById('tmv-content');
  const NOT_A_DATA_SCREEN = new Set(['overview/export-readiness', 'history/integrity']);

  const problems = [];
  let sections = 0;
  for (const tab of shell.TABS) {
    for (const section of shell.logic.sectionsOf(tab.id)) {
      sections++;
      const at = `${tab.id}/${section.id}`;
      shell.go(tab.id, section.id);

      const text = textOf(content);
      if (text === '') problems.push(`${at}: rendered nothing at all`);
      // The shell's own two failure screens, named exactly as `17-shell.js` writes them.
      if (/This screen could not be drawn|This screen is not available/.test(text)) {
        problems.push(`${at}: showed a failure screen: ${text.slice(0, 80)}`);
      }

      const empty = content.querySelector('.tmv-empty__title');
      const table = content.querySelector('table');
      if (!empty && !table && tab.id !== 'settings' && !NOT_A_DATA_SCREEN.has(at)) {
        problems.push(`${at}: no empty state, but nothing standing in for one either`);
      }
      if (empty) {
        const title = emptyTitle(content);
        if (title === null) problems.push(`${at}: the only empty state on the screen is hidden`);
        else if (title === '') problems.push(`${at}: an empty state with no title`);
        // An empty state that describes a failure is the thing the AC rules out. The words are the
        // ones the shell and the empty-state widget use when something has gone wrong.
        else if (/error|fail|could not|unavailable|not available/i.test(title)) {
          problems.push(`${at}: an empty state that reads as an error: ${title}`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(sections >= 40, `the sweep reached every screen, not a handful: ${sections}`);
  assert.equal(TMV.notify.entries('error').length, 0, 'no screen recorded an error while being viewed');

  // The Overview is the one screen `07-ui.md` §9 gives a job beyond saying it is empty: it offers the
  // way out. A user who opens a blank file is looking at this screen, and the AC's "informative"
  // means there is something to do next.
  shell.go('overview', 'summary');
  assert.equal(emptyTitle(content), 'This model is empty');
  assert.ok(
    content.querySelector('[data-action="go-import"]'),
    'the empty Overview offers the import that would fill it',
  );
});

specTest('view.entity-coverage', () => {
  // REQ-VIEW-001 AC1. The list in the requirement is enumerated there, and so it is enumerated here:
  // every entity type is named with a row the seeded model holds, so a type that loses its list view
  // fails on the type it lost rather than on a count. Reachability is asserted through the side nav
  // rather than through `sectionsOf`, because "reachable from the navigation" is the AC — a section
  // that exists but is not linked is a section the user cannot get to.
  const { dom, shell } = loadShell();
  const content = dom.getElementById('tmv-content');

  const COVERAGE = [
    ['architecture', 'trust-zones', 'zone-core', 'Trust zones'],
    ['architecture', 'trust-boundaries', 'tb-1', 'Trust boundaries'],
    ['architecture', 'components', 'comp-db', 'Components'],
    ['architecture', 'actors', 'actor-user', 'Actors'],
    ['architecture', 'data-stores', 'ds-cards', 'Data stores'],
    ['data', 'data-sets', 'set-pan', 'Data sets'],
    ['data', 'assets', 'asset-pan', 'Assets'],
    ['flows', 'all-flows', 'flow-1', 'Data flows'],
    ['threats', 'all-threats', 'threat-1', 'Threats'],
    ['threats', 'personas', 'persona-1', 'Threat personas'],
    ['threats', 'assumptions', 'asm-1', 'Assumptions'],
    ['controls', 'all-controls', 'ctrl-2', 'Controls'],
    ['controls', 'mitigation-plans', 'mp-1', 'Mitigations'],
    ['risk', 'risk-register', 'risk-1', 'Risks'],
  ];

  for (const [tab, section, rowId, what] of COVERAGE) {
    shell.go(tab, section);
    assert.ok(
      shell.logic.sectionsOf(tab).some((s) => s.id === section),
      `${what} is a sub-section of ${tab}`,
    );
    assert.ok(navSections(dom).includes(section), `${what} is reachable from the side nav`);
    assert.ok(rowIds(content).includes(rowId), `${what} lists ${rowId}`);
  }

  // Overview and scope has no rows to look for — it is the model's own statement about itself.
  shell.go('overview', 'scope');
  assert.ok(navSections(dom).includes('scope'), 'Scope is reachable from the side nav');
  assert.match(textOf(content), /Everything between the cardholder and the acquirer/, 'the scope is shown');

  // Diagrams are the fifteenth type, and they render through the panel rather than a table: the
  // attribute is the panel's own count of what it found, which is what tells a rendered canvas from
  // a panel that decided the model had nothing to draw.
  shell.go('architecture', 'diagram');
  const panel = content.querySelector('.tmv-diagram');
  assert.ok(panel, 'the Diagram sub-section renders the diagram panel');
  assert.equal(panel.getAttribute('data-representations'), '1', 'the seed carries one canvas');
  assert.equal(panel.getAttribute('data-diagrams'), '1', 'and one source-text diagram');
});

specTest('view.table-sort', () => {
  // REQ-VIEW-002 AC1. Two properties, and the second is the one that gets lost: a sort must be
  // *stable*, and it must be operable from the keyboard. Stability is asserted on a column with ties
  // — two trust zones hold no components — because a stable sort keeps them in model order while an
  // unstable one is free to swap them, and the values are read from the attribute on the header
  // rather than from a class, since `aria-sort` is what a screen reader announces.
  const { dom, shell } = loadShell();
  const content = dom.getElementById('tmv-content');

  view(shell, dom, 'threats', 'all-threats');
  assert.deepEqual(rowIds(content), ['threat-1', 'threat-2', 'threat-unplaced'], 'the seeded order');

  sortHeader(content, 'name').click();
  assert.deepEqual(
    rowIds(content),
    ['threat-2', 'threat-unplaced', 'threat-1'],
    'ascending by name: Credential stuffing, Disk failure, SQL injection',
  );
  assert.equal(sortHeader(content, 'name').getAttribute('aria-sort'), 'ascending');

  sortHeader(content, 'name').click();
  assert.deepEqual(rowIds(content), ['threat-1', 'threat-unplaced', 'threat-2'], 'the second click reverses it');
  assert.equal(sortHeader(content, 'name').getAttribute('aria-sort'), 'descending');

  // Keyboard operation, on a table that has not been clicked yet. Enter and space are both accepted
  // because a header is a button, and a button that only answers to one of them is a bug a mouse
  // user never sees.
  view(shell, dom, 'architecture', 'trust-zones');
  assert.deepEqual(rowIds(content), ['zone-internet', 'zone-dmz', 'zone-core'], 'the seeded order');
  press(sortHeader(content, 'name'), 'Enter');
  assert.deepEqual(rowIds(content), ['zone-core', 'zone-dmz', 'zone-internet'], 'Enter sorts ascending');
  assert.equal(sortHeader(content, 'name').getAttribute('aria-sort'), 'ascending');
  press(sortHeader(content, 'name'), ' ');
  assert.deepEqual(rowIds(content), ['zone-internet', 'zone-dmz', 'zone-core'], 'space reverses it');
  assert.equal(sortHeader(content, 'name').getAttribute('aria-sort'), 'descending');

  // Stability. `zone-internet` and `zone-core` both hold no components and `zone-dmz` holds two, so a
  // stable ascending sort must leave the two zeros in the model's own order — internet, then core.
  view(shell, dom, 'architecture', 'trust-zones');
  sortHeader(content, 'components').click();
  assert.deepEqual(
    rowIds(content),
    ['zone-internet', 'zone-core', 'zone-dmz'],
    'ties keep the model order: internet and core are both empty, and neither is swapped',
  );

  // Columns whose value does not live at `row[key]`. Every one of these was inert before it declared
  // where its value comes from: the header toggled `aria-sort` and the rows never moved, which is a
  // sort that looks like it worked. Each is asserted in *descending* order, because in the seed the
  // ascending order happens to equal the model's own order and would pass with no sorting at all.
  view(shell, dom, 'architecture', 'trust-zones');
  assert.deepEqual(rowIds(content), ['zone-internet', 'zone-dmz', 'zone-core'], 'the seeded order');
  sortHeader(content, 'rating').click();
  sortHeader(content, 'rating').click();
  assert.deepEqual(
    rowIds(content),
    ['zone-dmz', 'zone-internet', 'zone-core'],
    'the trust rating sorts by `trustRating`, and the zone that states none stays last either way',
  );

  view(shell, dom, 'risk', 'risk-register');
  assert.deepEqual(rowIds(content), ['risk-1', 'risk-2'], 'the seeded order');
  sortHeader(content, 'score').click();
  assert.deepEqual(rowIds(content), ['risk-2', 'risk-1'], 'the score sorts by the computed score: 9 then 16');
  sortHeader(content, 'score').click();
  assert.deepEqual(rowIds(content), ['risk-1', 'risk-2'], 'and descending reverses it');

  // The level sorts by the vocabulary's order, not alphabetically. `risk-1` is `high` and `risk-2` is
  // `medium`; a string sort puts `high` first, so the two orderings disagree and this assertion can
  // tell them apart.
  sortHeader(content, 'level').click();
  assert.deepEqual(rowIds(content), ['risk-2', 'risk-1'], 'medium is below high in the vocabulary');
  sortHeader(content, 'level').click();
  assert.deepEqual(rowIds(content), ['risk-1', 'risk-2'], 'and descending reverses every column the same way');

  view(shell, dom, 'controls', 'mitigation-plans');
  assert.deepEqual(rowIds(content), ['mp-1', 'mp-2'], 'the seeded order');
  sortHeader(content, 'level').click();
  assert.deepEqual(
    rowIds(content),
    ['mp-2', 'mp-1'],
    'a plan sorts by the level of the risk it mitigates, which no field on the plan carries',
  );
});

specTest('view.table-filter-search', () => {
  // REQ-VIEW-002 AC2, and the reason it is a requirement: the obvious implementation gives the
  // search box its own `rows` and the filter its own, so typing into one throws the other away and
  // the screen silently shows more than the user asked for. Each step here is therefore chosen so
  // that composing and replacing give different answers.
  const { dom, shell } = loadShell();
  const content = dom.getElementById('tmv-content');

  const filterSelect = () => content.querySelector('[data-filter="type"] select');
  const searchBox = () => content.querySelector('input[type="search"]');
  const counts = () => textOf(content.querySelector('[role="status"]'));

  view(shell, dom, 'architecture', 'trust-zones');
  assert.deepEqual(
    filterSelect().querySelectorAll('option').map((o) => o.getAttribute('value')),
    ['', 'dmz', 'trusted', 'untrusted'],
    'the filter offers the zone types the model uses, and a way back to all of them',
  );
  assert.equal(counts(), '3 trust zones in this model.');

  filterSelect().value = 'trusted';
  filterSelect().dispatch('change', {});
  assert.deepEqual(rowIds(content), ['zone-core'], 'filtering to trusted leaves Core');
  assert.equal(counts(), '1 of 3 trust zones shown.', 'the count says how many of the model are showing');

  // Search "internet" while filtered to `trusted`. Composing gives nothing — no trusted zone is named
  // Internet — while replacing would forget the filter and show zone-internet.
  searchBox().value = 'internet';
  searchBox().dispatch('input', {});
  return settled().then(() => {
    assert.deepEqual(rowIds(content), [], 'the filter still applies while searching');
    assert.equal(counts(), '0 of 3 trust zones shown.');

    // Clearing the filter with the search still in the box leaves the search in force, which is the
    // same property from the other side: the two narrow together and neither resets the other.
    filterSelect().value = '';
    filterSelect().dispatch('change', {});
    assert.deepEqual(rowIds(content), ['zone-internet'], 'the search survives the filter being cleared');

    // And the way out resets both, so a user who cannot see why the table is empty has one action
    // rather than two guesses.
    filterSelect().value = 'trusted';
    filterSelect().dispatch('change', {});
    searchBox().value = 'core';
    searchBox().dispatch('input', {});
    return settled().then(() => {
      assert.deepEqual(rowIds(content), ['zone-core'], 'filter and search together');
      assert.equal(counts(), '1 of 3 trust zones shown.');
      content.querySelector('[data-action="clear-filters"]').click();
      assert.deepEqual(rowIds(content), ['zone-internet', 'zone-dmz', 'zone-core'], 'both are cleared');
      assert.equal(filterSelect().value, '');
      assert.equal(searchBox().value, '');
      assert.equal(counts(), '3 trust zones in this model.');
    });
  });
});

specTest('view.detail-passthrough-visible', () => {
  // REQ-VIEW-003. The passthrough bag is what makes import non-destructive (ADR-0004), and a value
  // kept but not shown is a value the user has no way to know survived. The negative is asserted
  // first — the seeded component has no bag, and its detail shows no bag row at all — so the rows
  // below are known to come from the bag rather than from something the detail view always renders.
  const { dom, shell, core, M } = loadShell();
  const content = dom.getElementById('tmv-content');

  const openDetail = (rowId) => {
    content.querySelector(`tr[data-row="${rowId}"] [data-action="open-entity"]`).click();
    return content.querySelector('.tmv-detail-host');
  };
  const bagKeys = (host) => host.querySelectorAll('.tmv-detail__key--bag').map(textOf);

  view(shell, dom, 'architecture', 'components');
  assert.deepEqual(bagKeys(openDetail('comp-gw')), [], 'a component with no passthrough bag has no bag rows');

  withModel(shell, core, M, (m) => {
    const component = M.get(m, 'component', 'comp-gw');
    component.x = Object.create(null);
    component.x.otm = Object.create(null);
    component.x.otm.deployment = 'kubernetes';
    component.x.otm.customThing = 42;
    component.x.tml = Object.create(null);
    component.x.tml.note = 'from tml';
  });

  view(shell, dom, 'architecture', 'components');
  const host = openDetail('comp-gw');
  const keys = bagKeys(host);
  assert.equal(keys.length, 3, 'one row per passthrough field');

  // Each row is attributed to the format it came from, in the row label itself — the heading above
  // the group is the one thing a reader scrolling to the middle of a long detail can miss.
  const otm = keys.filter((k) => k.indexOf('OTM') !== -1);
  const tml = keys.filter((k) => k.indexOf('TML') !== -1);
  assert.equal(otm.length, 2, 'the two OTM fields are labelled OTM');
  assert.equal(tml.length, 1, 'the TML field is labelled TML');
  for (const key of keys) {
    assert.match(key, /not interpreted by this application/, `the row says what the application did with it: ${key}`);
  }
  assert.ok(otm.some((k) => /deployment/.test(k)), 'the field names are shown, not just the format');

  // The values themselves, not only their labels — and alongside the interpreted fields, because a
  // passthrough section that replaced the fields the application does understand would be a
  // different bug wearing the same shape.
  const detail = textOf(host);
  assert.match(detail, /kubernetes/);
  assert.match(detail, /42/, 'a number survives as a number');
  assert.match(detail, /from tml/);
  assert.match(detail, /Trust zone/, 'the interpreted field is still shown');
  assert.match(detail, /DMZ/);
});

specTest('view.diagram-coordinates', () => {
  // REQ-VIEW-004. The AC names three things a canvas has to get right: zones are labelled containers,
  // their components are *inside* them, and flows are edges between source and destination with the
  // bidirectional ones distinguished. All three are structural, so all three are asserted on the
  // structure — nesting is read from the tree rather than from coordinates that happen to overlap.
  const { dom, shell, M, TMV } = loadShell();
  const content = dom.getElementById('tmv-content');

  const model = M.createEmpty('Canvas model', BUILT_ID);
  M.insert(model, 'trustZone', { id: 'zone-net', name: 'Internet', type: 'untrusted' });
  M.insert(model, 'component', { id: 'comp-a', name: 'Gateway', trustZoneId: 'zone-net' });
  M.insert(model, 'component', { id: 'comp-b', name: 'Store', trustZoneId: 'zone-net' });
  M.insert(model, 'representation', { id: 'rep-x', name: 'Canvas', type: 'canvas', width: 800, height: 600 });
  const place = (id, ownerId, ownerType, x, y, w, h) =>
    M.insert(model, 'representationElement', {
      id: id,
      representationId: 'rep-x',
      ownerId: ownerId,
      ownerType: ownerType,
      position: { x: x, y: y },
      size: { width: w, height: h },
    });
  place('re-zone', 'zone-net', 'trustZone', 20, 20, 300, 200);
  place('re-a', 'comp-a', 'component', 60, 60, 100, 50);
  place('re-b', 'comp-b', 'component', 60, 140, 100, 50);
  M.insert(model, 'dataFlow', { id: 'f1', name: 'Bidi', sourceId: 'comp-a', destinationId: 'comp-b', bidirectional: true });
  M.insert(model, 'dataFlow', { id: 'f2', name: 'One way', sourceId: 'comp-a', destinationId: 'comp-b', bidirectional: false });
  assert.equal(shell.edit(model), true, 'the canvas model was accepted into the working copy');

  view(shell, dom, 'architecture', 'diagram');
  const svg = content.querySelector('.tmv-diagram__svg');
  assert.ok(svg, 'the canvas is drawn as SVG');

  // The zone: one labelled container, at the coordinates the model recorded for it.
  const zones = content.querySelectorAll('.tmv-diagram__zone');
  assert.deepEqual(zones.map((z) => z.getAttribute('data-zone-id')), ['zone-net'], 'one zone group per placed zone');
  const zoneBox = zones[0].querySelector('.tmv-diagram__zone-box');
  assert.equal(zoneBox.getAttribute('x'), '20', 'the zone is drawn where its element says');
  assert.equal(zoneBox.getAttribute('y'), '20');
  assert.equal(zoneBox.getAttribute('width'), '300');
  assert.equal(zoneBox.getAttribute('height'), '200');
  assert.equal(textOf(zones[0].querySelector('.tmv-diagram__zone-label')), 'Internet', 'the container is labelled');

  // The components: both inside the zone's own group, none loose on the canvas.
  const contained = zones[0].querySelector('.tmv-diagram__zone-nodes');
  assert.deepEqual(
    contained.querySelectorAll('.tmv-diagram__node').map((n) => n.getAttribute('data-node-id')),
    ['comp-a', 'comp-b'],
    'the zone contains its components',
  );
  assert.equal(
    content.querySelector('.tmv-diagram__nodes--loose').querySelectorAll('.tmv-diagram__node').length,
    0,
    'and nothing that belongs to a zone is drawn outside it',
  );
  const nodeA = contained.querySelector('.tmv-diagram__node[data-node-id="comp-a"]');
  assert.equal(nodeA.querySelector('rect').getAttribute('x'), '60', 'a component is positioned from its coordinates');
  assert.equal(nodeA.querySelector('rect').getAttribute('y'), '60');

  // The flows: two edges, joined to the right entities, and only the bidirectional one carries the
  // second marker. `marker-end` alone is a one-way arrow.
  const edges = content.querySelectorAll('.tmv-diagram__edge');
  assert.deepEqual(
    edges.map((e) => e.getAttribute('data-flow-id')).sort(),
    ['f1', 'f2'],
    'one edge per flow between two placed entities',
  );
  const bidirectional = content.querySelector('.tmv-diagram__edge[data-flow-id="f1"]');
  const oneWay = content.querySelector('.tmv-diagram__edge[data-flow-id="f2"]');
  assert.ok(bidirectional.getAttribute('marker-end'), 'every edge points at its destination');
  assert.ok(bidirectional.getAttribute('marker-start'), 'a bidirectional flow is drawn with an arrow at both ends');
  assert.ok(oneWay.getAttribute('marker-end'));
  assert.equal(oneWay.getAttribute('marker-start'), null, 'a one-way flow is not');

  // The two markers are declared as separate defs, which is what makes the distinction above real
  // rather than two attributes that happen to differ.
  assert.equal(content.querySelectorAll('marker').length, 2, 'an arrow for each direction');
  assert.equal(TMV.diagrams.layout(model, 'rep-x').edges.length, 2);
});

specTest('view.diagram-fallback-source', () => {
  // REQ-VIEW-005 AC3, and its AC2. Graphviz and PlantUML are shown as source with a copy action and
  // no render is attempted, which is a claim about what did *not* happen — so it is asserted through
  // the renderer's own state, which stays `idle` (nothing has been fetched) rather than through the
  // absence of an element. A failing Mermaid load degrades the same way, with an explanation, and the
  // source is still there in full.
  //
  // The model is empty except for the source diagrams, so the panel has nothing to open on but them —
  // a canvas in the model would take the first slot and this test would be about the picker.
  const { dom, shell, M, TMV, core } = loadShell({ empty: true });
  const content = dom.getElementById('tmv-content');

  const classify = (source, type) => TMV.diagrams.classify(type === undefined ? { source: source } : { type: type, source: source });
  assert.equal(classify('digraph { a -> b }', 'graphviz').kind, 'source');
  assert.equal(classify('@startuml\nA -> B\n@enduml', 'plantuml').kind, 'source');
  assert.ok(/Graphviz is not rendered/.test(classify('x', 'graphviz').reason), 'and says why');
  // A language this application has never heard of, and a diagram that does not name one, are both
  // shown as written rather than guessed at.
  assert.equal(classify('{"mark":"bar"}', 'vega').kind, 'source');
  assert.equal(classify('just some text').kind, 'source');
  assert.match(classify('just some text').reason, /does not say what language/);

  withModel(shell, core, M, (m) => {
    M.insert(m, 'diagram', { id: 'dia-gv', name: 'Graphviz one', type: 'graphviz', source: 'digraph { a -> b }' });
    M.insert(m, 'diagram', { id: 'dia-pu', name: 'PlantUML one', type: 'plantuml', source: '@startuml\nA -> B\n@enduml' });
    M.insert(m, 'diagram', { id: 'dia-x', name: 'Mystery', type: 'vega', source: '{"mark":"bar"}' });
    M.insert(m, 'diagram', { id: 'dia-n', name: 'Typeless', source: 'just some text' });
  });

  view(shell, dom, 'architecture', 'diagram');
  const host = content.querySelector('.tmv-diagram__host');
  assert.equal(content.querySelector('.tmv-diagram').getAttribute('data-showing'), 'src:dia-gv');
  assert.match(textOf(host), /Graphviz is not rendered in this application/);
  assert.match(textOf(host), /digraph \{ a -> b \}/, 'the source is shown, in full');
  assert.ok(host.querySelector('[data-action="copy"]'), 'with a copy action');
  assert.equal(host.querySelector('.tmv-diagram__svg'), null, 'and not as a drawing');

  // Each of the other three, directly, so the dispatch is exercised for types the picker would only
  // reach by being clicked. Every one of them reports `source`, and none of them moves the loader.
  for (const id of ['dia-pu', 'dia-x', 'dia-n']) {
    const target = dom.createElement('div');
    const outcome = TMV.diagrams.render(target, M.get(shell.state().model, 'diagram', id));
    assert.equal(outcome.status, 'source', `${id} is shown as source`);
    assert.ok(target.querySelector('[data-action="copy"]'), `${id} can be copied`);
    assert.equal(target.querySelector('.tmv-diagram__svg'), null, `${id} was not drawn`);
  }
  assert.deepEqual(
    [TMV.diagrams.mermaidStatus().status, TMV.diagrams.mermaidStatus().reason],
    ['idle', null],
    'nothing was fetched for any of them',
  );

  // A Mermaid diagram whose renderer cannot be loaded. The stub DOM declares no loader template, so
  // the attempt fails at once and the failure path runs for real rather than being simulated.
  const failing = dom.createElement('div');
  const started = TMV.diagrams.render(failing, { id: 'dia-m', name: 'Context', type: 'mermaid', source: 'graph TD; a-->b;' });
  assert.equal(started.status, 'pending', 'the render is asynchronous, as fetching has to be');
  return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
    const note = textOf(failing.querySelector('.tmv-diagram__note'));
    assert.match(note, /The diagram could not be drawn:/, 'the failure is explained where the diagram would have been');
    assert.match(note, /[Tt]he source is shown below, in full/, 'and says what is shown instead');
    assert.match(textOf(failing), /graph TD; a-->b;/, 'the source text is there');
    assert.ok(failing.querySelector('[data-action="copy"]'), 'with the same copy action');
    // Not an error page: the rest of the screen is unaffected, which is the AC's "not an error page".
    assert.doesNotMatch(textOf(failing), /This screen could not be drawn/);
    assert.equal(TMV.diagrams.mermaidStatus().status, 'failed', 'and the failure is remembered');
  });
});

specTest('view.diagram-mermaid-lazy', () => {
  // REQ-VIEW-005 AC1. Mermaid comes off the network, and the requirement is that it does not happen
  // until a Mermaid diagram is actually put on screen. The seeded model carries one Mermaid diagram
  // *and* one canvas, and the panel opens on the canvas — so the state before the switch is the exact
  // case the AC is about, and `idle` is the observable that distinguishes "not fetched" from "fetched
  // and failed" in this environment, where a fetch could only fail.
  const { dom, shell, TMV } = loadShell();
  const content = dom.getElementById('tmv-content');

  view(shell, dom, 'architecture', 'diagram');
  const panel = content.querySelector('.tmv-diagram');
  assert.equal(panel.getAttribute('data-representations'), '1');
  assert.equal(panel.getAttribute('data-diagrams'), '1', 'the model does carry a Mermaid diagram');
  assert.equal(panel.getAttribute('data-showing'), 'rep:rep-1', 'and the panel opens on the canvas');

  const host = content.querySelector('.tmv-diagram__host');
  assert.ok(host.querySelector('.tmv-diagram__svg'), 'the canvas is on screen');
  assert.doesNotMatch(textOf(host), /graph TD/, 'the Mermaid diagram is not being displayed');

  assert.deepEqual(
    [TMV.diagrams.mermaidStatus().status, TMV.diagrams.mermaidStatus().reason],
    ['idle', null],
    'nothing has been fetched for a diagram that is not shown',
  );

  // Now display it. The picker is a list-box rather than a `select`, so the menu is opened by
  // clicking the field and the options are read from inside the picker — the document holds a second
  // list-box for the model switcher, whose options are not diagram choices.
  content.querySelector('.tmv-diagram__picker .cds--list-box__field').click();
  const option = content
    .querySelectorAll('.tmv-diagram__picker [role="option"]')
    .filter((o) => o.getAttribute('data-value') === 'src:dia-1')[0];
  assert.ok(option, 'the Mermaid diagram is offered in the picker');
  option.click();
  assert.equal(panel.getAttribute('data-showing'), 'src:dia-1');

  // Displaying it is what starts the load, so the state has moved off `idle` — in this environment it
  // fails, which is the point: the change of state is caused by the display and by nothing else.
  const after = TMV.diagrams.mermaidStatus();
  assert.notEqual(after.status, 'idle', 'displaying the diagram is what starts the load');
  assert.equal(after.status, 'failed');
  assert.match(after.reason, /renderer/, 'and the reason is about the renderer, not about the diagram');

  return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
    assert.match(textOf(host), /graph TD; a-->b;/, 'with the load failed, the source is shown instead');
    assert.match(textOf(host), /could not be drawn/, 'and the reason is stated');
  });
});

specTest('view.risk-matrix', () => {
  // REQ-VIEW-006, first half. The matrix is a 5×5 of likelihood against impact, and its AC is about
  // *when* it appears: only for a model that holds TML risks. So the positive case is checked against
  // the two risks the seed holds — their band, their count, and the risk they name — and the negative
  // against a model that holds an asset but no risks at all, which is the model most likely to get a
  // matrix it should not have.
  const { dom, shell, core, M } = loadShell();
  const content = dom.getElementById('tmv-content');
  const bandOf = (cell) => (cell.getAttribute('class').match(/tmv-band--([a-z_]+)/) || [])[1];

  view(shell, dom, 'risk', 'risk-matrix');
  const table = content.querySelector('table.tmv-matrix');
  assert.ok(table, 'the matrix is a table, so its rows and columns are its structure');

  const cells = content.querySelectorAll('.tmv-matrix__cell');
  assert.equal(cells.length, 25, 'five likelihoods against five impacts');
  for (const cell of cells) {
    assert.ok(
      ['very_low', 'low', 'medium', 'high', 'very_high', 'critical'].includes(bandOf(cell)),
      `every cell carries a severity band: ${cell.getAttribute('class')}`,
    );
  }

  // Banded by severity means the band follows the score, so the populated cells are checked against
  // where they sit: likely × major scores 16 and is High, possible × moderate scores 9 and is Medium.
  // The risk's name is carried on the cell's title rather than inside it — the cell shows a count and
  // a score, and a tooltip is what tells a reader which risk the count is of.
  const populated = cells.filter((c) => !c.classList.contains('tmv-matrix__cell--empty'));
  assert.equal(populated.length, 2, 'the seed holds two risks');
  const titleOf = (cell) => cell.getAttribute('title') || '';
  const cardData = populated.filter((c) => /Card data exposure/.test(titleOf(c)))[0];
  const takeover = populated.filter((c) => /Account takeover/.test(titleOf(c)))[0];
  assert.ok(cardData, 'the cell names the risk it holds rather than only counting it');
  assert.ok(takeover);
  assert.match(textOf(cardData), /Likely and Major: 1 risk, band High/, 'and its text says what the count means');
  assert.equal(bandOf(cardData), 'high', 'likely × major is High');
  assert.equal(bandOf(takeover), 'medium', 'possible × moderate is Medium');
  assert.equal(textOf(cardData.querySelector('.tmv-matrix__count')), '1');
  assert.equal(textOf(takeover.querySelector('.tmv-matrix__count')), '1');

  const legend = content.querySelectorAll('.tmv-matrix__legend-list li');
  assert.equal(legend.length, 6, 'the six bands the matrix can use are listed with their scores');
  assert.deepEqual(
    legend.map((li) => bandOf(li.querySelector('[class*="tmv-band--"]'))),
    ['very_low', 'low', 'medium', 'high', 'very_high', 'critical'],
    'in order, so the colours on the grid can be read off',
  );
  assert.match(textOf(legend[0]), /Very Low \(1–3\)/);
  assert.match(textOf(legend[5]), /Critical \(21–25\)/);

  // The AC's "only when": an empty model has no risks, and a model with an asset but no risks is not
  // a model with a matrix either. The second is the one that would pass a test written only against
  // an empty file.
  const empty = loadShell({ empty: true });
  view(empty.shell, empty.dom, 'risk', 'risk-matrix');
  assert.equal(empty.dom.getElementById('tmv-content').querySelector('table.tmv-matrix'), null);
  assert.equal(emptyTitle(empty.dom.getElementById('tmv-content')), 'No risks to plot');

  withModel(shell, core, M, (m) => {
    for (const risk of M.collection(m, 'risks').slice()) M.remove(m, 'risk', risk.id);
    M.insert(m, 'asset', { id: 'asset-only', name: 'Only asset', confidentiality: 50, integrity: 40, availability: 30 });
  });
  view(shell, dom, 'risk', 'risk-matrix');
  assert.equal(content.querySelector('table.tmv-matrix'), null, 'OTM ratings are not TML risks, so there is no matrix');
  assert.equal(emptyTitle(content), 'No risks to plot');
});

specTest('view.risk-otm-ratings', () => {
  // REQ-VIEW-006, second half: the ratings OTM carries — CIA per asset, a trust rating per zone, and
  // the risk reduction a mitigation claims. The AC is again about presence, so the values are read
  // out of the rows that hold them and the model is then stripped of assets to show that the three
  // presentations disappear together rather than one of them lingering over an empty table.
  const { dom, shell, core, M } = loadShell();
  const content = dom.getElementById('tmv-content');
  const numbersIn = (rowId) =>
    content
      .querySelector(`tr[data-row="${rowId}"]`)
      .querySelectorAll('td.tmv-td--numeric')
      .map(textOf);

  view(shell, dom, 'risk', 'cia-ratings');
  assert.deepEqual(numbersIn('asset-pan').slice(0, 3), ['90', '80', '70'], 'the three ratings are shown in order');
  assert.deepEqual(
    numbersIn('asset-unrated').slice(0, 3),
    ['Not rated', 'Not rated', 'Not rated'],
    'an asset that states no ratings says so in each column rather than showing a zero',
  );
  assert.match(textOf(content.querySelector('tr[data-row="asset-unrated"]')), /Confidentiality/, 'and names what is missing');

  view(shell, dom, 'risk', 'trust-ratings');
  assert.equal(numbersIn('zone-internet')[0], '0 / 100', 'a trust rating is shown against the scale it is on');
  assert.equal(numbersIn('zone-core')[0], 'Not rated', 'a zone with no rating says so');

  view(shell, dom, 'risk', 'threat-risk-inputs');
  assert.ok(
    numbersIn('threat-1').includes('60%'),
    'a threat whose mitigation claims a reduction shows it, as the highest any of them claims',
  );
  assert.ok(
    numbersIn('threat-2').includes('Not estimated'),
    'and a threat with no reduction stated says that rather than showing nothing',
  );

  // The AC's other direction: an empty model holds none of this, and neither does a model holding
  // only TML risks.
  const empty = loadShell({ empty: true });
  const expectations = [
    ['cia-ratings', 'No assets'],
    ['trust-ratings', 'No trust zones'],
    ['threat-risk-inputs', 'No threats'],
  ];
  for (const [section, title] of expectations) {
    view(empty.shell, empty.dom, 'risk', section);
    const host = empty.dom.getElementById('tmv-content');
    assert.equal(host.querySelectorAll('tr[data-row]').length, 0, `${section} lists nothing in an empty model`);
    assert.equal(emptyTitle(host), title);
  }

  // `M.collection` hands back the model's own array, so the removals are made over a copy of it —
  // removing while iterating it would skip every second entity and leave the assertion passing on a
  // model that still had assets in it.
  withModel(shell, core, M, (m) => {
    for (const asset of M.collection(m, 'assets').slice()) M.remove(m, 'asset', asset.id);
    for (const zone of M.collection(m, 'trustZones').slice()) M.remove(m, 'trustZone', zone.id);
  });
  view(shell, dom, 'risk', 'cia-ratings');
  assert.equal(emptyTitle(content), 'No assets', 'no assets, no CIA ratings');
  view(shell, dom, 'risk', 'trust-ratings');
  assert.equal(emptyTitle(content), 'No trust zones', 'no zones, no trust ratings');
});

specTest('view.unresolved-visible', () => {
  // REQ-VIEW-007. A dangling id is a statement somebody made that the model cannot honour, and the
  // AC asks for it to be visible in *both* places a user meets the entity: the row in the list and
  // the detail they open from it. The explanation has to name the target, because "unresolved" alone
  // leaves the reader to go and find which reference it meant.
  const { dom, shell } = loadShell();
  const content = dom.getElementById('tmv-content');

  view(shell, dom, 'flows', 'all-flows');
  const row = content.querySelector('tr[data-row="flow-bad"]');
  assert.ok(row, 'the flow with the dangling destination is listed');
  const marker = row.querySelectorAll('.cds--tag').filter((t) => /unresolved/i.test(textOf(t)))[0];
  assert.ok(marker, 'and is marked in the list');
  assert.match(marker.getAttribute('title'), /comp-missing/, 'the mark names the target that is missing');
  assert.ok(row.querySelectorAll('.tmv-unresolved__id').some((n) => textOf(n) === 'comp-missing'));

  // The flow that resolves carries no such mark, so the indicator is known to be about this flow
  // rather than about flows in general.
  const ok = content.querySelector('tr[data-row="flow-1"]');
  assert.equal(ok.querySelectorAll('.cds--tag').filter((t) => /unresolved/i.test(textOf(t))).length, 0);

  row.querySelector('[data-action="open-entity"]').click();
  const detail = content.querySelector('.tmv-detail-host');
  const warning = detail.querySelector('.cds--inline-notification--warning');
  assert.ok(warning, 'the detail repeats the warning');
  assert.match(textOf(warning), /references that do not resolve/);
  assert.match(textOf(warning), /comp-missing/, 'and names the missing target there too');
  assert.match(textOf(warning), /not in this model/);

  // The finder section is where a user goes looking for these, so the same flow has to be there as
  // well — marked on the *reference*, which is the thing that is wrong.
  view(shell, dom, 'threats', 'unresolved-references');
  const found = content.querySelector('tr[data-row="dataFlows:flow-bad"]');
  assert.ok(found, 'the flow appears under Unresolved References');
  assert.match(textOf(found), /Destination → comp-missing/);
  assert.match(
    found.querySelectorAll('.cds--tag')[0].getAttribute('title'),
    /Destination points at .comp-missing., which is not in this model/,
  );
});

specTest('view.read-only', () => {
  // REQ-VIEW-008. Two halves: no edit affordance is reachable, and export still works. Reachability
  // is asserted as *enabled* actions, because a disabled control is not reachable — but the sweep is
  // paired with the same sweep over an editable shell, so the assertion is known to be about the mode
  // rather than about a sweep that never finds anything. The detail view is checked separately from
  // the list, since `07-ui.md` §9 says the affordances there are removed rather than disabled and the
  // two are different claims.
  const MUTATIONS = ['add-entity', 'edit-entity', 'delete-entity', 'bulk-update', 'bulk-delete', 'revert-ask'];

  /** Every enabled element with a mutation action, and every edit action in an opened detail. */
  function sweep(editable) {
    const h = loadShell({ editable: editable });
    const content = h.dom.getElementById('tmv-content');
    const enabled = [];
    const inDetail = [];
    let sections = 0;
    for (const tab of h.shell.TABS) {
      for (const section of h.shell.logic.sectionsOf(tab.id)) {
        sections++;
        h.shell.go(tab.id, section.id);
        for (const node of content.querySelectorAll('[data-action]')) {
          const action = node.getAttribute('data-action');
          if (MUTATIONS.includes(action) && !node.hasAttribute('disabled')) {
            enabled.push(`${tab.id}/${section.id} → ${action}`);
          }
        }
        const opener = content.querySelector('[data-action="open-entity"]');
        if (opener) {
          opener.click();
          const host = content.querySelector('.tmv-detail-host');
          for (const node of host ? host.querySelectorAll('[data-action]') : []) {
            const action = node.getAttribute('data-action');
            if (action === 'edit-entity' || action === 'delete-entity') inDetail.push(`${tab.id}/${section.id} → ${action}`);
          }
        }
      }
    }
    return { h: h, content: content, enabled: enabled, inDetail: inDetail, sections: sections };
  }

  const ro = sweep(false);
  assert.ok(ro.sections >= 40, `the sweep reached every screen: ${ro.sections}`);
  assert.deepEqual(ro.enabled, [], `no mutation is reachable: ${ro.enabled.join(', ')}`);
  assert.deepEqual(ro.inDetail, [], `no edit action is in a detail view: ${ro.inDetail.join(', ')}`);

  // The same sweep in an editable shell finds plenty of both, so neither assertion above is true of
  // the sweep itself.
  const rw = sweep(true);
  assert.ok(rw.enabled.length > 0, 'an editable shell does offer mutations');
  assert.ok(rw.inDetail.length > 0, 'and a detail view does offer edit and delete');

  // The reason is on screen, not only in the title of a control the user cannot press. The banner is
  // outside the content host, so it stays put while the user navigates — which is what "persistent"
  // means here.
  const banners = ro.h.dom.getElementById('tmv-banners');
  assert.match(textOf(banners), /Read-only/);
  assert.match(textOf(banners), /This file was opened without a writable history/, 'and names the reason');
  ro.h.shell.go('risk', 'risk-matrix');
  assert.match(textOf(banners), /Read-only/, 'still there after navigating away');

  // A caller that tries anyway is refused, and the refusal names the same reason. The working copy is
  // the object it was, which is the part that matters: a read-only file that quietly accepted an edit
  // would be a mutation that never reaches the file and never warns anyone.
  const before = ro.h.shell.state().model;
  const attempt = ro.h.core.deepCopy(before);
  ro.h.M.insert(attempt, 'assumption', { id: 'asm-nope', name: 'Nope' });
  assert.equal(ro.h.shell.edit(attempt), false, 'edit() refuses in read-only mode');
  assert.equal(ro.h.shell.state().model, before, 'and the working copy is untouched');
  const refusal = ro.h.TMV.notify.latestError();
  assert.equal(refusal.title, 'This model cannot be edited here');
  assert.equal(refusal.detail, 'This file was opened without a writable history.');

  // Export is the other half of the AC. The action is present and enabled rather than present and
  // inert, and the exporter itself runs to a document — a button that opens a dialog which then
  // refuses would satisfy the first and not the second.
  ro.h.shell.go('settings', 'export');
  const download = ro.content.querySelector('[data-action="export-download"]');
  assert.ok(download, 'export is offered');
  assert.equal(download.hasAttribute('disabled'), false, 'and is not disabled');
  // The fixture's `flow-bad` names a destination nothing holds, and §8 blocks writing that name into
  // someone else's tool; the flow goes, so what is under test here is that a read-only model still
  // exports rather than that a dangling reference is refused.
  ro.h.shell.state().model.dataFlows = ro.h.shell.state().model.dataFlows.filter((f) => f.id !== 'flow-bad');
  const out = ro.h.TMV.exporting.exportAs('otm', ro.h.shell.state().model, ro.h.shell.state().history);
  assert.equal(out.ok, true, JSON.stringify(out.blocked));
  assert.ok(out.bytes > 0, 'exporting a read-only file produces a document');
});
