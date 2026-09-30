/* 11-export.js — interchange export, native export, app re-export, download
 * (`06-interchange.md` §5.2, §6.2, §8–§10; `02-architecture.md` §7; REQ-EXP-001..013).
 *
 * Four outputs, and they are not variations on one another:
 *
 *   OTM / TML   a document for someone else's tool. Lossy, and the loss must be disclosed first.
 *   native      the model *and* its history as JSON, for archival or for passing between instances
 *               of this app. The only fully lossless round trip (§10)
 *   HTML        the whole application with a different model embedded — REQ-EXP-007
 *
 * Two things here are easy to get wrong and are worth stating before the code.
 *
 * **The app re-export is built from a clone captured at boot, never from the live DOM** (REQ-EXP-008).
 * The live DOM contains rendered entity rows, runtime attributes, whatever tab is open. Exporting it
 * would ship an application whose "pristine" markup is a snapshot of a session, and the file would
 * differ depending on how much the user had done.
 *
 * **The document is serialized by hand rather than with `outerHTML`** (`02-architecture.md` §7 writes
 * `clone.outerHTML`; see IMPLEMENTATION-STATUS.md). `outerHTML` is on the forbidden list in
 * `09-testing.md` §5 — the same list that keeps rendered model data from reaching the DOM — and using
 * it for our own markup would put the one API that can turn data into markup back into the artifact.
 * The serializer below is the alternative, and it has a second virtue: because we emit the script
 * element's text ourselves, REQ-EXP-009's byte-identity is something this file can *assert* rather
 * than hope a browser's serializer preserved.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var canonical = TMV.canonical;
  var TmvError = TMV.error;

  var BLOCK_ID = TMV.container.BLOCK_ID;

  var OTM = 'otm';
  var TML = 'tml';
  var NATIVE = 'native';
  var HTML = 'html';

  /**
   * What each target writes. The extension is part of the identity of the format, not decoration:
   * `.tmv.json` is a container, `.otm.json` is not, and a user who has both in a folder needs to be
   * able to tell them apart.
   */
  var TARGETS = {
    otm: { key: OTM, label: 'Open Threat Model', extension: '.otm.json', mime: 'application/json', kind: 'interchange' },
    tml: { key: TML, label: 'OWASP Threat Model Library', extension: '.tml.json', mime: 'application/json', kind: 'interchange' },
    native: { key: NATIVE, label: 'Native container (model and history)', extension: '.tmv.json', mime: 'application/json', kind: 'native' },
    html: { key: HTML, label: 'Standalone application', extension: '.html', mime: 'text/html', kind: 'app' },
  };

  // ---------------------------------------------------------------------------------------------
  // The pristine clone (REQ-EXP-008)
  // ---------------------------------------------------------------------------------------------

  var pristineRoot = null;
  var pristineDoctype = '<!DOCTYPE html>';

  /**
   * Capture a clone of the document element **at boot, before anything renders** (REQ-EXP-008).
   *
   * Called once from the boot sequence and never again. Capturing later would capture whatever had
   * been rendered by then, which is the failure the requirement exists to prevent — and the failure
   * is invisible, because the export would still look correct, just different each time.
   *
   * The clone is detached and is never inserted anywhere. It is read-only: every export clones *it*
   * again, so one export cannot affect the next.
   */
  function capturePristine(doc) {
    var d = doc || (typeof document === 'undefined' ? null : document);
    if (!d || !d.documentElement || typeof d.documentElement.cloneNode !== 'function') {
      pristineRoot = null;
      return null;
    }
    pristineRoot = d.documentElement.cloneNode(true);
    pristineDoctype = d.doctype && d.doctype.name ? '<!DOCTYPE ' + d.doctype.name + '>' : '<!DOCTYPE html>';
    return pristineRoot;
  }

  function pristine() {
    return pristineRoot;
  }

  function hasPristine() {
    return pristineRoot !== null;
  }

  /** Test seam: inject a fake document element. Not compiled out — the tests are the only caller. */
  function setPristineForTest(root, doctype) {
    pristineRoot = root;
    if (doctype) pristineDoctype = doctype;
    return pristineRoot;
  }

  // ---------------------------------------------------------------------------------------------
  // The HTML serializer
  // ---------------------------------------------------------------------------------------------

  /**
   * The HTML void elements: no end tag, and nothing may follow them in the output.
   * From the HTML standard's list; `02-architecture.md`'s shell uses `meta` and `link` from it.
   */
  var VOID_ELEMENTS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1,
  };

  /**
   * Elements whose children are *raw text*: the tokenizer does not decode entities inside them and
   * does not look for markup. This is the whole reason the app script survives a round trip — its
   * bytes are copied out verbatim, so the CSP hash computed over them at build time still agrees.
   */
  var RAW_TEXT_ELEMENTS = { script: 1, style: 1 };

  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
  var COMMENT_NODE = 8;

  /** Text-node escaping, per the HTML fragment serialization algorithm. */
  function escapeText(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '&') out += '&amp;';
      else if (c === '<') out += '&lt;';
      else if (c === '>') out += '&gt;';
      else if (c === ' ') out += '&nbsp;';
      else out += c;
    }
    return out;
  }

  /** Attribute-value escaping: the standard escapes `&`, the no-break space, and the quote. */
  function escapeAttributeValue(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '&') out += '&amp;';
      else if (c === '"') out += '&quot;';
      else if (c === ' ') out += '&nbsp;';
      else out += c;
    }
    return out;
  }

  /**
   * Serialize a DOM-like node to HTML text.
   *
   * The only interface used is `nodeType`, `tagName`, `attributes` (as `{name, value}`), `childNodes`
   * and `textContent`. That is deliberate on two counts: it keeps the serializer honest about what it
   * needs from a DOM, and it lets the tests drive it with a plain object tree, since the unit harness
   * has no browser.
   *
   * Attribute order is the document's own, not sorted: this output is meant to look like the file a
   * browser would have written, and reordering attributes would make every export diff against the
   * artifact for no benefit.
   *
   * Foreign content (`svg`, `math`) is serialized as HTML rather than by the XML rules. The artifact
   * contains none — the icons are CSS — so the distinction never arises here, and handling it would
   * be code that is never exercised.
   */
  function serializeNode(node, out) {
    if (!node) return;
    if (node.nodeType === TEXT_NODE) {
      out.push(escapeText(String(node.data === undefined ? '' : node.data)));
      return;
    }
    if (node.nodeType === COMMENT_NODE) {
      out.push('<!--', String(node.data === undefined ? '' : node.data), '-->');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    serializeElement(node, out);
  }

  function serializeElement(el, out) {
    var name = String(el.tagName || '').toLowerCase();
    if (name === '') return;
    out.push('<', name);

    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      if (!attr || attr.name === undefined) continue;
      out.push(' ', String(attr.name), '="', escapeAttributeValue(String(attr.value === undefined ? '' : attr.value)), '"');
    }
    out.push('>');

    if (VOID_ELEMENTS[name]) return;

    if (RAW_TEXT_ELEMENTS[name]) {
      // Verbatim, and that is the point: `textContent` on a script element is the browser's parsed
      // text with no entity decoding applied, so copying it out is exactly byte-preserving.
      out.push(String(el.textContent === undefined ? '' : el.textContent));
    } else {
      var kids = el.childNodes || [];
      for (var k = 0; k < kids.length; k++) serializeNode(kids[k], out);
    }
    out.push('</', name, '>');
  }

  /** Serialize a whole document: the doctype, then the document element. */
  function serializeDocument(root, doctype) {
    if (!root) throw TmvError('EXPORT_NO_ROOT', 'There is no document element to serialize.');
    var out = [];
    out.push(doctype || '<!DOCTYPE html>', '\n');
    serializeElement(root, out);
    return out.join('');
  }

  /** Depth-first search for an element by its `id`, over the attribute interface above. */
  function findById(node, id) {
    if (!node) return null;
    if (node.nodeType === ELEMENT_NODE) {
      var attrs = node.attributes || [];
      for (var i = 0; i < attrs.length; i++) {
        if (attrs[i] && attrs[i].name === 'id' && attrs[i].value === id) return node;
      }
    }
    var kids = node.childNodes || [];
    for (var k = 0; k < kids.length; k++) {
      var found = findById(kids[k], id);
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Native export (REQ-EXP-006)
  // ---------------------------------------------------------------------------------------------

  /**
   * Serialize a container the way the artifact itself carries one: compact canonical JSON, escaped
   * for the block. Native export is the same bytes in a `.json` file, which is what makes re-import
   * restore the full DAG rather than just the head (REQ-EXP-006 AC).
   */
  function nativeText(container) {
    return TMV.container.serialize(container);
  }

  function buildContainer(m, history, build) {
    return TMV.container.makeContainer(m, history || TMV.vcs.initHistory(m, { name: 'Export', email: '' }, 'Export'), build);
  }

  function exportNative(m, history, options) {
    var opts = options || {};
    var container = buildContainer(m, history, opts.build);
    var text = nativeText(container);
    return {
      format: NATIVE,
      ok: true,
      blocked: [],
      container: container,
      text: text,
      bytes: core.utf8Length(text),
      filename: filename(m, NATIVE, history),
      mime: TARGETS.native.mime,
      lossiness: emptyLossiness(TARGETS.native.label),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Lossiness (REQ-EXP-003) and interchange export (REQ-EXP-001, 002, 004, 005)
  // ---------------------------------------------------------------------------------------------

  function emptyLossiness(label) {
    return { label: label, entries: [], total: 0, synthesized: 0, lossless: true };
  }

  /**
   * Assemble the disclosure list from the mapping report.
   *
   * Every entry here was *computed by the mapper while walking the model* against its own tables, so
   * the list cannot drift from what the export actually does — which is what REQ-EXP-003 asks for
   * when it says the list is derived from the mapping tables rather than hard-coded prose. A
   * hand-written list of "things OTM cannot say" would be a second, unverified description of §5.3
   * and would go stale the first time a mapping changed.
   *
   * The mappers describe loss in four different shapes — a counted concept, an entity folded into
   * another, a reference with nowhere to point, and a field deliberately left out — and use a
   * different key name for each. The shapes are normalised *here* rather than at the point of
   * writing, so that each mapper can keep the vocabulary that reads naturally where it is written,
   * and so this file is the one place to consult to know what the export dialogue will show.
   * Getting this wrong is not a crash: it is a disclosure list that says `unknown` with no
   * explanation, which is the same as no disclosure at all (REQ-EXP-003).
   *
   * Synthesized values are counted separately, never mixed into the loss list: a synthesized field
   * is an *addition* the exporter made, a dropped field is data that will not survive, and a reader
   * needs to tell those apart (§8's "an undisclosed synthesis is indistinguishable from data loss").
   * Generated identifiers are the third thing again — not lost and not added, but *changed*, which
   * is why a re-import of the file does not recognise what it wrote.
   */
  var LAYERS = [
    {
      list: 'dropped',
      layer: 'dropped',
      describe: 'Cannot be represented in this format',
      pick: function (e) { return { kind: e.kind, count: e.count, reason: e.reason }; },
    },
    {
      list: 'folded',
      layer: 'folded',
      describe: 'Rewritten as another entity, so the original shape is lost',
      pick: function (e) { return { kind: e.entity, field: e.id, reason: e.as ? 'rewritten as ' + e.as : '' }; },
    },
    {
      list: 'droppedRefs',
      layer: 'reference',
      describe: 'A reference that names nothing, so it was dropped',
      pick: function (e) { return { kind: e.kind, field: e.from, reason: e.to ? 'it pointed at ' + e.to : '' }; },
    },
    {
      list: 'omitted',
      layer: 'omitted',
      describe: 'Omitted rather than guessed at',
      pick: function (e) { return { kind: e.what, reason: e.why }; },
    },
  ];

  function lossinessFrom(report, label) {
    var out = emptyLossiness(label);
    for (var i = 0; i < LAYERS.length; i++) {
      var spec = LAYERS[i];
      var list = core.isArray(report[spec.list]) ? report[spec.list] : [];
      for (var j = 0; j < list.length; j++) {
        var picked = spec.pick(core.isObject(list[j]) ? list[j] : {});
        out.entries.push({
          layer: spec.layer,
          describe: spec.describe,
          kind: core.isString(picked.kind) ? picked.kind : 'unknown',
          field: core.isString(picked.field) ? picked.field : '',
          count: core.isNumber(picked.count) ? picked.count : 1,
          reason: core.isString(picked.reason) ? picked.reason : '',
        });
      }
    }

    var generated = core.isArray(report.generatedIds) ? report.generatedIds : [];
    if (generated.length) {
      out.entries.push({
        layer: 'generated',
        describe: 'Given a new identifier, so re-importing this file will not recognise it',
        kind: 'generated ids',
        field: '',
        count: generated.length,
        reason: 'The format has nowhere to carry an identifier for these, so one is minted on import.',
      });
    }

    var synth = core.isArray(report.synthesized) ? report.synthesized : [];
    out.synthesized = synth.length;
    out.total = out.entries.reduce(function (n, e) { return n + e.count; }, 0);
    out.lossless = out.entries.length === 0;
    return out;
  }

  /**
   * Export to an interchange format.
   *
   * Three separate things can stop the file being offered, and they are kept distinct because they
   * call for different responses from the user:
   *
   *   blocked      the §8 to-do list — entities the mapper refused to invent values for. The user
   *                fixes the model; nothing is downloadable in the meantime.
   *   selfCheck    our own output failed our own validator. This is a bug in the mapper, not in the
   *                user's model, and the honest response is to refuse the download and say so
   *                (REQ-EXP-010's principle applied to interchange) rather than ship a document that
   *                validates nowhere.
   *   lossiness    not a failure at all: it is what the user must be shown *before* exporting
   *                (REQ-EXP-003), and it is computed even when the export is blocked so the
   *                readiness view can show both at once.
   */
  function interchange(m, format, options) {
    var opts = options || {};
    var target = TARGETS[format];
    if (!target || target.kind !== 'interchange') {
      throw TmvError('EXPORT_FORMAT', '"' + format + '" is not an interchange format.');
    }

    // Provenance travels with the model (REQ-IMP-006), so a re-export to the format it came from
    // carries the record of where it came from. Callers may override it; nothing may suppress it
    // silently, and `omitted` in the report is how a mapper that *cannot* place it says so.
    if (opts.provenance === undefined) opts.provenance = TMV.importing.readProvenance(m);

    var mapped = format === TML ? TMV.tml.fromCanonical(m, opts) : TMV.otm.fromCanonical(m, opts);
    var report = mapped.report || {};
    var result = {
      format: format,
      label: target.label,
      ok: mapped.ok !== false,
      blocked: core.isArray(mapped.blocked) ? mapped.blocked : [],
      document: mapped.document,
      report: report,
      lossiness: lossinessFrom(report, target.label),
      checks: null,
      text: '',
      bytes: 0,
      filename: filename(m, format, opts.history),
      mime: target.mime,
    };

    if (!result.ok) return result;

    // Pretty-printed, in the mapper's own field order: these files are read and diffed by people,
    // and the order the mapper writes fields in is the order the format's documentation discusses
    // them. `normalize` is the same pass the canonical model uses, so nothing reaches the file that
    // could not be hashed — and it drops the prototype-pollution keys as a side effect.
    var text = JSON.stringify(canonical.normalize(mapped.document), null, 2) + '\n';
    result.text = text;
    result.bytes = core.utf8Length(text);

    // REQ-EXP-001/002 ACs, checked the only way that means anything: with the validator the import
    // path uses, against the same vendored schema. Validating our own output is also the cheapest
    // possible catch for a mapping regression — it fails here rather than in someone else's tool.
    var check = TMV.importing.validateDocument(mapped.document, format);
    result.checks = check;
    if (!check.valid) {
      result.ok = false;
      result.selfCheck = check.problems;
    }
    return result;
  }

  /**
   * The mapper options a preview shares with the export it is previewing.
   *
   * The TML extension domain is the reason this exists. Whether provenance can be written depends on
   * it, and the export report says so — so a preview that did not carry the configured domain would
   * warn about provenance being omitted on a screen whose Export button then omits nothing. A dialog
   * that disagrees with the file it produces is worse than no dialog.
   *
   * Built field by field rather than by copying `options`, so nothing arrives here under a name the
   * mappers do not read. `history` is forced to null: an interchange document carries no history, and
   * previewing one that did would be previewing an artifact the app never emits.
   *
   * `remember: false` is why this function is load-bearing rather than a convenience. The TML mapper
   * records the slug map it allocates into `x.tml.symbolicNames` so a slug survives a rename (§4), and
   * that write belongs to an export. A preview is a *read*: the Overview asks for one on every render,
   * so recording here would leave the freshly opened model dirty — the header offering to commit a
   * change nobody made, and every reconcile refused for uncommitted edits that do not exist.
   */
  function previewOptions(options) {
    var given = options || {};
    return {
      history: null,
      provenance: given.provenance,
      extensionDomain: core.isString(given.extensionDomain) ? given.extensionDomain : undefined,
      remember: false,
    };
  }

  /** The disclosure and readiness view, without building the file (§6 of `03-data-model.md`). */
  function preview(m, format, options) {
    var out = interchange(m, format, previewOptions(options));
    return {
      format: format,
      label: out.label,
      ok: out.ok,
      blocked: out.blocked,
      lossiness: out.lossiness,
      synthesized: core.isArray(out.report.synthesized) ? out.report.synthesized : [],
      unresolved: core.isArray(out.report.unresolved) ? out.report.unresolved : [],
      counts: TMV.model.counts(m),
    };
  }

  /** Which interchange targets are worth offering, and a one-line reason where they are not. */
  function readiness(m, options) {
    return [OTM, TML].map(function (format) {
      var p = preview(m, format, options);
      return {
        format: format,
        label: p.label,
        ok: p.ok,
        blocked: p.blocked.length,
        lossy: !p.lossiness.lossless,
        summary: p.ok
          ? (p.lossiness.lossless ? 'Exports without loss' : p.lossiness.total + ' value(s) will not survive')
          : p.blocked.length + ' item(s) need attention before this can be exported',
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // App re-export (REQ-EXP-007, REQ-EXP-008, REQ-EXP-009)
  // ---------------------------------------------------------------------------------------------

  /**
   * Assemble a standalone HTML file: the application, with a different container embedded.
   *
   * Built from the pristine clone, which is itself cloned first so the pristine copy stays pristine
   * across exports. The data block's new text is escaped with the container's own escaper, so the
   * bytes are exactly what `build.mjs` would have written for that container — which is what makes
   * an exported file indistinguishable from a built one apart from its model.
   */
  function selfExport(m, history, options) {
    var opts = options || {};
    var root = opts.root || pristineRoot;
    if (!root) {
      throw TmvError(
        'EXPORT_NO_PRISTINE',
        'The pristine copy of the page was not captured at startup, so a standalone export cannot be ' +
          'built. This is a bug in the application, not something you did.',
      );
    }

    var container = opts.container || buildContainer(m, history, opts.build);
    var clone = root.cloneNode(true);
    var block = findById(clone, BLOCK_ID);
    if (!block) {
      throw TmvError(
        'EXPORT_NO_BLOCK',
        'The pristine copy of the page has no #' + BLOCK_ID + ' data block, so there would be ' +
          'nowhere to put the model. This is a bug in the application, not something you did.',
      );
    }
    var json = TMV.container.serialize(container);
    // Setting `textContent` on the block, never inserting markup: the value is JSON, and it stays
    // JSON. The clone is detached, so this is not a live-DOM write either.
    block.textContent = TMV.container.escapeForScriptBlock(json);

    var text = serializeDocument(clone, pristineDoctype);
    var result = {
      format: HTML,
      label: TARGETS.html.label,
      ok: true,
      blocked: [],
      container: container,
      text: text,
      bytes: core.utf8Length(text),
      filename: filename(m, HTML, history),
      mime: TARGETS.html.mime,
      lossiness: emptyLossiness(TARGETS.html.label),
      escaped: TMV.container.needsEscaping(json),
    };
    result.checks = verifyExport(text, container, opts);
    if (!result.checks.ok) result.ok = false;
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Verification before download (REQ-EXP-010)
  // ---------------------------------------------------------------------------------------------

  /**
   * Check the assembled file against what it is supposed to contain, before anyone is offered it.
   *
   * Four assertions, in the order the architecture lists them, and the reason each is here rather
   * than in a test:
   *
   *   the block re-parses     a file whose data block does not parse is a file that cannot be opened,
   *                           and the only place that can be caught is where it is written
   *   the container matches   re-parsing is not enough: the block could parse to *something else*
   *   the script is identical REQ-EXP-009. If this fails the CSP hash in the exported file is wrong
   *                           and the file opens to a CSP error rather than an application
   *   the declared hash agrees the meta tag and the script must tell the same story, or the file
   *                           claims an integrity it does not have
   *
   * Every failure is a reason to block the download, not a warning. A file that fails any of these is
   * worse than no file: the user believes they have a copy.
   */
  function verifyExport(html, container, options) {
    var opts = options || {};
    var problems = [];

    var block = TMV.container.extractBlock(html, BLOCK_ID);
    if (block === null) {
      problems.push({ code: 'NO_BLOCK', message: 'The assembled file has no data block.' });
    } else {
      var parsed = null;
      try {
        parsed = JSON.parse(block);
      } catch (e) {
        problems.push({
          code: 'BLOCK_UNPARSEABLE',
          message: 'The embedded data does not parse: ' + (e && e.message ? e.message : 'parse error'),
        });
      }
      if (parsed !== null && canonical.serialize(parsed) !== canonical.serialize(container)) {
        problems.push({
          code: 'BLOCK_DIFFERS',
          message: 'The embedded data does not match the model that was written.',
        });
      }
    }

    var script = TMV.container.extractBlock(html, TMV.container.APP_SCRIPT_ID);
    if (script === null) {
      problems.push({ code: 'NO_SCRIPT', message: 'The assembled file has no application script.' });
    } else if (opts.expectScript !== undefined && script !== opts.expectScript) {
      problems.push({
        code: 'SCRIPT_DIFFERS',
        message: 'The application script is not byte-identical to this build\'s, so the exported ' +
          'file would fail its own content-security policy.',
      });
    }

    if (script !== null) {
      var declared = declaredAppHash(html);
      if (declared === null) {
        problems.push({ code: 'NO_DECLARED_HASH', message: 'The assembled file declares no application hash.' });
      } else {
        var actual = appHashOf(script);
        if (declared !== actual) {
          problems.push({
            code: 'HASH_MISMATCH',
            message: 'The file declares application hash ' + declared + ' but carries ' + actual + '.',
          });
        }
      }
    }

    return { ok: problems.length === 0, problems: problems };
  }

  /** The app hash as `build.mjs` computes it: `sha256-` plus the base64 of the SHA-256 of the bytes. */
  function appHashOf(scriptText) {
    return 'sha256-' + TMV.hash.base64(scriptText);
  }

  /**
   * Read `tmv-app-hash` from the assembled file's head.
   *
   * Matched on the name attribute rather than the tag, and read from the text rather than from a
   * parse, because the file being checked is one we just assembled and re-parsing it with a document
   * parser is the one thing the import path must never do. Keeping this path text-only means there is
   * no code in the artifact that builds a document from a string at all.
   */
  function declaredAppHash(html) {
    var pattern = /<meta\s[^>]*name="tmv-app-hash"[^>]*>/gi;
    var tag = pattern.exec(html);
    if (!tag) return null;
    var content = /content="([^"]*)"/i.exec(tag[0]);
    return content ? content[1] : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Filenames (REQ-EXP-011)
  // ---------------------------------------------------------------------------------------------

  /**
   * A deterministic, filesystem-safe filename.
   *
   * Deterministic from three things and nothing else: the model name, the target, and the head
   * commit's short id. No timestamp — a timestamp would make every export of the same model a
   * different file, which defeats the point of naming it after the commit. The short id is what makes
   * two exports of *different* heads distinguishable, which is the property that matters when someone
   * has three of these in a downloads folder.
   *
   * Filesystem safety is a whitelist, not a blacklist: characters are allowed through only if they
   * are letters, digits, dot, underscore or hyphen. A blacklist would have to enumerate every
   * reserved name on every platform (`CON`, `NUL`, `..`), and it would still miss the next one.
   */
  function filename(m, format, history) {
    var target = TARGETS[format] || TARGETS.native;
    var base = safeName(m && m.name) || 'threat-model';
    var head = history && core.isString(history.head) ? core.shortId(history.head) : '';
    var parts = [base, target.key];
    if (head) parts.push(head);
    return parts.join('-') + target.extension;
  }

  function safeName(name) {
    if (!core.isString(name)) return '';
    var out = '';
    var text = name.trim().toLowerCase();
    for (var i = 0; i < text.length && out.length < 60; i++) {
      var c = text.charAt(i);
      if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
      else if (out.length > 0 && out.charAt(out.length - 1) !== '-') out += '-';
    }
    // A leading dot would make the file hidden on every Unix; a trailing hyphen is noise.
    out = out.replace(/^[.-]+/, '').replace(/[-.]+$/, '');
    if (out === '.' || out === '..') return '';
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Download (REQ-EXP-012)
  // ---------------------------------------------------------------------------------------------

  /**
   * Offer the file, or hand back the text when the browser will not take it.
   *
   * The fallback is a return value, not an error path: REQ-EXP-012 requires it to be *always
   * reachable*, because a user on a browser that suppresses `file://` downloads has no way to find
   * out that a retry would work. The caller shows the text with a copy button either way.
   *
   * Whether a download actually starts cannot be observed from here — a blocked download is silent
   * by design, and no exception is thrown. That is why the fallback is offered unconditionally rather
   * than only on a caught error, and why `sec.export.file-protocol` in the end-to-end suite is the
   * test that settles it rather than anything in this file.
   */
  function download(text, name, mime, options) {
    var opts = options || {};
    var doc = opts.document || (typeof document === 'undefined' ? null : document);
    var result = { ok: false, method: 'fallback', filename: name, text: text, bytes: core.utf8Length(text) };

    if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      result.reason = 'This browser cannot create a download from a file, so the text is shown instead.';
      return result;
    }

    var url = null;
    var anchor = null;
    try {
      url = URL.createObjectURL(new Blob([text], { type: mime || 'application/octet-stream' }));
      anchor = doc.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.rel = 'noopener';
      // Appended, clicked, removed. A detached anchor is not enough in every browser, and an anchor
      // that is briefly in the body cannot affect an export — the export is built from the pristine
      // clone, taken before anything rendered.
      if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(anchor);
      anchor.click();
      result.ok = true;
      result.method = 'download';
      result.url = url;
    } catch (e) {
      result.reason = 'The download could not be started: ' + (e && e.message ? e.message : 'unknown error');
    } finally {
      if (anchor && anchor.parentNode && typeof anchor.parentNode.removeChild === 'function') {
        anchor.parentNode.removeChild(anchor);
      }
      // Revoked on a later turn of the event loop: revoking synchronously can cancel a download that
      // has not read the blob yet.
      if (url) releaseLater(url, opts.schedule);
    }
    return result;
  }

  function releaseLater(url, schedule) {
    var run = function () {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        // Revoking is best-effort; the URL dies with the document regardless.
      }
    };
    if (typeof schedule === 'function') schedule(run);
    else if (typeof setTimeout === 'function') setTimeout(run, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // One entry point
  // ---------------------------------------------------------------------------------------------

  /**
   * Export to any of the four targets.
   *
   * REQ-EXP-013 wants export available in every degraded mode — no storage, a dirty working copy,
   * pending conflicts. It is, and the reason is structural rather than a special case: nothing in
   * this file reads storage, and nothing consults the working copy's state. Export reads a model and
   * a history that the caller already has. That is worth stating because it is easy to break by
   * accident — a "should I warn about uncommitted changes" check added here would quietly make export
   * depend on the working copy, and only in the mode nobody tests.
   */
  function exportAs(format, m, history, options) {
    if (format === OTM || format === TML) return interchange(m, format, options);
    if (format === NATIVE) return exportNative(m, history, options);
    if (format === HTML) return selfExport(m, history, options);
    throw TmvError('EXPORT_FORMAT', 'There is no export target called "' + format + '".');
  }

  TMV.exporting = {
    OTM: OTM,
    TML: TML,
    NATIVE: NATIVE,
    HTML: HTML,
    TARGETS: TARGETS,
    BLOCK_ID: BLOCK_ID,

    capturePristine: capturePristine,
    pristine: pristine,
    hasPristine: hasPristine,
    setPristineForTest: setPristineForTest,

    serializeDocument: serializeDocument,
    serializeNode: serializeNode,
    findById: findById,
    escapeText: escapeText,
    escapeAttributeValue: escapeAttributeValue,

    interchange: interchange,
    exportNative: exportNative,
    selfExport: selfExport,
    exportAs: exportAs,
    preview: preview,
    readiness: readiness,
    lossiness: lossinessFrom,

    verifyExport: verifyExport,
    appHashOf: appHashOf,
    declaredAppHash: declaredAppHash,

    filename: filename,
    safeName: safeName,

    download: download,
  };
})(globalThis.TMV = globalThis.TMV || {});
