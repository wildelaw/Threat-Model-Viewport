/*
 * scan.mjs — reading source and artifact text for the static checks (`09-testing.md` §5).
 *
 * A static check is a substring search, and a substring search over this project's sources is wrong
 * in a specific and predictable way: the source is full of prose *about* the constructs it forbids.
 * `01-core.js` says "There is no `innerHTML` in this application", `11-export.js` explains why it
 * does not use `outerHTML`, `07-storage.js` names `localStorage` in a comment above the one line that
 * actually touches it. A scan that does not know the difference reports the documentation as the
 * violation, and the fix a hurried reader applies is to weaken the scan.
 *
 * So the two functions here are the difference between a check that means something and one that
 * passes forever:
 *
 *   `codeOnly(src)`      — comments *and* string/template literals blanked, so an identifier search
 *                          sees only identifiers. Blanking preserves every offset and newline, so a
 *                          finding's line number is the one in the real file.
 *   `stripComments(src)` — comments blanked, literals kept. Used where the literal is the point: a
 *                          property reached as `node['innerHTML']` is a violation that only a scan
 *                          seeing inside the string can find.
 *
 * There is no parser here and none is wanted: the build has no dependencies (REQ-SHELL-003), and a
 * test that imported a JavaScript lexer to check the artifact would be a dependency the artifact's
 * own tests could not run without. The state machine below covers the four literal forms the
 * language has, including `${…}` interpolation, which is the case a naive "blank the backticks"
 * scan gets wrong in the direction that hides a violation rather than inventing one.
 *
 * **Regex literals are the fifth form, and leaving them out is not an omission you can live with.**
 * `04-container.js` has `/(^|[\s"'/])id\s*=\s*…/` and `10-import.js` has `/[\s<>"{}|\\^`]/`. A
 * scanner that does not know a regex literal is not a regex literal reads the `'` inside the first
 * as the start of a string, and from there to the next `'` it is out of step with the file — which
 * was measured, on this codebase, as three `localStorage` occurrences in prose being reported as
 * three code references in the built artifact, when the sources hold exactly one. A desync like that
 * runs in both directions: it invents violations in comments and it hides real ones in code.
 *
 * So `blank` distinguishes a regex from a division the way a reader does, from the previous
 * significant token: after `(`, `,`, `=`, `return`, … a `/` opens a regex; after an identifier, `)`
 * or `]` it is division. `codeOnly` and `stripComments` are then *local* — the state at the end of
 * any complete module is the state at its start — which `static.test.mjs` relies on when it scans a
 * module's region inside the built artifact and the module's own source and requires the two to
 * blank identically.
 *
 * The HTML side is the same problem one layer up: a `<script>` element's *body* is not markup, and
 * neither is a comment, so `markupOnly` blanks both while keeping the tags — which is what lets
 * `openTags` be a regex rather than a second HTML parser, and keeps `<script src=… integrity=…>` in
 * front of the check that needs to see it.
 */

/**
 * Blank comments (and, unless `keepStrings`, string, template and regex literals), preserving length.
 *
 * Offsets and newlines survive, so `find` results can be reported against the original text.
 */
function blank(src, keepStrings) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  // Template literals nest: a `${ … }` interpolation is code inside template text, and a template
  // inside that interpolation is template text again. The stack is exactly that nesting.
  const stack = [];
  // The last significant character and identifier in *code* context. Only the regex/division
  // decision needs them (see `regexAllowed`); everywhere else the blanker is context-free.
  let lastSig = '';
  let lastWord = '';
  const blankAt = (k) => {
    if (k < n && out[k] !== '\n') out[k] = ' ';
  };
  const saw = (ch) => {
    lastSig = ch;
    lastWord = /[A-Za-z0-9_$]/.test(ch) ? lastWord + ch : '';
  };
  const afterLiteral = () => {
    // A literal is a value: the next `/` is division, not a regex.
    lastSig = ')';
    lastWord = '';
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    const top = stack[stack.length - 1];

    if (top && top.type === 'template') {
      if (c === '\\') {
        blankAt(i);
        blankAt(i + 1);
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        blankAt(i);
        i++;
        afterLiteral();
        continue;
      }
      if (c === '$' && c2 === '{') {
        blankAt(i);
        stack.push({ type: 'interp', depth: 0 });
        i++;
        lastSig = '{';
        lastWord = '';
        continue;
      }
      if (!keepStrings) blankAt(i);
      i++;
      continue;
    }

    // Code — at top level, or inside a `${ }`.
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') blankAt(i++);
      continue;
    }
    if (c === '/' && c2 === '*') {
      blankAt(i);
      blankAt(i + 1);
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blankAt(i++);
      blankAt(i);
      blankAt(i + 1);
      i += 2;
      continue;
    }
    if (c === '/' && regexAllowed(lastSig, lastWord)) {
      // A regex literal. `[...]` is a character class, where `/` does not close the literal.
      if (!keepStrings) blankAt(i);
      i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          if (!keepStrings) {
            blankAt(i);
            blankAt(i + 1);
          }
          i += 2;
          continue;
        }
        if (ch === '\n') break; // unterminated: it was a division after all. Do not swallow the file.
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        if (ch === '/' && !inClass) {
          if (!keepStrings) blankAt(i);
          i++;
          closed = true;
          break;
        }
        if (!keepStrings) blankAt(i);
        i++;
      }
      if (closed) {
        while (i < n && /[a-z]/i.test(src[i])) {
          if (!keepStrings) blankAt(i);
          i++;
        }
        afterLiteral();
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      if (!keepStrings) blankAt(i);
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          if (!keepStrings) {
            blankAt(i);
            blankAt(i + 1);
          }
          i += 2;
          continue;
        }
        if (src[i] === quote || src[i] === '\n') {
          if (!keepStrings) blankAt(i);
          i++;
          break;
        }
        if (!keepStrings) blankAt(i);
        i++;
      }
      afterLiteral();
      continue;
    }
    if (c === '`') {
      blankAt(i);
      stack.push({ type: 'template' });
      i++;
      continue;
    }
    if (top && top.type === 'interp') {
      if (c === '{') {
        top.depth++;
        saw(c);
        i++;
        continue;
      }
      if (c === '}') {
        if (top.depth === 0) {
          stack.pop();
          blankAt(i);
          saw(')');
        } else {
          top.depth--;
          saw(c);
        }
        i++;
        continue;
      }
    }
    if (!/\s/.test(c)) saw(c);
    i++;
  }
  return out.join('');
}

/** Keywords after which a `/` opens a regex rather than meaning division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Decide whether `/` at this point opens a regex literal.
 *
 * A regex may start where a value may start: after an operator, an opening bracket, a comma, or one
 * of the keywords above. It may not start after an identifier, number, `)` or `]`, which is where a
 * `/` is division.
 */
function regexAllowed(lastSig, lastWord) {
  if (lastSig === '') return true;
  if (REGEX_AFTER_WORD.has(lastWord)) return true;
  return !/[A-Za-z0-9_$)\]]/.test(lastSig);
}

/** Identifiers and operators only: comments and every literal form blanked. */
export function codeOnly(src) {
  return blank(String(src), false);
}

/** Comments blanked, literals kept, so `node['innerHTML']` is still visible. */
export function stripComments(src) {
  return blank(String(src), true);
}

/** The same length as `text`, with every non-newline character replaced by a space. */
function spaces(text) {
  return String(text).replace(/[^\n]/g, ' ');
}

/**
 * HTML markup, with the inert parts blanked: comments, `<script>` bodies and `<style>` bodies.
 *
 * The tags themselves survive — `<script src=… integrity=…>` has to be visible to the SRI and
 * classsic-script checks — but their contents do not, so an `onload` inside a script's *source text*
 * is not mistaken for an inline handler attribute in markup.
 */
export function markupOnly(html) {
  let out = String(html);
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => spaces(m));
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (m, open, body, close) => open + spaces(body) + close);
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, body, close) => open + spaces(body) + close);
  return out;
}

const TAG = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * Parse a tag's attribute text into `{name, value, valueless}` entries.
 *
 * Valueless attributes are kept, not dropped. `hidden`, `defer` and `async` carry their whole meaning
 * in their presence, so a scanner that only matched `name="value"` would report a `<noscript hidden>`
 * as an unadorned `<noscript>` — the exact mistake `shell.noscript` exists to catch. Such an entry
 * gets `value: ''` and `valueless: true`, so a caller comparing values sees the empty string rather
 * than `undefined`.
 */
export function parseAttrs(text) {
  const out = [];
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(text)) !== null) {
    const set = m[2] !== undefined || m[3] !== undefined || m[4] !== undefined;
    out.push({
      name: m[1],
      value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '',
      valueless: !set,
    });
  }
  return out;
}

/** Every open tag in the markup, as `{name, attrs, text}` (name lower-cased, attrs parsed). */
export function openTags(html) {
  const markup = markupOnly(html);
  const out = [];
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(markup)) !== null) {
    out.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2]), text: m[0] });
  }
  return out;
}

const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'srcset', 'data', 'action', 'formaction']);

/**
 * Every `src`/`href`-style reference in the markup, as `{tag, name, value}`.
 *
 * Read from the markup with script and style bodies blanked, so a URL written in a string inside the
 * application script is not reported as a reference the document makes.
 */
export function refs(html) {
  const out = [];
  for (const tag of openTags(html)) {
    for (const attr of tag.attrs) {
      if (URL_ATTRS.has(attr.name.toLowerCase())) out.push({ tag: tag.name, name: attr.name.toLowerCase(), value: attr.value });
    }
  }
  return out;
}

/** True for a value that carries its own scheme (`https:`, `data:`, `mailto:`, …) or is a fragment. */
export function isAbsoluteRef(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('#');
}

/** Every external (scheme-carrying) reference, as `{tag, name, value}`. */
export function externalRefs(html) {
  return refs(html).filter((r) => /^[a-z][a-z0-9+.-]*:/i.test(r.value));
}

/** A finding, for a check that accumulates instead of throwing on the first one. */
export function offender(text, index) {
  const at = index < 0 ? 0 : index;
  const line = text.slice(0, at).split('\n').length;
  return { index: at, line, context: text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ') };
}

/** Every match of `pattern` in `text`, as findings. `pattern` must be a global regex. */
export function findings(text, pattern) {
  const out = [];
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    out.push(offender(text, m.index));
    if (m.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return out;
}

const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * The `<script>` elements of a built artifact, as `{attrs, body, index}` — `attrs` the raw text.
 *
 * Sound only because the build refuses to emit a script whose own text contains a tag sequence
 * (`build.mjs`'s `checkScriptTextIsSafe`), so the first `</script` after an opening tag really does
 * close it. `static.test.mjs` asserts that invariant over the artifact before trusting this.
 */
export function scriptBodies(html) {
  const out = [];
  let m;
  SCRIPT_ELEMENT.lastIndex = 0;
  while ((m = SCRIPT_ELEMENT.exec(String(html))) !== null) {
    out.push({ attrs: m[1], body: m[2], index: m.index });
  }
  return out;
}

/** The body of the one executable script — the application, `id="tmv-app"`. */
export function appScript(html) {
  const found = scriptBodies(html).find((s) => /id\s*=\s*["']?tmv-app\b/.test(s.attrs));
  if (!found) throw new Error('the artifact has no <script id="tmv-app">');
  return found.body;
}

const TEST_HOOK_BEGIN = '/* tmv:' + 'test-hook-begin */';
const TEST_HOOK_END = '/* tmv:' + 'test-hook-end */';

/**
 * Remove the fault-injection seam the way `build.mjs` removes it.
 *
 * The sentinels are spelled in two pieces above and the caller's expectations have to be built the
 * same way, or these test files would themselves contain the marker they exist to search for.
 */
export function stripTestHooks(source) {
  let out = String(source);
  for (;;) {
    const start = out.indexOf(TEST_HOOK_BEGIN);
    if (start === -1) return out;
    const end = out.indexOf(TEST_HOOK_END, start);
    if (end === -1) return out;
    out = out.slice(0, start) + out.slice(end + TEST_HOOK_END.length);
  }
}

/** The sentinel pair, for a test that has to look for it. */
export const TEST_HOOK_SENTINELS = Object.freeze({
  begin: TEST_HOOK_BEGIN,
  end: TEST_HOOK_END,
});
