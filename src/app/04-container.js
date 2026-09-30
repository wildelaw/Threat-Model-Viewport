/* 04-container.js — the container: parse, serialize, escape for the script block (`03-data-model.md` §7).
 *
 * The container is what is embedded in the HTML and what native export writes (REQ-EXP-006). It is
 * the canonical model plus a history plus build metadata. It is a *data block*, never executable
 * script (invariant I4).
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var TmvError = TMV.error;
  var canonical = TMV.canonical;

  // ---------------------------------------------------------------------------------------------
  // Script-block escaping (REQ-DATA-002)
  // ---------------------------------------------------------------------------------------------

  /**
   * The two Unicode line terminators, built from their code points rather than written as literals.
   *
   * This is not stylistic. U+2028 and U+2029 are invisible, they are *line terminators in JavaScript
   * source* (though not in JSON), and a source file containing them cannot be reviewed or diffed
   * honestly — a regex written with a literal separator and one written with a space look identical
   * on screen and behave nothing alike. Deriving them here means the characters this module is
   * responsible for cannot be confused with the space character by anyone reading this file.
   */
  var LINE_SEPARATOR = String.fromCharCode(0x2028);
  var PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
  var SEPARATORS = LINE_SEPARATOR + PARAGRAPH_SEPARATOR;

  /** Replace every occurrence of a one-character string. Used instead of a regex, to avoid literals. */
  function replaceAll(str, needle, replacement) {
    return str.indexOf(needle) === -1 ? str : str.split(needle).join(replacement);
  }

  /**
   * Escape a JSON text so it can sit inside the container's data block and still parse.
   *
   * The important property, and the reason this is not a blanket HTML escape: **every substitution is
   * a valid JSON escape that decodes back to the original character**. The reader therefore needs no
   * unescaping pass at all — `JSON.parse` of the escaped text already yields the original value. An
   * unescaping pass would be a second way to corrupt data, and it would have to tell a `\/` that this
   * function produced from a `\/` that was legitimately in the user's string.
   *
   *   `</`      becomes  `<\/`          — else the script block terminates early
   *   `<!--`    becomes  `\u003C!--`    — else comment parsing swallows the block
   *   U+2028    becomes  `\u2028`       — legal in JSON, illegal in JavaScript source
   *   U+2029    becomes  `\u2029`
   *
   * Note that the spec's table (`02-architecture.md` §4) writes the `<!--` case as `<\!--`. That
   * literal form is not valid JSON — `\!` is not in the JSON grammar — so it would make the data
   * block unparseable for any model containing `<!--`, which is precisely the round trip
   * REQ-DATA-002 requires. What is implemented here is the table's *intent* (survive parse →
   * serialize → re-embed without loss); see IMPLEMENTATION-STATUS.md.
   */
  function escapeForScriptBlock(jsonText) {
    var s = String(jsonText);
    s = replaceAll(s, '</', '<\\/');
    s = replaceAll(s, '<!--', '\\u003C!--');
    s = replaceAll(s, LINE_SEPARATOR, '\\u2028');
    s = replaceAll(s, PARAGRAPH_SEPARATOR, '\\u2029');
    return s;
  }

  /**
   * True when a JSON text contains a sequence the script block cannot carry verbatim.
   *
   * Escaping is applied unconditionally, so this is not a control-flow guard — it exists because
   * export verification (REQ-EXP-010) asserts that a clean serialization needed no escaping at all,
   * which is the cheapest way to notice that a serializer started emitting something unexpected.
   */
  function needsEscaping(jsonText) {
    var s = String(jsonText);
    return (
      s.indexOf('</') !== -1 ||
      s.indexOf('<!--') !== -1 ||
      s.indexOf(LINE_SEPARATOR) !== -1 ||
      s.indexOf(PARAGRAPH_SEPARATOR) !== -1
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Reading the block out of a page (`02-architecture.md` §4, `08-security.md` §3)
  // ---------------------------------------------------------------------------------------------

  /** The `id` of the container's data block in an exported artifact. */
  var BLOCK_ID = 'tmv-data';

  /** The `id` of the application script in an exported artifact, for the export's own verification. */
  var APP_SCRIPT_ID = 'tmv-app';

  /**
   * Lift a script block's text out of an HTML document **by scanning the text**.
   *
   * This is the whole of REQ-IMP-008's extraction path, and the reason it lives here rather than in
   * the importer is that it is a fact about the container block, not about importing: the exporter
   * finds the same block again to verify what it wrote (REQ-EXP-010).
   *
   * Scanning, deliberately, and never `DOMParser` or `innerHTML`: an incoming file is untrusted, and
   * the only way to guarantee it is never parsed as a document is to never hand it to a document
   * parser. The scan walks script-tag occurrences in order, so an earlier occurrence that is not the
   * block — a mention inside another script, a tag inside a comment — cannot make the real one
   * unreachable, and an occurrence whose text contains a closing script tag is cut there rather than
   * swallowing the rest of the page (impossible in a file we wrote, since `escapeForScriptBlock`
   * prevents it).
   *
   * The tag markers come from `core` rather than being written here: see the note there on why this
   * directory may not contain them literally.
   *
   * Returns `null` when there is no such block, so callers report a missing block in words rather
   * than as an exception.
   */
  function extractBlock(html, id) {
    var wanted = id || BLOCK_ID;
    var text = String(html);
    var lower = text.toLowerCase();
    var at = 0;
    while (true) {
      var open = lower.indexOf(core.SCRIPT_OPEN, at);
      if (open === -1) return null;
      var tagEnd = text.indexOf('>', open);
      if (tagEnd === -1) return null;
      var tag = text.slice(open, tagEnd + 1);
      at = tagEnd + 1;
      if (!hasIdAttribute(tag, wanted)) continue;
      var close = lower.indexOf(core.SCRIPT_CLOSE, at);
      return text.slice(at, close === -1 ? text.length : close);
    }
  }

  /**
   * Whether a tag's text declares `id="<wanted>"`, with either quote style and any attribute order.
   *
   * Written by hand rather than as `id\s*=\s*["']?…` matched against the whole tag, because the
   * loose form also matches `data-id="tmv-data"` and `aria-describedby='…tmv-data…'` — an attacker
   * controlled page could then hide a second block behind an attribute we mistake for the real one.
   */
  function hasIdAttribute(tag, wanted) {
    var pattern = /(^|[\s"'/])id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    var match;
    while ((match = pattern.exec(tag)) !== null) {
      var value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
      if (value === wanted) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------------------------

  /**
   * Parse a container JSON text. Parsing only — never evaluation, never DOM insertion.
   *
   * Size is guarded before the parse: the failure being protected against is a hostile file hanging
   * the tab (`08-security.md` §5), and a guard applied after a successful parse would be no guard at
   * all.
   */
  function parse(text, options) {
    var opts = options || {};
    var byteLength = core.utf8Length(text);
    if (byteLength > TMV.LIMITS.containerRefuseBytes && !opts.allowOversize) {
      throw TmvError(
        'CONTAINER_TOO_LARGE',
        'This file is ' + core.bytes(byteLength) + ', which is larger than the ' +
          core.bytes(TMV.LIMITS.containerRefuseBytes) + ' limit this application will open.',
        { bytes: byteLength },
      );
    }
    var value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw TmvError('CONTAINER_PARSE', 'The embedded data is not valid JSON: ' + err.message, {
        bytes: byteLength,
      });
    }
    if (!core.isObject(value)) {
      throw TmvError('CONTAINER_SHAPE', 'The embedded data is valid JSON but not a container object.');
    }
    return { container: value, bytes: byteLength, oversize: byteLength > TMV.LIMITS.containerWarnBytes };
  }

  /** Serialize a container to canonical JSON text. This is what gets escaped and embedded. */
  function serialize(container) {
    return canonical.serialize(container);
  }

  // ---------------------------------------------------------------------------------------------
  // Shape
  // ---------------------------------------------------------------------------------------------

  /**
   * Structural checks on the container envelope. Whether the *model* inside is valid is
   * `TMV.model.validate`'s business; this only answers "is this a container, and can this build
   * understand it".
   *
   * Returns a verdict rather than throwing, because an unknown container version must load read-only
   * with an explanation (REQ-DATA-003), not fail.
   */
  function inspect(container) {
    var problems = [];
    if (!core.isObject(container)) {
      return { ok: false, readOnly: true, reason: 'Not a container object.', problems: ['root'] };
    }
    var version = container.tmvFormat;
    if (!core.isString(version)) problems.push('tmvFormat');
    var history = container.history;
    if (!core.isObject(history)) problems.push('history');
    else if (!core.isArray(history.commits)) problems.push('history.commits');
    if (!core.isObject(container.model)) problems.push('model');

    if (problems.length) {
      return {
        ok: false,
        readOnly: true,
        reason:
          'This file is missing the fields that identify it as a Threat-Model-Viewport container (' +
          problems.join(', ') + ').',
        problems: problems,
      };
    }

    var known = version === TMV.CONTAINER_FORMAT;
    var newer = !known && compareVersions(version, TMV.CONTAINER_FORMAT) > 0;
    if (!known) {
      return {
        ok: true,
        readOnly: true,
        unknownVersion: true,
        reason:
          'This file declares container format ' + version + ', and this build understands ' +
          TMV.CONTAINER_FORMAT + '.' +
          (newer
            ? ' It was written by a newer version of the application, so its semantics are not known'
            + ' here. It is open in read-only mode rather than guessed at.'
            : ' It is older than this build, and was migrated in memory on load.'),
        problems: [],
      };
    }
    return { ok: true, readOnly: false, unknownVersion: false, reason: null, problems: [] };
  }

  /** Numeric comparison of dotted version strings. A non-numeric segment counts as 0. */
  function compareVersions(a, b) {
    var pa = String(a).split('.');
    var pb = String(b).split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var na = parseInt(pa[i], 10);
      var nb = parseInt(pb[i], 10);
      if (isNaN(na)) na = 0;
      if (isNaN(nb)) nb = 0;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------------------------

  /** An empty model: every entity array present, so no code path meets `undefined` (`03-data-model.md` §2). */
  function emptyModel(name, modelId) {
    return TMV.model.createEmpty(name, modelId);
  }

  /** The container envelope around a model and its history. */
  function makeContainer(model, history, build) {
    return {
      $schema: TMV.CONTAINER_SCHEMA,
      tmvFormat: TMV.CONTAINER_FORMAT,
      model: model,
      history: {
        keyframeInterval: history.keyframeInterval || TMV.DEFAULT_KEYFRAME_INTERVAL,
        head: history.head === undefined ? null : history.head,
        commits: history.commits || [],
      },
      build: {
        appVersion: (build && build.appVersion) || TMV.VERSION,
        appHash: (build && build.appHash) || null,
        generatedAt: (build && build.generatedAt) || new Date().toISOString(),
      },
    };
  }

  /**
   * The artifact's seed container: an empty model with one root commit, so the built file opens as a
   * working application rather than an error state. Called by `build.mjs` through the application's
   * own model and VCS code, which is what keeps canonical serialization and hashing to a single
   * implementation.
   */
  function buildSeedContainer(build) {
    var name = 'Untitled Threat Model';
    var model = emptyModel(name);
    var identity = { name: 'Threat-Model-Viewport', email: '' };
    var commit = TMV.vcs.createRootCommit(model, identity, 'Create ' + name, {
      timestamp: new Date().toISOString(),
      isKeyframe: true,
    });
    return makeContainer(
      model,
      { keyframeInterval: TMV.DEFAULT_KEYFRAME_INTERVAL, head: commit.id, commits: [commit] },
      build,
    );
  }

  /** Read and parse the embedded data block. Throws on failure; the caller renders the error state. */
  function readEmbedded() {
    var node = core.byId('tmv-data');
    if (!node) {
      throw TmvError('CONTAINER_MISSING', 'This page has no embedded data block (expected #tmv-data).');
    }
    return parse(node.textContent);
  }

  /** Replace the embedded data block's text. Used by self-export, and by nothing else. */
  function writeEmbeddedText(target, text) {
    if (target) target.textContent = escapeForScriptBlock(text);
    return target;
  }

  TMV.container = {
    BLOCK_ID: BLOCK_ID,
    APP_SCRIPT_ID: APP_SCRIPT_ID,
    escapeForScriptBlock: escapeForScriptBlock,
    needsEscaping: needsEscaping,
    extractBlock: extractBlock,
    parse: parse,
    serialize: serialize,
    inspect: inspect,
    compareVersions: compareVersions,
    emptyModel: emptyModel,
    makeContainer: makeContainer,
    buildSeedContainer: buildSeedContainer,
    readEmbedded: readEmbedded,
    writeEmbeddedText: writeEmbeddedText,
  };
})(globalThis.TMV = globalThis.TMV || {});
