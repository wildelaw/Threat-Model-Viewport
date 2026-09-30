/*
 * compare.mjs — comparing values that came out of the application's own realm.
 *
 * Everything a test imports through `loadApp()` was created inside a `node:vm` context, so its
 * arrays and objects have *that* realm's `Array.prototype` and `Object.prototype`. `node:assert`'s
 * strict comparisons check prototypes, so `assert.deepStrictEqual(appArray, ['history', 'model'])`
 * fails with "Values have same structure but are not reference-equal" — a message that describes the
 * realm boundary and reads like a real defect.
 *
 * The fix is to normalise both sides through JSON before comparing. That is also exactly what the
 * assertions here are about: the model is a JSON document, and two models that serialize the same
 * are the same model. A value that cannot survive a JSON round trip is not one this application can
 * store, so the normalisation is not hiding a case that matters.
 *
 * (Deliberately *not* using `TMV.core.deepEqual` for this: the assertion would then be made by the
 * code under test.)
 */

import assert from 'node:assert/strict';

export function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Deep equality over the JSON form. */
export function same(actual, expected, message) {
  assert.deepEqual(plain(actual), plain(expected), message);
}

/** The same, inverted, for the cases where a difference *is* the assertion. */
export function notSame(actual, expected, message) {
  assert.notDeepEqual(plain(actual), plain(expected), message);
}

/** Membership for cross-realm arrays of primitives. */
export function includes(list, value, message) {
  assert.ok(plain(list).indexOf(value) !== -1, message || `expected ${JSON.stringify(plain(list))} to contain ${value}`);
}
