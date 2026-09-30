#!/usr/bin/env node
/**
 * build.mjs — concatenate `src/` into the single distributable artifact.
 *
 * Dependency-free by requirement (REQ-SHELL-003, ADR-0009): nothing but the Node standard library.
 * A CI stage runs this first, from a clean checkout, with no install step — adding a dependency here
 * fails that stage, which is the machine-checkable form of the auditability claim.
 *
 * Steps (02-architecture.md §3):
 *   1. read + concatenate CSS
 *   2. read + concatenate JS in BUILD_ORDER
 *   3. minify nothing — the CSP hash is computed over the final bytes
 *   4. compute the script hash and the style hash
 *   5. substitute placeholders in src/index.html
 *   6. fail loudly on any unresolved placeholder
 *   7. re-read the assembled artifact and verify the hash it declares matches the script it carries
 *
 * One thing here is not in the spec's step list and is worth stating: the seed container is produced
 * by *evaluating the application's own modules* in a `node:vm` context and calling them, rather than
 * by a second implementation of canonical serialization and hashing living in the build. Two
 * implementations of the hash input would drift, and the drift would be silent — every commit id in
 * every file this build produced would simply disagree with every other build's. The test harness
 * (09-testing.md §2) loads the sources the same way, so the build, the tests and the browser all run
 * one implementation.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** The one place concatenation order is defined. The test harness imports this same list. */
export const BUILD_ORDER = [
  '01-core.js',
  '02-canonical.js',
  '03-hash.js',
  '04-container.js',
  '05-model.js',
  '06-vcs.js',
  '07-storage.js',
  '08-otm.js',
  '09-tml.js',
  '10-import.js',
  '11-export.js',
  '12-widgets.js',
  '13-notify.js',
  '14-diagrams.js',
  '15-forms.js',
  '16-compare.js',
  '17-shell.js',
  '18-views-shared.js',
  '18-views-overview.js',
  '18-views-architecture.js',
  '18-views-data.js',
  '18-views-flows.js',
  '18-views-threats.js',
  '18-views-controls.js',
  '18-views-risk.js',
  '18-views-history.js',
  '18-views-settings.js',
  '19-boot.js',
];

/** Files that must never run at build time — they touch the DOM at load. */
const BOOT_FILE = '19-boot.js';

const APP_VERSION = '0.1.0';
const OUT_DIR = join(ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'threat-model-viewport.html');

const read = (p) => readFileSync(p, 'utf8');
const sha256b64 = (buf) => createHash('sha256').update(buf).digest('base64');

/**
 * Evaluate the application sources in a vm context and hand back the `TMV` namespace.
 * `19-boot.js` is excluded: it is the only file with load-time side effects.
 */
function loadNamespace({ forTests = false } = {}) {
  const sandbox = {
    console,
    // Enough of a DOM that no module's *definition* needs one. Anything that actually renders is
    // called only from boot, which never runs here.
    document: undefined,
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  for (const file of BUILD_ORDER) {
    if (file === BOOT_FILE) continue;
    const src = read(join(ROOT, 'src', 'app', file));
    try {
      runInContext(src, context, { filename: `src/app/${file}` });
    } catch (err) {
      fail(`failed to evaluate src/app/${file}: ${err.message}`);
    }
  }
  if (!sandbox.TMV) fail('sources did not publish a TMV namespace');
  if (forTests) sandbox.TMV.__sandbox = sandbox;
  return sandbox.TMV;
}

function fail(message) {
  process.stderr.write(`\nbuild failed: ${message}\n\n`);
  process.exit(1);
}

/**
 * Remove the fault-injection seams (`09-testing.md` §5).
 *
 * The storage adapter must be able to fail a write on command, because two of its orderings —
 * blobs-before-pointer, and write-verify-then-remove in migration — are only observable when
 * something goes wrong halfway, and a test that cannot interrupt cannot check them. The seam must
 * not survive into the artifact, so it is marked and cut here, *before* the script hash is computed:
 * the hash covers what ships, and a hook that were stripped afterwards would leave the artifact's
 * declared hash describing bytes it does not contain.
 *
 * `test/store.no-test-hooks-in-release` asserts the sentinel is absent from `dist/`.
 */
const TEST_HOOK_BEGIN = '/* tmv:test-hook-begin */';
const TEST_HOOK_END = '/* tmv:test-hook-end */';

function stripTestHooks(source) {
  let out = source;
  for (;;) {
    const start = out.indexOf(TEST_HOOK_BEGIN);
    if (start === -1) return out;
    const end = out.indexOf(TEST_HOOK_END, start);
    if (end === -1) fail('a test-hook region is opened and never closed');
    out = out.slice(0, start) + out.slice(end + TEST_HOOK_END.length);
  }
}

/**
 * Refuse to build a script whose *own text* would confuse the HTML tokenizer.
 *
 * This is the one class of defect that every other check in this file is blind to. `src/app/*.js` is
 * concatenated verbatim into one inline script element, and the tokenizer runs over that text before
 * a single line of JavaScript does — so a tag sequence written in a **comment or a string literal**
 * is exactly as dangerous as one written in code.
 *
 * Step 7 below verifies the artifact by matching the script with a regex, and a regex over the file
 * cannot see the difference between a tag the tokenizer ends the element at and one it reads past. So
 * a file that breaks in a browser passes every test in Node, and the failure mode is that the rest of
 * the document is parsed as script: a blank page. The two hazards, in full, are documented beside the
 * assembled constants in `src/app/01-core.js`.
 *
 * The check is a substring test rather than a comparison against the assembled constants, because the
 * constants are the *runtime* fix; this is about what the source text literally contains.
 */
function checkScriptTextIsSafe(script) {
  const offenders = [];
  // An angle bracket, an optional slash, then the word `script`: the end-tag form terminates the
  // element, and the opening form is what arms the legacy double-escaped state.
  const pattern = /<[\/]?script/gi;
  let match;
  while ((match = pattern.exec(script)) !== null) {
    offenders.push({ at: match.index, text: match[0] });
  }
  if (offenders.length === 0) return;

  const first = offenders[0];
  const line = script.slice(0, first.at).split('\n').length;
  // Report the byte offset and the line, and name the workaround, because the offender is usually
  // inside prose and looks completely harmless where it sits.
  fail(
    `the concatenated script contains ${offenders.length} occurrence(s) of a literal script tag ` +
      `(first at line ${line}, offset ${first.at}); the HTML tokenizer acts on this text before ` +
      'JavaScript runs, so it would end the element or arm the legacy escaped state there. Build ' +
      'the sequence from parts — see the SCRIPT_OPEN/SCRIPT_CLOSE note in src/app/01-core.js.',
  );
}

/** Escape a JSON text for a <script> element, so JSON.parse of the escaped text yields the original. */
function escapeForScriptBlock(jsonText, TMV) {
  return TMV.container.escapeForScriptBlock(jsonText);
}

function buildCsp({ scriptHash, styleHash, mermaidOrigin }) {
  // 02-architecture.md §5. `default-src 'none'` — everything is denied unless named.
  // Only <meta>-supported directives: frame-ancestors, report-uri and sandbox are header-only.
  return [
    "default-src 'none'",
    `script-src '${scriptHash}' ${mermaidOrigin}`,
    `style-src '${styleHash}' https://cdn.jsdelivr.net`,
    'font-src https://1.www.s81c.com',
    'img-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

// ---------------------------------------------------------------------------------------------

const TMV = loadNamespace();

// 1. CSS
const stylesDir = join(ROOT, 'src', 'styles');
const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css')).sort();
if (cssFiles.length === 0) fail('no CSS found in src/styles/');
const appCss = cssFiles.map((f) => `/* ${f} */\n${read(join(stylesDir, f))}`).join('\n');
const styleHash = `sha256-${sha256b64(appCss)}`;

// 2. JS — with the test seams cut out, so nothing below hashes or ships them.
const appJs = stripTestHooks(
  BUILD_ORDER.map((f) => `/* ---- src/app/${f} ---- */\n${read(join(ROOT, 'src', 'app', f))}`).join('\n'),
);
if (appJs.includes('tmv:test-hook') || /\.__test\b/.test(appJs)) {
  fail('a test hook survived stripping');
}
checkScriptTextIsSafe(appJs);

// Vendored schemas and the Mermaid pin are inlined so validation and rendering need no network read.
const schemasJson = JSON.stringify({
  otm: JSON.parse(read(join(ROOT, 'vendor', 'otm_schema.json'))),
  tml: JSON.parse(read(join(ROOT, 'vendor', 'tml_schema.json'))),
});
const schemasJs = `globalThis.TMV_SCHEMAS = ${escapeForScriptBlock(schemasJson, TMV)};`;

const mermaidVersion = read(join(ROOT, 'vendor', 'mermaid.version')).trim();
if (!/^\d+\.\d+\.\d+$/.test(mermaidVersion)) {
  fail(`vendor/mermaid.version is not an exact pinned version: ${JSON.stringify(mermaidVersion)}`);
}
// 08-security.md §7 requires the Mermaid script be SRI-checked as well as version-pinned. The digest
// is recorded next to the version rather than typed into a module, so re-pinning is one edit to
// vendor/ and the app cannot carry a digest that does not match the version beside it.
//
// The digest reaches the artifact as a static attribute on the inert template element that
// `14-diagrams.js` clones when a Mermaid diagram is first displayed — not as a global the module
// reads, so what the Settings pane shows and what the browser verifies are the same attribute.
const mermaidSri = read(join(ROOT, 'vendor', 'mermaid.sri')).trim();
if (!/^sha\d{3}-[A-Za-z0-9+/]+=*$/.test(mermaidSri)) {
  fail(`vendor/mermaid.sri is not a subresource-integrity digest: ${JSON.stringify(mermaidSri)}`);
}
const mermaidSrc = `https://cdn.jsdelivr.net/npm/mermaid@${mermaidVersion}/dist/mermaid.min.js`;
const mermaidJs = `globalThis.TMV_MERMAID_VERSION = ${JSON.stringify(mermaidVersion)};`;

// 3/4. Assemble the script exactly as index.html will render it, then hash those bytes.
const template = read(join(ROOT, 'src', 'index.html'));
const scriptContent = `${schemasJs}\n${mermaidJs}\n${appJs}`;
const appHash = `sha256-${sha256b64(scriptContent)}`;

// 5. Seed container, from the application's own model and VCS code.
const seed = TMV.container.buildSeedContainer({
  appVersion: APP_VERSION,
  appHash,
  generatedAt: new Date().toISOString(),
});

const now = new Date().toISOString();
const replacements = {
  APP_JS: appJs,
  SCHEMAS: schemasJs,
  MERMAID_VERSION: mermaidJs,
  MERMAID_SRC: mermaidSrc,
  MERMAID_SRI: mermaidSri,
  APP_CSS: appCss,
  CSP: buildCsp({
    scriptHash: appHash,
    styleHash,
    // Mermaid is the one third-party *script* origin, and only its origin is granted (ADR-0010).
    mermaidOrigin: 'https://cdn.jsdelivr.net',
  }),
  APP_HASH: appHash,
  APP_VERSION,
  BUILD_TIME: now,
  APP_DATA: escapeForScriptBlock(TMV.container.serialize(seed), TMV),
};

let html = template;
for (const [key, value] of Object.entries(replacements)) {
  html = html.split(`{{${key}}}`).join(value);
}

// 6. Fail loudly on any unresolved marker (REQ-SHELL-003 AC2).
const unresolved = html.match(/\{\{[A-Z0-9_]+\}\}/g);
if (unresolved) {
  fail(`unresolved placeholder(s): ${[...new Set(unresolved)].join(', ')}`);
}

// 7. Self-check: the artifact's declared hash must match the script it actually carries.
const scriptMatch = html.match(/<script id="tmv-app">([\s\S]*?)<\/script>/);
if (!scriptMatch) fail('could not locate the application script in the assembled artifact');
const actualHash = `sha256-${sha256b64(scriptMatch[1])}`;
if (actualHash !== appHash) {
  fail(`declared hash ${appHash} does not match the emitted script (${actualHash})`);
}
const declared = html.match(/name="tmv-app-hash" content="([^"]+)"/);
if (!declared || declared[1] !== appHash) fail('tmv-app-hash meta does not match the computed hash');

// The CSP must precede the first script element (REQ-SEC-001 AC2, invariant I3).
const cspAt = html.indexOf('http-equiv="Content-Security-Policy"');
const firstScriptAt = html.search(/<script[\s>]/);
if (cspAt === -1 || firstScriptAt === -1 || cspAt > firstScriptAt) {
  fail('the CSP meta tag does not precede the first <script> element');
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
process.stdout.write(
  `built dist/threat-model-viewport.html (${kb} KB)\n` +
    `  app script   ${appHash}\n` +
    `  app styles   ${styleHash}\n` +
    `  mermaid      ${mermaidVersion}\n`,
);
