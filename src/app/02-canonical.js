/* 02-canonical.js — canonical serialization (`03-data-model.md` §5, REQ-VCS-003).
 *
 * Hashing depends on this, so it is specified rather than left to `JSON.stringify`:
 *
 *   - object keys sorted by UTF-16 code unit — insertion order cannot affect a hash
 *   - no insignificant whitespace
 *   - arrays keep their order (order is meaningful)
 *   - `undefined` and functions omitted from objects; `null` preserved
 *   - numbers in shortest round-trippable form; NaN and Infinity rejected outright
 *   - strings NFC-normalized, so visually identical text hashes identically
 *   - empty arrays and objects preserved — `[]` is not the same as absent
 *
 * Two implementations must agree, the app's and the test harness's. The harness evaluates *this
 * file*, so they cannot drift; what the harness re-implements from scratch is SHA-256, and that is
 * checked against the NIST vectors instead (ADR-0011).
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var TmvError = TMV.error;

  function serializeString(s) {
    // NFC first: two strings that render identically must hash identically.
    return JSON.stringify(core.nfc(s));
  }

  function serializeNumber(n) {
    if (!isFinite(n)) {
      throw TmvError('CANONICAL_NUMBER', 'Canonical serialization rejects a non-finite number');
    }
    if (n === 0) return '0'; // collapses -0, which is a distinct value that stringifies oddly
    return String(n); // ECMAScript's Number→String is already shortest-round-trip
  }

  function serializeValue(value, out, depth) {
    if (depth > TMV.LIMITS.nestingDepth + 16) {
      throw TmvError('CANONICAL_DEPTH', 'Canonical serialization exceeded the nesting limit');
    }
    if (value === null) {
      out.push('null');
      return;
    }
    var t = typeof value;
    if (t === 'string') {
      out.push(serializeString(value));
      return;
    }
    if (t === 'number') {
      out.push(serializeNumber(value));
      return;
    }
    if (t === 'boolean') {
      out.push(value ? 'true' : 'false');
      return;
    }
    if (t === 'undefined' || t === 'function' || t === 'symbol') {
      // Omitted from objects by the caller; inside an array this becomes null so indices hold.
      out.push('null');
      return;
    }
    if (core.isArray(value)) {
      out.push('[');
      for (var i = 0; i < value.length; i++) {
        if (i > 0) out.push(',');
        var item = value[i];
        if (item === undefined || typeof item === 'function') out.push('null');
        else serializeValue(item, out, depth + 1);
      }
      out.push(']');
      return;
    }
    // Plain object. Own enumerable keys only, sorted, prototype-dropped values included.
    out.push('{');
    var keys = core.sortedKeys(value);
    var first = true;
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var v = value[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      if (!first) out.push(',');
      first = false;
      out.push(serializeString(key), ':');
      serializeValue(v, out, depth + 1);
    }
    out.push('}');
  }

  /** Canonical serialization of a JSON value. Throws on anything that cannot be hashed deterministically. */
  function serialize(value) {
    var out = [];
    serializeValue(value, out, 0);
    return out.join('');
  }

  /**
   * The normalized structure a canonical serialization represents: NFC strings, canonical numbers,
   * undefined removed. Returned as null-prototype objects throughout.
   *
   * Used where a *value* is needed rather than bytes — diffing two models field by field, or
   * comparing an imported document against a canonical one.
   */
  function normalize(value, depth) {
    var d = depth || 0;
    if (d > TMV.LIMITS.nestingDepth) {
      throw TmvError('CANONICAL_DEPTH', 'Model nesting exceeds the supported depth');
    }
    if (value === null || value === undefined) return null;
    var t = typeof value;
    if (t === 'string') return core.nfc(value);
    if (t === 'number') {
      if (!isFinite(value)) return null;
      return value === 0 ? 0 : value;
    }
    if (t === 'boolean') return value;
    if (core.isArray(value)) {
      var arr = new Array(value.length);
      for (var i = 0; i < value.length; i++) {
        var item = value[i];
        arr[i] = item === undefined ? null : normalize(item, d + 1);
      }
      return arr;
    }
    var out = Object.create(null);
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      var v = value[key];
      if (v === undefined || typeof v === 'function') continue;
      out[core.nfc(key)] = normalize(v, d + 1);
    }
    return out;
  }

  /**
   * A stable, human-readable key for an arbitrary value, for use as a map key or a React-style
   * render key. Not a hash — `TMV.hash.sha256` is used where a hash is needed.
   */
  function keyOf(value) {
    return serialize(value === undefined ? null : value);
  }

  /** Structural diff of two normalized values: the paths that differ, as JSON Pointers. */
  function diffPaths(a, b, path, out) {
    var acc = out || [];
    var at = path || '';
    if (core.deepEqual(a, b)) return acc;
    if (core.isArray(a) && core.isArray(b)) {
      var n = Math.max(a.length, b.length);
      for (var i = 0; i < n; i++) diffPaths(a[i], b[i], at + '/' + i, acc);
      return acc;
    }
    if (core.isObject(a) && core.isObject(b)) {
      var keys = core.unique(core.sortedKeys(a).concat(core.sortedKeys(b)));
      for (var j = 0; j < keys.length; j++) diffPaths(a[keys[j]], b[keys[j]], at + '/' + escapePointer(keys[j]), acc);
      return acc;
    }
    acc.push(at === '' ? '/' : at);
    return acc;
  }

  /** RFC 6901 pointer escaping. */
  function escapePointer(token) {
    return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function unescapePointer(token) {
    return String(token).replace(/~1/g, '/').replace(/~0/g, '~');
  }

  TMV.canonical = {
    serialize: serialize,
    normalize: normalize,
    keyOf: keyOf,
    diffPaths: diffPaths,
    escapePointer: escapePointer,
    unescapePointer: unescapePointer,
  };
})(globalThis.TMV = globalThis.TMV || {});
