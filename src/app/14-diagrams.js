/**
 * Diagrams (ADR-0010, REQ-VIEW-004, REQ-VIEW-005, REQ-SEC-004).
 *
 * Two shapes reach this module and they have almost nothing in common. OTM stores a diagram as
 * *data* — a canvas with coordinates — so rendering it is arithmetic and SVG construction, with no
 * parser and no third-party code anywhere in the path. TML stores a diagram as *source text* in one
 * of four languages, so rendering it requires an actual renderer: Mermaid from a pinned CDN, or
 * nothing at all for Graphviz and PlantUML, which are shown as the source they are.
 *
 *   | type                 | what happens                                                 |
 *   |----------------------|--------------------------------------------------------------|
 *   | coordinates (OTM)    | native SVG, positioned from the recorded geometry             |
 *   | inline `svg`         | our own parser, then our own sanitizer, then our own builder  |
 *   | `mermaid`            | Mermaid, lazily fetched, then *the same* parser and sanitizer |
 *   | `graphviz`, `plantuml` | source text with a copy action. Not rendered                |
 *   | anything else        | source text. An unrecognised type is never guessed at        |
 *
 * Three things are worth stating plainly, because each is a place where a reasonable-looking
 * implementation would be wrong.
 *
 * **1. Nothing untrusted is handed to a browser parser.** `08-security.md` §6 allows sanitizing an
 * imported SVG, and the obvious way to do that is `DOMParser` plus a walk. That is rejected here: a
 * parser that has already built a document from attacker text has already parsed entities, resolved
 * namespaces and possibly begun loading what the document references. Instead the module carries a
 * *deliberately small* XML scanner that refuses everything it is not certain about — DOCTYPE,
 * processing instructions, CDATA, any entity but the five predefined ones plus numeric escapes,
 * mismatched tags, a second root element. Refusal is always safe, because the fallback is the source
 * text, which is what ADR-0010 says a diagram the user cannot see should degrade to.
 *
 * **2. Mermaid's output goes through the same sanitizer as an imported SVG.** Mermaid is third-party
 * code rendering attacker-controlled text, so its result is not more trustworthy than a model's own
 * `<svg>`. It arrives as a string and is parsed by the same scanner, filtered by the same policy and
 * built by the same builder. That is also why `htmlLabels` is set to `false` rather than left at its
 * default: `htmlLabels: true` makes Mermaid emit `<foreignObject>`, which the sanitizer removes — so
 * the setting that `08-security.md` §6 warns about is the setting that would make the output fail to
 * render at all. V4 is answered elsewhere (see `09-testing.md` §6); the settings are still written
 * explicitly, because a default that has changed twice across releases is not a specification.
 *
 * **3. The policy is an allow-list, not the deny-list §6 tabulates.** ADR-0010 records the cost
 * honestly: "sanitization is a deny-list, and deny-lists in this area have a history of gaps". So the
 * mechanism is an allow-list of elements and attributes, which makes every entry in §6's removal
 * table unreachable by construction rather than by remembering to check for it. The removal table is
 * still carried here verbatim, as `FORBIDDEN_ELEMENTS`, and asserted against the allow-list — so the
 * document's list stays an implemented artefact and not a comment that drifted.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------------------------------
  // 1. Policy
  // ---------------------------------------------------------------------------------------------

  /**
   * `08-security.md` §6's removal table, quoted rather than paraphrased:
   *
   *   "the script, foreignObject and use elements / All `on*` attributes / `href`/`xlink:href` with
   *    `javascript:` or external URLs / the xml-stylesheet processing instruction / a style element
   *    with `@import` / an image with an external URL"
   *
   * (The element names are written without their angle brackets, here and everywhere else in this
   * file, because this file is concatenated into a script element of the built artifact: a literal
   * opening or closing tag in a comment would end the script, and the failure would be a blank page
   * rather than an error. `build.mjs` refuses to build a module that contains one.)
   *
   * Kept as its own list because it is the specification, and because a test asserts every entry is
   * absent from `ALLOWED_ELEMENTS` — which is the property that makes the table true of this code
   * forever, rather than true of whoever last read both.
   *
   * The entries §6 does not name are here for the same reason it names the ones it does. Each is a
   * way to load a resource, run a behaviour, or leave the SVG context:
   *
   *   - `style`, `link`, `meta`, `base`: styling and document-level channels. Removed outright, and
   *     the loss is disclosed rather than hidden — see `presentationDefaults` below.
   *   - `iframe`, `object`, `embed`, `audio`, `video`, `canvas`, `form`, `handler`, `listener`:
   *     HTML-side escape hatches that have no business inside a diagram.
   *   - `animate`, `animateMotion`, `animateTransform`, `set`, `discard`: SMIL can *change an
   *     attribute after sanitization*, which is the one way past a static allow-list. A diagram that
   *     needs animation is not a diagram this application has to display.
   *   - `feImage`: a filter primitive that fetches a URL, so it is `<image>`'s problem again.
   */
  var FORBIDDEN_ELEMENTS = [
    'script', 'foreignObject', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'canvas',
    'handler', 'listener', 'animate', 'animateMotion', 'animateTransform', 'set', 'discard',
    'feImage',
  ];

  /**
   * Everything a diagram may be built out of.
   *
   * Names are compared exactly, case included: `feGaussianBlur` and `linearGradient` are SVG's
   * spellings, and `SCRIPT`, `Script` and `foreignobject` are not, which is why the comparison must
   * not be case-insensitive "for robustness".
   */
  var ALLOWED_ELEMENTS = {
    svg: 1, g: 1, defs: 1, symbol: 1, use: 1, switch: 1, view: 1, a: 1,
    path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1,
    text: 1, tspan: 1, textPath: 1, title: 1, desc: 1,
    marker: 1, pattern: 1, clipPath: 1, mask: 1,
    linearGradient: 1, radialGradient: 1, stop: 1,
    filter: 1, feGaussianBlur: 1, feOffset: 1, feBlend: 1, feColorMatrix: 1, feComposite: 1,
    feFlood: 1, feMerge: 1, feMergeNode: 1, feMorphology: 1, feTurbulence: 1,
    feDisplacementMap: 1, feComponentTransfer: 1, feFuncA: 1, feFuncR: 1, feFuncG: 1, feFuncB: 1,
    image: 1,
  };

  /**
   * Attributes a diagram may carry.
   *
   * Geometry and presentation only. Deliberately absent, and why:
   *
   *   - every `on*` (the whole event surface),
   *   - `style` and `class`: `style-src` is a hash with no `'unsafe-inline'`, so both are already
   *     inert in this document — dropping them makes the sanitized tree say what actually renders,
   *     and stops an imported `class="cds--header"` from matching the application's own stylesheet,
   *   - `role`, `aria-*`, `tabindex`, `focusable`: an untrusted diagram does not get to describe
   *     itself to a screen reader or inject focusable elements into the tab order. The rendered
   *     figure carries the application's own accessible name, taken from the diagram's `name`.
   */
  var ALLOWED_ATTRS = {
    id: 1, href: 1, 'xlink:href': 1,
    x: 1, y: 1, x1: 1, y1: 1, x2: 1, y2: 1, cx: 1, cy: 1, r: 1, rx: 1, ry: 1,
    width: 1, height: 1, d: 1, points: 1, transform: 1, viewBox: 1, preserveAspectRatio: 1,
    version: 1, pathLength: 1, offset: 1, rotate: 1, dx: 1, dy: 1, textLength: 1,
    lengthAdjust: 1, startOffset: 1, method: 1, spacing: 1,
    fill: 1, 'fill-opacity': 1, 'fill-rule': 1, 'fill-rule-clip': 1,
    stroke: 1, 'stroke-width': 1, 'stroke-opacity': 1, 'stroke-linecap': 1, 'stroke-linejoin': 1,
    'stroke-dasharray': 1, 'stroke-dashoffset': 1, 'stroke-miterlimit': 1,
    opacity: 1, color: 1, display: 1, visibility: 1, overflow: 1, 'paint-order': 1,
    'font-family': 1, 'font-size': 1, 'font-size-adjust': 1, 'font-style': 1, 'font-weight': 1,
    'font-variant': 1, 'letter-spacing': 1, 'word-spacing': 1, 'text-anchor': 1,
    'text-decoration': 1, 'dominant-baseline': 1, 'alignment-baseline': 1, 'baseline-shift': 1,
    direction: 1, 'writing-mode': 1, kerning: 1, 'unicode-bidi': 1,
    'stop-color': 1, 'stop-opacity': 1, gradientUnits: 1, gradientTransform: 1, spreadMethod: 1,
    patternUnits: 1, patternContentUnits: 1, patternTransform: 1,
    clipPathUnits: 1, maskUnits: 1, maskContentUnits: 1, filterUnits: 1, primitiveUnits: 1,
    markerWidth: 1, markerHeight: 1, markerUnits: 1, refX: 1, refY: 1, orient: 1,
    'marker-start': 1, 'marker-mid': 1, 'marker-end': 1,
    'color-interpolation': 1, 'color-interpolation-filters': 1,
    'shape-rendering': 1, 'text-rendering': 1, 'image-rendering': 1,
    'pointer-events': 1, 'enable-background': 1, lang: 1, 'xml:space': 1,
    type: 1, result: 1, in: 1, in2: 1, mode: 1, values: 1, operator: 1, k1: 1, k2: 1, k3: 1, k4: 1,
    stdDeviation: 1, baseFrequency: 1, numOctaves: 1, seed: 1, scale: 1, bias: 1, order: 1,
    radius: 1, targetX: 1, targetY: 1, slope: 1, amplitude: 1, exponent: 1, intercept: 1,
    tableValues: 1, 'diffuseConstant': 1, 'surfaceScale': 1, 'specularConstant': 1,
    'specularExponent': 1, 'xChannelSelector': 1, 'yChannelSelector': 1, requiredExtensions: 1,
    requiredFeatures: 1, systemLanguage: 1, refX1: 1,
  };

  /** Shapes that get the fallback outline when a diagram's own styling has been removed. */
  var SHAPE_ELEMENTS = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1 };
  var TEXT_ELEMENTS = { text: 1, tspan: 1, textPath: 1 };

  /**
   * Refuse a diagram above `LIMITS.diagramSourceRefuseBytes` rather than trying to render it.
   *
   * `08-security.md` §5 sets the guard and names the fallback: "refuse to render beyond a fixed size;
   * offer source text instead". Refusing *after* a parse would spend the memory the guard exists to
   * protect, so this is checked before anything else touches the string.
   */
  var PARSE_LIMITS = { depth: 24, nodes: 20000, nameLen: 128, attrValueLen: 16384 };

  var NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
  var NUMERIC_ENTITY_RE = /^#(?:[0-9]+|[xX][0-9a-fA-F]+)$/;
  var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  /** `url(...)` in a presentation attribute: the only way one names another resource. */
  var URL_FUNC_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

  var FAIL = { parse: 'failed' };

  // ---------------------------------------------------------------------------------------------
  // 2. A very small XML scanner
  // ---------------------------------------------------------------------------------------------

  function decodeEntity(body) {
    if (core.has(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    if (!NUMERIC_ENTITY_RE.test(body)) return null;
    var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
    var code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!isFinite(code) || code > 0x10ffff) return null;
    // The surrogate range is not a character, and decoding it would produce a lone half of a pair
    // that then travels through the whole pipeline looking like text.
    if (code >= 0xd800 && code <= 0xdfff) return null;
    // C0 controls other than tab, LF and CR are not characters XML allows to be written this way.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
    if (code === 0xfffe || code === 0xffff) return null;
    return String.fromCodePoint(code);
  }

  /**
   * Decode every entity in `raw`, or return null if any of them is one we do not know.
   *
   * Returning null rather than leaving the text alone is the point: a document that references an
   * entity we cannot resolve is a document that meant something we cannot see, and guessing at its
   * text is how a sanitizer ends up disagreeing with a browser about what a string says.
   */
  function decodeEntities(raw) {
    var out = '';
    var i = 0;
    while (i < raw.length) {
      var amp = raw.indexOf('&', i);
      if (amp === -1) {
        out += raw.slice(i);
        break;
      }
      out += raw.slice(i, amp);
      var semi = raw.indexOf(';', amp);
      if (semi === -1 || semi - amp > 32) return null;
      var decoded = decodeEntity(raw.slice(amp + 1, semi));
      if (decoded === null) return null;
      out += decoded;
      i = semi + 1;
    }
    return out;
  }

  /**
   * Parse a subset of XML into `{tag, attrs, children, text}` records, or null.
   *
   * What it accepts: elements, attributes with quoted values, comments, the five predefined entities,
   * numeric character references, self-closing tags, and `svg:`-style prefixes on names (kept, and
   * resolved by the sanitizer). What it refuses, all of it by returning null: a DOCTYPE, any other
   * `<!` declaration, a processing instruction, CDATA, any unknown entity, an unquoted or valueless
   * attribute, a duplicate attribute, a mismatched or unclosed tag, a second root element, non-space
   * text outside the root, and anything past the depth and node limits in `PARSE_LIMITS`.
   *
   * Refusing is never a failure of the application: the caller shows the source instead.
   */
  function parseXml(text) {
    if (!core.isString(text) || text === '') return null;
    var i = 0;
    var n = text.length;
    var stack = [];
    var root = null;
    var rootClosed = false;
    var count = 0;

    function fail() { throw FAIL; }

    function skipWs() {
      while (i < n) {
        var c = text.charAt(i);
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
        else return;
      }
    }

    function readName() {
      var start = i;
      while (i < n && /[A-Za-z0-9_.:-]/.test(text.charAt(i))) i++;
      if (i === start || i - start > PARSE_LIMITS.nameLen) fail();
      var name = text.slice(start, i);
      if (!NAME_RE.test(name)) fail();
      return name;
    }

    function readAttrs() {
      var attrs = Object.create(null);
      for (;;) {
        skipWs();
        if (i >= n) fail();
        var c = text.charAt(i);
        if (c === '>' || c === '/') return attrs;
        var name = readName();
        skipWs();
        if (text.charAt(i) !== '=') fail();
        i++;
        skipWs();
        var quote = text.charAt(i);
        if (quote !== '"' && quote !== "'") fail();
        i++;
        var start = i;
        while (i < n && text.charAt(i) !== quote) {
          if (text.charAt(i) === '<') fail();
          i++;
        }
        if (i >= n) fail();
        if (i - start > PARSE_LIMITS.attrValueLen) fail();
        var value = decodeEntities(text.slice(start, i));
        if (value === null) fail();
        i++;
        if (core.has(attrs, name)) fail();
        attrs[name] = value;
      }
    }

    function readText() {
      var start = i;
      while (i < n && text.charAt(i) !== '<') i++;
      var decoded = decodeEntities(text.slice(start, i));
      if (decoded === null) fail();
      return decoded;
    }

    try {
      while (i < n) {
        if (text.charAt(i) !== '<') {
          var run = readText();
          if (run !== '') {
            if (stack.length === 0) {
              if (run.trim() !== '') fail();
            } else {
              stack[stack.length - 1].text += run;
            }
          }
          continue;
        }
        if (text.startsWith('<!--', i)) {
          var end = text.indexOf('-->', i + 4);
          if (end === -1) fail();
          i = end + 3;
          continue;
        }
        if (text.startsWith('</', i)) {
          i += 2;
          var closing = readName();
          skipWs();
          if (text.charAt(i) !== '>') fail();
          i++;
          var open = stack.pop();
          if (!open || open.tag !== closing) fail();
          if (stack.length === 0) rootClosed = true;
          continue;
        }
        // `<!DOCTYPE`, `<!ENTITY`, `<!ATTLIST`, CDATA sections and processing instructions all land
        // here. None of them has a use in a diagram, and every one of them is a parser-complexity or
        // entity-expansion surface, so the scanner declines the whole document.
        if (text.startsWith('<!', i) || text.startsWith('<?', i)) fail();

        i++;
        var tag = readName();
        var attrs = readAttrs();
        var selfClosing = false;
        if (text.charAt(i) === '/') { selfClosing = true; i++; }
        if (text.charAt(i) !== '>') fail();
        i++;

        count++;
        if (count > PARSE_LIMITS.nodes) fail();
        var node = {
          tag: tag,
          attrs: attrs,
          children: [],
          text: '',
          parent: stack.length ? stack[stack.length - 1] : null,
        };
        if (node.parent) node.parent.children.push(node);
        else if (root === null && !rootClosed) root = node;
        else fail();

        if (selfClosing) {
          if (stack.length === 0) rootClosed = true;
        } else {
          if (stack.length + 1 > PARSE_LIMITS.depth) fail();
          stack.push(node);
        }
      }
      if (root === null || stack.length !== 0) return null;
      return root;
    } catch (e) {
      if (e === FAIL) return null;
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Sanitization
  // ---------------------------------------------------------------------------------------------

  /** `svg:rect` → `rect`; any other prefix, or none, is returned as written. */
  function localName(tag) {
    var colon = tag.indexOf(':');
    if (colon === -1) return tag;
    return tag.slice(0, colon) === 'svg' ? tag.slice(colon + 1) : tag;
  }

  function attrName(name) {
    var colon = name.indexOf(':');
    if (colon === -1) return name;
    var prefix = name.slice(0, colon);
    if (prefix !== 'xlink' && prefix !== 'xml') return null;
    return name;
  }

  /** True when the value is a reference to something inside this same diagram. */
  function internalRef(value) {
    var v = core.isString(value) ? value.trim() : '';
    return v.charAt(0) === '#' && v.length > 1;
  }

  /** A `data:` image the policy permits (`img-src data: blob:`), or null. */
  function dataImage(value) {
    if (!core.isString(value)) return null;
    var v = value.trim();
    return /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(v) ? v : null;
  }

  /**
   * Rewrite every `url(#x)` in a value, given the id map. Returns null if any of them is not
   * internal, which makes the caller drop the attribute rather than keep a reference we cannot
   * reason about.
   */
  function rewriteUrlFuncs(value, ids) {
    var out = '';
    var last = 0;
    var m;
    URL_FUNC_RE.lastIndex = 0;
    while ((m = URL_FUNC_RE.exec(value)) !== null) {
      var target = m[2].trim();
      if (!internalRef(target)) return null;
      var key = target.slice(1);
      if (!core.has(ids, key)) return null;
      out += value.slice(last, m.index) + 'url(#' + ids[key] + ')';
      last = m.index + m[0].length;
    }
    return last === 0 ? value : out + value.slice(last);
  }

  /**
   * Every `id` in the tree, mapped to a diagram-unique replacement.
   *
   * The prefix is not tidiness. An imported `<rect id="tmv-live">` would otherwise *be* the element
   * `core.byId('tmv-live')` returns, so a hostile diagram could take over the application's
   * announcement region, or any other element the app looks up by id. Renaming every imported id —
   * and rewriting the `url(#…)` and `href="#…"` references that point at them — removes the
   * collision instead of documenting it. Ids that are duplicated inside one diagram are collapsed
   * onto a single replacement, which is also what a browser resolves a repeated id to (the first).
   */
  function idMapFor(root, prefix) {
    var ids = Object.create(null);
    var next = 0;
    (function walk(node) {
      if (core.isString(node.attrs.id) && node.attrs.id !== '') {
        if (!core.has(ids, node.attrs.id)) {
          next++;
          ids[node.attrs.id] = prefix + next;
        }
      }
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    })(root);
    return ids;
  }

  /**
   * Filter one element's attributes in place.
   *
   * Separate from the element walk because the root needs exactly the same treatment as any other
   * element, and giving it a special case is how a `viewBox` gets dropped by accident — which would
   * not fail loudly, it would silently reinterpret every coordinate in the diagram as a pixel.
   *
   * No `on*` check appears here, and the absence is deliberate rather than an oversight: no
   * event-handler attribute name is on `ALLOWED_ATTRS`, so the allow-list is the whole rule. A
   * second check that could never fire would read as though the first one were insufficient, which
   * is the misleading kind of redundant.
   */
  function filterAttrs(node, name, ids, prefix, counters) {
    var attrs = Object.create(null);
    var names = Object.keys(node.attrs);
    for (var j = 0; j < names.length; j++) {
      var raw = names[j];
      var plain = attrName(raw);
      if (plain === null || !core.has(ALLOWED_ATTRS, plain)) {
        // `style` and `class` are counted separately from the rest, because losing them is not the
        // same kind of loss: it is the difference between a diagram that looks like itself and one
        // that would render as a solid black rectangle, and the caller has to be able to say so.
        if (plain === 'style' || plain === 'class') counters.styled++;
        else if (plain !== null) counters.attrs++;
        continue;
      }
      var value = node.attrs[raw];
      var normalised = plain === 'xlink:href' ? 'href' : plain;

      if (normalised === 'href') {
        if (name === 'image') {
          var data = dataImage(value);
          if (!data) { counters.refs++; continue; }
          attrs.href = data;
        } else if (internalRef(value)) {
          var target = value.trim().slice(1);
          if (!core.has(ids, target)) { counters.refs++; continue; }
          attrs.href = '#' + ids[target];
        } else {
          // An external, `javascript:` or `data:` href on anything but an image. §6 names the first
          // two; the third is refused for the same reason.
          counters.refs++;
        }
        continue;
      }

      if (value.indexOf('url(') !== -1) {
        var rewritten = rewriteUrlFuncs(value, ids);
        if (rewritten === null) { counters.refs++; continue; }
        attrs[normalised] = rewritten;
        continue;
      }

      if (normalised === 'id') {
        attrs.id = core.has(ids, value) ? ids[value] : prefix + 'u' + (++counters.renamed);
        continue;
      }

      attrs[normalised] = value;
    }
    node.attrs = attrs;
  }

  /**
   * Sanitize a parsed tree in place, returning the tree, or null if it is not an `svg` document.
   *
   * The counters accumulate what was removed so the caller can say so. A sanitizer that silently
   * deletes half a diagram and then reports success is worse than one that fails, because the user
   * sees a picture and believes it — and the fallback here is always available, since the source
   * text is right there.
   */
  function sanitizeTree(root, opts) {
    var options = opts || {};
    var counters = { elements: 0, attrs: 0, styled: 0, styleElements: 0, refs: 0, renamed: 0 };
    if (!root || localName(root.tag) !== 'svg') return null;

    var prefix = options.idPrefix || 'tmvs-';
    var ids = idMapFor(root, prefix);

    (function filter(node) {
      var kept = [];
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        var name = localName(child.tag);
        var colon = child.tag.indexOf(':');
        var foreignPrefix = colon !== -1 && name === child.tag;

        // Checked before the allow-list because `style` is not on it: the counters are what let the
        // caller say that a diagram's own styling was removed rather than silently show it unstyled.
        if (name === 'style') {
          counters.styleElements++;
          continue;
        }
        if (foreignPrefix) {
          // `svg:` is the one prefix accepted (`localName` resolved it); anything else means a
          // namespace this policy says nothing about, and an unknown namespace is a refusal.
          counters.elements++;
          continue;
        }
        if (!core.has(ALLOWED_ELEMENTS, name)) {
          // Dropped with its subtree rather than unwrapped: an unknown element is unknown, and
          // promoting its children into the parent's context is a guess about what it meant.
          counters.elements++;
          continue;
        }
        if (name === 'image' && !dataImage(child.attrs.href || child.attrs['xlink:href'])) {
          // §6: "`<image>` with an external URL" removed. An image with nothing left to show is
          // removed rather than kept as an empty box.
          counters.elements++;
          continue;
        }
        if (name === 'use' && !internalRef(child.attrs.href || child.attrs['xlink:href'])) {
          counters.elements++;
          continue;
        }

        child.tag = name;
        filterAttrs(child, name, ids, prefix, counters);
        filter(child);
        kept.push(child);
      }
      node.children = kept;
    })(root);

    // The root goes through the same filter as everything else, which is what keeps its `viewBox`,
    // `width`, `height` and `preserveAspectRatio`: those are the diagram's coordinate system, and
    // dropping them would not fail loudly — it would silently reinterpret every coordinate in the
    // document as a pixel.
    root.tag = 'svg';
    filterAttrs(root, 'svg', ids, prefix, counters);
    root.presentationLost = counters.styled > 0 || counters.styleElements > 0;
    root.removed = counters;
    return root;
  }

  /**
   * Give a diagram presentation back when its own was removed.
   *
   * `style` elements and `style` attributes are removed — the first outright, the second because
   * `style-src` is a hash with no `'unsafe-inline'` and they are therefore inert in this document
   * whether we remove them or not. The consequence is not aesthetic. Mermaid emits `<rect>` and
   * `<text>` with no paint attributes at all, because its `<style>` block was going to supply them;
   * remove that block and every label is default-black text on a default-black fill. A diagram that
   * renders as a solid black rectangle is not a rendering.
   *
   * So the fallback is applied *only* when something was actually removed (reported by the sanitizer
   * as `presentationLost`), and only to elements that do not already say how they should look. A
   * diagram that carries its own `fill`/`stroke` attributes is left exactly as authored.
   */
  function presentationDefaults(root) {
    (function walk(node) {
      var name = localName(node.tag);
      if (core.isString(node.attrs.fill) || core.isString(node.attrs.stroke)) return;
      if (core.has(SHAPE_ELEMENTS, name)) {
        node.attrs.fill = 'none';
        node.attrs.stroke = 'currentColor';
        node.attrs['stroke-width'] = '1.5';
      } else if (core.has(TEXT_ELEMENTS, name)) {
        node.attrs.fill = 'currentColor';
        node.attrs.stroke = 'none';
      }
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    })(root);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Building the live SVG
  // ---------------------------------------------------------------------------------------------

  function svgNode(doc, tag, attrs, children) {
    var node = doc.createElementNS(SVG_NS, tag);
    if (attrs) {
      var names = Object.keys(attrs);
      for (var i = 0; i < names.length; i++) {
        var v = attrs[names[i]];
        if (v === null || v === undefined || v === false) continue;
        node.setAttribute(names[i], String(v));
      }
    }
    if (children) {
      for (var j = 0; j < children.length; j++) if (children[j]) node.appendChild(children[j]);
    }
    return node;
  }

  /** Turn a sanitized tree into live SVG nodes. Every leaf enters as a text node, never as markup. */
  function buildSvg(doc, tree) {
    var node = doc.createElementNS(SVG_NS, tree.tag);
    var names = Object.keys(tree.attrs);
    for (var i = 0; i < names.length; i++) node.setAttribute(names[i], String(tree.attrs[names[i]]));
    if (tree.text) node.appendChild(doc.createTextNode(tree.text));
    for (var j = 0; j < tree.children.length; j++) node.appendChild(buildSvg(doc, tree.children[j]));
    return node;
  }

  /**
   * Parse, sanitize and build an SVG string. Returns `{element, removed}` or `{error}`.
   *
   * Used for both an imported `<svg>` diagram and for Mermaid's output, which is the point: Mermaid
   * is third-party code rendering text a model supplied, so its result gets no more trust than the
   * model's own markup.
   */
  function sanitizeSvg(text, doc, opts) {
    if (!doc || !doc.createElementNS) return { error: 'no-document' };
    if (!core.isString(text) || text.trim() === '') return { error: 'empty' };
    if (core.utf8Length(text) > TMV.LIMITS.diagramSourceRefuseBytes) return { error: 'too-large' };
    var parsed = parseXml(text);
    if (!parsed) return { error: 'unparseable' };
    var options = opts || {};
    var tree = sanitizeTree(parsed, {
      idPrefix: options.idPrefix || ('tmvs-' + core.uuid().slice(0, 8) + '-'),
    });
    if (!tree) return { error: 'not-svg' };
    if (tree.presentationLost) presentationDefaults(tree);
    return { element: buildSvg(doc, tree), removed: tree.removed };
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Coordinate diagrams (REQ-VIEW-004)
  // ---------------------------------------------------------------------------------------------

  var PADDING = 24;
  var MIN_CANVAS = 240;
  var MAX_ZONE_DEPTH = 8;

  function num(value) {
    return core.isNumber(value) && isFinite(value) ? value : null;
  }

  /**
   * How deep a trust zone nests, following `parentId`.
   *
   * Bounded, because `parentId` is model data and model data can contain a cycle — a zone that is its
   * own ancestor would otherwise be an infinite loop in a render path, which is the worst place to
   * find one.
   */
  function zoneDepth(zone, index, depth) {
    var seen = Object.create(null);
    var current = zone;
    var d = depth || 0;
    while (current && d < MAX_ZONE_DEPTH) {
      if (core.has(seen, current.id)) return MAX_ZONE_DEPTH;
      seen[current.id] = true;
      var parentId = current.parentId || current.trustZoneId;
      if (!core.isString(parentId)) break;
      var parent = index.trustZones[parentId];
      if (!parent) break;
      current = parent;
      d++;
    }
    return d;
  }

  /** Which zone a node's owner sits in, if that zone is itself drawn on this canvas. */
  function zoneOf(entity, placedZones) {
    var zoneId = entity.parentId || entity.trustZoneId;
    return core.isString(zoneId) && core.has(placedZones, zoneId) ? zoneId : null;
  }

  /**
   * Lay out a coordinate representation. Pure: it reads the model and returns a plan, which is what
   * makes "render as authored" checkable without a browser.
   *
   * Elements are drawn where their coordinates say, not where their `parentId` would put them —
   * ADR-0010's "diagrams are rendered as authored, with no auto-layout" cuts both ways, and a model
   * whose coordinates disagree with its zone membership looks wrong here because it *is* wrong.
   * Membership is still used, for grouping: a zone's `<g>` contains its components, which is what
   * REQ-VIEW-004's "contained components inside them" asks for and also what gives the drawing its
   * z-order.
   */
  function layout(model, representationId) {
    var index = TMV.model.index(model);
    var representation = core.isString(representationId)
      ? index.representations[representationId] || null
      : null;
    var plan = {
      representation: representation,
      width: MIN_CANVAS,
      height: MIN_CANVAS,
      zones: [],
      nodes: [],
      edges: [],
      unplaced: [],
    };
    if (!representation) return plan;

    var elements = [];
    var all = TMV.model.collection(model, 'representationElements');
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].representationId === representation.id) elements.push(all[i]);
    }

    var placed = Object.create(null);
    var rawZones = [];
    for (var j = 0; j < elements.length; j++) {
      var element = elements[j];
      // Geometry is read from the nested `position`/`size` the canonical model uses
      // (`03-data-model.md` §4.15 writes them flat; `05-model.js`'s registry explains why the canonical
      // form nests them, and `08-otm.js` maps OTM's own nested wire shape straight through). Reading a
      // flat `element.x` here would not fail loudly — it would silently find the passthrough bag, which
      // lives at the property `x` on every entity, and report every element as unplaced.
      var position = core.isObject(element.position) ? element.position : null;
      var size = core.isObject(element.size) ? element.size : null;
      var x = position ? num(position.x) : null;
      var y = position ? num(position.y) : null;
      var w = size ? num(size.width) : null;
      var h = size ? num(size.height) : null;
      var owner = element.ownerType === 'trustZone'
        ? index.trustZones[element.ownerId]
        : index.components[element.ownerId];
      if (!owner) {
        // A dangling `ownerId` — an import warning, not an error (REQ-IMP-004). It is listed rather
        // than drawn at the origin, because drawing it at 0,0 would state a coordinate the model
        // never claimed.
        plan.unplaced.push({
          id: element.id,
          name: core.isString(element.ownerId) ? element.ownerId : element.id,
          reason: 'the element refers to ' + (element.ownerType || 'an entity') + ' that is not in this model',
        });
        continue;
      }
      if (x === null || y === null) {
        plan.unplaced.push({
          id: element.id,
          name: TMV.model.labelOf(owner),
          reason: 'the element has no recorded position',
        });
        continue;
      }
      var box = {
        id: owner.id,
        elementId: element.id,
        name: TMV.model.labelOf(owner),
        x: x,
        y: y,
        w: w === null || w <= 0 ? 120 : w,
        h: h === null || h <= 0 ? 60 : h,
      };
      placed[owner.id] = box;
      if (element.ownerType === 'trustZone') rawZones.push(box);
      else {
        box.kind = element.ownerType || 'component';
        plan.nodes.push(box);
      }
    }

    for (var k = 0; k < rawZones.length; k++) {
      var zone = rawZones[k];
      zone.depth = zoneDepth(index.trustZones[zone.id] || {}, index, 0);
      zone.zoneId = zoneOf(index.trustZones[zone.id] || {}, placed);
      plan.zones.push(zone);
    }
    plan.zones.sort(function (a, b) { return a.depth - b.depth; });
    for (var m = 0; m < plan.nodes.length; m++) {
      var entity = elementOwner(index, plan.nodes[m]);
      plan.nodes[m].zoneId = entity ? zoneOf(entity, placed) : null;
    }

    // Edges: a flow joins two placed entities. A flow to something that is not on this canvas is
    // left out of the drawing rather than routed to nowhere, and counted for the caller to mention.
    var flows = TMV.model.collection(model, 'dataFlows');
    var missing = 0;
    for (var f = 0; f < flows.length; f++) {
      var flow = flows[f];
      if (!flow) continue;
      var from = placed[flow.sourceId];
      var to = placed[flow.destinationId];
      if (!from || !to || from === to) {
        if (from || to) missing++;
        continue;
      }
      var ends = edgeEnds(from, to);
      plan.edges.push({
        id: flow.id,
        name: TMV.model.labelOf(flow),
        sourceId: flow.sourceId,
        destinationId: flow.destinationId,
        bidirectional: flow.bidirectional === true,
        encrypted: flow.encrypted === true,
        x1: ends.x1, y1: ends.y1, x2: ends.x2, y2: ends.y2,
      });
    }
    plan.flowsOffCanvas = missing;

    // Canvas: the recorded size when the model gives one, extended when the geometry runs past it.
    // The recorded size wins when it is larger, because it is what the author drew on.
    var right = num(representation.width) || 0;
    var bottom = num(representation.height) || 0;
    var boxes = plan.zones.concat(plan.nodes);
    for (var b = 0; b < boxes.length; b++) {
      right = Math.max(right, boxes[b].x + boxes[b].w);
      bottom = Math.max(bottom, boxes[b].y + boxes[b].h);
    }
    plan.width = Math.max(MIN_CANVAS, right + PADDING);
    plan.height = Math.max(MIN_CANVAS, bottom + PADDING);
    plan.empty = plan.zones.length === 0 && plan.nodes.length === 0;
    return plan;
  }

  function elementOwner(index, box) {
    return index.components[box.id] || index.actors[box.id] || index.dataStores[box.id] || null;
  }

  /**
   * Where an edge meets the border of each box, on the line between their centres.
   *
   * Centre-to-centre clipped at the box edge rather than a routed path: routing is layout, and
   * ADR-0010 puts layout out of scope for v1. Clipping is not layout — it is the difference between
   * an arrow that points at a component and one that disappears underneath it.
   */
  function edgeEnds(from, to, inset) {
    var gap = inset === undefined ? 6 : inset;
    var ax = from.x + from.w / 2;
    var ay = from.y + from.h / 2;
    var bx = to.x + to.w / 2;
    var by = to.y + to.h / 2;
    var dx = bx - ax;
    var dy = by - ay;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return { x1: ax, y1: ay, x2: bx, y2: by };
    var ux = dx / len;
    var uy = dy / len;
    var start = clip(ax, ay, ux, uy, from) + gap;
    var end = len - clip(bx, by, -ux, -uy, to) - gap;
    if (end <= start) {
      // Boxes overlap or touch. Draw the shortest edge we can rather than a reversed one.
      start = Math.max(0, Math.min(start, len / 2 - 1));
      end = Math.min(len, Math.max(end, len / 2 + 1));
    }
    return {
      x1: ax + ux * start,
      y1: ay + uy * start,
      x2: ax + ux * end,
      y2: ay + uy * end,
    };
  }

  /** Distance from a box's centre to its edge along a unit direction. */
  function clip(cx, cy, ux, uy, box) {
    var hw = box.w / 2;
    var hh = box.h / 2;
    var tx = ux === 0 ? Infinity : hw / Math.abs(ux);
    var ty = uy === 0 ? Infinity : hh / Math.abs(uy);
    return Math.min(tx, ty);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Drawing
  // ---------------------------------------------------------------------------------------------

  function truncateLabel(name, box) {
    var perChar = 7.4;
    var room = Math.max(4, Math.floor((box.w - 12) / perChar));
    return core.truncate(core.oneLine(name), room);
  }

  function drawLayout(plan, doc, opts) {
    var options = opts || {};
    var prefix = options.idPrefix || ('tmvd-' + core.uuid().slice(0, 8) + '-');
    var markerEnd = prefix + 'arrow';
    var markerStart = prefix + 'arrow-rev';

    var defs = svgNode(doc, 'defs', null, [
      marker(doc, markerEnd, 'auto'),
      marker(doc, markerStart, 'auto-start-reverse'),
    ]);

    var zoneGroups = Object.create(null);
    var zonesRoot = svgNode(doc, 'g', { class: 'tmv-diagram__zones' });
    var looseRoot = svgNode(doc, 'g', { class: 'tmv-diagram__nodes tmv-diagram__nodes--loose' });

    for (var i = 0; i < plan.zones.length; i++) {
      var zone = plan.zones[i];
      var group = svgNode(doc, 'g', { class: 'tmv-diagram__zone' });
      group.setAttribute('data-zone-id', zone.id);
      group.appendChild(svgNode(doc, 'rect', {
        class: 'tmv-diagram__zone-box',
        x: zone.x, y: zone.y, width: zone.w, height: zone.h,
      }));
      var zoneLabel = svgNode(doc, 'text', {
        class: 'tmv-diagram__zone-label',
        x: zone.x + 8, y: zone.y + 18,
      }, [doc.createTextNode(truncateLabel(zone.name, zone))]);
      group.appendChild(zoneLabel);
      group.appendChild(svgNode(doc, 'title', null, [doc.createTextNode(zone.name)]));
      var nodes = svgNode(doc, 'g', { class: 'tmv-diagram__zone-nodes' });
      group.appendChild(nodes);
      zoneGroups[zone.id] = { group: group, nodes: nodes };
      if (zone.zoneId && core.has(zoneGroups, zone.zoneId)) zoneGroups[zone.zoneId].nodes.appendChild(group);
      else zonesRoot.appendChild(group);
    }

    for (var j = 0; j < plan.nodes.length; j++) {
      var node = plan.nodes[j];
      var parent = node.zoneId && core.has(zoneGroups, node.zoneId) ? zoneGroups[node.zoneId].nodes : looseRoot;
      var nodeGroup = svgNode(doc, 'g', { class: 'tmv-diagram__node' });
      nodeGroup.setAttribute('data-node-id', node.id);
      nodeGroup.setAttribute('data-node-kind', node.kind);
      nodeGroup.appendChild(svgNode(doc, 'rect', {
        class: 'tmv-diagram__node-box',
        x: node.x, y: node.y, width: node.w, height: node.h,
        rx: 2,
      }));
      nodeGroup.appendChild(svgNode(doc, 'text', {
        class: 'tmv-diagram__node-label',
        x: node.x + node.w / 2, y: node.y + node.h / 2 + 4,
        'text-anchor': 'middle',
      }, [doc.createTextNode(truncateLabel(node.name, node))]));
      nodeGroup.appendChild(svgNode(doc, 'title', null, [doc.createTextNode(node.name)]));
      parent.appendChild(nodeGroup);
    }

    var edgesRoot = svgNode(doc, 'g', { class: 'tmv-diagram__edges' });
    for (var k = 0; k < plan.edges.length; k++) {
      var edge = plan.edges[k];
      var attrs = {
        class: 'tmv-diagram__edge' + (edge.encrypted ? ' tmv-diagram__edge--encrypted' : ''),
        x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2,
        'marker-end': 'url(#' + markerEnd + ')',
      };
      if (edge.bidirectional) attrs['marker-start'] = 'url(#' + markerStart + ')';
      var line = svgNode(doc, 'line', attrs);
      line.setAttribute('data-flow-id', edge.id);
      edgesRoot.appendChild(line);
      if (edge.name && edge.name !== 'Untitled') {
        var midX = (edge.x1 + edge.x2) / 2;
        var midY = (edge.y1 + edge.y2) / 2;
        edgesRoot.appendChild(svgNode(doc, 'text', {
          class: 'tmv-diagram__edge-label',
          x: midX, y: midY - 4, 'text-anchor': 'middle', 'paint-order': 'stroke',
        }, [doc.createTextNode(core.truncate(core.oneLine(edge.name), 28))]));
      }
    }

    var svg = svgNode(doc, 'svg', {
      class: 'tmv-diagram__svg',
      xmlns: SVG_NS,
      viewBox: '0 0 ' + Math.round(plan.width) + ' ' + Math.round(plan.height),
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': options.label || 'Diagram',
    }, [defs, zonesRoot, looseRoot, edgesRoot]);
    return svg;
  }

  function marker(doc, id, orient) {
    return svgNode(doc, 'marker', {
      id: id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: orient || 'auto',
      markerUnits: 'strokeWidth',
    }, [svgNode(doc, 'path', { class: 'tmv-diagram__arrow', d: 'M 0 0 L 10 5 L 0 10 z' })]);
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The Mermaid loader (REQ-VIEW-005)
  // ---------------------------------------------------------------------------------------------

  var mermaidState = { status: 'idle', promise: null, reason: null };

  function loaderTemplate() {
    return core.byId('tmv-mermaid-loader');
  }

  /** What the artifact declares it will fetch, read from the element that will do the fetching. */
  function loaderInfo() {
    var template = loaderTemplate();
    var script = null;
    if (template && template.content) {
      for (var i = 0; i < template.content.childNodes.length; i++) {
        if (template.content.childNodes[i].nodeType === 1) script = template.content.childNodes[i];
      }
    }
    if (!script) return null;
    return {
      src: script.getAttribute('src') || '',
      integrity: script.getAttribute('integrity') || '',
      crossorigin: script.getAttribute('crossorigin') || '',
      version: typeof globalThis.TMV_MERMAID_VERSION === 'string' ? globalThis.TMV_MERMAID_VERSION : '',
    };
  }

  /**
   * Fetch and initialise Mermaid, once, on first use.
   *
   * The element is *cloned out of the template the shell already carries* rather than built here.
   * That is not a style preference: REQ-SEC-002 forbids dynamic script insertion, and the honest
   * reading of that requirement is that no code path in this application may construct a script
   * element out of anything — least of all out of model data. Cloning a static element that the
   * build wrote, with the version and the integrity digest as literal attributes in the artifact,
   * keeps the script's identity as build output. The template's contents are inert until imported,
   * which is what makes REQ-VIEW-005's "not fetched unless a Mermaid diagram is displayed" a
   * property of the platform rather than a promise about our control flow.
   *
   * The timeout exists because a CDN that accepts the connection and then stalls is a real failure
   * mode, and a busy indicator that never resolves is worse than the source text.
   */
  function ensureMermaid(timeoutMs) {
    if (mermaidState.status === 'ready') return Promise.resolve(globalThis.mermaid);
    if (mermaidState.status === 'loading') return mermaidState.promise;
    if (mermaidState.status === 'failed') return Promise.reject(new Error(mermaidState.reason));

    var info = loaderInfo();
    var doc = typeof document === 'undefined' ? null : document;
    if (!info || !info.src) {
      mermaidState.status = 'failed';
      mermaidState.reason = 'the renderer is not declared in this file';
      return Promise.reject(new Error(mermaidState.reason));
    }
    if (!doc || !doc.head || !doc.importNode) {
      mermaidState.status = 'failed';
      mermaidState.reason = 'this environment cannot load the renderer';
      return Promise.reject(new Error(mermaidState.reason));
    }

    mermaidState.status = 'loading';
    mermaidState.promise = new Promise(function (resolve, reject) {
      var template = loaderTemplate();
      var fragment = doc.importNode(template.content, true);
      var script = null;
      var moving = [];
      for (var i = 0; i < fragment.childNodes.length; i++) {
        moving.push(fragment.childNodes[i]);
        if (fragment.childNodes[i].nodeType === 1) script = fragment.childNodes[i];
      }
      if (!script) {
        mermaidState.status = 'failed';
        mermaidState.reason = 'the renderer element is missing from this file';
        reject(new Error(mermaidState.reason));
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        finish('the renderer did not respond within 20 seconds');
      }, timeoutMs || 20000);

      function finish(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        if (reason) {
          mermaidState.status = 'failed';
          mermaidState.reason = reason;
          reject(new Error(reason));
        }
      }

      function onLoad() {
        var api = globalThis.mermaid;
        if (!api || typeof api.initialize !== 'function' || typeof api.render !== 'function') {
          finish('the renderer loaded but did not provide a drawing interface');
          return;
        }
        configure(api);
        mermaidState.status = 'ready';
        finish(null);
        resolve(api);
      }

      function onError() {
        finish('the renderer could not be downloaded, or it did not match the expected integrity digest');
      }

      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      for (var j = 0; j < moving.length; j++) doc.head.appendChild(moving[j]);
    });
    return mermaidState.promise;
  }

  /**
   * Mermaid's settings, written out rather than inherited.
   *
   * `08-security.md` §6 requires the strict security mode and says it "must be verified rather than
   * assumed, since the default has changed across versions". It is verified — the pinned 12.0.0
   * defaults to `strict` — and it is set anyway, because a verified default is still a default, and
   * the next re-pin should not be the thing that turns it off.
   *
   * `htmlLabels: false` is what makes the strict mode meaningful here. With HTML labels Mermaid emits
   * `<foreignObject>`, which sanitization removes, so the setting chooses between "labels render" and
   * "the diagram does not render at all" as much as between safe and unsafe. Both readings point the
   * same way. The two size limits are ours: Mermaid's own defaults for them have moved too, and a
   * diagram that is too large to render must say so rather than hang.
   */
  function configure(api) {
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      maxTextSize: 100000,
      maxEdges: 1000,
      fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
      theme: 'base',
      themeVariables: { background: 'transparent' },
      flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'linear' },
      sequence: { useMaxWidth: true },
      'class': { htmlLabels: false, useMaxWidth: true },
      state: { useMaxWidth: true },
      er: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
      journey: { useMaxWidth: true },
    });
  }

  function mermaidStatus() {
    return { status: mermaidState.status, reason: mermaidState.reason };
  }

  /**
   * Render Mermaid source to a live SVG element.
   *
   * Mermaid's output is a string, and it is treated as untrusted markup: parsed by the same scanner,
   * filtered by the same policy, built by the same builder as an imported `<svg>`. If any step
   * declines, the caller shows the source — which is the AC, and also simply the truest thing to
   * show when we cannot be sure what the picture would have been.
   */
  function renderMermaid(source, doc) {
    return ensureMermaid().then(function (api) {
      var id = 'tmv-mermaid-' + core.uuid().slice(0, 8);
      return api.render(id, source).then(function (out) {
        if (!out || !core.isString(out.svg)) throw new Error('the renderer produced nothing');
        var built = sanitizeSvg(out.svg, doc, { idPrefix: 'tmvm-' + core.uuid().slice(0, 6) + '-' });
        if (built.error) throw new Error('the rendered diagram did not pass the same checks an imported one must (' + built.error + ')');
        return built;
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Type dispatch (REQ-VIEW-005)
  // ---------------------------------------------------------------------------------------------

  var SOURCE_ONLY = {
    graphviz: 'Graphviz is not rendered in this application. The source is shown instead, and it is the authoritative form of the diagram.',
    plantuml: 'PlantUML is not rendered in this application. The source is shown instead, and it is the authoritative form of the diagram.',
  };

  /**
   * What to do with a `diagrams` entry.
   *
   * An unrecognised or absent `type` is *source*, never a guess. A missing type is a missing
   * statement about what the text means, and rendering it as something it might not be would be an
   * invention — the same rule the interchange layer applies to fields it cannot map (REQ-IMP-009).
   */
  function classify(diagram) {
    if (!diagram) return { kind: 'source', reason: 'there is no diagram to render' };
    var type = core.isString(diagram.type) ? diagram.type.trim().toLowerCase() : '';
    if (type === 'svg') return { kind: 'svg', type: type };
    if (type === 'mermaid') return { kind: 'mermaid', type: type };
    if (core.has(SOURCE_ONLY, type)) return { kind: 'source', type: type, reason: SOURCE_ONLY[type] };
    if (type === '') {
      return { kind: 'source', type: '', reason: 'this diagram does not say what language its source is in, so it is shown as written' };
    }
    return { kind: 'source', type: type, reason: 'this application does not render "' + type + '" diagrams; the source is shown instead' };
  }

  // ---------------------------------------------------------------------------------------------
  // 9. DOM: rendering a diagram into a host
  // ---------------------------------------------------------------------------------------------

  function doc() {
    return typeof document === 'undefined' ? null : document;
  }

  function widgets() {
    return TMV.widgets;
  }

  function note(text, kind) {
    return core.el('p', {
      class: 'tmv-diagram__note' + (kind ? ' tmv-diagram__note--' + kind : ''),
      text: text,
    });
  }

  function sourceBlock(source, reason) {
    var children = [note(reason)];
    children.push(widgets().snippet({
      text: source,
      copyLabel: 'Copy diagram source',
      collapsible: source.length > 1200,
    }).element);
    return children;
  }

  function figure(element, caption) {
    var wrap = core.el('figure', { class: 'tmv-diagram__figure' });
    wrap.appendChild(core.el('div', { class: 'tmv-diagram__canvas' }, [element]));
    if (caption) wrap.appendChild(core.el('figcaption', { class: 'tmv-diagram__caption', text: caption }));
    return wrap;
  }

  /**
   * Render one diagram into `host`, replacing whatever was there.
   *
   * Everything asynchronous reports through the host itself rather than throwing: a diagram that
   * cannot be drawn is a normal state of this application, and the state has to be visible in the
   * place the diagram was going to be.
   */
  function render(host, diagram, opts) {
    if (!host) return { status: 'no-host' };
    var options = opts || {};
    core.clear(host);
    var source = diagram && core.isString(diagram.source) ? diagram.source : '';
    var decision = classify(diagram);
    var label = (diagram && TMV.model.labelOf(diagram)) || 'Diagram';

    if (decision.kind === 'source') {
      renderSource(host, source, decision.reason, options);
      return { status: 'source', type: decision.type };
    }
    if (core.utf8Length(source) > TMV.LIMITS.diagramSourceRefuseBytes) {
      // §5's guard, and its stated fallback: the source, whole, with an explanation.
      renderSource(host, source,
        'This diagram is ' + core.bytes(core.utf8Length(source)) + ', above the ' + core.bytes(TMV.LIMITS.diagramSourceRefuseBytes) +
        ' this application will draw. The source is shown in full, and nothing has been discarded.',
        options);
      return { status: 'source', type: decision.type, reason: 'too-large' };
    }

    if (decision.kind === 'svg') {
      var built = sanitizeSvg(source, doc(), {});
      if (built.error === 'too-large') {
        renderSource(host, source, 'This diagram is too large to draw; the source is shown in full.', options);
        return { status: 'source', reason: 'too-large' };
      }
      if (built.error) {
        renderSource(host, source, explainSvgFailure(built.error), options);
        return { status: 'source', reason: built.error };
      }
      host.appendChild(figure(built.element, label));
      appendRemovalNote(host, built.removed);
      return { status: 'rendered', type: 'svg', element: built.element, removed: built.removed };
    }

    // Mermaid. The placeholder is present immediately, because the fetch takes as long as it takes
    // and a blank panel would be indistinguishable from a diagram that failed.
    var busy = core.el('p', { class: 'tmv-diagram__note', text: 'Loading the diagram renderer…' });
    host.appendChild(busy);
    // The placeholder's identity *is* the guard against a slow render landing in a host that has
    // since been rendered again: if something replaced it, this render is stale and must not write.
    // A module-level "current render" token would instead make two diagrams on one screen cancel
    // each other, which is a worse bug than the one it prevents.
    var stale = function () { return host.firstChild !== busy; };

    renderMermaid(source, doc()).then(function (result) {
      if (stale()) return;
      core.clear(host);
      host.appendChild(figure(result.element, label));
      appendRemovalNote(host, result.removed);
      if (options.onRendered) options.onRendered(result);
    }, function (failure) {
      if (stale()) return;
      // The placeholder goes before the explanation does. Leaving it would put "Loading the diagram
      // renderer…" permanently above the message saying the renderer could not be loaded, which reads
      // as though it might still arrive.
      core.clear(host);
      var reason = 'The diagram could not be drawn: ' +
        (failure && failure.message ? failure.message : 'the renderer is unavailable') +
        '. The source is shown below, in full.';
      renderSource(host, source, reason, options);
      if (options.onFailed) options.onFailed(failure);
    });
    return { status: 'pending', type: 'mermaid' };
  }

  function explainSvgFailure(code) {
    if (code === 'empty') return 'This diagram has no source to draw.';
    if (code === 'not-svg') return 'The source is not an SVG document, so it is shown as written.';
    if (code === 'no-document') return 'This diagram cannot be drawn here; the source is shown instead.';
    return 'The diagram was not drawn: its source uses markup this application will not display. ' +
      'Sanitizing it could not be completed with confidence, and showing nothing is better than showing ' +
      'something that is not what the file said. The source is below, in full.';
  }

  function appendRemovalNote(host, removed) {
    if (!removed) return;
    var parts = [];
    if (removed.elements) parts.push(core.plural(removed.elements, 'element'));
    if (removed.attrs) parts.push(core.plural(removed.attrs, 'attribute'));
    if (removed.refs) parts.push(core.plural(removed.refs, 'external reference'));
    if (parts.length) {
      host.appendChild(note(
        'Removed before display: ' + parts.join(', ') + '. An imported diagram is untrusted, so anything ' +
        'that could run, fetch or leave this page is stripped rather than shown.',
        'removed'));
    }
    // `styled` counts style and class attributes; `styleElements` counts whole style elements. They
    // are separate counters because they are removed at different points, and both are the same loss
    // to the person looking at the diagram — which is why the note asks about their sum, and why the
    // test for "did this diagram bring its own styling" is not `removed.styled` alone.
    if (removed.styled || removed.styleElements) {
      // Said plainly because the alternative is a user concluding the application cannot draw. The
      // shapes and the text are all there; what is gone is the diagram's own styling, which the
      // document's security policy refuses to apply — so it is drawn in this application's style.
      host.appendChild(note(
        'This diagram brought its own styling, which this page will not apply. It is drawn in the ' +
        'application\'s own style instead; the shapes and their arrangement are unchanged.',
        'styled'));
    }
  }

  function renderSource(host, source, reason, opts) {
    var options = opts || {};
    if (source === '') {
      host.appendChild(note('This diagram has no source text.', 'empty'));
      return;
    }
    var children = sourceBlock(source, reason);
    for (var i = 0; i < children.length; i++) host.appendChild(children[i]);
    if (options.onRendered) options.onRendered({ source: true });
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Panels
  // ---------------------------------------------------------------------------------------------

  /** The representations in this model, with how many elements each one actually has. */
  function representations(model) {
    var index = TMV.model.index(model);
    var counts = Object.create(null);
    var elements = TMV.model.collection(model, 'representationElements');
    for (var i = 0; i < elements.length; i++) {
      var key = elements[i] && elements[i].representationId;
      if (core.isString(key)) counts[key] = (counts[key] || 0) + 1;
    }
    var list = TMV.model.collection(model, 'representations');
    var out = [];
    for (var j = 0; j < list.length; j++) {
      if (!list[j]) continue;
      out.push({
        id: list[j].id,
        name: TMV.model.labelOf(list[j]),
        type: list[j].type || '',
        width: num(list[j].width),
        height: num(list[j].height),
        elementCount: counts[list[j].id] || 0,
      });
    }
    return out;
  }

  /** The source-text diagrams in this model, in the order they appear. */
  function sourceDiagrams(model) {
    var list = TMV.model.collection(model, 'diagrams');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      out.push({
        id: list[i].id,
        name: TMV.model.labelOf(list[i]),
        type: core.isString(list[i].type) ? list[i].type : '',
        decision: classify(list[i]),
        diagram: list[i],
      });
    }
    return out;
  }

  /**
   * The Diagram sub-section's body (Architecture tab).
   *
   * Whichever of the two shapes the model carries, and never an invented one: a TML model shows its
   * source diagrams and an OTM model shows its canvases, and a model with neither says so plainly
   * rather than showing an empty frame that looks like a rendering failure.
   */
  function panel(model, opts) {
    var options = opts || {};
    var root = core.el('div', { class: 'tmv-diagram' });
    var reps = representations(model);
    var diagrams = sourceDiagrams(model);
    root.setAttribute('data-representations', String(reps.length));
    root.setAttribute('data-diagrams', String(diagrams.length));

    if (!reps.length && !diagrams.length) {
      root.appendChild(widgets().emptyState({
        title: 'This model has no diagrams',
        body: 'Neither format stores a diagram here. A TML model carries diagram source text; an OTM ' +
          'model carries a canvas of coordinates. This one carries neither.',
      }));
      return root;
    }

    // One list of everything drawable, whether it came from a canvas or from source text. The two
    // kinds are different enough to need different renderers and similar enough to belong in one
    // chooser: a user looking for "the diagram" should not have to know which format produced it.
    var entries = [];
    var i;
    for (i = 0; i < reps.length; i++) {
      entries.push({ value: 'rep:' + reps[i].id, label: reps[i].name, kind: 'representation', ref: reps[i] });
    }
    for (i = 0; i < diagrams.length; i++) {
      entries.push({ value: 'src:' + diagrams[i].id, label: diagrams[i].name, kind: 'source', ref: diagrams[i] });
    }

    var host = core.el('div', { class: 'tmv-diagram__host' });

    function showRepresentation(reference) {
      var plan = layout(model, reference.id);
      if (plan.unplaced.length) {
        var names = [];
        for (var k = 0; k < plan.unplaced.length && k < 5; k++) names.push(plan.unplaced[k].name);
        host.appendChild(note(
          core.plural(plan.unplaced.length, 'element') + ' could not be drawn: ' + names.join(', ') +
          (plan.unplaced.length > names.length ? ', and others' : '') + '. ' + plan.unplaced[0].reason + '.',
          'warning'));
      }
      if (plan.empty) {
        host.appendChild(note('This canvas has no positioned elements.', 'empty'));
        if (options.onRepresentationRendered) options.onRepresentationRendered(plan);
        return;
      }
      var svg = drawLayout(plan, doc(), {
        label: plan.representation ? TMV.model.labelOf(plan.representation) : 'Diagram',
      });
      var caption = core.plural(plan.zones.length, 'trust zone') + ' · ' +
        core.plural(plan.nodes.length, 'element') + ' · ' + core.plural(plan.edges.length, 'flow');
      host.appendChild(figure(svg, caption));
      if (plan.flowsOffCanvas) {
        host.appendChild(note(
          core.plural(plan.flowsOffCanvas, 'flow') + ' in this model is not drawn because one of its ends ' +
          'is not on this canvas. The flows themselves are listed under the Flows tab.', 'warning'));
      }
      if (options.onRepresentationRendered) options.onRepresentationRendered(plan);
    }

    function show(value) {
      core.clear(host);
      var entry = entryFor(entries, value);
      if (!entry) return;
      if (entry.kind === 'representation') showRepresentation(entry.ref);
      else render(host, entry.ref.diagram, {});
      root.setAttribute('data-showing', entry.value);
    }

    if (entries.length > 1) {
      var switcher = widgets().dropdown({
        options: entries,
        selected: entries[0].value,
        label: 'Diagram',
        onSelect: show,
      });
      root.appendChild(core.el('div', { class: 'tmv-diagram__picker' }, [switcher.element]));
    } else {
      root.appendChild(core.el('div', { class: 'tmv-diagram__picker' }, [
        core.el('p', {
          class: 'tmv-diagram__note',
          text: entries[0].label + ' · ' + (entries[0].kind === 'source'
            ? (entries[0].ref.type || 'language not stated')
            : core.plural(entries[0].ref.elementCount, 'element')),
        }),
      ]));
    }

    // Stated where the diagram is, not buried in Settings: the promise REQ-VIEW-005 makes is about
    // when this application touches the network, and the only honest place to make it is next to the
    // thing that would do it.
    var info = loaderInfo();
    if (info && info.version && hasMermaid(entries)) {
      root.appendChild(core.el('p', {
        class: 'tmv-diagram__mermaid-version',
        text: 'Mermaid ' + info.version + ' is downloaded from a pinned source the first time a Mermaid ' +
          'diagram is displayed, and not before. Everything else on this tab is drawn by this file alone.',
      }));
    }

    root.appendChild(host);
    show(entries[0].value);
    return root;
  }

  function entryFor(entries, value) {
    for (var i = 0; i < entries.length; i++) if (entries[i].value === value) return entries[i];
    return null;
  }

  function hasMermaid(entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].kind === 'source' && entries[i].ref.decision.kind === 'mermaid') return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------

  TMV.diagrams = {
    // Policy — exported so the static checks and the tests can read it rather than restate it.
    SVG_NS: SVG_NS,
    ALLOWED_ELEMENTS: ALLOWED_ELEMENTS,
    ALLOWED_ATTRS: ALLOWED_ATTRS,
    FORBIDDEN_ELEMENTS: FORBIDDEN_ELEMENTS,
    SHAPE_ELEMENTS: SHAPE_ELEMENTS,
    TEXT_ELEMENTS: TEXT_ELEMENTS,
    PARSE_LIMITS: PARSE_LIMITS,

    // Pure
    parseXml: parseXml,
    decodeEntities: decodeEntities,
    decodeEntity: decodeEntity,
    sanitizeTree: sanitizeTree,
    presentationDefaults: presentationDefaults,
    localName: localName,
    idMapFor: idMapFor,
    classify: classify,
    layout: layout,
    edgeEnds: edgeEnds,
    zoneDepth: zoneDepth,

    // DOM
    sanitizeSvg: sanitizeSvg,
    buildSvg: buildSvg,
    drawLayout: drawLayout,
    renderMermaid: renderMermaid,
    ensureMermaid: ensureMermaid,
    mermaidStatus: mermaidStatus,
    loaderInfo: loaderInfo,
    render: render,
    renderSource: renderSource,
    representations: representations,
    sourceDiagrams: sourceDiagrams,
    panel: panel,
  };
})(globalThis.TMV = globalThis.TMV || {});
