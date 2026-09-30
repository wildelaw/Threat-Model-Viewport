/* ---- src/app/12-widgets.js ---- */
/*
 * Hand-written Carbon wiring (`07-ui.md` §5, REQ-UI-010).
 *
 * Carbon v11 supplies a stylesheet and nothing else. There is no JavaScript bundle to call, so every
 * behaviour the documentation implies — a modal that traps focus, a listbox that answers arrow keys,
 * a table that sorts — is written here, toggling Carbon's own class names. §5 is the inventory and
 * this module is its implementation; when the two disagree, §5 is right and this file is the bug.
 *
 * Two notes that shape everything below.
 *
 * **The class names are unverified.** `10-open-questions.md` V3 records that the pinned stylesheet
 * has never been read for its actual state classes — §5's list is React's conventions, which are not
 * the same thing. Every class name here is therefore grouped into a named constant near its widget,
 * so correcting one after V3 is measured is a one-line change rather than a hunt. Nothing is
 * hard-coded inline for that reason.
 *
 * **Nothing here decides anything about a threat model.** Widgets take rows, labels and values and
 * render them; they do not know what a threat is. That keeps the security-relevant rule in one place
 * — every string in this file reaches the DOM through `textContent` or `createTextNode`, and there is
 * no path in it that takes markup (REQ-SEC-003, REQ-UI-008). A widget that could render markup would
 * be a widget every view had to remember not to feed untrusted data to.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;

  // ---------------------------------------------------------------------------------------------
  // Carbon class names, gathered per widget
  //
  // Grouped rather than inline so that V3 is a single edit per component. The values were §5's
  // inventory verbatim, which is what V3 says not to trust — and V3 was right. Every name below was
  // then checked against the pinned stylesheet itself (`@carbon/styles@1.116.0/css/styles.min.css`,
  // the only CSS file that package ships) and five of them were wrong:
  //
  //   cds--file__drop-container--dragover  →  `--drag-over` is the real name; fixed below
  //   cds--modal--danger                   →  no such rule in v11 at all; `00-app.css` supplies it
  //   cds--grid                            →  not in the pinned file; the 2× grid is not shipped here
  //   cds--header__menu-trigger            →  not in the pinned file either, despite §1's table
  //   cds--structured-list-cell            →  the real cells are `--td` and `--th`; see `list` below
  //   cds--structured-list-header-row      →  the real name is `--row--header-row`; see `list` below
  //
  // What *was* confirmed: `is-visible` is right for the modal (`.cds--modal` is `visibility:hidden`
  // and `.is-visible` sets `visibility:inherit`), and the side-nav state classes are
  // `--collapsed`/`--expanded` — though `--collapsed` slides the nav off-canvas rather than shrinking
  // it to a rail, so `00-app.css` overrides it above `sm`. V3 is answered; these names are now
  // transcribed from the stylesheet rather than from the documentation about it.
  // ---------------------------------------------------------------------------------------------

  var CLS = {
    // §5 lists `.is-visible` vs `--expanded` as the open question for these three specifically.
    modal: { root: 'cds--modal', container: 'cds--modal-container', header: 'cds--modal-header', content: 'cds--modal-content', footer: 'cds--modal-footer', visible: 'is-visible', danger: 'cds--modal--danger' },
    menu: { root: 'cds--overflow-menu-options', option: 'cds--overflow-menu-options__option', open: 'cds--overflow-menu--open' },
    dropdown: { root: 'cds--list-box', field: 'cds--list-box__field', menu: 'cds--list-box__menu', item: 'cds--list-box__menu-item', selected: 'cds--list-box__menu-item--selected', highlighted: 'cds--list-box__menu-item--highlighted', open: 'cds--list-box--expanded', invalid: 'cds--list-box--invalid' },
    table: { root: 'cds--data-table', sortable: 'cds--table-sort', asc: 'cds--table-sort--ascending', desc: 'cds--table-sort--descending', rowSelected: 'cds--data-table--selected', batch: 'cds--batch-actions', batchOn: 'cds--batch-actions--active', expandable: 'cds--expandable-row', sticky: 'tmv-table--sticky' },
    field: { input: 'cds--text-input', area: 'cds--text-area', select: 'cds--select-input', selectWrapper: 'cds--select-input__wrapper', label: 'cds--label', invalid: 'cds--text-input--invalid' },
    checkbox: 'cds--checkbox',
    radio: 'cds--radio-button',
    toggle: 'cds--toggle',
    notification: { inline: 'cds--inline-notification', toast: 'cds--toast-notification', error: 'cds--inline-notification--error', success: 'cds--inline-notification--success', warning: 'cds--inline-notification--warning', info: 'cds--inline-notification--info' },
    file: { root: 'cds--file', drop: 'cds--file__drop-container', browse: 'cds--file-browse-btn', container: 'cds--file-container', over: 'cds--file__drop-container--drag-over', item: 'cds--file__selected-file' },
    snippet: { root: 'cds--snippet', multi: 'cds--snippet--multi', single: 'cds--snippet--single', expand: 'cds--snippet--expand', copy: 'cds--snippet__copy-button' },
    // The cells are `--td` and `--th`, not a shared `--cell`, and the header row is
    // `--row--header-row`, not `--header-row`. The invented names were the visible defect, not just a
    // wrong string in a table: Carbon puts a cell's padding on `.cds--structured-list-td`, so a cell
    // carrying a class nothing matches got no padding at all, and the entity detail rendered its
    // labels hard against their values with no gutter between the columns.
    list: { root: 'cds--structured-list', row: 'cds--structured-list-row', cell: 'cds--structured-list-td', headCell: 'cds--structured-list-th', head: 'cds--structured-list-row--header-row' },
    tag: { root: 'cds--tag', filter: 'cds--tag--filter', label: 'cds--tag__label' },
    progress: { root: 'cds--progress', vertical: 'cds--progress--vertical', step: 'cds--progress-step', current: 'cds--progress-step--current', complete: 'cds--progress-step--complete', incomplete: 'cds--progress-step--incomplete' },
    tree: { root: 'cds--tree', node: 'cds--tree-node', children: 'cds--tree-node__children', leaf: 'cds--tree-leaf-node', active: 'cds--tree-node--active' },
    accordion: { root: 'cds--accordion', item: 'cds--accordion__item', heading: 'cds--accordion__heading', content: 'cds--accordion__content', open: 'cds--accordion__item--active' },
    search: { root: 'cds--search', input: 'cds--search-input', close: 'cds--search-close' },
    pagination: { root: 'cds--pagination', nav: 'cds--pagination__nav', button: 'cds--pagination__button', text: 'cds--pagination__text' },
    switcher: { root: 'cds--content-switcher', button: 'cds--content-switcher-btn', selected: 'cds--content-switcher--selected' },
    tooltip: 'cds--definition-tooltip',
    // No `grid` entry. There was one — `cds--grid`, taken from §5 — and the pinned stylesheet has no
    // rule for it, so any widget that had used it would have got no layout and no error. `02-` and
    // `07-ui.md` describe the 2× grid as the content container; in this Carbon build it is not
    // shipped. Layout is `.tmv-*` classes in `00-app.css`.
  };

  // ---------------------------------------------------------------------------------------------
  // 1. Logic worth testing without a DOM
  //
  // `09-testing.md` §2 keeps the unit-test DOM stub deliberately small, which is a design
  // instruction: anything a widget can decide *before* it touches the document belongs here, where
  // it is testable, rather than in the render path, where it is not.
  // ---------------------------------------------------------------------------------------------

  /**
   * Compare two cell values for sorting.
   *
   * Deliberately not `localeCompare`: its result depends on the browser's collation and locale, so
   * the same model would sort differently in Chrome and Safari and the browser matrix would start
   * reporting ordering bugs that are not bugs. This ordering is a pure function of the values.
   *
   * Absent values (`null`, `undefined`, `''`) always sort last, in both directions. That is not
   * alphabetical logic — it is the display rule: a table sorted by "Mitigation" should not lead with
   * the rows that have no mitigation, whichever way the caret points.
   */
  function compareValues(a, b) {
    var aAbsent = a === null || a === undefined || a === '';
    var bAbsent = b === null || b === undefined || b === '';
    if (aAbsent && bAbsent) return 0;
    if (aAbsent) return 1;
    if (bAbsent) return -1;

    if (core.isNumber(a) && core.isNumber(b)) return a < b ? -1 : a > b ? 1 : 0;
    if (core.isBoolean(a) && core.isBoolean(b)) return a === b ? 0 : a ? 1 : -1;
    // Numbers compared as numbers even when one side arrived as a string, because the model allows
    // both and "50" landing between "5" and "500" is the kind of thing users file bugs about.
    var an = Number(a);
    var bn = Number(b);
    if (!isNaN(an) && !isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '') {
      return an < bn ? -1 : an > bn ? 1 : 0;
    }

    var as = core.nfc(String(a)).toLowerCase();
    var bs = core.nfc(String(b)).toLowerCase();
    if (as === bs) return 0;
    return as < bs ? -1 : 1;
  }

  /**
   * Sort without depending on the engine for stability (REQ-VIEW-002).
   *
   * `Array.prototype.sort` has been specified stable since ES2019, so the tiebreak below is
   * redundant on every engine we target. It is written anyway, because the requirement is that two
   * rows with equal keys keep their source order, and "the engine guarantees it" is a platform
   * assumption — which is the category of thing this project has already been burned by twice
   * (ADR-0001, V1–V4). Four lines is a cheap way not to depend on it.
   */
  function stableSort(rows, compare) {
    var indexed = [];
    for (var i = 0; i < rows.length; i++) indexed.push({ row: rows[i], at: i });
    indexed.sort(function (a, b) {
      var byValue = compare(a.row, b.row);
      return byValue !== 0 ? byValue : a.at - b.at;
    });
    var out = [];
    for (var j = 0; j < indexed.length; j++) out.push(indexed[j].row);
    return out;
  }

  /** A value the table has nothing to show for. */
  function isAbsent(value) {
    return value === null || value === undefined || value === '';
  }

  /** Sort rows by a cell accessor. `direction` is `'ascending'` or `'descending'`. */
  function sortRows(rows, valueOf, direction) {
    var sign = direction === 'descending' ? -1 : 1;
    return stableSort(rows, function (a, b) {
      var av = valueOf(a);
      var bv = valueOf(b);
      // Absent values are decided *before* the sign is applied, which is the whole point: reversing
      // a column should reverse the rows that have a value, not drag the blanks to the top. See the
      // note in compareValues.
      if (isAbsent(av) || isAbsent(bv)) {
        if (isAbsent(av) && isAbsent(bv)) return 0;
        return isAbsent(av) ? 1 : -1;
      }
      return sign * compareValues(av, bv);
    });
  }

  /**
   * Typeahead for a listbox (REQ-UI-007's `aria-activedescendant` patterns).
   *
   * Match rules, in order: a label starting with the query, then any label containing it, then — for
   * a repeated press of the same letter — the next such label after the current one, so pressing
   * `t` three times walks the `t` entries rather than sticking on the first.
   *
   * `query` should accumulate the keys typed in quick succession; `widgets.typeaheadBuffer` does that
   * bookkeeping and this function stays a pure lookup.
   */
  function typeahead(labels, query, current) {
    if (!query) return -1;
    var q = core.nfc(query).toLowerCase();
    var starts = [];
    var contains = [];
    for (var i = 0; i < labels.length; i++) {
      var label = core.nfc(String(labels[i] === null || labels[i] === undefined ? '' : labels[i])).toLowerCase();
      if (label.indexOf(q) === 0) starts.push(i);
      else if (label.indexOf(q) !== -1) contains.push(i);
    }
    var pool = starts.length ? starts : contains;
    if (!pool.length) return -1;
    if (pool.length === 1) return pool[0];
    // Repeated same-letter presses cycle: only when the current item is itself in the pool, so the
    // first press still jumps to the first match rather than to the second.
    if (core.isNumber(current) && pool.indexOf(current) !== -1 && pool.length > 1) {
      return pool[(pool.indexOf(current) + 1) % pool.length];
    }
    return pool[0];
  }

  /**
   * Accumulate keystrokes into a typeahead query.
   *
   * A press continues the query if it came within 600ms of the last one, and starts a new one
   * otherwise. A space arriving at the start of a *new* query is dropped rather than taken
   * literally: no label begins with a space, so keeping it would make the first press match nothing
   * and look like the list had stopped answering.
   */
  function typeaheadBuffer(buffer, key, nowMs) {
    var fresh = !buffer || nowMs - buffer.at > 600;
    if (fresh && key === ' ') return { text: '', at: nowMs };
    return { text: fresh ? key : buffer.text + key, at: nowMs };
  }

  /**
   * Clamp a page number and describe the window (REQ-VIEW-002's pagination).
   *
   * `total` of 0 is a page, not an error: an empty table still has a page 1 that says "0 items",
   * because a pager that disappears when a filter matches nothing looks broken rather than empty
   * (`07-ui.md` §9).
   */
  function pageWindow(total, page, pageSize) {
    var size = core.isNumber(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 10;
    var count = core.isNumber(total) && total > 0 ? Math.floor(total) : 0;
    var pages = Math.max(1, Math.ceil(count / size));
    var current = core.isNumber(page) ? Math.floor(page) : 1;
    if (current < 1) current = 1;
    if (current > pages) current = pages;
    var from = count === 0 ? 0 : (current - 1) * size + 1;
    var to = count === 0 ? 0 : Math.min(count, current * size);
    return {
      page: current,
      pages: pages,
      pageSize: size,
      from: from,
      to: to,
      total: count,
      text: rangeText(from, to, count),
    };
  }

  /** Carbon's pagination copy: "1–10 of 240 items". En dash, singular for one item. */
  function rangeText(from, to, total) {
    if (total === 0) return '0 items';
    if (total === 1) return '1 item';
    return from + '–' + to + ' of ' + total + ' items';
  }

  /** Slice a page out of a list, given the window `pageWindow` produced. */
  function pageSlice(list, window) {
    if (window.total === 0) return [];
    return list.slice(window.from - 1, window.to);
  }

  /**
   * The select-all checkbox has three states, not two (REQ-UI-007's indeterminate obligation).
   * Carbon expresses the third with the DOM property `indeterminate`, which has no attribute form —
   * so it can only be set in script, and a view that forgot it would show "all selected" for a
   * partial selection.
   */
  function selectAllState(selectedCount, total) {
    if (total === 0 || selectedCount <= 0) return 'none';
    return selectedCount >= total ? 'all' : 'some';
  }

  /** Move a highlighted index by a key press, optionally wrapping at the ends. */
  function stepHighlight(count, current, key, opts) {
    if (count <= 0) return -1;
    var wrap = !opts || opts.wrap !== false;
    var at = core.isNumber(current) ? current : -1;
    var next;
    if (key === 'Home') next = 0;
    else if (key === 'End') next = count - 1;
    else if (key === 'ArrowDown') next = at + 1;
    else if (key === 'ArrowUp') next = at - 1;
    else if (key === 'PageDown') next = at + 10;
    else if (key === 'PageUp') next = at - 10;
    else return at;
    if (next < 0) return wrap ? count - 1 : 0;
    if (next >= count) return wrap ? 0 : count - 1;
    return next;
  }

  /**
   * Where a tab press lands, for a focus trap.
   *
   * `list` is the ordered focusable elements, `current` the one holding focus. Returning an index
   * rather than an element keeps the arithmetic — including the `-1` cases, where focus is outside
   * the trap entirely — testable without a document.
   */
  function tabTarget(list, current, shift) {
    if (!list || !list.length) return -1;
    var at = list.indexOf(current);
    if (at === -1) return shift ? list.length - 1 : 0;
    var next = at + (shift ? -1 : 1);
    if (next < 0) return list.length - 1;
    if (next >= list.length) return 0;
    return next;
  }

  /**
   * Can this element take focus?
   *
   * Written as a predicate over an element rather than a `querySelectorAll` call because the
   * selectors Carbon's own components use (`:not([disabled])`, `:not([tabindex="-1"])`) are exactly
   * the kind of thing V3 says to verify against the stylesheet, and a hand-rolled predicate is
   * easier to correct than a selector string buried in a trap.
   */
  function isFocusable(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = String(node.tagName || '').toLowerCase();
    if (tag === 'input' && node.getAttribute && String(node.getAttribute('type')).toLowerCase() === 'hidden') return false;
    if (node.hasAttribute && (node.hasAttribute('disabled') || node.hasAttribute('hidden'))) return false;
    if (node.getAttribute && node.getAttribute('tabindex') === '-1') return false;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  /** The focusable descendants of a root, in document order. */
  function focusables(root) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    // A selector rather than a full tree walk, then the predicate above for the per-element rules.
    var found = root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]');
    for (var i = 0; i < found.length; i++) if (isFocusable(found[i])) out.push(found[i]);
    return out;
  }

  /**
   * Collision-aware placement for a tooltip (`07-ui.md` §5: "positioning is ours").
   *
   * Pure geometry, in viewport coordinates. Tries below the anchor, then above, then right, then
   * left, and clamps along the cross axis so a tooltip on a cell at the right edge stays on screen
   * instead of being clipped — which is the whole reason Carbon's static positional classes are not
   * enough.
   */
  function place(anchor, size, viewport, opts) {
    var margin = opts && core.isNumber(opts.margin) ? opts.margin : 8;
    var gap = opts && core.isNumber(opts.gap) ? opts.gap : 6;
    var vw = viewport.width;
    var vh = viewport.height;
    var placement = 'bottom';
    if (anchor.top + anchor.height + gap + size.height > vh - margin) {
      if (anchor.top - gap - size.height >= margin) placement = 'top';
      else if (anchor.left + anchor.width + gap + size.width <= vw - margin) placement = 'right';
      else if (anchor.left - gap - size.width >= margin) placement = 'left';
      else placement = 'top';
    }
    var top;
    var left;
    if (placement === 'bottom' || placement === 'top') {
      top = placement === 'bottom' ? anchor.top + anchor.height + gap : anchor.top - gap - size.height;
      // Centred on the anchor, then clamped to the viewport, then clamped again if the tooltip is
      // wider than the space available (in which case it pins to the left margin).
      left = anchor.left + anchor.width / 2 - size.width / 2;
      left = Math.min(Math.max(left, margin), Math.max(margin, vw - margin - size.width));
    } else {
      left = placement === 'right' ? anchor.left + anchor.width + gap : anchor.left - gap - size.width;
      top = anchor.top + anchor.height / 2 - size.height / 2;
      top = Math.min(Math.max(top, margin), Math.max(margin, vh - margin - size.height));
    }
    return {
      top: Math.round(top),
      left: Math.round(left),
      placement: placement,
      // Where the arrow should sit along the tooltip's edge, so it still points at the anchor after
      // the clamp moved the body.
      arrow: placement === 'bottom' || placement === 'top'
        ? { x: Math.round(Math.min(Math.max(anchor.left + anchor.width / 2 - left, 12), size.width - 12)) }
        : { y: Math.round(Math.min(Math.max(anchor.top + anchor.height / 2 - top, 12), size.height - 12)) },
    };
  }

  /**
   * Is this a colour that can be shown as-is?
   *
   * Used by the diagram and the risk matrix, both of which take colours from model data. A value
   * that is not a plain CSS colour is refused here rather than handed to `style.background`, because
   * a `style` value is a place a `url(…)` can smuggle a request out — and REQ-SEC-005's no-exfil
   * claim is about every path, not just the obvious one.
   */
  var COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\(\s*[\d.\s,%]+\)$|^hsla?\(\s*[\d.\s,%]+\)$/;
  function safeColor(value) {
    if (!core.isString(value)) return null;
    var colour = value.trim();
    return COLOR_RE.test(colour) ? colour : null;
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Small pieces the widgets share
  // ---------------------------------------------------------------------------------------------

  /** An icon is a CSS-drawn span; there is no icon font and no SVG sprite to load. */
  function icon(name, extra) {
    return core.el('span', { class: 'tmv-icon tmv-icon--' + name + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
  }

  function button(opts) {
    var attrs = {
      type: 'button',
      class: 'cds--btn cds--btn--' + (opts.kind || 'tertiary') + (opts.size ? ' cds--btn--' + opts.size : ''),
      text: opts.label,
      disabled: opts.disabled === true,
    };
    if (opts.action) attrs['data-action'] = opts.action;
    if (opts.name) attrs['data-name'] = opts.name;
    if (opts.title) attrs.title = opts.title;
    if (opts.ariaLabel) attrs['aria-label'] = opts.ariaLabel;
    if (opts.value !== undefined) attrs['data-value'] = String(opts.value);
    var node = core.el('button', attrs, opts.icon ? [icon(opts.icon)] : []);
    if (opts.icon && opts.label) node.appendChild(core.text(opts.label));
    return node;
  }

  function tag(opts) {
    var attrs = {
      class: CLS.tag.root + (opts.type ? ' cds--tag--' + opts.type : '') + (opts.filter ? ' ' + CLS.tag.filter : ''),
      title: opts.title || null,
    };
    // The text goes inside `.cds--tag__label`. That span is where Carbon puts `white-space: nowrap`
    // and `text-overflow: ellipsis`, and the rule reaches the span and not the tag: a bare text node
    // in the tag is covered by neither, so a tag in a narrow column — the log's Kind column, whose
    // word is "keyframe" — broke between every pair of letters and stood two words tall.
    var node = core.el('span', attrs, [core.el('span', { class: CLS.tag.label, text: opts.text })]);
    if (opts.filter) {
      // Filter tags carry a dismiss control; other tags are static text (REQ-UI-010).
      node.appendChild(core.el('button', {
        type: 'button',
        class: 'cds--tag__close-icon',
        'aria-label': 'Remove filter ' + opts.text,
        'data-action': opts.action || 'remove-filter',
        'data-value': opts.value === undefined ? opts.text : String(opts.value),
      }, [icon('close')]));
    }
    return node;
  }

  /** A label + control pair, with the validation wiring §5 requires. */
  function labelled(labelText, control, opts) {
    var options = opts || {};
    var id = options.id || ('tmv-f-' + core.uuid().slice(0, 8));
    control.setAttribute('id', id);
    var children = [
      core.el('label', { class: CLS.field.label, for: id, text: labelText }),
    ];
    var wrapper = core.el('div', { class: 'cds--form-item' }, children);
    wrapper.appendChild(control);
    return { wrapper: wrapper, id: id, control: control };
  }

  function emptyState(opts) {
    return core.el('div', { class: 'tmv-empty' }, [
      core.el('h3', { class: 'tmv-empty__title', text: opts.title }),
      opts.body ? core.el('p', { class: 'tmv-empty__body', text: opts.body }) : null,
      opts.action ? button({ label: opts.action.label, kind: 'primary', action: opts.action.action }) : null,
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Layers: the one place overlays mount
  //
  // Modals, menus and dropdowns all go into `#tmv-layers` rather than into the content region, for
  // two reasons: a table re-render must not tear down an open dialog, and `19-boot.js` captures the
  // pristine DOM before anything renders (REQ-EXP-008), so keeping runtime furniture out of the
  // shell's own tree keeps the exported file's markup honest.
  // ---------------------------------------------------------------------------------------------

  var layerStack = [];

  function layerRoot() {
    var root = core.byId('tmv-layers');
    if (root) return root;
    var d = documentRef();
    if (!d || !d.body) return null;
    root = core.el('div', { id: 'tmv-layers' });
    d.body.appendChild(root);
    return root;
  }

  function documentRef() {
    return typeof document === 'undefined' ? null : document;
  }

  function lockScroll(lock) {
    var d = documentRef();
    if (!d || !d.body) return;
    core.setClass(d.body, 'tmv-scroll-locked', lock);
  }

  /**
   * Register an open layer.
   *
   * Only the topmost layer answers Escape: two modals stacked is a real state (a delete confirmation
   * over a compare view), and letting both react to a single Escape would close the pair.
   *
   * `blocking` separates the two kinds. A modal owns the scroll lock; an overflow menu does not — and
   * since a menu can be open over a modal, the lock is recomputed over the whole stack rather than
   * claimed by whichever layer happened to be first or last.
   */
  function pushLayer(layer, blocking) {
    layer.blocking = blocking === true;
    layerStack.push(layer);
    syncScrollLock();
  }

  function popLayer(layer) {
    var at = layerStack.indexOf(layer);
    if (at !== -1) layerStack.splice(at, 1);
    syncScrollLock();
  }

  function syncScrollLock() {
    for (var i = 0; i < layerStack.length; i++) {
      if (layerStack[i].blocking) { lockScroll(true); return; }
    }
    lockScroll(false);
  }

  function topLayer() {
    return layerStack.length ? layerStack[layerStack.length - 1] : null;
  }

  /** The element focus should return to when a layer closes (REQ-UI-007). */
  function activeElement() {
    var d = documentRef();
    return d && d.activeElement ? d.activeElement : null;
  }

  function restoreFocus(to) {
    if (to && to.focus) to.focus();
  }

  /**
   * Outside-click dismissal.
   *
   * `mousedown` rather than `click`, because a click that starts inside and ends outside is a drag,
   * not a dismissal — and `pointerdown` is not universal enough to rely on for the Safari path.
   */
  function onOutsideClick(node, handler) {
    var off = core.on(documentRef(), 'mousedown', function (event) {
      var target = event.target;
      var d = documentRef();
      while (target && target !== d) {
        if (target === node) return;
        target = target.parentNode;
      }
      handler(event);
    }, true);
    return off;
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Modal (§5: open/close, focus trap, focus restore, Escape, scroll lock, backdrop policy)
  // ---------------------------------------------------------------------------------------------

  /**
   * A Carbon modal.
   *
   * Options:
   *   title, body (nodes), actions ([{label, kind, action, disabled, value}]), size, danger,
   *   dismissible (Escape and backdrop), onClose(reason), initialFocus ('cancel' | 'first')
   *
   * Returns `{element, close, setBusy, setBody}`.
   *
   * Destructive modals ignore backdrop clicks — a mis-aimed click must not be how a delete is
   * confirmed. They still close on Escape, because a dialog that cannot be dismissed by keyboard is a
   * worse trap than a stray click is a hazard; and focus starts on **cancel**, so Enter on a
   * destructive dialog is safe (REQ-UI-007).
   */
  function modal(opts) {
    var options = opts || {};
    var d = documentRef();
    var previous = activeElement();
    var danger = options.danger === true;
    var dismissible = options.dismissible !== false;
    var closed = false;

    var titleId = 'tmv-modal-title-' + core.uuid().slice(0, 8);
    var heading = core.el('h2', { class: 'cds--modal-header__heading', id: titleId, text: options.title || '' });
    var header = core.el('div', { class: CLS.modal.header }, [heading]);

    var body = core.el('div', { class: CLS.modal.content }, options.body || []);
    var footer = core.el('div', { class: CLS.modal.footer });

    var actions = options.actions || [];
    var actionNodes = [];
    for (var i = 0; i < actions.length; i++) {
      var spec = actions[i];
      var node = button({
        label: spec.label,
        kind: spec.kind || 'tertiary',
        action: spec.action,
        name: spec.name,
        disabled: spec.disabled,
        value: spec.value,
        title: spec.title,
      });
      actionNodes.push(node);
      footer.appendChild(node);
    }

    var container = core.el('div', {
      class: CLS.modal.container + (options.size ? ' cds--modal-container--' + options.size : '') + (danger ? ' ' + CLS.modal.danger : ''),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    }, [header, body, footer]);

    // `CLS.modal` is the group of class names, not one of them, so the root's own class is
    // `CLS.modal.root`. Concatenating the group produced "…[object Object] is-visible", which left
    // every modal in the application without `cds--modal` — unstyled, and with the backdrop rules
    // keyed off a class that was not there.
    var root = core.el('div', {
      class: CLS.modal.root + ' ' + CLS.modal.visible + (danger ? ' ' + CLS.modal.danger : ''),
    }, [container]);

    function close(reason) {
      if (closed) return;
      closed = true;
      offEscape();
      offBackdrop();
      popLayer(layer);
      core.setClass(root, CLS.modal.visible, false);
      if (root.parentNode) root.parentNode.removeChild(root);
      // Focus goes back where it came from, not to the document. A user who opened this from a row
      // action returns to that row (REQ-UI-007).
      restoreFocus(previous);
      if (options.onClose) options.onClose(reason || 'dismiss');
    }

    var offEscape = core.on(d, 'keydown', function (event) {
      if (closed || topLayer() !== layer) return;
      // A layer *above* this one (an overflow menu opened from inside the dialog) may already have
      // consumed this Escape. It is gone from the stack by now, so `topLayer()` says this dialog is
      // on top and the stack check above passes — and one Escape would close the pair, which is the
      // exact failure `pushLayer`'s comment says the stack exists to prevent. `defaultPrevented` is
      // the record that the key was answered once already.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (!dismissible) return;
        event.preventDefault();
        close('escape');
        return;
      }
      if (event.key !== 'Tab') return;
      var list = focusables(container);
      if (!list.length) {
        event.preventDefault();
        return;
      }
      var next = tabTarget(list, activeElement(), event.shiftKey);
      if (next === -1) return;
      event.preventDefault();
      list[next].focus();
    });

    var offBackdrop = core.on(root, 'mousedown', function (event) {
      // Only a press that started on the backdrop itself, and only when the modal is not
      // destructive. A press inside the container that *ended* on the backdrop never reaches this.
      if (event.target !== root) return;
      if (danger || !dismissible) return;
      close('backdrop');
    });

    var layer = { root: root, close: close };

    // Initial focus. Destructive modals put it on cancel (the first action whose kind is not danger
    // and which is not the primary); everything else on the first focusable in the container.
    var target = null;
    if (options.initialFocus === 'cancel' || danger) {
      for (var a = 0; a < actionNodes.length; a++) {
        if (actions[a].kind !== 'danger') { target = actionNodes[a]; break; }
      }
    }
    if (!target) {
      var found = focusables(container);
      target = found.length ? found[0] : container;
    }

    return {
      element: root,
      container: container,
      body: body,
      close: close,
      setBody: function (children) { core.replace(body, children); },
      setBusy: function (busy) {
        for (var k = 0; k < actionNodes.length; k++) {
          if (busy) actionNodes[k].setAttribute('disabled', '');
          else if (!actions[k].disabled) actionNodes[k].removeAttribute('disabled');
        }
        core.setAttr(root, 'aria-busy', busy ? 'true' : null);
      },
      open: function () {
        var mount = layerRoot();
        if (!mount) return null;
        mount.appendChild(root);
        pushLayer(layer, true);
        if (target && target.focus) target.focus();
        return root;
      },
    };
  }

  /** A confirmation modal, which is the shape almost every destructive action in the app takes. */
  function confirm(opts) {
    var options = opts || {};
    return modal({
      title: options.title,
      size: 'sm',
      danger: options.danger === true,
      body: [core.el('p', { text: options.body })].concat(options.details || []),
      actions: [
        { label: options.cancelLabel || 'Cancel', kind: 'tertiary', action: 'cancel' },
        {
          label: options.confirmLabel || 'Continue',
          kind: options.danger ? 'danger' : 'primary',
          action: 'confirm',
          name: 'confirm',
        },
      ],
      onClose: options.onClose,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Popup: the shared machinery behind the overflow menu and the dropdown
  //
  // Both are "a trigger and a list, positioned near it", and §5 asks the same things of both:
  // open/close, outside-click dismiss, Escape, focus trap, arrow keys, `aria-expanded`. Writing that
  // twice would be writing the same six obligations twice, and the second copy is where the
  // forgotten `aria-expanded` lives.
  // ---------------------------------------------------------------------------------------------

  function popup(opts) {
    var trigger = opts.trigger;
    // The menu element is built by the caller, because what goes *in* it is the widget's own shape
    // (menu items vs. listbox options) and building it here would mean this function knowing both.
    var menu = opts.menu || core.el('div', { class: opts.menuClass, role: opts.role, id: opts.id || ('tmv-pop-' + core.uuid().slice(0, 8)) });
    if (!menu.getAttribute('role')) menu.setAttribute('role', opts.role);
    var open = false;
    var offs = [];

    function items() {
      return menu.querySelectorAll('[role="' + opts.itemRole + '"]');
    }

    function itemList() {
      var found = items();
      var out = [];
      for (var i = 0; i < found.length; i++) out.push(found[i]);
      return out;
    }

    function highlight(index) {
      var list = itemList();
      if (!list.length) return;
      var at = index < 0 ? 0 : index >= list.length ? list.length - 1 : index;
      for (var i = 0; i < list.length; i++) {
        core.setClass(list[i], opts.highlightClass, i === at);
      }
      // `aria-activedescendant` is what reports the highlight, and `aria-selected` is deliberately
      // *not* written here. They are different facts: the active descendant is where the keyboard is,
      // the selection is the value the widget holds. Writing both made the highlighted row claim to be
      // the chosen one — wrong on a listbox, whose selection the dropdown sets when it builds its
      // options, and invalid on the overflow menu, whose items are `menuitem` and may not carry
      // `aria-selected` at all (REQ-UI-007).
      core.setAttr(menu, 'aria-activedescendant', list[at].id || null);
      if (list[at].scrollIntoView) list[at].scrollIntoView({ block: 'nearest' });
    }

    function highlightedIndex() {
      var list = itemList();
      for (var i = 0; i < list.length; i++) {
        if (list[i].getAttribute('class') && list[i].getAttribute('class').indexOf(opts.highlightClass) !== -1) return i;
      }
      return -1;
    }

    function close(reason) {
      if (!open) return;
      open = false;
      for (var i = 0; i < offs.length; i++) offs[i]();
      offs = [];
      core.setClass(menu, opts.openClass, false);
      core.setHidden(menu, true);
      core.setAttr(trigger, 'aria-expanded', 'false');
      popLayer(layer);
      if (reason !== 'select') restoreFocus(trigger);
      if (opts.onClose) opts.onClose(reason || 'dismiss');
    }

    function openMenu(reason) {
      if (open) return;
      open = true;
      // Mounted beside the trigger, not into `#tmv-layers`. Carbon positions
      // `.cds--overflow-menu-options` and `.cds--list-box__menu` against their own component's
      // container, so lifting the menu out to a global layer would place it at the top-left of the
      // viewport — the layer root is the fallback for a trigger that is not in the document yet.
      var mount = (trigger && trigger.parentNode) || layerRoot();
      if (!mount) return;
      mount.appendChild(menu);
      core.setHidden(menu, false);
      core.setClass(menu, opts.openClass, true);
      core.setAttr(trigger, 'aria-expanded', 'true');
      pushLayer(layer, false);
      offs.push(onOutsideClick(menu, function () { close('outside'); }));
      offs.push(core.on(menu, 'click', function (event) {
        var node = core.closestAction(event.target, menu);
        if (!node || node.getAttribute('data-action') === 'noop') return;
        if (opts.onSelect) opts.onSelect(node, event);
        if (opts.closeOnSelect !== false) close('select');
      }));
      offs.push(core.on(menu, 'keydown', function (event) {
        var list = itemList();
        if (event.key === 'Escape') { event.preventDefault(); close('escape'); return; }
        if (event.key === 'Enter' || event.key === ' ') {
          var current = itemList()[highlightedIndex()];
          if (current) { event.preventDefault(); current.click(); }
          return;
        }
        if (event.key === 'Tab') {
          // Carbon's overflow menu keeps Tab inside the menu while it is open; leaving on Tab would
          // put focus behind an overlay the user can still see.
          event.preventDefault();
          var order = itemList();
          var next = tabTarget(order, activeElement(), event.shiftKey);
          if (next !== -1) order[next].focus();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          highlight(stepHighlight(list.length, highlightedIndex(), event.key));
          var target = itemList()[highlightedIndex()];
          if (target && target.focus) target.focus();
        }
      }));
      offs.push(core.on(trigger, 'keydown', function (event) {
        // The trigger itself answers the keys that act on the menu it just opened, which is why this
        // is attached on open and removed on close: it must not fire while the menu is closed, where
        // these keys belong to the page.
        //
        // Escape matters most. Opening a menu leaves focus on the trigger — the menu is an
        // `aria-activedescendant` listbox, not a focus container, and `highlight` moves the
        // *selection* without moving focus — so without this branch the ordinary gesture "open the
        // menu, press Escape" did nothing at all, and the menu stayed open until the user clicked
        // somewhere else (REQ-UI-007, `07-ui.md` §5's Overflow menu row).
        if (event.key === 'Escape') { event.preventDefault(); close('escape'); return; }
        if (event.key === 'ArrowDown') { event.preventDefault(); highlight(0); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(itemList().length - 1); }
      }));
      if (opts.onOpen) opts.onOpen(reason || 'open');
      highlight(0);
    }

    function toggle() {
      if (open) close('toggle');
      else openMenu('toggle');
    }

    var layer = {
      root: menu,
      close: close,
      toggle: toggle,
      open: openMenu,
      isOpen: function () { return open; },
      highlight: highlight,
      highlightedIndex: highlightedIndex,
      items: itemList,
      element: menu,
    };

    core.setAttr(trigger, 'aria-expanded', 'false');
    core.setAttr(trigger, 'aria-controls', menu.id);
    core.on(trigger, 'click', function (event) { event.preventDefault(); toggle(); });
    return layer;
  }

  /**
   * The header's overflow menu (`07-ui.md` §4).
   *
   * `entries` is `[{label, action, value, type, disabled, separator, danger}]`. A separator is a
   * presentational divider and is not focusable — it is rendered as a non-item so the arrow keys
   * skip it rather than landing on a rule.
   */
  function overflowMenu(opts) {
    var options = opts || {};
    var trigger = options.trigger;
    var menu = core.el('div', {
      class: CLS.menu.root,
      role: 'menu',
      id: options.id || 'tmv-menu-list',
      hidden: true,
      'aria-labelledby': trigger && trigger.id ? trigger.id : null,
    });

    var entries = options.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.separator) {
        menu.appendChild(core.el('li', { class: 'cds--overflow-menu-options__option--separator', role: 'separator' }));
        continue;
      }
      if (entry.heading) {
        menu.appendChild(core.el('li', { class: 'tmv-menu__heading', role: 'presentation', text: entry.heading }));
        continue;
      }
      var attrs = {
        class: CLS.menu.option + (entry.danger ? ' cds--overflow-menu-options__option--danger' : ''),
        role: 'menuitem',
        tabindex: '-1',
        id: 'tmv-menu-item-' + i,
        'data-action': entry.disabled ? 'noop' : (entry.action || 'menu'),
      };
      if (entry.value !== undefined) attrs['data-value'] = String(entry.value);
      if (entry.disabled) attrs['aria-disabled'] = 'true';
      var row = core.el('li', attrs, [
        entry.icon ? icon(entry.icon) : null,
        core.el('span', { class: 'cds--overflow-menu-options__option-content', text: entry.label }),
        entry.current ? icon('check', 'tmv-menu__check') : null,
      ]);
      menu.appendChild(row);
    }

    var layer = popup({
      trigger: trigger,
      menu: menu,
      menuClass: CLS.menu.root,
      openClass: CLS.menu.open,
      itemRole: 'menuitem',
      highlightClass: 'cds--overflow-menu-options__option--highlighted',
      role: 'menu',
      onSelect: function (node, event) {
        if (options.onSelect) options.onSelect(node, event);
      },
      onClose: options.onClose,
    });
    layer.element = menu;
    return layer;
  }

  /**
   * A listbox dropdown (§5: open/close, typeahead, keyboard selection, highlighted index,
   * `aria-activedescendant`).
   *
   * `options` is `[{value, label, disabled, note}]`, values passed back as strings. Selection is
   * reported through `onSelect(value)`, and the caller owns the state — this widget renders what it
   * is told to, so a view that stores the choice in the model does not have two copies of it.
   */
  function dropdown(opts) {
    var options = opts || {};
    var items = options.options || [];
    var selected = options.selected === undefined ? null : options.selected;
    var trigger = options.trigger || core.el('div', {
      class: CLS.dropdown.field,
      role: 'combobox',
      tabindex: '0',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });

    function labelFor(value) {
      for (var i = 0; i < items.length; i++) {
        if (String(items[i].value) === String(value)) return items[i].label;
      }
      return '';
    }

    var labelNode = core.el('span', { class: 'cds--list-box__label', text: labelFor(selected) || options.placeholder || 'Choose an option' });
    if (options.trigger) {
      // A caller-supplied trigger (a form field, say) supplies its own label node.
      var existing = trigger.querySelector ? trigger.querySelector('.cds--list-box__label') : null;
      if (existing) labelNode = existing;
      else trigger.appendChild(labelNode);
    } else {
      trigger.appendChild(labelNode);
      trigger.appendChild(core.el('span', { class: 'cds--list-box__menu-icon' }, [icon('chevron-down')]));
    }

    var list = core.el('ul', {
      class: CLS.dropdown.menu,
      role: 'listbox',
      id: options.id || ('tmv-list-' + core.uuid().slice(0, 8)),
      hidden: true,
      tabindex: '-1',
    });
    if (options.label) list.setAttribute('aria-label', options.label);

    var buffer = null;
    var nodeById = {};

    function renderItems() {
      core.clear(list);
      nodeById = {};
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var id = list.id + '-opt-' + i;
        nodeById[id] = item;
        var isSelected = String(item.value) === String(selected);
        var li = core.el('li', {
          class: CLS.dropdown.item + (isSelected ? ' ' + CLS.dropdown.selected : '') + (item.disabled ? ' cds--list-box__menu-item--disabled' : ''),
          role: 'option',
          id: id,
          tabindex: '-1',
          'data-action': item.disabled ? 'noop' : 'pick',
          'data-value': String(item.value),
          'aria-selected': isSelected ? 'true' : 'false',
          'aria-disabled': item.disabled ? 'true' : null,
          title: item.note || null,
        }, [
          core.el('span', { class: 'cds--list-box__menu-item__option', text: item.label }),
          isSelected ? icon('check') : null,
        ]);
        list.appendChild(li);
      }
      core.setAttr(trigger, 'aria-controls', list.id);
    }

    function setSelected(value) {
      selected = value;
      labelNode.textContent = labelFor(value) || options.placeholder || 'Choose an option';
      renderItems();
      core.setAttr(trigger, 'aria-label', (options.label ? options.label + ': ' : '') + labelNode.textContent);
    }

    function commit(value) {
      setSelected(value);
      if (options.onSelect) options.onSelect(value);
    }

    var layer = popup({
      trigger: trigger,
      menu: list,
      menuClass: CLS.dropdown.menu,
      openClass: CLS.dropdown.open,
      itemRole: 'option',
      highlightClass: CLS.dropdown.highlighted,
      role: 'listbox',
      onOpen: function () {
        // Open on the current selection, not on the first item: a user reopening a 60-entry
        // dropdown should be where they left off.
        var list_ = layer.items();
        var at = -1;
        for (var i = 0; i < list_.length; i++) {
          if (String(nodeById[list_[i].id] && nodeById[list_[i].id].value) === String(selected)) { at = i; break; }
        }
        layer.highlight(at);
      },
      onSelect: function (node) {
        var item = nodeById[node.id];
        if (!item || item.disabled) return;
        commit(String(item.value));
      },
    });

    // Typeahead. The buffer is deliberately owned here rather than by the popup, because it is a
    // listbox behaviour and not a menu one — a menu of four actions does not answer to letters.
    core.on(trigger, 'keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        if (!layer.isOpen()) { event.preventDefault(); layer.open('keyboard'); }
        return;
      }
      if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        buffer = typeaheadBuffer(buffer, event.key, Date.now());
        var labels = [];
        for (var i = 0; i < items.length; i++) labels.push(items[i].label);
        var at = typeahead(labels, buffer.text, buffer.text.length === 1 ? -1 : layer.highlightedIndex());
        if (at !== -1) {
          if (!layer.isOpen()) layer.open('typeahead');
          layer.highlight(at);
        }
      }
    });

    renderItems();
    setSelected(selected);

    return {
      // The trigger is the element a caller mounts, whether this widget built it or was handed one.
      // Returning null in the built-it case would make the only way to use the widget be `.trigger`,
      // which is the kind of asymmetry that turns into a bug the first time two callers disagree
      // about which field to read.
      element: trigger,
      trigger: trigger,
      menu: list,
      close: layer.close,
      open: layer.open,
      isOpen: layer.isOpen,
      value: function () { return selected; },
      setValue: setSelected,
      setOptions: function (next) {
        items = next || [];
        renderItems();
        setSelected(selected);
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Data table (§5: sort, selection, select-all with indeterminate, batch bar, expandable rows,
  //    sticky header)
  // ---------------------------------------------------------------------------------------------

  /**
   * A Carbon data table.
   *
   * Options:
   *   columns   [{key, label, sortable, numeric, className, render(row, index), sortValue(row)}]
   *   rows      the rows themselves; the table never mutates them
   *   rowKey(row) -> stable id, required when selectable
   *   sort      {key, direction} initial sort, or omit for source order
   *   selectable, batchActions, expandable, expand(row), onSelectionChange, stickyHeader, caption,
   *   empty     {title, body, action}
   *   page      {page, pageSize} — when present the table renders one window and a pager
   *
   * Returns `{element, setRows, setSort, getSort, getSelection, clearSelection, focusRow}`.
   *
   * Rows are rendered to `<tr>` with a `data-label` on every cell, so the `sm` breakpoint can restyle
   * the same markup as stacked cards (REQ-UI-006 AC2) with no second render path — the alternative,
   * rendering two trees and hiding one, doubles the work for a 5,000-row model.
   *
   * Column widths are a `className`, not a pixel count, and that is a CSP decision rather than a
   * stylistic one: `style-src` is hash-pinned without `'unsafe-inline'` (`02-architecture.md` §5),
   * so a `style` attribute would be refused by the browser. Anything that needs a per-instance
   * dimension belongs in `src/styles/00-app.css` behind a class.
   */
  function dataTable(opts) {
    var options = opts || {};
    var columns = options.columns || [];
    var rows = options.rows || [];
    var selection = {};
    var sort = options.sort ? { key: options.sort.key, direction: options.sort.direction || 'ascending' } : null;
    var page = options.page || null;
    var expanded = {};

    var tbody = core.el('tbody');
    var table = core.el('table', { class: CLS.table.root + (options.stickyHeader === false ? '' : ' ' + CLS.table.sticky) });
    if (options.caption) table.appendChild(core.el('caption', { class: 'cds--visually-hidden', text: options.caption }));
    var thead = core.el('thead');
    table.appendChild(thead);
    table.appendChild(tbody);

    var batchBar = options.selectable && options.batchActions ? core.el('div', { class: CLS.table.batch }) : null;
    var grouped = groupToolbar(options.toolbar || []);
    var toolbar = core.el('div', { class: 'cds--table-toolbar' }, grouped.rest);
    // One id per table instance, not a constant: History and Threats can both be on screen after a
    // tab switch that has not yet torn the previous view down, and two elements sharing an id would
    // make the select-all box operate on whichever the document found first.
    var selectAllId = 'tmv-select-all-' + core.uuid().slice(0, 8);
    if (options.selectable) toolbar.appendChild(selectAllBox());
    if (batchBar) toolbar.appendChild(batchBar);
    if (grouped.filters) toolbar.appendChild(grouped.filters);

    // The table sits in its own element so that the one width band where it cannot fit its block —
    // roughly 672 to 832px, where there is not yet room for nine columns and not yet the stacked
    // presentation — can scroll the table alone. Making `.tmv-table` itself the scroller would take
    // the toolbar and the pagination into the scrollport with it, and a search box that slides out of
    // view when the reader scrolls the table sideways is worse than the overflow it was fixing.
    var scroll = core.el('div', { class: 'tmv-table__scroll' }, [table]);
    var root = core.el('div', { class: 'tmv-table' }, [toolbar, scroll]);

    // -- header ---------------------------------------------------------------------------------

    /**
     * The caller builds the toolbar as one flat list: search box, filter dropdowns, buttons. A flat
     * list is what a wrapping flex row lays out badly — with four filters and two buttons the first
     * line comes out as the search box, both buttons and three of the four filters, and the fourth
     * filter shares the second line with the select-all box. That is a row nobody designed, and its
     * shape changes with the number of filters a view happens to declare. Grouping the dropdowns
     * into one element makes them wrap as a unit, which gives the toolbar two rows that mean
     * something: the controls, then the filters.
     *
     * The group is placed after the select-all box rather than where the caller had the dropdowns,
     * so that the order the controls are read in and the order they are tabbed through stay the
     * same. Reordering them back into place with `order` would lay the filters out last while
     * leaving focus to reach them second, and a focus ring that jumps to the bottom row and then
     * back up is worse than a toolbar whose second row is a row of dropdowns.
     */
    function groupToolbar(nodes) {
      var filters = [];
      var rest = [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].classList && nodes[i].classList.contains('cds--form-item')) filters.push(nodes[i]);
        else rest.push(nodes[i]);
      }
      return {
        rest: rest,
        filters: filters.length ? core.el('div', { class: 'tmv-toolbar__filters' }, filters) : null,
      };
    }

    function selectAllBox() {
      var box = core.el('input', { type: 'checkbox', class: CLS.checkbox, id: selectAllId, 'data-action': 'select-all' });
      // The text goes in a `.cds--checkbox-label-text` span. Carbon draws the box itself as the
      // label's `:before` and reserves 1.25rem of inline padding for it, which is enough to clear the
      // box and no more — the space between the box and the word comes from a rule Carbon writes for
      // that span alone, so a bare text node renders as a box the label is jammed against.
      var label = core.el('label', { class: 'cds--checkbox-label', for: selectAllId }, [
        core.el('span', { class: 'cds--checkbox-label-text', text: options.selectAllLabel || 'Select all' }),
      ]);
      return core.el('div', { class: 'cds--table-toolbar__select' }, [box, label]);
    }

    function sortIndicator(column) {
      if (!sort || sort.key !== column.key) return icon('sort', 'tmv-sort--none');
      return icon('sort', sort.direction === 'ascending' ? 'tmv-sort--asc' : 'tmv-sort--desc');
    }

    function renderHead() {
      core.clear(thead);
      var tr = core.el('tr');
      if (options.expandable) tr.appendChild(core.el('th', { class: 'tmv-th--expand', scope: 'col' }, [core.el('span', { class: 'cds--visually-hidden', text: 'Expand' })]));
      if (options.selectable) tr.appendChild(core.el('th', { class: 'tmv-th--select', scope: 'col' }, []));
      for (var i = 0; i < columns.length; i++) {
        var column = columns[i];
        var active = sort && sort.key === column.key;
        var attrs = {
          scope: 'col',
          class: (column.numeric ? 'tmv-td--numeric ' : '') + (column.className || '') +
            (column.sortable && active ? ' ' + (sort.direction === 'ascending' ? CLS.table.asc : CLS.table.desc) : ''),
        };
        var content;
        if (column.sortable) {
          attrs['data-action'] = 'sort';
          attrs['data-key'] = column.key;
          attrs['aria-sort'] = active ? sort.direction : 'none';
          attrs.tabindex = '0';
          content = [
            core.el('span', { class: 'cds--table-sort__content', text: column.label }),
            core.el('span', { class: 'cds--table-sort__icon' }, [
              core.el('span', { class: 'cds--visually-hidden', text: sortLabel(column, active) }),
              sortIndicator(column),
            ]),
          ];
        } else {
          content = [core.text(column.label)];
        }
        tr.appendChild(core.el('th', attrs, content));
      }
      thead.appendChild(tr);
    }

    function sortLabel(column, active) {
      if (!active) return 'Sort by ' + column.label;
      return 'Sorted ' + (sort.direction === 'ascending' ? 'ascending' : 'descending') + ' by ' + column.label + '; activate to reverse';
    }

    // -- body -----------------------------------------------------------------------------------

    function rowsInOrder() {
      if (!sort) return rows;
      var column = columnByKey(sort.key);
      if (!column) return rows;
      // `core.has`, not `column.sortValue || …`. Every plain object inherits `Object.prototype`'s
      // members, so an inherited name is *always* truthy and the fallback never runs — which is how
      // a column option called `valueOf` or `toString` would break sorting with a TypeError in the
      // comparator rather than being ignored. The name is `sortValue` for the same reason.
      var sortValue = core.has(column, 'sortValue')
        ? column.sortValue
        : function (row) { return row[column.key]; };
      return sortRows(rows, sortValue, sort.direction);
    }

    function columnByKey(key) {
      for (var i = 0; i < columns.length; i++) if (columns[i].key === key) return columns[i];
      return null;
    }

    function rowId(row) {
      if (options.rowKey) return String(options.rowKey(row));
      return String(rows.indexOf(row));
    }

    function renderBody() {
      core.clear(tbody);
      var ordered = rowsInOrder();
      var window = page ? pageWindow(ordered.length, page.page, page.pageSize) : null;
      if (window) page.window = window;
      var visible = window ? pageSlice(ordered, window) : ordered;
      // The cell renderer's `index` is the row's position in the *sorted* list, not in the page, so
      // a row number column does not restart at 1 on every page.
      var firstIndex = window ? window.from - 1 : 0;

      if (!visible.length) {
        var span = 1 + (options.selectable ? 1 : 0) + (options.expandable ? 1 : 0) + columns.length;
        tbody.appendChild(core.el('tr', {}, [
          core.el('td', { colSpan: String(span), class: 'tmv-table__empty' },
            [emptyState(options.empty || { title: 'Nothing to show' })]),
        ]));
        renderBatch();
        return;
      }

      for (var i = 0; i < visible.length; i++) {
        var row = visible[i];
        var id = rowId(row);
        var isSelected = selection[id] === true;
        var tr = core.el('tr', {
          class: (isSelected ? CLS.table.rowSelected : '') + (expanded[id] ? ' ' + CLS.table.expandable : ''),
          'data-row': id,
        });
        if (options.expandable) {
          tr.appendChild(core.el('td', { class: 'tmv-td--expand' }, [core.el('button', {
            type: 'button',
            class: 'cds--table-expand__button',
            'data-action': 'expand',
            'data-row': id,
            'aria-expanded': expanded[id] ? 'true' : 'false',
            'aria-label': (expanded[id] ? 'Collapse' : 'Expand') + ' row ' + (i + 1),
          }, [icon('chevron-right')])]));
        }
        if (options.selectable) {
          var boxId = 'tmv-sel-' + id;
          tr.appendChild(core.el('td', { class: 'tmv-td--select' }, [
            core.el('input', {
              type: 'checkbox',
              class: CLS.checkbox,
              id: boxId,
              'data-action': 'select-row',
              'data-row': id,
              checked: isSelected ? true : null,
            }),
            core.el('label', { class: 'cds--checkbox-label', for: boxId }, [
              core.el('span', { class: 'cds--visually-hidden', text: 'Select row ' + (i + 1) }),
            ]),
          ]));
        }
        for (var c = 0; c < columns.length; c++) {
          var column = columns[c];
          var cell = core.el('td', {
            class: (column.numeric ? 'tmv-td--numeric ' : '') + (column.className || ''),
            // The label is what the `sm` card layout shows in place of the column header.
            'data-label': column.label,
          });
          core.append(cell, cellContent(column, row, firstIndex + i));
          tr.appendChild(cell);
        }
        tbody.appendChild(tr);

        if (options.expandable && expanded[id] && options.expand) {
          var detail = core.el('td', { colSpan: String(1 + (options.selectable ? 1 : 0) + columns.length), class: 'tmv-row-detail' });
          core.append(detail, options.expand(row));
          tbody.appendChild(core.el('tr', { class: 'cds--expandable-row' }, [detail]));
        }
      }
      renderBatch();
    }

    function cellContent(column, row, index) {
      if (column.render) {
        var rendered = column.render(row, index);
        return rendered === null || rendered === undefined ? '' : rendered;
      }
      var value = row[column.key];
      if (value === null || value === undefined || value === '') return '';
      if (core.isBoolean(value)) return value ? 'Yes' : 'No';
      return String(value);
    }

    // -- selection ------------------------------------------------------------------------------

    function selectedIds() {
      return Object.keys(selection).filter(function (id) { return selection[id] === true; });
    }

    function renderBatch() {
      if (!batchBar) return;
      core.clear(batchBar);
      var count = selectedIds().length;
      core.setClass(batchBar, CLS.table.batchOn, count > 0);
      core.setHidden(batchBar, count === 0);
      if (count === 0) return;
      batchBar.appendChild(core.el('div', { class: 'cds--batch-summary' }, [
        core.el('p', { class: 'cds--batch-summary__para', text: core.plural(count, 'item') + ' selected' }),
      ]));
      var list = options.batchActions || [];
      for (var i = 0; i < list.length; i++) {
        batchBar.appendChild(button({
          label: list[i].label,
          kind: list[i].kind || 'ghost',
          action: list[i].action,
          name: list[i].name,
        }));
      }
      batchBar.appendChild(button({ label: 'Cancel', kind: 'ghost', action: 'clear-selection' }));
    }

    function syncSelectAll() {
      var box = root.querySelector('#' + selectAllId);
      if (!box) return;
      var state = selectAllState(selectedIds().length, rows.length);
      // `indeterminate` is a property, not an attribute — §5 calls it out because it is the half of
      // select-all that has no markup form and is therefore the half that gets missed.
      if ('indeterminate' in box) box.indeterminate = state === 'some';
      if (box.checked !== (state === 'all')) box.checked = state === 'all';
      core.setAttr(box, 'aria-checked', state === 'some' ? 'mixed' : null);
    }

    function reportSelection() {
      syncSelectAll();
      if (options.onSelectionChange) options.onSelectionChange(selectedIds());
    }

    // -- events ---------------------------------------------------------------------------------

    core.delegate(root, 'click', function (event, node) {
      var action = node.getAttribute('data-action');
      if (action === 'sort') {
        var key = node.getAttribute('data-key');
        var direction = sort && sort.key === key && sort.direction === 'ascending' ? 'descending' : 'ascending';
        setSort(key, direction);
      } else if (action === 'expand') {
        var id = node.getAttribute('data-row');
        expanded[id] = !expanded[id];
        renderBody();
      } else if (action === 'clear-selection') {
        clearSelection();
      }
    });

    core.on(root, 'change', function (event) {
      var node = event.target;
      if (!node || !node.getAttribute) return;
      var action = node.getAttribute('data-action');
      if (action === 'select-all') {
        var on = node.checked === true;
        selection = {};
        if (on) for (var i = 0; i < rows.length; i++) selection[rowId(rows[i])] = true;
        renderBody();
        reportSelection();
      } else if (action === 'select-row') {
        var id = node.getAttribute('data-row');
        if (node.checked) selection[id] = true;
        else delete selection[id];
        var row = node.parentNode && node.parentNode.parentNode;
        if (row) core.setClass(row, CLS.table.rowSelected, node.checked === true);
        renderBatch();
        reportSelection();
      }
    });

    // The sort control is a `th` with a tabindex, so it needs keyboard activation as well as a
    // click — a sortable header that only answers the mouse is the accessibility gap §8 names.
    core.on(root, 'keydown', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node) return;
      if (node.getAttribute('data-action') !== 'sort') return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      node.click();
    });

    function setSort(key, direction) {
      sort = { key: key, direction: direction || 'ascending' };
      renderHead();
      renderBody();
    }

    renderHead();
    renderBody();

    return {
      element: root,
      table: table,
      body: tbody,
      setRows: function (next) {
        rows = next || [];
        // A selection that outlives its rows would report ids for entities the table no longer
        // shows, so it is dropped rather than carried.
        var live = {};
        for (var i = 0; i < rows.length; i++) {
          var id = rowId(rows[i]);
          if (selection[id]) live[id] = true;
        }
        selection = live;
        renderBody();
        syncSelectAll();
      },
      setSort: setSort,
      getSort: function () { return sort ? { key: sort.key, direction: sort.direction } : null; },
      getSelection: selectedIds,
      clearSelection: function () {
        selection = {};
        renderBody();
        reportSelection();
      },
      getWindow: function () { return page ? page.window : null; },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Disclosure: accordion and tree
  // ---------------------------------------------------------------------------------------------

  function accordion(opts) {
    var options = opts || {};
    var root = core.el('div', { class: CLS.accordion.root });
    var items = options.items || [];
    var open = {};

    // `single` is Carbon's "one at a time" variant; without it every item opens independently.
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = 'tmv-acc-' + i;
      var heading = core.el('button', {
        type: 'button',
        class: CLS.accordion.heading,
        'data-action': 'toggle-accordion',
        'data-value': id,
        'aria-expanded': 'false',
        'aria-controls': id + '-content',
        id: id,
      }, [icon('chevron-right', 'cds--accordion__arrow'), core.el('span', { class: 'cds--accordion__title', text: item.title })]);
      var content = core.el('div', { class: CLS.accordion.content, id: id + '-content', hidden: true }, item.content || []);
      root.appendChild(core.el('div', { class: CLS.accordion.item, 'data-item': id }, [heading, content]));
    }

    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node) return;
      var id = node.getAttribute('data-value');
      var content = root.querySelector('#' + id + '-content');
      var item = root.querySelector('[data-item="' + id + '"]');
      if (!content || !item) return;
      var next = !open[id];
      if (next && options.single) {
        var keys = Object.keys(open);
        for (var k = 0; k < keys.length; k++) {
          open[keys[k]] = false;
          var other = root.querySelector('[data-value="' + keys[k] + '"]');
          var otherContent = root.querySelector('#' + keys[k] + '-content');
          if (other) other.setAttribute('aria-expanded', 'false');
          if (otherContent) core.setHidden(otherContent, true);
        }
      }
      open[id] = next;
      node.setAttribute('aria-expanded', next ? 'true' : 'false');
      core.setHidden(content, !next);
      core.setClass(item, CLS.accordion.open, next);
    });

    return root;
  }

  /**
   * A tree view (REQ-UI-010: expand/collapse, keyboard navigation, `aria-expanded`/`aria-selected`).
   *
   * `nodes` is `[{id, label, children, meta}]`. Only visible nodes are in the tab order, and the
   * roving `tabindex` moves with the highlighted node — the same pattern the tab strip uses.
   */
  function tree(opts) {
    var options = opts || {};
    var nodes = options.nodes || [];
    var open = options.expanded || {};
    var root = core.el('ul', { class: CLS.tree.root, role: 'tree', 'aria-label': options.label || null });
    var selected = null;

    function render() {
      core.replace(root, nodes.map(nodeOf));
    }

    /**
     * Find a node's `<li>` by its id, without putting the id in a selector.
     *
     * `querySelector('[data-node="' + id + '"]')` looks harmless and is not: a node id can come from
     * an imported document (`03-data-model.md` lets an entity keep the id its source format gave it),
     * and a quote in that id makes the selector a syntax error that throws — on a keystroke, in a
     * keydown handler, which is the worst place for it. Iterating has no such input.
     */
    function findNode(id) {
      if (!root.querySelectorAll) return null;
      var found = root.querySelectorAll('[data-node]');
      for (var i = 0; i < found.length; i++) {
        if (String(found[i].getAttribute('data-node')) === String(id)) return found[i];
      }
      return null;
    }

    function nodeOf(node) {
      var isOpen = open[node.id] === true;
      var children = node.children || [];
      var li = core.el('li', {
        class: CLS.tree.node,
        role: 'treeitem',
        'data-node': String(node.id),
        'aria-expanded': children.length ? (isOpen ? 'true' : 'false') : null,
        'aria-selected': String(selected) === String(node.id) ? 'true' : 'false',
        'aria-level': '1',
      });
      var label = core.el('div', { class: 'cds--tree-node__label', tabindex: '-1', 'data-action': 'tree-node', 'data-node': String(node.id) }, [
        children.length ? core.el('span', {
          class: 'cds--tree-node__icon',
          'data-action': 'tree-toggle',
          'data-node': String(node.id),
          'aria-label': (isOpen ? 'Collapse ' : 'Expand ') + node.label,
        }, [icon(isOpen ? 'chevron-down' : 'chevron-right')]) : core.el('span', { class: 'cds--tree-node__icon' }),
        core.el('span', { class: 'cds--tree-node__label-text', text: node.label }),
        node.meta ? core.el('span', { class: 'cds--tree-node__meta', text: node.meta }) : null,
      ]);
      li.appendChild(label);
      if (children.length && isOpen) {
        var group = core.el('ul', { class: CLS.tree.children, role: 'group' });
        for (var i = 0; i < children.length; i++) group.appendChild(nodeOf(children[i]));
        li.appendChild(group);
      }
      return li;
    }

    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node) return;
      var id = node.getAttribute('data-node');
      if (node.getAttribute('data-action') === 'tree-toggle') {
        open[id] = !open[id];
        render();
        return;
      }
      selected = id;
      render();
      if (options.onSelect) options.onSelect(id);
    });

    /**
     * Keyboard navigation.
     *
     * Up/Down move between visible nodes, Right expands (or enters), Left collapses (or leaves to
     * the parent), Home/End jump. The visible-node list is recomputed from the DOM on each key,
     * because it changes with every expand.
     */
    core.on(root, 'keydown', function (event) {
      var visible = root.querySelectorAll('[data-action="tree-node"]');
      if (!visible.length) return;
      var current = 0;
      var d = documentRef();
      for (var i = 0; i < visible.length; i++) if (visible[i] === d.activeElement) current = i;
      var id = visible[current].getAttribute('data-node');
      var node = findNode(id);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        var at = stepHighlight(visible.length, current, event.key, { wrap: false });
        visible[at].focus();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (node && node.getAttribute('aria-expanded') === 'false') {
          // Expand, then move into the revealed children — which is what Right means when the item
          // is already open, so the two cases have to be distinguished rather than both expanding.
          open[id] = true;
          render();
          focusNode(id);
        } else if (node && node.getAttribute('aria-expanded') === 'true') {
          // Into the group, not `node.querySelector` — that would match the node's own label first,
          // since the label is itself a descendant and comes earlier in document order.
          var group = node.querySelector('[role="group"]');
          var first = group && group.querySelector('[data-action="tree-node"]');
          if (first) first.focus();
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (node && node.getAttribute('aria-expanded') === 'true') { open[id] = false; render(); focusNode(id); return; }
        // Otherwise go to the parent item, walking out of the group `<ul>` on the way. A top-level
        // node has no ancestor with `data-node` and the walk simply runs out.
        var parent = node && node.parentNode;
        while (parent && parent.getAttribute && parent.getAttribute('data-node') === null) parent = parent.parentNode;
        if (parent && parent.getAttribute && parent.getAttribute('data-node') !== null) {
          focusNode(parent.getAttribute('data-node'));
        }
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selected = id;
        render();
        if (options.onSelect) options.onSelect(id);
      }
    });

    function focusNode(id) {
      var node = findNode(id);
      var label = node && node.querySelector ? node.querySelector('[data-action="tree-node"]') : null;
      if (label) label.focus();
    }

    render();
    return { element: root, render: render, expand: function (id) { open[id] = true; render(); }, collapseAll: function () { open = {}; render(); } };
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Inputs and small controls
  // ---------------------------------------------------------------------------------------------

  /**
   * A text input, textarea or select with §5's validation wiring.
   *
   * The requirement is `data-invalid` plus an inline message referenced by `aria-describedby`, so a
   * screen reader hears the reason rather than just "invalid". A field that only turns red conveys
   * its problem by colour alone, which REQ-UI-007 forbids.
   */
  function field(opts) {
    var options = opts || {};
    var id = options.id || ('tmv-f-' + core.uuid().slice(0, 8));
    var describedBy = [];
    var control;
    var isSelect = options.kind === 'select';
    // The element the invalid state is written to. For every control except a select that is the
    // control itself; a select is marked on its wrapper, which is where Carbon's outline rule looks.
    var invalidHost;

    if (isSelect) {
      /*
       * The native `<select>` carries `cds--select-input`, not `cds--select`.
       *
       * In Carbon's markup `cds--select` is the *wrapper* — `.cds--select, .cds--select-input__wrapper
       * { position: relative; display: flex; inline-size: 100% }` — and `cds--select-input` is the
       * `<select>` inside it. Putting the wrapper's class on the `<select>` itself made the element a
       * flex container, so the browser laid its options out as flex items in a column: every filter
       * dropdown in the application rendered as a 224px-tall open list box, and in the table toolbar,
       * where four of them sat side by side, that is what pushed the search box and the buttons out
       * of the bar. The class was present, the rule existed, and the component it applied to was the
       * wrong element — the same failure as the side-nav `<button>` in `00-app.css`, from the other
       * direction.
       */
      control = core.el('select', { class: CLS.field.select, id: id });
      var choices = options.options || [];
      if (options.placeholder) control.appendChild(core.el('option', { value: '', text: options.placeholder, disabled: options.required ? true : null, selected: options.value === '' || options.value === undefined ? true : null }));
      for (var i = 0; i < choices.length; i++) {
        control.appendChild(core.el('option', {
          value: String(choices[i].value),
          text: choices[i].label,
          selected: String(choices[i].value) === String(options.value) ? true : null,
          disabled: choices[i].disabled ? true : null,
        }));
      }
    } else if (options.kind === 'textarea') {
      control = core.el('textarea', { class: CLS.field.area, id: id, rows: options.rows || 4, placeholder: options.placeholder || null });
      if (options.value !== undefined && options.value !== null) control.textContent = String(options.value);
    } else {
      var type = options.type || 'text';
      control = core.el('input', {
        type: type,
        class: CLS.field.input,
        id: id,
        placeholder: options.placeholder || null,
        maxlength: options.maxlength || null,
        inputmode: options.inputmode || null,
        // A date input is native on purpose (`07-ui.md` §5): Carbon's picker needs flatpickr's JS,
        // which does not ship, and the model's dates are day-granularity anyway.
        value: options.value === undefined || options.value === null ? null : String(options.value),
      });
    }
    if (options.required) control.setAttribute('required', '');
    if (options.name) control.setAttribute('name', options.name);
    if (options.action) control.setAttribute('data-action', options.action);
    if (options.autocomplete) control.setAttribute('autocomplete', options.autocomplete);

    var message = core.el('p', { class: 'cds--form-requirement', id: id + '-msg', hidden: true });
    if (options.hint) {
      var hintId = id + '-hint';
      describedBy.push(hintId);
    }
    describedBy.push(id + '-msg');
    control.setAttribute('aria-describedby', describedBy.join(' '));

    var children = [core.el('label', { class: CLS.field.label, for: id, text: options.label })];
    if (options.hint) {
      children.push(core.el('p', { class: 'cds--form__helper-text', id: id + '-hint', text: options.hint }));
    }
    /*
     * The select is the one control that needs a wrapper of its own, for two reasons that are both
     * Carbon's: `cds--select-input` is `appearance: none` — the native arrow is switched off, because
     * Carbon draws its own — and the invalid outline is painted by a rule that reaches the control
     * through `.cds--select-input__wrapper[data-invalid] .cds--select-input`. Without the wrapper the
     * dropdown had no arrow at all and a failed validation had nowhere to show, so the requirement
     * message appeared while the field it belonged to looked untouched.
     */
    if (isSelect) {
      invalidHost = core.el('div', { class: CLS.field.selectWrapper }, [
        control,
        icon('chevron-down', 'tmv-select__arrow'),
      ]);
      children.push(invalidHost);
    } else {
      children.push(control);
    }
    children.push(message);
    var wrapper = core.el('div', { class: 'cds--form-item' + (options.className ? ' ' + options.className : '') }, children);

    function setError(text) {
      var invalid = !!text;
      // `data-invalid` goes on whichever element Carbon's own rules read it from: the control for a
      // text input or a textarea, the wrapper for a select. The text-input invalid class is applied
      // only where it is the right class — writing `cds--text-input--invalid` onto a `<select>` was
      // the other half of the same mistake, a real Carbon class on an element Carbon never puts it on.
      core.setAttr(invalidHost, 'data-invalid', invalid ? 'true' : null);
      core.setAttr(control, 'aria-invalid', invalid ? 'true' : null);
      if (!isSelect) core.setClass(control, CLS.field.invalid, invalid);
      message.textContent = text || '';
      core.setHidden(message, !invalid);
      core.setClass(wrapper, 'cds--form-item--invalid', invalid);
    }

    return {
      element: wrapper,
      control: control,
      id: id,
      value: function () { return control.value === undefined ? control.textContent : control.value; },
      setValue: function (v) {
        if (control.value === undefined) control.textContent = v === null || v === undefined ? '' : String(v);
        else control.value = v === null || v === undefined ? '' : String(v);
      },
      setError: setError,
      clearError: function () { setError(null); },
      on: function (type, handler) { return core.on(control, type, handler); },
    };
  }

  /**
   * A search box (§5: debounced filtering, clear, Escape).
   *
   * The debounce is a real timer with a function argument — never a string (REQ-SEC-002) — and it is
   * cleared on every keystroke so a fast typist does not get a render per character. That matters
   * here beyond politeness: filtering a 5,000-row model per keystroke is what REQ-VIEW-009's "stays
   * interactive" is about.
   */
  function search(opts) {
    var options = opts || {};
    var delay = core.isNumber(options.delay) ? options.delay : 150;
    var input = core.el('input', {
      type: 'search',
      class: CLS.search.input,
      id: options.id || ('tmv-search-' + core.uuid().slice(0, 8)),
      placeholder: options.placeholder || 'Search',
      'aria-label': options.label || options.placeholder || 'Search',
      autocomplete: 'off',
    });
    var clear = core.el('button', {
      type: 'button',
      class: CLS.search.close,
      'data-action': 'search-clear',
      'aria-label': 'Clear search',
      hidden: true,
    }, [icon('close')]);
    var root = core.el('div', { class: CLS.search.root }, [input, clear]);
    var timer = null;

    function emit(immediate) {
      clearTimeout(timer);
      if (immediate) { if (options.onChange) options.onChange(input.value); return; }
      timer = setTimeout(function () { if (options.onChange) options.onChange(input.value); }, delay);
    }

    core.on(input, 'input', function () {
      core.setHidden(clear, !input.value);
      emit(false);
    });
    core.on(input, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      // Escape clears first and only reports "dismissed" once there is nothing left to clear, so a
      // single press does not both empty the box and close the thing the box lives in.
      if (input.value) {
        event.stopPropagation();
        input.value = '';
        core.setHidden(clear, true);
        emit(true);
      } else if (options.onEscape) {
        options.onEscape();
      }
    });
    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node || node.getAttribute('data-action') !== 'search-clear') return;
      input.value = '';
      core.setHidden(clear, true);
      input.focus();
      emit(true);
    });

    return {
      element: root,
      input: input,
      value: function () { return input.value; },
      setValue: function (v) { input.value = v || ''; core.setHidden(clear, !input.value); },
      focus: function () { input.focus(); },
      destroy: function () { clearTimeout(timer); },
    };
  }

  /**
   * A file drop zone (§5: drag-and-drop wiring, drop-active state, file reading, progress, errors).
   *
   * `onFiles(entries)` receives `[{name, size, text}]` for the files that read successfully and
   * `{name, size, error}` for the ones that did not. Reading is text-only, always: the import path
   * never parses a dropped file as HTML (`08-security.md` §3), and the same is true of a model file
   * that *is* HTML — it is read as text and parsed as JSON, never opened.
   */
  function fileDrop(opts) {
    var options = opts || {};
    var input = core.el('input', {
      type: 'file',
      class: 'cds--visually-hidden',
      id: options.id || ('tmv-file-' + core.uuid().slice(0, 8)),
      multiple: options.multiple === false ? null : true,
      accept: options.accept || '.json,.html,.otm,.tml,application/json,text/html',
    });
    var status = core.el('div', { class: 'cds--file-container', 'aria-live': 'polite' });
    var drop = core.el('div', {
      class: CLS.file.drop,
      'data-action': 'browse',
      tabindex: '0',
      role: 'button',
      'aria-describedby': input.id + '-hint',
    }, [
      core.el('p', { class: 'cds--file__drop-container-text', text: options.prompt || 'Drag a file here or click to browse' }),
      core.el('p', { class: 'cds--file__drop-container-hint', id: input.id + '-hint', text: options.hint || 'Threat-Model-Viewport, OTM and TML files' }),
    ]);
    var root = core.el('div', { class: CLS.file.root }, [input, drop, status]);

    core.on(drop, 'click', function () { input.click(); });
    core.on(drop, 'keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      input.click();
    });
    core.on(input, 'change', function () { handle(input.files); input.value = ''; });

    // dragenter/dragover must both preventDefault or the browser opens the file instead of handing
    // it over — the single most common way a drop zone silently does nothing.
    core.on(drop, 'dragenter', function (event) { event.preventDefault(); core.setClass(drop, CLS.file.over, true); });
    core.on(drop, 'dragover', function (event) { event.preventDefault(); core.setClass(drop, CLS.file.over, true); });
    core.on(drop, 'dragleave', function (event) {
      // Only when the pointer has actually left the zone: dragging over a child fires dragleave on
      // the parent, which would make the highlight flicker.
      if (event.relatedTarget && drop.contains && drop.contains(event.relatedTarget)) return;
      core.setClass(drop, CLS.file.over, false);
    });
    core.on(drop, 'drop', function (event) {
      event.preventDefault();
      core.setClass(drop, CLS.file.over, false);
      var files = event.dataTransfer ? event.dataTransfer.files : null;
      handle(files);
    });

    function handle(files) {
      if (!files || !files.length) return;
      core.clear(status);
      var list = [];
      for (var i = 0; i < files.length; i++) list.push(files[i]);
      status.appendChild(core.el('p', { class: 'tmv-file__progress', text: 'Reading ' + core.plural(list.length, 'file') + '…' }));
      readAll(list, function (entries) {
        core.clear(status);
        var ok = [];
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j];
          status.appendChild(core.el('div', { class: CLS.file.item + (entry.error ? ' cds--file__selected-file--invalid' : '') }, [
            core.el('p', { class: 'cds--file-filename', text: entry.name }),
            core.el('p', { class: 'cds--file__state-container', text: entry.error || core.bytes(entry.size) }),
          ]));
          if (!entry.error) ok.push(entry);
        }
        if (ok.length && options.onFiles) options.onFiles(ok, entries);
      });
    }

    return { element: root, input: input, reset: function () { core.clear(status); } };
  }

  /** Read files as text, one report per file. Never rejects: a failure is a result, not an exception. */
  function readAll(files, done) {
    var Reader = typeof FileReader === 'undefined' ? null : FileReader;
    var out = [];
    var index = 0;
    function next() {
      if (index >= files.length) { done(out); return; }
      var file = files[index++];
      if (!Reader) {
        out.push({ name: file.name, size: file.size, error: 'This browser cannot read files here.' });
        next();
        return;
      }
      var reader = new Reader();
      reader.onload = function () {
        out.push({ name: file.name, size: file.size, text: String(reader.result) });
        next();
      };
      reader.onerror = function () {
        out.push({ name: file.name, size: file.size, error: 'The file could not be read.' });
        next();
      };
      try {
        reader.readAsText(file);
      } catch (err) {
        out.push({ name: file.name, size: file.size, error: 'The file could not be read.' });
        next();
      }
    }
    if (!files.length) { done(out); return; }
    next();
  }

  /**
   * A code snippet (§5: copy-to-clipboard, expand/collapse).
   *
   * `text` is the only content this widget accepts, and it is set with `textContent`. That is the
   * point of it: a snippet is where raw model text is shown to the user — an imported document, a
   * diagram source, a commit patch — and it must be shown as characters, not parsed.
   */
  function snippet(opts) {
    var options = opts || {};
    var text = options.text === undefined || options.text === null ? '' : String(options.text);
    var collapsible = options.collapsible !== false;
    var code = core.el('code', { class: 'cds--snippet__code', text: text });
    var pre = core.el('pre', { class: 'cds--snippet__pre', tabindex: '0' }, [code]);
    var copy = core.el('button', {
      type: 'button',
      class: CLS.snippet.copy,
      'data-action': 'copy',
      'aria-label': options.copyLabel || 'Copy to clipboard',
    }, [icon('copy')]);
    var expand = collapsible ? core.el('button', {
      type: 'button',
      class: 'cds--snippet__expand',
      'data-action': 'expand-snippet',
      'aria-expanded': 'false',
      'aria-label': 'Show more',
    }, [icon('chevron-down')]) : null;

    var root = core.el('div', {
      class: CLS.snippet.root + (options.single ? ' ' + CLS.snippet.single : ' ' + CLS.snippet.multi),
    }, [pre, copy, expand]);

    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node) return;
      var action = node.getAttribute('data-action');
      if (action === 'copy') {
        copyText(text, function (ok) {
          node.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed — select the text and copy manually');
          if (options.onCopy) options.onCopy(ok);
        });
      } else if (action === 'expand-snippet') {
        var isOpen = node.getAttribute('aria-expanded') === 'true';
        node.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        node.setAttribute('aria-label', isOpen ? 'Show more' : 'Show less');
        core.setClass(root, CLS.snippet.expand, !isOpen);
      }
    });

    return { element: root, code: code, setText: function (v) { code.textContent = v === null || v === undefined ? '' : String(v); } };
  }

  /**
   * Copy text, with a fallback for the browsers and origins where the async clipboard is refused.
   *
   * `navigator.clipboard` needs a secure context and a permission, and on `file://` both are
   * uncertain — which is the same class of platform assumption this project refuses to make
   * elsewhere (ADR-0011). The `execCommand` path is deprecated but it is the only synchronous
   * fallback, and a copy button that works is worth a deprecated call. When neither works the caller
   * is told, so the UI can say "select and copy" rather than claiming a copy that did not happen.
   */
  function copyText(value, done) {
    var nav = typeof navigator === 'undefined' ? null : navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(value).then(function () { done(true); }, function () { done(legacyCopy(value)); });
      return;
    }
    done(legacyCopy(value));
  }

  function legacyCopy(value) {
    var d = documentRef();
    if (!d || !d.body || !d.createElement) return false;
    var area = core.el('textarea', { class: 'cds--visually-hidden', 'aria-hidden': 'true' });
    area.value = value;
    d.body.appendChild(area);
    var ok = false;
    try {
      area.select();
      ok = d.execCommand ? d.execCommand('copy') === true : false;
    } catch (err) {
      ok = false;
    }
    d.body.removeChild(area);
    return ok;
  }

  function pagination(opts) {
    var options = opts || {};
    var sizes = options.pageSizes || [10, 25, 50, 100];
    var text = core.el('span', { class: CLS.pagination.text });
    var sizeSelect = core.el('select', { class: 'cds--select-input', 'aria-label': 'Items per page', 'data-action': 'page-size' });
    for (var i = 0; i < sizes.length; i++) {
      sizeSelect.appendChild(core.el('option', { value: String(sizes[i]), text: sizes[i] + ' per page', selected: String(sizes[i]) === String(options.pageSize) ? true : null }));
    }
    var back = core.el('button', { type: 'button', class: CLS.pagination.button, 'data-action': 'page-prev', 'aria-label': 'Previous page' }, [icon('chevron-left')]);
    var forward = core.el('button', { type: 'button', class: CLS.pagination.button, 'data-action': 'page-next', 'aria-label': 'Next page' }, [icon('chevron-right')]);
    // The page-size select gets the same wrapper as every other select in the application: without
    // it the control is `appearance: none` with no arrow, so a reader has no way to know it opens.
    var sizeSelectHost = core.el('div', { class: CLS.field.selectWrapper }, [sizeSelect, icon('chevron-down', 'tmv-select__arrow')]);
    var root = core.el('div', { class: CLS.pagination.root }, [text, sizeSelectHost, core.el('div', { class: CLS.pagination.nav }, [back, forward])]);

    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node) return;
      var action = node.getAttribute('data-action');
      if (action === 'page-prev') emit(window_.page - 1);
      else if (action === 'page-next') emit(window_.page + 1);
    });
    core.on(sizeSelect, 'change', function () { if (options.onChange) options.onChange({ page: 1, pageSize: parseInt(sizeSelect.value, 10) }); });

    var window_ = pageWindow(options.total || 0, options.page || 1, options.pageSize || 10);

    function emit(page) {
      if (options.onChange) options.onChange({ page: page, pageSize: window_.pageSize });
    }

    function set(page, total, pageSize) {
      window_ = pageWindow(total, page, pageSize || window_.pageSize);
      text.textContent = window_.text;
      core.setAttr(back, 'disabled', window_.page <= 1 ? '' : null);
      core.setAttr(forward, 'disabled', window_.page >= window_.pages ? '' : null);
      return window_;
    }

    set(options.page || 1, options.total || 0, options.pageSize);

    return { element: root, set: set, window: function () { return window_; } };
  }

  function contentSwitcher(opts) {
    var options = opts || {};
    var tabs = options.items || [];
    var selected = options.selected || (tabs.length ? tabs[0].value : null);
    var root = core.el('div', { class: CLS.switcher.root, role: 'tablist', 'aria-label': options.label || 'View' });
    var buttons = [];

    for (var i = 0; i < tabs.length; i++) {
      var active = String(tabs[i].value) === String(selected);
      var node = core.el('button', {
        type: 'button',
        class: CLS.switcher.button + (active ? ' ' + CLS.switcher.selected : ''),
        role: 'tab',
        'aria-selected': active ? 'true' : 'false',
        tabindex: active ? '0' : '-1',
        'data-action': 'switch',
        'data-value': String(tabs[i].value),
      }, [
        // The label is a span, not the button's bare text, and that is load-bearing rather than
        // tidiness: Carbon paints the selected state with the button's `:after` pseudo-element and
        // expects the label to sit above it in `.cds--content-switcher__label` (which carries
        // `z-index: 1`). Text placed directly in the button has no stacking context of its own, so the
        // `:after` covered it — the selected entry rendered as a blank chip and the current theme was
        // unreadable in the menu it was chosen from.
        core.el('span', { class: 'cds--content-switcher__label', text: tabs[i].label }),
      ]);
      buttons.push(node);
      root.appendChild(node);
    }

    function select(value) {
      selected = value;
      for (var i = 0; i < buttons.length; i++) {
        var active = String(buttons[i].getAttribute('data-value')) === String(value);
        core.setClass(buttons[i], CLS.switcher.selected, active);
        buttons[i].setAttribute('aria-selected', active ? 'true' : 'false');
        buttons[i].setAttribute('tabindex', active ? '0' : '-1');
      }
      if (options.onChange) options.onChange(value);
    }

    core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (node && node.getAttribute('data-action') === 'switch') select(node.getAttribute('data-value'));
    });
    // Roving tabindex with arrow keys, the same contract as the top tab strip (§1).
    core.on(root, 'keydown', function (event) {
      if (!event.target || !event.target.getAttribute) return;
      var at = buttons.indexOf(event.target);
      if (at === -1) return;
      var next = stepHighlight(buttons.length, at, event.key);
      if (next === at) return;
      event.preventDefault();
      buttons[next].focus();
      select(buttons[next].getAttribute('data-value'));
    });

    return { element: root, select: select, value: function () { return selected; } };
  }

  /** The stepped Progress indicator the import flow uses (`07-ui.md` §6). */
  function progressSteps(opts) {
    var options = opts || {};
    var steps = options.steps || [];
    var root = core.el('ol', { class: CLS.progress.root + ' tmv-progress' + (options.vertical ? ' ' + CLS.progress.vertical : ''), 'aria-label': options.label || 'Progress' });
    var nodes = [];
    for (var i = 0; i < steps.length; i++) {
      var node = core.el('li', { class: CLS.progress.step + ' ' + CLS.progress.incomplete }, [
        core.el('p', { class: 'cds--progress-label', text: steps[i].label }),
        steps[i].detail ? core.el('p', { class: 'cds--progress-optional', text: steps[i].detail }) : null,
      ]);
      nodes.push(node);
      root.appendChild(node);
    }

    function set(index) {
      for (var i = 0; i < nodes.length; i++) {
        var state = i < index ? CLS.progress.complete : i === index ? CLS.progress.current : CLS.progress.incomplete;
        core.setClass(nodes[i], CLS.progress.complete, i < index);
        core.setClass(nodes[i], CLS.progress.current, i === index);
        core.setClass(nodes[i], CLS.progress.incomplete, i > index);
        core.setAttr(nodes[i], 'aria-current', i === index ? 'step' : null);
        nodes[i].setAttribute('data-state', state === CLS.progress.complete ? 'complete' : state === CLS.progress.current ? 'current' : 'incomplete');
      }
    }

    set(core.isNumber(options.current) ? options.current : 0);
    return { element: root, set: set };
  }

  function structuredList(opts) {
    var options = opts || {};
    var rows = options.rows || [];
    var root = core.el('div', { class: CLS.list.root + ' tmv-structured', role: 'table', 'aria-label': options.label || null });
    if (options.headers) {
      var head = core.el('div', { class: CLS.list.row + ' ' + CLS.list.head, role: 'row' });
      for (var h = 0; h < options.headers.length; h++) {
        head.appendChild(core.el('span', { class: CLS.list.headCell, role: 'columnheader', text: options.headers[h] }));
      }
      root.appendChild(head);
    }
    for (var i = 0; i < rows.length; i++) {
      var row = core.el('div', { class: CLS.list.row, role: 'row', 'data-row': rows[i].id ? String(rows[i].id) : String(i) });
      var cells = rows[i].cells || [];
      for (var c = 0; c < cells.length; c++) {
        var cell = core.el('span', { class: CLS.list.cell, role: 'cell' });
        core.append(cell, cells[c]);
        row.appendChild(cell);
      }
      root.appendChild(row);
    }
    return root;
  }

  /**
   * Tooltip / definition tooltip (§5: "positioning is ours"; Carbon ships static positional classes
   * and no collision awareness).
   *
   * Returns a wrapper holding the trigger and the bubble, and the caller places **the wrapper**. That
   * indirection is what makes the placement CSP-safe: the bubble is a child of a positioned wrapper,
   * so CSS does the geometry and JavaScript only chooses the *side*, writing it as a `data-placement`
   * attribute.
   *
   * The obvious implementation — absolutely-position it with `top`/`left` against the viewport — is
   * not available here. `style-src` is a hash with no `'unsafe-inline'` (`02-architecture.md` §5), so
   * a `style` attribute is refused by the browser. `place()` still does the collision arithmetic that
   * decides the side; what it gives up is the pixel-level clamp along the other axis, and that is
   * bought back in CSS with a `max-width`. Losing the clamp is the better trade: the alternative was
   * a tooltip whose positioning depends on a CSP behaviour this project has already flagged as
   * unverified (V2).
   */
  function tooltip(opts) {
    var options = opts || {};
    var trigger = options.trigger;
    var body = core.el('span', { class: 'cds--definition-tooltip__inner', text: options.text });
    var bubble = core.el('div', {
      class: CLS.tooltip,
      role: 'tooltip',
      id: options.id || ('tmv-tip-' + core.uuid().slice(0, 8)),
      hidden: true,
    }, [body]);
    var wrapper = core.el('span', { class: 'tmv-tip' }, [trigger, bubble]);
    var offs = [];

    function side() {
      var d = documentRef();
      if (!trigger || !trigger.getBoundingClientRect || !d || !d.documentElement) return 'bottom';
      var anchorRect = trigger.getBoundingClientRect();
      // The bubble's own size is not known before it is shown, so the estimate is generous: a wrong
      // estimate only ever flips the side early, which is the harmless direction to be wrong in.
      var estimate = { width: Math.min(320, String(options.text || '').length * 7 + 32), height: 44 };
      return place(
        { top: anchorRect.top, left: anchorRect.left, width: anchorRect.width, height: anchorRect.height },
        estimate,
        { width: d.documentElement.clientWidth, height: d.documentElement.clientHeight }
      ).placement;
    }

    function show() {
      core.setHidden(bubble, false);
      wrapper.setAttribute('data-placement', side());
      core.setAttr(trigger, 'aria-describedby', bubble.id);
      offs.push(core.on(documentRef(), 'keydown', function (event) {
        if (event.key === 'Escape') hide();
      }));
    }

    function hide() {
      core.setHidden(bubble, true);
      core.setAttr(trigger, 'aria-describedby', null);
      for (var i = 0; i < offs.length; i++) offs[i]();
      offs = [];
    }

    if (trigger) {
      core.on(trigger, 'mouseenter', show);
      core.on(trigger, 'mouseleave', hide);
      core.on(trigger, 'focus', show);
      core.on(trigger, 'blur', hide);
    }
    return { element: wrapper, bubble: bubble, trigger: trigger, show: show, hide: hide, side: side };
  }

  // ---------------------------------------------------------------------------------------------
  // Namespace
  // ---------------------------------------------------------------------------------------------

  TMV.widgets = {
    CLS: CLS,

    // Pure logic — the parts a unit test can reach without a document (`09-testing.md` §2).
    logic: {
      compareValues: compareValues,
      stableSort: stableSort,
      sortRows: sortRows,
      typeahead: typeahead,
      typeaheadBuffer: typeaheadBuffer,
      pageWindow: pageWindow,
      pageSlice: pageSlice,
      rangeText: rangeText,
      selectAllState: selectAllState,
      stepHighlight: stepHighlight,
      tabTarget: tabTarget,
      isFocusable: isFocusable,
      place: place,
      safeColor: safeColor,
    },

    icon: icon,
    button: button,
    tag: tag,
    labelled: labelled,
    emptyState: emptyState,

    layerRoot: layerRoot,
    lockScroll: lockScroll,
    focusables: focusables,
    closeTopLayer: function (reason) {
      var top = topLayer();
      if (top && top.close) top.close(reason || 'programmatic');
    },
    openLayers: function () { return layerStack.length; },

    modal: modal,
    confirm: confirm,
    popup: popup,
    overflowMenu: overflowMenu,
    dropdown: dropdown,

    dataTable: dataTable,

    accordion: accordion,
    tree: tree,

    field: field,
    search: search,
    fileDrop: fileDrop,
    readAll: readAll,
    snippet: snippet,
    copyText: copyText,
    pagination: pagination,
    contentSwitcher: contentSwitcher,
    progressSteps: progressSteps,
    structuredList: structuredList,
    tooltip: tooltip,
  };
})(globalThis.TMV = globalThis.TMV || {});
