/**
 * The shell — `07-ui.md` §1–§4 and §9, `02-architecture.md` §6 steps 6–8.
 * Requirements: REQ-UI-001..012, REQ-SHELL-001..007, REQ-STORE-004/005/007, REQ-SYNC-001..008.
 *
 * This module is the frame everything else renders into: the header, the nine tabs, the per-tab side
 * navigation, the content region, and the working-copy/history container that the views read. It owns
 * no model knowledge whatsoever — it never inspects an entity — and that boundary is the whole point:
 * a view can be replaced without the navigation noticing, and the shell can be restyled without a view
 * noticing.
 *
 * Six decisions shape it.
 *
 * 1. **The tab strip is a selector, not a set of panels.** `07-ui.md` §1 deviates from Carbon's
 *    one-panel-per-tab markup deliberately: nine panels would be nine renders, eight of them thrown
 *    away, and every one needing invalidation when the model changes. One content region is rendered
 *    into instead, and the accessibility consequence is paid for explicitly — `aria-controls` on every
 *    tab, `aria-labelledby` on the panel rewritten on **every** switch, and a roving tabindex so only
 *    the active tab is in the tab order. That last one is why the tab buttons are built once and only
 *    have their attributes updated: rebuilding them on every switch would drop the focus the arrow
 *    keys just moved.
 *
 * 2. **Tabs are generated from `TABS`; the header frame is authored.** The nine tabs and their
 *    sub-sections are one table in one file, so the tab order, the labels and the side nav cannot
 *    drift apart. The header's own markup (app name, regions, the commit button) is static in
 *    `src/index.html`, because export is a clone of the *authored* document — `exporting.capturePristine`
 *    clones `documentElement` before this module runs, so anything the shell builds is rebuilt on open
 *    rather than carried in the file.
 *
 * 3. **The working copy is a value, not a state machine.** `state.model` is the editable model and
 *    `state.history` is the DAG; `dirty` is derived (`vcs.isDirty`), never stored, so it cannot
 *    disagree with the thing it describes. Every edit goes through `edit`, which pushes the previous
 *    model onto `forms.undo`, recomputes, and re-renders. Nothing else may assign `state.model`.
 *
 * 4. **Uncommitted work is never persisted.** `05-storage.md` §2 gives the stored layout keys for
 *    commits and preferences and none for the working copy, and that is right: the file is the
 *    carrier, a half-finished edit is not a fact about the model, and a browser that remembered an
 *    uncommitted edit would produce a model nobody wrote. `beforeunload` warns (REQ-EDIT-005) and the
 *    model-switch prompt offers commit, stash or discard (REQ-STORE-004) — never a silent discard.
 *
 *    A **stash** is therefore held for the session, in this object. `04-versioning.md` §5 says it is
 *    "stored locally and never exported", and its one purpose is to let *this* reconcile proceed
 *    without losing in-progress work — the reconcile happens at boot, so the session is the window in
 *    which a stash is meaningful. `05-storage.md` §2 does not list a stash key; inventing one would
 *    change a closed storage layout, so it is not invented.
 *
 * 5. **Notice policy is a table, not scattered conditionals.** §9 says the storage-degraded and
 *    origin-partitioned notices are the most common confusing moment in the product, and REQ-SYNC-004
 *    says the *identical* case must be silent. Both are answers to "what should the user be told",
 *    and they live together in `logic.reconcileNotice` / `logic.storageNotice` where they can be read
 *    as a set and tested without a document.
 *
 * 6. **Read-only is a property of the shell, not a hidden flag in each view.** Views read
 *    `ctx.editable` and remove their edit affordances; the shell renders the persistent banner naming
 *    the reason (REQ-VIEW-008). `07-ui.md` §9 is explicit that they are *removed*, not disabled — a
 *    disabled button invites the user to work out why, and the banner has already said why.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;

  // ---------------------------------------------------------------------------------------------
  // 1. The nine tabs and the four themes
  // ---------------------------------------------------------------------------------------------

  /**
   * `07-ui.md` §2 and §3, in one table.
   *
   * Every tab's `sections` are the side-nav entries of §3, in the order given there. A section
   * flagged `finding: true` is a filter or a report rather than an entity list, and §3 says those
   * carry a count "so they read as findings, not sections" — an empty filter showing `0` is
   * informative, an empty one showing nothing looks broken.
   */
  var TABS = [
    {
      id: 'overview',
      label: 'Overview',
      sections: [
        { id: 'summary', label: 'Summary' },
        { id: 'scope', label: 'Scope' },
        { id: 'contributors', label: 'Contributors' },
        { id: 'export-readiness', label: 'Export Readiness', finding: true },
        { id: 'provenance', label: 'Provenance' },
      ],
    },
    {
      id: 'architecture',
      label: 'Architecture',
      sections: [
        { id: 'trust-zones', label: 'Trust Zones' },
        { id: 'trust-boundaries', label: 'Trust Boundaries' },
        { id: 'components', label: 'Components' },
        { id: 'actors', label: 'Actors' },
        { id: 'data-stores', label: 'Data Stores' },
        { id: 'diagram', label: 'Diagram' },
      ],
    },
    {
      id: 'data',
      label: 'Data',
      sections: [
        { id: 'data-sets', label: 'Data Sets' },
        { id: 'assets', label: 'Assets' },
        { id: 'sensitivity', label: 'Sensitivity', finding: true },
        { id: 'placement', label: 'Placement' },
      ],
    },
    {
      id: 'flows',
      label: 'Flows',
      sections: [
        { id: 'all-flows', label: 'All Flows' },
        { id: 'unencrypted', label: 'Unencrypted', finding: true },
        { id: 'cross-zone', label: 'Cross-Zone', finding: true },
        { id: 'missing-endpoints', label: 'Missing Endpoints', finding: true },
      ],
    },
    {
      id: 'threats',
      label: 'Threats',
      sections: [
        { id: 'all-threats', label: 'All Threats' },
        { id: 'by-target', label: 'By Target' },
        { id: 'by-persona', label: 'By Persona' },
        { id: 'personas', label: 'Personas' },
        { id: 'assumptions', label: 'Assumptions' },
        { id: 'unresolved-references', label: 'Unresolved References', finding: true },
      ],
    },
    {
      id: 'controls',
      label: 'Controls',
      sections: [
        { id: 'all-controls', label: 'All Controls' },
        { id: 'by-threat', label: 'By Threat' },
        { id: 'mitigation-plans', label: 'Mitigation Plans' },
        { id: 'coverage-gaps', label: 'Coverage Gaps', finding: true },
        { id: 'unapplied', label: 'Unapplied', finding: true },
      ],
    },
    {
      id: 'risk',
      label: 'Risk',
      sections: [
        { id: 'risk-matrix', label: 'Risk Matrix' },
        { id: 'risk-register', label: 'Risk Register' },
        { id: 'threat-risk-inputs', label: 'Threat Risk Inputs' },
        { id: 'cia-ratings', label: 'CIA Ratings', finding: true },
        { id: 'trust-ratings', label: 'Trust Ratings', finding: true },
      ],
    },
    {
      id: 'history',
      label: 'History',
      sections: [
        { id: 'log', label: 'Log' },
        { id: 'compare', label: 'Compare & Merge' },
        { id: 'conflicts', label: 'Conflicts', finding: true },
        { id: 'stashes', label: 'Stashes', finding: true },
        { id: 'integrity', label: 'Integrity' },
      ],
    },
    {
      id: 'settings',
      label: 'Settings',
      sections: [
        { id: 'model', label: 'Model' },
        { id: 'identity', label: 'Identity' },
        { id: 'storage', label: 'Storage' },
        { id: 'import', label: 'Import' },
        { id: 'export', label: 'Export' },
        { id: 'diagram', label: 'Diagram' },
        { id: 'appearance', label: 'Appearance' },
        { id: 'about', label: 'About' },
        { id: 'danger-zone', label: 'Danger Zone' },
      ],
    },
  ];

  /** Carbon's four prebuilt themes (REQ-UI-005). The classes are the compiled stylesheet's own. */
  var THEMES = [
    { value: 'cds--white', label: 'White', note: 'Carbon White — light' },
    { value: 'cds--g10', label: 'Gray 10', note: 'Carbon Gray 10 — light, the default' },
    { value: 'cds--g90', label: 'Gray 90', note: 'Carbon Gray 90 — dark' },
    { value: 'cds--g100', label: 'Gray 100', note: 'Carbon Gray 100 — dark' },
  ];

  /** The switcher's value for "the model in this file". Not a model id, and cannot collide with one. */
  var FILE_VALUE = '@file';

  /**
   * The switcher's value for a model imported in this session that the browser would not store.
   *
   * There are three kinds of history the switcher can be showing, not two (`05-storage.md` §8,
   * REQ-STORE-007): the one in the file, one saved in this browser, and one that arrived by import
   * into a browser that is refusing to save anything. The third has no stored copy to delete and no
   * file to go back to, so it needs its own value — and its own wording, because a delete affordance
   * that says "the file is untouched either way" about a model that came from a dropped file the
   * application never wrote would be describing something that did not happen.
   */
  var SESSION_VALUE = '@session';
  var CONTENT_ID = 'tmv-content';
  var SIDENAV_ID = 'tmv-side-nav';
  var TABS_ID = 'tmv-tabs';
  var SIDENAV_COLLAPSED = 'cds--side-nav--collapsed';
  var SIDENAV_EXPANDED = 'cds--side-nav--expanded';
  var TABLIST_LABEL = 'Sections of the threat model';

  // ---------------------------------------------------------------------------------------------
  // 2. Decisions worth testing without a document (`09-testing.md` §2)
  // ---------------------------------------------------------------------------------------------

  function tabFor(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
    return null;
  }

  function tabIds() {
    var out = [];
    for (var i = 0; i < TABS.length; i++) out.push(TABS[i].id);
    return out;
  }

  function tabIndex(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return i;
    return -1;
  }

  /** A tab id from anywhere — a preference, a deep link, a restored session — or the fallback. */
  function normaliseTab(id, fallback) {
    return tabFor(id) ? id : tabFor(fallback) ? fallback : TABS[0].id;
  }

  function sectionsOf(tabId) {
    var tab = tabFor(tabId);
    return tab ? tab.sections : [];
  }

  function sectionFor(tabId, sectionId) {
    var list = sectionsOf(tabId);
    for (var i = 0; i < list.length; i++) if (list[i].id === sectionId) return list[i];
    return null;
  }

  /**
   * The section a tab opens on. The first entry of §3's table, which is the tab's subject — Overview
   * opens on Summary, Threats on All Threats — so the side nav always has an active row and no view
   * has to invent a default of its own.
   */
  function defaultSection(tabId) {
    var list = sectionsOf(tabId);
    return list.length ? list[0].id : null;
  }

  /**
   * Which tab a key moves to. Returns `-1` for a key that is not the strip's business, so the caller
   * lets the event through rather than swallowing every keystroke on the strip.
   *
   * Wrapping is deliberate: Carbon's tabs wrap, and a nine-item strip that dead-ends at Overview
   * makes the last tab feel like a different kind of thing from the first.
   */
  function stepTab(total, current, key) {
    if (!core.isNumber(total) || total <= 0) return -1;
    var at = core.isNumber(current) && current >= 0 && current < total ? current : 0;
    if (key === 'ArrowRight' || key === 'ArrowDown') return (at + 1) % total;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (at - 1 + total) % total;
    if (key === 'Home') return 0;
    if (key === 'End') return total - 1;
    return -1;
  }

  function isTheme(value) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].value === value) return true;
    return false;
  }

  /** Anything that is not one of the four compiled themes becomes Gray 10, the light default. */
  function themeFor(value) {
    return isTheme(value) ? value : 'cds--g10';
  }

  function themeLabel(value) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].value === value) return THEMES[i].label;
    return 'Gray 10';
  }

  function isDarkTheme(value) {
    return value === 'cds--g90' || value === 'cds--g100';
  }

  /**
   * The variant the light/dark switch returns to, per family.
   *
   * REQ-UI-005 offers four themes; the switch in the header is a one-click shortcut between the light
   * pair and the dark pair, not a fifth theme. A user who picked Gray 90 from the menu and then used
   * the switch to go light expects the switch to bring back Gray 90 — not to reset them to Gray 100 —
   * so the last theme used in each family is remembered and returned to.
   *
   * These are session memory and nothing else, which is deliberate. Persisting them would add two
   * fields to the stored preferences and to their whitelist (`07-storage.js` §2) for a value whose
   * only job is to make a second press of one control undo the first. After a reload the family
   * defaults are the sensible pair, and the four-way choice is never more than a menu or Settings
   * away, so nothing is lost that the user cannot re-express in one click.
   */
  var preferredLight = 'cds--g10';
  var preferredDark = 'cds--g100';

  function rememberThemeFamily(value) {
    if (!isTheme(value)) return;
    if (isDarkTheme(value)) preferredDark = value;
    else preferredLight = value;
  }

  /** The theme a switch press should move to, given whatever theme is current. */
  function oppositeFamilyTheme(value) {
    var current = themeFor(value);
    rememberThemeFamily(current);
    return isDarkTheme(current) ? preferredLight : preferredDark;
  }

  /**
   * The switcher's entries (REQ-UI-004, `07-ui.md` §4).
   *
   * The embedded model's history and a stored copy of the same model are **two entries**, and
   * deliberately so: they are two different histories that happen to share a model id, which is
   * exactly the situation `04-versioning.md` §6 is written for. Merging them into one row would make
   * the row mean two things, and would leave the user unable to reach whichever of the two the row was
   * not showing — including, when they diverge, the one the compare screen needs to name.
   *
   * The embedded entry is first and tagged `fromFile` (REQ-STORE-004: it is always present, even when
   * nothing is stored, because on Firefox the file's own history may be the only one there is).
   * `stored` marks the entries that are a copy in this browser, and it is what the delete affordance
   * keys on — §4 puts delete on registry entries only and leaves it out for the embedded model.
   */
  function switcherEntries(embeddedEntry, registry, options) {
    var opts = options || {};
    var list = core.isArray(registry) ? registry : [];
    var source = opts.source === 'stored' ? 'stored' : opts.source === 'session' ? 'session' : 'file';
    var activeId = core.isString(opts.activeModelId) ? opts.activeModelId : null;
    var out = [];
    var i;

    if (embeddedEntry) {
      out.push({
        value: FILE_VALUE,
        kind: 'file',
        modelId: core.isString(embeddedEntry.modelId) ? embeddedEntry.modelId : null,
        name: embeddedEntry.name,
        commitCount: core.isNumber(embeddedEntry.commitCount) ? embeddedEntry.commitCount : 0,
        lastOpenedAt: embeddedEntry.lastOpenedAt || null,
        headCommitId: embeddedEntry.headCommitId || null,
        bytes: core.isNumber(embeddedEntry.bytes) ? embeddedEntry.bytes : 0,
        fromFile: true,
        stored: false,
        session: false,
        current: source === 'file',
      });
    }

    for (i = 0; i < list.length; i++) {
      var entry = list[i];
      out.push({
        value: entry.modelId,
        kind: 'stored',
        modelId: entry.modelId,
        name: entry.name,
        commitCount: core.isNumber(entry.commitCount) ? entry.commitCount : 0,
        lastOpenedAt: entry.lastOpenedAt || null,
        headCommitId: entry.headCommitId || null,
        bytes: core.isNumber(entry.bytes) ? entry.bytes : 0,
        fromFile: false,
        stored: true,
        session: false,
        current: source === 'stored' && entry.modelId === activeId,
      });
    }

    // The session entry is added last and only when there is one, so it cannot displace a stored
    // entry for the same model id — an import followed by a successful save produces both, and they
    // are two different histories exactly as the file and stored entries are.
    var session = opts.session || null;
    if (session) {
      out.push({
        value: SESSION_VALUE,
        kind: 'session',
        modelId: core.isString(session.modelId) ? session.modelId : null,
        name: session.name,
        commitCount: core.isNumber(session.commitCount) ? session.commitCount : 0,
        lastOpenedAt: session.lastOpenedAt || null,
        headCommitId: session.headCommitId || null,
        bytes: core.isNumber(session.bytes) ? session.bytes : 0,
        fromFile: false,
        stored: false,
        session: true,
        current: source === 'session',
      });
    }
    return out;
  }

  /** Which of the three places a switcher entry's history lives in. */
  function entryKindOf(entry) {
    if (!entry) return null;
    if (entry.kind === 'file' || entry.kind === 'stored' || entry.kind === 'session') return entry.kind;
    return entry.fromFile ? 'file' : 'stored';
  }

  /**
   * Whether the header may offer to delete the *stored copy* of the current model.
   *
   * §4 draws the distinction precisely: the delete affordance is on registry entries only and is
   * **absent** — not present-and-disabled — for the embedded model. A model that is only in the file
   * has nothing stored to delete, so the menu says so in words instead of showing a dead control.
   */
  function deleteAvailability(entry) {
    var kind = entryKindOf(entry);
    if (!entry) {
      return { available: false, reason: 'No model is open, so there is nothing stored to delete.' };
    }
    if (kind === 'session') {
      return {
        available: false,
        reason:
          'This model was imported in this session and this browser is not storing anything, so there ' +
          'is no copy here to delete. It is not in the file either — export it if you want to keep it, ' +
          'because closing the page will lose it.',
      };
    }
    if (kind !== 'stored') {
      return {
        available: false,
        reason:
          'This model came from the file. There is no stored copy of it in this browser, so there is ' +
          'nothing here to delete — the file is untouched either way.',
      };
    }
    return { available: true, reason: null };
  }

  function entryHeadline(entry) {
    return entry && core.isString(entry.name) && entry.name !== '' ? entry.name : 'Untitled Threat Model';
  }

  /** One line per entry: commit count, when it was last opened, and where this history lives. */
  function entryDetail(entry, nowMs) {
    var kind = entryKindOf(entry);
    var parts = [];
    parts.push(core.plural(core.isNumber(entry.commitCount) ? entry.commitCount : 0, 'commit', 'commits'));
    if (entry.lastOpenedAt) parts.push('opened ' + core.relativeTime(entry.lastOpenedAt, nowMs));
    if (kind === 'session') parts.push('imported in this session · not stored');
    else parts.push(kind === 'file' ? 'from the file' : 'stored in this browser');
    return parts.join(' · ');
  }

  /**
   * The name the header renders for an entry, which is not always the name the entry carries.
   *
   * The entry for the model being **edited** is labelled with the name in the working copy, so a
   * rename is visible in the header before it is committed — the same thing the dirty indicator
   * already says about the copy as a whole (REQ-EDIT-005, REQ-EDIT-011, §4).
   *
   * Three limits on that, and they are the reason this is a function here rather than an assignment to
   * the entry objects in `switcherEntries`:
   *
   *   - **It is display only, and display only for the current entry.** `state.switcherEntries` keeps
   *     the committed names, so the delete confirmation (which names the model with `entryHeadline`)
   *     and every other entry's label describe a name that is actually in a history.
   *   - **The embedded model is excluded.** What its entry names is the file, so it shows the file's
   *     name whichever copy of that model is open. A rename is committed to a history and never
   *     rewrites the file, so after renaming while the file's copy is open the two entries disagree —
   *     and that is the accurate answer rather than a stale one.
   *   - **The accessible names follow the visible label**, because a control whose spoken name and
   *     written name disagree is its own defect. That is why `entryName` below uses this too.
   */
  function renderedName(entry) {
    if (!entry || !entry.current || entryKindOf(entry) === 'file') return entryHeadline(entry);
    if (core.isObject(state.model) && core.isString(state.model.name) && state.model.name !== '') {
      return core.nfc(state.model.name);
    }
    return entryHeadline(entry);
  }

  /** The full accessible name of a switcher option, which is not the visual label. */
  function entryName(entry, nowMs) {
    var kind = entryKindOf(entry);
    var text = renderedName(entry) + ' — ' + entryDetail(entry, nowMs);
    if (kind === 'file') text += ' — from the file';
    if (kind === 'session') text += ' — imported in this session, not saved';
    if (entry.current) text += ' — current';
    return text;
  }

  /** The side nav's rows for a tab: §3's entries, with counts where §3 says they read as findings. */
  function navRows(tabId, counts, activeSection) {
    var list = sectionsOf(tabId);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var section = list[i];
      var has = counts && core.isNumber(counts[section.id]);
      out.push({
        id: section.id,
        label: section.label,
        finding: section.finding === true,
        count: section.finding === true && has ? counts[section.id] : null,
        unread: section.finding === true && !has,
        active: section.id === activeSection,
        index: i,
      });
    }
    return out;
  }

  /**
   * Dirty is derived, never stored (`04-versioning.md` §5). A read-only model is never dirty: there
   * is no path by which it could be committed, so an indicator offering to commit it would be a lie.
   */
  function dirtyState(history, model, editable) {
    if (!history || !core.isObject(model)) return { dirty: false, label: null };
    if (editable === false) return { dirty: false, label: null };
    var dirty = TMV.vcs.isDirty(history, model);
    return { dirty: dirty, label: dirty ? 'Uncommitted changes' : null };
  }

  /**
   * What to say about a reconcile result (`04-versioning.md` §6, REQ-SYNC-001..006).
   *
   * The verdicts that must say **nothing** are as important as the ones that speak: identical
   * histories are silent (REQ-SYNC-004), and adopting the file's history when this browser had none
   * is a fact about storage rather than an event, so it is a toast that goes away by itself rather
   * than a banner the user has to dismiss.
   */
  function reconcileNotice(result) {
    var r = result || {};
    var verdict = r.verdict;
    if (!verdict) return null;
    if (verdict === TMV.storage.IDENTICAL) return null;

    if (verdict === TMV.storage.NO_LOCAL) {
      return {
        kind: 'toast',
        level: 'info',
        ref: 'sync.no-local',
        title: 'Using the history in this file',
        detail:
          'Nothing was stored for this model in this browser, so the file\'s history has been recorded ' +
          'locally. That is expected when storage was cleared or when this file has not been opened here before.',
      };
    }
    if (verdict === TMV.storage.EMBEDDED_AHEAD) {
      var adopted = core.isNumber(r.adopted) ? r.adopted : null;
      return {
        kind: 'toast',
        level: 'success',
        ref: 'sync.adopted',
        title: adopted === null
          ? 'The file was ahead, so its history was adopted'
          : 'Adopted ' + core.plural(adopted, 'commit', 'commits') + ' from the file',
        detail: 'The file and this browser are back in step, and the head is the file\'s head.',
      };
    }
    if (verdict === TMV.storage.LOCAL_AHEAD) {
      // The wording of this one is the table's, not this module's: §9 names it as one of the messages
      // the product has to get right, and a second copy of it here would drift from the first.
      return {
        kind: 'banner',
        key: 'local-ahead',
        level: TMV.notify.MESSAGES.localAhead.level,
        ref: 'sync.local-ahead',
        title: TMV.notify.MESSAGES.localAhead.title,
        detail: TMV.notify.MESSAGES.localAhead.body,
        actions: [
          { label: 'Export updated file', action: 'export-updated', dismiss: false },
        ],
      };
    }
    if (verdict === TMV.storage.DIVERGED) {
      return {
        kind: 'toast',
        level: 'warning',
        ref: 'sync.diverged',
        title: 'The file and this browser have both moved on',
        detail:
          'Nothing has been written. Both histories are shown side by side in History → Compare & Merge ' +
          'so the difference can be resolved deliberately.',
      };
    }
    if (verdict === TMV.storage.UNRELATED) {
      return {
        kind: 'toast',
        level: 'info',
        ref: 'sync.unrelated',
        title: 'This file is a separate model',
        detail:
          'It shares no history with anything stored here, so it has been registered alongside the ' +
          'others rather than combined with them.',
      };
    }
    return null;
  }

  /**
   * What to say about where storage is (`05-storage.md` §4, REQ-SYNC-008).
   *
   * `certain` is carried through rather than dropped: partitioning is a heuristic and an empty
   * registry on a first run looks exactly like it, so the partitioned notice is worded as a likely
   * explanation. §9's point is that this is the moment the product either explains the browser or
   * looks broken, and it cannot explain a guess as if it were a measurement.
   *
   * `indicator` is the header's short form of the same fact — see `renderStorageIndicator` — and its
   * presence *is* the switch for whether that badge appears. Only the two states where the reader
   * would otherwise be surprised by where their work went carry one; the third notice is the browser
   * working normally and a permanent badge for it would be a warning about nothing. Writing the two
   * words here keeps the state and its wordings decided in one place rather than in a second switch
   * that has to be kept in step with this one.
   */
  function storageNotice(storageState) {
    var s = storageState || {};
    if (s.available === false || s.context === TMV.storage.UNAVAILABLE) {
      return {
        kind: 'banner',
        key: 'storage-unavailable',
        level: 'warning',
        ref: 'storage.unavailable',
        indicator: 'Not saving',
        title: 'Changes will not be kept between visits',
        detail: TMV.notify.MESSAGES.storageUnavailable.body,
        actions: [{ label: 'Export a copy', action: 'export-now', dismiss: false }],
      };
    }
    if (s.context === TMV.storage.FILE_ORIGIN_PARTITIONED) {
      return {
        kind: 'banner',
        key: 'storage-partitioned',
        level: 'info',
        ref: 'storage.partitioned',
        indicator: 'Saved for this file only',
        title: s.certain === true
          ? 'This file remembers itself, not the others'
          : 'This file may keep its own storage',
        detail: core.isString(s.message) && s.message !== ''
          ? s.message
          : TMV.notify.MESSAGES.storagePartitioned.body,
        actions: [{ label: 'Export a copy', action: 'export-now', dismiss: false }],
      };
    }
    if (s.context === TMV.storage.FILE_ORIGIN) {
      return {
        kind: 'banner',
        key: 'storage-shared-origin',
        level: 'info',
        ref: 'storage.shared-origin',
        title: TMV.notify.MESSAGES.storageSharedOrigin.title,
        detail: TMV.notify.MESSAGES.storageSharedOrigin.body,
      };
    }
    return null;
  }

  /** §5's four recovery options, in the order of preference the document gives them. */
  function quotaNotice(level, detail) {
    var exhausted = level === 'exhausted';
    return {
      kind: 'banner',
      key: 'quota',
      level: 'warning',
      ref: 'storage.quota',
      title: exhausted ? 'There is no room left to save this' : 'Storage is nearly full',
      detail: detail || TMV.notify.MESSAGES.quotaWarning.body,
      actions: [
        { label: 'Export a copy', action: 'export-now', dismiss: false },
        { label: 'Make room', action: 'quota-options', dismiss: false },
      ],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 3. State
  //
  // One object, mutated in place, exposed through `state()`. It is not a model of the application —
  // it is the shell's own handful of facts, and every one of them is either read from storage, read
  // from the file, or a UI preference. Anything a view needs to remember belongs in the view.
  // ---------------------------------------------------------------------------------------------

  var state = {
    mounted: false,
    adapter: null,
    prefs: null,
    container: null,
    embedded: null,
    history: null,
    model: null,
    writeToken: null,
    editable: false,
    readOnlyReason: null,
    storage: { context: null, certain: true, message: null, available: true },
    registry: [],
    source: 'file',
    activeTab: TABS[0].id,
    activeSection: defaultSection(TABS[0].id),
    compare: null,
    reconcile: null,
    stash: null,
    failure: null,
    dirty: false,
    missing: [],
  };

  /** A preference write that reports when it did not happen, once, rather than on every toggle. */
  var prefsNoticeShown = false;

  function persistPrefs(patch) {
    if (!state.adapter || !TMV.storage) return { prefs: state.prefs, saved: false, reason: 'no-adapter' };
    var result = TMV.storage.writePrefs(state.adapter, patch);
    state.prefs = result.prefs;
    if (!result.saved && !prefsNoticeShown) {
      prefsNoticeShown = true;
      notify().banner({
        key: 'prefs-not-saved',
        level: 'info',
        title: 'This choice will not be remembered',
        body:
          'The setting applies for now, but this browser is not letting the page save anything, so it ' +
          'will be back to its default the next time this file is opened.',
      });
    }
    return result;
  }

  function notify() {
    return TMV.notify;
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Rendering
  // ---------------------------------------------------------------------------------------------

  /**
   * Where a theme class goes: the root element, which is what every `cds--*` rule is scoped to.
   *
   * The fallback to `body` is not a browser case — `documentElement` is always an element there — but
   * the test DOM models it as a layout stand-in with no attributes, and a theme that lands nowhere is
   * a behaviour no unit test could observe. `body` is the only other root there is, and the class
   * means the same thing on either.
   */
  function themeTarget() {
    var d = typeof document === 'undefined' ? null : document;
    if (!d) return null;
    var root = d.documentElement;
    if (root && typeof root.setAttribute === 'function') return root;
    return d.body && typeof d.body.setAttribute === 'function' ? d.body : null;
  }

  /**
   * Where the delegated listeners attach: the document body, which is an ancestor of every element the
   * shell owns. One listener per event type for the whole application (REQ-UI-008).
   */
  function shellRoot() {
    var d = typeof document === 'undefined' ? null : document;
    if (!d) return null;
    if (d.body && typeof d.body.addEventListener === 'function') return d.body;
    var root = d.documentElement;
    return root && typeof root.addEventListener === 'function' ? root : null;
  }

  /** The four theme classes are mutually exclusive and live on the root element (REQ-UI-005 AC1). */
  function applyTheme(value) {
    var theme = themeFor(value);
    rememberThemeFamily(theme);
    var root = themeTarget();
    if (root) {
      for (var i = 0; i < THEMES.length; i++) {
        core.setClass(root, THEMES[i].value, THEMES[i].value === theme);
      }
    }
    return theme;
  }

  function applySideNav() {
    var nav = core.byId(SIDENAV_ID);
    var collapsed = !!(state.prefs && state.prefs.sideNavCollapsed);
    if (nav) {
      core.setClass(nav, SIDENAV_COLLAPSED, collapsed);
      core.setClass(nav, SIDENAV_EXPANDED, !collapsed);
      core.setAttr(nav, 'aria-label', 'Sections of the ' + (tabFor(state.activeTab) || TABS[0]).label + ' tab');
    }
    var trigger = core.byId('tmv-sidenav-trigger');
    if (trigger) core.setAttr(trigger, 'aria-expanded', collapsed ? 'false' : 'true');
    return collapsed;
  }

  // --- tabs -------------------------------------------------------------------------------------

  function tabButton(tab) {
    return core.el('button', {
      type: 'button',
      class: 'cds--tabs__nav-item cds--tabs__nav-link',
      role: 'tab',
      id: 'tmv-tab-' + tab.id,
      'aria-controls': CONTENT_ID,
      'aria-selected': 'false',
      tabindex: '-1',
      'data-action': 'tab',
      'data-value': tab.id,
      text: tab.label,
    });
  }

  /**
   * Built once. Only attributes change afterwards, because the strip is where the roving tabindex
   * lives and a rebuild would move focus off the tab an arrow key just landed on.
   */
  function renderTabs() {
    var host = core.byId(TABS_ID);
    if (!host) return null;
    var existing = host.querySelectorAll('[role="tab"]');
    if (existing.length !== TABS.length) {
      core.clear(host);
      // The `role="tablist"` sits on the list, not on the tab strip's container: a tablist may only
      // contain tabs, and `#tmv-tabs` also carries Carbon's own wrapper classes.
      var list = core.el('div', { class: 'cds--tab--list', role: 'tablist', 'aria-label': TABLIST_LABEL });
      for (var i = 0; i < TABS.length; i++) list.appendChild(tabButton(TABS[i]));
      host.appendChild(list);
    }
    return updateTabs();
  }

  function updateTabs() {
    var host = core.byId(TABS_ID);
    if (!host) return null;
    var buttons = host.querySelectorAll('[role="tab"]');
    var active = null;
    for (var i = 0; i < buttons.length; i++) {
      var isActive = buttons[i].getAttribute('data-value') === state.activeTab;
      core.setAttr(buttons[i], 'aria-selected', isActive ? 'true' : 'false');
      core.setAttr(buttons[i], 'tabindex', isActive ? '0' : '-1');
      core.setClass(buttons[i], 'cds--tabs__nav-item--selected', isActive);
      if (isActive) active = buttons[i];
    }
    return active;
  }

  function tabButtonFor(tabId) {
    var host = core.byId(TABS_ID);
    if (!host) return null;
    var buttons = host.querySelectorAll('[role="tab"]');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-value') === tabId) return buttons[i];
    }
    return null;
  }

  // --- side nav ---------------------------------------------------------------------------------

  /**
   * The rail is 3rem wide and shows a monogram per section instead of a label. There is nothing in
   * this application's own icon set to name a section with — every mask icon it has is interface
   * chrome: a chevron, a tick, a magnifier, an overflow menu — so the rail used to fall back on
   * clipping the real label, which left a column reading "Ris", "Ris", "CIA", "Tru" at the two widths
   * where the rail is the default. That is the same unfinished-looking nav the button reset below was
   * written to fix, one breakpoint further down.
   *
   * A monogram is what is left: initials, taken from the words that carry the meaning. It is
   * `aria-hidden` because it is decoration — the label is still in the row, clipped rather than
   * removed, and is still what names the button.
   */
  function monogramPool(label) {
    var words = String(label === null || label === undefined ? '' : label).split(/[\s/–—-]+/);
    var parts = [];
    for (var i = 0; i < words.length; i++) {
      var word = words[i].replace(/[^0-9A-Za-z]/g, '');
      if (word) parts.push(word);
    }
    if (!parts.length) return '';
    // One letter from each word first, so the monogram reads as initials — and then the letters the
    // words did not spend, last word first, so that a pool can be drawn from when initials collide.
    var pool = '';
    for (var j = 0; j < parts.length; j++) pool += parts[j].charAt(0);
    for (var k = parts.length - 1; k >= 0; k--) pool += parts[k].slice(1);
    return pool;
  }

  function monogramFor(label, length) {
    var pool = monogramPool(label);
    if (!pool) return '?';
    return pool.slice(0, length).toUpperCase();
  }

  /* Two monograms in the same tab are enough to be ambiguous — the Risk tab alone has "Threat Risk
     Inputs" and "Trust Ratings", both of which reduce to TR — and a rail of two identical glyphs is
     worse than the clipped labels it replaced. So each tab's monograms are collected first and any
     that collide are grown a letter at a time until they differ. The cap is three: at 3rem a fourth
     letter is no longer a glyph, and every collision the current section lists resolves within it. */
  function monogramsFor(rows) {
    var taken = {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].label;
      var length = 2;
      var mark = monogramFor(label, length);
      while (taken[mark] && length < 3) {
        length += 1;
        mark = monogramFor(label, length);
      }
      taken[mark] = true;
      out.push(mark);
    }
    return out;
  }

  function renderSideNav() {
    var nav = core.byId(SIDENAV_ID);
    if (!nav) return null;
    var host = nav.querySelector('.cds--side-nav__items');
    if (!host) {
      host = core.el('ul', { class: 'cds--side-nav__items' });
      nav.appendChild(host);
    }
    core.clear(host);
    var rows = navRows(state.activeTab, countsFor(state.activeTab), state.activeSection);
    var marks = monogramsFor(rows);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var children = [
        core.el('span', { class: 'tmv-side-nav__monogram', text: marks[i], 'aria-hidden': 'true' }),
        core.el('span', { class: 'cds--side-nav__link-text', text: row.label }),
      ];
      if (row.finding) {
        // A filter that matches nothing still shows its number: `0` is a finding, and a row with no
        // count at all reads as a section rather than as a report (`07-ui.md` §3).
        children.push(core.el('span', {
          class: 'cds--side-nav__link-count' + (row.count === 0 ? ' cds--side-nav__link-count--zero' : ''),
          text: row.count === null ? '—' : String(row.count),
          'aria-hidden': 'true',
        }));
        children.push(core.el('span', {
          class: 'tmv-sr-only',
          text: row.count === null ? ' — count not available' : ' — ' + row.count + ' found',
        }));
      }
      var link = core.el('button', {
        type: 'button',
        class: 'cds--side-nav__link' + (row.active ? ' cds--side-nav__link--current' : ''),
        'data-action': 'side-nav',
        'data-value': row.id,
        // The rail has no room for the label, so the name has to be reachable another way than
        // reading it.
        title: row.label,
      }, children);
      if (row.active) core.setAttr(link, 'aria-current', 'true');
      host.appendChild(core.el('li', { class: 'cds--side-nav__item' }, [link]));
    }
    return host;
  }

  function countsFor(tabId) {
    var view = views[tabId];
    if (!view || typeof view.counts !== 'function') return null;
    try {
      var counts = view.counts(context());
      return counts && core.isObject(counts) ? counts : null;
    } catch (err) {
      // A count is a decoration. A view that cannot produce one loses the decoration, not the screen.
      return null;
    }
  }

  // --- header -----------------------------------------------------------------------------------

  function renderHeader() {
    renderSwitcher();
    renderActions();
    return true;
  }

  var switcherLayer = null;
  var menuLayers = [];

  function closeSwitcher() {
    if (switcherLayer && switcherLayer.isOpen && switcherLayer.isOpen()) switcherLayer.close('rebuild');
    switcherLayer = null;
  }

  /** Rebuilding a header menu while it is open would strand the layer registration it pushed. */
  function closeMenuLayers() {
    for (var i = 0; i < menuLayers.length; i++) {
      if (menuLayers[i] && menuLayers[i].isOpen && menuLayers[i].isOpen()) menuLayers[i].close('rebuild');
    }
    menuLayers = [];
  }

  /**
   * The model switcher (REQ-UI-004).
   *
   * A listbox, not a menu: one model is chosen out of several, which is the dropdown of §5's
   * inventory — and `role="option"` is what lets `aria-selected` mark the current model with a
   * property the option role actually supports. Deleting lives in the header's overflow menu, where
   * it can be a plain menuitem, because a delete control nested inside a listbox option is neither
   * valid ARIA nor reachable by keyboard.
   */
  function renderSwitcher() {
    var mount = core.byId('tmv-model-switcher');
    if (!mount) return null;
    closeSwitcher();
    core.clear(mount);

    var entries = switcherEntries(state.embedded, state.registry, {
      source: state.source,
      activeModelId: currentModelId(),
      session: sessionEntry(),
    });
    var current = null;
    for (var e = 0; e < entries.length; e++) if (entries[e].current) current = entries[e];
    if (!current && entries.length) current = entries[0];
    state.switcherEntries = entries;
    state.switcherCurrent = current;

    var name = renderedName(current);
    var trigger = core.el('button', {
      type: 'button',
      class: 'cds--header__action tmv-switcher',
      id: 'tmv-model-trigger',
      role: 'combobox',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': 'Open model: ' + name,
      'data-action': 'noop',
    }, [
      core.el('span', { class: 'tmv-switcher__name', text: name }),
      widgets.icon('chevron-down', 'tmv-switcher__caret'),
    ]);
    mount.appendChild(trigger);

    var list = core.el('ul', {
      class: 'cds--list-box__menu tmv-switcher__menu',
      role: 'listbox',
      id: 'tmv-model-list',
      'aria-label': 'Open model',
      hidden: true,
      tabindex: '-1',
    });

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var isCurrent = current === entry;
      list.appendChild(core.el('li', {
        class: 'cds--list-box__menu-item' + (isCurrent ? ' cds--list-box__menu-item--selected' : ''),
        role: 'option',
        id: 'tmv-model-option-' + i,
        tabindex: '-1',
        'data-action': 'switch-model',
        'data-value': entry.value,
        'aria-selected': isCurrent ? 'true' : 'false',
        'aria-label': entryName(entry, null),
      }, [
        core.el('span', { class: 'cds--list-box__menu-item__option' }, [
          core.el('span', { class: 'tmv-switcher__entry-name', text: renderedName(entry) }),
          core.el('span', { class: 'tmv-switcher__entry-meta', text: entryDetail(entry, null) }),
        ]),
        isCurrent ? widgets.icon('check') : null,
      ]));
    }

    mount.appendChild(list);

    switcherLayer = widgets.popup({
      trigger: trigger,
      menu: list,
      menuClass: 'cds--list-box__menu',
      openClass: 'cds--list-box--expanded',
      itemRole: 'option',
      highlightClass: 'cds--list-box__menu-item--highlighted',
      role: 'listbox',
      onSelect: function (node) {
        var value = node.getAttribute('data-value');
        if (value) switchModel(value);
      },
    });
    return switcherLayer;
  }

  /**
   * The header's overflow menus (`07-ui.md` §4).
   *
   * Import and export are both infrequent and neither deserves header space, so they are menu entries
   * that navigate to the Settings sections that own them. Delete is here rather than in the switcher,
   * and when the open model has no stored copy it is **absent** and replaced by a heading that says
   * why — §4 is explicit that it is not present-and-disabled.
   */
  function renderActions() {
    var mount = core.byId('tmv-header-actions');
    if (!mount) return null;
    closeMenuLayers();
    core.clear(mount);
    var current = state.switcherCurrent || null;
    var del = deleteAvailability(current);

    var fileTrigger = core.el('button', {
      type: 'button',
      class: 'cds--header__action',
      id: 'tmv-menu-file-trigger',
      'aria-label': 'Model and file actions',
      'aria-haspopup': 'menu',
    }, [widgets.icon('chevron-down')]);

    var fileEntries = [
      { label: 'Import a threat model…', action: 'goto', value: 'import' },
      { label: 'Export this model…', action: 'goto', value: 'export' },
      { separator: true },
    ];
    // Absent, not disabled, on a read-only model (§9): a dead control in a menu invites a hunt for
    // whatever would make it live. It sits here rather than on a switcher row for the reason §4 gives
    // for delete — a control nested inside a listbox option is not valid ARIA and cannot be reached
    // from the keyboard.
    if (state.editable) {
      fileEntries.push({ label: 'Edit model details…', action: 'edit-model' });
    }
    if (del.available) {
      fileEntries.push({ label: 'Delete this model from this browser…', action: 'delete-stored', danger: true });
    } else {
      fileEntries.push({ heading: del.reason });
    }
    mount.appendChild(fileTrigger);
    var fileMenu = widgets.overflowMenu({
      trigger: fileTrigger,
      id: 'tmv-menu-file',
      entries: fileEntries,
      onSelect: function (node) {
        var action = node.getAttribute('data-action');
        if (action === 'goto') go('settings', node.getAttribute('data-value'));
        else if (action === 'edit-model') editModelDetails();
        else if (action === 'delete-stored') confirmDeleteStored();
      },
    });
    menuLayers.push(fileMenu);
    mount.appendChild(fileMenu.element);

    var themeTrigger = core.el('button', {
      type: 'button',
      class: 'cds--header__action',
      id: 'tmv-menu-theme-trigger',
      'aria-label': 'Theme: ' + themeLabel(state.prefs ? state.prefs.theme : null),
      'aria-haspopup': 'menu',
    }, [widgets.icon('chevron-down')]);

    /*
     * The light/dark switch, and it is a real switch control rather than a themed button:
     * `role="switch"` with `aria-checked` is what tells a screen reader the control has two states and
     * which one is current, and it is the role §8's accessibility rules expect for a binary toggle.
     *
     * The icons are `aria-hidden` and the state is carried by `aria-checked`, so the control is never
     * a picture of a sun meaning "dark mode is off" that a screen reader has to guess at. It sits
     * before the two overflow menus because it is the one theme control worth a single click; the
     * four-way choice stays in the menu beside it and in Settings → Appearance (REQ-UI-005).
     *
     * Both glyphs are in the markup at once and `00-app.css` cross-fades them on `aria-checked`,
     * which is why there is one button here rather than two that swap. Swapping the mask would mean
     * re-rendering the header on every press and would make the control a moving target to click.
     */
    var dark = themeIsDark();
    var themeToggle = core.el('button', {
      type: 'button',
      class: 'cds--header__action tmv-theme-toggle',
      id: 'tmv-theme-toggle',
      role: 'switch',
      'aria-checked': dark ? 'true' : 'false',
      'aria-label': 'Dark mode',
      title: dark ? 'Switch to a light theme' : 'Switch to a dark theme',
      'data-action': 'toggle-theme',
    }, [
      widgets.icon('sun', 'tmv-theme-toggle__icon tmv-theme-toggle__icon--sun'),
      widgets.icon('moon', 'tmv-theme-toggle__icon tmv-theme-toggle__icon--moon'),
    ]);
    mount.appendChild(themeToggle);

    var themeEntries = [];
    for (var i = 0; i < THEMES.length; i++) {
      var theme = THEMES[i];
      themeEntries.push({
        label: theme.label,
        action: 'theme',
        value: theme.value,
        current: state.prefs && state.prefs.theme === theme.value,
      });
    }
    mount.appendChild(themeTrigger);
    var themeMenu = widgets.overflowMenu({
      trigger: themeTrigger,
      id: 'tmv-menu-theme',
      entries: themeEntries,
      onSelect: function (node) {
        if (node.getAttribute('data-action') === 'theme') setTheme(node.getAttribute('data-value'));
      },
    });
    menuLayers.push(themeMenu);
    mount.appendChild(themeMenu.element);
    return mount;
  }

  // --- content -----------------------------------------------------------------------------------

  /**
   * The four full-screen states of `07-ui.md` §6 that stop the application rather than degrade it.
   *
   * They are rendered into the content region with the navigation hidden, because every one of them
   * means "there is nothing to navigate to": a container that did not parse, a chain that did not
   * verify, a model that was loaded as read-only. The chrome comes back through `clearFailure`.
   */
  function failureScreen(spec) {
    var actions = [];
    for (var i = 0; i < (spec.actions || []).length; i++) {
      var a = spec.actions[i];
      actions.push(widgets.button({ label: a.label, kind: a.kind || 'tertiary', action: a.action, value: a.value }));
    }
    var children = [
      core.el('p', { class: 'cds--type-heading-03', text: spec.title || 'This file cannot be opened' }),
      core.el('p', { class: 'tmv-screen__body', text: spec.body || '' }),
    ];
    if (spec.detail) children.push(core.el('p', { class: 'tmv-screen__detail', text: spec.detail }));
    if (spec.actions && spec.actions.length) {
      children.push(core.el('div', { class: 'tmv-screen__actions' }, actions));
    }
    if (spec.raw) {
      children.push(core.el('p', {
        class: 'tmv-screen__lead',
        text:
          'The text below is the data block exactly as it appears in the file. Copying it out is enough ' +
          'to recover the model without this application reading it as markup.',
      }));
      children.push(widgets.snippet({ text: spec.raw, collapsible: true }).element);
    }
    return core.el('div', { class: 'tmv-screen' + (spec.danger ? ' tmv-screen--danger' : '') }, children);
  }

  function renderContent() {
    var host = core.byId(CONTENT_ID);
    if (!host) return null;
    var tab = tabFor(state.activeTab) || TABS[0];
    core.setAttr(host, 'role', 'tabpanel');
    core.setAttr(host, 'tabindex', '0');
    core.setAttr(host, 'aria-labelledby', 'tmv-tab-' + tab.id);
    core.clear(host);

    if (state.failure) {
      host.appendChild(failureScreen(state.failure));
      return host;
    }

    host.appendChild(core.el('h1', { class: 'tmv-view__title', text: tab.label }));

    var view = views[tab.id];
    if (!view || typeof view.render !== 'function') {
      host.appendChild(widgets.emptyState({
        title: 'This screen is not available',
        body:
          'The ' + tab.label + ' tab has no implementation in this build. Nothing is wrong with the ' +
          'file — export and every other tab still work.',
      }));
      return host;
    }

    var out;
    try {
      out = view.render(context());
    } catch (err) {
      // One view failing is not the application failing. Report it, keep the shell usable, and let
      // the user switch tabs — the error is in the retained log either way (REQ-UI-009 AC).
      notify().failure({
        title: 'The ' + tab.label + ' tab could not be drawn',
        detail: err && err.message ? err.message : 'An unexpected error.',
        ref: 'shell.render.' + tab.id,
      });
      host.appendChild(widgets.emptyState({
        title: 'This screen could not be drawn',
        body:
          'The rest of the application still works: other tabs, export, and the history are unaffected. ' +
          'The error has been recorded in the retained log.',
      }));
      return host;
    }
    if (out && out.element) host.appendChild(out.element);
    else if (out) host.appendChild(out);
    return host;
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Context — what a view is handed
  // ---------------------------------------------------------------------------------------------

  /**
   * The object every view renders from.
   *
   * It is deliberately small and deliberately read-only in intent: a view reads the model, asks the
   * shell to change it through `edit`, and asks the shell to move through `go`. A view that assigned
   * to `state.model` would bypass undo, the dirty indicator and the render, which is three bugs that
   * would show up in three different places.
   */
  function context() {
    var tab = tabFor(state.activeTab) || TABS[0];
    return {
      shell: api,
      state: state,
      model: state.model,
      history: state.history,
      container: state.container,
      embedded: state.embedded,
      tab: tab.id,
      tabLabel: tab.label,
      section: state.activeSection,
      sectionLabel: (sectionFor(tab.id, state.activeSection) || {}).label || null,
      sections: sectionsOf(tab.id),
      editable: state.editable,
      readOnlyReason: state.readOnlyReason,
      adapter: state.adapter,
      prefs: state.prefs,
      registry: state.registry,
      storage: state.storage,
      compare: state.compare,
      reconcile: state.reconcile,
      stash: state.stash,
      edit: edit,
      go: go,
      refresh: refresh,
      counts: function (tabId) { return countsFor(tabId || state.activeTab); },
    };
  }

  function currentModelId() {
    if (state.model && core.isString(state.model.modelId)) return state.model.modelId;
    if (state.embedded && core.isString(state.embedded.modelId)) return state.embedded.modelId;
    return null;
  }

  /**
   * The switcher entry for an import this browser would not store, or `null` when there is none.
   *
   * It describes the *open* history, so it is built from `state` rather than remembered: a session
   * import that later gets committed and saved stops being a session import the moment the save
   * succeeds, and a remembered entry would keep claiming otherwise.
   */
  function sessionEntry() {
    if (state.source !== 'session' || !state.model) return null;
    return {
      modelId: currentModelId(),
      name: state.model.name,
      commitCount: state.history && core.isArray(state.history.commits) ? state.history.commits.length : 0,
      headCommitId: state.history ? state.history.head : null,
      bytes: 0,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Navigation
  // ---------------------------------------------------------------------------------------------

  /**
   * Move to a tab, and optionally a section of it.
   *
   * The active tab is mirrored to preferences, never to the URL: `02-architecture.md` §10 rules out
   * the history API because `pushState` is unreliable on `file://`, and a fragment would put a second,
   * less reliable copy of the navigation in a place the user can bookmark and then open out of order.
   */
  function go(tabId, sectionId) {
    var tab = tabFor(tabId) ? tabId : state.activeTab;
    var section = sectionFor(tab, sectionId) ? sectionId : defaultSection(tab);
    var changed = tab !== state.activeTab || section !== state.activeSection;
    state.activeTab = tab;
    state.activeSection = section;
    if (state.mounted) {
      persistPrefs({ activeTab: tab });
      updateTabs();
      applySideNav();
      renderSideNav();
      renderContent();
      if (changed) {
        var name = (tabFor(tab) || {}).label + (sectionFor(tab, section) ? ' — ' + sectionFor(tab, section).label : '');
        notify().announce(name);
      }
    }
    return { tab: tab, section: section, changed: changed };
  }

  function refresh(options) {
    var opts = options || {};
    if (opts.tab) state.activeTab = normaliseTab(opts.tab, state.activeTab);
    if (opts.section !== undefined) state.activeSection = sectionFor(state.activeTab, opts.section) ? opts.section : defaultSection(state.activeTab);
    if (!state.mounted) return false;
    updateTabs();
    applySideNav();
    renderSideNav();
    renderHeader();
    renderContent();
    syncDirty();
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The working copy
  // ---------------------------------------------------------------------------------------------

  function syncDirty() {
    var d = dirtyState(state.history, state.model, state.editable);
    if (TMV.forms && typeof TMV.forms.setDirty === 'function') {
      TMV.forms.setDirty(d.dirty, { label: d.label || undefined });
    }
    state.dirty = d.dirty;
    return d;
  }

  /** Recompute the dirty indicator and re-render whichever screen is showing. */
  function afterModelChange(reason) {
    syncDirty();
    if (state.mounted) {
      renderSideNav();
      renderContent();
      renderSwitcher();
      renderActions();
    }
    return state.model;
  }

  /**
   * Apply an edit to the working copy.
   *
   * The only way the model changes. `previous` goes onto the undo stack *before* the swap, so undo
   * restores the model as it was rather than reconstructing it — which is what makes REQ-EDIT-010's
   * "identifiers **and references**" hold for a delete (`15-forms.js` decision 1).
   */
  function edit(nextModel, options) {
    var opts = options || {};
    // A structural check, not `M.validate` — the point is to catch a caller that passed a *part* of a
    // model (`M.update` returns the entity it changed, not the model), which would otherwise replace
    // the working copy with an entity and show up much later as a view rendering nothing.
    if (!core.isObject(nextModel) || !core.isString(nextModel.modelId) || nextModel.modelId === '') {
      throw TMV.error('SHELL_MODEL', 'edit() takes a whole threat model; it was given something else.');
    }
    if (!state.editable) {
      notify().failure({
        title: 'This model cannot be edited here',
        detail: state.readOnlyReason || 'The model was opened read-only.',
        ref: 'edit.read-only',
      });
      return false;
    }
    var previous = state.model;
    var changed = !previous || TMV.vcs.modelHashOf(previous) !== TMV.vcs.modelHashOf(nextModel);
    if (!changed) return false;
    if (opts.undo !== false && previous) TMV.forms.undo.push(opts.label || 'Edit', previous);
    state.model = nextModel;
    afterModelChange(opts.reason || 'edit');
    if (opts.announce) notify().announce(opts.announce);
    return true;
  }

  function undo() {
    if (!state.editable) return false;
    var restored = TMV.forms.undo.undo();
    if (!restored) {
      notify().announce('There is nothing to undo');
      return false;
    }
    state.model = restored.model;
    afterModelChange('undo');
    notify().announce('Undid ' + restored.label);
    return true;
  }

  /** Where the current head's model is, for "what is being discarded". */
  function headModel() {
    if (!state.history) return null;
    return TMV.vcs.headModel(state.history);
  }

  /**
   * Make the working copy the head commit's model again, without calling it an edit.
   *
   * This exists for the two operations that write a commit *whose content the working copy already
   * agrees with* — a merge (REQ-VCS-011) and a revert (REQ-VCS-013). Both are reached from History, and
   * both end with the new head's model being what should be on screen. Going through `edit()` would be
   * wrong twice over: it would push an undo step for a change the user did not make, and it would leave
   * the working copy dirty the instant after a commit, so the header would offer to commit a merge that
   * had just been committed.
   *
   * The model is read back out of the history rather than taken from the caller: materialising the new
   * head is the round trip REQ-VCS-006 requires, and adopting a model from anywhere else would put
   * content on screen that no commit is known to reproduce.
   */
  function resetToHead() {
    if (!state.history) return null;
    var model = headModel();
    if (!core.isObject(model)) return null;
    state.model = model;
    TMV.forms.undo.clear();
    syncDirty();
    if (state.mounted) {
      renderHeader();
      renderContent();
    }
    return state.model;
  }

  /**
   * Persist the history behind the adapter (REQ-STORE-001 — the shell never touches web storage
   * directly, and the static check that enforces this reads the built script, comments included).
   *
   * Every refusal `saveModel` can make is a thing the user has to be told about, and each one has its
   * own answer: a quota refusal is a choice (§5's recovery options), a conflict is another tab (§6),
   * and read-only is the banner that is already on screen.
   */
  function persistHistory(reason) {
    if (!state.adapter || !TMV.storage) return { ok: false, reason: 'no-adapter' };
    var modelId = currentModelId();
    if (!modelId) return { ok: false, reason: 'no-model-id' };
    var result;
    try {
      result = TMV.storage.saveModel(state.adapter, state.history, {
        modelId: modelId,
        name: state.model && core.isString(state.model.name) ? state.model.name : null,
        expectedWriteToken: state.writeToken,
      });
    } catch (err) {
      notify().failure({
        title: 'The history could not be saved in this browser',
        detail: err && err.message ? err.message : 'An unexpected storage error.',
        ref: 'storage.save',
      });
      return { ok: false, reason: 'threw', error: err };
    }
    if (result.ok) {
      state.writeToken = result.writeToken;
      reloadRegistry();
      return result;
    }
    if (result.reason === 'quota') {
      reportQuota(result.level, result.message);
    } else if (result.reason === 'conflict') {
      // Not a failure the user caused and not one to retry blindly: another tab has a newer head, and
      // §6's answer is to reload and compare rather than to overwrite (REQ-VCS-012's shape).
      notify().failure({
        title: 'Another tab saved this model first',
        detail: result.message + ' Nothing was overwritten. Reopening the file, or comparing the two histories, is the safe next step.',
        ref: 'storage.conflict',
      });
    } else if (result.reason !== 'read-only') {
      notify().failure({
        title: 'The history was not saved',
        detail: result.message || 'The storage adapter refused the write.',
        ref: 'storage.refused',
      });
    }
    return result;
  }

  function reloadRegistry() {
    if (!state.adapter || !TMV.storage) return state.registry;
    state.registry = TMV.storage.listModels(state.adapter);
    return state.registry;
  }

  // --- garbage collection (REQ-STORE-008, `04-versioning.md` §9) -----------------------------------

  /**
   * What collection would remove, before anything is removed.
   *
   * REQ-STORE-008 requires the report first and REQ-STORE-006 forbids deleting commits without an
   * explicit confirmation, so this is a separate call from `runCollection` and it is the one the UI
   * shows. `04-versioning.md` §9 is the reason it is here rather than anywhere else: **reachable
   * commits are never removed**, so what this reclaims is unreachable commits and the keyframes
   * compaction made redundant — it is a pressure valve under the quota limit, not maintenance.
   */
  function collectionReport() {
    if (!state.adapter || !TMV.storage) return { ok: false, reason: 'no-adapter' };
    if (!state.history) return { ok: false, reason: 'no-history' };
    var id = currentModelId();
    if (!id) return { ok: false, reason: 'no-model-id' };
    try {
      return { ok: true, report: TMV.storage.collect(state.adapter, state.history, { modelId: id }) };
    } catch (err) {
      return { ok: false, reason: 'threw', error: err };
    }
  }

  /**
   * Run it, after the user has seen the report and said yes.
   *
   * The compacted history is adopted *and saved from inside* `collect`'s `save` callback, because that
   * callback is the only moment at which the re-keyframed representation exists and the meta pointer
   * has already been moved — writing the old history afterwards would put the redundant keyframes
   * straight back.
   */
  function runCollection() {
    if (!state.editable) {
      return { ok: false, reason: 'read-only', message: state.readOnlyReason };
    }
    var preview = collectionReport();
    if (!preview.ok) return preview;
    var id = currentModelId();
    var result;
    try {
      result = TMV.storage.collect(state.adapter, state.history, {
        modelId: id,
        confirm: true,
        save: function (compacted) {
          state.history = compacted;
          persistHistory('collect');
        },
      });
    } catch (err) {
      notify().failure({
        title: 'The stored history could not be compacted',
        detail: err && err.message ? err.message : 'An unexpected storage error.',
        ref: 'store.collect',
      });
      return { ok: false, reason: 'threw', error: err };
    }
    reloadRegistry();
    refresh();
    return { ok: true, report: result };
  }

  // --- commit and discard ------------------------------------------------------------------------

  /**
   * Commit the working copy (REQ-VCS-004, REQ-EDIT-006).
   *
   * The dialog is `15-forms.js`'s, because it already renders the change summary from the same
   * comparison the commit will make. `vcs.commit` mutates the history it is given, so it is called
   * with the live one — and the only refusal it can make (an empty commit) is answered in the dialog
   * rather than closing on a user who asked for a commit.
   */
  function commit(options) {
    var opts = options || {};
    if (!state.editable) {
      notify().failure({ title: 'This model cannot be committed here', detail: state.readOnlyReason, ref: 'commit.read-only' });
      return null;
    }
    if (!state.history || !state.model) return null;
    var d = dirtyState(state.history, state.model, state.editable);
    if (!d.dirty && opts.allowEmpty !== true) {
      notify().announce('There is nothing to commit');
      return null;
    }
    return TMV.forms.commitDialog({
      history: state.history,
      workingModel: state.model,
      headModel: headModel(),
      author: (state.prefs && state.prefs.identity) || { name: '', email: '' },
      onCommit: function (record) {
        // A commit moves the history, so the undo stack's entries describe a model that is now a
        // commit of its own. `15-forms.js` leaves that decision to the caller on purpose.
        TMV.forms.undo.clear();
        syncDirty();
        persistHistory('commit');
        renderHeader();
        renderContent();
        notify().outcome({
          level: 'success',
          title: 'Committed ' + core.shortId(record && record.id),
          detail: record && record.message ? core.oneLine(record.message) : null,
          ref: 'vcs.commit',
        });
        if (opts.onDone) opts.onDone(record);
      },
      onRefused: function (result) {
        notify().failure({
          title: 'The commit was refused',
          detail: result && result.message ? result.message : 'The working copy matches the head commit.',
          ref: 'vcs.commit.refused',
        });
      },
    });
  }

  function discard(options) {
    var opts = options || {};
    if (!state.editable || !state.history) return null;
    return TMV.forms.discardDialog({
      history: state.history,
      workingModel: state.model,
      headModel: headModel(),
      onDiscard: function (restored) {
        state.model = restored;
        // Undo is cleared with the discard: leaving it would let a second action put back exactly what
        // the user just confirmed they wanted gone (REQ-EDIT-007).
        TMV.forms.undo.clear();
        afterModelChange('discard');
        notify().outcome({ level: 'info', title: 'Changes discarded', detail: 'The working copy matches the head commit again.', ref: 'edit.discard' });
        if (opts.onDone) opts.onDone(restored);
      },
    });
  }

  // --- models ------------------------------------------------------------------------------------

  function isDirtyNow() {
    return dirtyState(state.history, state.model, state.editable).dirty;
  }

  /**
   * Model switch, with the guard REQ-STORE-004 AC1 requires: commit, stash, or discard — never a
   * silent discard, and never a silent carry-over of one model's edits into another's.
   *
   * Commit is offered first because it is the only one of the three that keeps the work as work.
   */
  function guardSwitch(done) {
    if (!isDirtyNow()) {
      done();
      return null;
    }
    var instance = widgets.modal({
      title: 'You have changes that are not committed',
      size: 'sm',
      danger: true,
      body: [
        core.el('p', {
          text:
            'The working copy has changes that are not in any commit. Opening another model would leave ' +
            'them attached to the wrong one, so they have to go somewhere first.',
        }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'Stashing keeps them in this browser for the rest of this session and is offered again from ' +
            'History → Stashes. Discarding is the only one of these that loses anything.',
        }),
      ],
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Discard the changes', kind: 'danger', action: 'discard' },
        { label: 'Stash them', kind: 'tertiary', action: 'stash' },
        { label: 'Commit them first', kind: 'primary', action: 'commit' },
      ],
    });
    instance.open();

    TMV.forms.modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action === 'discard') {
        instance.close('discard');
        state.model = headModel();
        TMV.forms.undo.clear();
        syncDirty();
        done();
        return;
      }
      if (action === 'stash') {
        var stash = TMV.vcs.createStash(state.history, state.model, { reason: 'Stashed to switch models' });
        instance.close('stash');
        if (stash) {
          stash.modelId = currentModelId();
          state.stash = stash;
          notify().outcome({
            level: 'info',
            title: 'Changes stashed',
            detail:
              core.plural(stash.delta.length, 'change', 'changes') + ' kept in this browser. They are ' +
              'reapplied from History → Stashes.',
            ref: 'edit.stash',
          });
        }
        state.model = headModel();
        TMV.forms.undo.clear();
        syncDirty();
        done();
        return;
      }
      if (action === 'commit') {
        instance.close('commit');
        var dialog = commit({
          onDone: function () { done(); },
        });
        if (!dialog) {
          // Nothing to commit after all — the working copy had already been brought back in step.
          done();
        }
      }
    });
    return instance;
  }

  /**
   * A last word before an import that only exists in this page is abandoned.
   *
   * `guardSwitch` protects uncommitted *changes*; this protects the model itself. They are different
   * losses and either can happen without the other: a session import with a clean working copy has
   * nothing for `guardSwitch` to ask about, and switching away from it destroys the only copy there
   * is. Committing does not help — a commit lives in the same page (`05-storage.md` §8).
   */
  function guardAbandonSession(done) {
    if (state.source !== 'session') {
      done();
      return null;
    }
    var instance = widgets.modal({
      title: 'This model is not saved anywhere',
      size: 'sm',
      danger: true,
      body: [
        core.el('p', {
          text:
            'The model open now was imported into this page, and this browser is not storing anything, so ' +
            'this page is the only place it exists. Opening another model will lose it.',
        }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'Exporting writes a file and does not depend on storage working, so it is the way to keep it. ' +
            'Nothing else here can.',
        }),
      ],
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Export it first', kind: 'tertiary', action: 'export' },
        { label: 'Open the other model anyway', kind: 'danger', action: 'leave' },
      ],
    });
    instance.open();
    TMV.forms.modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action === 'export') {
        // The switch does not continue: exporting and opening are two decisions, and the user has only
        // made the first one. Doing both would open the other model with the exported file still
        // sitting in a download they have not looked at.
        instance.close('export');
        go('settings', 'export');
        return;
      }
      if (action === 'leave') {
        instance.close('leave');
        done();
      }
    });
    return instance;
  }

  /** The switcher entry for a value, from the list the switcher last rendered. */
  function entryFor(value) {
    var entries = state.switcherEntries || [];
    for (var i = 0; i < entries.length; i++) if (entries[i].value === value) return entries[i];
    return null;
  }

  /**
   * Open an entry, having asked whatever has to be asked first.
   *
   * Session first, then dirty: the two questions are asked in that order because leaving the page's
   * only copy is the larger act, and answering the smaller one first would commit work to a model
   * that is about to be thrown away.
   *
   * `then` runs after the open, and only if it happened. It cannot be a caller checking afterwards,
   * because a guard may ask its question in a dialog and return immediately — the answer arrives long
   * after the call, which is exactly when a "did it open?" test on the way out would be worthless.
   */
  function guardedOpen(entry, then) {
    return guardAbandonSession(function () {
      return guardSwitch(function () {
        var opened = openEntry(entry, { announce: true });
        if (opened && then) then();
        return opened;
      });
    });
  }

  function switchModel(value) {
    var target = entryFor(value);
    if (!target) return null;
    if (target.current) return null;
    return guardedOpen(target);
  }

  /**
   * Edit the model's own name and description (REQ-EDIT-011).
   *
   * Two shapes of call, and the difference between them matters:
   *
   *   - no id, or the id of the model already open → the dialog opens on the working copy;
   *   - the id of another model the switcher lists → that model is opened first, through the same
   *     guards a switcher selection goes through, and the dialog opens on it.
   *
   * The alternative for the second case — committing a rename straight to a history nobody is looking
   * at — is the shape of `confirmDeleteStored`, and it would have to reimplement the quota, write-token
   * and conflict handling that `persistHistory` owns. Its cost is real and worth naming: cancelling the
   * dialog leaves the other model open, which is where that model's own Open action would have left the
   * user anyway, and which the switcher immediately shows.
   *
   * A read-only model is refused here, before any dialog exists, so there is one place that decides
   * whether the edit may happen at all rather than one per affordance.
   */
  function editModelDetails(modelId) {
    if (!state.editable) {
      notify().failure({
        title: 'This model cannot be edited',
        detail: state.readOnlyReason || 'The model was opened read-only, so its details cannot be changed.',
        ref: 'shell.edit-model.read-only',
      });
      return null;
    }
    if (core.isString(modelId) && modelId !== currentModelId()) {
      var target = entryFor(modelId);
      if (!target) return null;
      return guardedOpen(target, function () { modelDetailsDialogFor(state.model); });
    }
    return modelDetailsDialogFor(state.model);
  }

  /**
   * The dialog, and what happens when it is saved.
   *
   * The next model comes from `forms.withModelFields` — a copy of the root with the two changed fields
   * written into it — so the entity arrays and the `x` passthrough bags are the objects they already
   * were. A rename has no path by which it could reach an imported file's uninterpreted data, which is
   * the property ADR-0004 is protecting.
   *
   * The save goes through `edit`, so it is an ordinary working-copy change: dirty indicator, undo, the
   * commit dialog's summary, and nothing written to storage until a commit.
   */
  function modelDetailsDialogFor(model) {
    return TMV.forms.modelDetailsDialog({
      model: model,
      disabled: !state.editable,
      onSave: function (fields) {
        edit(TMV.forms.logic.withModelFields(state.model, fields), {
          reason: 'edit-model',
          label: 'Edit model details',
        });
      },
    });
  }

  /**
   * Open the model an entry names.
   *
   * The file entry and the stored entry for the same model id are two different histories, which is
   * exactly the situation `04-versioning.md` §6 exists for — so selecting the file entry when the
   * stored copy is ahead is a deliberate step backwards, and it says so before it does it.
   */
  function openEntry(entry, options) {
    var opts = options || {};
    if (entry.fromFile) return openEmbedded(opts);
    return openStored(entry.modelId, opts);
  }

  function openEmbedded(options) {
    var opts = options || {};
    var container = state.container;
    var history = container && core.isObject(container.history) ? container.history : null;
    if (!history || !core.isArray(history.commits) || !history.commits.length) {
      notify().failure({
        title: 'This file carries no history',
        detail: 'There is nothing in the file to open, so the model being shown has been left alone.',
        ref: 'shell.open-file',
      });
      return false;
    }
    var adopted = TMV.vcs.adopt(history);
    if (!adopted.verdict.ok) {
      var problems = adopted.verdict.problems || [];
      notify().failure({
        title: 'The history in this file did not verify',
        detail: problems.length
          ? problems[0].message + (problems.length > 1 ? ' (' + core.plural(problems.length - 1, 'more problem', 'more problems') + ')' : '')
          : 'The commit chain in the file does not check out, so it has not been opened.',
        ref: 'shell.open-file.chain',
      });
      return false;
    }
    state.history = adopted.history;
    state.model = TMV.vcs.headModel(state.history);
    state.source = 'file';
    state.compare = null;
    settleAfterOpen(opts);
    if (opts.persist === false) {
      // Recording the embedded model is what makes it switchable, and it is what boot does every time
      // this file is opened. After a delete it must not happen, or the delete would undo itself inside
      // the same page load: the user removes the stored copy and the write that follows it puts the
      // copy straight back. The next time this file is opened, the embedded model is recorded again —
      // that is a consequence of opening a file, not a way round the delete.
      //
      // With no stored copy there is no meta record, so the write token has to be dropped with it: a
      // token that outlives its record makes every later save look like another tab's write.
      state.writeToken = null;
    } else {
      persistHistory('open-file');
    }
    return true;
  }

  function openStored(modelId, options) {
    var opts = options || {};
    if (!state.adapter || !TMV.storage) return false;
    var loaded;
    try {
      loaded = TMV.storage.loadModel(state.adapter, modelId);
    } catch (err) {
      notify().failure({
        title: 'That model could not be read',
        detail: err && err.message ? err.message : 'An unexpected storage error.',
        ref: 'shell.open-stored',
      });
      return false;
    }
    if (!loaded.ok) {
      notify().failure({
        title: 'That model could not be read',
        detail: loaded.message || 'Nothing usable was stored for it.',
        ref: 'shell.open-stored',
      });
      reloadRegistry();
      renderSwitcher();
      return false;
    }
    state.history = loaded.history;
    state.model = loaded.model;
    state.writeToken = loaded.meta ? loaded.meta.writeToken : null;
    state.source = 'stored';
    state.compare = null;
    settleAfterOpen(opts);
    persistPrefs({ lastModelId: modelId });
    persistHistory('open-stored');
    return true;
  }

  function settleAfterOpen(opts) {
    TMV.forms.undo.clear();
    notify().resetForModelSwitch();
    state.stash = null;
    state.failure = null;
    applySideNav();
    refresh();
    if (opts.announce) {
      notify().outcome({
        level: 'info',
        title: 'Opened ' + (state.model && state.model.name ? state.model.name : 'the model'),
        detail: state.source === 'file'
          ? 'Showing the history carried by the file.'
          : state.source === 'session'
            ? 'Showing the model imported in this session. This browser is not storing it, so it exists only in this page until it is exported.'
            : 'Showing the history stored in this browser.',
        ref: 'shell.switch',
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 7b. Import (REQ-IMP-001 … REQ-IMP-010)
  //
  // The parsing all happens in `10-import.js`, which reads the incoming document as text and hands
  // back a model. What lives here is the part `10-import.js` deliberately does not do: deciding
  // *which* model the result becomes, whether the browser will hold on to it, and what the user is
  // told. `runImport` writes nothing to storage and touches no state — that separation is what makes
  // "import, don't open" (08-security.md §3) checkable, and it must survive here.
  // ---------------------------------------------------------------------------------------------

  /** A name for the imported model that says where it came from when the model itself does not. */
  function importName(model, filename) {
    if (model && core.isString(model.name) && model.name !== '') return model.name;
    var base = core.isString(filename) ? filename.replace(/\.[^.]*$/, '') : '';
    return base !== '' ? base : 'Imported threat model';
  }

  /**
   * Install an import result as the open model.
   *
   * Three things have to be true at once and they pull in different directions: the imported model
   * must be the one on screen, the history must be the imported model's own (REQ-IMP-005: a single
   * root commit, never a fabricated past), and it must be saved if this browser is willing. The save
   * is attempted rather than assumed — REQ-STORE-007 says an application with no working storage is
   * still an application, so a failed save downgrades the model to this session rather than failing
   * the import.
   */
  function adoptImported(result, options) {
    var opts = options || {};
    if (!result || !result.model || !core.isObject(result.model)) {
      return { ok: false, reason: 'no-model' };
    }
    var model = result.model;

    // REQ-IMP-007's "target an existing model" branch: the caller has already asked, and replacing
    // means the incoming model keeps the id it arrived with. Importing as a new model mints a fresh
    // id instead, because two stored entries sharing an id would be a collision the registry cannot
    // represent — `05-storage.md` keys stored models by it.
    var relabelled =
      !!(opts.modelId && core.isString(opts.modelId) && opts.modelId !== model.modelId);
    if (relabelled) {
      model = core.deepCopy(model);
      model.modelId = opts.modelId;
    }

    var history;
    if (relabelled && core.isObject(result.rootCommit) && core.isString(result.rootCommit.message)) {
      // An interchange import's history is not the document's — it is the one root commit `runImport`
      // built from the model it had just mapped (REQ-IMP-005), and `result.rootCommit` is how it is
      // identified. That commit cannot survive a relabelling: its id is a hash over the model it
      // snapshots, and the snapshot carries the *old* model id, so adopting it would put a model
      // whose id contradicts its own history on screen. Rebuilding it from the relabelled model is
      // the honest answer, and it is not fabrication: the commit is one this application wrote
      // moments ago, not a past the document arrived with. Same author, same message, same instant —
      // only the model, and therefore the id, differ.
      history = TMV.vcs.initHistory(model, result.rootCommit.author, result.rootCommit.message, {
        timestamp: result.rootCommit.timestamp,
        keyframeInterval:
          result.history && core.isNumber(result.history.keyframeInterval)
            ? result.history.keyframeInterval
            : TMV.DEFAULT_KEYFRAME_INTERVAL,
      });
    } else if (result.history && core.isObject(result.history) && core.isArray(result.history.commits) && result.history.commits.length) {
      // A native container carries its own history. Adopting it is the whole point of the format —
      // REQ-IMP-005's single root commit is about *interchange* models, which have no history to
      // carry — and `adopt` verifies the chain before it is trusted.
      var adopted = TMV.vcs.adopt(result.history, { readOnly: result.readOnly === true });
      if (!adopted.verdict.ok) {
        return { ok: false, reason: 'chain', verdict: adopted.verdict };
      }
      history = adopted.history;
      model = TMV.vcs.headModel(history);
      if (opts.modelId && core.isString(opts.modelId) && model.modelId !== opts.modelId) {
        // A container whose history does not belong to the id we are replacing cannot be re-labelled:
        // the id is inside every commit, so renaming it would break the chain this import exists to
        // preserve. Refusing is the honest answer, and the notice says so rather than leaving the
        // user to guess why "Import as a new model" did nothing.
        return { ok: false, reason: 'id-in-history' };
      }
    } else {
      // REQ-IMP-005: one root commit, no fabrication. The author is the identity from Settings
      // (REQ-VCS-015) — an import is not a commit the user wrote, but it is a commit this copy of
      // the model starts from, and leaving the author blank would make it the one commit in the log
      // with nobody attached.
      history = TMV.vcs.initHistory(
        model,
        state.prefs ? state.prefs.identity : null,
        'Imported ' + importName(model, result.summary && result.summary.filename) +
          (result.summary && result.summary.formatLabel ? ' (' + result.summary.formatLabel + ')' : ''),
        { keyframeInterval: state.prefs ? state.prefs.keyframeInterval : TMV.DEFAULT_KEYFRAME_INTERVAL },
      );
    }

    state.model = model;
    state.history = history;
    state.compare = null;
    state.writeToken = null;

    // The save is what decides where this model lives. `localStorage` is a cache, not the record
    // (ADR-0001), so a refusal here is a fact about the browser rather than a failure of the import.
    var saved = null;
    if (state.adapter && TMV.storage && opts.persist !== false) {
      saved = persistHistory('import');
    }
    var stored = !!(saved && saved.ok);
    state.source = stored ? 'stored' : 'session';

    settleAfterOpen({ announce: false });
    // REQ-IMP-003: the override opens the model read-only for re-export, and `setEditable` is what
    // puts that on screen — setting the flags by hand would leave the banner, the header actions and
    // the content disagreeing about what this model may be used for.
    setEditable(result.readOnly !== true, result.readOnly === true
      ? 'This model was imported from a document that did not pass validation, so it is read-only for re-export to that format until the violations are resolved.'
      : null);
    reloadRegistry();
    renderSwitcher();
    return { ok: true, stored: stored, saved: saved, model: model, history: history, readOnly: result.readOnly === true };
  }

  /**
   * Import one or more already-read documents (REQ-IMP-001).
   *
   * `entries` is what `widgets.readAll` produces — `[{name, size, text}]` — so nothing here touches a
   * `File` and nothing here can hand a document to the browser to parse. A drop of several files
   * imports the first one that works and says plainly what became of the others: importing them
   * silently in sequence would leave the user unsure which model they are looking at, and a document
   * that failed to parse is not a thing to swallow.
   */
  function importEntries(entries, options) {
    var opts = options || {};
    var list = core.isArray(entries) ? entries : [];
    if (!list.length) return { ok: false, reason: 'nothing' };

    var entry = list[0];
    var input = {
      text: core.isString(entry.text) ? entry.text : '',
      filename: core.isString(entry.name) ? entry.name : 'imported document',
    };
    var result;
    try {
      result = TMV.importing.runImport(input, {
        allowInvalid: opts.allowInvalid === true,
        author: state.prefs ? state.prefs.identity : null,
      });
    } catch (err) {
      notify().failure({
        title: 'That file could not be imported',
        detail: err && err.message ? err.message : 'An unexpected error while reading the document.',
        ref: 'import.failed',
      });
      return { ok: false, reason: 'threw', error: err };
    }

    // REQ-IMP-010: the report is retained here, for every reading of a document — including one that
    // was refused, because "what did it detect and why did it stop" is exactly the question a refusal
    // leaves behind, and it has to stay answerable after the toast is gone.
    if (result && typeof TMV.importing.retainReport === 'function') TMV.importing.retainReport(result);

    var others = list.length - 1;
    var othersNote = others > 0
      ? ' ' + core.plural(others, 'other file was', 'other files were') + ' not imported — the content area takes one model at a time.'
      : '';

    // REQ-IMP-003: by default a document that fails its schema imports nothing and reports the
    // failing paths, with an explicit override. The override is a second pass through the same
    // parser with `allowInvalid`, so the report the user sees and the model they get come from one
    // reading of the file rather than two.
    if (!result.ok) {
      if (result.problems && result.problems.length && !opts.allowInvalid && result.format && result.format !== 'unknown') {
        return offerInvalidImport(result, input, others);
      }
      notify().failure({
        title: 'That file could not be imported',
        detail: (result.reason || 'The document could not be read as a threat model.') + othersNote,
        ref: 'import.refused',
      });
      return { ok: false, reason: result.reason || 'refused', result: result };
    }

    return installOrPrompt(result, input, others, othersNote);
  }

  /**
   * REQ-IMP-003's "Import anyway (limited)".
   *
   * The override states its cost in the same breath as it is offered, because the cost is not
   * obvious: the model opens and can be edited, but it cannot be written back out to the format it
   * came from while it still violates that format's schema. Reading what someone sent you is the
   * whole purpose of a viewport, so refusing outright is the wrong answer — and importing in silence
   * is worse.
   */
  function offerInvalidImport(result, input, others) {
    var problems = (result.problems || []).slice(0, 5);
    var extra = (result.problems || []).length - problems.length;
    var body = [
      core.el('p', { text: result.reason || 'This document does not match its schema.' }),
    ];
    if (problems.length) {
      body.push(widgets.structuredList({
        label: 'Validation problems',
        headers: ['Where', 'What'],
        rows: problems.map(function (p, i) {
          return {
            id: String(i),
            cells: [
              core.el('span', { text: String(p.path || '(document)') }),
              core.el('span', { text: String(p.message || '') }),
            ],
          };
        }),
      }));
    }
    if (extra > 0) {
      body.push(core.el('p', { class: 'tmv-dialog__note', text: 'And ' + core.plural(extra, 'more problem') + '.' }));
    }
    body.push(core.el('p', {
      class: 'tmv-dialog__note',
      text:
        'Importing anyway keeps every field the document does have and leaves the rest empty. The model ' +
        'is read-only for re-export to this format until the violations are resolved.',
    }));

    var instance = widgets.modal({
      title: 'This document does not match its schema',
      size: 'sm',
      danger: true,
      body: body,
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Import anyway (limited)', kind: 'danger', action: 'override' },
      ],
    });
    instance.open();
    TMV.forms.modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action === 'override') {
        instance.close('override');
        importEntries([{ name: input.filename, text: input.text }], { allowInvalid: true });
      }
    });
    if (others) {
      notify().outcome({
        level: 'info',
        title: 'One file at a time',
        detail: core.plural(others, 'other file was', 'other files were') + ' not imported.',
        ref: 'import.multiple',
      });
    }
    return { ok: false, reason: 'invalid', result: result };
  }

  /**
   * REQ-IMP-007: ask, never merge.
   *
   * The collision case is the only one that needs asking about. A model id the registry has never
   * seen cannot collide with anything, so the import simply becomes the model it already says it is —
   * prompting there would train the user to click through a dialog that has one answer.
   */
  function installOrPrompt(result, input, others, othersNote) {
    var incomingId = result.model && core.isString(result.model.modelId) ? result.model.modelId : null;
    var registry = core.isArray(state.registry) ? state.registry : [];
    var existing = null;
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].modelId === incomingId) existing = registry[i];
    }

    if (!existing) return commitImport(result, null, others, othersNote);

    var name = existing.name || incomingId;
    var instance = widgets.modal({
      title: 'That model is already open in this browser',
      size: 'sm',
      body: [
        core.el('p', {
          text:
            'The document being imported is a model called ' + name + ', and this browser already has a ' +
            'saved copy of a model with that identifier.',
        }),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'Nothing is merged either way — the two histories stay separate and the imported model keeps ' +
            'its own single commit. Replacing throws away the saved copy’s history in this browser; ' +
            'the file it came from is not touched.',
        }),
      ],
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Replace the saved copy', kind: 'danger', action: 'replace' },
        { label: 'Import as a new model', kind: 'primary', action: 'new' },
      ],
    });
    instance.open();
    TMV.forms.modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        notify().outcome({
          level: 'info',
          title: 'Nothing was imported',
          detail: 'The model on screen and the saved copy are both unchanged.',
          ref: 'import.cancelled',
        });
        return;
      }
      instance.close(action);
      commitImport(result, action === 'replace' ? incomingId : core.uuid(), others, othersNote);
    });
    return { ok: false, reason: 'prompted', result: result };
  }

  /** Take the result as the open model, and say exactly what happened to it. */
  function commitImport(result, modelId, others, othersNote) {
    var installed = adoptImported(result, { modelId: modelId });
    if (!installed.ok) {
      notify().failure({
        title: 'That file could not be imported',
        detail: installed.reason === 'chain'
          ? 'The history in that file did not verify, so the model has not been opened.'
          : installed.reason === 'id-in-history'
            ? 'That file carries a history belonging to a different model. A model id is inside every ' +
              'commit in a container, so the file cannot be renamed and opened as a new model: it can ' +
              'only be opened as itself.'
            : 'The document produced no model that could be opened.',
        ref: 'import.install',
      });
      return installed;
    }

    var summary = result.summary || {};
    var parts = [];
    if (summary.formatLabel) parts.push(summary.formatLabel);
    if (summary.schemaVersion) parts.push('schema ' + summary.schemaVersion);
    var counts = summary.counts || {};
    var counted = [];
    for (var key in counts) {
      if (Object.prototype.hasOwnProperty.call(counts, key) && counts[key]) {
        counted.push(core.plural(counts[key], key));
      }
    }
    if (counted.length) parts.push(counted.join(', '));

    var detail = parts.length ? parts.join(' · ') + '.' : 'The document was read as a threat model.';
    if (summary.unresolved && summary.unresolved.length) {
      detail += ' ' + core.plural(summary.unresolved.length, 'reference does not', 'references do not') +
        ' resolve; they are marked unresolved rather than dropped.';
    }
    if (installed.readOnly) detail += ' It is read-only for re-export to that format.';
    if (!installed.stored) {
      detail += ' This browser is not storing anything, so it lives in this page only — export it to keep it.';
    }
    detail += othersNote;

    notify().outcome({
      level: summary.warnings && summary.warnings.length ? 'warning' : 'success',
      title: 'Imported ' + importName(installed.model, summary.filename),
      detail: detail,
      ref: 'import.done',
    });

    // REQ-IMP-010: the report stays reachable after the toast is gone, so it is retained here and
    // rendered by Settings → Import. `runImport` already retains it; this is the pointer to it.
    return installed;
  }

  /**
   * The drag-and-drop path (REQ-IMP-001).
   *
   * Reading is delegated to `widgets.readAll`, which uses `FileReader.readAsText` and nothing else —
   * a dropped file is characters on their way to `JSON.parse`, never a document the browser parses
   * (REQ-IMP-008). The listener is on the content region rather than the window so that a drop on
   * the page's own chrome is not silently treated as an import.
   */
  function attachDropZone() {
    var target = core.byId(CONTENT_ID);
    if (!target || !core.on) return function () {};
    var depth = 0;
    function over(event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      core.setClass(target, 'tmv-drop-target', true);
    }
    var offs = [
      core.on(target, 'dragenter', function (event) { depth++; over(event); }),
      core.on(target, 'dragover', over),
      core.on(target, 'dragleave', function () {
        depth = Math.max(0, depth - 1);
        if (depth === 0) core.setClass(target, 'tmv-drop-target', false);
      }),
      core.on(target, 'drop', function (event) {
        depth = 0;
        over(event);
        core.setClass(target, 'tmv-drop-target', false);
        var files = event.dataTransfer ? event.dataTransfer.files : null;
        if (!files || !files.length) return;
        var list = [];
        for (var i = 0; i < files.length; i++) list.push(files[i]);
        widgets.readAll(list, function (entries) {
          var ok = [];
          for (var j = 0; j < entries.length; j++) if (!entries[j].error) ok.push(entries[j]);
          if (ok.length) importEntries(ok);
          else {
            notify().failure({
              title: 'That file could not be read',
              detail: 'This browser would not hand over the contents of the dropped file.',
              ref: 'import.drop',
            });
          }
        });
      }),
    ];
    return function () {
      for (var k = 0; k < offs.length; k++) offs[k]();
    };
  }

  /**
   * Delete a model from this browser (REQ-STORE-005, `05-storage.md` §7).
   *
   * The confirmation names the model, its commit count and its size, and states that the file on disk
   * is not deleted — §7 calls that the most likely misunderstanding, and it is, because the user's
   * mental model is that the application *is* the file. Deleting the open model returns to the
   * embedded data rather than to an empty state.
   */
  function confirmDeleteStored(modelId) {
    if (!state.editable && state.readOnlyReason) {
      notify().failure({ title: 'Nothing can be deleted here', detail: state.readOnlyReason, ref: 'store.delete.read-only' });
      return null;
    }
    var explicit = core.isString(modelId);
    var id = explicit ? modelId : currentModelId();
    if (!id) {
      notify().outcome({ level: 'info', title: 'Nothing was deleted', detail: 'No model is open.', ref: 'store.delete.unavailable' });
      return null;
    }

    // The entry that describes the open model is `switcherCurrent`, not whichever entry happens to
    // match the id: the file entry and the stored entry for one model share an id, and matching by id
    // would find the file entry and refuse to delete the stored copy the user is looking at.
    var entry = explicit ? null : state.switcherCurrent || null;
    if (!entry) {
      var entries = state.switcherEntries || [];
      for (var i = 0; i < entries.length; i++) if (entries[i].value === id) entry = entries[i];
    }
    if (!entry) {
      entry = { value: id, modelId: id, name: id, commitCount: 0, bytes: 0, fromFile: false, stored: storedIds()[id] === true };
    }
    var availability = deleteAvailability(entry);
    if (!availability.available) {
      notify().outcome({ level: 'info', title: 'Nothing was deleted', detail: availability.reason, ref: 'store.delete.unavailable' });
      return null;
    }

    var instance = widgets.modal({
      title: 'Delete this model from this browser',
      size: 'sm',
      danger: true,
      body: [
        core.el('p', { text: 'Delete “' + entryHeadline(entry) + '” from this browser?' }),
        core.el('div', { class: 'tmv-dialog__group' }, [
          core.el('p', { class: 'tmv-dialog__lead', text: 'What is being deleted' }),
          core.el('p', {
            class: 'tmv-dialog__value',
            text: core.plural(entry.commitCount, 'commit', 'commits') + ' · ' + core.bytes(entry.bytes || 0),
          }),
        ]),
        core.el('p', {
          class: 'tmv-dialog__note',
          text:
            'This removes the history this browser kept for it, and it cannot be undone from here. The ' +
            'file on disk is not deleted and is not changed — if this model is in a file, that file still ' +
            'has it.',
        }),
      ],
      actions: [
        { label: 'Cancel', kind: 'tertiary', action: 'cancel' },
        { label: 'Delete from this browser', kind: 'danger', action: 'delete', name: 'confirm' },
      ],
    });
    instance.open();

    TMV.forms.modalActions(instance, function (action) {
      if (action === 'cancel') {
        instance.close('cancel');
        return;
      }
      if (action !== 'delete') return;
      instance.close('deleted');
      var report;
      try {
        report = TMV.storage.deleteModel(state.adapter, id);
      } catch (err) {
        notify().failure({
          title: 'Nothing was deleted',
          detail: err && err.message ? err.message : 'The storage adapter refused the delete.',
          ref: 'store.delete',
        });
        return;
      }
      notify().outcome({
        level: 'success',
        title: 'Deleted from this browser',
        detail: core.plural(report.removed, 'stored record', 'stored records') + ' removed. The file on disk was not touched.',
        ref: 'store.delete',
      });
      reloadRegistry();
      if (id === currentModelId()) openEmbedded({ announce: false, persist: false });
      else refresh();
      return;
    });
    return instance;
  }

  function storedIds() {
    var out = Object.create(null);
    for (var i = 0; i < state.registry.length; i++) out[state.registry[i].modelId] = true;
    return out;
  }

  function stashList() {
    return state.stash ? [state.stash] : [];
  }

  /** Reapply the session stash, reporting a partial application rather than swallowing it. */
  function applyStash() {
    if (!state.stash || !state.history) return { ok: false, message: 'There is no stash to reapply.' };
    var result = TMV.vcs.applyStash(state.history, state.stash);
    if (!result || !result.ok) {
      notify().failure({
        title: 'The stash could not be reapplied',
        detail: (result && result.message) || 'The head has moved on too far for this stash to apply.',
        ref: 'edit.stash.apply',
      });
      return result || { ok: false };
    }
    state.stash = null;
    edit(result.model, { label: 'Reapply stash', reason: 'stash' });
    notify().outcome({ level: 'success', title: 'Stash reapplied', detail: 'The changes are back in the working copy and are not committed.', ref: 'edit.stash.apply' });
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Appearance and side nav
  // ---------------------------------------------------------------------------------------------

  function setTheme(value) {
    var theme = applyTheme(value);
    persistPrefs({ theme: theme });
    renderActions();
    var label = themeLabel(theme);
    notify().announce('Theme: ' + label);
    return theme;
  }

  /**
   * The light/dark switch (`07-ui.md` §4).
   *
   * A shortcut across the four themes rather than a fifth one: it moves to the opposite *family* and
   * leaves the exact variant to whichever the user last used in that family. That keeps the switch and
   * the four-entry menu describing the same state — pressing the switch can never land on a theme the
   * Appearance screen would disagree with — which is the whole reason it is derived rather than stored.
   */
  function toggleTheme() {
    var current = themeFor(state.prefs && state.prefs.theme);
    return setTheme(oppositeFamilyTheme(current));
  }

  function themeIsDark() {
    return isDarkTheme(themeFor(state.prefs && state.prefs.theme));
  }

  function setSideNavCollapsed(collapsed) {
    persistPrefs({ sideNavCollapsed: collapsed === true });
    return applySideNav();
  }

  function toggleSideNav() {
    return setSideNavCollapsed(!(state.prefs && state.prefs.sideNavCollapsed));
  }

  // ---------------------------------------------------------------------------------------------
  // 9. Reporting
  // ---------------------------------------------------------------------------------------------

  function showNotice(notice) {
    if (!notice) return null;
    if (notice.kind === 'toast') {
      return notify().outcome({
        level: notice.level,
        title: notice.title,
        detail: notice.detail,
        actions: notice.actions,
        ref: notice.ref,
      });
    }
    return notify().banner({
      key: notice.key,
      level: notice.level,
      title: notice.title,
      body: notice.detail,
      actions: notice.actions,
    });
  }

  /**
   * The header's storage indicator (`07-ui.md` §9).
   *
   * It sits in the header because that is the one part of the chrome every tab shares, and the notice
   * it summarises is below the content where a reader who has scrolled a long section will not see it.
   * It is a label and not a control: the banner is already the place with the explanation and the
   * action, so a button here would either duplicate that or do nothing at all.
   *
   * No live region and no role: the banner announces itself with the politeness its level deserves,
   * and a second announcement of the same fact is how a status becomes noise.
   */
  function renderStorageIndicator(name) {
    var host = core.byId('tmv-storage-notice');
    if (!host) return null;
    var text = core.byId('tmv-storage-notice-text');
    if (text) {
      core.clear(text);
      text.appendChild(core.text(name || ''));
    }
    core.setHidden(host, !name);
    return name || null;
  }

  /**
   * Say where storage is, and what it means for this session (REQ-STORE-007, REQ-SYNC-008).
   *
   * Called on every boot, which is the point: a notice about storage is a notice about *this* visit,
   * and a user who has cleared their data needs it said again rather than remembered as dismissed.
   */
  function reportStorage(storageState) {
    if (storageState) state.storage = storageState;
    var notice = storageNotice(state.storage);
    renderStorageIndicator(notice ? notice.indicator : null);
    return showNotice(notice);
  }

  /** Say what the reconcile did, or say nothing when there is nothing to say (REQ-SYNC-004). */
  function reportReconcile(result) {
    state.reconcile = result || null;
    return showNotice(reconcileNotice(result));
  }

  /** §5's four levels. `elevated` is the quiet indicator in Settings and nothing here. */
  function reportQuota(level, detail) {
    if (level !== 'warning' && level !== 'exhausted') {
      notify().clearBanner('quota');
      return null;
    }
    return showNotice(quotaNotice(level, detail));
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Read-only and failure states
  // ---------------------------------------------------------------------------------------------

  function setEditable(editable, reason) {
    state.editable = editable === true;
    state.readOnlyReason = state.editable ? null : reason || state.readOnlyReason || null;
    if (!state.editable) {
      // The banner is persistent and named: §9's rule is that edit affordances are removed rather
      // than disabled, and the reason has to be somewhere the user can read it.
      notify().banner({
        key: 'read-only',
        level: 'warning',
        title: TMV.notify.MESSAGES.readOnly.title,
        body: state.readOnlyReason ? TMV.notify.MESSAGES.readOnly.body + ' ' + state.readOnlyReason : TMV.notify.MESSAGES.readOnly.body,
      });
    } else {
      notify().clearBanner('read-only');
    }
    if (state.mounted) {
      syncDirty();
      renderHeader();
      renderContent();
    }
    return state.editable;
  }

  var chromeIds = [TABS_ID, SIDENAV_ID, 'tmv-model-switcher', 'tmv-header-actions', 'tmv-dirty'];

  function setChromeHidden(hidden) {
    for (var i = 0; i < chromeIds.length; i++) {
      var node = core.byId(chromeIds[i]);
      if (node) core.setHidden(node, hidden);
    }
    var commit = core.byId('tmv-commit');
    if (commit) {
      // Hidden means disabled as well: a commit button behind a failure screen is not reachable, and a
      // form of it that was focusable would be a trap.
      core.setAttr(commit, 'disabled', hidden || !state.dirty ? true : null);
    }
    // The storage indicator is deliberately not in `chromeIds`: putting the chrome back must not mean
    // showing it, because whether it belongs on screen is decided by the storage state and not by
    // whether a failure screen is up. Hiding is unconditional; restoring asks `reportStorage`'s own
    // rule again.
    var indicator = core.byId('tmv-storage-notice');
    if (indicator) {
      if (hidden) core.hide(indicator);
      else {
        var notice = storageNotice(state.storage);
        renderStorageIndicator(notice ? notice.indicator : null);
      }
    }
    var nav = core.byId(SIDENAV_ID);
    if (nav && !hidden) applySideNav();
  }

  /**
   * A state the application stops in: the file did not parse, the chain did not verify.
   *
   * Everything navigational is hidden and the content region carries the whole screen, because the
   * alternative — a tab strip over an empty panel — invites the user to look for the problem in the
   * wrong place. `clearFailure` puts the chrome back.
   */
  function showFailure(spec) {
    state.failure = spec || { title: 'This file cannot be opened' };
    setChromeHidden(true);
    applySideNav();
    if (state.mounted) renderContent();
    return state.failure;
  }

  function clearFailure() {
    state.failure = null;
    setChromeHidden(false);
    if (state.mounted) refresh();
    return true;
  }

  /** Hand the compare view its two heads and its base (`04-versioning.md` §6, REQ-SYNC-005). */
  function setCompare(compare) {
    state.compare = compare || null;
    return state.compare;
  }

  // ---------------------------------------------------------------------------------------------
  // 11. Views
  // ---------------------------------------------------------------------------------------------

  var views = Object.create(null);

  /**
   * A view is `{id, render(ctx), counts?(ctx), title?}`. `id` is a tab id, so registering the wrong
   * one is a programming error and is refused loudly rather than rendering nothing later on.
   */
  function register(view) {
    if (!view || !core.isString(view.id)) throw TMV.error('SHELL_VIEW', 'A view must have an id.');
    if (!tabFor(view.id)) throw TMV.error('SHELL_VIEW', 'No tab has the id "' + view.id + '".');
    views[view.id] = view;
    if (state.mounted) {
      // The side nav first: a newly registered view may supply counts the placeholder rows were
      // showing as "not yet counted", and the content is rendered from the same context.
      renderSideNav();
      if (view.id === state.activeTab) renderContent();
    }
    return view;
  }

  function registerAll(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push(register(list[i]));
    return out;
  }

  function viewFor(id) {
    return views[id] || null;
  }

  function registeredTabs() {
    var out = [];
    for (var i = 0; i < TABS.length; i++) if (views[TABS[i].id]) out.push(TABS[i].id);
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // 12. Mount
  // ---------------------------------------------------------------------------------------------

  var offHandlers = [];
  var offDrop = function () {};
  var offUnloadGuard = function () {};

  /**
   * Delegated handlers, one per event type for the whole shell (REQ-UI-008, `02-architecture.md` §6
   * step 7). No row, tab or menu entry carries its own listener, which is what keeps a redraw cheap
   * and means a handler cannot outlive the element it was attached to.
   */
  /**
   * Whether a node is inside the overlay root.
   *
   * The delegated listener is on `document.body`, because the notification regions are created there
   * and their actions ("Export updated file") belong to the shell. Overlays are the exception: a modal
   * is a self-contained interaction with its own listener, and its buttons reuse action names the
   * shell also uses — the commit dialog's Commit is `data-action="commit"` — so a click inside one must
   * not also be read as a shell action, or committing would open a second commit dialog.
   */
  function inOverlay(node) {
    var current = node;
    while (current) {
      if (current.getAttribute && current.getAttribute('id') === 'tmv-layers') return true;
      current = current.parentNode;
    }
    return false;
  }

  function attach() {
    detach();
    var root = shellRoot();
    if (!root) return [];

    // REQ-IMP-001's drop path is separate from the delegated click handlers below because it listens
    // on the content region and needs dragenter/dragleave bookkeeping that the delegator has no room
    // for. It is torn down with the rest so a second `mount` cannot leave two drop zones live.
    offDrop = attachDropZone();

    offHandlers.push(core.on(root, 'click', function (event) {
      var node = core.closestAction(event.target, root);
      if (!node || node.getAttribute('disabled') !== null) return;
      if (inOverlay(node)) return;
      var action = node.getAttribute('data-action');
      if (!action || action === 'noop') return;
      handleAction(action, node.getAttribute('data-value'), event);
    }));

    offHandlers.push(core.on(root, 'keydown', function (event) {
      var strip = core.byId(TABS_ID);
      if (!strip) return;
      var target = event.target;
      if (!target || !target.getAttribute) return;
      if (target.getAttribute('role') !== 'tab') return;
      var next = stepTab(TABS.length, tabIndex(state.activeTab), event.key);
      if (next === -1) return;
      event.preventDefault();
      var tab = TABS[next];
      go(tab.id);
      var button = tabButtonFor(tab.id);
      if (button && button.focus) button.focus();
    }));

    return offHandlers;
  }

  function detach() {
    for (var i = 0; i < offHandlers.length; i++) offHandlers[i]();
    offHandlers = [];
    offDrop();
    offDrop = function () {};
  }

  function handleAction(action, value) {
    if (action === 'tab') {
      go(value);
      return;
    }
    if (action === 'side-nav') {
      go(state.activeTab, value);
      return;
    }
    if (action === 'toggle-side-nav') {
      toggleSideNav();
      return;
    }
    if (action === 'toggle-theme') {
      toggleTheme();
      return;
    }
    if (action === 'commit') {
      commit();
      return;
    }
    if (action === 'switch-model') {
      switchModel(value);
      return;
    }
    if (action === 'import') {
      go('settings', 'import');
      return;
    }
    if (action === 'notify-action') {
      // §9's storage and quota notices both offer to get the model out of the browser, and both
      // mean "open the export screen" — the export dialog belongs to the Settings view, not here.
      if (value === 'export-updated' || value === 'export-now') go('settings', 'export');
      else if (value === 'quota-options') go('settings', 'storage');
      return;
    }
    if (action === 'clear-failure') {
      // The one full-screen state with a way out. §6's inventory says the integrity screen is
      // read-only and offers export, and export is only reachable from an opened model — so the way
      // out is to put the model on screen with every edit affordance still removed, rather than to
      // leave the reader on the screen that told them about the problem.
      clearFailure();
      return;
    }
  }

  /**
   * Wire the shell into the document and render it once.
   *
   * Called by `19-boot.js` at step 6, after the container has parsed, the chain has verified, storage
   * has been probed and the reconcile has run — so by the time anything is rendered there is a history
   * to render. Anything earlier would be rendering a model the reconcile is about to replace.
   */
  function mount(options) {
    var opts = options || {};

    // The frame is checked before any state is touched, so a page that is missing a region fails
    // without leaving a half-mounted shell behind: a shell that had adopted the new history but could
    // not render it would report itself mounted and then draw nothing.
    var missing = [];
    if (!core.byId(CONTENT_ID)) missing.push(CONTENT_ID);
    if (!core.byId(TABS_ID)) missing.push(TABS_ID);
    if (!core.byId(SIDENAV_ID)) missing.push(SIDENAV_ID);
    state.missing = missing;
    if (missing.length) {
      throw TMV.error('SHELL_FRAME', 'The page is missing the shell regions this build needs: ' + missing.join(', ') + '.');
    }

    state.adapter = opts.adapter || null;
    state.prefs = opts.prefs || (TMV.storage ? TMV.storage.defaultPrefs() : { theme: 'cds--g10', activeTab: 'overview', sideNavCollapsed: false, identity: { name: '', email: '' } });
    state.container = opts.container || null;
    state.history = opts.history || null;
    state.model = opts.model || null;
    state.writeToken = opts.writeToken || null;
    state.registry = core.isArray(opts.registry) ? opts.registry : [];
    state.embedded = opts.embedded || null;
    state.source = opts.source === 'stored' ? 'stored' : opts.source === 'session' ? 'session' : 'file';
    state.storage = opts.storage || state.storage;
    state.reconcile = opts.reconcile || null;
    state.compare = opts.compare || null;

    // Read from the adapter now, before anything is drawn. A registry passed in `opts` is a caller's
    // override and is left alone; otherwise the adapter is the only source, and every consumer of
    // `state.registry` — the header switcher, the side nav, Settings' Storage and Danger Zone — reads
    // it during the first render. Loading it after that paint leaves the screen disagreeing with what
    // is actually stored: the switcher showing the file as current while a stored copy exists, and the
    // Danger Zone offering nothing to delete.
    if (!core.isArray(opts.registry)) reloadRegistry();

    // A model id the registry knows nothing about is not an error; a model id the file does not have
    // is, because `embeddedEntry` is built from the file and the history has to agree with it.
    state.activeTab = normaliseTab(state.prefs.activeTab, TABS[0].id);
    state.activeSection = defaultSection(state.activeTab);
    state.mounted = true;

    applyTheme(state.prefs.theme);
    renderTabs();
    applySideNav();
    renderSideNav();
    renderHeader();
    renderContent();
    syncDirty();
    attach();

    // REQ-EDIT-005: an uncommitted working copy is the one thing a reload loses, so leaving the page
    // asks first. It never blocks — a `beforeunload` handler cannot — it only gives the browser a
    // reason to show its own confirmation.
    offUnloadGuard = TMV.forms.guardUnload(isDirtyNow, {});

    var commitButton = core.byId('tmv-commit');
    if (commitButton) {
      core.setAttr(commitButton, 'type', 'button');
      core.setAttr(commitButton, 'data-action', 'commit');
    }
    var trigger = core.byId('tmv-sidenav-trigger');
    if (trigger) core.setAttr(trigger, 'data-action', 'toggle-side-nav');

    setEditable(opts.editable !== false, opts.readOnlyReason || null);
    if (opts.failure) showFailure(opts.failure);

    return api;
  }

  function unmount() {
    detach();
    offUnloadGuard();
    offUnloadGuard = function () {};
    closeSwitcher();
    closeMenuLayers();
    state.mounted = false;
    return true;
  }

  // ---------------------------------------------------------------------------------------------

  var api = {
    TABS: TABS,
    TAB_IDS: tabIds(),
    THEMES: THEMES,
    FILE_VALUE: FILE_VALUE,
    CONTENT_ID: CONTENT_ID,
    SIDENAV_ID: SIDENAV_ID,
    TABS_ID: TABS_ID,

    /** The decisions worth testing without a document (`09-testing.md` §2). */
    logic: {
      tabFor: tabFor,
      tabIds: tabIds,
      tabIndex: tabIndex,
      normaliseTab: normaliseTab,
      sectionsOf: sectionsOf,
      sectionFor: sectionFor,
      defaultSection: defaultSection,
      stepTab: stepTab,
      isTheme: isTheme,
      themeFor: themeFor,
      themeLabel: themeLabel,
      isDarkTheme: isDarkTheme,
      oppositeFamilyTheme: oppositeFamilyTheme,
      switcherEntries: switcherEntries,
      entryKindOf: entryKindOf,
      deleteAvailability: deleteAvailability,
      entryHeadline: entryHeadline,
      entryDetail: entryDetail,
      entryName: entryName,
      navRows: navRows,
      dirtyState: dirtyState,
      reconcileNotice: reconcileNotice,
      storageNotice: storageNotice,
      quotaNotice: quotaNotice,
    },

    state: function () { return state; },
    context: context,
    currentModelId: currentModelId,

    register: register,
    registerAll: registerAll,
    viewFor: viewFor,
    registeredTabs: registeredTabs,

    mount: mount,
    unmount: unmount,
    refresh: refresh,
    go: go,
    activeTab: function () { return state.activeTab; },
    activeSection: function () { return state.activeSection; },

    edit: edit,
    undo: undo,
    commit: commit,
    discard: discard,
    isDirty: isDirtyNow,
    syncDirty: syncDirty,
    headModel: headModel,
    resetToHead: resetToHead,
    persistHistory: persistHistory,
    reloadRegistry: reloadRegistry,
    collectionReport: collectionReport,
    runCollection: runCollection,

    switchModel: switchModel,
    editModelDetails: editModelDetails,
    openEntry: openEntry,
    openEmbedded: openEmbedded,
    openStored: openStored,
    guardSwitch: guardSwitch,
    guardAbandonSession: guardAbandonSession,
    adoptImported: adoptImported,
    importEntries: importEntries,
    deleteStored: confirmDeleteStored,
    stashList: stashList,
    applyStash: applyStash,

    setTheme: setTheme,
    toggleTheme: toggleTheme,
    themeIsDark: themeIsDark,
    applyTheme: applyTheme,
    setSideNavCollapsed: setSideNavCollapsed,
    toggleSideNav: toggleSideNav,

    setEditable: setEditable,
    showFailure: showFailure,
    clearFailure: clearFailure,
    setCompare: setCompare,

    reportStorage: reportStorage,
    reportReconcile: reportReconcile,
    reportQuota: reportQuota,
    showNotice: showNotice,

    persistPrefs: persistPrefs,
  };

  TMV.shell = api;
})(globalThis.TMV = globalThis.TMV || {});
