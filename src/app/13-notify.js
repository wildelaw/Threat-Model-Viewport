/* ---- src/app/13-notify.js ---- */
/*
 * Notifications, banners and errors (`07-ui.md` §5, §6, §9; REQ-UI-009).
 *
 * Three surfaces, and the difference between them is *duration*, which is also what decides where
 * each one belongs:
 *
 *   - a **toast** reports something that already finished (a commit landed). It goes away on its own.
 *   - a **banner** reports a condition that is still true (storage is unavailable, local history is
 *     ahead of the file). It stays until the condition stops being true.
 *   - the **retained error log** holds what went wrong after the message about it has gone. REQ-UI-009
 *     AC is explicit that an error is not dismissible into oblivion, so dismissing an error's
 *     notification dismisses the *notification* and never the record.
 *
 * Getting that last one wrong is the easy mistake and the one with consequences: an app that shows a
 * red toast for a failed write and then forgets it is an app where a user can lose work without ever
 * being able to say what happened.
 *
 * §9 is also why the copy for the storage notices lives here rather than at each call site. Those two
 * messages — storage unavailable, origin partitioned — are described there as "the most common
 * confusing moment in the product" and as the difference between "this tool is broken" and "this tool
 * explained something I did not know about my browser". A message that important is written once.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;

  var LEVELS = ['error', 'success', 'warning', 'info'];

  /** How many entries the retained error log keeps. Bounded, because it is never pruned by the user. */
  var RETAINED_LIMIT = 20;

  /** Toasts on screen at once. Beyond this the oldest goes, oldest-first. */
  var TOAST_LIMIT = 4;

  var TOAST_TIMEOUT = { error: 0, warning: 8000, success: 5000, info: 5000 };

  // ---------------------------------------------------------------------------------------------
  // 1. Copy that §9 says to get right
  //
  // Written in plain language, naming the browser behaviour, and always offering the file-based path.
  // They never say "storage error": the user did not make an error, and nothing is broken.
  // ---------------------------------------------------------------------------------------------

  var MESSAGES = {
    storageUnavailable: {
      level: 'warning',
      title: 'Changes will not be kept between visits',
      body:
        'This browser is not letting the page save anything, so edits you make now live in this tab ' +
        'only. Reloading loses them. Nothing is broken — download the file when you are done and it ' +
        'carries everything with it.',
    },
    storagePartitioned: {
      level: 'info',
      title: 'This file remembers itself, not the others',
      body:
        'Firefox gives every local file its own storage, so this threat model cannot see models opened ' +
        'from other file paths — and they cannot see this one. That is how the browser is built, not a ' +
        'fault. Use Export to move a model between files.',
    },
    storageSharedOrigin: {
      level: 'info',
      title: 'Other local files share this storage',
      body:
        'On this browser every local file shares one storage area. This model keeps its own record ' +
        'separately, but a file you did not create could also be stored here. Import a file rather ' +
        'than opening it if you do not trust where it came from.',
    },
    quotaWarning: {
      level: 'warning',
      title: 'Storage is nearly full',
      body:
        'There is not much room left for this browser to keep this model. Nothing has been removed. ' +
        'You can download the file, compact the stored history, or remove specific models you no ' +
        'longer need.',
    },
    localAhead: {
      level: 'info',
      title: 'The stored copy is newer than the file',
      body:
        'Work saved in this browser is ahead of the copy embedded in the file. The stored version is ' +
        'the one being shown. Download the file to bring them back together.',
    },
    readOnly: {
      level: 'warning',
      title: 'Read-only',
      body: 'This model cannot be edited here. Viewing and exporting still work.',
    },
  };

  // ---------------------------------------------------------------------------------------------
  // 2. The retained record
  // ---------------------------------------------------------------------------------------------

  var retained = [];
  var listeners = [];

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * Record an outcome.
   *
   * Everything is recorded, not only errors: the History tab shows what happened, and "the import
   * reported four warnings" is as much a thing a user needs to find again as an error is.
   */
  function record(entry) {
    retained.push({
      id: core.uuid(),
      level: LEVELS.indexOf(entry.level) === -1 ? 'info' : entry.level,
      title: entry.title || '',
      detail: entry.detail || '',
      at: entry.at || nowIso(),
      // A caller-supplied handle, so a screen can deep-link back to whatever the message was about
      // (the commit, the import report, the model).
      ref: entry.ref || null,
    });
    while (retained.length > RETAINED_LIMIT) retained.shift();
    for (var i = 0; i < listeners.length; i++) listeners[i](retained[retained.length - 1]);
  }

  function entries(level) {
    if (!level) return retained.slice();
    return retained.filter(function (e) { return e.level === level; });
  }

  /** The last error, which REQ-UI-009 AC requires to stay reachable after its message is dismissed. */
  function latestError() {
    for (var i = retained.length - 1; i >= 0; i--) if (retained[i].level === 'error') return retained[i];
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Surfaces
  // ---------------------------------------------------------------------------------------------

  function region(id, fallbackClass) {
    var node = core.byId(id);
    if (node) return node;
    var d = typeof document === 'undefined' ? null : document;
    if (!d || !d.body) return null;
    node = core.el('div', { id: id, class: fallbackClass });
    d.body.appendChild(node);
    return node;
  }

  /**
   * Carbon spells a notification as the base component *plus* a level modifier, and the two carry
   * different things: the base class owns the box's layout, padding and typography, and the modifier
   * only overrides its colours. Returning the modifier alone — which this did — leaves every toast
   * and banner unstyled in a browser, because nothing matches `.cds--toast-notification` and the
   * modifier's own rule sets colour on an element that was never given a frame. Every other
   * notification in the codebase (`18-views-shared.js`, `16-compare.js`, `18-views-risk.js`) already
   * carries both; this is the one place they were built rather than written out.
   */
  function levelClass(level, kind) {
    var base = kind === 'toast' ? 'cds--toast-notification' : 'cds--inline-notification';
    var modifier = level === 'success' ? '--success' : level === 'warning' ? '--warning' : level === 'error' ? '--error' : '--info';
    return base + ' ' + base + modifier;
  }

  /**
   * Which live region this level needs.
   *
   * An error is announced assertively — it interrupts, because the alternative is that the user
   * carries on with work that is not being saved. Everything else is polite, because a success
   * message interrupting a sentence is noise. This is the §5 requirement, not a preference.
   */
  function roleFor(level) {
    return level === 'error' ? 'alert' : 'status';
  }

  function actionsOf(specs) {
    var out = [];
    var list = specs || [];
    for (var i = 0; i < list.length; i++) {
      out.push(widgets.button({
        label: list[i].label,
        kind: list[i].kind || 'ghost',
        action: 'notify-action',
        value: String(list[i].action || list[i].label),
      }));
    }
    return out;
  }

  function notificationBody(opts) {
    var children = [
      core.el('div', { class: 'cds--inline-notification__details' }, [
        opts.title ? core.el('p', { class: 'cds--inline-notification__title', text: opts.title }) : null,
        opts.detail ? core.el('p', { class: 'cds--inline-notification__subtitle', text: opts.detail }) : null,
        opts.body ? core.el('p', { class: 'cds--inline-notification__subtitle', text: opts.body }) : null,
      ]),
    ];
    var actions = actionsOf(opts.actions);
    if (actions.length) {
      children.push(core.el('div', { class: 'cds--inline-notification__action-button' }, actions));
    }
    if (opts.dismissible !== false) {
      children.push(core.el('button', {
        type: 'button',
        class: 'cds--inline-notification__close-button',
        'data-action': 'dismiss-notification',
        'aria-label': 'Dismiss',
      }, [widgets.icon('close')]));
    }
    return children;
  }

  /** Wire a notification's own actions and its dismiss control. */
  function wire(node, opts, onDismiss) {
    core.on(node, 'click', function (event) {
      var target = core.closestAction(event.target, node);
      if (!target) return;
      var action = target.getAttribute('data-action');
      if (action === 'dismiss-notification') {
        onDismiss('dismissed');
        return;
      }
      if (action !== 'notify-action') return;
      var value = target.getAttribute('data-value');
      var list = opts.actions || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].action || list[i].label) !== value) continue;
        // An action that also dismisses is how "Export updated file" is expected to behave: the
        // banner has done its job and the user has acted on it.
        if (list[i].dismiss !== false) onDismiss('action:' + value);
        if (list[i].onSelect) list[i].onSelect();
        return;
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Toasts
  // ---------------------------------------------------------------------------------------------

  var liveToasts = [];

  /**
   * A toast: something that has finished.
   *
   * `timeout` follows the level (errors do not auto-dismiss — see below), and `0` means "stay until
   * dismissed". An error toast is given no timeout on purpose: REQ-UI-009's whole point is that an
   * error the user did not read is an error the user does not know about, and a red box that vanishes
   * after five seconds is a red box most people never read.
   */
  function toast(opts) {
    var options = opts || {};
    var level = LEVELS.indexOf(options.level) === -1 ? 'info' : options.level;
    var container = region('tmv-notifications', 'tmv-notifications');
    var timer = null;

    var node = core.el('div', {
      class: levelClass(level, 'toast') + ' tmv-toast',
      role: roleFor(level),
      'aria-live': level === 'error' ? 'assertive' : 'polite',
    }, notificationBody(options));

    function close(reason) {
      if (timer) { clearTimeout(timer); timer = null; }
      var at = liveToasts.indexOf(handle);
      if (at !== -1) liveToasts.splice(at, 1);
      if (node.parentNode) node.parentNode.removeChild(node);
      if (options.onClose) options.onClose(reason);
    }

    var handle = { element: node, close: close, level: level, id: core.uuid() };

    wire(node, options, close);
    if (container) {
      container.appendChild(node);
      liveToasts.push(handle);
      while (liveToasts.length > TOAST_LIMIT) liveToasts[0].close('overflow');
    }

    var timeout = core.isNumber(options.timeout) ? options.timeout : TOAST_TIMEOUT[level];
    if (timeout > 0) timer = setTimeout(function () { close('timeout'); }, timeout);

    handle.timer = function () { return timer; };
    return handle;
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Banners
  //
  // Keyed, because a banner reports a *condition* and conditions recur. `banner({key: 'quota'})`
  // twice leaves one banner, not two; and a condition that has stopped being true is removed by
  // `clearBanner(key)`, not by the user dismissing something that is still happening.
  // ---------------------------------------------------------------------------------------------

  var banners = {};

  function banner(opts) {
    var options = opts || {};
    var key = options.key || options.title || 'banner';
    if (banners[key]) banners[key].close('replaced');

    var level = LEVELS.indexOf(options.level) === -1 ? 'info' : options.level;
    var container = region('tmv-banners', 'tmv-banners');
    if (!container) return { element: null, close: function () {} };

    var node = core.el('div', { class: levelClass(level, 'inline') + ' tmv-banner', role: roleFor(level) },
      notificationBody(options));

    var handle = { element: node, key: key, level: level };
    handle.close = function (reason) {
      delete banners[key];
      if (node.parentNode) node.parentNode.removeChild(node);
      if (options.onClose) options.onClose(reason);
    };

    wire(node, options, handle.close);
    // Inserted before any modal-only content: banners stack newest-last so the reading order matches
    // the order conditions appeared.
    container.appendChild(node);
    banners[key] = handle;
    return handle;
  }

  function clearBanner(key) {
    if (banners[key]) banners[key].close('cleared');
  }

  function bannerKeys() {
    return Object.keys(banners);
  }

  function clearAllBanners() {
    var keys = bannerKeys();
    for (var i = 0; i < keys.length; i++) banners[keys[i]].close('cleared');
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Screen-reader announcements (REQ-UI-007: live regions announce outcomes)
  //
  // Separate from the visual notifications: the text a sighted user reads and the text a screen
  // reader should hear are not always the same sentence, and a visually hidden region lets the
  // second be written deliberately instead of being whatever the visible markup happens to say.
  // ---------------------------------------------------------------------------------------------

  function announce(text, level) {
    var live = core.byId('tmv-live');
    if (!live) return;
    // Empty text clears the region, which is how a caller says "nothing is being announced any more"
    // — without this the last message stays in the accessible name of the region indefinitely.
    core.clear(live);
    if (!text) return;
    // The node is replaced rather than re-set, because assigning identical text to a live region is
    // not a mutation and announces nothing — which is exactly the case when the same error happens
    // twice in a row, the one time a user most needs to hear it again.
    live.appendChild(core.text(String(text)));
    core.setAttr(live, 'aria-live', level === 'error' ? 'assertive' : 'polite');
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The one entry point the rest of the app calls
  // ---------------------------------------------------------------------------------------------

  /**
   * Report an outcome: records it, announces it, and shows it.
   *
   *   notify.outcome({level, title, detail, actions, ref, toast: true|false, announce})
   *
   * The record is written first, so a screen that shows the retained log from inside a notification's
   * own action sees the entry it came from.
   */
  function outcome(opts) {
    var options = opts || {};
    var level = LEVELS.indexOf(options.level) === -1 ? 'info' : options.level;

    record({
      level: level,
      title: options.title,
      detail: options.detail || options.body || '',
      ref: options.ref,
    });

    if (options.announce !== false) {
      announce(join(options.title, options.detail || options.body), level);
    }

    if (options.toast === false) return null;
    return toast(options);
  }

  function join(title, detail) {
    if (title && detail) return title + '. ' + detail;
    return title || detail || '';
  }

  /** The error path, which is `outcome` with the two things an error always needs. */
  function failure(opts) {
    var options = opts || {};
    options.level = 'error';
    // Never `toast: false` by default: an error the user is not told about is the failure mode this
    // module exists to prevent.
    return outcome(options);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Busy indicator (REQ-VIEW-009: a "still working" indicator past 300 ms)
  // ---------------------------------------------------------------------------------------------

  /**
   * Show a "still working" indicator only if the work is slow.
   *
   * The 300ms threshold is the requirement's own number, and it matters: an indicator that appears
   * immediately flashes on every fast operation and trains the user to ignore it, which costs more
   * than the indicator is worth.
   *
   *   var busy = notify.busy('Loading model');
   *   … work …
   *   busy.done();
   */
  function busy(label, delayMs) {
    var delay = core.isNumber(delayMs) ? delayMs : 300;
    var timer = setTimeout(function () { show(); }, delay);
    var shown = null;

    function show() {
      var container = region('tmv-notifications', 'tmv-notifications');
      if (!container) return;
      shown = core.el('div', { class: 'tmv-busy', role: 'status', 'aria-live': 'polite' }, [
        core.el('span', { class: 'tmv-busy__spinner', 'aria-hidden': 'true' }),
        core.el('span', { class: 'tmv-busy__label', text: label || 'Working…' }),
      ]);
      container.appendChild(shown);
    }

    return {
      done: function () {
        clearTimeout(timer);
        if (shown && shown.parentNode) shown.parentNode.removeChild(shown);
        shown = null;
      },
      isShown: function () { return shown !== null; },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 9. Rendering what was retained
  // ---------------------------------------------------------------------------------------------

  /**
   * The retained-outcome panel, for the History tab and for the "what went wrong" affordance.
   *
   * Renders from the record, so it still has the entry after the notification about it was dismissed
   * — which is REQ-UI-009 AC made visible.
   */
  function retainedPanel(opts) {
    var options = opts || {};
    var list = options.level ? entries(options.level) : entries();
    var root = core.el('div', { class: 'tmv-retained' });

    if (!list.length) {
      root.appendChild(widgets.emptyState({
        title: 'Nothing reported yet',
        body: 'Commits, imports, exports and errors will be listed here as they happen.',
      }));
      return root;
    }

    var rows = list.slice().reverse();
    for (var i = 0; i < rows.length; i++) {
      var entry = rows[i];
      root.appendChild(core.el('div', { class: 'tmv-retained__entry', 'data-level': entry.level }, [
        core.el('div', { class: 'tmv-retained__head' }, [
          widgets.tag({ text: entry.level, type: tagType(entry.level) }),
          core.el('span', { class: 'tmv-retained__title', text: entry.title || '(no title)' }),
          core.el('span', { class: 'tmv-retained__time', text: core.formatDateTime(entry.at), title: entry.at }),
        ]),
        entry.detail ? core.el('p', { class: 'tmv-retained__detail', text: entry.detail }) : null,
      ]));
    }
    return root;
  }

  function tagType(level) {
    if (level === 'error') return 'red';
    if (level === 'warning') return 'magenta';
    if (level === 'success') return 'green';
    return 'blue';
  }

  /** The last error as a compact, always-available strip (the header's error affordance). */
  function errorNotice() {
    var last = latestError();
    if (!last) return null;
    return core.el('div', { class: 'tmv-error-notice', role: 'status' }, [
      widgets.tag({ text: 'error', type: 'red' }),
      core.el('span', { class: 'tmv-error-notice__text', text: last.title || last.detail || 'An error was reported' }),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Model switching
  // ---------------------------------------------------------------------------------------------

  /**
   * Clear everything tied to the model that is going away.
   *
   * Banners and toasts describe *this* model's conditions — "the stored copy is newer than the file",
   * "the import reported four warnings" — and carrying them into a different model is how a user ends
   * up reading a warning about a file they closed ten minutes ago. The retained log is kept: it is a
   * record of the session, and the History tab is where a user looks for what happened earlier.
   */
  function resetForModelSwitch() {
    clearAllBanners();
    for (var i = liveToasts.length - 1; i >= 0; i--) liveToasts[i].close('model-switch');
    liveToasts = [];
    announce('');
  }

  /** Everything, including the log. Used by tests and by "start again" in Settings. */
  function reset() {
    resetForModelSwitch();
    retained = [];
  }

  // ---------------------------------------------------------------------------------------------
  // Namespace
  // ---------------------------------------------------------------------------------------------

  TMV.notify = {
    LEVELS: LEVELS,
    MESSAGES: MESSAGES,
    RETAINED_LIMIT: RETAINED_LIMIT,
    TOAST_LIMIT: TOAST_LIMIT,
    TOAST_TIMEOUT: TOAST_TIMEOUT,

    roleFor: roleFor,
    levelClass: levelClass,

    toast: toast,
    banner: banner,
    clearBanner: clearBanner,
    clearAllBanners: clearAllBanners,
    bannerKeys: bannerKeys,

    announce: announce,
    outcome: outcome,
    failure: failure,
    busy: busy,

    entries: entries,
    latestError: latestError,
    retainedPanel: retainedPanel,
    errorNotice: errorNotice,
    onRecord: function (handler) {
      listeners.push(handler);
      return function () {
        var at = listeners.indexOf(handler);
        if (at !== -1) listeners.splice(at, 1);
      };
    },

    liveToasts: function () { return liveToasts.slice(); },
    reset: reset,
    resetForModelSwitch: resetForModelSwitch,
    /** The messages §9 says to get right, as ready-made banners. */
    showMessage: function (key, extra) {
      var spec = MESSAGES[key];
      if (!spec) return null;
      var opts = { key: key, level: spec.level, title: spec.title, body: spec.body };
      var overrides = extra || {};
      var keys = Object.keys(overrides);
      for (var i = 0; i < keys.length; i++) opts[keys[i]] = overrides[keys[i]];
      return banner(opts);
    },
  };
})(globalThis.TMV = globalThis.TMV || {});
