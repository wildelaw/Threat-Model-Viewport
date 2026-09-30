/* 03-hash.js — pure-JavaScript, synchronous SHA-256 (ADR-0011).
 *
 * Why not `crypto.subtle`:
 *   - availability — it needs a secure context, and this app must run on any origin a user happens
 *     to open it from, `file://` included;
 *   - asynchrony — commit ids are computed inside synchronous logic (ancestry walks, patch
 *     application, verification). An async digest would infect the whole merge algorithm;
 *   - determinism — a pure implementation is a specification, a platform implementation is a
 *     promise. Two machines must compute the same commit id or every reconcile is spurious
 *     divergence (ADR-0003).
 *
 * Hand-written cryptography is a liability in general and is acceptable here only because SHA-256 is
 * used as a *digest*: the inputs are public model data, there is no key, and timing side channels
 * are not part of this threat model. The mitigation for a subtle implementation bug — which would
 * produce hashes that are self-consistent but wrong everywhere else — is that the NIST test vectors
 * run on every build (`test/unit/hash.test.mjs`).
 *
 * The build computes its own SHA-256 with `node:crypto`; that is correct there because the build is
 * trusted, runs in Node, and the browser independently enforces the digest through the CSP.
 */
(function (TMV) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  var INIT = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  /** SHA-256 over a byte array (or Uint8Array). Returns 32 bytes as an ordinary Array. */
  function digestBytes(input) {
    var len = input.length;
    var bitLenHi = Math.floor(len / 536870912); // len * 8 / 2^32
    var bitLenLo = (len << 3) >>> 0;

    // Pad: 0x80, zeros, then the 64-bit big-endian bit length.
    var withOne = len + 1;
    var zeros = (56 - (withOne % 64) + 64) % 64;
    var total = withOne + zeros + 8;
    var m = new Uint8Array(total);
    for (var i = 0; i < len; i++) m[i] = input[i] & 0xff;
    m[len] = 0x80;
    m[total - 8] = (bitLenHi >>> 24) & 0xff;
    m[total - 7] = (bitLenHi >>> 16) & 0xff;
    m[total - 6] = (bitLenHi >>> 8) & 0xff;
    m[total - 5] = bitLenHi & 0xff;
    m[total - 4] = (bitLenLo >>> 24) & 0xff;
    m[total - 3] = (bitLenLo >>> 16) & 0xff;
    m[total - 2] = (bitLenLo >>> 8) & 0xff;
    m[total - 1] = bitLenLo & 0xff;

    var h0 = INIT[0], h1 = INIT[1], h2 = INIT[2], h3 = INIT[3];
    var h4 = INIT[4], h5 = INIT[5], h6 = INIT[6], h7 = INIT[7];
    var w = new Uint32Array(64);

    for (var off = 0; off < total; off += 64) {
      for (var t = 0; t < 16; t++) {
        var p = off + t * 4;
        w[t] = ((m[p] << 24) | (m[p + 1] << 16) | (m[p + 2] << 8) | m[p + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var w15 = w[t - 15];
        var w2 = w[t - 2];
        var s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
        var s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }

      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (t = 0; t < 64; t++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e;
        e = (d + temp1) >>> 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    var out = [];
    var state = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (var s = 0; s < 8; s++) {
      out.push((state[s] >>> 24) & 0xff, (state[s] >>> 16) & 0xff, (state[s] >>> 8) & 0xff, state[s] & 0xff);
    }
    return out;
  }

  var HEX = '0123456789abcdef';

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += HEX[(bytes[i] >> 4) & 0xf] + HEX[bytes[i] & 0xf];
    }
    return s;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** Standard base64 with padding, computed here so neither `btoa` nor `Buffer` is required. */
  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
      s += B64[b0 >> 2];
      s += B64[((b0 & 3) << 4) | (b1 === null ? 0 : b1 >> 4)];
      s += b1 === null ? '=' : B64[((b1 & 15) << 2) | (b2 === null ? 0 : b2 >> 6)];
      s += b2 === null ? '=' : B64[b2 & 63];
    }
    return s;
  }

  /** Hex digest of a string (UTF-8 encoded). */
  function hex(input) {
    var bytes = typeof input === 'string' ? TMV.core.utf8Bytes(input) : input;
    return toHex(digestBytes(bytes));
  }

  /** Base64 digest of a string (UTF-8 encoded) — the form a CSP hash uses. */
  function base64(input) {
    var bytes = typeof input === 'string' ? TMV.core.utf8Bytes(input) : input;
    return toBase64(digestBytes(bytes));
  }

  /**
   * A content address: `sha256:<hex>`.
   * The prefix is retained for algorithm agility — a future algorithm gets a new prefix and old
   * commits keep theirs (`04-versioning.md` §10).
   */
  function contentAddress(input) {
    return 'sha256:' + hex(input);
  }

  /** True for a well-formed `sha256:<64 hex>` content address. */
  function isAddress(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
  }

  /** The algorithm prefix of an address, for verification dispatch. */
  function algorithmOf(value) {
    if (typeof value !== 'string') return null;
    var at = value.indexOf(':');
    return at === -1 ? null : value.slice(0, at);
  }

  TMV.hash = {
    digestBytes: digestBytes,
    hex: hex,
    base64: base64,
    contentAddress: contentAddress,
    isAddress: isAddress,
    algorithmOf: algorithmOf,
    toHex: toHex,
    toBase64: toBase64,
  };
})(globalThis.TMV = globalThis.TMV || {});
