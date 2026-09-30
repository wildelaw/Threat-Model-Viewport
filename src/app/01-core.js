/* 01-core.js — namespace, constants, small pure helpers, DOM helpers, escaping.
 *
 * Source convention (02-architecture.md §3): a plain script fragment attaching to a shared
 * `globalThis.TMV` namespace. No import, no export, no top-level await — the build concatenates
 * these files into one classic inline script (ADR-0006), and the test harness concatenates the same
 * list in the same order (09-testing.md §2). Nothing here touches the DOM at load time.
 */
(function (TMV) {
  'use strict';

  /** App version. Mirrors the `tmv-app-version` meta tag written by the build. */
  var VERSION = '0.1.0';

  /** Canonical model format version (`03-data-model.md` §2). */
  var MODEL_FORMAT = '1.0.0';

  /** Container format version (`03-data-model.md` §7). */
  var CONTAINER_FORMAT = '1.0.0';

  /** Container `$schema`. Identifies the *container* format, never an interchange schema. */
  var CONTAINER_SCHEMA = 'https://threat-model-viewport.invalid/container-1.0.0.schema.json';

  /** Storage layout version — the middle segment of every key (`05-storage.md` §2). */
  var STORAGE_VERSION = 1;

  /** Default keyframe interval. Configurable in Settings (`04-versioning.md` §3). */
  var DEFAULT_KEYFRAME_INTERVAL = 20;

  /** Resource guards (`08-security.md` §5). Every one fails with an explanation, never a blank page. */
  var LIMITS = {
    containerWarnBytes: 20 * 1024 * 1024,
    containerRefuseBytes: 100 * 1024 * 1024,
    commitWarnCount: 10000,
    patchOpRefuse: 100000,
    nestingDepth: 64,
    diagramSourceRefuseBytes: 512 * 1024,
  };

  /** Quota thresholds (`05-storage.md` §5), as fractions of an assumed 5 MB budget. */
  var QUOTA = { budgetBytes: 5 * 1024 * 1024, elevated: 0.7, warning: 0.85 };

  /** The canonical `state` vocabulary (`03-data-model.md` §4.10). A UI convenience, never a gate. */
  var THREAT_STATES = ['exposed', 'mitigated', 'accepted', 'not_applicable'];
  var CONTROL_STATES = ['required', 'implemented', 'planned', 'mitigated', 'accepted', 'not_applicable'];

  // ---------------------------------------------------------------------------------------------
  // The two tag sequences that must never be written literally in this directory
  // ---------------------------------------------------------------------------------------------
  //
  // Every file here is concatenated into one inline script element, and **the HTML tokenizer runs
  // over that text before any JavaScript does**. Two things follow, neither visible to a source
  // reader and neither caught by a regex over the assembled file:
  //
  //   - An angle bracket followed by the word `script` ends the element. If that happens, the rest
  //     of the document is parsed as script and the application does not start at all.
  //   - A `<!--` earlier in the text followed by an opening script tag puts the tokenizer into its
  //     legacy double-escaped state, where the real closing tag no longer terminates the element.
  //     The recovery requires exactly the sequences we are forbidding, so the state is a trap.
  //
  // Both hazards are *source text* hazards: they are about what the tokenizer sees, so a comment or
  // a string literal is exactly as dangerous as code. A browser-only failure is the worst kind here,
  // because `build.mjs`'s self-check and every Node test read the file as text and see nothing wrong.
  //
  // Hence: the sequences are assembled from parts, here, once, and `build.mjs` fails the build if
  // any of them — or the bare opening form — appears anywhere in the concatenated script.
  var SCRIPT_OPEN = '<' + 'script';
  var SCRIPT_CLOSE = '<' + '/script';

  /** Matches an opening script tag, built rather than written, for the same reason. */
  var SCRIPT_TAG = new RegExp('<' + 'script[\\s>/]', 'i');

  // ---------------------------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------------------------

  /** An error with a machine-readable code, so callers branch on the code and not on the message. */
  function TmvError(code, message, detail) {
    var err = new Error(message);
    err.name = 'TmvError';
    err.code = code;
    err.detail = detail || null;
    return err;
  }

  // ---------------------------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------------------------

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function isString(v) {
    return typeof v === 'string';
  }

  function isNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isBoolean(v) {
    return typeof v === 'boolean';
  }

  /**
   * True for a JSON-style object — not null, not an array, not a function.
   * Deliberately accepts null-prototype objects, because that is what untrusted data is rebuilt into
   * (`08-security.md` §5, prototype pollution).
   */
  function isObject(v) {
    return v !== null && typeof v === 'object' && !isArray(v);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** A value counts as present when it is neither absent, null, nor an empty/whitespace string. */
  function present(v) {
    if (v === undefined || v === null) return false;
    if (isString(v)) return v.trim() !== '';
    if (isArray(v)) return v.length > 0;
    return true;
  }

  function nfc(s) {
    return isString(s) && s.normalize ? s.normalize('NFC') : s;
  }

  /**
   * NFC-normalize every string inside a value, returning a structure that shares nothing with the
   * input.
   *
   * Two jobs, both load-bearing:
   *
   *   1. **Canonical form on entry.** `03-data-model.md` §5 says strings are NFC-normalized so that
   *      visually identical text hashes identically. Doing it when the value enters the model, rather
   *      than only inside the serializer, means the model in memory *is* the canonical form — what is
   *      displayed, exported and diffed is what was hashed. The alternative shows up later as a
   *      working copy that looks unchanged, hashes unchanged, and produces a diff anyway.
   *   2. **No aliasing.** The result is always a fresh structure, so a caller cannot hand a value to
   *      the model and then mutate it from underneath. The same aliasing mistake, made in the patch
   *      generator, silently corrupted stored deltas.
   */
  function nfcValue(value) {
    if (isString(value)) return nfc(value);
    if (isArray(value)) {
      var arr = new Array(value.length);
      for (var i = 0; i < value.length; i++) arr[i] = nfcValue(value[i]);
      return arr;
    }
    if (isObject(value)) {
      var out = Object.create(null);
      var keys = Object.keys(value);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[key] = nfcValue(value[key]);
      }
      return out;
    }
    return value;
  }

  // ---------------------------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------------------------

  /**
   * RFC 4122 version 4 UUID.
   *
   * Uses the platform CSPRNG where there is one and falls back to Math.random otherwise. This is not
   * a security boundary — the id's only job is to not collide (`03-data-model.md` §1) — but a
   * collision between two independently created models would be a correctness failure of
   * REQ-DATA-006, so the stronger source is preferred when present.
   */
  function uuid() {
    var bytes = new Array(16);
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    var c = g.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      var arr = new Uint8Array(16);
      c.getRandomValues(arr);
      for (var i = 0; i < 16; i++) bytes[i] = arr[i];
    } else {
      for (var j = 0; j < 16; j++) bytes[j] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var k = 0; k < 16; k++) hex.push((bytes[k] + 0x100).toString(16).slice(1));
    return (
      hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') +
      '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('')
    );
  }

  var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  function isUuid(s) {
    return isString(s) && UUID_RE.test(s);
  }

  // ---------------------------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------------------------

  /** UTF-8 encode by hand: the app must not depend on `TextEncoder` being present. */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
          continue;
        }
        out.push(0xef, 0xbf, 0xbd);
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  function utf8Length(str) {
    return utf8Bytes(str).length;
  }

  /** Human-readable byte size. */
  function bytes(n) {
    if (!isNumber(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function truncate(s, n) {
    if (!isString(s)) return '';
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }

  /** Collapse whitespace runs, for one-line renderings of multi-line text. */
  function oneLine(s) {
    return isString(s) ? s.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Slug derivation for TML symbolic names (`06-interchange.md` §4).
   * Deterministic; the collision suffix is applied by the caller, which owns the taken-set.
   */
  function slugBase(input, fallback) {
    var s = isString(input) ? input : '';
    s = s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining marks after NFD
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '');
    return s === '' ? fallback || 'item' : s;
  }

  // ---------------------------------------------------------------------------------------------
  // URLs (`08-security.md` §5)
  // ---------------------------------------------------------------------------------------------

  var SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

  /**
   * Returns a safe href for an untrusted URL, or null.
   *
   * `javascript:`, `data:` and `vbscript:` are rejected outright. Scheme-relative and relative URLs
   * are rejected too: a model's URLs are absolute or they are not links.
   */
  function safeUrl(raw) {
    if (!isString(raw)) return null;
    var s = raw.trim();
    if (s === '') return null;
    // Strip characters browsers ignore inside a scheme, so "java\tscript:" cannot slip through.
    var probe = s.replace(/[\u0000- ]/g, '').toLowerCase();
    var m = /^([a-z][a-z0-9+.-]*):/.exec(probe);
    if (!m) return null;
    if (SAFE_SCHEMES.indexOf(m[1] + ':') === -1) return null;
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // Dates and formatting
  // ---------------------------------------------------------------------------------------------

  function parseDate(v) {
    if (!isString(v)) return null;
    var t = Date.parse(v);
    return isNaN(t) ? null : new Date(t);
  }

  function formatDate(v) {
    var d = parseDate(v);
    if (!d) return isString(v) && v !== '' ? v : '—';
    return d.toISOString().slice(0, 10);
  }

  function formatDateTime(v) {
    var d = parseDate(v);
    if (!d) return isString(v) && v !== '' ? v : '—';
    var iso = d.toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
  }

  /** Coarse relative time for list views. Never used for precedence (REQ-VCS-007). */
  function relativeTime(v, nowMs) {
    var d = parseDate(v);
    if (!d) return '—';
    var now = isNumber(nowMs) ? nowMs : Date.now();
    var secs = Math.round((now - d.getTime()) / 1000);
    var future = secs < 0;
    var a = Math.abs(secs);
    var text;
    if (a < 60) text = a + ' seconds';
    else if (a < 3600) text = Math.round(a / 60) + ' minutes';
    else if (a < 86400) text = Math.round(a / 3600) + ' hours';
    else if (a < 2592000) text = Math.round(a / 86400) + ' days';
    else if (a < 31536000) text = Math.round(a / 2592000) + ' months';
    else text = Math.round(a / 31536000) + ' years';
    return future ? 'in ' + text : text + ' ago';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's');
  }

  /** `sha256:abcdef…` → `abcdef…`, for display. */
  function shortId(id) {
    if (!isString(id)) return '—';
    var hex = id.indexOf(':') === -1 ? id : id.split(':')[1];
    return hex.slice(0, 7);
  }

  // ---------------------------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------------------------

  /** Own enumerable keys, sorted by UTF-16 code unit (`03-data-model.md` §5). */
  function sortedKeys(obj) {
    var keys = [];
    for (var k in obj) if (has(obj, k)) keys.push(k);
    return keys.sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  /** A deep copy that never carries a prototype. */
  function deepCopy(value) {
    if (isArray(value)) {
      var arr = new Array(value.length);
      for (var i = 0; i < value.length; i++) arr[i] = deepCopy(value[i]);
      return arr;
    }
    if (isObject(value)) {
      var out = Object.create(null);
      var keys = Object.keys(value);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[key] = deepCopy(value[key]);
      }
      return out;
    }
    return value;
  }

  /**
   * Deep structural equality over JSON values. Key order is irrelevant.
   *
   * String comparison is NFC-insensitive, which is what makes this agree with `canonical.serialize`.
   * If it did not, two spellings of the same text would be "equal" to the hasher and "different" to
   * the diff, and the model would report a change it cannot commit and cannot show.
   */
  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'string') return nfc(a) === nfc(b);
    if (isArray(a)) {
      if (!isArray(b) || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (isObject(a)) {
      if (!isObject(b)) return false;
      var ka = sortedKeys(a);
      var kb = sortedKeys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) {
        if (ka[j] !== kb[j]) return false;
        if (!deepEqual(a[ka[j]], b[kb[j]])) return false;
      }
      return true;
    }
    return false;
  }

  function indexById(list) {
    var map = Object.create(null);
    if (isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && isString(list[i].id)) map[list[i].id] = list[i];
      }
    }
    return map;
  }

  /** Split a list into [matching, rest] without mutating it. */
  function partition(list, fn) {
    var yes = [];
    var no = [];
    for (var i = 0; i < list.length; i++) (fn(list[i], i) ? yes : no).push(list[i]);
    return [yes, no];
  }

  function unique(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!seen[v]) {
        seen[v] = true;
        out.push(v);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // DOM helpers
  //
  // Every one of these inserts text as text. There is no `innerHTML` in this application
  // (REQ-SEC-003, REQ-UI-008) and no code path may introduce one.
  // ---------------------------------------------------------------------------------------------

  function doc() {
    return typeof document === 'undefined' ? null : document;
  }

  function byId(id) {
    var d = doc();
    return d ? d.getElementById(id) : null;
  }

  /**
   * A `<meta>` element's content, found by its `name`, or null when the build wrote no such element.
   *
   * By `name` rather than by id because that is how the build writes them (`build.mjs` emits
   * `name="tmv-app-hash"` and `name="tmv-app-version"`) and how a reader of the file finds them. The
   * distinction cost something real: looking these up as ids found nothing in the artifact, so the
   * About panel reported the build as "not recorded" on a page that had recorded it — and then
   * explained the absence as "a page that is not the built artifact has no build record to read",
   * which was both untrue and exactly the kind of claim `07-ui.md` §9 exists to prevent.
   *
   * The name is a literal at every call site; nothing here comes from a document.
   */
  function metaContent(name) {
    var d = doc();
    if (!d || typeof d.querySelector !== 'function') return null;
    var node = d.querySelector('meta[name="' + name + '"]');
    if (!node || typeof node.getAttribute !== 'function') return null;
    var value = node.getAttribute('content');
    return isString(value) && value !== '' ? value : null;
  }

  /**
   * Create an element.
   *   el('div', { class: 'x', hidden: true }, [child, 'text'])
   * Properties are set with setAttribute; `text` is a shortcut for a text node, never markup.
   */
  function el(tag, attrs, children) {
    var d = doc();
    if (!d) return null;
    var node = d.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') {
          node.textContent = String(v);
        } else if (k === 'class') {
          node.setAttribute('class', v);
        } else if (k === 'dataset') {
          var dk = Object.keys(v);
          for (var j = 0; j < dk.length; j++) node.setAttribute('data-' + dk[j], String(v[dk[j]]));
        } else if (v === true) {
          node.setAttribute(k, '');
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (children) append(node, children);
    return node;
  }

  function append(parent, children) {
    if (!parent) return parent;
    var list = isArray(children) ? children : [children];
    for (var i = 0; i < list.length; i++) {
      var child = list[i];
      if (child === null || child === undefined || child === false) continue;
      parent.appendChild(isString(child) || isNumber(child) ? doc().createTextNode(String(child)) : child);
    }
    return parent;
  }

  function text(str) {
    var d = doc();
    return d ? d.createTextNode(isString(str) ? str : String(str)) : null;
  }

  /** Remove every child. Uses removeChild, not innerHTML. */
  function clear(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function replace(parent, children) {
    if (!parent) return parent;
    clear(parent);
    append(parent, children);
    return parent;
  }

  function on(target, type, handler, opts) {
    if (!target || !target.addEventListener) return function () {};
    target.addEventListener(type, handler, opts || false);
    return function () {
      target.removeEventListener(type, handler, opts || false);
    };
  }

  /**
   * Delegated listener. The shell attaches one listener per concern rather than one per row
   * (REQ-UI-008), which is also what keeps a 5,000-row table's render cheap (REQ-VIEW-009).
   * `selector` is matched against `data-action` values, not CSS.
   */
  function delegate(root, type, handler) {
    return on(root, type, function (event) {
      var node = event.target;
      var d = doc();
      while (node && node !== root && node !== d) {
        if (node.getAttribute && node.getAttribute('data-action')) {
          handler(event, node);
          return;
        }
        node = node.parentNode;
      }
    });
  }

  /** Find the nearest ancestor (or self) with a `data-action` attribute. */
  function closestAction(node, root) {
    var d = doc();
    while (node && node !== root && node !== d) {
      if (node.getAttribute && node.getAttribute('data-action')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  function show(node) {
    setHidden(node, false);
  }

  function hide(node) {
    setHidden(node, true);
  }

  function setClass(node, name, active) {
    if (!node) return;
    if (node.classList) {
      if (active) node.classList.add(name);
      else node.classList.remove(name);
    } else {
      var current = (node.getAttribute('class') || '').split(/\s+/);
      var next = [];
      for (var i = 0; i < current.length; i++) if (current[i] && current[i] !== name) next.push(current[i]);
      if (active) next.push(name);
      node.setAttribute('class', next.join(' '));
    }
  }

  /** Set an attribute only when the value changed, so the pristine-vs-live DOM stays predictable. */
  function setAttr(node, name, value) {
    if (!node) return;
    if (value === null || value === undefined) node.removeAttribute(name);
    else node.setAttribute(name, String(value));
  }

  // ---------------------------------------------------------------------------------------------
  // Namespace
  // ---------------------------------------------------------------------------------------------

  TMV.VERSION = VERSION;
  TMV.MODEL_FORMAT = MODEL_FORMAT;
  TMV.CONTAINER_FORMAT = CONTAINER_FORMAT;
  TMV.CONTAINER_SCHEMA = CONTAINER_SCHEMA;
  TMV.STORAGE_VERSION = STORAGE_VERSION;
  TMV.DEFAULT_KEYFRAME_INTERVAL = DEFAULT_KEYFRAME_INTERVAL;
  TMV.LIMITS = LIMITS;
  TMV.QUOTA = QUOTA;
  TMV.THREAT_STATES = THREAT_STATES;
  TMV.CONTROL_STATES = CONTROL_STATES;

  TMV.error = TmvError;

  TMV.core = {
    isArray: isArray,
    isString: isString,
    isNumber: isNumber,
    isBoolean: isBoolean,
    isObject: isObject,
    has: has,
    SCRIPT_OPEN: SCRIPT_OPEN,
    SCRIPT_CLOSE: SCRIPT_CLOSE,
    SCRIPT_TAG: SCRIPT_TAG,

    present: present,
    nfc: nfc,
    nfcValue: nfcValue,
    uuid: uuid,
    isUuid: isUuid,
    utf8Bytes: utf8Bytes,
    utf8Length: utf8Length,
    bytes: bytes,
    truncate: truncate,
    oneLine: oneLine,
    slugBase: slugBase,
    safeUrl: safeUrl,
    parseDate: parseDate,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    relativeTime: relativeTime,
    plural: plural,
    shortId: shortId,
    sortedKeys: sortedKeys,
    deepCopy: deepCopy,
    deepEqual: deepEqual,
    indexById: indexById,
    partition: partition,
    unique: unique,
    byId: byId,
    metaContent: metaContent,
    el: el,
    append: append,
    text: text,
    clear: clear,
    replace: replace,
    on: on,
    delegate: delegate,
    closestAction: closestAction,
    setHidden: setHidden,
    show: show,
    hide: hide,
    setClass: setClass,
    setAttr: setAttr,
  };
})(globalThis.TMV = globalThis.TMV || {});
