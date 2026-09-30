/* 10-import.js — format detection, schema validation, and the import pipeline
 * (`06-interchange.md` §2, §3, §9; REQ-IMP-001..010).
 *
 * This is the file the security model is built around. `08-security.md` §3 is blunt about it: the
 * primary mitigation for an untrusted threat model is "import, do not open", and that only works if
 * this module never lets an incoming document near the DOM. So the rules here are absolute:
 *
 *   - The text is read as text. The HTML data block is found by **string scanning** (REQ-IMP-008),
 *     never by `DOMParser`, `innerHTML`, or a document object of any kind.
 *   - The extracted JSON goes through `JSON.parse` and then the schema validator. Nothing else.
 *   - No path through this file creates an element, a script, or a timer from the input.
 *
 * The second thing worth stating is what the validator is. JSON Schema has no dependency-free
 * implementation, and §3 chose option C: hand-written, format-specific, covering exactly the
 * keywords the two vendored schemas use — re-derived from the vendored files rather than guessed at,
 * and cross-checked against Ajv in the test suite only. `KEYWORDS` below is that surface, and
 * `interop.validator-vs-ajv` fails if a vendored schema starts using something outside it.
 *
 * One finding is worth recording, because it is not obvious and it constrains that differential:
 * **TML's `date-or-datetime` is `oneOf: [{format: date}, {format: date-time}]`, and `format` is an
 * annotation rather than an assertion in JSON Schema 2020-12.** A validator that leaves `format`
 * unenforced therefore matches *both* branches for any string and rejects every date, since `oneOf`
 * requires exactly one match. So the differential has to run Ajv with format assertion enabled for
 * either implementation to be usable, and a disagreement there means the Ajv configuration is
 * wrong, not that the date is invalid.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var model = TMV.model;
  var TmvError = TMV.error;

  // ---------------------------------------------------------------------------------------------
  // Detection (`06-interchange.md` §2)
  // ---------------------------------------------------------------------------------------------

  var NATIVE = 'native';
  var TML = 'tml';
  var OTM = 'otm';
  var UNKNOWN = 'unknown';

  /** The `id` of the data block an exported artifact carries (`02-architecture.md` §3). */
  var DATA_BLOCK_ID = 'tmv-data';

  var FORMAT_LABEL = {
    native: 'a native Threat-Model-Viewport file',
    tml: 'an OWASP Threat Model Library document',
    otm: 'an Open Threat Model document',
    unknown: 'an unrecognised format',
  };

  /**
   * Identify the incoming format from structural markers, never the filename (REQ-IMP-002).
   *
   * Returns the text to parse as well as the verdict, because an exported artifact is HTML whose
   * JSON has to be lifted out first and then re-detected — the same document, one layer down.
   *
   * Order is the spec's order, and it is load-bearing: container first. A native export carries the
   * whole model in a passthrough bag, and a model that happens to quote `otmVersion` in an
   * attribute would otherwise be read as OTM and lose its entire history.
   */
  function detect(text) {
    if (!core.isString(text)) {
      return { format: UNKNOWN, jsonText: '', html: false, evidence: '', reason: 'The input was not text.' };
    }

    if (looksLikeHtml(text)) {
      var block = extractDataBlock(text);
      if (block === null) {
        return {
          format: UNKNOWN,
          jsonText: '',
          html: true,
          evidence: '<html',
          reason:
            'This looks like an HTML file, but it has no JSON data block with id="' + DATA_BLOCK_ID +
            '", which is where an exported threat model keeps its data.',
        };
      }
      // The block's contents are JSON by construction, so they are parsed as JSON and not scanned
      // again for markup. `looksLikeHtml` asks whether a *file* is a page; the text inside a data
      // block is not a file, and a model is allowed to quote a tag inside a name — an export whose
      // model quotes a script open tag would otherwise be read as a page with no data block and
      // refused. `html: true` still tells the caller the container came out of a page, which matters
      // for provenance and for the report, not for the format verdict.
      var inner = detectJson(block);
      inner.html = true;
      inner.evidence = inner.evidence ? 'html > ' + inner.evidence : 'html';
      return inner;
    }

    return detectJson(text);
  }

  /** The JSON half of `detect`, split out so that a data block is never re-scanned as a page. */
  function detectJson(text) {
    var doc = null;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return {
        format: UNKNOWN,
        jsonText: text,
        html: false,
        evidence: '',
        reason: 'This file is not valid JSON: ' + (e && e.message ? e.message : 'parse error'),
        parseError: true,
      };
    }
    if (!core.isObject(doc)) {
      return {
        format: UNKNOWN,
        jsonText: text,
        html: false,
        evidence: '',
        reason: 'This file is valid JSON but not a JSON object, so it cannot be a threat model.',
      };
    }

    var verdict = classify(doc);
    return {
      format: verdict.format,
      jsonText: text,
      html: false,
      evidence: verdict.evidence,
      parsed: doc,
      reason: verdict.format === UNKNOWN
        ? 'This JSON does not look like a threat model this application can read. It expected one of: ' +
          'a native file (with "tmvFormat" and "history"), an OWASP Threat Model Library document ' +
          '(with "$schema" naming threat-model-library, or "trust_zones"), or an Open Threat Model ' +
          'document (with "otmVersion", or "trustZones" and "dataflows").'
        : '',
    };
  }

  function looksLikeHtml(text) {
    // A BOM or leading whitespace is common; doctype case varies. The script-tag test uses the
    // assembled pattern from `core` — see the note there on why this directory may not write the
    // tag literally, which applies to regex literals and strings exactly as much as to code.
    var head = text.slice(0, 4096).replace(/^﻿/, '');
    return /<!doctype\s+html/i.test(head) || /<html[\s>]/i.test(head) || core.SCRIPT_TAG.test(head);
  }

  /** The structural markers of §2, in the order they are resolved. */
  function classify(doc) {
    if (core.isString(doc.tmvFormat) && core.isObject(doc.history)) {
      return { format: NATIVE, evidence: 'tmvFormat + history' };
    }
    if (core.isString(doc.$schema) && doc.$schema.indexOf('threat-model-library') !== -1) {
      return { format: TML, evidence: '$schema names threat-model-library' };
    }
    if (core.isArray(doc.trust_zones) && hasSymbolicName(doc)) {
      return { format: TML, evidence: 'trust_zones + symbolic_name' };
    }
    if (doc.otmVersion !== undefined) {
      return { format: OTM, evidence: 'otmVersion' };
    }
    if (core.isArray(doc.trustZones) && core.isArray(doc.dataflows)) {
      return { format: OTM, evidence: 'trustZones + dataflows' };
    }
    return { format: UNKNOWN, evidence: '' };
  }

  /** Whether any of TML's entity arrays carries a `symbolic_name`, the format's own naming rule. */
  function hasSymbolicName(doc) {
    for (var i = 0; i < TML_ARRAYS.length; i++) {
      var list = doc[TML_ARRAYS[i]];
      if (!core.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        if (core.isObject(list[j]) && core.isString(list[j].symbolic_name)) return true;
      }
    }
    return false;
  }

  var TML_ARRAYS = [
    'trust_zones', 'trust_boundaries', 'actors', 'components', 'data_stores', 'data_sets',
    'data_flows', 'threat_personas', 'threats', 'controls', 'risks', 'assumptions', 'diagrams',
  ];

  /**
   * Lift the JSON out of an exported artifact's data block, by scanning the text (REQ-IMP-008).
   *
   * The scan itself is `TMV.container.extractBlock` — the block is the container's, and the importer
   * and the exporter must find it the same way or an export could verify against a block the import
   * would not read. This wrapper exists only to name the block this caller wants.
   */
  function extractDataBlock(html) {
    return TMV.container.extractBlock(html, DATA_BLOCK_ID);
  }

  // ---------------------------------------------------------------------------------------------
  // The schema validator (`06-interchange.md` §3, option C)
  // ---------------------------------------------------------------------------------------------

  /**
   * The keywords this validator implements, and nothing else.
   *
   * `interop.validator-vs-ajv` re-derives this list from the vendored schemas on every run, so a
   * schema that starts using `anyOf` fails the suite instead of being silently ignored — which is
   * the failure mode that matters, because an ignored keyword makes a bad document look good.
   *
   * `default`, `$id`, `$schema`, `$comment`, `title` and `description` are annotations: they carry
   * no constraint and are deliberately absent.
   */
  var KEYWORDS = {
    $ref: 1, type: 1, required: 1, properties: 1, items: 1, enum: 1, pattern: 1, format: 1,
    patternProperties: 1, additionalProperties: 1, minimum: 1, maximum: 1, oneOf: 1,
    $defs: 1, definitions: 1,
  };

  var ANNOTATION_KEYWORDS = {
    default: 1, $id: 1, $schema: 1, $comment: 1, title: 1, description: 1, examples: 1,
    deprecated: 1, readOnly: 1, writeOnly: 1,
  };

  function schemaFor(format) {
    var schemas = TMV_SCHEMAS;
    if (!core.isObject(schemas)) {
      throw TmvError(
        'SCHEMAS_MISSING',
        'The bundled schemas are not present. They are inlined at build time; this build has none.',
      );
    }
    var schema = format === TML ? schemas.tml : format === OTM ? schemas.otm : null;
    if (!schema) throw TmvError('SCHEMA_UNKNOWN', 'There is no bundled schema for "' + format + '".');
    return schema;
  }

  /**
   * Validate a document against one of the vendored schemas.
   *
   * `problems` is a list of `{path, keyword, message}` in JSON-Pointer form, matching what the
   * canonical model validator reports, so the UI renders both the same way.
   */
  function validateDocument(document, format, options) {
    var opts = options || {};
    var schema = opts.schema || schemaFor(format);
    var problems = [];
    check(schema, schema, document, '', problems, 0);
    return { valid: problems.length === 0, problems: problems, format: format };
  }

  function problem(problems, path, keyword, message) {
    problems.push({ path: path || '/', keyword: keyword, message: message });
  }

  /**
   * Validate `value` against `schema`, appending to `problems`.
   *
   * `root` is the schema the `$ref`s are anchored at, threaded through unchanged so a pointer can
   * only ever resolve inside the schema that wrote it. `depth` counts nesting for
   * `LIMITS.nestingDepth`, which is what stops a document that nests without end.
   */
  function check(root, rawSchema, value, path, problems, depth) {
    if (depth > TMV.LIMITS.nestingDepth) {
      problem(problems, path, 'depth', 'Nested more deeply than this application will validate.');
      return;
    }
    var schema = rawSchema;
    for (var guard = 0; schema && schema.$ref !== undefined; guard++) {
      if (guard > 32) {
        problem(problems, path, '$ref', 'This schema reference does not resolve.');
        return;
      }
      var target = resolveRef(root, schema.$ref);
      if (target === undefined) {
        problem(problems, path, '$ref', 'This schema reference does not resolve: ' + schema.$ref + '.');
        return;
      }
      // In draft-07 a `$ref` replaces its siblings; in 2020-12 they apply alongside it. Neither
      // vendored schema puts a sibling next to a `$ref`, so the distinction never arises — and
      // resolving to the target is the behaviour that is correct for both when it does not.
      schema = target;
    }
    if (!core.isObject(schema)) return;

    if (core.isArray(schema.oneOf)) {
      var matches = 0;
      for (var i = 0; i < schema.oneOf.length; i++) {
        var sub = [];
        check(root, schema.oneOf[i], value, path, sub, depth + 1);
        if (sub.length === 0) matches += 1;
      }
      if (matches !== 1) {
        problem(problems, path, 'oneOf',
          matches === 0
            ? 'Does not match any of the ' + schema.oneOf.length + ' accepted shapes here.'
            : 'Matches ' + matches + ' of the ' + schema.oneOf.length + ' shapes here, and exactly one is required.');
      }
    }

    if (schema.type !== undefined && !typeMatches(schema.type, value)) {
      problem(problems, path, 'type',
        'Expected ' + describeType(schema.type) + ', found ' + kindOf(value) + '.');
      // Stop here rather than cascade: every downstream keyword would report against a value that
      // is the wrong shape, and the first message is the only one that helps.
      return;
    }

    if (core.isArray(schema.enum) && !enumMatches(schema.enum, value)) {
      problem(problems, path, 'enum',
        'Value ' + short(value) + ' is not one of: ' + schema.enum.map(short).join(', ') + '.');
    }

    if (core.isNumber(schema.minimum) && core.isNumber(value) && value < schema.minimum) {
      problem(problems, path, 'minimum', 'Value ' + value + ' is below the minimum of ' + schema.minimum + '.');
    }
    if (core.isNumber(schema.maximum) && core.isNumber(value) && value > schema.maximum) {
      problem(problems, path, 'maximum', 'Value ' + value + ' is above the maximum of ' + schema.maximum + '.');
    }

    if (core.isString(schema.pattern) && core.isString(value)) {
      var re = compilePattern(schema.pattern);
      if (re && !re.test(value)) {
        problem(problems, path, 'pattern',
          'Value ' + short(value) + ' does not match the required pattern ' + schema.pattern + '.');
      }
    }

    if (core.isString(schema.format) && core.isString(value) && !formatMatches(schema.format, value)) {
      problem(problems, path, 'format', 'Value ' + short(value) + ' is not a valid ' + schema.format + '.');
    }

    if (core.isArray(value)) {
      if (schema.items !== undefined) checkItems(root, schema, value, path, problems, depth);
      return;
    }
    if (!core.isObject(value)) return;

    checkObject(root, schema, value, path, problems, depth);
  }

  /**
   * Whether `value` has `key` as an own property — which is what `required` means.
   *
   * Deliberately not `core.present`, which asks whether a value is *substantive* and answers "no"
   * for `''`, `[]` and `null`. That is the right question for the model validator, where an empty
   * string is an absent name, and the wrong one here: JSON Schema's `required` is about key
   * presence alone, so `{"data_sensitivity": []}` satisfies it. The vendored husky example contains
   * exactly that — an empty `data_sensitivity` on one of its data sets — which is the case that
   * caught this. `hasOwnProperty` rather than `in` so a `__proto__` key parsed out of the document
   * cannot make a requirement look satisfied by the prototype chain.
   */
  function hasKey(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
  }

  function checkItems(root, schema, value, path, problems, depth) {
    if (core.isArray(schema.items)) {
      // Tuple validation (draft-07). Neither vendored schema uses it; implemented because silently
      // validating nothing would be worse than the four lines it costs.
      for (var i = 0; i < value.length; i++) {
        var itemSchema = i < schema.items.length ? schema.items[i] : schema.additionalItems;
        if (itemSchema === undefined || itemSchema === false) continue;
        check(root, itemSchema, value[i], path + '/' + i, problems, depth + 1);
      }
      return;
    }
    for (var j = 0; j < value.length; j++) {
      check(root, schema.items, value[j], path + '/' + j, problems, depth + 1);
    }
  }

  /**
   * `required`, `properties`, `patternProperties` and `additionalProperties`.
   *
   * The interaction between the last three is the part of JSON Schema most often got wrong, and it
   * matters here: TML sets `additionalProperties: false` on the root and on every entity, so a
   * property that matches neither `properties` nor a `patternProperties` pattern is a violation —
   * and its one pattern-driven case, `extensions`, is a map whose keys are the pattern.
   */
  function checkObject(root, schema, value, path, problems, depth) {
    var required = schema.required;
    if (core.isArray(required)) {
      for (var r = 0; r < required.length; r++) {
        if (!hasKey(value, required[r])) {
          problem(problems, path, 'required', 'Missing required property "' + required[r] + '".');
        }
      }
    }

    var covered = Object.create(null);
    var properties = core.isObject(schema.properties) ? schema.properties : null;
    if (properties) {
      var keys = Object.keys(value);
      for (var p = 0; p < keys.length; p++) {
        if (!(keys[p] in properties)) continue;
        covered[keys[p]] = true;
        check(root, properties[keys[p]], value[keys[p]], path + '/' + escapePointer(keys[p]), problems, depth + 1);
      }
    }

    var patterns = core.isObject(schema.patternProperties) ? schema.patternProperties : null;
    if (patterns) {
      var patternKeys = Object.keys(patterns);
      var valueKeys = Object.keys(value);
      for (var s = 0; s < patternKeys.length; s++) {
        var re = compilePattern(patternKeys[s]);
        if (!re) continue;
        for (var v = 0; v < valueKeys.length; v++) {
          if (!re.test(valueKeys[v])) continue;
          covered[valueKeys[v]] = true;
          check(root, patterns[patternKeys[s]], value[valueKeys[v]], path + '/' + escapePointer(valueKeys[v]), problems, depth + 1);
        }
      }
    }

    if (schema.additionalProperties === undefined) return;
    var all = Object.keys(value);
    for (var a = 0; a < all.length; a++) {
      if (covered[all[a]]) continue;
      if (schema.additionalProperties === false) {
        problem(problems, path, 'additionalProperties',
          'Property "' + all[a] + '" is not allowed here.');
      } else if (core.isObject(schema.additionalProperties)) {
        check(root, schema.additionalProperties, value[all[a]], path + '/' + escapePointer(all[a]), problems, depth + 1);
      }
    }
  }

  function escapePointer(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  /**
   * Resolve a JSON Pointer `$ref` against the schema that declared it.
   *
   * Both vendored schemas are self-contained, so a ref that leaves its own document is a defect
   * rather than a document to fetch — which is also the only safe reading, since fetching is a
   * network request this application does not make. Anchoring at `root` rather than searching every
   * bundled schema is what makes a TML `$ref` unable to resolve into the OTM schema by accident.
   */
  function resolveRef(root, ref) {
    if (!core.isString(ref)) return undefined;
    if (ref.charAt(0) !== '#') return undefined;
    var pointer = ref.slice(1);
    if (pointer === '') return root;
    if (pointer.charAt(0) !== '/') return undefined;
    var parts = pointer.slice(1).split('/');
    var node = root;
    for (var i = 0; i < parts.length; i++) {
      var key = decodeURIComponent(parts[i]).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!core.isObject(node) || !(key in node)) return undefined;
      node = node[key];
    }
    return node;
  }

  function typeMatches(type, value) {
    var types = core.isArray(type) ? type : [type];
    for (var i = 0; i < types.length; i++) {
      if (matchesOneType(types[i], value)) return true;
    }
    return false;
  }

  function matchesOneType(type, value) {
    switch (type) {
      case 'null': return value === null;
      case 'array': return core.isArray(value);
      case 'object': return core.isObject(value) && !core.isArray(value);
      case 'string': return core.isString(value);
      case 'boolean': return core.isBoolean(value);
      case 'number': return typeof value === 'number' && isFinite(value);
      case 'integer': return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
      default: return true; // An unknown type name constrains nothing; the differential test catches it.
    }
  }

  function describeType(type) {
    var types = core.isArray(type) ? type : [type];
    if (types.length === 1) return types[0] === 'object' ? 'an object' : 'a ' + types[0];
    return types.join(' or ');
  }

  function kindOf(value) {
    if (value === null) return 'null';
    if (core.isArray(value)) return 'an array';
    if (core.isObject(value)) return 'an object';
    if (core.isString(value)) return 'a string';
    if (core.isBoolean(value)) return 'a boolean';
    if (typeof value === 'number') return 'a number';
    return typeof value;
  }

  /** An explicit `null` never satisfies an `enum`, even one containing `null` spelled differently. */
  function enumMatches(values, value) {
    for (var i = 0; i < values.length; i++) {
      if (values[i] === value) return true;
      // JSON has no NaN, but a document could carry `1e999` which parses to Infinity.
      if (typeof values[i] === 'number' && typeof value === 'number' &&
        isNaN(values[i]) && isNaN(value)) return true;
    }
    return false;
  }

  var patternCache = Object.create(null);

  function compilePattern(source) {
    if (!core.isString(source)) return null;
    if (source in patternCache) return patternCache[source];
    var re = null;
    try {
      re = new RegExp(source);
    } catch (e) {
      re = null;
    }
    patternCache[source] = re;
    return re;
  }

  /**
   * `format` for the three formats the vendored schemas use.
   *
   * JSON Schema treats `format` as an annotation unless the format-assertion vocabulary is in play,
   * and this validates it anyway — deliberately. TML's `date-or-datetime` is a `oneOf` over two
   * `format` constraints, so leaving `format` unenforced would make that `oneOf` fail *every* date
   * (both branches match any string, and exactly one must match). Enforcing it is the only reading
   * under which the def means anything.
   */
  function formatMatches(format, value) {
    switch (format) {
      case 'date': return isCalendarDate(value);
      case 'date-time': return isDateTime(value);
      case 'uri': return isUri(value);
      default: return true;
    }
  }

  var DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isCalendarDate(value) {
    var m = DATE.exec(value);
    if (!m) return false;
    var year = +m[1], month = +m[2], day = +m[3];
    if (month < 1 || month > 12 || day < 1) return false;
    return day <= daysInMonth(year, month);
  }

  function daysInMonth(year, month) {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  // RFC 3339: a full date, a time with seconds, an optional fraction, and a required offset.
  var DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

  function isDateTime(value) {
    var m = DATE_TIME.exec(value);
    if (!m) return false;
    if (!isCalendarDate(m[1])) return false;
    var hour = +m[2], minute = +m[3], second = +m[4];
    // A leap second is written `:60`; accept it, since RFC 3339 does.
    if (hour > 23 || minute > 59 || second > 60) return false;
    if (m[8] !== undefined) {
      var offHour = +m[8], offMinute = +m[9];
      if (offHour > 23 || offMinute > 59) return false;
    }
    return true;
  }

  function isUri(value) {
    if (/[\s<>"{}|\\^`]/.test(value)) return false;
    var m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
    if (!m) return false;
    var scheme = m[1].toLowerCase();
    // `tcp:` style relative schemes are legal URIs; a bare `//host` is not a URI without one.
    // A path scheme with no scheme-specific part at all (`http:`) is legal per RFC 3986.
    if (scheme === 'http' || scheme === 'https') return /^https?:\/\/[^\s/?#]+/.test(value);
    return value.length > m[0].length;
  }

  function short(value) {
    if (core.isString(value)) return value.length > 60 ? JSON.stringify(value.slice(0, 57) + '…') : JSON.stringify(value);
    if (core.isArray(value)) return 'an array of ' + value.length;
    if (core.isObject(value)) return 'an object';
    return String(value);
  }

  // ---------------------------------------------------------------------------------------------
  // Provenance (`06-interchange.md` §9, REQ-IMP-006)
  // ---------------------------------------------------------------------------------------------

  /** The canonical home for provenance: the model's own bag, so it survives export (REQ-EXP-004). */
  var PROVENANCE_FORMAT = 'tmv';

  /**
   * Record where this model came from.
   *
   * REQ-IMP-006 lists five fields — source format and schema version, filename, source content hash,
   * import timestamp, and tool — and all five are written.
   *
   * Provenance describes **the hop that produced this model**, and is therefore *overwritten* on
   * import rather than chained. An earlier draft nested the source document's own record under
   * `prior`, on the theory that a file which has been through two tools should describe both hops.
   * That was wrong for two reasons, and both are decisive:
   *
   *   REQ-IMP-009 requires two consecutive round trips to produce **identical** canonical models, and
   *   a nested record makes the model differ on every trip — the nesting grows without bound, so the
   *   file would also grow on every trip through the app.
   *
   *   The lineage is not lost by dropping it: REQ-IMP-005's root commit message already names the
   *   source file, and the history is where ancestry belongs (ADR-0005). A second, unbounded history
   *   inside a passthrough bag was a worse home for the same fact.
   *
   * The mapping table agrees: `06-interchange.md` §5.1 has `project.attributes` imported "verbatim,
   * minus our own provenance keys", which is a description of a record that is regenerated per hop,
   * not accumulated.
   *
   * `modelId` travels in the record, and that is load-bearing for REQ-DATA-006. Neither interchange
   * format has a home for our model identity: OTM's `project.id` may be any string, so when a source
   * declares a non-UUID one the canonical `modelId` has to be minted fresh, and TML has no id field
   * at all. The record is therefore the only thing that can carry the id through a round trip — and
   * preserving it is what lets REQ-IMP-007 recognise "this is a model I already have" instead of
   * offering to create a duplicate under a new identity.
   */
  function recordProvenance(m, input, detection, options) {
    var opts = options || {};
    var record = {
      format: detection.format + (input.schemaVersion ? '/' + input.schemaVersion : ''),
      filename: core.isString(input.filename) ? input.filename : '',
      sourceHash: core.isString(input.text) ? TMV.hash.contentAddress(input.text) : null,
      importedAt: opts.now || new Date().toISOString(),
      tool: 'threat-model-viewport',
      toolVersion: TMV.VERSION,
      // REQ-DATA-006. A UUID, so the import path can tell our record from a foreign one that
      // happened to use the same key, and so a document edited by another tool cannot inject an
      // arbitrary string as a model identity.
      modelId: m.modelId,
    };
    if (detection.html) record.container = 'exported-html';
    model.setBag(m, PROVENANCE_FORMAT, record);
    return record;
  }

  /**
   * Adopt the `modelId` a source document recorded, when it recorded one.
   *
   * REQ-DATA-006: "a `modelId` ... preserved across all copies, exports, and re-exports", and its
   * first acceptance criterion is that exporting and reopening preserves it. A model that has been
   * through our own export carries its id in the provenance record, and re-import must restore it.
   *
   * This is the *only* path that can, because neither format has a native id field: OTM's
   * `project.id` is written from `x.otm.projectId` when the original was not a UUID (so that §10's
   * losslessness holds), and TML has nothing at all. Where a format can carry the id natively the
   * mapper has already used it — an OTM `project.id` that *is* a UUID becomes the `modelId` in
   * `08-otm.js` — and this is then a no-op rather than an override.
   *
   * Deliberately restricted to a UUID: a key we do not recognise must not be able to name our
   * identity, which is why the record carries `tool` as well.
   */
  function adoptModelId(m, provenance) {
    if (!core.isObject(provenance)) return false;
    if (provenance.tool !== 'threat-model-viewport') return false;
    if (!core.isUuid(provenance.modelId)) return false;
    if (m.modelId === provenance.modelId) return false;
    m.modelId = provenance.modelId;
    return true;
  }

  function readProvenance(m) {
    return model.bag(m, PROVENANCE_FORMAT);
  }

  // ---------------------------------------------------------------------------------------------
  // The pipeline
  // ---------------------------------------------------------------------------------------------

  /**
   * Turn an incoming document into a model plus a history, or into a reason it cannot.
   *
   * The result is a value, not an exception, for every input that is *readable but wrong* — an
   * unparseable file, a schema violation, a truncated container. Throwing is reserved for the
   * programmer errors: a missing bundle, an unknown format name. That split is what lets the UI
   * show a report for a bad file instead of an error dialog.
   *
   * `options.allowInvalid` is REQ-IMP-003's override. It imports what it can, marks the result
   * read-only for that format, and says so — because the alternative readings both fail: refusing
   * outright makes a viewport useless for a slightly-off-spec file someone sent you, and importing
   * silently propagates invalid data back out under our name.
   */
  function runImport(input, options) {
    var opts = options || {};
    var text = input && input.text;
    var detection = detect(text);

    var result = {
      ok: false,
      blocked: true,
      format: detection.format,
      formatLabel: FORMAT_LABEL[detection.format] || FORMAT_LABEL.unknown,
      html: detection.html,
      evidence: detection.evidence,
      reason: detection.reason || '',
      schemaVersion: null,
      problems: [],
      warnings: [],
      unresolved: [],
      dropped: [],
      counts: null,
      readOnly: false,
      model: null,
      history: null,
      container: null,
      provenance: null,
      mapping: null,
    };

    if (detection.format === UNKNOWN) return finish(result, input, opts);

    var document = detection.parsed;
    if (document === undefined) {
      try {
        document = JSON.parse(detection.jsonText);
      } catch (e) {
        result.reason = 'This file is not valid JSON: ' + (e && e.message ? e.message : 'parse error');
        return finish(result, input, opts);
      }
    }

    result.schemaVersion = schemaVersionOf(document, detection.format);

    if (detection.format === NATIVE) return importNative(result, document, input, opts);
    return importInterchange(result, document, detection, input, opts);
  }

  function schemaVersionOf(document, format) {
    if (format === OTM) return core.isString(document.otmVersion) ? document.otmVersion : null;
    if (format === TML) {
      var m = core.isString(document.$schema) ? /\/v(\d+(?:\.\d+)*)\//.exec(document.$schema) : null;
      return m ? m[1] : core.isString(document.version) ? document.version : null;
    }
    return core.isString(document.tmvFormat) ? document.tmvFormat : null;
  }

  function importNative(result, document, input, opts) {
    var verdict = TMV.container.inspect(document);
    result.checks = verdict;
    // `readOnly` is reported independently of `ok`: a container written by a newer build is
    // structurally fine and opens, but its semantics are not known here, so it is opened read-only
    // rather than guessed at. Reading it back from `ok` alone would silently make it writable.
    result.readOnly = verdict.readOnly === true;
    if (!verdict.ok) {
      result.reason = verdict.reason || 'This native file is not usable.';
      result.problems = (verdict.problems || []).map(function (p) {
        return { path: String(p), keyword: 'container', message: 'Missing or malformed: ' + p + '.' };
      });
      // A container whose history cannot be trusted is still worth reading, so the override applies
      // here too — and it is the case where it matters most, because the model inside may be fine.
      if (!opts.allowInvalid) return finish(result, input, opts);
      result.readOnly = true;
    }

    // A broken hash chain is a warning, not a refusal: ADR-0008 is explicit that the chain proves
    // integrity rather than authorship, and an edit that breaks it is exactly what the user needs
    // to see rather than be turned away from. The UI says "chain intact" only when this is empty.
    var chain = TMV.vcs.verifyChain(document.history);
    result.chain = { ok: chain.ok, problems: chain.problems || [] };
    for (var i = 0; i < result.chain.problems.length; i++) {
      var entry = result.chain.problems[i];
      result.warnings.push({
        code: 'CHAIN',
        message: String(entry && entry.message ? entry.message : entry),
      });
    }

    var head = document.history && document.history.head;
    var materialized = head ? TMV.vcs.headModel(document.history) : null;
    if (!materialized) {
      result.reason = 'This native file has no commit to read the model from.';
      return finish(result, input, opts);
    }

    result.model = materialized;
    result.history = document.history;
    result.container = document;
    result.ok = true;
    result.blocked = false;
    result.counts = model.counts(materialized);

    var validity = model.validate(materialized, { referential: 'warning' });
    result.problems = validity.problems.filter(isError).map(problemFromModel);
    result.unresolved = validity.unresolved || [];
    result.warnings = result.warnings.concat(
      validity.problems.filter(isNotError).map(problemFromModel),
    );
    return finish(result, input, opts);
  }

  function importInterchange(result, document, detection, input, opts) {
    var verdict = validateDocument(document, detection.format);
    result.validation = verdict;
    if (!verdict.valid) {
      result.problems = verdict.problems;
      result.reason =
        'This ' + (detection.format === TML ? 'Threat Model Library' : 'Open Threat Model') +
        ' document does not match its schema (' + verdict.problems.length +
        (verdict.problems.length === 1 ? ' problem' : ' problems') + ').';
      if (!opts.allowInvalid) return finish(result, input, opts);
      result.readOnly = true;
    }

    var mapped;
    if (detection.format === TML) {
      mapped = TMV.tml.toCanonical(document);
      result.dropped = mapped.report.dropped;
      result.mapping = mapped.report;
      result.unresolved = mapped.report.unresolved || [];
      result.provenance = mapped.report.provenance || null;
    } else {
      mapped = TMV.otm.toCanonical(document);
      result.dropped = mapped.report.dropped;
      result.mapping = mapped.report;
      result.unresolved = mapped.report.unresolved || [];
      result.provenance = mapped.report.provenance || null;
    }

    var m = mapped.model;
    if (!core.present(m.name)) m.name = nameFromFilename(input.filename) || 'Imported model';

    // The record the *source document* carried, kept on the report for the UI to show ("this came
    // from TML, via some other tool") before it is replaced by our own record of this hop.
    result.sourceProvenance = result.provenance || null;
    result.modelIdRestored = adoptModelId(m, result.sourceProvenance);

    // Provenance is written before the commit is made, not after. The root commit carries a
    // snapshot of the model, so anything added afterwards exists only in the working copy and is
    // lost the moment the model is materialized from its history — which is every subsequent load.
    // Recording it first is what makes the import record survive its own round trip.
    result.provenance = recordProvenance(m, {
      filename: input.filename,
      text: input.text,
      schemaVersion: result.schemaVersion,
    }, detection, opts);

    // REQ-IMP-005: an import is a new model with a single root commit and no fabricated history.
    // Whatever history the source document had is gone — it is not translated, and the import says
    // nothing about where the model has been. `initHistory` is the one place that shape is built.
    var author = core.isObject(opts.author) ? opts.author : { name: 'Import', email: '' };
    var history = TMV.vcs.initHistory(
      m,
      author,
      'Import ' + (input.filename ? input.filename : 'a ' + detection.format + ' document'),
      { timestamp: opts.now },
    );

    result.model = m;
    result.history = history;
    result.rootCommit = history.commits[0];
    result.counts = model.counts(m);

    // REQ-IMP-004: referential integrity is a warning, and the references stay in the model marked
    // unresolved rather than being dropped. The mappers already ran the check; this is the second
    // pass over the model they produced, which is what catches a reference the mapping introduced.
    var validity = model.validate(m, { referential: 'warning' });
    for (var i = 0; i < validity.problems.length; i++) {
      var entry = problemFromModel(validity.problems[i]);
      if (isNotError(validity.problems[i])) result.warnings.push(entry);
      else result.problems.push(entry);
    }
    for (var u = 0; u < (validity.unresolved || []).length; u++) {
      var ref = validity.unresolved[u];
      var already = false;
      for (var k = 0; k < result.unresolved.length; k++) {
        if (result.unresolved[k].path === ref.path) { already = true; break; }
      }
      if (!already) result.unresolved.push(ref);
    }

    result.ok = result.problems.length === 0 || !!opts.allowInvalid;
    result.blocked = false;
    return finish(result, input, opts);
  }

  function isError(problem) {
    return problem.severity !== 'warning';
  }

  function isNotError(problem) {
    return problem.severity === 'warning';
  }

  function problemFromModel(problem) {
    return {
      path: problem.path,
      keyword: problem.code || 'model',
      message: problem.message,
      severity: problem.severity,
    };
  }

  function nameFromFilename(filename) {
    if (!core.isString(filename)) return '';
    var base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    return base.trim();
  }

  /**
   * Assemble the retained report (REQ-IMP-010) and return the result as it.
   *
   * The result *is* the report: it carries the model and the history alongside the problems, so
   * the shell can hold one value rather than two that could disagree. `summary` is the flat
   * projection a notice or a log line needs, computed once here so nothing downstream has to
   * re-derive counts from the lists.
   */
  function finish(result, input, opts) {
    result.summary = {
      format: result.format,
      formatLabel: result.formatLabel,
      filename: core.isString(input && input.filename) ? input.filename : '',
      schemaVersion: result.schemaVersion,
      evidence: result.evidence,
      html: result.html,
      ok: result.ok,
      readOnly: result.readOnly,
      counts: result.counts,
      problems: result.problems.length,
      warnings: result.warnings.length,
      unresolved: result.unresolved.length,
      at: opts.now || new Date().toISOString(),
    };
    return result;
  }

  /** The last report, retained until replaced or dismissed (REQ-IMP-010). */
  var retained = null;

  function retainReport(report) {
    retained = report;
    return retained;
  }

  function lastReport() {
    return retained;
  }

  function clearReport() {
    retained = null;
  }

  TMV.importing = {
    NATIVE: NATIVE,
    TML: TML,
    OTM: OTM,
    UNKNOWN: UNKNOWN,
    DATA_BLOCK_ID: DATA_BLOCK_ID,
    FORMAT_LABEL: FORMAT_LABEL,
    KEYWORDS: KEYWORDS,
    ANNOTATION_KEYWORDS: ANNOTATION_KEYWORDS,
    PROVENANCE_FORMAT: PROVENANCE_FORMAT,

    detect: detect,
    extractDataBlock: extractDataBlock,
    validateDocument: validateDocument,
    schemaFor: schemaFor,
    runImport: runImport,
    readProvenance: readProvenance,
    recordProvenance: recordProvenance,
    retainReport: retainReport,
    lastReport: lastReport,
    clearReport: clearReport,
  };
})(globalThis.TMV = globalThis.TMV || {});
