/*
 * hash.test.mjs — the pure-JS SHA-256 against the published vectors (ADR-0011).
 *
 * This is the only test in the suite that checks an implementation against something outside this
 * repository, and it is the reason the hand-written digest is acceptable at all. The failure it
 * guards against is the worst kind available here: a SHA-256 that is self-consistent — every commit
 * id agrees with every other commit id produced by the same buggy build — and wrong on every other
 * machine. Two people sharing a file would see spurious divergence forever, and nothing about the
 * app would look broken.
 *
 * Vectors: FIPS 180-4 / NIST's `SHA256ShortMsg` and `SHA256LongMsg` examples, plus the standard
 * million-`a` case for the multi-block path. `node:crypto` is used as a *second opinion* on random
 * inputs, which is what actually covers the padding arithmetic at every length residue — the fixed
 * vectors all land on lengths that happen to be convenient.
 *
 * The container's escaping property (`data.escape-roundtrip`) lives in container.test.mjs, where the
 * subject is the escape-embed-extract-parse path rather than the digest underneath it.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { specTest } from '../lib/check.mjs';
import { loadApp } from '../lib/app.mjs';

const { TMV } = loadApp();
const hash = TMV.hash;

const nodeHex = (buf) => createHash('sha256').update(buf).digest('hex');

/** The published vectors. Each is `[input, expected hex]`; input is UTF-8 text. */
const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  // A character outside ASCII, so the digest is computed over encoded bytes rather than code units.
  ['ÿ', 'ea47fa96cf6d727d3068913da9193fef44aec4ee2c5972e9ac50cf7d637a56cf'],
  // Multi-byte, so the UTF-8 encoding is checked and not just the digest.
  ['é€😀', 'df9226927fd572c1ee66eec85de1bb139497614899f36e4e90474cb71f6ef9d0'],
];

specTest('vcs.commit-hash-deterministic', () => {
  // The name the spec cites is about commit ids being reproducible; the primitive underneath is
  // checked here too, because a commit id is exactly this function over a canonical payload.
  for (const [input, expected] of VECTORS) {
    assert.equal(hash.hex(input), expected, `hex of ${JSON.stringify(input.slice(0, 24))}`);
  }
  // Determinism in the sense the requirement means: same bytes, same digest, every time.
  assert.equal(hash.hex('abc'), hash.hex('abc'));
  assert.notEqual(hash.hex('abc'), hash.hex('abd'));

  // And against Node's own implementation at every padding residue. The 55/56/57/63/64 lengths are
  // where the length-field arithmetic is easiest to get wrong and where the fixed vectors sit
  // entirely on the convenient side.
  const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000];
  for (const n of lengths) {
    const bytes = randomBytes(n);
    assert.equal(hash.hex(bytes), nodeHex(bytes), `random ${n}-byte input`);
  }
  for (const n of lengths) {
    const text = 'x'.repeat(n);
    assert.equal(hash.hex(text), nodeHex(Buffer.from(text, 'utf8')), `text of length ${n}`);
  }
});

specTest('sec.csp-hash-pins-script', () => {
  // The CSP form of the same digest: base64, no padding stripped, which is what a `script-src`
  // hash has to be. Checked against Node's base64 so the hand-written encoder is covered.
  for (const n of [0, 1, 2, 3, 31, 32, 33, 64, 65]) {
    const bytes = randomBytes(n);
    const b64 = hash.base64(bytes);
    assert.equal(b64, createHash('sha256').update(bytes).digest('base64'), `${n}-byte input`);
    assert.match(b64, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(b64.length % 4, 0, 'base64 is padded to a multiple of four');
  }
  assert.equal(
    hash.base64(''),
    '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    'the digest of the empty string, which is the one every encoder gets wrong',
  );
});

specTest('vcs.tamper-detected', () => {
  // A content address is compared, never recomputed loosely: the prefix is part of it, and the
  // shape check is what stops a truncated or upper-cased hex string being accepted as an id.
  const good = hash.contentAddress('abc');
  assert.equal(good, `sha256:${VECTORS[1][1]}`);
  assert.ok(hash.isAddress(good));
  assert.equal(hash.algorithmOf(good), 'sha256');

  const tampered = [
    good.replace(/^sha256:/, 'sha512:'),
    good.toUpperCase(),
    `sha256:${VECTORS[1][1].slice(0, 63)}`,
    `sha256:${VECTORS[1][1]}0`,
    'sha256:',
    '',
    null,
    undefined,
  ];
  for (const value of tampered) {
    assert.equal(hash.isAddress(value), false, `rejected: ${JSON.stringify(value)}`);
  }
  assert.equal(hash.algorithmOf(null), null);
  assert.equal(hash.algorithmOf('nocolon'), null);
  assert.notEqual(hash.contentAddress('abc'), hash.contentAddress('abd'));
});
