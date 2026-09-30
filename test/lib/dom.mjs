/*
 * A small DOM for the unit harness.
 *
 * `09-testing.md` §2 asks for exactly this and says why: the stub is deliberately small, and
 * anything a unit test needs beyond it belongs in an end-to-end test instead. So this is not a
 * browser. It is enough of one to check that a widget builds the markup and the ARIA wiring it
 * claims to — classes present, roles set, `aria-expanded` moved, actions attached — which is where
 * the wiring typos live. It deliberately does not do layout, hit-testing, focus order, or real
 * event propagation: those are the Playwright matrix's job, and pretending to have them here would
 * make a passing suite say something it does not know.
 *
 * The selector engine supports the subset the widgets actually use: tag, `.class`, `#id`, `[attr]`,
 * `[attr="value"]` and the four operator forms (`^=`, `$=`, `*=`, `~=`), comma lists, and descendant
 * combinators. The operators were added after a test written against `[data-action^="add"]` silently
 * matched nothing, which is the failure this file is most likely to produce: a selector the stub
 * cannot parse returns an empty list, and an empty list looks exactly like "the code did not build
 * that". Anything still unsupported should throw rather than match nothing, for the same reason.
 */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'col', 'meta', 'link']);

class ClassList {
  constructor(node) { this.node = node; }
  _list() { return (this.node.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.node.setAttribute('class', list.join(' ')); }
  add(name) { const l = this._list(); if (l.indexOf(name) === -1) { l.push(name); this._set(l); } }
  remove(name) { this._set(this._list().filter((c) => c !== name)); }
  contains(name) { return this._list().indexOf(name) !== -1; }
  toggle(name, force) {
    const has = this.contains(name);
    const on = force === undefined ? !has : force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class Node {
  constructor(tag, doc, ns) {
    this.nodeType = 1;
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.localName = String(tag);
    // For an HTML element the browser reports the tag upper-cased; for anything else it reports the
    // qualified name as written, which is what makes SVG's case-sensitive names (`linearGradient`,
    // `feGaussianBlur`) checkable here.
    this.tagName = this.namespaceURI === 'http://www.w3.org/1999/xhtml' ? String(tag).toUpperCase() : String(tag);
    this.ownerDocument = doc;
    this.attributes = [];
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this._listeners = [];
    this._value = undefined;
    this.checked = false;
    this.indeterminate = false;
    this.focused = false;
  }

  cloneNode(deep) {
    const copy = new Node(this.localName, this.ownerDocument, this.namespaceURI);
    for (const a of this.attributes) copy.setAttribute(a.name, a.value);
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }

  get firstChild() { return this.childNodes[0] || null; }

  // IDL reflections. These exist in the DOM and the widgets use them, so the stub has them too —
  // omitting them would make a widget that is correct in a browser look broken here.
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get value() {
    const tag = this.tagName.toLowerCase();
    if (tag === 'textarea') return this.textContent;
    if (tag === 'select') {
      const options = this.querySelectorAll('option');
      const chosen = options.find((o) => o.hasAttribute('selected'));
      if (chosen) return chosen.getAttribute('value') || '';
      return options.length ? options[0].getAttribute('value') || '' : '';
    }
    return this._value === undefined ? '' : this._value;
  }
  set value(v) {
    const tag = this.tagName.toLowerCase();
    if (tag === 'textarea') { this.textContent = String(v); return; }
    if (tag === 'select') {
      for (const o of this.querySelectorAll('option')) {
        if (o.getAttribute('value') === String(v)) o.setAttribute('selected', '');
        else o.removeAttribute('selected');
      }
      return;
    }
    this._value = String(v);
  }

  get textContent() {
    if (VOID_TAGS.has(this.tagName.toLowerCase())) return '';
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) {
      const t = this.ownerDocument.createTextNode(String(value));
      t.parentNode = this;
      this.childNodes.push(t);
    }
  }

  setAttribute(name, value) {
    const existing = this.attributes.find((a) => a.name === name);
    if (existing) existing.value = String(value);
    else this.attributes.push({ name, value: String(value) });
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    const found = this.attributes.find((a) => a.name === name);
    return found ? found.value : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { this.attributes = this.attributes.filter((a) => a.name !== name); }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at !== -1) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(child, ref) {
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at === -1) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(at, 0, child);
    return child;
  }
  contains(other) {
    let node = other;
    while (node) { if (node === this) return true; node = node.parentNode; }
    return false;
  }

  addEventListener(type, handler) {
    this._listeners.push({ type, handler });
    return handler;
  }
  removeEventListener(type, handler) {
    this._listeners = this._listeners.filter((l) => !(l.type === type && l.handler === handler));
  }
  /** Fire listeners for `type`, letting them bubble up the parent chain. */
  dispatch(type, extra) {
    const event = Object.assign({
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    }, extra || {});
    let node = this;
    while (node) {
      for (const l of node._listeners.slice()) {
        if (l.type === type) l.handler(event);
      }
      if (event.propagationStopped) break;
      node = node.parentNode;
    }
    return event;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.focused = true;
  }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  click() { this.dispatch('click', { key: undefined }); }

  getBoundingClientRect() { return { top: 100, left: 100, width: 80, height: 20, right: 180, bottom: 120 }; }

  matches(selector) { return matchesSelector(this, selector); }

  querySelectorAll(selector) {
    const out = [];
    for (const part of splitTop(selector)) walk(this, part.trim(), out);
    // A descendant combinator can reach the same node by more than one route; a real DOM returns it
    // once.
    return out.filter((node, at) => out.indexOf(node) === at);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class TextNode {
  constructor(data, doc) { this.nodeType = 3; this.data = String(data); this.ownerDocument = doc; this.parentNode = null; }
  get textContent() { return this.data; }
  // A text node has `cloneNode` in every DOM; the self-export path deep-clones the captured
  // document element, so without this a stub tree cannot be cloned at all.
  cloneNode() { return new TextNode(this.data, this.ownerDocument); }
}

// ---- selection ------------------------------------------------------------------------------

function splitTop(selector) {
  // Comma-separated groups, but a comma inside brackets does not split.
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

function walk(root, selector, out) {
  const steps = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) { if (current) steps.push(current); current = ''; continue; }
    current += ch;
  }
  if (current) steps.push(current);
  if (!steps.length) return;
  matchDescendant(root, steps, 0, out, root);
}

function matchDescendant(node, steps, index, out, root) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    if (matchesCompound(child, steps[index])) {
      if (index === steps.length - 1) out.push(child);
      else matchDescendant(child, steps, index + 1, out, root);
    }
    // A descendant combinator means the next step can match at any depth below, so keep scanning
    // this subtree at the same step index as well.
    matchDescendant(child, steps, index, out, root);
  }
}

function matchesCompound(node, compound) {
  const parts = compound.match(/[.#]?[\w-]+|\[[^\]]*\]/g) || [];
  for (const part of parts) {
    if (part[0] === '#') { if (node.getAttribute('id') !== part.slice(1)) return false; continue; }
    if (part[0] === '.') { if (!node.classList.contains(part.slice(1))) return false; continue; }
    if (part[0] === '[') {
      const inner = part.slice(1, -1);
      const op = inner.match(/[\^$*~]?=/);
      if (!op) { if (!node.hasAttribute(inner)) return false; continue; }
      const name = inner.slice(0, op.index);
      const want = inner.slice(op.index + op[0].length).replace(/^["']|["']$/g, '');
      const actual = node.getAttribute(name);
      if (actual === null) return false;
      const symbol = op[0];
      if (symbol === '=' && actual !== want) return false;
      if (symbol === '^=' && actual.indexOf(want) !== 0) return false;
      if (symbol === '$=' && actual.slice(-want.length) !== want) return false;
      if (symbol === '*=' && actual.indexOf(want) === -1) return false;
      if (symbol === '~=' && actual.split(/\s+/).indexOf(want) === -1) return false;
      continue;
    }
    if (node.tagName.toLowerCase() !== part.toLowerCase()) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  for (const part of splitTop(selector)) if (matchesCompound(node, part.trim())) return true;
  return false;
}

// ---- the document ---------------------------------------------------------------------------

export function makeDom() {
  const doc = {
    nodeType: 9,
    activeElement: null,
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    createElement(tag) {
      const node = new Node(tag, doc);
      // A template's contents are inert in a browser: they are never rendered, never fetched and
      // never executed until they are imported. The stub keeps them in `content` so a module that
      // declares its lazy-loaded script inside a template can be tested for not activating it.
      if (String(tag).toLowerCase() === 'template') {
        node.content = new Node('#fragment', doc);
        node.content.nodeType = 11;
      }
      return node;
    },
    createElementNS(ns, tag) { return new Node(tag, doc, ns); },
    createTextNode(data) { return new TextNode(data, doc); },
    importNode(node, deep) { return node.cloneNode(deep !== false); },
    getElementById(id) {
      const found = doc.body ? doc.body.querySelectorAll('[id="' + id + '"]') : [];
      return found[0] || null;
    },
    addEventListener(type, handler) { return doc._root.addEventListener(type, handler); },
    removeEventListener(type, handler) { return doc._root.removeEventListener(type, handler); },
    // Document-level events are attached to the root node; dispatching on it is how a test fires a
    // key the way the browser would, by bubbling from wherever focus is up to the document.
    dispatch(type, extra) { return doc._root.dispatch(type, extra); },
    _listeners: [],
    execCommand() { return true; },
  };
  doc.body = new Node('body', doc);
  doc.head = new Node('head', doc);
  doc._root = doc.body;
  return doc;
}
