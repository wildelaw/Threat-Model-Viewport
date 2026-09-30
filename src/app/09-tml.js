/* 09-tml.js — the OWASP Threat Model Library mapping, both directions (`06-interchange.md` §6).
 *
 * TML is a stricter format than OTM in a way that shapes this whole file: it has nine **required**
 * root arrays, every entity requires a `symbolic_name`, `title` and `description`, and references
 * are symbolic names constrained to `^[0-9a-z-]+$`. Almost every field the canonical model leaves
 * optional is required here, which is why §8's synthesize-or-block rule does most of the work below.
 *
 * Three things are easy to get wrong and are given names instead:
 *
 *   1. **The symbolic-name map is built before any reference is resolved** (§6.1). References appear
 *      before their targets in real documents — the vendored wallet example has a data flow on line
 *      one naming an actor declared later — so a single-pass resolver reports dangling references
 *      that are not dangling. `collectNames` runs over every array first.
 *   2. **Slug allocation is deterministic and sticky** (§4). Candidate order is sorted by canonical
 *      id so a re-export after a harmless reordering produces byte-identical output (REQ-EXP-005),
 *      and the assignment is stored in `x.tml.symbolicNames` so renaming an entity does not rename
 *      its symbolic name — which, for a model someone else references, would be a breaking change.
 *   3. **`permissions` is a string in TML and a list canonically** (§4.4). The join and the split
 *      are both lossy in edge cases, so both directions disclose when they do something other than
 *      a straight copy.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var model = TMV.model;
  var TmvError = TMV.error;

  /** The TML version this build validates against (`06-interchange.md` §1). */
  var TML_VERSION = '1.0.2';

  /**
   * The identifier TML export writes into `$schema`.
   *
   * The vendored schema constrains its own `$schema` property to this exact URL shape — the OWASP
   * repository's blob URL with a `v<major>.<minor>.<patch>` segment. A `raw.githubusercontent.com`
   * URL, or any self-hosted copy, fails validation **on the identifier alone** (REQ-EXP-002), so this
   * is not a cosmetic default.
   */
  var SCHEMA_URL =
    'https://github.com/OWASP/www-project-threat-model-library/blob/v' + TML_VERSION + '/threat-model.schema.json';

  /** `metadata.version` when the model has none; the schema requires a `\d+(\.\d+)*` string. */
  var DEFAULT_VERSION = '1.0';

  /** Provenance goes in `extensions`, under the configured domain (OQ-02). */
  var PROVENANCE_PREFIX = 'tmv:';

  // ---------------------------------------------------------------------------------------------
  // Field classification, for the lossiness ledger (§7)
  // ---------------------------------------------------------------------------------------------
  //
  // Path convention matches `interop.lossiness-complete`, which walks the vendored schema and looks
  // each path up here: `f` for a root field, `f.p` for a nested one, `a` for a root array, `a[].p`
  // for an item field, `a[].p.q` for a field of a nested object, `a[].p[].q` for an array's items.

  var MAPPED = 'mapped';
  var FOLDED = 'folded';
  var DROPPED = 'dropped';
  var UNREACHABLE = 'unreachable';

  var TML_FIELDS = {
    $schema: MAPPED,
    version: MAPPED,
    scope: MAPPED,
    'scope.title': MAPPED,
    'scope.description': MAPPED,
    'scope.business_criticality': MAPPED,
    'scope.data_sensitivity': MAPPED,
    'scope.exposure': MAPPED,
    'scope.tier': MAPPED,
    description: MAPPED,
    frozen: MAPPED,
    released_at: MAPPED,
    product_release_date: MAPPED,
    release_docs_link: MAPPED,
    reviewed_at: MAPPED,
    repo_link: MAPPED,
    diagrams: MAPPED,
    'diagrams[].title': MAPPED,
    'diagrams[].description': MAPPED,
    'diagrams[].link': MAPPED,
    'diagrams[].type': MAPPED,
    'diagrams[].source': MAPPED,
    trust_zones: MAPPED,
    'trust_zones[].symbolic_name': MAPPED,
    'trust_zones[].title': MAPPED,
    'trust_zones[].description': MAPPED,
    trust_boundaries: MAPPED,
    'trust_boundaries[].trust_zone_a': MAPPED,
    'trust_boundaries[].trust_zone_b': MAPPED,
    'trust_boundaries[].access_control_methods': MAPPED,
    'trust_boundaries[].authentication_methods': MAPPED,
    'trust_boundaries[].access_token_expires': MAPPED,
    'trust_boundaries[].access_token_ttl': MAPPED,
    'trust_boundaries[].has_refresh_token': MAPPED,
    'trust_boundaries[].refresh_token_expires': MAPPED,
    'trust_boundaries[].refresh_token_ttl': MAPPED,
    'trust_boundaries[].can_user_logout': MAPPED,
    'trust_boundaries[].can_system_logout': MAPPED,
    actors: MAPPED,
    'actors[].symbolic_name': MAPPED,
    'actors[].title': MAPPED,
    'actors[].description': MAPPED,
    'actors[].type': MAPPED,
    'actors[].permissions': MAPPED,
    'actors[].trust_zone': MAPPED,
    components: MAPPED,
    'components[].symbolic_name': MAPPED,
    'components[].title': MAPPED,
    'components[].description': MAPPED,
    'components[].parent_component': MAPPED,
    'components[].trust_zone': MAPPED,
    'components[].repo_link': MAPPED,
    data_stores: MAPPED,
    'data_stores[].symbolic_name': MAPPED,
    'data_stores[].title': MAPPED,
    'data_stores[].description': MAPPED,
    'data_stores[].type': MAPPED,
    'data_stores[].vendor': MAPPED,
    'data_stores[].product': MAPPED,
    'data_stores[].trust_zone': MAPPED,
    data_sets: MAPPED,
    'data_sets[].symbolic_name': MAPPED,
    'data_sets[].title': MAPPED,
    'data_sets[].description': MAPPED,
    'data_sets[].placements': MAPPED,
    'data_sets[].placements[].data_store': MAPPED,
    'data_sets[].placements[].encrypted': MAPPED,
    'data_sets[].data_sensitivity': MAPPED,
    'data_sets[].access_control_methods': MAPPED,
    'data_sets[].record_count': MAPPED,
    data_flows: MAPPED,
    'data_flows[].symbolic_name': MAPPED,
    'data_flows[].title': MAPPED,
    'data_flows[].description': MAPPED,
    'data_flows[].source': MAPPED,
    'data_flows[].source.type': MAPPED,
    'data_flows[].source.object': MAPPED,
    'data_flows[].destination': MAPPED,
    'data_flows[].destination.type': MAPPED,
    'data_flows[].destination.object': MAPPED,
    'data_flows[].has_sensitive_data': MAPPED,
    'data_flows[].encrypted': MAPPED,
    assumptions: MAPPED,
    'assumptions[].description': MAPPED,
    'assumptions[].topics': MAPPED,
    'assumptions[].validity': MAPPED,
    threat_personas: MAPPED,
    'threat_personas[].symbolic_name': MAPPED,
    'threat_personas[].title': MAPPED,
    'threat_personas[].description': MAPPED,
    'threat_personas[].is_person': MAPPED,
    'threat_personas[].skill_level': MAPPED,
    'threat_personas[].access_level': MAPPED,
    'threat_personas[].malicious_intent': MAPPED,
    'threat_personas[].applicability_to_org': MAPPED,
    threats: MAPPED,
    'threats[].symbolic_name': MAPPED,
    'threats[].title': MAPPED,
    'threats[].description': MAPPED,
    'threats[].components_affected': MAPPED,
    'threats[].threat_persona': MAPPED,
    'threats[].event': MAPPED,
    'threats[].sources': MAPPED,
    'threats[].attack_mechanisms': MAPPED,
    'threats[].attack_mechanisms[].capec_id': MAPPED,
    'threats[].attack_mechanisms[].capec_title': MAPPED,
    'threats[].weaknesses': MAPPED,
    'threats[].weaknesses[].cwe_id': MAPPED,
    'threats[].weaknesses[].cwe_title': MAPPED,
    controls: MAPPED,
    'controls[].symbolic_name': MAPPED,
    'controls[].title': MAPPED,
    'controls[].description': MAPPED,
    'controls[].threats': MAPPED,
    'controls[].trust_boundary': MAPPED,
    'controls[].trust_boundary.trust_zone_a': MAPPED,
    'controls[].trust_boundary.trust_zone_b': MAPPED,
    'controls[].status': MAPPED,
    'controls[].priority': MAPPED,
    risks: MAPPED,
    'risks[].symbolic_name': MAPPED,
    'risks[].title': MAPPED,
    'risks[].description': MAPPED,
    'risks[].threats': MAPPED,
    'risks[].likelihood': MAPPED,
    'risks[].impact': MAPPED,
    'risks[].impact_description': MAPPED,
    'risks[].score': MAPPED,
    'risks[].level': MAPPED,
    extensions: MAPPED,
    // `$defs/mitigation-plan` is `{risk, controls}` and is referenced by nothing: the root schema has
    // no `mitigation_plans` property and `additionalProperties: false`, so no conforming document can
    // contain one. §6.1 maps `mitigation_plans[]` → `mitigationPlans[]`, so **import** reads the key
    // when a document from another tool carries it, and the definition is reachable that way. Export
    // does not write it — see the note above `exportExtensions` — so both directions of the
    // definition itself stay unreachable, which is what this classification records.
    'mitigation-plan.risk': UNREACHABLE,
    'mitigation-plan.controls': UNREACHABLE,
  };

  // ---------------------------------------------------------------------------------------------
  // Symbolic names
  // ---------------------------------------------------------------------------------------------

  /**
   * The deterministic slug of `06-interchange.md` §4.
   *
   * `toLowerCase → transliterate to ASCII → [^a-z0-9]+ to "-" → trim → truncate to 64`. The
   * transliteration is NFD-then-strip-combining-marks, which handles the Latin accents that actually
   * occur and leaves every other script to the `[^a-z0-9]+` rule, where it becomes a hyphen. That is
   * lossy for Cyrillic or CJK, and it is *deterministically* lossy, which is what REQ-EXP-005 needs;
   * a transliteration table would be a dependency and a maintenance liability for a marginal gain.
   *
   * The `fallback` \u2014 the entity-type name \u2014 goes through the same pipeline rather than being used
   * raw. That matters more than it looks: TML constrains `symbolic_name` to `^[0-9a-z-]+$` and the
   * canonical type labels are camelCase (`trustZone`, `dataFlow`), so a raw fallback would emit a
   * symbolic name that fails the schema's own pattern in exactly the case the fallback exists for.
   */
  function slugify(canonicalId, fallback) {
    var base = normalizeSlug(core.isString(canonicalId) ? canonicalId : '');
    if (base === '') base = normalizeSlug(core.isString(fallback) ? fallback : '') || 'entity';
    return base;
  }

  function normalizeSlug(value) {
    var base = value.toLowerCase();
    if (base.normalize) base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (base.length > 64) base = base.slice(0, 64).replace(/-+$/, '');
    return base;
  }

  /**
   * The stored id → symbolic-name map, keyed `"<typeKey>/<id>"`.
   *
   * §4 says the map is `id → slug`. Keying it by type as well costs nothing and removes a real
   * ambiguity: TML requires symbolic names to be unique *within each array* — a `trust_zone_a` names
   * a trust zone, a `threat_persona` names a persona — while canonical ids are only unique within a
   * type. Two entities of different types may share an id, and a flat map would silently give one of
   * them the wrong symbolic name. The map is never emitted into a TML document, so its shape is the
   * tool's business, not the format's.
   */
  var NAME_MAP_KEY = 'symbolicNames';

  function nameMap(m) {
    var bag = model.bag(m, 'tml');
    // `bag[NAME_MAP_KEY] &&` is load-bearing: without it the `&&` chain short-circuits on the
    // boolean from `isObject` and this returns `true`, whose `Object.keys` is empty — so every
    // caller silently re-derives names instead of reusing the stored ones.
    return (bag && core.isObject(bag[NAME_MAP_KEY]) && bag[NAME_MAP_KEY]) || null;
  }

  function storeNameMap(m, map) {
    var bag = model.bag(m, 'tml') || Object.create(null);
    if (Object.keys(map).length) bag[NAME_MAP_KEY] = map;
    else delete bag[NAME_MAP_KEY];
    model.setBag(m, 'tml', bag);
  }

  /**
   * Allocate a symbolic name for every entity that needs one, and return `"type/id" → name`.
   *
   * Candidates are processed in a fixed order — sorted by canonical id within each type — so the
   * same model always yields the same assignment regardless of array order (§4). An existing
   * assignment is kept even if the entity has been renamed, because changing it would break any
   * external reference to that entity.
   *
   * **This function writes to the model unless `remember` is false, and callers that are only reading
   * must pass it.** Recording on a real export is the point (§4: the map is stored and reused, so a
   * slug survives a rename), but a *preview* is a read — the Overview asks for one on every render —
   * and a read that writes marks the working copy dirty the moment the page opens, so the header
   * offers to commit a change the user never made.
   */
  function symbolicNames(m, options) {
    var opts = options || {};
    var stored = nameMap(m) || Object.create(null);
    var out = Object.create(null);
    var used = Object.create(null);

    for (var t = 0; t < model.TYPES.length; t++) {
      var type = model.TYPES[t];
      if (!needsSymbolicName(type)) continue;
      var list = model.collection(m, type.key);
      var ids = [];
      for (var i = 0; i < list.length; i++) {
        if (core.isObject(list[i]) && core.isString(list[i].id)) ids.push(list[i].id);
      }
      // Sorted, so allocation does not depend on array order.
      ids.sort();

      // Pass one: honour the stored assignment, so a renamed entity keeps its symbolic name.
      for (var a = 0; a < ids.length; a++) {
        var key = type.key + '/' + ids[a];
        var keep = stored[key];
        if (core.isString(keep) && /^[0-9a-z-]+$/.test(keep) && !used[type.key + ':' + keep]) {
          out[key] = keep;
          used[type.key + ':' + keep] = true;
        }
      }
      // Pass two: derive names for the rest, resolving collisions with a numeric suffix.
      for (var b = 0; b < ids.length; b++) {
        var k2 = type.key + '/' + ids[b];
        if (out[k2]) continue;
        var base = slugify(ids[b], type.label);
        var candidate = base;
        var suffix = 2;
        while (used[type.key + ':' + candidate]) candidate = base + '-' + suffix++;
        out[k2] = candidate;
        used[type.key + ':' + candidate] = true;
      }
    }

    if (opts.remember !== false) storeNameMap(m, out);
    return out;
  }

  /**
   * Which types carry a symbolic name.
   *
   * `assumptions` and `diagrams` do not: TML's `assumption` has `description`/`topics`/`validity` and
   * its `diagram` has `title`/`type`/`source`, with no `symbolic_name` in either. They are the two
   * types whose canonical id has no TML counterpart, and so the two whose ids are minted on import.
   */
  function needsSymbolicName(type) {
    return type.key !== 'assumptions' && type.key !== 'diagrams';
  }

  function nameFor(names, type, id) {
    return names[type + '/' + id];
  }

  /**
   * The symbolic name of an id under *any* type, for the two TML fields that are untyped.
   *
   * `components_affected` and the `object` of a `typed-symbolic-name` are both bare
   * `symbolic-name`s in the schema, so the type has to come from the model rather than from the
   * field. The lookup order is fixed — components first, then the other architecture types — so a
   * model where two entities of different types share an id resolves the same way every time
   * instead of depending on object key order (REQ-EXP-005).
   */
  var ANY_NAME_ORDER = ['components', 'actors', 'dataStores', 'dataFlows', 'threats', 'controls', 'risks'];

  function anyNameFor(names, id) {
    if (!core.present(id)) return null;
    for (var i = 0; i < ANY_NAME_ORDER.length; i++) {
      var found = names[ANY_NAME_ORDER[i] + '/' + id];
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Import — TML → canonical (§6.1)
  // ---------------------------------------------------------------------------------------------

  /** TML's `type` on a typed reference → the canonical flow endpoint vocabulary. */
  var ENDPOINT_IN = {
    actor: 'actor',
    'data-store': 'data_store',
    data_store: 'data_store',
    component: 'component',
    '#/$defs/actor': 'actor',
    '#/$defs/component': 'component',
    '#/$defs/data-store': 'data_store',
  };

  /**
   * Canonical endpoint kind → the `type` written into a TML document.
   *
   * The schema does not decide this: `typed-symbolic-name.type` is a free-form string, documented as
   * "a '#/$defs/...' or simple '...' type reference", and `$defs` spells the entry `data-store` while
   * both vendored reference documents write `data_store`. With the spec silent, the fixtures are the
   * tiebreaker — they are what real TML tooling produces, and `06-interchange.md` §10 promises
   * TML → canonical → TML is lossless where TML is concerned, which it is not if we rewrite the
   * endpoint type of every store-ended flow. `ENDPOINT_IN` accepts all three spellings on the way in,
   * so nothing we or anyone else writes is refused.
   */
  var ENDPOINT_OUT = {
    actor: 'actor',
    component: 'component',
    data_store: 'data_store',
  };

  function toCanonical(tml, options) {
    var opts = options || {};
    var report = emptyReport('tml');
    if (!core.isObject(tml)) throw TmvError('TML_SHAPE', 'A TML document must be a JSON object.');

    var m = model.createEmpty('Imported model');
    var bag = Object.create(null);
    if (core.isString(tml.$schema)) bag.$schema = tml.$schema;
    if (core.isObject(tml.extensions)) {
      var prov = readProvenance(tml.extensions);
      if (prov) report.provenance = prov;
      var rest = stripProvenance(tml.extensions);
      if (rest) bag.extensions = rest;
    }
    var extras = unknownKeys(tml, TML_ROOT_KEYS);
    if (extras) bag.extras = extras;
    model.setBag(m, 'tml', bag);

    // `description` is the model's, not an entity's: TML's root description describes the system.
    m.description = core.isString(tml.description) ? tml.description : '';
    applyMetadata(m, tml, report);
    applyScope(m, tml.scope, report);

    // **Before any reference is resolved** (§6.1). References appear before their targets in
    // document order in practice, so this pass exists to stop the resolver inventing dangling
    // references for entities that are simply declared further down.
    var names = collectNames(tml, m);

    importTrustZones(m, tml, names, report);
    importTrustBoundaries(m, tml, names, report);
    importActors(m, tml, names, report);
    importComponents(m, tml, names, report);
    importDataStores(m, tml, names, report);
    importDataSets(m, tml, names, report);
    importDataFlows(m, tml, names, report);
    importPersonas(m, tml, names, report);
    importThreats(m, tml, names, report);
    importControls(m, tml, names, report);
    importRisks(m, tml, names, report);
    importMitigationPlans(m, tml, names, report);
    importAssumptions(m, tml, report);
    importDiagrams(m, tml, report);

    // §3: a dangling reference is a **Warning**, not a rejection — "Import; mark references
    // unresolved" (REQ-IMP-004). The reference is kept exactly as written so the model is a faithful
    // copy of the document, and the list is reported so the user can fix it in place. It blocks
    // *export* (§8), which is where a dangling reference would reach someone else's tool.
    //
    // This is not a theoretical case: both vendored examples contain dangling references — the
    // husky model places data in `api-keys-storage` and `secret-keys-storage` while declaring
    // `api-key-storage` and `secret-key-storage`. Neither schema checks references, so nothing
    // upstream catches it.
    var check = model.validate(m, { referential: 'warning' });
    report.unresolved = check.unresolved || [];

    report.counts = model.counts(m);
    return { model: m, report: report };
  }

  var TML_ROOT_KEYS = {
    $schema: 1, version: 1, scope: 1, description: 1, frozen: 1, released_at: 1,
    product_release_date: 1, release_docs_link: 1, reviewed_at: 1, repo_link: 1, diagrams: 1,
    trust_zones: 1, trust_boundaries: 1, actors: 1, components: 1, data_stores: 1, data_sets: 1,
    data_flows: 1, assumptions: 1, threat_personas: 1, threats: 1, controls: 1, risks: 1,
    extensions: 1, mitigation_plans: 1,
  };

  /**
   * Register every symbolic name against the id it will get, before anything is resolved.
   *
   * On TML import the symbolic name *is* the canonical id (`03-data-model.md` §1: it already matches
   * `^[0-9a-z-]+$`), and `slug` is set to the same value — so the identity in this map is what makes
   * a TML → canonical → TML round trip rename nothing. A name that is absent or does not match the
   * pattern gets a generated id, and the mapping is reported so the user knows the document was not
   * conforming.
   */
  function collectNames(tml, m) {
    var names = Object.create(null);
    var sources = [
      ['trust_zones', 'trustZones'],
      ['trust_boundaries', 'trustBoundaries'],
      ['actors', 'actors'],
      ['components', 'components'],
      ['data_stores', 'dataStores'],
      ['data_sets', 'dataSets'],
      ['data_flows', 'dataFlows'],
      ['threat_personas', 'threatPersonas'],
      ['threats', 'threats'],
      ['controls', 'controls'],
      ['risks', 'risks'],
    ];
    // Recorded as it goes, so the names this document used are the names it gets back (§4: "the map
    // is stored in `x.tml.symbolicNames` and reused"). Seeding it here is what makes the round trip
    // exact rather than merely stable: `slugify` truncates to 64 characters, and a real document
    // has names longer than that — the vendored wallet model's
    // `add-authentication-and-host-header-validation-for-exchange-api-and-backend` is 74 — so
    // re-deriving on export would quietly shorten a name a reader may have referenced.
    var remember = Object.create(null);
    for (var i = 0; i < sources.length; i++) {
      var wire = sources[i][0];
      var key = sources[i][1];
      var list = core.isArray(tml[wire]) ? tml[wire] : [];
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        if (!core.isObject(item)) continue;
        var name = core.isString(item.symbolic_name) ? item.symbolic_name : null;
        if (name === null || name === '') continue;
        names[name] = name;
        remember[key + '/' + name] = name;
      }
    }
    storeNameMap(m, remember);
    return names;
  }

  /** `name` for anything TML declares by symbolic name; a minted uuid when it declares nothing. */
  function idOf(names, value) {
    if (!core.isString(value) || value === '') return null;
    return core.present(names[value]) ? names[value] : value;
  }

  function applyMetadata(m, tml, report) {
    var map = [
      ['version', 'version'],
      ['frozen', 'frozen'],
      ['released_at', 'releasedAt'],
      ['product_release_date', 'productReleaseDate'],
      ['reviewed_at', 'reviewedAt'],
      ['repo_link', 'repoLink'],
      ['release_docs_link', 'releaseDocsLink'],
    ];
    for (var i = 0; i < map.length; i++) {
      var value = tml[map[i][0]];
      if (value === undefined || value === null) continue;
      if (core.isString(value) || core.isBoolean(value)) m.metadata[map[i][1]] = value;
    }
  }

  /**
   * `scope` maps 1:1 by vocabulary, and the vocabularies are identical — including `tier`, whose
   * canonical values are TML's snake_case spellings rather than the camelCase `03-data-model.md`
   * §3.1 prints. Using TML's spelling means the mapping is a copy in both directions instead of a
   * translation table that would have to be kept in step with the schema (IMPLEMENTATION-STATUS.md).
   */
  function applyScope(m, scope, report) {
    if (!core.isObject(scope)) return;
    m.scope = Object.create(null);
    var map = [
      ['title', 'title'],
      ['description', 'description'],
      ['business_criticality', 'businessCriticality'],
      ['data_sensitivity', 'dataSensitivity'],
      ['exposure', 'exposure'],
      ['tier', 'tier'],
    ];
    for (var i = 0; i < map.length; i++) {
      var value = scope[map[i][0]];
      if (value === undefined || value === null) continue;
      if (core.isString(value)) m.scope[map[i][1]] = value;
      else if (core.isArray(value)) {
        var list = [];
        for (var j = 0; j < value.length; j++) if (core.isString(value[j])) list.push(value[j]);
        m.scope[map[i][1]] = list;
      }
    }
    var unknown = unknownKeys(scope, SCOPE_KEYS);
    if (unknown) {
      report.unmapped.push({ where: 'scope', keys: Object.keys(unknown) });
      m.scope.x = unknown;
    }
  }

  var SCOPE_KEYS = {
    title: 1, description: 1, business_criticality: 1, data_sensitivity: 1, exposure: 1, tier: 1,
  };

  function importTrustZones(m, tml, names, report) {
    var list = asArray(tml.trust_zones);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var zone = model.insert(m, 'trustZone', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: core.isString(raw.symbolic_name) ? raw.symbolic_name : undefined,
      }));
      // trustRating has no TML equivalent, so it is left unset rather than defaulted — OTM export
      // synthesizes and discloses it there, which is where the requirement actually exists.
      bagUnknown(zone, raw, { symbolic_name: 1, title: 1, description: 1 });
    }
  }

  function importTrustBoundaries(m, tml, names, report) {
    var list = asArray(tml.trust_boundaries);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var boundary = model.insert(m, 'trustBoundary', defined({
        id: core.uuid(),
        name: '',
        description: core.isString(raw.description) ? raw.description : undefined,
        zoneAId: idOf(names, raw.trust_zone_a),
        zoneBId: idOf(names, raw.trust_zone_b),
        accessControlMethods: stringList(raw.access_control_methods),
        authenticationMethods: stringList(raw.authentication_methods),
        accessTokenExpires: boolOr(raw.access_token_expires),
        accessTokenTtl: intOr(raw.access_token_ttl),
        hasRefreshToken: boolOr(raw.has_refresh_token),
        refreshTokenExpires: boolOr(raw.refresh_token_expires),
        refreshTokenTtl: intOr(raw.refresh_token_ttl),
        canUserLogout: boolOr(raw.can_user_logout),
        canSystemLogout: boolOr(raw.can_system_logout),
      }));
      bagUnknown(boundary, raw, TRUST_BOUNDARY_KEYS);
    }
  }

  var TRUST_BOUNDARY_KEYS = {
    trust_zone_a: 1, trust_zone_b: 1, access_control_methods: 1, authentication_methods: 1,
    access_token_expires: 1, access_token_ttl: 1, has_refresh_token: 1, refresh_token_expires: 1,
    refresh_token_ttl: 1, can_user_logout: 1, can_system_logout: 1, description: 1,
  };

  function importActors(m, tml, names, report) {
    var list = asArray(tml.actors);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var actor = model.insert(m, 'actor', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        type: core.isString(raw.type) ? raw.type : undefined,
        trustZoneId: idOf(names, raw.trust_zone),
        // TML's `permissions` is a free-form *string*; the canonical field is a list (§4.4). A
        // one-element list is the honest reading, and it is what makes the reverse join a copy for
        // everything TML can write.
        permissions: core.isString(raw.permissions) && raw.permissions !== '' ? [raw.permissions] : undefined,
      }));
      bagUnknown(actor, raw, { symbolic_name: 1, title: 1, description: 1, type: 1, permissions: 1, trust_zone: 1 });
    }
  }

  function importComponents(m, tml, names, report) {
    var list = asArray(tml.components);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var comp = model.insert(m, 'component', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        trustZoneId: idOf(names, raw.trust_zone),
        parentId: idOf(names, raw.parent_component),
        repoLink: core.isString(raw.repo_link) ? raw.repo_link : undefined,
      }));
      bagUnknown(comp, raw, COMPONENT_KEYS);
    }
  }

  var COMPONENT_KEYS = {
    symbolic_name: 1, title: 1, description: 1, parent_component: 1, trust_zone: 1, repo_link: 1,
  };

  function importDataStores(m, tml, names, report) {
    var list = asArray(tml.data_stores);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var store = model.insert(m, 'dataStore', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        type: core.isString(raw.type) ? raw.type : undefined,
        trustZoneId: idOf(names, raw.trust_zone),
        vendor: core.isString(raw.vendor) ? raw.vendor : undefined,
        product: core.isString(raw.product) ? raw.product : undefined,
      }));
      bagUnknown(store, raw, DATA_STORE_KEYS);
    }
  }

  var DATA_STORE_KEYS = {
    symbolic_name: 1, title: 1, description: 1, type: 1, vendor: 1, product: 1, trust_zone: 1,
  };

  function importDataSets(m, tml, names, report) {
    var list = asArray(tml.data_sets);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var set = model.insert(m, 'dataSet', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        dataSensitivity: stringList(raw.data_sensitivity),
        accessControlMethods: stringList(raw.access_control_methods),
        recordCount: intOr(raw.record_count),
      }));
      var placements = asArray(raw.placements);
      var out = [];
      for (var p = 0; p < placements.length; p++) {
        var placement = placements[p];
        if (!core.isObject(placement)) continue;
        var row = Object.create(null);
        var target = idOf(names, placement.data_store);
        if (target !== null) row.dataStoreId = target;
        if (core.isBoolean(placement.encrypted)) row.encrypted = placement.encrypted;
        out.push(row);
      }
      if (out.length) set.placements = out;
      bagUnknown(set, raw, DATA_SET_KEYS);
    }
  }

  var DATA_SET_KEYS = {
    symbolic_name: 1, title: 1, description: 1, placements: 1, data_sensitivity: 1,
    access_control_methods: 1, record_count: 1,
  };

  function importDataFlows(m, tml, names, report) {
    var list = asArray(tml.data_flows);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var source = endpoint(names, raw.source);
      var destination = endpoint(names, raw.destination);
      var flow = model.insert(m, 'dataFlow', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        sourceId: source.id,
        sourceType: source.type,
        destinationId: destination.id,
        destinationType: destination.type,
        hasSensitiveData: boolOr(raw.has_sensitive_data),
        encrypted: boolOr(raw.encrypted),
      }));
      bagUnknown(flow, raw, DATA_FLOW_KEYS);
    }
  }

  var DATA_FLOW_KEYS = {
    symbolic_name: 1, title: 1, description: 1, source: 1, destination: 1, has_sensitive_data: 1,
    encrypted: 1,
  };

  /** A `typed-symbolic-name` is `{type, object}`; the type may be a bare name or a `#/$defs/…` one. */
  function endpoint(names, value) {
    if (!core.isObject(value)) return { id: null, type: null };
    var kind = ENDPOINT_IN[core.isString(value.type) ? value.type : ''] || null;
    return { id: idOf(names, value.object), type: kind };
  }

  function importPersonas(m, tml, names, report) {
    var list = asArray(tml.threat_personas);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var persona = model.insert(m, 'threatPersona', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        isPerson: boolOr(raw.is_person),
        skillLevel: core.isString(raw.skill_level) ? raw.skill_level : undefined,
        accessLevel: core.isString(raw.access_level) ? raw.access_level : undefined,
        maliciousIntent: boolOr(raw.malicious_intent),
        applicabilityToOrg: core.isString(raw.applicability_to_org) ? raw.applicability_to_org : undefined,
      }));
      bagUnknown(persona, raw, PERSONA_KEYS);
    }
  }

  var PERSONA_KEYS = {
    symbolic_name: 1, title: 1, description: 1, is_person: 1, skill_level: 1, access_level: 1,
    malicious_intent: 1, applicability_to_org: 1,
  };

  /**
   * A threat, plus one `threatApplication` per entry in `components_affected`.
   *
   * This is where TML's model of the threat/architecture relation is inverted: TML puts
   * `components_affected[]` on the threat, and the canonical join entity keeps one row per
   * target (§4.10). `state` and per-control states do not exist in TML, so a round trip through TML
   * loses them — that is §6.3's disclosure, not an oversight.
   */
  function importThreats(m, tml, names, report) {
    var list = asArray(tml.threats);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var threat = model.insert(m, 'threat', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        personaId: idOf(names, raw.threat_persona),
        event: core.isString(raw.event) ? raw.event : undefined,
        sources: stringList(raw.sources),
        attackMechanisms: capecRefs(raw.attack_mechanisms),
        weaknesses: cweRefs(raw.weaknesses),
        // `cwes` is a string list so that OTM export — which has no `weaknesses` shape — has
        // something to write. Deriving it here rather than at OTM export time keeps the two formats
        // reading one canonical field instead of two.
        cwes: cweStrings(raw.weaknesses),
      }));
      bagUnknown(threat, raw, THREAT_KEYS);

      var affected = asArray(raw.components_affected);
      var seen = Object.create(null);
      for (var a = 0; a < affected.length; a++) {
        var targetId = idOf(names, affected[a]);
        if (targetId === null || seen[targetId]) continue;
        seen[targetId] = true;
        // §4.10 types every `components_affected` entry as a component, and that is the default
        // here. It is not the only possibility: TML types the field as a bare `symbolic-name` and
        // the vendored wallet example lists a data store in it, so a name can belong to something
        // else. The export half already relies on that — it resolves the name across every
        // collection precisely so an existing reference is not called dangling — and typing every
        // entry `component` here made the two halves disagree about the same document: a threat
        // applied to a data flow was written to TML by name and read back as a reference to a
        // component that does not exist, so an exported document failed its own re-import
        // (REQ-IMP-007's promise, broken on the way out rather than the way in). A data flow is a
        // member of the canonical `targetType` vocabulary, so it is the one alternative this model
        // can record exactly. Everything else keeps the spec's `component` default, and where that
        // does not resolve, REQ-IMP-004 reports it.
        var app = model.insert(m, 'threatApplication', {
          threatId: threat.id,
          targetType: model.get(m, 'dataFlow', targetId) ? 'dataFlow' : 'component',
          targetId: targetId,
        });
        report.generatedIds.push(app.id);
      }
    }
  }

  var THREAT_KEYS = {
    symbolic_name: 1, title: 1, description: 1, components_affected: 1, threat_persona: 1, event: 1,
    sources: 1, attack_mechanisms: 1, weaknesses: 1,
  };

  function importControls(m, tml, names, report) {
    var list = asArray(tml.controls);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var control = model.insert(m, 'control', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        threatIds: refList(names, raw.threats),
        status: core.isString(raw.status) ? raw.status : undefined,
        priority: core.isString(raw.priority) ? raw.priority : undefined,
        trustBoundary: trustBoundaryOf(names, raw.trust_boundary),
      }));
      bagUnknown(control, raw, CONTROL_KEYS);
    }
  }

  var CONTROL_KEYS = {
    symbolic_name: 1, title: 1, description: 1, threats: 1, trust_boundary: 1, status: 1, priority: 1,
  };

  function trustBoundaryOf(names, value) {
    if (!core.isObject(value)) return undefined;
    var out = Object.create(null);
    var a = idOf(names, value.trust_zone_a);
    var b = idOf(names, value.trust_zone_b);
    if (a !== null) out.zoneAId = a;
    if (b !== null) out.zoneBId = b;
    var unknown = unknownKeys(value, { trust_zone_a: 1, trust_zone_b: 1 });
    if (unknown) {
      var keys = Object.keys(unknown);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = unknown[keys[i]];
    }
    return out;
  }

  /**
   * A risk, with `score` and `level` **stored as given**.
   *
   * They are derivable from `likelihood` × `impact`, and recomputing them would be the obvious
   * thing to do — and wrong. An imported model is not always internally consistent, and silently
   * "correcting" someone's assessment misrepresents it. The editor flags a mismatch instead
   * (`03-data-model.md` §4.12).
   */
  function importRisks(m, tml, names, report) {
    var list = asArray(tml.risks);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var risk = model.insert(m, 'risk', defined({
        id: idOf(names, raw.symbolic_name),
        name: text(raw.title),
        description: text(raw.description),
        slug: slugOrUndefined(raw.symbolic_name),
        threatIds: refList(names, raw.threats),
        likelihood: core.isString(raw.likelihood) ? raw.likelihood : undefined,
        impact: core.isString(raw.impact) ? raw.impact : undefined,
        impactDescription: core.isString(raw.impact_description) ? raw.impact_description : undefined,
        score: intOr(raw.score),
        level: core.isString(raw.level) ? raw.level : undefined,
      }));
      bagUnknown(risk, raw, RISK_KEYS);
    }
  }

  var RISK_KEYS = {
    symbolic_name: 1, title: 1, description: 1, threats: 1, likelihood: 1, impact: 1,
    impact_description: 1, score: 1, level: 1,
  };

  /**
   * `mitigation_plans` is not a property of the vendored TML 1.0.2 root schema, though
   * `$defs/mitigation-plan` exists and §6.1 maps the entity. It is read when present so a document
   * that carries it — from an older or future schema, or another tool — round-trips into the
   * canonical model. Export drops them again and discloses the loss; the note above `exportExtensions`
   * says why.
   */
  function importMitigationPlans(m, tml, names, report) {
    var list = asArray(tml.mitigation_plans);
    if (list.length) {
      report.notes.push(
        'This document has mitigation_plans, which the vendored TML 1.0.2 schema does not declare. ' +
          'They were imported, and a later TML export will report them as dropped.',
      );
    }
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      // `risk` and `controls` are the schema's names; a real document may spell them either way.
      var riskRef = raw.risk !== undefined ? raw.risk : raw.riskId;
      var controls = raw.controls !== undefined ? raw.controls : raw.control_ids;
      model.insert(m, 'mitigationPlan', defined({
        id: core.uuid(),
        riskId: idOf(names, riskRef),
        controlIds: refList(names, controls),
      }));
    }
  }

  function importAssumptions(m, tml, report) {
    var list = asArray(tml.assumptions);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      // No `symbolic_name` in TML's assumption, so the id is minted. `name` is left empty rather
      // than derived from the description: a title invented from prose is a claim about what the
      // assumption is *about*, and the description is right there for the UI to show.
      var assumption = model.insert(m, 'assumption', defined({
        id: core.uuid(),
        name: '',
        description: core.isString(raw.description) ? raw.description : undefined,
        validity: core.isString(raw.validity) ? raw.validity : undefined,
        topics: stringList(raw.topics),
      }));
      report.generatedIds.push(assumption.id);
      bagUnknown(assumption, raw, { description: 1, topics: 1, validity: 1 });
    }
  }

  function importDiagrams(m, tml, report) {
    var list = asArray(tml.diagrams);
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!core.isObject(raw)) continue;
      var diagram = model.insert(m, 'diagram', defined({
        id: core.uuid(),
        name: text(raw.title),
        description: text(raw.description),
        type: core.isString(raw.type) ? raw.type : undefined,
        source: core.isString(raw.source) ? raw.source : undefined,
        link: core.isString(raw.link) ? raw.link : undefined,
      }));
      report.generatedIds.push(diagram.id);
      bagUnknown(diagram, raw, { title: 1, description: 1, link: 1, type: 1, source: 1 });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Export — canonical → TML (§6.2)
  // ---------------------------------------------------------------------------------------------

  /**
   * Every value this mapper invents, named in one place.
   *
   * §8 requires a disclosed synthesis rather than a silent one, and it names the defaults for the
   * fields it discusses — `assumed`, `none`, `["adversary"]` — which are all reproduced verbatim
   * here. Where it does not name one, the rule taken is **the first member the schema declares**
   * (`rare`, `negligible`, `very_low`, `script_kid`, `anonymous`, `minimal`, `unconfirmed`), because
   * that is what the named defaults turn out to be, so the rule is the spec's own rather than one
   * invented alongside it.
   *
   * Two deliberate departures from it:
   *
   *   - **`scopeTier` is `non_critical`, not the first member `mission_critical`.** A tier is a claim
   *     about how much the system matters, and the direction of the error matters: understating it
   *     loses a warning, overstating it invents importance the author never asserted. §8's "a false
   *     statement" bar is not symmetric, so the default is not either.
   *   - **booleans are `false`.** `false` asserts no capability and no condition, so it cannot
   *     overstate; the disclosure carries the caveat. The alternative — midpoint — is what the OTM
   *     mapper uses for the 0–100 numbers, where the schema offers no member to prefer and no
   *     direction that is safer than another.
   */
  var DEFAULTS = {
    scopeBusinessCriticality: 'minimal',
    scopeExposure: 'internal',
    scopeTier: 'non_critical',
    controlStatus: 'assumed',
    controlPriority: 'none',
    threatSources: ['adversary'],
    likelihood: 'rare',
    impact: 'negligible',
    riskLevel: 'very_low',
    riskScore: 1,
    personaSkill: 'script_kid',
    personaAccess: 'anonymous',
    personaApplicability: 'minimal',
    assumptionValidity: 'unconfirmed',
  };

  /** The placeholder zone for entities TML requires a `trust_zone` for and the model does not give. */
  var PLACEHOLDER_ZONE = { id: 'tmv-unassigned', name: 'Unassigned' };

  function fromCanonical(m, options) {
    var opts = options || {};
    var report = emptyReport('tml');

    var names = symbolicNames(m, { remember: opts.remember });

    var doc = Object.create(null);
    var schema = model.bag(m, 'tml');
    // Re-emit the recorded `$schema` when there is one, so a document imported from TML 1.0.1 comes
    // back as 1.0.1 rather than being silently upgraded. Both forms match the schema's own pattern.
    doc.$schema = schema && core.isString(schema.$schema) ? schema.$schema : SCHEMA_URL;
    doc.version = core.present(m.metadata.version) ? versionString(m.metadata.version, report) : DEFAULT_VERSION;
    if (!core.present(m.metadata.version)) {
      disclose(report, 'version', 'model', m.modelId, 'no version was set, so "' + DEFAULT_VERSION + '" was written');
    }
    doc.scope = exportScope(m, report);
    if (core.present(m.description)) doc.description = m.description;
    exportMetadata(m, doc);
    exportDiagrams(m, doc, report);

    // TML requires these nine arrays to exist even when empty, so a model with no boundaries emits
    // `"trust_boundaries": []` rather than omitting the key (P3 in `03-data-model.md`).
    doc.trust_zones = [];
    doc.trust_boundaries = [];
    doc.actors = [];
    doc.components = [];
    doc.data_stores = [];
    doc.data_sets = [];
    doc.data_flows = [];

    exportTrustZones(m, doc, names, report);
    exportTrustBoundaries(m, doc, names, report);
    exportActors(m, doc, names, report);
    exportComponents(m, doc, names, report);
    exportDataStores(m, doc, names, report);
    exportDataSets(m, doc, names, report);
    exportDataFlows(m, doc, names, report);

    doc.assumptions = exportAssumptions(m, report);
    doc.threat_personas = exportPersonas(m, doc, names, report);
    doc.threats = exportThreats(m, names, report);
    doc.controls = exportControls(m, names, report);

    var risks = exportRisks(m, names, report);
    if (risks) doc.risks = risks;

    var extensions = exportExtensions(m, opts, report);
    if (extensions) doc.extensions = extensions;
    if (schema && core.isObject(schema.extras)) {
      var keys = Object.keys(schema.extras);
      for (var i = 0; i < keys.length; i++) if (!(keys[i] in doc)) doc[keys[i]] = core.deepCopy(schema.extras[keys[i]]);
    }

    report.dropped = report.dropped.concat(tmlDrops(m));
    return { document: doc, report: report, blocked: report.blocked, ok: report.blocked.length === 0 };
  }

  function exportScope(m, report) {
    var scope = core.isObject(m.scope) ? m.scope : {};
    var out = {
      title: core.present(scope.title) ? scope.title : '',
      description: core.present(scope.description) ? scope.description : '',
      business_criticality: core.present(scope.businessCriticality) ? scope.businessCriticality : DEFAULTS.scopeBusinessCriticality,
      // 0..n, so an empty list is legal and needs no synthesis — the one scope field that can
      // honestly say "nothing was assessed".
      data_sensitivity: core.isArray(scope.dataSensitivity) ? scope.dataSensitivity.slice() : [],
      exposure: core.present(scope.exposure) ? scope.exposure : DEFAULTS.scopeExposure,
      tier: core.present(scope.tier) ? scope.tier : DEFAULTS.scopeTier,
    };
    if (!core.present(scope.title)) disclose(report, 'scope.title', 'model', m.modelId, 'no scope title was set');
    if (!core.present(scope.description)) disclose(report, 'scope.description', 'model', m.modelId, 'no scope description was set');
    if (!core.present(scope.businessCriticality)) {
      disclose(report, 'scope.business_criticality', 'model', m.modelId, 'no business criticality was set');
    }
    if (!core.present(scope.exposure)) disclose(report, 'scope.exposure', 'model', m.modelId, 'no exposure was set');
    if (!core.present(scope.tier)) disclose(report, 'scope.tier', 'model', m.modelId, 'no tier was set');
    if (core.isObject(scope.x)) {
      var keys = Object.keys(scope.x);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = core.deepCopy(scope.x[keys[i]]);
    }
    return out;
  }

  function exportMetadata(m, doc) {
    var map = [
      ['frozen', 'frozen'],
      ['releasedAt', 'released_at'],
      ['productReleaseDate', 'product_release_date'],
      ['reviewedAt', 'reviewed_at'],
      ['repoLink', 'repo_link'],
      ['releaseDocsLink', 'release_docs_link'],
    ];
    for (var i = 0; i < map.length; i++) {
      var value = m.metadata[map[i][0]];
      if (core.isString(value) || core.isBoolean(value)) doc[map[i][1]] = value;
    }
  }

  /**
   * `metadata.version` must match `^\d+(\.\d+)*$`. A version that does not is not quietly dropped —
   * it is preserved in the bag and the exported value is disclosed, so the round trip keeps both.
   */
  function versionString(value, report) {
    if (/^\d+(\.\d+)*$/.test(value)) return value;
    disclose(report, 'version', 'model', '', 'the model version "' + value + '" is not a dotted numeric version');
    var bag = report.bagRestore || (report.bagRestore = Object.create(null));
    bag.version = value;
    return DEFAULT_VERSION;
  }

  function exportDiagrams(m, doc, report) {
    doc.diagrams = [];
    for (var i = 0; i < m.diagrams.length; i++) {
      var diagram = m.diagrams[i];
      var out = {
        title: core.present(diagram.name) ? diagram.name : '',
        type: core.present(diagram.type) ? diagram.type : 'mermaid',
        source: core.isString(diagram.source) ? diagram.source : '',
      };
      if (!core.present(diagram.type)) disclose(report, 'diagrams[].type', 'diagram', diagram.id, 'no diagram type was set');
      if (core.present(diagram.description)) out.description = diagram.description;
      if (core.present(diagram.link)) out.link = diagram.link;
      doc.diagrams.push(out);
    }
  }

  function exportTrustZones(m, doc, names, report) {
    // A placeholder for whatever needs a zone and has none, created once and disclosed (§6.2's
    // precedent for OTM's required `parent`, applied to TML's required `trust_zone`).
    var placeholder = null;
    function ensurePlaceholder() {
      if (placeholder) return placeholder;
      placeholder = PLACEHOLDER_ZONE.id;
      doc.trust_zones.push({
        symbolic_name: PLACEHOLDER_ZONE.id,
        title: PLACEHOLDER_ZONE.name,
        description:
          'Added by Threat-Model-Viewport: TML requires every component, actor and data store to be in a ' +
          'trust zone, and these are in none.',
      });
      disclose(report, 'trust_zone', 'model', m.modelId, 'a placeholder trust zone "Unassigned" was added for entities with no trust zone');
      return placeholder;
    }
    report.placeholderZone = ensurePlaceholder;
    for (var i = 0; i < m.trustZones.length; i++) {
      var zone = m.trustZones[i];
      doc.trust_zones.push({
        symbolic_name: nameFor(names, 'trustZones', zone.id),
        title: core.present(zone.name) ? zone.name : '',
        description: core.present(zone.description) ? zone.description : '',
      });
    }
  }

  /** The symbolic name of a zone, or the placeholder if the entity is in none. */
  function zoneName(doc, names, report, zoneId) {
    if (core.present(zoneId) && nameFor(names, 'trustZones', zoneId)) return nameFor(names, 'trustZones', zoneId);
    return typeof report.placeholderZone === 'function' ? report.placeholderZone() : PLACEHOLDER_ZONE.id;
  }

  function exportTrustBoundaries(m, doc, names, report) {
    for (var i = 0; i < m.trustBoundaries.length; i++) {
      var boundary = m.trustBoundaries[i];
      var a = nameFor(names, 'trustZones', boundary.zoneAId);
      var b = nameFor(names, 'trustZones', boundary.zoneBId);
      if (!a || !b) {
        dangling(report, {
          entity: 'trustBoundary',
          id: boundary.id,
          field: a ? 'zoneBId' : 'zoneAId',
          target: a ? boundary.zoneBId : boundary.zoneAId,
          what: 'a trust zone it separates',
        });
        continue;
      }
      var out = { trust_zone_a: a, trust_zone_b: b };
      copyBooleans(boundary, out, [
        ['accessTokenExpires', 'access_token_expires'],
        ['hasRefreshToken', 'has_refresh_token'],
        ['refreshTokenExpires', 'refresh_token_expires'],
        ['canUserLogout', 'can_user_logout'],
        ['canSystemLogout', 'can_system_logout'],
      ]);
      copyInts(boundary, out, [['accessTokenTtl', 'access_token_ttl'], ['refreshTokenTtl', 'refresh_token_ttl']]);
      if (core.isArray(boundary.accessControlMethods) && boundary.accessControlMethods.length) {
        out.access_control_methods = boundary.accessControlMethods.slice();
      }
      if (core.isArray(boundary.authenticationMethods) && boundary.authenticationMethods.length) {
        out.authentication_methods = boundary.authenticationMethods.slice();
      }
      doc.trust_boundaries.push(out);
    }
  }

  function exportActors(m, doc, names, report) {
    for (var i = 0; i < m.actors.length; i++) {
      var actor = m.actors[i];
      var out = {
        symbolic_name: nameFor(names, 'actors', actor.id),
        title: core.present(actor.name) ? actor.name : '',
        description: core.present(actor.description) ? actor.description : '',
        type: core.present(actor.type) ? actor.type : 'user',
        // TML declares this a string and the canonical field is a list. One element round-trips
        // exactly; more than one has to be joined, which loses the boundary and is disclosed.
        permissions: permissionsString(actor, report),
        trust_zone: zoneName(doc, names, report, actor.trustZoneId),
      };
      if (!core.present(actor.type)) disclose(report, 'actors[].type', 'actor', actor.id, 'no actor type was set');
      doc.actors.push(out);
    }
  }

  function permissionsString(actor, report) {
    var list = core.isArray(actor.permissions) ? actor.permissions : [];
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    disclose(report, 'actors[].permissions', 'actor', actor.id, 'several permissions were joined into one string');
    return list.join('; ');
  }

  function exportComponents(m, doc, names, report) {
    for (var i = 0; i < m.components.length; i++) {
      var comp = m.components[i];
      var out = {
        symbolic_name: nameFor(names, 'components', comp.id),
        title: core.present(comp.name) ? comp.name : '',
        description: core.present(comp.description) ? comp.description : '',
        trust_zone: zoneName(doc, names, report, comp.trustZoneId || comp.parentId),
      };
      if (core.present(comp.parentId)) {
        var parentName = nameFor(names, 'components', comp.parentId);
        if (parentName) out.parent_component = parentName;
        // §8: a reference to an entity that is not there blocks. Omitting `parent_component` instead
        // would restructure the model on the way out — the component would read as a child of
        // nothing, which is a claim the author never made, and it is not one the export report can
        // describe either, because nothing was dropped: the field is simply absent.
        else {
          dangling(report, {
            entity: 'component',
            id: comp.id,
            field: 'parent_component',
            target: comp.parentId,
            what: 'its parent component',
          });
        }
      }
      if (core.present(comp.repoLink)) out.repo_link = comp.repoLink;
      doc.components.push(out);
    }
  }

  function exportDataStores(m, doc, names, report) {
    for (var i = 0; i < m.dataStores.length; i++) {
      var store = m.dataStores[i];
      var out = {
        symbolic_name: nameFor(names, 'dataStores', store.id),
        title: core.present(store.name) ? store.name : '',
        description: core.present(store.description) ? store.description : '',
        type: core.present(store.type) ? store.type : 'sql',
        trust_zone: zoneName(doc, names, report, store.trustZoneId),
      };
      if (!core.present(store.type)) disclose(report, 'data_stores[].type', 'dataStore', store.id, 'no data store type was set');
      if (core.present(store.vendor)) out.vendor = store.vendor;
      if (core.present(store.product)) out.product = store.product;
      doc.data_stores.push(out);
    }
  }

  function exportDataSets(m, doc, names, report) {
    for (var i = 0; i < m.dataSets.length; i++) {
      var set = m.dataSets[i];
      var out = {
        symbolic_name: nameFor(names, 'dataSets', set.id),
        title: core.present(set.name) ? set.name : '',
        description: core.present(set.description) ? set.description : '',
        placements: [],
        data_sensitivity: core.isArray(set.dataSensitivity) ? set.dataSensitivity.slice() : [],
      };
      var placements = core.isArray(set.placements) ? set.placements : [];
      for (var p = 0; p < placements.length; p++) {
        var row = placements[p];
        if (!core.isObject(row)) continue;
        var name = nameFor(names, 'dataStores', row.dataStoreId);
        if (!name) {
          dangling(report, {
            entity: 'dataSet',
            id: set.id,
            field: 'placements[].dataStoreId',
            target: row.dataStoreId,
            what: 'a data store it is placed in',
          });
          continue;
        }
        var placement = { data_store: name };
        if (core.isBoolean(row.encrypted)) placement.encrypted = row.encrypted;
        out.placements.push(placement);
      }
      if (core.isArray(set.accessControlMethods) && set.accessControlMethods.length) {
        out.access_control_methods = set.accessControlMethods.slice();
      }
      if (core.isNumber(set.recordCount)) out.record_count = Math.round(set.recordCount);
      doc.data_sets.push(out);
    }
  }

  function exportDataFlows(m, doc, names, report) {
    for (var i = 0; i < m.dataFlows.length; i++) {
      var flow = m.dataFlows[i];
      var missing = [];
      if (!core.present(flow.sourceId)) missing.push('source');
      if (!core.present(flow.destinationId)) missing.push('destination');
      if (missing.length) {
        blockedPush(report, {
          code: 'TML_NO_ENDPOINTS',
          entity: 'dataFlow',
          id: flow.id,
          field: missing.join(', '),
          message:
            '"' + (core.present(flow.name) ? flow.name : flow.id) + '" has no ' + missing.join(' or ') +
            '. A data flow needs both ends to mean anything — set ' + (missing.length > 1 ? 'them' : 'it') + ' and export again.',
        });
        continue;
      }
      var source = flowEndpoint(doc, names, report, flow.sourceId, flow.sourceType);
      var destination = flowEndpoint(doc, names, report, flow.destinationId, flow.destinationType);
      if (!source || !destination) {
        dangling(report, {
          entity: 'dataFlow',
          id: flow.id,
          field: source ? 'destinationId' : 'sourceId',
          target: source ? flow.destinationId : flow.sourceId,
          what: 'the entity at that end of the flow',
        });
        continue;
      }
      var out = {
        symbolic_name: nameFor(names, 'dataFlows', flow.id),
        title: core.present(flow.name) ? flow.name : '',
        description: core.present(flow.description) ? flow.description : '',
        source: source,
        destination: destination,
        has_sensitive_data: core.isBoolean(flow.hasSensitiveData) ? flow.hasSensitiveData : false,
        encrypted: core.isBoolean(flow.encrypted) ? flow.encrypted : false,
      };
      if (!core.isBoolean(flow.hasSensitiveData)) {
        disclose(report, 'data_flows[].has_sensitive_data', 'dataFlow', flow.id, 'whether the flow carries sensitive data was not stated');
      }
      if (!core.isBoolean(flow.encrypted)) {
        disclose(report, 'data_flows[].encrypted', 'dataFlow', flow.id, 'whether the flow is encrypted was not stated');
      }
      doc.data_flows.push(out);
    }
  }

  /**
   * `{type, object}` — the endpoint's kind and its symbolic name, or `null` if it names nothing.
   *
   * The endpoint's type is used for two unrelated lookups here, and keeping them apart is the whole
   * difficulty: which collection the id lives in (a canonical question, answered by the model's own
   * `FLOW_ENDPOINT_TARGET`), and which spelling to write into the document (a TML question, answered
   * by `ENDPOINT_OUT`). Everything therefore goes through `ENDPOINT_IN` first, which also means a
   * document that spells the type `data-store`, `data_store` or `#/$defs/data-store` resolves the
   * same way — `typed-symbolic-name.type` is free-form, and all three occur in the wild.
   *
   * This was wrong in a way worth naming, because every test that existed was blind to it: the
   * *output* spelling was used as the key into the *canonical* collection table. For the two
   * spellings that happen to agree it worked by accident, so the defect hid until a flow ended at a
   * data store whose spelling differed — at which point the lookup missed and **every such flow was
   * reported dangling**, blocking an export for a model that was perfectly complete. It surfaced the
   * first time a model with a store-ended flow was exported back to TML, which the import-side
   * round-trip tests had never done.
   */
  function flowEndpoint(doc, names, report, id, type) {
    var kind = ENDPOINT_IN[core.isString(type) ? type : ''];
    // The collection table is the model's own, not a copy: it is the same map the editor and the
    // validator use to decide where a flow endpoint's id lives, and a second copy here would be free
    // to drift from it in exactly the silent way described above.
    var key = TMV.model.FLOW_ENDPOINT_TARGET[kind];
    var out = ENDPOINT_OUT[kind];
    if (!key || !out) return null;
    var name = nameFor(names, key, id);
    if (!name) return null;
    return { type: out, object: name };
  }

  function exportAssumptions(m, report) {
    var out = [];
    for (var i = 0; i < m.assumptions.length; i++) {
      var assumption = m.assumptions[i];
      var row = {
        description: core.isString(assumption.description) ? assumption.description : '',
        validity: core.present(assumption.validity) ? assumption.validity : DEFAULTS.assumptionValidity,
      };
      // `03-data-model.md` §4.14: the TML specification says no topic taxonomy is standardised and
      // that `topics` must not be specified. A value that was imported is preserved; none is ever
      // written where there was none.
      if (core.isArray(assumption.topics) && assumption.topics.length) row.topics = assumption.topics.slice();
      out.push(row);
      if (!core.present(assumption.validity)) {
        disclose(report, 'assumptions[].validity', 'assumption', assumption.id, 'no validity was set');
      }
    }
    return out;
  }

  function exportPersonas(m, doc, names, report) {
    var out = [];
    for (var i = 0; i < m.threatPersonas.length; i++) {
      var persona = m.threatPersonas[i];
      var row = {
        symbolic_name: nameFor(names, 'threatPersonas', persona.id),
        title: core.present(persona.name) ? persona.name : '',
        description: core.present(persona.description) ? persona.description : '',
        is_person: core.isBoolean(persona.isPerson) ? persona.isPerson : false,
        skill_level: core.present(persona.skillLevel) ? persona.skillLevel : DEFAULTS.personaSkill,
        access_level: core.present(persona.accessLevel) ? persona.accessLevel : DEFAULTS.personaAccess,
        malicious_intent: core.isBoolean(persona.maliciousIntent) ? persona.maliciousIntent : false,
        applicability_to_org: core.present(persona.applicabilityToOrg) ? persona.applicabilityToOrg : DEFAULTS.personaApplicability,
      };
      var fields = [['skill_level', 'skillLevel'], ['access_level', 'accessLevel'], ['applicability_to_org', 'applicabilityToOrg']];
      for (var f = 0; f < fields.length; f++) {
        if (!core.present(persona[fields[f][1]])) {
          disclose(report, 'threat_personas[].' + fields[f][0], 'threatPersona', persona.id, 'no ' + fields[f][1] + ' was set');
        }
      }
      if (!core.isBoolean(persona.isPerson)) disclose(report, 'threat_personas[].is_person', 'threatPersona', persona.id, 'not stated');
      if (!core.isBoolean(persona.maliciousIntent)) disclose(report, 'threat_personas[].malicious_intent', 'threatPersona', persona.id, 'not stated');
      out.push(row);
    }
    return out;
  }

  /**
   * Threats, with `components_affected[]` regrouped from the flat join entity.
   *
   * `personaId` is required and blocks when it is missing: inventing an adversary attributes intent
   * the author never asserted (§8). `sources` is required and non-empty, so an empty list is
   * synthesized and disclosed — the enum has no neutral member.
   */
  function exportThreats(m, names, report) {
    var out = [];

    // An application whose threat is gone is not reachable from any threat row below — the loop
    // groups applications *under* their threat — so without this it would be dropped in silence
    // rather than blocked. §8 blocks a reference to a deleted entity: the assessment would vanish
    // from the document while the model still claimed it.
    for (var oa = 0; oa < m.threatApplications.length; oa++) {
      var orphan = m.threatApplications[oa];
      if (nameFor(names, 'threats', orphan.threatId)) continue;
      dangling(report, {
        entity: 'threatApplication',
        id: orphan.id,
        field: 'threatId',
        target: orphan.threatId,
        what: 'the threat it applies',
      });
    }

    for (var i = 0; i < m.threats.length; i++) {
      var threat = m.threats[i];
      if (!core.present(threat.personaId)) {
        blockedPush(report, {
          code: 'TML_NO_PERSONA',
          entity: 'threat',
          id: threat.id,
          field: 'personaId',
          message:
            '"' + (core.present(threat.name) ? threat.name : threat.id) + '" has no threat persona. TML requires one, ' +
            'and inventing an adversary would attribute intent you never asserted. Choose a persona and export again.',
        });
        continue;
      }
      if (!nameFor(names, 'threatPersonas', threat.personaId)) {
        blockedPush(report, {
          code: 'TML_DANGLING_REF',
          entity: 'threat',
          id: threat.id,
          field: 'personaId',
          message: '"' + (core.present(threat.name) ? threat.name : threat.id) + '" names a threat persona that no longer exists. Restore it or choose another.',
        });
        continue;
      }
      var row = {
        symbolic_name: nameFor(names, 'threats', threat.id),
        title: core.present(threat.name) ? threat.name : '',
        description: core.present(threat.description) ? threat.description : '',
        threat_persona: nameFor(names, 'threatPersonas', threat.personaId),
        event: core.isString(threat.event) ? threat.event : '',
        sources: core.isArray(threat.sources) && threat.sources.length ? threat.sources.slice() : DEFAULTS.threatSources.slice(),
      };
      if (!core.isArray(threat.sources) || threat.sources.length === 0) {
        disclose(report, 'threats[].sources', 'threat', threat.id, 'no sources were set');
      }
      if (!core.isString(threat.event)) disclose(report, 'threats[].event', 'threat', threat.id, 'no event was set');
      var affected = [];
      for (var a = 0; a < m.threatApplications.length; a++) {
        var app = m.threatApplications[a];
        if (app.threatId !== threat.id) continue;
        // Looked up across *every* symbolic name, not just the components, because TML types
        // `components_affected` as a bare `symbolic-name` — the field's name says "components" and
        // its schema does not. The vendored wallet example lists `store-wallet-file` there, which is
        // a data store. §4.10 mandates `targetType: "component"` on the way in, so the app looks
        // like a component reference; resolving it only among components would call a reference
        // that exists in the source document dangling, and block the export over it.
        var name = anyNameFor(names, app.targetId);
        if (!name) {
          dangling(report, {
            entity: 'threat',
            id: threat.id,
            field: 'components_affected',
            target: app.targetId,
            what: 'an entity this threat applies to',
          });
          continue;
        }
        if (affected.indexOf(name) === -1) affected.push(name);
      }
      if (affected.length) row.components_affected = affected;
      var mechanisms = capecOut(threat.attackMechanisms);
      if (mechanisms.length) row.attack_mechanisms = mechanisms;
      var weaknesses = weaknessesOut(threat, report);
      if (weaknesses.length) row.weaknesses = weaknesses;
      out.push(row);
    }
    return out;
  }

  /**
   * `weaknesses` comes from the canonical `weaknesses` when there is one, so a TML → canonical → TML
   * round trip is exact. Only a model that came from OTM — which has `cwes` as free strings and no
   * `weaknesses` shape — needs the parse, and the parse is where §6.2's lossiness lives:
   * `"CWE-89"` becomes `{cweId: 89}`, and anything else is reported and dropped.
   */
  function weaknessesOut(threat, report) {
    var list = core.isArray(threat.weaknesses) ? threat.weaknesses : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!core.isObject(row) || !core.isNumber(row.cweId)) continue;
      var ref = { cwe_id: Math.round(row.cweId) };
      if (core.isString(row.cweTitle)) ref.cwe_title = row.cweTitle;
      out.push(ref);
    }
    if (out.length) return out;

    var cwes = core.isArray(threat.cwes) ? threat.cwes : [];
    for (var c = 0; c < cwes.length; c++) {
      var id = parseCwe(cwes[c]);
      if (id === null) {
        report.droppedRefs.push({ from: 'threat ' + threat.id, kind: 'cwes', to: cwes[c] });
        continue;
      }
      out.push({ cwe_id: id });
    }
    return out;
  }

  /** `"CWE-89"` → `89`. Anything without a number in it is not a CWE identifier. */
  function parseCwe(value) {
    if (!core.isString(value)) return null;
    var match = value.match(/(\d+)/);
    if (!match) return null;
    var id = parseInt(match[1], 10);
    return core.isNumber(id) && id > 0 ? id : null;
  }

  function capecOut(list) {
    var out = [];
    if (!core.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!core.isObject(row) || !core.isNumber(row.capecId)) continue;
      var ref = { capec_id: Math.round(row.capecId) };
      if (core.isString(row.capecTitle)) ref.capec_title = row.capecTitle;
      out.push(ref);
    }
    return out;
  }

  function exportControls(m, names, report) {
    var out = [];
    for (var i = 0; i < m.controls.length; i++) {
      var control = m.controls[i];
      var threatIds = core.isArray(control.threatIds) ? control.threatIds : [];
      if (threatIds.length === 0) {
        blockedPush(report, {
          code: 'TML_NO_THREATS',
          entity: 'control',
          id: control.id,
          field: 'threatIds',
          message:
            '"' + (core.present(control.name) ? control.name : control.id) + '" does not say which threats it addresses. ' +
            'TML requires at least one, and inventing a link would fabricate an assessment. Link it to a threat and export again.',
        });
        continue;
      }
      var linked = [];
      for (var t = 0; t < threatIds.length; t++) {
        var name = nameFor(names, 'threats', threatIds[t]);
        if (!name) {
          dangling(report, {
            entity: 'control',
            id: control.id,
            field: 'threatIds',
            target: threatIds[t],
            what: 'a threat it addresses',
          });
          continue;
        }
        if (linked.indexOf(name) === -1) linked.push(name);
      }
      if (linked.length === 0) {
        blockedPush(report, {
          code: 'TML_DANGLING_REF',
          entity: 'control',
          id: control.id,
          field: 'threatIds',
          message: '"' + (core.present(control.name) ? control.name : control.id) + '" names only threats that no longer exist.',
        });
        continue;
      }
      var row = {
        symbolic_name: nameFor(names, 'controls', control.id),
        title: core.present(control.name) ? control.name : '',
        description: core.present(control.description) ? control.description : '',
        threats: linked,
        status: core.present(control.status) ? control.status : DEFAULTS.controlStatus,
        priority: core.present(control.priority) ? control.priority : DEFAULTS.controlPriority,
      };
      if (!core.present(control.status)) disclose(report, 'controls[].status', 'control', control.id, 'no status was set');
      if (!core.present(control.priority)) disclose(report, 'controls[].priority', 'control', control.id, 'no priority was set');
      var boundary = trustBoundaryOut(control.trustBoundary, names, report, control.id);
      if (boundary) row.trust_boundary = boundary;
      out.push(row);
    }
    return out;
  }

  function trustBoundaryOut(value, names, report, controlId) {
    if (!core.isObject(value)) return null;
    var a = nameFor(names, 'trustZones', value.zoneAId);
    var b = nameFor(names, 'trustZones', value.zoneBId);
    if (!a || !b) {
      dangling(report, {
        entity: 'control',
        id: controlId,
        field: 'trustBoundary',
        target: a ? value.zoneBId : value.zoneAId,
        what: 'a trust zone the boundary runs between',
      });
      return null;
    }
    var out = { trust_zone_a: a, trust_zone_b: b };
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === 'zoneAId' || keys[i] === 'zoneBId') continue;
      out[keys[i]] = core.deepCopy(value[keys[i]]);
    }
    return out;
  }

  function exportRisks(m, names, report) {
    if (m.risks.length === 0) return null;
    var out = [];
    for (var i = 0; i < m.risks.length; i++) {
      var risk = m.risks[i];
      var threatIds = core.isArray(risk.threatIds) ? risk.threatIds : [];
      if (threatIds.length === 0) {
        blockedPush(report, {
          code: 'TML_NO_THREATS',
          entity: 'risk',
          id: risk.id,
          field: 'threatIds',
          message:
            '"' + (core.present(risk.name) ? risk.name : risk.id) + '" does not say which threats it covers. ' +
            'TML requires at least one, and inventing a link would fabricate an assessment.',
        });
        continue;
      }
      var linked = [];
      for (var t = 0; t < threatIds.length; t++) {
        var name = nameFor(names, 'threats', threatIds[t]);
        if (!name) {
          dangling(report, {
            entity: 'risk',
            id: risk.id,
            field: 'threatIds',
            target: threatIds[t],
            what: 'a threat it covers',
          });
          continue;
        }
        if (linked.indexOf(name) === -1) linked.push(name);
      }
      if (linked.length === 0) {
        blockedPush(report, {
          code: 'TML_DANGLING_REF',
          entity: 'risk',
          id: risk.id,
          field: 'threatIds',
          message: '"' + (core.present(risk.name) ? risk.name : risk.id) + '" names only threats that no longer exist.',
        });
        continue;
      }
      var likelihood = core.present(risk.likelihood) ? risk.likelihood : DEFAULTS.likelihood;
      var impact = core.present(risk.impact) ? risk.impact : DEFAULTS.impact;
      if (!core.present(risk.likelihood)) disclose(report, 'risks[].likelihood', 'risk', risk.id, 'no likelihood was set');
      if (!core.present(risk.impact)) disclose(report, 'risks[].impact', 'risk', risk.id, 'no impact was set');
      // `score` and `level` are stored, not recomputed, so a model's own values are written through
      // even when they disagree with its inputs. Only a missing pair is filled in, and it is filled
      // in consistently with the enums that were just written.
      var score = core.isNumber(risk.score) ? Math.round(risk.score) : DEFAULT_SCORES[likelihood + '/' + impact];
      if (!core.isNumber(risk.score)) {
        disclose(report, 'risks[].score', 'risk', risk.id, 'no score was set');
        if (!core.isNumber(score)) score = DEFAULTS.riskScore;
      }
      out.push({
        symbolic_name: nameFor(names, 'risks', risk.id),
        title: core.present(risk.name) ? risk.name : '',
        description: core.present(risk.description) ? risk.description : '',
        threats: linked,
        likelihood: likelihood,
        impact: impact,
        impact_description: core.isString(risk.impactDescription) ? risk.impactDescription : '',
        score: score,
        level: core.present(risk.level) ? risk.level : DEFAULTS.riskLevel,
      });
      if (!core.present(risk.level)) disclose(report, 'risks[].level', 'risk', risk.id, 'no risk level was set');
    }
    return out;
  }

  /** The 5×5 matrix product, so a synthesized `score` agrees with the enums beside it. */
  var DEFAULT_SCORES = (function () {
    var likelihood = TMV.model.VOCAB.likelihood;
    var impact = TMV.model.VOCAB.impact;
    var out = Object.create(null);
    for (var i = 0; i < likelihood.length; i++) {
      for (var j = 0; j < impact.length; j++) out[likelihood[i] + '/' + impact[j]] = (i + 1) * (j + 1);
    }
    return out;
  })();

  /*
   * Mitigation plans are **not** written on TML export, and the reason is worth keeping here because
   * the code that read them back is still present a few hundred lines up (`importMitigationPlans`).
   *
   * `$defs/mitigation-plan` exists in the vendored TML 1.0.2 schema and §7's ledger lists the concept,
   * but the root has `additionalProperties: false` and declares no `mitigation_plans` property — so a
   * document carrying one does not validate, and §6.2's export table has no row for it. Writing it
   * anyway was tried and is not survivable: `interchange` validates its own output (REQ-EXP-001/002)
   * and a failed self-check blocks the download (REQ-EXP-010), so a model with one mitigation plan
   * could not be exported to TML at all — for a reason that reads to the user as a bug in the
   * application, which it was.
   *
   * Import still reads the key when a document from another tool carries it (§6.1 maps the entity),
   * so nothing is destroyed on the way in. What changes is the way out: the plans are dropped and
   * disclosed under REQ-EXP-003 like every other thing TML cannot hold. That is a worse outcome for
   * the data than a non-conforming key, and a better one than an export that refuses to run.
   */

  /**
   * Provenance goes in `extensions`, whose keys must match `domain.tld/extension-name` (§9, OQ-02).
   *
   * The project has no domain it owns, so it does not squat on one: provenance is written only when
   * a domain has been configured in Settings, and its absence is reported rather than silent.
   */
  function exportExtensions(m, opts, report) {
    var bag = model.bag(m, 'tml');
    var out = core.isObject(bag && bag.extensions) ? core.deepCopy(bag.extensions) : Object.create(null);
    if (core.isObject(opts.provenance)) {
      var domain = core.isString(opts.extensionDomain) ? opts.extensionDomain.trim() : '';
      if (!/^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]+$/.test(domain)) {
        report.omitted.push({
          what: 'provenance',
          why:
            'TML extension keys must be prefixed with a domain the project owns, and no domain is configured. ' +
            'Set one in Settings to have provenance survive a TML round trip.',
        });
      } else {
        var holder = Object.create(null);
        var keys = Object.keys(opts.provenance);
        for (var i = 0; i < keys.length; i++) holder[PROVENANCE_PREFIX + keys[i]] = core.deepCopy(opts.provenance[keys[i]]);
        out[domain + '/provenance'] = holder;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  // ---------------------------------------------------------------------------------------------
  // What TML cannot carry (§6.3)
  // ---------------------------------------------------------------------------------------------

  function tmlDrops(m) {
    var out = [];
    function count(kind, predicate, reason) {
      var n = 0;
      for (var i = 0; i < m[kind].length; i++) if (predicate(m[kind][i])) n += 1;
      if (n) out.push({ kind: kind, count: n, reason: reason });
    }
    var total = function (key) {
      return core.isArray(m[key]) ? m[key].length : 0;
    };
    if (total('assets')) {
      out.push({ kind: 'assets', count: total('assets'), reason: 'TML has no assets; confidentiality, integrity and availability have no equivalent' });
    }
    if (total('representations')) {
      out.push({ kind: 'representations', count: total('representations'), reason: 'TML diagrams are source text, not coordinate canvases' });
    }
    if (total('representationElements')) {
      out.push({ kind: 'representationElements', count: total('representationElements'), reason: 'same as representations' });
    }
    if (total('mitigationPlans')) {
      out.push({
        kind: 'mitigationPlans',
        count: total('mitigationPlans'),
        reason: 'the vendored TML 1.0.2 schema declares no mitigation_plans at the root, so writing one would produce a document that does not validate',
      });
    }
    count('trustZones', function (z) { return core.isNumber(z.trustRating); }, 'trustRating has no TML field');
    count('trustZones', function (z) { return core.present(z.parentId); }, 'zone nesting has no TML field');
    count('components', function (c) { return core.present(c.type) || (core.isArray(c.tags) && c.tags.length); }, 'component type and tags have no TML field');
    count('dataFlows', function (f) {
      return core.isBoolean(f.bidirectional) || (core.isArray(f.tags) && f.tags.length) || (core.isArray(f.assetIds) && f.assetIds.length);
    }, 'bidirectional, tags and asset links have no TML field');
    count('threats', function (t) {
      return (core.isArray(t.categories) && t.categories.length) || core.isNumber(t.likelihood) || core.isNumber(t.impact) ||
        core.present(t.likelihoodComment) || core.present(t.impactComment);
    }, 'OTM per-threat risk inputs have no TML field; express them as a risk instead');
    count('threatApplications', function () { return true; }, 'state and per-application control states have no TML field');
    count('controls', function (c) { return core.isNumber(c.riskReduction); }, 'riskReduction has no TML field');
    var metaDrops = ['owner', 'ownerContact', 'tags'];
    var n = 0;
    for (var i = 0; i < metaDrops.length; i++) if (m.metadata[metaDrops[i]] !== undefined && m.metadata[metaDrops[i]] !== null) n += 1;
    if (core.isArray(m.metadata.contributors) && m.metadata.contributors.length) n += 1;
    if (n) out.push({ kind: 'metadata', count: n, reason: 'owner, contacts, tags and contributors have no TML field' });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------

  function emptyReport(format) {
    return {
      format: format,
      blocked: [],
      dropped: [],
      folded: [],
      synthesized: [],
      droppedRefs: [],
      generatedIds: [],
      unmapped: [],
      omitted: [],
      notes: [],
      provenance: null,
    };
  }

  function disclose(report, field, entity, id, why) {
    report.synthesized.push({ field: field, entity: entity, id: id, why: why });
  }

  function blockedPush(report, item) {
    report.blocked.push(item);
  }

  /**
   * A reference that names something which is not there.
   *
   * §8 is explicit that this **blocks** rather than being dropped: "Exporting a dangling reference
   * produces a broken document in someone else's tool." That is the opposite of the treatment a
   * field with no TML home gets — a field is ours to lose, a reference is the recipient's to
   * resolve, and handing them a name that does not exist is worse than handing them nothing.
   *
   * `droppedRefs` therefore stays empty for TML. The one thing that lands there is an unparseable
   * CWE string, which is a *value* the format cannot express rather than a link to an entity.
   */
  function dangling(report, spec) {
    blockedPush(report, {
      code: 'TML_DANGLING_REF',
      entity: spec.entity,
      id: spec.id,
      field: spec.field,
      target: spec.target,
      message:
        'The ' + spec.entity + ' "' + spec.id + '" points at ' + spec.what + ' — "' + spec.target +
        '" — that is no longer in this model. Restore it, repoint the reference, or clear it, then export again.',
    });
  }

  function defined(source) {
    var out = Object.create(null);
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      if (source[keys[i]] !== undefined) out[keys[i]] = source[keys[i]];
    }
    return out;
  }

  /** Keep every key the mapping did not read, so an unmapped field survives (§10). */
  function bagUnknown(entity, raw, known) {
    var rest = unknownKeys(raw, known);
    if (rest) model.setBag(entity, 'tml', rest);
  }

  function unknownKeys(source, known) {
    var out = Object.create(null);
    var keys = Object.keys(source || {});
    for (var i = 0; i < keys.length; i++) {
      if (known[keys[i]]) continue;
      out[keys[i]] = core.deepCopy(source[keys[i]]);
    }
    return Object.keys(out).length ? out : null;
  }

  function readProvenance(extensions) {
    var out = Object.create(null);
    var found = false;
    var keys = Object.keys(extensions);
    for (var i = 0; i < keys.length; i++) {
      var value = extensions[keys[i]];
      if (!core.isObject(value)) continue;
      var inner = Object.keys(value);
      for (var j = 0; j < inner.length; j++) {
        if (inner[j].indexOf(PROVENANCE_PREFIX) !== 0) continue;
        out[inner[j].slice(PROVENANCE_PREFIX.length)] = value[inner[j]];
        found = true;
      }
    }
    return found ? out : null;
  }

  function stripProvenance(extensions) {
    var out = Object.create(null);
    var keys = Object.keys(extensions);
    for (var i = 0; i < keys.length; i++) {
      var value = extensions[keys[i]];
      if (!core.isObject(value)) {
        out[keys[i]] = core.deepCopy(value);
        continue;
      }
      var inner = Object.create(null);
      var innerKeys = Object.keys(value);
      for (var j = 0; j < innerKeys.length; j++) {
        if (innerKeys[j].indexOf(PROVENANCE_PREFIX) === 0) continue;
        inner[innerKeys[j]] = core.deepCopy(value[innerKeys[j]]);
      }
      if (Object.keys(inner).length) out[keys[i]] = inner;
    }
    return Object.keys(out).length ? out : null;
  }

  function cweRefs(list) {
    var out = [];
    var items = asArray(list);
    for (var i = 0; i < items.length; i++) {
      var raw = items[i];
      if (!core.isObject(raw) || !core.isNumber(raw.cwe_id)) continue;
      var row = Object.create(null);
      row.cweId = Math.round(raw.cwe_id);
      if (core.isString(raw.cwe_title)) row.cweTitle = raw.cwe_title;
      out.push(row);
    }
    return out.length ? out : undefined;
  }

  function capecRefs(list) {
    var out = [];
    var items = asArray(list);
    for (var i = 0; i < items.length; i++) {
      var raw = items[i];
      if (!core.isObject(raw) || !core.isNumber(raw.capec_id)) continue;
      var row = Object.create(null);
      row.capecId = Math.round(raw.capec_id);
      if (core.isString(raw.capec_title)) row.capecTitle = raw.capec_title;
      out.push(row);
    }
    return out.length ? out : undefined;
  }

  /** `"CWE-120"` strings derived from TML's `weaknesses`, for OTM export to write. */
  function cweStrings(list) {
    var refs = cweRefs(list);
    if (!refs) return undefined;
    var out = [];
    for (var i = 0; i < refs.length; i++) out.push('CWE-' + refs[i].cweId);
    return out;
  }

  function refList(names, list) {
    var items = asArray(list);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var id = idOf(names, items[i]);
      if (id !== null && out.indexOf(id) === -1) out.push(id);
    }
    return out.length ? out : undefined;
  }

  function slugOrUndefined(value) {
    return core.isString(value) ? value : undefined;
  }

  function copyBooleans(from, to, pairs) {
    for (var i = 0; i < pairs.length; i++) {
      if (core.isBoolean(from[pairs[i][0]])) to[pairs[i][1]] = from[pairs[i][0]];
    }
  }

  function copyInts(from, to, pairs) {
    for (var i = 0; i < pairs.length; i++) {
      if (core.isNumber(from[pairs[i][0]])) to[pairs[i][1]] = Math.round(from[pairs[i][0]]);
    }
  }

  function asArray(value) {
    return core.isArray(value) ? value : [];
  }

  function text(value) {
    return core.isString(value) ? value : '';
  }

  function intOr(value) {
    return core.isNumber(value) ? Math.round(value) : undefined;
  }

  function boolOr(value) {
    return core.isBoolean(value) ? value : undefined;
  }

  function stringList(value) {
    if (!core.isArray(value)) return undefined;
    var out = [];
    for (var i = 0; i < value.length; i++) if (core.isString(value[i])) out.push(value[i]);
    return out.length ? out : undefined;
  }

  TMV.tml = {
    VERSION: TML_VERSION,
    SCHEMA_URL: SCHEMA_URL,
    DEFAULT_VERSION: DEFAULT_VERSION,
    DEFAULTS: DEFAULTS,
    MAPPED: MAPPED,
    FOLDED: FOLDED,
    DROPPED: DROPPED,
    UNREACHABLE: UNREACHABLE,
    FIELDS: TML_FIELDS,

    slugify: slugify,
    symbolicNames: symbolicNames,
    toCanonical: toCanonical,
    fromCanonical: fromCanonical,
  };
})(globalThis.TMV = globalThis.TMV || {});
