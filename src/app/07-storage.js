/* 07-storage.js — persistence behind one adapter: the registry, quota, and the file↔storage
 * reconcile (`05-storage.md`).
 *
 * The sentence this module exists to make true is *storage is a cache, never the source of truth*
 * (ADR-0001), and three properties of the code below follow from it:
 *
 *   1. **Nothing here is required for the application to work.** Every read has a defined answer
 *      when storage is empty, partitioned, or absent, and none of those answers is "fail". That is
 *      why there are three adapters rather than one with an `isAvailable` flag checked at every
 *      call site.
 *   2. **This is the only file that names `localStorage`** (REQ-STORE-001). A static check over the
 *      built artifact enforces it, because the day a view reads the store directly, the adapter has
 *      stopped being a seam and become a convention.
 *   3. **Writes are ordered blobs first, pointer last; removals the other way round** (§1). The
 *      failure those orderings leave behind is an orphan, which is waste. The one they rule out is a
 *      head naming commits that do not exist, which is corruption.
 *
 * Reconcile lives here too because it is the one place both histories — the file's and the store's —
 * are in hand at once. It is written as a *verdict* rather than as an action: `reconcile` decides,
 * the caller writes. That is what makes REQ-SYNC-005's "reaches the compare view without writing to
 * storage" true by construction rather than by care.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var canonical = TMV.canonical;
  var vcs = TMV.vcs;
  var TmvError = TMV.error;

  var PREFIX = 'tmv:' + TMV.STORAGE_VERSION + ':';
  var REGISTRY_KEY = PREFIX + 'registry';
  var PREFS_KEY = PREFIX + 'prefs';

  /** Prefix of every storage version this build might meet, for the migration scan (§8). */
  var ANY_PREFIX = /^tmv:(\d+):/;

  // ---------------------------------------------------------------------------------------------
  // Keys (§2)
  // ---------------------------------------------------------------------------------------------

  function modelPrefix(modelId) {
    return PREFIX + 'model:' + modelId + ':';
  }

  /**
   * The key set for one model. Model ids are minted here (`core.uuid`), so they are already safe in
   * a key; a model id read from an untrusted file is not, and is rejected by `isModelId` before any
   * key is built from it.
   */
  function keysFor(modelId) {
    var base = modelPrefix(modelId);
    return {
      prefix: base,
      meta: base + 'meta',
      snap: function (commitId) {
        return base + 'snap:' + commitId;
      },
      delta: function (commitId) {
        return base + 'delta:' + commitId;
      },
      cmeta: function (commitId) {
        return base + 'cmeta:' + commitId;
      },
    };
  }

  /**
   * True for an id this module will build a key from.
   *
   * A model id reaches us out of a file anybody could have written, and it goes straight into a
   * storage key — so a `modelId` of `../` or of something with a `:` in it would let a file address
   * another model's keys, or another model's *namespace*. The alphabet is therefore fixed and narrow;
   * everything this application mints (`core.uuid`) and every id `03-data-model.md` §2 permits is
   * inside it.
   */
  function isModelId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
  }

  /** Decode a storage key. Returns null for anything this build does not recognise. */
  function parseKey(key) {
    if (typeof key !== 'string') return null;
    var m = ANY_PREFIX.exec(key);
    if (!m) return null;
    var version = parseInt(m[1], 10);
    var rest = key.slice(m[0].length);
    if (rest === 'registry') return { version: version, kind: 'registry' };
    if (rest === 'prefs') return { version: version, kind: 'prefs' };
    var mm = /^model:([A-Za-z0-9_-]+):(.+)$/.exec(rest);
    if (!mm) return { version: version, kind: 'unknown', key: key };
    var modelId = mm[1];
    var tail = mm[2];
    if (tail === 'meta') return { version: version, kind: 'meta', modelId: modelId };
    var cm = /^(snap|delta|cmeta):(.+)$/.exec(tail);
    if (!cm) return { version: version, kind: 'unknown', key: key, modelId: modelId };
    return { version: version, kind: cm[1], modelId: modelId, commitId: cm[2] };
  }

  // ---------------------------------------------------------------------------------------------
  // Test seam (`09-testing.md` §5)
  // ---------------------------------------------------------------------------------------------
  //
  // Fault injection needs writes to fail on command, and the hook must not exist in anything that
  // ships — its presence in `dist/` is itself a failing test (`store.no-test-hooks-in-release`).
  // Both halves, the counter and its only use, sit inside the marked regions that `build.mjs` strips,
  // so the release artifact contains neither a check nor a variable for it to check.
  //
  // This comment says "the marked regions" rather than naming the sentinel, and that is not coyness:
  // the build's own check is a substring test for that sentinel, so writing it here would fail the
  // build. Which is the correct outcome — a check that has to distinguish a marker from prose about a
  // marker is a check with a gap in it, and the gap would be exactly where a half-stripped hook
  // hides. The build refuses to guess, and the prose gives way.

  /* tmv:test-hook-begin */
  var testFailWritesAt = 0;
  var testHookWrites = 0;
  function testHookBeforeWrite(key) {
    testHookWrites++;
    if (testFailWritesAt > 0 && testHookWrites >= testFailWritesAt) {
      throw TmvError('STORAGE_TEST_FAILURE', 'test hook: refusing the write to ' + key, { key: key });
    }
  }
  /* tmv:test-hook-end */

  // ---------------------------------------------------------------------------------------------
  // Adapters (§1)
  // ---------------------------------------------------------------------------------------------

  /** `localStorage` as a backend, or null when it is absent or refuses to be written (§4). */
  function localBackend() {
    var store = null;
    try {
      // The only reference to `localStorage` in the application (REQ-STORE-001 AC1).
      store = globalThis.localStorage;
      if (!store) return null;
      // A *write* probe, not a presence probe. Safari's private mode has a localStorage that throws
      // on the first setItem, so asking whether it exists answers the wrong question (§4).
      var probe = PREFIX + 'probe';
      store.setItem(probe, '1');
      store.removeItem(probe);
    } catch (err) {
      return null;
    }
    return {
      kind: 'local',
      read: function (key) {
        return store.getItem(key);
      },
      write: function (key, value) {
        store.setItem(key, value);
      },
      remove: function (key) {
        store.removeItem(key);
      },
      keys: function () {
        var out = [];
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  }

  /**
   * An in-memory backend. Full functionality, no persistence — the degradation REQ-STORE-007 asks
   * for, and also the backend the tests run against, so what is tested is what ships.
   */
  function memoryBackend(seed) {
    var data = Object.create(null);
    if (core.isObject(seed)) {
      var seedKeys = Object.keys(seed);
      for (var i = 0; i < seedKeys.length; i++) data[seedKeys[i]] = String(seed[seedKeys[i]]);
    }
    function drop(key) {
      // `delete` on a null-prototype object, never a key of the shared Object prototype. This object
      // only ever holds keys we wrote — but the habit is the point (`08-security.md` §5).
      delete data[key];
    }
    return {
      kind: 'memory',
      read: function (key) {
        return core.has(data, key) ? data[key] : null;
      },
      write: function (key, value) {
        data[key] = value;
      },
      remove: drop,
      keys: function () {
        return Object.keys(data);
      },
    };
  }

  /** Bytes this adapter accounts for a key: its name and its value, as the browser charges for both. */
  function sizeOf(key, value) {
    return core.utf8Length(key) + core.utf8Length(value);
  }

  /**
   * The adapter itself: accounting, the write ordering's building block, and change notification
   * around a backend. `LocalStorageAdapter` and `MemoryAdapter` are the same object over different
   * media, which is the honest version of the spec's table — the difference between them is one
   * function, not one behaviour.
   */
  function makeAdapter(backend, options) {
    var opts = options || {};
    var writable = opts.writable !== false;
    var refuseReason = opts.refuseReason || 'This file is open in read-only mode, so nothing was saved.';
    var bytes = 0;
    var keyCount = 0;

    /**
     * Our own tally, recomputed from the backend (§5). Recomputing at construction rather than
     * trusting a running total is what makes the number right after a crash: the spec asks for
     * "our own accounting, not the browser's", and an account that can drift from what is on disk is
     * worse than a recount that costs one pass over at most a few megabytes.
     */
    function recount() {
      bytes = 0;
      keyCount = 0;
      var ks = backend.keys();
      for (var i = 0; i < ks.length; i++) {
        var v = backend.read(ks[i]);
        if (v === null) continue;
        bytes += sizeOf(ks[i], v);
        keyCount += 1;
      }
      return { bytes: bytes, keys: keyCount };
    }

    recount();

    function read(key) {
      try {
        return backend.read(key);
      } catch (err) {
        // A backend that throws on read is a backend that is gone. Absent history is a state this
        // application handles; a thrown error from the middle of a boot is not.
        return null;
      }
    }

    function write(key, value) {
      if (!writable) throw TmvError('STORAGE_READ_ONLY', refuseReason, { key: key });
      var text = core.isString(value) ? value : JSON.stringify(value);
      /* tmv:test-hook-begin */
      testHookBeforeWrite(key);
      /* tmv:test-hook-end */
      var existing = read(key);
      try {
        backend.write(key, text);
      } catch (err) {
        throw TmvError(
          'STORAGE_QUOTA',
          'The browser refused to save: ' + (err && err.message ? err.message : 'storage is full'),
          { key: key, bytes: core.utf8Length(text) },
        );
      }
      if (existing === null) keyCount += 1;
      else bytes -= sizeOf(key, existing);
      bytes += sizeOf(key, text);
      return text;
    }

    function remove(key) {
      if (!writable) throw TmvError('STORAGE_READ_ONLY', refuseReason, { key: key });
      var existing = read(key);
      try {
        backend.remove(key);
      } catch (err) {
        return false;
      }
      if (existing !== null) {
        bytes -= sizeOf(key, existing);
        keyCount -= 1;
      }
      return true;
    }

    function keys(prefix) {
      var all = backend.keys();
      var out = [];
      for (var i = 0; i < all.length; i++) {
        if (core.isString(prefix) && all[i].indexOf(prefix) !== 0) continue;
        out.push(all[i]);
      }
      return out.sort();
    }

    /**
     * Cross-tab change notification (§6). Advisory by construction: the `storage` event does not
     * fire reliably on `file://`, so nothing in this application may depend on a subscriber running.
     * A missing event listener (the test harness, an exotic host) yields an unsubscribe that does
     * nothing, which is the same contract.
     */
    function subscribe(fn) {
      if (backend.kind !== 'local') return function () {};
      if (typeof globalThis.addEventListener !== 'function') return function () {};
      var listener = function (event) {
        if (!event || !core.isString(event.key) || event.key.indexOf(PREFIX) !== 0) return;
        fn({ key: event.key, oldValue: event.oldValue, newValue: event.newValue });
      };
      globalThis.addEventListener('storage', listener);
      return function () {
        globalThis.removeEventListener('storage', listener);
      };
    }

    function usage() {
      return { bytes: bytes, keys: keyCount };
    }

    return {
      kind: backend.kind,
      isAvailable: function () {
        return true;
      },
      writable: function () {
        return writable;
      },
      refuseReason: function () {
        return writable ? null : refuseReason;
      },
      read: read,
      write: write,
      remove: remove,
      keys: keys,
      usage: usage,
      recount: recount,
      subscribe: subscribe,
    };
  }

  /**
   * Choose an adapter. This is the whole of §1's table, in one place:
   *
   *   read-only mode        → NullAdapter   (reads permitted, writes refused with an explanation)
   *   `localStorage` works  → LocalStorageAdapter
   *   it does not           → MemoryAdapter, and a notice the user must see (REQ-STORE-007)
   *
   * Returns the notice rather than raising it, because the caller — boot — is the only thing that
   * knows how to say it.
   */
  function createAdapter(options) {
    var opts = options || {};
    if (opts.readOnly === true) {
      var roBackend = opts.backend === 'memory' ? memoryBackend(opts.seed) : localBackend() || memoryBackend();
      return {
        adapter: makeAdapter(roBackend, {
          writable: false,
          refuseReason:
            opts.refuseReason ||
            'This file is open read-only, so changes cannot be saved. Export a copy to edit it.',
        }),
        notice: null,
      };
    }
    if (opts.backend === 'memory') return { adapter: makeAdapter(memoryBackend(opts.seed)), notice: null };
    var local = localBackend();
    if (local) return { adapter: makeAdapter(local), notice: null };
    return {
      adapter: makeAdapter(memoryBackend(opts.seed)),
      notice: {
        code: 'STORAGE_UNAVAILABLE',
        kind: 'warning',
        title: 'Changes will not be saved',
        message:
          'This browser is not letting the page use local storage, so the application is running with ' +
          'memory only. Everything works — viewing, editing, importing and exporting — but changes are ' +
          'lost when this page is reloaded or closed. Exporting writes a file you can keep.',
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // JSON over the adapter
  // ---------------------------------------------------------------------------------------------

  /** Read and parse a JSON value. A corrupt or absent value yields the fallback, never a throw. */
  function readJson(adapter, key, fallback) {
    var text = adapter.read(key);
    if (!core.isString(text)) return fallback;
    try {
      var value = JSON.parse(text);
      return core.isObject(value) || core.isArray(value) ? value : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(adapter, key, value) {
    adapter.write(key, canonical.serialize(value));
  }

  // ---------------------------------------------------------------------------------------------
  // Preferences (§2)
  // ---------------------------------------------------------------------------------------------

  /** First-run theme from the OS preference — the only automatic theme choice the app makes. */
  function osPreferredTheme() {
    try {
      if (typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'cds--g100';
      }
    } catch (err) {
      /* no matchMedia, no opinion */
    }
    return 'cds--g10';
  }

  /** Carbon's `lg` breakpoint, in CSS pixels (`07-ui.md` §7). Below it the side nav starts collapsed. */
  var LG_BREAKPOINT = 1056;

  /**
   * How wide the viewport is, or `null` when there is nothing to ask.
   *
   * `innerWidth` first, because that is the number a browser actually has. The document element's
   * `clientWidth` second, because that is the number a host without a window has — including the unit
   * harness's stub document. Anything that is not a positive finite number means "no viewport to go
   * on", and the caller keeps its non-responsive answer rather than inventing one.
   */
  function viewportWidth() {
    try {
      var inner = globalThis.innerWidth;
      if (core.isNumber(inner) && inner > 0) return inner;
      var doc = globalThis.document;
      var root = doc && doc.documentElement;
      var client = root && root.clientWidth;
      if (core.isNumber(client) && client > 0) return client;
    } catch (err) {
      /* no viewport, no opinion */
    }
    return null;
  }

  /**
   * The side nav's state on first run, from the viewport (`07-ui.md` §7).
   *
   * §7 gives the nav a *different default at each breakpoint*: expanded at 16rem at `lg` and above,
   * the 3rem rail at `md`, and at `sm` an overlay that is "opened from the header trigger" — which
   * means it starts closed. So a constant `false` is wrong at two of the three, and it was: the app
   * opened at 320px with the drawer over the content, and at 700px with a 16rem column where §7 asks
   * for a rail.
   *
   * This is a first-run default, not a layout rule. `00-app.css` is what turns one collapsed/expanded
   * flag into a rail at `md` and an off-canvas drawer at `sm`; all that was missing was the flag's
   * initial value.
   *
   * Once the user touches the nav — the header trigger, or Settings → Appearance — the boolean is
   * stored and `readPrefs` returns it, so this function is not consulted again. That is REQ-UI-003
   * AC3 ("the collapsed/expanded state persists across reloads"). The cost is that the first write of
   * preferences records whatever the viewport suggested, so someone who opens the same storage on a
   * much wider screen afterwards keeps the rail until they say otherwise. That is the trade the app
   * makes for every preference-shaped value, the resulting state is visible and reversible from
   * Settings, and the alternative — recording whether a value was *chosen* or *derived* so that a
   * resize could re-derive it — is a second piece of stored state whose whole job would be to undo a
   * default nobody asked for. Resizing a window across a breakpoint therefore does not re-run this,
   * and it does not need to: every width is already usable, because the CSS gives whichever state is
   * current a rail above `sm` and a drawer below it, and Settings carries the control either way.
   *
   * With no viewport at all this answers expanded, which is what the app did before §7's table was
   * honoured — so the stub-document tests keep exercising the wide layout.
   */
  function defaultSideNavCollapsed() {
    var width = viewportWidth();
    if (width === null) return false;
    return width < LG_BREAKPOINT;
  }

  /**
   * Preferences are the one thing that may be silently reset (§2): losing a theme choice is not
   * losing work, so a corrupt `prefs` is replaced with defaults rather than reported.
   */
  /**
   * `extensionDomain` is the TML provenance namespace (OQ-02, `06-interchange.md` §9).
   *
   * TML's `extensions` keys must match `domain.tld/extension-name`, so provenance cannot be written
   * without naming a domain — and the project owns none, so it will not invent one that belongs to
   * somebody else. Empty means "not configured", and the TML export then omits provenance and says so
   * in its report rather than failing. It is a preference rather than a model field because it is a
   * fact about the tool running the export, not about the threat model being exported.
   */
  function defaultPrefs() {
    return {
      theme: osPreferredTheme(),
      activeTab: 'overview',
      sideNavCollapsed: defaultSideNavCollapsed(),
      identity: { name: '', email: '' },
      extensionDomain: '',
      keyframeInterval: TMV.DEFAULT_KEYFRAME_INTERVAL,
      lastModelId: null,
    };
  }

  function readPrefs(adapter) {
    var raw = readJson(adapter, PREFS_KEY, null);
    var prefs = defaultPrefs();
    if (!core.isObject(raw)) return prefs;
    if (core.isString(raw.theme) && raw.theme) prefs.theme = raw.theme;
    if (core.isString(raw.activeTab) && raw.activeTab) prefs.activeTab = raw.activeTab;
    if (core.isBoolean(raw.sideNavCollapsed)) prefs.sideNavCollapsed = raw.sideNavCollapsed;
    if (core.isNumber(raw.keyframeInterval) && raw.keyframeInterval >= 1) {
      prefs.keyframeInterval = Math.round(raw.keyframeInterval);
    }
    if (core.isString(raw.lastModelId) && isModelId(raw.lastModelId)) prefs.lastModelId = raw.lastModelId;
    if (core.isString(raw.extensionDomain)) prefs.extensionDomain = core.nfc(raw.extensionDomain).trim();
    if (core.isObject(raw.identity)) {
      prefs.identity = {
        name: core.isString(raw.identity.name) ? core.nfc(raw.identity.name) : '',
        email: core.isString(raw.identity.email) ? core.nfc(raw.identity.email) : '',
      };
    }
    return prefs;
  }

  /**
   * Merge a patch into stored preferences.
   *
   * Returns `{prefs, saved, reason}` rather than the preferences alone, because in read-only mode the
   * honest answer is "here is the new value, and it was not written". A theme still applies for the
   * session; it just will not be there next time, and the caller can say so once rather than the
   * adapter failing on every toggle.
   */
  function writePrefs(adapter, patch) {
    var prefs = readPrefs(adapter);
    var next = core.deepCopy(prefs);
    var ks = Object.keys(patch || {});
    for (var i = 0; i < ks.length; i++) next[ks[i]] = core.deepCopy(patch[ks[i]]);
    if (!adapter.writable()) return { prefs: next, saved: false, reason: adapter.refuseReason() };
    writeJson(adapter, PREFS_KEY, next);
    return { prefs: next, saved: true, reason: null };
  }

  // ---------------------------------------------------------------------------------------------
  // The registry (§2, §3)
  // ---------------------------------------------------------------------------------------------

  function readRegistry(adapter) {
    var raw = readJson(adapter, REGISTRY_KEY, []);
    if (!core.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = normalizeEntry(raw[i]);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** One registry entry, rebuilt field by field. Nothing from storage is trusted into an object. */
  function normalizeEntry(raw) {
    if (!core.isObject(raw) || !isModelId(raw.modelId)) return null;
    var entry = {
      modelId: raw.modelId,
      name: core.isString(raw.name) ? core.nfc(raw.name) : raw.modelId,
      headCommitId: core.isString(raw.headCommitId) ? raw.headCommitId : null,
      commitCount: core.isNumber(raw.commitCount) ? Math.max(0, Math.round(raw.commitCount)) : 0,
      bytes: core.isNumber(raw.bytes) ? Math.max(0, Math.round(raw.bytes)) : 0,
      lastOpenedAt: core.isString(raw.lastOpenedAt) ? raw.lastOpenedAt : null,
      sourceHint: null,
    };
    if (core.isObject(raw.sourceHint)) {
      entry.sourceHint = {
        filename: core.isString(raw.sourceHint.filename) ? core.nfc(raw.sourceHint.filename) : null,
        format: core.isString(raw.sourceHint.format) ? raw.sourceHint.format : null,
      };
    }
    return entry;
  }

  function writeRegistry(adapter, entries) {
    writeJson(adapter, REGISTRY_KEY, entries);
    return entries;
  }

  /** Insert or replace one entry by `modelId`. Returns the new list and which way it went. */
  function upsertRegistry(adapter, entry) {
    var normalized = normalizeEntry(entry);
    if (!normalized) throw TmvError('STORAGE_ENTRY', 'A registry entry without a usable model id.');
    var entries = readRegistry(adapter);
    var replaced = false;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].modelId === normalized.modelId) {
        entries[i] = normalized;
        replaced = true;
        break;
      }
    }
    if (!replaced) entries.push(normalized);
    writeRegistry(adapter, entries);
    return { entries: entries, replaced: replaced };
  }

  /** The switcher's list: newest-opened first, by name as a tiebreak. */
  function listModels(adapter) {
    var entries = readRegistry(adapter);
    entries.sort(function (a, b) {
      var at = a.lastOpenedAt || '';
      var bt = b.lastOpenedAt || '';
      if (at !== bt) return at < bt ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  /** Model ids that actually have keys in storage — the registry is an index, not an authority. */
  function storedModelIds(adapter) {
    var ks = adapter.keys(PREFIX + 'model:');
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < ks.length; i++) {
      var parsed = parseKey(ks[i]);
      if (!parsed || !parsed.modelId) continue;
      if (seen[parsed.modelId]) continue;
      seen[parsed.modelId] = true;
      out.push(parsed.modelId);
    }
    return out;
  }

  /**
   * The registry entry that describes the *embedded* model, so the model switcher can always offer
   * "the model in this file" (REQ-STORE-004 AC2). It is built from the file, never read from storage.
   */
  function embeddedEntry(container, options) {
    var opts = options || {};
    var history = container.history || { commits: [] };
    var model = container.model || {};
    var head = core.isString(history.head) ? history.head : null;
    var commits = core.isArray(history.commits) ? history.commits : [];
    var bytes = core.utf8Length(canonical.serialize(container));
    return {
      modelId: core.isString(model.modelId) && isModelId(model.modelId) ? model.modelId : null,
      name: core.isString(model.name) ? core.nfc(model.name) : 'Untitled Threat Model',
      headCommitId: head,
      commitCount: commits.length,
      bytes: bytes,
      lastOpenedAt: opts.now || new Date().toISOString(),
      sourceHint: { filename: opts.filename || null, format: 'container' },
      embedded: true,
    };
  }

  /**
   * Seed the registry from the file, on **every** load (REQ-STORE-003).
   *
   * The rule that keeps this from being destructive is worth stating, because "upsert from the file
   * on every load" naively read would clobber a local history that is ahead of the file's
   * (REQ-SYNC-003). The registry indexes *storage*, so:
   *
   *   - no `meta` for this model → storage knows nothing; write the file's entry. This is the
   *     cleared-store and first-run case, and it is the whole point of seeding on every load;
   *   - `meta` present → storage's own record wins for the head, the count and the size, and only
   *     the presentation fields (name, source hint, last opened) are refreshed from the file.
   *
   * So the registry is repopulated from the file alone exactly when the file is all there is, and
   * never downgraded to a file's older head while a newer local history exists. Returns
   * `{ action, entry }` where action is `created`, `refreshed` or `kept`.
   */
  function seedRegistry(adapter, container, options) {
    var fileEntry = embeddedEntry(container, options);
    if (!fileEntry.modelId) return { action: 'skipped', entry: null, reason: 'the file has no usable model id' };
    if (!adapter.writable()) return { action: 'skipped', entry: null, reason: adapter.refuseReason() };

    var previous = null;
    var entries = readRegistry(adapter);
    for (var i = 0; i < entries.length; i++) if (entries[i].modelId === fileEntry.modelId) previous = entries[i];

    if (!previous) {
      upsertRegistry(adapter, fileEntry);
      return { action: 'created', entry: fileEntry, historyChanged: true };
    }

    var meta = readMeta(adapter, fileEntry.modelId);
    var entry = {
      modelId: fileEntry.modelId,
      name: fileEntry.name,
      // Storage's own record describes what is stored; the file only fills in what storage cannot
      // know. Without a `meta` the entry itself is the record, and is left exactly as it stands.
      headCommitId: meta ? meta.headCommitId : previous.headCommitId,
      commitCount: meta ? meta.commitCount : previous.commitCount,
      bytes: meta ? storedBytes(adapter, fileEntry.modelId) : previous.bytes,
      lastOpenedAt: fileEntry.lastOpenedAt,
      sourceHint: fileEntry.sourceHint,
    };
    var historyChanged = entry.headCommitId !== previous.headCommitId || entry.commitCount !== previous.commitCount;
    if (
      !historyChanged &&
      entry.name === previous.name &&
      entry.lastOpenedAt === previous.lastOpenedAt &&
      sameSourceHint(entry.sourceHint, previous.sourceHint)
    ) {
      return { action: 'kept', entry: previous, historyChanged: false };
    }
    upsertRegistry(adapter, entry);
    return { action: 'refreshed', entry: entry, historyChanged: historyChanged };
  }

  function sameSourceHint(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.filename === b.filename && a.format === b.format;
  }

  // ---------------------------------------------------------------------------------------------
  // Model persistence (§1, §2, §6)
  // ---------------------------------------------------------------------------------------------

  function readMeta(adapter, modelId) {
    if (!isModelId(modelId)) return null;
    var raw = readJson(adapter, keysFor(modelId).meta, null);
    if (!core.isObject(raw)) return null;
    if (!core.isString(raw.writeToken)) return null;
    return {
      modelId: modelId,
      headCommitId: core.isString(raw.headCommitId) ? raw.headCommitId : null,
      commitCount: core.isNumber(raw.commitCount) ? Math.round(raw.commitCount) : 0,
      keyframeInterval: core.isNumber(raw.keyframeInterval) ? raw.keyframeInterval : TMV.DEFAULT_KEYFRAME_INTERVAL,
      writeToken: raw.writeToken,
      updatedAt: core.isString(raw.updatedAt) ? raw.updatedAt : null,
    };
  }

  /** Total bytes of one model's keys, from the per-key records rather than a stored total. */
  function storedBytes(adapter, modelId) {
    var ks = adapter.keys(modelPrefix(modelId));
    var total = 0;
    for (var i = 0; i < ks.length; i++) {
      var value = adapter.read(ks[i]);
      if (value !== null) total += sizeOf(ks[i], value);
    }
    return total;
  }

  /** The commit record as stored: everything the hash covers, plus where to find its payload. */
  function cmetaOf(commit) {
    return {
      id: commit.id,
      parents: commit.parents || [],
      modelId: commit.modelId,
      author: commit.author,
      timestamp: commit.timestamp,
      message: commit.message,
      modelHash: commit.modelHash,
      isKeyframe: commit.isKeyframe === true,
    };
  }

  /**
   * Save a model's history. Blobs first, the meta pointer last (§1) — an interruption leaves
   * unreferenced blobs, which `collect` tidies, and never a head naming a commit that is not there.
   *
   * Optimistic concurrency is the caller's guard, not this function's: `expectedWriteToken` is the
   * token the caller loaded, and a mismatch means another tab committed while this one was editing.
   * The check is repeated immediately before the pointer is written, which closes the window to a
   * single synchronous step — local storage operations are single-threaded per origin, so the
   * re-check and the write cannot be interleaved inside this tab (§6).
   */
  function saveModel(adapter, history, options) {
    var opts = options || {};
    var commits = core.isArray(history && history.commits) ? history.commits : [];
    var head = core.isString(history && history.head) ? history.head : null;
    var modelId = opts.modelId || (commits.length ? commits[commits.length - 1].modelId : null);
    if (!isModelId(modelId)) {
      throw TmvError('STORAGE_MODEL_ID', 'Refusing to save: no usable model id.', { modelId: modelId });
    }
    if (!adapter.writable()) {
      return { ok: false, reason: 'read-only', message: adapter.refuseReason() };
    }
    var keys = keysFor(modelId);
    var before = readMeta(adapter, modelId);
    var beforeToken = before ? before.writeToken : null;

    if (opts.expectedWriteToken !== undefined && opts.expectedWriteToken !== null) {
      if (beforeToken !== opts.expectedWriteToken) {
        return {
          ok: false,
          reason: 'conflict',
          message:
            'Another tab saved this model since it was opened here, so this commit was not written. ' +
            'The working copy is untouched.',
          meta: before,
        };
      }
    }

    // Pre-flight (§5): a write that would cross the warning threshold is a choice the user gets to
    // make *before* it happens, and this function's caller shows it.
    var projection = projectWrite(adapter, modelId, commits);
    if (opts.preflight !== false) {
      var gaugeBefore = gauge(adapter);
      var level = levelFor(gaugeBefore.bytes + projection.bytes, gaugeBefore.budget);
      if ((level === 'warning' || level === 'exhausted') && !opts.allowOverThreshold) {
        return {
          ok: false,
          reason: 'quota',
          level: level,
          message:
            'Saving needs about ' +
            core.bytes(projection.bytes) +
            ', which would take this origin to about ' +
            core.bytes(gaugeBefore.bytes + projection.bytes) +
            ' of roughly ' +
            core.bytes(gaugeBefore.budget) +
            '. Nothing has been written yet.',
          gauge: gaugeBefore,
          projection: projection,
        };
      }
    }

    var written = [];
    var skipped = [];
    for (var i = 0; i < commits.length; i++) {
      var commit = commits[i];
      if (!core.isObject(commit) || !core.isString(commit.id)) continue;
      var payloadKey = commit.isKeyframe ? keys.snap(commit.id) : keys.delta(commit.id);
      var metaKey = keys.cmeta(commit.id);
      var payloadPresent = adapter.read(payloadKey) !== null;
      var metaPresent = adapter.read(metaKey) !== null;
      if (payloadPresent && metaPresent) {
        skipped.push(commit.id);
        continue;
      }
      // Payload, then the record that says where the payload is.
      if (commit.isKeyframe) {
        if (!payloadPresent) adapter.write(payloadKey, canonical.serialize(commit.snapshot));
      } else if (core.isArray(commit.delta) || core.isObject(commit.delta)) {
        if (!payloadPresent) adapter.write(payloadKey, canonical.serialize(commit.delta));
      } else if (!payloadPresent) {
        // A non-keyframe with no delta cannot be stored without inventing one; say so rather than
        // writing a commit the reader will not be able to replay.
        throw TmvError('STORAGE_NO_PAYLOAD', 'Commit ' + commit.id + ' is neither a keyframe nor a delta.', {
          commitId: commit.id,
        });
      }
      adapter.write(metaKey, canonical.serialize(cmetaOf(commit)));
      written.push(commit.id);
    }

    // The pointer, checked once more immediately before it is written (§6).
    var nowMeta = readMeta(adapter, modelId);
    if (opts.expectedWriteToken !== undefined && opts.expectedWriteToken !== null) {
      var nowToken = nowMeta ? nowMeta.writeToken : null;
      if (nowToken !== opts.expectedWriteToken) {
        return {
          ok: false,
          reason: 'conflict',
          message: 'Another tab saved this model while this one was writing, so the head was not moved.',
          meta: nowMeta,
        };
      }
    }

    var token = core.uuid();
    adapter.write(
      keys.meta,
      canonical.serialize({
        modelId: modelId,
        headCommitId: head,
        commitCount: commits.length,
        keyframeInterval: (history && history.keyframeInterval) || TMV.DEFAULT_KEYFRAME_INTERVAL,
        writeToken: token,
        updatedAt: opts.now || new Date().toISOString(),
      }),
    );

    // The registry is a pointer too, so it follows the meta rather than leading it. A crash between
    // the two leaves an index that is behind, which the next load re-derives from `meta`.
    upsertRegistry(adapter, {
      modelId: modelId,
      name: opts.name || (opts.model && core.isString(opts.model.name) ? core.nfc(opts.model.name) : 'Untitled Threat Model'),
      headCommitId: head,
      commitCount: commits.length,
      bytes: storedBytes(adapter, modelId),
      lastOpenedAt: opts.now || new Date().toISOString(),
      sourceHint: opts.sourceHint || null,
    });

    return { ok: true, writeToken: token, written: written, skipped: skipped, bytes: storedBytes(adapter, modelId) };
  }

  /** What a save would add: commits storage does not already hold, plus the new meta record. */
  function projectWrite(adapter, modelId, commits) {
    var keys = keysFor(modelId);
    var total = 0;
    var missing = 0;
    for (var i = 0; i < commits.length; i++) {
      var commit = commits[i];
      if (!core.isObject(commit) || !core.isString(commit.id)) continue;
      var payloadKey = commit.isKeyframe ? keys.snap(commit.id) : keys.delta(commit.id);
      if (adapter.read(payloadKey) !== null && adapter.read(keys.cmeta(commit.id)) !== null) continue;
      missing += 1;
      var payload = commit.isKeyframe ? commit.snapshot : commit.delta;
      total += payload === undefined || payload === null ? 0 : core.utf8Length(canonical.serialize(payload));
      total += 320; // the commit record, near enough; the estimate decides a prompt, not a byte count
    }
    return { bytes: total, commits: missing };
  }

  /**
   * Load a model's history. Returns a verdict rather than throwing, for the same reason the
   * container parser does: there is a screen for "your local copy is damaged, here is the file's",
   * and there is none for an exception during boot.
   *
   * `ok:false` with `reason:'corrupt'` means the commits are all present but do not reconstruct —
   * the failure mode a write interrupted between two keys can produce, and the one the write
   * ordering is designed to make impossible. It is checked rather than assumed, because the case it
   * protects against is a file written by a *different* build.
   */
  function loadModel(adapter, modelId) {
    if (!isModelId(modelId)) return { ok: false, reason: 'invalid', message: 'No usable model id.' };
    var meta = readMeta(adapter, modelId);
    if (!meta) return { ok: false, reason: 'absent', message: 'Nothing is stored for this model.' };

    var keys = keysFor(modelId);
    var keyList = adapter.keys(keys.prefix + 'cmeta:');
    var commits = [];
    for (var i = 0; i < keyList.length; i++) {
      var parsed = parseKey(keyList[i]);
      if (!parsed || parsed.kind !== 'cmeta' || !parsed.commitId) continue;
      var record = readJson(adapter, keyList[i], null);
      if (!core.isObject(record) || !core.isString(record.id)) continue;
      var isKeyframe = record.isKeyframe === true;
      var payloadText = adapter.read(isKeyframe ? keys.snap(record.id) : keys.delta(record.id));
      if (payloadText === null) continue; // payload missing: the commit is not loadable, so it is not loaded
      var payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (err) {
        continue;
      }
      commits.push({
        id: record.id,
        parents: core.isArray(record.parents) ? record.parents.slice() : [],
        modelId: record.modelId,
        author: record.author,
        timestamp: record.timestamp,
        message: record.message,
        modelHash: record.modelHash,
        isKeyframe: isKeyframe,
        snapshot: isKeyframe ? payload : null,
        delta: isKeyframe ? null : payload,
      });
    }

    var raw = {
      keyframeInterval: meta.keyframeInterval,
      head: meta.headCommitId,
      commits: commits,
    };
    // `adopt` sorts what untrusted arrays never guaranteed was sorted, and verifies the chain — both
    // of which storage has to do for the same reason a parsed file does: these bytes are on disk,
    // not in our care.
    var adopted = vcs.adopt(raw);
    var history = adopted.history;

    if (history.head && !vcs.commitById(history, history.head)) {
      return {
        ok: false,
        reason: 'dangling',
        meta: meta,
        history: history,
        message:
          'The stored history names a head commit (' +
          core.shortId(history.head) +
          ') that is not present. Nothing was changed; the file on disk still has the model.',
      };
    }
    if (!adopted.verdict.ok) {
      return { ok: false, reason: 'chain', meta: meta, history: history, verdict: adopted.verdict };
    }

    var model = vcs.headModel(history);
    var modelVerdict = vcs.verifyModel(history, history.head);
    if (!modelVerdict.ok) {
      return {
        ok: false,
        reason: 'corrupt',
        meta: meta,
        history: history,
        verdict: modelVerdict,
        message: 'The stored commits are present but do not reconstruct the model they claim to hold.',
      };
    }
    return { ok: true, history: history, meta: meta, model: model, verdict: adopted.verdict };
  }

  /**
   * Delete a model from storage (REQ-STORE-005). Registry entry first, then blobs (§1, §7) — the
   * reverse would leave the index naming a model whose commits are gone.
   *
   * This is the only destructive operation in the application, and it is deliberately narrow: it
   * removes what is *in this browser*, and the confirmation that precedes it says so in those words.
   */
  function deleteModel(adapter, modelId) {
    if (!isModelId(modelId)) throw TmvError('STORAGE_MODEL_ID', 'Refusing to delete: no usable model id.');
    if (!adapter.writable()) throw TmvError('STORAGE_READ_ONLY', adapter.refuseReason(), { modelId: modelId });
    var entries = readRegistry(adapter);
    var kept = [];
    var removedEntry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].modelId === modelId) removedEntry = entries[i];
      else kept.push(entries[i]);
    }
    var bytes = storedBytes(adapter, modelId);
    if (removedEntry) writeRegistry(adapter, kept); // pointer first
    var ks = adapter.keys(modelPrefix(modelId));
    for (var j = 0; j < ks.length; j++) adapter.remove(ks[j]); // then the blobs
    var prefs = readPrefs(adapter);
    if (prefs.lastModelId === modelId) writePrefs(adapter, { lastModelId: null });
    return { modelId: modelId, removed: ks.length, bytes: bytes, entry: removedEntry, remaining: kept.length };
  }

  // ---------------------------------------------------------------------------------------------
  // Unreachable commits and redundant keyframes (REQ-STORE-008)
  // ---------------------------------------------------------------------------------------------

  /**
   * What could be collected, and — only when asked — the collecting.
   *
   * Two things are collectable and both are *reported before they are removed* (REQ-STORE-008 AC1):
   *
   *   unreachable commits  stored, but not reachable from the head. They are what a reverted branch
   *                        or an adopted-but-not-merged history leaves behind, and nothing in the
   *                        application can ever show them again.
   *   redundant keyframes  keyframes the interval rule would not place. Removing one is not a
   *                        deletion of a commit: it is re-keyframing, so the commit survives and
   *                        `vcs.compact` preserves its id. That is why this is offered under the same
   *                        report as the other: the user is choosing to re-lay-out storage, not to
   *                        lose anything.
   *
   * **Nothing here runs without `confirm === true`** (REQ-STORE-006 AC3). Not on quota pressure, not
   * because a commit is "obviously unreachable". The history is the user's work and may be the only
   * copy of it, so the dry run is the default and the explicit flag is the only way past it.
   */
  function collect(adapter, history, options) {
    var opts = options || {};
    var modelId = opts.modelId || (history && history.commits.length ? history.commits[0].modelId : null);
    if (!isModelId(modelId)) throw TmvError('STORAGE_MODEL_ID', 'Refusing to collect: no usable model id.');
    var keys = keysFor(modelId);

    // `reachableFrom` answers with a map keyed by id, and an empty map for an unknown head — so a
    // history with no head reachable leaves every stored commit looking unreachable, which is
    // exactly the situation in which this must not guess.
    var reachable = Object.create(null);
    if (history && core.isString(history.head)) {
      var reached = vcs.reachableFrom(history, history.head);
      var reachedIds = Object.keys(reached);
      for (var r = 0; r < reachedIds.length; r++) reachable[reachedIds[r]] = true;
    }

    var unreachableIds = Object.create(null);
    var cmetaKeys = adapter.keys(keys.prefix + 'cmeta:');
    for (var i = 0; i < cmetaKeys.length; i++) {
      var parsed = parseKey(cmetaKeys[i]);
      if (!parsed || !parsed.commitId || reachable[parsed.commitId]) continue;
      unreachableIds[parsed.commitId] = true;
    }
    // Sized by summing the keys each unreachable commit actually owns, rather than a per-commit
    // figure: a commit's bytes are spread across up to three keys, and a report that is about to
    // remove data should quote what it will really free.
    var unreachable = Object.keys(unreachableIds);
    var unreachableBytes = 0;
    var allKeys = adapter.keys(keys.prefix);
    for (var k = 0; k < allKeys.length; k++) {
      var p = parseKey(allKeys[k]);
      if (!p || !p.commitId || !unreachableIds[p.commitId]) continue;
      var value = adapter.read(allKeys[k]);
      if (value !== null) unreachableBytes += sizeOf(allKeys[k], value);
    }

    var compacted = history ? vcs.compact(history) : null;
    var redundant = [];
    if (compacted) {
      var keptKeyframes = Object.create(null);
      for (var c = 0; c < compacted.history.commits.length; c++) {
        if (compacted.history.commits[c].isKeyframe) keptKeyframes[compacted.history.commits[c].id] = true;
      }
      for (var d = 0; d < (history.commits || []).length; d++) {
        var commit = history.commits[d];
        if (!commit.isKeyframe || keptKeyframes[commit.id]) continue;
        var snapKey = keys.snap(commit.id);
        var snapValue = adapter.read(snapKey);
        redundant.push({ id: commit.id, bytes: snapValue === null ? 0 : sizeOf(snapKey, snapValue) });
      }
    }

    var report = {
      modelId: modelId,
      unreachable: unreachable,
      unreachableBytes: unreachableBytes,
      redundantKeyframes: redundant,
      redundantBytes: redundant.reduce(function (sum, item) {
        return sum + item.bytes;
      }, 0),
      before: storedBytes(adapter, modelId),
      confirmed: opts.confirm === true,
    };
    report.bytes = report.unreachableBytes + report.redundantBytes;

    if (opts.confirm !== true) return report;
    if (!adapter.writable()) throw TmvError('STORAGE_READ_ONLY', adapter.refuseReason(), { modelId: modelId });

    var removed = 0;
    for (var m = 0; m < allKeys.length; m++) {
      var q = parseKey(allKeys[m]);
      if (!q || !q.commitId || !unreachableIds[q.commitId]) continue;
      adapter.remove(allKeys[m]);
      removed += 1;
    }
    report.removed = removed;

    // Redundant keyframes are dropped by rewriting the history at the current interval, not by
    // deleting commits: `compact` preserves every reachable commit and its id.
    if (compacted && typeof opts.save === 'function') {
      opts.save(compacted.history);
      report.rekeyframed = compacted.report;
    }
    report.after = storedBytes(adapter, modelId);
    return report;
  }

  // ---------------------------------------------------------------------------------------------
  // Quota (§5)
  // ---------------------------------------------------------------------------------------------

  /** The four levels of §5, from a byte count and a budget. */
  function levelFor(bytes, budget) {
    var b = core.isNumber(budget) && budget > 0 ? budget : TMV.QUOTA.budgetBytes;
    if (bytes >= b) return 'exhausted';
    var ratio = bytes / b;
    if (ratio >= TMV.QUOTA.warning) return 'warning';
    if (ratio >= TMV.QUOTA.elevated) return 'elevated';
    return 'normal';
  }

  /**
   * Storage usage as this application accounts for it, plus the platform's own estimate when the
   * platform offers one (§5). The platform number is advisory: it is not available on `file://` in
   * any browser, which is why the tally exists.
   */
  function gauge(adapter, options) {
    var opts = options || {};
    var usage = adapter.usage();
    var budget = opts.budget || TMV.QUOTA.budgetBytes;
    return {
      bytes: usage.bytes,
      keys: usage.keys,
      budget: budget,
      ratio: budget > 0 ? usage.bytes / budget : 0,
      level: levelFor(usage.bytes, budget),
    };
  }

  /**
   * Ask the platform for its own estimate. Returns a promise, or null where the API is absent —
   * which is every `file://` context, so nothing may depend on the answer.
   */
  function platformEstimate() {
    try {
      var nav = globalThis.navigator;
      if (!nav || !nav.storage || typeof nav.storage.estimate !== 'function') return null;
      return nav.storage.estimate();
    } catch (err) {
      return null;
    }
  }

  /** Would this model's history fit? A pre-flight answer for import, which writes nothing itself. */
  function preflight(adapter, bytes, options) {
    var g = gauge(adapter, options);
    var projected = g.bytes + Math.max(0, bytes | 0);
    return {
      gauge: g,
      projected: projected,
      level: levelFor(projected, g.budget),
      crossesWarning: levelFor(projected, g.budget) === 'warning' || levelFor(projected, g.budget) === 'exhausted',
      available: Math.max(0, g.budget - g.bytes),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Where are we? (§4)
  // ---------------------------------------------------------------------------------------------

  /**
   * The environment facts the context decision needs, read from the platform. Separated from the
   * decision so the decision is a pure function and can be tested for every browser without running
   * any of them.
   */
  function environment() {
    var nav = globalThis.navigator || {};
    var ua = core.isString(nav.userAgent) ? nav.userAgent : '';
    var location = globalThis.location || {};
    return {
      protocol: core.isString(location.protocol) ? location.protocol : '',
      isFirefox: /firefox/i.test(ua),
      isSafari: /safari/i.test(ua) && !/chrome|chromium|android/i.test(ua),
      userAgent: ua,
    };
  }

  var FILE_ORIGIN = 'FILE_ORIGIN';
  var FILE_ORIGIN_PARTITIONED = 'FILE_ORIGIN_PARTITIONED';
  var WEB_ORIGIN = 'WEB_ORIGIN';
  var UNAVAILABLE = 'UNAVAILABLE';

  /**
   * Classify the storage context (`05-storage.md` §4).
   *
   * `FILE_ORIGIN_PARTITIONED` is a *heuristic* — an empty registry on a first run looks exactly like
   * one on a partitioned Firefox — so the result carries `certain: false` and the UI must present it
   * as a likely explanation with the file-based path alongside. Getting it wrong either way costs
   * nothing; stating it as a fact costs trust.
   */
  function detectStorageContext(input) {
    var i = input || {};
    if (i.available === false) {
      return { context: UNAVAILABLE, certain: true, message: storageContextMessage(UNAVAILABLE, i) };
    }
    if (i.protocol === 'file:') {
      var partitioned = i.isFirefox === true && i.registryEmpty === true && i.fileHasHistory !== false;
      return {
        context: partitioned ? FILE_ORIGIN_PARTITIONED : FILE_ORIGIN,
        certain: !partitioned,
        message: storageContextMessage(partitioned ? FILE_ORIGIN_PARTITIONED : FILE_ORIGIN, i),
      };
    }
    return { context: WEB_ORIGIN, certain: true, message: storageContextMessage(WEB_ORIGIN, i) };
  }

  /** Plain language, naming the browser behaviour rather than the condition (REQ-SYNC-008 AC1). */
  function storageContextMessage(context, i) {
    var partitioned = context === FILE_ORIGIN_PARTITIONED;
    switch (context) {
      case UNAVAILABLE:
        return (
          'This browser is not allowing the page to use local storage, so nothing can be remembered ' +
          'between visits. The file remains the model; the file-based path below works without storage.'
        );
      case FILE_ORIGIN:
        return (
          'This file is open from disk. Browsers treat local files as their own storage area, so what ' +
          'is remembered here may not be visible when the same file is opened another way — and a ' +
          'moved or renamed file may not find its history again.'
        );
      case FILE_ORIGIN_PARTITIONED:
        return (
          'No history was found for this file, and this browser keeps a separate storage area for each ' +
          'local file path — Firefox does this — so a file that was moved, renamed or copied will not ' +
          'find what an earlier copy remembered. ' +
          (i.fileHasHistory === false
            ? 'This file carries no history of its own, so there may be nothing to find.'
            : 'The history in the file is used below, and exporting a new copy is the reliable way to ' +
              'carry work between paths.')
        );
      default:
        return 'This model is stored by this browser for the site it was opened from.';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reconcile (§`04-versioning.md` §6, REQ-SYNC-001..008)
  // ---------------------------------------------------------------------------------------------

  var NO_LOCAL = 'no-local';
  var IDENTICAL = 'identical';
  var EMBEDDED_AHEAD = 'embedded-ahead';
  var LOCAL_AHEAD = 'local-ahead';
  var DIVERGED = 'diverged';
  var UNRELATED = 'unrelated';

  /**
   * Compare the file's history with the store's for the same model id, and return a verdict.
   *
   * Ancestry decides, never a timestamp — the same rule as everywhere else (ADR-0003). The two
   * histories are walked as one union so that a commit present in both is recognised as shared
   * rather than as two commits that happen to have the same id (they cannot: the id *is* the hash).
   *
   * The verdict is a value, not an action. Boot is what writes; this decides what to write, which is
   * what makes REQ-SYNC-005's "reaches the compare view without writing to storage" a property of the
   * code rather than a promise about it.
   */
  function countNewCommits(localHistory, localHead, fileHistory, fileHead) {
    var known = core.isString(localHead) ? vcs.reachableFrom(localHistory, localHead) : Object.create(null);
    var incoming = core.isString(fileHead) ? Object.keys(vcs.reachableFrom(fileHistory, fileHead)) : [];
    var added = 0;
    for (var i = 0; i < incoming.length; i++) if (!known[incoming[i]]) added += 1;
    return added;
  }

  function reconcile(embedded, local) {
    var fileHistory = embedded && embedded.history ? embedded.history : null;
    if (!fileHistory || !core.isArray(fileHistory.commits)) {
      return { verdict: UNRELATED, certain: true, message: 'This file carries no history to compare.' };
    }
    var fileHead = core.isString(fileHistory.head) ? fileHistory.head : null;

    if (!local || !local.ok || !core.isArray(local.history && local.history.commits) || local.history.commits.length === 0) {
      return {
        verdict: NO_LOCAL,
        certain: true,
        adopt: true,
        head: fileHead,
        message:
          'Nothing is stored for this model in this browser, so the history in the file is being used ' +
          'and recorded locally. This is expected when storage was cleared, or when the file has not ' +
          'been opened here before.',
      };
    }

    var localHistory = local.history;
    var localHead = core.isString(localHistory.head) ? localHistory.head : null;

    var union = {
      keyframeInterval: fileHistory.keyframeInterval,
      head: null,
      commits: fileHistory.commits.concat(localHistory.commits),
    };

    if (!vcs.sharesHistory(fileHistory, localHistory)) {
      // No common commit at all: two different models that happen to share an id, or a history
      // rewritten past the point of recognition. They are registered side by side and never merged
      // (REQ-SYNC-006) — merging unrelated lineages produces a model that never existed.
      return {
        verdict: UNRELATED,
        certain: true,
        adopt: false,
        head: fileHead,
        message:
          'The history in this file and the history stored for this model id have nothing in common. ' +
          'They are being kept side by side as separate models rather than combined.',
      };
    }

    if (fileHead === localHead) return { verdict: IDENTICAL, certain: true, adopt: false, head: localHead };

    if (vcs.isAncestor(union, localHead, fileHead)) {
      return {
        verdict: EMBEDDED_AHEAD,
        certain: true,
        adopt: true,
        head: fileHead,
        // What a notification should say: the commits this open *adds*, not the size of the history
        // it arrives with. Those are different numbers whenever the store was merely behind.
        adopted: countNewCommits(localHistory, localHead, fileHistory, fileHead),
        message:
          'The file is ahead of what this browser had stored, so its history has been adopted and ' +
          'recorded locally.',
      };
    }
    if (vcs.isAncestor(union, fileHead, localHead)) {
      return {
        verdict: LOCAL_AHEAD,
        certain: true,
        adopt: false,
        head: localHead,
        message:
          'The copy stored by this browser is ahead of the file. The stored history is being shown, ' +
          'and exporting a refreshed file is offered — the file on disk is out of date, not lost.',
      };
    }
    return {
      verdict: DIVERGED,
      certain: true,
      adopt: false,
      head: localHead,
      message:
        'The file and this browser have both moved on from a common point, in different directions. ' +
        'Nothing has been written: the two histories are shown side by side so the difference can be ' +
        'resolved deliberately.',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Storage format migration (§8)
  // ---------------------------------------------------------------------------------------------

  /**
   * Migrations from older storage layouts, keyed by the version they upgrade *from*.
   *
   * Empty, and honestly so: `1` is the only storage layout this build knows. The table is the seam a
   * future version adds a function to, and the fault-injection test
   * (`store.migration-verify-before-remove`) drives it by registering one — which is the only way to
   * test an ordering that must hold when something goes wrong halfway.
   *
   * A migration receives `(adapter, modelIds, fromVersion)` and must **write the new layout only**;
   * `runMigrations` removes the old keys after verifying the new ones, never before.
   */
  var MIGRATIONS = Object.create(null);

  /**
   * Bring storage forward. Never deletes anything it has not first written and verified.
   *
   *   older version   build the new layout, verify it, then remove the old keys
   *   newer version   ignore it, and delete nothing — a newer application's data is not ours to
   *                   destroy
   *   unrecognised    skip, count, report
   *
   * The order is the whole point (REQ-STORE-006 AC3, §8): a crash during migration leaves both
   * layouts, which the next run completes; the reverse order leaves neither.
   */
  function runMigrations(adapter, options) {
    var opts = options || {};
    var current = TMV.STORAGE_VERSION;
    var all = adapter.keys('tmv:');
    var byVersion = Object.create(null);
    var unrecognised = [];
    for (var i = 0; i < all.length; i++) {
      var parsed = parseKey(all[i]);
      if (!parsed) {
        unrecognised.push(all[i]);
        continue;
      }
      if (parsed.kind === 'unknown') {
        unrecognised.push(all[i]);
        continue;
      }
      if (!byVersion[parsed.version]) byVersion[parsed.version] = [];
      byVersion[parsed.version].push(all[i]);
    }

    var report = { current: current, migrated: [], ignoredNewer: [], unrecognised: unrecognised, removed: [] };
    var versions = Object.keys(byVersion);
    versions.sort(function (a, b) {
      return parseInt(a, 10) - parseInt(b, 10);
    });

    for (var v = 0; v < versions.length; v++) {
      var version = parseInt(versions[v], 10);
      if (version === current) continue;
      if (version > current) {
        report.ignoredNewer.push({ version: version, keys: byVersion[versions[v]].length });
        continue;
      }
      var migrate = MIGRATIONS[version];
      if (typeof migrate !== 'function') {
        report.unrecognised = report.unrecognised.concat(byVersion[versions[v]]);
        continue;
      }
      var modelIds = Object.create(null);
      for (var k = 0; k < byVersion[versions[v]].length; k++) {
        var p = parseKey(byVersion[versions[v]][k]);
        if (p && p.modelId) modelIds[p.modelId] = true;
      }
      var outcome = migrate(adapter, Object.keys(modelIds), version);
      // Verify before removing: every model the migration claims to have written must load.
      var verified = true;
      var ids = Object.keys(modelIds);
      for (var m = 0; m < ids.length; m++) {
        if (!readMeta(adapter, ids[m])) verified = false;
      }
      if (!verified && opts.trustMigration !== true) {
        report.failed = { version: version, reason: 'the migrated layout did not verify; nothing was removed' };
        continue;
      }
      for (var r = 0; r < byVersion[versions[v]].length; r++) {
        adapter.remove(byVersion[versions[v]][r]);
        report.removed.push(byVersion[versions[v]][r]);
      }
      report.migrated.push({ version: version, keys: byVersion[versions[v]].length, outcome: outcome || null });
    }
    return report;
  }

  // ---------------------------------------------------------------------------------------------

  TMV.storage = {
    PREFIX: PREFIX,
    REGISTRY_KEY: REGISTRY_KEY,
    PREFS_KEY: PREFS_KEY,

    FILE_ORIGIN: FILE_ORIGIN,
    FILE_ORIGIN_PARTITIONED: FILE_ORIGIN_PARTITIONED,
    WEB_ORIGIN: WEB_ORIGIN,
    UNAVAILABLE: UNAVAILABLE,

    NO_LOCAL: NO_LOCAL,
    IDENTICAL: IDENTICAL,
    EMBEDDED_AHEAD: EMBEDDED_AHEAD,
    LOCAL_AHEAD: LOCAL_AHEAD,
    DIVERGED: DIVERGED,
    UNRELATED: UNRELATED,

    MIGRATIONS: MIGRATIONS,

    isModelId: isModelId,
    keysFor: keysFor,
    modelPrefix: modelPrefix,
    parseKey: parseKey,

    localBackend: localBackend,
    memoryBackend: memoryBackend,
    makeAdapter: makeAdapter,
    createAdapter: createAdapter,

    readJson: readJson,
    writeJson: writeJson,

    defaultPrefs: defaultPrefs,
    readPrefs: readPrefs,
    writePrefs: writePrefs,

    normalizeEntry: normalizeEntry,
    readRegistry: readRegistry,
    writeRegistry: writeRegistry,
    upsertRegistry: upsertRegistry,
    listModels: listModels,
    storedModelIds: storedModelIds,
    embeddedEntry: embeddedEntry,
    seedRegistry: seedRegistry,

    readMeta: readMeta,
    storedBytes: storedBytes,
    saveModel: saveModel,
    loadModel: loadModel,
    deleteModel: deleteModel,
    projectWrite: projectWrite,

    collect: collect,

    levelFor: levelFor,
    gauge: gauge,
    preflight: preflight,
    platformEstimate: platformEstimate,

    environment: environment,
    detectStorageContext: detectStorageContext,

    reconcile: reconcile,

    runMigrations: runMigrations,
  };

  /* tmv:test-hook-begin */
  // The only handle on the fault-injection counter, and inside the stripped region with it. Tests
  // reach it through `TMV.storage.__test`; nothing in `dist/` has either the handle or the counter.
  TMV.storage.__test = {
    failWritesAt: function (n) {
      testFailWritesAt = core.isNumber(n) ? n : 0;
      testHookWrites = 0;
      return testFailWritesAt;
    },
    writesSeen: function () {
      return testHookWrites;
    },
  };
  /* tmv:test-hook-end */
})(globalThis.TMV = globalThis.TMV || {});
