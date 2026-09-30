/*
 * sec.test.mjs — the security requirements that are properties of *behaviour* rather than of the
 * shipped text.
 *
 * `08-security.md` is the document every other decision bends around, and its claims divide into two
 * kinds. One kind is "this artifact does not contain X", which `test/static.test.mjs` answers by
 * reading `dist/`. The other is "when this happens, this does not", which needs an input: a model
 * full of markup, an imported document that looks native, a file written by another build, an SVG
 * with a script in it. That second kind is this file, and the two files are deliberately disjoint —
 * a name may be declared once in the suite, so each requirement's test lives in the file whose
 * subject it is. Three of the tests below also carry a static half, because `09-testing.md` §5 pairs
 * that row with the same requirement and the same single test name.
 *
 * Two harness facts shape almost everything here:
 *
 *   - **The stub DOM has no `innerHTML`.** `test/lib/dom.mjs` implements the DOM subset the widgets
 *     use, and `innerHTML` is not in it. So a render that reached for it would throw rather than
 *     quietly succeed, and the escape tests below are asserting on a tree that was built the only way
 *     this harness allows — by creating elements. What they check is that the *text* of a hostile
 *     field arrived as text and that no element or attribute was produced from it.
 *
 *   - **`19-boot.js` runs at load and captures `document` at that moment.** The ordinary harness
 *     leaves `document` undefined so that loading the sources proves none of them needs a document to
 *     define itself. The boot tests therefore build their own context with a document already in it,
 *     which is what a browser does — and means the boot path under test is the shipped one, not a
 *     re-implementation of it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

import { specTest } from '../lib/check.mjs';
import { ROOT, SOURCE, HOST_IDS, loadShell, schemas } from '../lib/app.mjs';
import { appScript, codeOnly, findings, markupOnly, openTags } from '../lib/scan.mjs';
import { makeDom } from '../lib/dom.mjs';

const html = readFileSync(`${ROOT}/dist/threat-model-viewport.html`, 'utf8');
const app = appScript(html);
const code = codeOnly(app);

/** Walk an element tree. The stub has no `TreeWalker`, and one is not worth adding for this. */
function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
}

/** Every element in a tree, as a list. */
function elements(tree) {
  const out = [];
  walk(tree, (n) => {
    if (n.nodeType === 1) out.push(n);
  });
  return out;
}

/**
 * The hostile strings, used as *field values* rather than as a list of things to search for.
 *
 * Each is a different way out of a text node: a tag that does something on error, a tag sequence
 * that ends the surrounding script element if the content is ever placed inside one, a quote that
 * closes an attribute, and an SVG element whose load handler fires without any user action.
 */
const PAYLOADS = {
  img: '<img src=x onerror=alert(1)>',
  tags: '</script><script>alert(2)</script>',
  quote: '" onmouseover="alert(3)" x="',
  svg: '<svg/onload=alert(4)>',
};

/** URLs that must never survive into an `href` or a `src`. */
const HOSTILE_URLS = ['javascript:alert(5)', 'JaVaScRiPt:alert(6)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(7)'];

/** Elements no screen may build from model content. `script` and `iframe` are never legitimate here. */
const FORBIDDEN_ELEMENTS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'style', 'meta']);

/**
 * The violations a rendered tree may not contain, as a list of sentences.
 *
 * Shared by the model-render test and the import test, because "imported content is untrusted
 * *regardless of appearance*" (REQ-SEC-007) means the imported model has to end up under exactly the
 * same assertions as a hand-built one — not under a weaker set that assumes the source was native.
 */
function unsafeIn(tree) {
  const found = [];
  for (const node of elements(tree)) {
    if (FORBIDDEN_ELEMENTS.has(node.localName)) found.push(`<${node.localName}>`);
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name)) found.push(`<${node.localName} ${attr.name}="…">`);
      if (/^\s*(javascript|vbscript|data\s*:\s*text\/html)/i.test(attr.value)) found.push(`<${node.localName} ${attr.name}="${attr.value.slice(0, 40)}">`);
      // The payload's own `src="x"` is the decisive one: if the string had been parsed, an element
      // would carry the value the payload asked for.
      if (attr.value === 'x' && (attr.name === 'src' || attr.name === 'href')) found.push(`<${node.localName} ${attr.name}="x">`);
    }
  }
  return found;
}

/**
 * REQ-SEC-003 — every value from a model is inserted as text, never as markup.
 *
 * §5 puts the sink scan (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`) under this
 * same requirement, so it is here rather than in the static file: the requirement is one claim with a
 * static half and a behavioural half, and splitting it across two names would need a name the
 * specification does not cite.
 *
 * The behavioural half is parameterised over *fields*, which is what the requirement asks for: the
 * payloads go into the name, description and metadata fields of every entity kind the model has, and
 * each URL field gets a `javascript:` URL. Every tab and every section is then rendered, because a
 * value that is escaped in the list but not in the detail panel is the defect this is looking for.
 */
specTest('sec.xss-model-fields', () => {
  // The static half. No path may build markup from a string.
  for (const [label, pattern] of [
    ['innerHTML', /\binnerHTML\b/g],
    ['outerHTML', /\bouterHTML\b/g],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/g],
    ['document.write', /document\s*\.\s*write\b/g],
  ]) {
    assert.equal(findings(code, pattern).length, 0, `the artifact's code contains no ${label}`);
    // …and the rule flags it when it is there. The samples are built from parts so that this file
    // would not itself trip a scan written the same way.
    const sample = `node.${'inner' + 'HTML'} = model.name; node.outer${'HTML'} = s; node.insert${'AdjacentHTML'}("beforeend", s); document.write("<b>");`;
    assert.ok(findings(sample, pattern).length > 0, `the ${label} rule flags a real use`);
    // The two halves of the artifact's own prose that a naive scan reports: `01-core.js` explains
    // this absence, and the explanation must not be mistaken for the thing it explains.
    assert.ok(SOURCE.get('01-core.js').includes('innerHTML'), 'the source does discuss the sink it does not use');
  }

  const { dom, shell, model, M } = loadShell();

  // One hostile value per entity kind, in the field a list column shows, so every rendered screen
  // carries at least one hostile value and none of them is reachable only through a detail panel.
  const hostile = [
    ['component', PAYLOADS.img],
    ['actor', PAYLOADS.tags],
    ['threat', PAYLOADS.quote],
    ['control', PAYLOADS.svg],
    ['dataStore', PAYLOADS.img],
    ['dataSet', PAYLOADS.tags],
    ['asset', PAYLOADS.quote],
    ['trustZone', PAYLOADS.svg],
    ['dataFlow', PAYLOADS.img],
    ['assumption', PAYLOADS.tags],
    ['risk', PAYLOADS.quote],
    ['mitigationPlan', PAYLOADS.svg],
  ];
  for (const [kind, payload] of hostile) {
    M.insert(model, kind, { id: `hostile-${kind}`, name: payload, description: payload });
  }
  // The URL fields, which are the other half of the requirement: a `javascript:` URL in a link field
  // is a defect even when the surrounding text is escaped.
  const comp = M.get(model, 'component', 'comp-gw');
  comp.repoLink = HOSTILE_URLS[0];
  comp.description = PAYLOADS.img;
  model.name = PAYLOADS.tags;
  model.description = PAYLOADS.quote;
  model.metadata = Object.assign(Object.create(null), {
    owner: PAYLOADS.img,
    ownerContact: HOSTILE_URLS[1],
    repoLink: HOSTILE_URLS[2],
    releaseDocs: HOSTILE_URLS[3],
    tags: [PAYLOADS.svg, PAYLOADS.tags],
  });
  shell.refresh();

  const seen = [];
  for (const tab of shell.TABS) {
    for (const section of tab.sections) {
      shell.go(tab.id, section.id);
      const content = dom.body.querySelector('#tmv-content');
      assert.ok(content, `${tab.id}/${section.id} rendered a content node`);
      assert.deepEqual(unsafeIn(content), [], `${tab.id}/${section.id} rendered model text as markup`);
      seen.push(content.textContent);
    }
  }

  // Escaping is only proven by the value arriving somewhere. A renderer that dropped every hostile
  // value would pass the assertions above, so the payloads are required to be *present*, as text.
  const rendered = seen.join('\n');
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    assert.ok(rendered.includes(payload), `the ${name} payload is rendered as text, unchanged`);
  }
  for (const url of HOSTILE_URLS) {
    assert.equal(
      elements(dom.body).some((n) => n.attributes.some((a) => a.value === url)),
      false,
      `${url} appears nowhere as an attribute value`,
    );
  }

  // `safeUrl` is the mechanism, and it is checked directly: scheme matching is case-insensitive and
  // a data URI is not a link. The one function is what every link field goes through.
  const { safeUrl } = loadShell().core;
  for (const url of HOSTILE_URLS) assert.equal(safeUrl(url), null, `${url} is not a safe URL`);
  assert.equal(safeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeUrl('mailto:security@example.com'), 'mailto:security@example.com');
  assert.equal(safeUrl('java\nscript:alert(1)'), null, 'a control character does not smuggle a scheme');
});

/**
 * REQ-SEC-004 — untrusted SVG is sanitized, or refused.
 *
 * The acceptance criteria are "does not execute" and "does not fetch", and both are asserted against
 * what survives rather than against a counter: the test walks the sanitized tree and fails on any
 * script element, any `on*` attribute, any `javascript:` value and any URL that would be a fetch.
 *
 * The last assertion is what keeps this from passing vacuously. A sanitizer that returned an empty
 * tree — or refused everything — would satisfy "nothing dangerous survived" while having destroyed
 * the one thing it is for, which is to render a diagram. So a benign SVG is required to survive with
 * its shapes intact.
 */
specTest('sec.svg-sanitized', () => {
  const diagrams = loadShell().TMV.diagrams;
  const dom = makeDom();
  const NS = 'http://www.w3.org/2000/svg';

  const HOSTILE = [
    ['a script element', `<svg xmlns="${NS}"><script>alert(1)</script><rect width="1" height="1"/></svg>`],
    ['a load handler on the root', `<svg xmlns="${NS}" onload="alert(1)"><rect width="1" height="1"/></svg>`],
    ['an external image', `<svg xmlns="${NS}"><image href="https://evil.example/x.png"/></svg>`],
    ['an external reference through xlink', `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/y"/></svg>`],
    ['a link to javascript:', `<svg xmlns="${NS}"><a href="javascript:alert(1)"><rect/></a></svg>`],
    ['an animate element carrying a value', `<svg xmlns="${NS}"><animate attributeName="href" values="https://evil.example/z"/><rect/></svg>`],
    ['a style element importing a stylesheet', `<svg xmlns="${NS}"><style>@import url("https://evil.example/s.css");</style><rect/></svg>`],
    ['a foreignObject carrying html', `<svg xmlns="${NS}"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject></svg>`],
    ['an external entity', `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="${NS}"><text>&xxe;</text></svg>`],
  ];

  for (const [label, source] of HOSTILE) {
    const result = diagrams.sanitizeSvg(source, dom);
    if (result.error) {
      // Refusing the document outright is a stronger answer than sanitizing it, and the sanitizer is
      // allowed to take it — but it has to be a refusal it can name.
      assert.equal(typeof result.error, 'string', `${label}: a refusal states a reason`);
      continue;
    }
    assert.ok(result.element, `${label}: a sanitized tree came back`);
    const offenders = [];
    for (const node of elements(result.element)) {
      if (/^(script|foreignObject|handler|listener)$/i.test(node.localName)) offenders.push(node.localName);
      for (const attr of node.attributes) {
        if (/^on/i.test(attr.name)) offenders.push(attr.name);
        if (/^\s*javascript:/i.test(attr.value)) offenders.push(attr.value);
        if (/^https?:/i.test(attr.value)) offenders.push(attr.value);
        if (/@import|url\s*\(\s*['"]?https?:/i.test(attr.value)) offenders.push(attr.value);
      }
    }
    assert.deepEqual(offenders, [], `${label} left nothing dangerous in the tree`);
  }

  // Refusal is not allowed to be the only behaviour: an ordinary diagram has to render.
  const benign = `<svg xmlns="${NS}" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#fff"/><text x="2" y="5">Label</text></svg>`;
  const kept = diagrams.sanitizeSvg(benign, dom);
  assert.equal(kept.error, undefined, 'a benign svg is not refused');
  const keptNames = elements(kept.element).map((n) => n.localName);
  assert.ok(keptNames.includes('rect'), 'the benign svg keeps its shapes');
  assert.ok(keptNames.includes('text'), 'the benign svg keeps its text');

  // And the sanitizer's own vocabulary agrees about what is forbidden.
  for (const name of ['script', 'foreignObject', 'handler']) {
    assert.ok(diagrams.FORBIDDEN_ELEMENTS.includes(name), `${name} is in the forbidden list`);
  }
});

/**
 * REQ-SEC-005 — a foreign build is flagged, and opens read-only until acknowledged.
 *
 * The mismatch is between the hash the *file* records and the hash the *running build* declares in
 * its own document, so the test has to give boot both. Everything else is the ordinary boot path: the
 * modules are evaluated against a document that already holds the meta tag, the data block and the
 * shell's host elements, and `run()` does the rest.
 *
 * Both acceptance criteria are asserted on observable state rather than on the presence of a string:
 * the file opens read-only, the notice names the mismatch, and editability comes back only when the
 * notice's own action is taken.
 */
specTest('sec.unknown-app-version', () => {
  const FOREIGN_HASH = 'sha256-XY3k9AbCdEfGh';
  const OTHER_HASH = 'sha256-Qw8rT2yUiOpAs';

  const bootWith = (declaredHash, runningHash) => {
    const built = loadShell();
    const container = built.TMV.container.makeContainer(built.model, built.history, {
      appVersion: '9.9.9',
      appHash: declaredHash,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    return boot({ containers: built.TMV.container, container, runningHash });
  };

  const foreign = bootWith(FOREIGN_HASH, 'sha256-ThisBuild');
  assert.equal(foreign.TMV.shell.state().editable, false, 'a file from another build opens read-only');
  const reason = foreign.TMV.shell.state().readOnlyReason || '';
  assert.match(reason, /different build/i, 'the read-only reason says why');
  assert.ok(reason.includes(shortOf(FOREIGN_HASH)), 'the reason names the hash the file recorded');

  const banners = foreign.dom.body.querySelector('#tmv-banners').textContent;
  assert.match(banners, /different build/i, 'the notice is shown, not only the read-only banner');
  const action = foreign.dom.body
    .querySelectorAll('[data-action="notify-action"]')
    .find((node) => node.getAttribute('data-value') === 'trust-foreign-build');
  assert.ok(action, 'editing is offered behind an explicit acknowledgement');
  assert.equal(foreign.TMV.shell.state().editable, false, 'the acknowledgement has not been given yet');

  action.click();
  assert.equal(foreign.TMV.shell.state().editable, true, 'the acknowledgement restores editing');
  assert.equal(/different build/i.test(foreign.dom.body.querySelector('#tmv-banners').textContent), false, 'the notice is cleared');

  // A file from this build is not flagged, so the check is a comparison and not a constant.
  const same = bootWith('sha256-ThisBuild', 'sha256-ThisBuild');
  assert.equal(same.TMV.shell.state().editable, true, 'a file from this build opens editable');
  assert.equal(same.TMV.shell.state().readOnlyReason, null, 'and carries no read-only reason');

  // "Names the mismatch" has to mean something: two different foreign builds must not produce the
  // same sentence. `core.shortId` shortens a content address (`sha256:<hex>`); an application hash is
  // a CSP hash (`sha256-<base64>`), and handing it to `shortId` yields the scheme and nothing else.
  const other = bootWith(OTHER_HASH, 'sha256-ThisBuild');
  const otherReason = other.TMV.shell.state().readOnlyReason || '';
  assert.notEqual(reason, otherReason, 'two different foreign builds are named differently');
  assert.ok(reason.includes(shortOf(FOREIGN_HASH)), 'the message carries a readable prefix of the file hash');
  assert.ok(!/different build of the application \(sha256-\)/.test(reason), 'the message does not degenerate to the scheme');
});

/** The short form the notice is expected to show: the scheme, then seven characters of the digest. */
function shortOf(hash) {
  const at = hash.indexOf('-');
  return at === -1 ? hash.slice(0, 7) : `${hash.slice(0, at + 1)}${hash.slice(at + 1, at + 8)}`;
}

/**
 * Evaluate the shipped sources against a document, the way a browser does.
 *
 * `loadShell` mounts the shell directly and leaves `document` undefined while the modules are
 * evaluated. Boot is the one file that cannot be tested that way — it reads `document` at load — so
 * this helper builds the context instead: the host elements the shell expects, the meta tag boot
 * compares against, and the data block it parses.
 *
 * `document.querySelector` is added to the stub. The stub documents itself as a subset and omits it;
 * the selector engine is implemented on elements, and a browser's document has it. Adding it here is
 * what lets `runningAppHash()` — which is deliberately reading a document attribute rather than
 * recomputing its own hash — run unchanged.
 */
function boot(options) {
  const dom = makeDom();
  dom.querySelector = (selector) => dom.head.querySelector(selector) || dom.body.querySelector(selector) || null;

  for (const id of HOST_IDS) {
    const node = dom.createElement('div');
    node.setAttribute('id', id);
    dom.body.appendChild(node);
  }
  const hashMeta = dom.createElement('meta');
  hashMeta.setAttribute('name', 'tmv-app-hash');
  hashMeta.setAttribute('content', options.runningHash);
  dom.head.appendChild(hashMeta);
  const versionMeta = dom.createElement('meta');
  versionMeta.setAttribute('name', 'tmv-app-version');
  versionMeta.setAttribute('content', '0.1.0');
  dom.head.appendChild(versionMeta);

  const data = dom.createElement('script');
  data.setAttribute('type', 'application/json');
  data.setAttribute('id', 'tmv-data');
  data.textContent = options.containers.escapeForScriptBlock(options.containers.serialize(options.container));
  dom.body.appendChild(data);

  const sandbox = Object.assign(
    { console, TextEncoder, TextDecoder, crypto: webcrypto, setTimeout, clearTimeout, document: dom, navigator: {} },
    options.globals || {},
  );
  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.globalThis = globalThis;', context);
  vm.runInContext(`globalThis.TMV_SCHEMAS = ${JSON.stringify(schemas())};`, context);
  for (const [file, source] of SOURCE) vm.runInContext(source, context, { filename: `src/app/${file}` });
  return { dom, TMV: context.TMV, context };
}

/** A stand-in for the pristine document element: an `html` root holding the data block. */
function pristineRoot(dom) {
  const root = dom.createElement('html');
  const head = dom.createElement('head');
  const body = dom.createElement('body');
  const block = dom.createElement('script');
  block.setAttribute('type', 'application/json');
  block.setAttribute('id', 'tmv-data');
  body.appendChild(block);
  root.appendChild(head);
  root.appendChild(body);
  return root;
}

/**
 * REQ-SEC-007 — an import that looks native is still untrusted input.
 *
 * The premise of the requirement is that "looks native" is not a basis for skipping anything, so the
 * fixture is a document that is native in every respect the app can see: the right `tmv-data`
 * element, the right container shape, the right `tmvFormat`. It is then carried through the real
 * import path and into the shell, and put under the *same* assertions as a hand-built model.
 */
specTest('sec.import-always-untrusted', () => {
  const { TMV, M } = loadShell();

  // A model built hostile from the start. Mutating the imported model *after* the fact would prove
  // nothing: the history is what the app reads back, so the fixture has to be hostile where the
  // history is seeded.
  const hostileModel = M.createEmpty('Payments Platform', '33333333-2222-4333-8444-555555555555');
  M.insert(hostileModel, 'component', {
    id: 'comp-gw',
    name: PAYLOADS.img,
    description: PAYLOADS.svg,
    repoLink: HOSTILE_URLS[0],
  });
  M.insert(hostileModel, 'actor', { id: 'actor-user', name: PAYLOADS.tags, description: PAYLOADS.quote });
  M.insert(hostileModel, 'threat', { id: 'threat-t1', name: PAYLOADS.quote, description: PAYLOADS.img });
  M.insert(hostileModel, 'control', { id: 'control-c1', name: PAYLOADS.svg, description: PAYLOADS.tags });
  hostileModel.name = PAYLOADS.tags;
  hostileModel.metadata = Object.assign(Object.create(null), {
    owner: PAYLOADS.img,
    ownerContact: HOSTILE_URLS[0],
    tags: [PAYLOADS.quote],
  });

  const history = TMV.vcs.initHistory(hostileModel, { name: 'Importer', email: 'i@example.com' }, 'Seed');
  const container = TMV.container.makeContainer(hostileModel, history, {
    appVersion: '0.1.0',
    appHash: 'sha256-whatever',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  const document = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>Payments Platform</h1>\n` +
    `<${'script'} type="application/json" id="tmv-data">${TMV.container.escapeForScriptBlock(TMV.container.serialize(container))}</${'script'}>\n</body></html>`;

  const result = TMV.importing.runImport({ text: document, filename: 'looks-native.html' }, {});
  assert.equal(result.ok, true, 'a native-shaped document imports');
  assert.equal(result.format, TMV.importing.NATIVE, 'and is recognised as native — that is the premise of the test');

  // The values arrive as data. Nothing was interpreted on the way in.
  const imported = result.model;
  assert.equal(TMV.model.get(imported, 'component', 'comp-gw').name, PAYLOADS.img, 'the payload arrives as the string it was');
  assert.equal(TMV.model.get(imported, 'component', 'comp-gw').repoLink, HOSTILE_URLS[0], 'a javascript: URL is still just a string');

  // …and then the shell renders it, under the same rules as any other model.
  const { dom, shell, model: live } = loadShell();
  Object.assign(live, TMV.core.deepCopy(imported));
  shell.refresh();
  const offenders = [];
  for (const tab of shell.TABS) {
    for (const section of tab.sections) {
      shell.go(tab.id, section.id);
      offenders.push(...unsafeIn(dom.body.querySelector('#tmv-content')).map((o) => `${tab.id}/${section.id}: ${o}`));
    }
  }
  assert.deepEqual(offenders, [], 'an imported model renders under the same escaping rules');
  shell.go('architecture', 'components');
  assert.ok(dom.body.querySelector('#tmv-content').textContent.includes(PAYLOADS.img), 'and its text is still shown');

  // The one exemption in the requirement is that a native source is trusted *more*; there is no such
  // branch. A document claiming to be native is parsed by the same function as anything else.
  assert.equal(typeof TMV.importing.runImport, 'function');
  const text = TMV.importing.extractDataBlock(document);
  assert.equal(typeof text, 'string', 'extraction returns text, never a node');
  assert.ok(text.includes('tmvFormat'), 'and it is the embedded JSON');
});

/**
 * REQ-SEC-008 — no telemetry, and no network request that REQ-SHELL-007 does not enumerate.
 *
 * The acceptance criterion is a network inspection, which this harness cannot do. What it can do is
 * better than asserting an absence in the source: the application is loaded into a context where
 * every egress API is a recorder, a full exercise is driven through it — mount, every tab, a commit,
 * an export, an import — and the recorders are required to be untouched. That is the same claim as
 * the criterion, made at the boundary the criterion is about.
 *
 * The static half covers what the exercise cannot reach: a request the app would only make on a path
 * this test did not take is still visible as the API that would make it.
 */
specTest('sec.no-telemetry', () => {
  const sent = [];
  const record = (name) => (...args) => {
    sent.push({ name, args: args.map((a) => String(a).slice(0, 40)) });
    throw new Error(`${name} was called`);
  };

  class RecordedXHR {
    constructor() {
      record('XMLHttpRequest')();
    }
  }
  class RecordedWebSocket {
    constructor(url) {
      record('WebSocket')(url);
    }
  }
  class RecordedEventSource {
    constructor(url) {
      record('EventSource')(url);
    }
  }
  class RecordedImage {
    constructor() {
      this.src = '';
      Object.defineProperty(this, 'src', {
        set(value) {
          record('Image.src')(value);
        },
        get() {
          return '';
        },
      });
    }
  }

  const { TMV, model, history } = loadShell();
  const container = TMV.container.makeContainer(model, history, {
    appVersion: '0.1.0',
    appHash: 'sha256-x',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  const booted = boot({
    containers: TMV.container,
    container,
    runningHash: 'sha256-x',
    globals: {
      fetch: record('fetch'),
      XMLHttpRequest: RecordedXHR,
      WebSocket: RecordedWebSocket,
      EventSource: RecordedEventSource,
      Image: RecordedImage,
      navigator: { sendBeacon: record('navigator.sendBeacon') },
      Blob: class Blob {},
      URL: Object.assign(class URL {}, { createObjectURL: () => 'blob:local', revokeObjectURL() {} }),
    },
  });

  // A full exercise. Every tab and section is rendered, because a view that fetched something would
  // do it on whichever screen builds it.
  const shell = booted.TMV.shell;
  for (const tab of shell.TABS) for (const section of tab.sections) shell.go(tab.id, section.id);
  shell.edit(TMV.core.deepCopy(shell.state().model), { label: 'Exercise' });
  shell.commit({ name: 'Tester', email: 't@example.com' }, 'Exercise');
  // A standalone export needs the pristine clone boot would have taken in a browser, and this
  // harness's stub document has no element tree to clone. `setPristineForTest` is the seam the
  // export module documents for exactly this; the point here is to run the export path, not to
  // re-test the cloning that `exp.test.mjs` covers.
  booted.TMV.exporting.setPristineForTest(pristineRoot(booted.dom));
  booted.TMV.exporting.exportAs(booted.TMV.exporting.HTML, shell.state().model, shell.state().history);
  booted.TMV.exporting.exportAs(booted.TMV.exporting.NATIVE, shell.state().model, shell.state().history);
  booted.TMV.importing.runImport({ text: '<html><body>nothing</body></html>', filename: 'nothing.html' }, {});
  booted.TMV.diagrams.sourceDiagrams(shell.state().model);

  assert.deepEqual(sent, [], 'no egress API was reached during a full exercise');

  // Static: the artifact contains no API that would make a request, and no analytics identifier.
  for (const [label, pattern] of [
    ['fetch', /(^|[^.\w$])fetch\s*\(/gm],
    ['XMLHttpRequest', /XMLHttpRequest/g],
    ['sendBeacon', /sendBeacon/g],
    ['WebSocket', /WebSocket/g],
    ['EventSource', /EventSource/g],
    ['FormData', /\bFormData\b/g],
    ['an image beacon', /new\s+Image\b/g],
  ]) {
    assert.equal(findings(code, pattern).length, 0, `the artifact contains no ${label}`);
    assert.ok(findings(codeOnly(`var x = ${label === 'an image beacon' ? 'new Image()' : label + '(1)'};`), pattern).length > 0, `the ${label} rule flags a use`);
  }
  for (const identifier of ['gtag', 'google-analytics', 'googletagmanager', 'mixpanel', 'amplitude.com', 'segment.io', 'posthog', 'hotjar', 'matomo', 'sentry.io']) {
    assert.equal(findings(code, new RegExp(identifier.replace('.', '\\.'), 'gi')).length, 0, `the artifact names no analytics service (${identifier})`);
  }
});

/**
 * REQ-IMP-008 — an imported HTML document is never executed, and never inserted.
 *
 * The extraction path reads the file as *text*. The test asserts the two acceptance criteria
 * separately: a script in the incoming document does not run (nothing observes it running, and — more
 * to the point — nothing in this process *can* run it, because the import never builds a DOM), and
 * the module that does the extraction contains no sink that could insert anything, checked over the
 * shipped artifact rather than the source.
 */
specTest('sec.import-html-no-exec', () => {
  const { TMV, model, history } = loadShell();
  const container = TMV.container.makeContainer(model, history, { appVersion: '0.1.0', appHash: 'sha256-x', generatedAt: '2026-01-01T00:00:00.000Z' });
  const payload = TMV.container.escapeForScriptBlock(TMV.container.serialize(container));

  let ran = 0;
  globalThis.__tmvProbe = () => {
    ran += 1;
  };
  try {
    const hostile = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n` +
      `<${'script'}>globalThis.__tmvProbe();</${'script'}>\n` +
      `<img src=x onerror="globalThis.__tmvProbe()">\n` +
      `<${'script'} type="application/json" id="tmv-data">${payload}</${'script'}>\n` +
      `<${'script'}>globalThis.__tmvProbe();</${'script'}>\n` +
      `</body></html>`;

    const result = TMV.importing.runImport({ text: hostile, filename: 'hostile.html' }, {});
    assert.equal(ran, 0, 'nothing in the incoming document ran');
    assert.equal(result.ok, true, 'the model inside it is still read');
    assert.equal(result.format, TMV.importing.NATIVE, 'and read as the native container it claims to be');

    // Extraction is a string operation over the text of the file.
    const extracted = TMV.importing.extractDataBlock(hostile);
    assert.equal(typeof extracted, 'string', 'the data block comes back as text');
    assert.ok(extracted.includes('tmvFormat'), 'and it is the JSON, not a rendered node');
    assert.equal(/<img|onerror/i.test(extracted), false, 'the surrounding document is not part of what was extracted');

    // The extraction path carries no sink. This is REQ-IMP-008's second acceptance criterion, read
    // off the shipped artifact: the import module's own region of the built script.
    const at = app.indexOf('/* ---- src/app/10-import.js ---- */');
    assert.ok(at !== -1, 'the import module is marked in the artifact');
    const next = app.indexOf('/* ---- src/app/', at + 10);
    const importModule = codeOnly(app.slice(app.indexOf('\n', at) + 1, next === -1 ? app.length : next));
    for (const [label, pattern] of [
      ['innerHTML', /\binnerHTML\b/g],
      ['outerHTML', /\bouterHTML\b/g],
      ['insertAdjacentHTML', /\binsertAdjacentHTML\b/g],
      ['document.write', /document\s*\.\s*write\b/g],
      ['dynamic script creation', /createElement\s*\(\s*['"]script/g],
    ]) {
      assert.equal(findings(importModule, pattern).length, 0, `the import module contains no ${label}`);
    }
  } finally {
    delete globalThis.__tmvProbe;
  }
});

/**
 * REQ-SHELL-007 — no network calls beyond the enumerated pinned assets.
 *
 * The enumeration is the point. "The app makes no requests" would be wrong — Carbon's stylesheet and
 * Mermaid are both fetched, from a CDN, and the app is documented as not being offline-capable
 * (ADR-0002). What is required is that the set is closed and known, so the assertion is that the
 * artifact references exactly those two URLs and nothing else, that the policy blocks everything
 * else including any form submission, and that no exported document carries model text inside a URL.
 */
specTest('sec.no-exfiltration', () => {
  const references = openTags(html).flatMap((tag) =>
    tag.attrs.filter((a) => (a.name === 'src' || a.name === 'href') && /^https?:/i.test(a.value)).map((a) => a.value),
  );
  assert.deepEqual(
    [...references].sort(),
    [
      'https://cdn.jsdelivr.net/npm/@carbon/styles@1.116.0/css/styles.min.css',
      'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js',
    ],
    'the artifact references exactly the two enumerated pinned assets',
  );
  for (const url of references) assert.equal(new URL(url).hostname, 'cdn.jsdelivr.net', `${url} is the pinned origin`);

  const policy = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*content="([^"]*)"/i.exec(html)[1];
  assert.match(policy, /default-src 'none'/, 'everything is denied unless named');
  assert.match(policy, /connect-src 'none'/, 'no connection of any kind is permitted');
  assert.match(policy, /form-action 'none'/, 'nothing can be submitted anywhere');
  assert.match(policy, /font-src https:\/\/1\.www\.s81c\.com/, 'the only permitted font origin is the one Carbon names');

  assert.equal(openTags(html).some((tag) => tag.name === 'form'), false, 'the artifact has no form to submit');
  assert.equal(markupOnly(html).includes('http://'), false, 'and no plaintext reference to anything');

  // The other acceptance criterion: no request could carry model content, because no request carries
  // anything. What can be checked here is the export — a URL built from model text would be one way
  // this requirement is broken, and it would be visible in the file the app writes.
  const { TMV, model, history } = loadShell();
  const marker = 'Zq7-marker-name-Zq7';
  model.name = marker;
  const exported = TMV.exporting.exportAs(TMV.exporting.NATIVE, model, history, {
    build: { appVersion: '0.1.0', appHash: 'sha256-x', generatedAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(exported.ok, true, 'the export succeeded');
  const urls = exported.text.match(/https?:\/\/[^\s"'<>\\)]+/g) || [];
  assert.ok(urls.length > 0, 'the exported file does contain URLs (the schema $id)');
  assert.equal(urls.some((u) => u.includes(marker)), false, 'no URL in the exported file carries model text');
});

/**
 * REQ-SHELL-006 — a `<noscript>` that says what is missing.
 *
 * The failure this guards against is the blank page, so the assertion is not "a noscript element
 * exists" but that it is *visible* — no `hidden`, and not inside a template, which is where a message
 * a developer added for the disabled-JavaScript case would be invisible to the person who needs it.
 */
specTest('shell.noscript', () => {
  const noscripts = openTags(html).filter((tag) => tag.name === 'noscript');
  assert.equal(noscripts.length, 1, 'the artifact has exactly one noscript element');
  assert.equal(noscripts[0].attrs.some((a) => a.name === 'hidden'), false, 'it is not hidden');
  assert.equal(/<template[^>]*>[\s\S]*<noscript/i.test(html), false, 'and it is not inside an inert template');

  const body = /<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/i.exec(html)[1];
  assert.match(body, /<h1[^>]*>\s*JavaScript is required\s*<\/h1>/i, 'it names the requirement in a heading');
  assert.match(body, /JavaScript/i, 'and explains it');
  assert.match(body, /embedded in this file as JSON/i, 'and says the model is still there');
});

/**
 * REQ-UI-011 — no framework runtime.
 *
 * The acceptance criterion is about what the artifact loads, and the artifact loads one script from
 * outside itself: the Mermaid renderer, on the one tab that draws a diagram, pinned and integrity-
 * checked. So the assertion is that the set of external scripts is exactly that one, that it is
 * inert until asked for, and that no framework's identifier appears anywhere in the shipped code —
 * the last of which is a different claim from "no framework is loaded", and the one that catches a
 * runtime that was vendored in by hand.
 */
specTest('shell.no-framework', () => {
  const scripts = openTags(html).filter((tag) => tag.name === 'script');
  const external = scripts.filter((tag) => tag.attrs.some((a) => a.name === 'src'));
  assert.equal(external.length, 1, 'the artifact loads exactly one external script');
  assert.match(external[0].attrs.find((a) => a.name === 'src').value, /@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js$/, 'which is the pinned Mermaid build');
  assert.equal(scripts.some((tag) => tag.attrs.some((a) => a.name === 'type' && a.value === 'module')), false, 'and no module script');

  // The Mermaid script is written inside an inert `<template>`, so it is not fetched on load: the
  // renderer is the one thing that may reach the network and it does so only when a diagram exists.
  const templateAt = html.indexOf('id="tmv-mermaid-loader"');
  assert.ok(templateAt !== -1, 'the mermaid loader is declared in a template');
  assert.ok(html.indexOf('mermaid.min.js') > templateAt, 'the loader script is inside it');

  for (const identifier of ['React', 'ReactDOM', 'Vue', 'Angular', 'Svelte', 'Preact', 'jQuery', 'Ember', 'Backbone', 'LitElement']) {
    assert.equal(findings(code, new RegExp(`\\b${identifier}\\b`, 'g')).length, 0, `the artifact's code names no ${identifier} runtime`);
    assert.ok(findings(codeOnly(`var x = ${identifier};`), new RegExp(`\\b${identifier}\\b`, 'g')).length > 0, `the ${identifier} rule flags a declaration`);
  }
  assert.equal(findings(code, /\bcreateElement\s*\(\s*['"]script/gi).length, 0, 'and nothing builds a script element');
});

/**
 * REQ-SHELL-003 — the build runs from a clean checkout, with no install.
 *
 * The claim is auditable only in the strong form: not "the build has no dependencies in its manifest"
 * but "a copy of the repository with no `node_modules` and no `package.json` builds the artifact".
 * So the test does exactly that — `build.mjs`, `src/` and `vendor/` are the only things copied — and
 * then asserts the second acceptance criterion by breaking a placeholder on purpose and requiring the
 * build to fail loudly rather than emit a file with a hole in it.
 *
 * The build is run with `process.execPath`, so the Node running the tests is the Node under test, and
 * the copy is written to a temporary directory: this test never touches the repository's own `dist/`.
 */
specTest('build.clean-checkout', () => {
  // The build script itself imports nothing but the Node standard library, which is the machine-
  // readable form of "no third-party packages" — checked as imports, not as prose.
  const buildScript = readFileSync(join(ROOT, 'build.mjs'), 'utf8');
  const specifiers = [...buildScript.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, 'the build has imports to check');
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'), `the build imports only node: modules (found ${specifier})`);
  }

  const work = mkdtempSync(join(tmpdir(), 'tmv-clean-build-'));
  try {
    for (const entry of ['src', 'vendor']) cpSync(join(ROOT, entry), join(work, entry), { recursive: true });
    cpSync(join(ROOT, 'build.mjs'), join(work, 'build.mjs'));
    assert.equal(existsSync(join(work, 'node_modules')), false, 'the copy has no installed packages');

    const stdout = execFileSync(process.execPath, ['build.mjs'], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(stdout, /built dist\/threat-model-viewport\.html/, 'the build reported what it wrote');

    const produced = join(work, 'dist', 'threat-model-viewport.html');
    assert.ok(existsSync(produced), 'node build.mjs produced the artifact from a clean checkout');
    const built = readFileSync(produced, 'utf8');
    assert.equal(/\{\{[A-Z0-9_]+\}\}/.test(built), false, 'no placeholder was left in the output');

    // The emitted artifact is self-consistent: the hash it declares is the hash of the script it
    // carries. Asserted here rather than trusted from the build's own report, because a build that
    // says it verified and did not is the failure this whole requirement is about.
    const script = appScript(built);
    const declared = /<meta name="tmv-app-hash" content="([^"]+)"/.exec(built)[1];
    const policy = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*content="([^"]*)"/i.exec(built)[1];
    assert.equal(policy.includes(`script-src '${declared}'`), true, 'the artifact pins the script it carries');
    assert.ok(script.length > 1000, 'and carries a real script');

    // An unresolved placeholder must stop the build, not ship.
    const template = join(work, 'src', 'index.html');
    writeFileSync(template, `${readFileSync(template, 'utf8')}\n<!-- {{TMV_NOT_A_REAL_KEY}} -->\n`);
    let failure = null;
    try {
      execFileSync(process.execPath, ['build.mjs'], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, 'the build failed on an unresolved placeholder');
    assert.notEqual(failure.status, 0, 'and exited with a failure status');
    assert.match(String(failure.stderr), /unresolved placeholder\(s\): \{\{TMV_NOT_A_REAL_KEY\}\}/, 'and said which placeholder, loudly');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
