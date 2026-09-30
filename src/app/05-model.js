/* 05-model.js — the canonical model: entity registry, vocabularies, validation, editing (`03-data-model.md`).
 *
 * One table drives four consumers: the validator, the generic form renderer, the table/tree views, and
 * the import mappers. Keeping the field descriptions in a single place is what stops "the editor allows
 * a value the validator rejects" from becoming possible.
 *
 * Two things here are deliberate and easy to mistake for bugs:
 *
 *   1. **Vocabulary violations are warnings, not errors.** The canonical vocabularies exist so the UI can
 *      offer a picker; they are never a validation gate (`03-data-model.md` §4.10). A model that has come
 *      from OTM will routinely carry a `state` outside our list, and refusing to open it would be wrong.
 *   2. **Unknown fields are preserved, not dropped.** P2 says nothing is dropped on import. A key we do
 *      not understand is copied through verbatim and reported, so a model round-trips unchanged even
 *      when it contains something this build is too old to interpret.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var TmvError = TMV.error;

  // ---------------------------------------------------------------------------------------------
  // Vocabularies (`03-data-model.md` §3, §4)
  //
  // Where a vocabulary is TML's, the values are TML's own — snake_case, verbatim — so that import
  // stores what the document said and export writes it back with no translation table in between. A
  // translation table is the kind of thing that is right for a year and then silently drops a value.
  // ---------------------------------------------------------------------------------------------

  var VOCAB = {
    // scope
    businessCriticality: ['minimal', 'low', 'moderate', 'high', 'maximal'],
    dataSensitivity: ['pii', 'phi', 'fin', 'ip', 'cred', 'biz', 'gov', 'pci', 'op'],
    exposure: ['internal', 'external'],
    // `tier` is snake_case to match the vendored TML schema. `03-data-model.md` §3.1 writes these in
    // camelCase, which the schema would reject on export; see IMPLEMENTATION-STATUS.md.
    tier: ['mission_critical', 'business_critical', 'important', 'non_critical'],

    // trust boundaries
    accessControlMethod: ['none', 'acl', 'rbac', 'mac', 'dac', 'abac'],
    authenticationMethod: [
      'none', 'password', 'otp', 'challenge_response', 'public_key', 'token', 'biometrics', 'sso', 'social',
    ],

    // architecture
    actorType: ['system', 'user', 'power_user', 'administrator', 'engineer', 'third_party'],
    dataStoreType: ['sql', 'key_value', 'document', 'object', 'graph', 'time_series'],
    flowEndpointType: ['actor', 'component', 'data_store'],

    // adversary
    threatSource: ['adversary', 'human_error', 'failure', 'events_beyond_org_control'],
    skillLevel: ['script_kid', 'insider', 'engineer', 'expert_engineer', 'oc_sponsored', 'state_sponsored'],
    accessLevel: ['anonymous', 'user', 'admin'],
    degree: ['minimal', 'low', 'moderate', 'high', 'maximal'],

    // controls and risk
    controlStatus: ['assumed', 'active', 'suggested', 'under_review', 'approved', 'scheduled', 'retired', 'wont_do'],
    priority: ['none', 'low', 'medium', 'high', 'critical'],
    likelihood: ['rare', 'unlikely', 'possible', 'likely', 'certain'],
    impact: ['negligible', 'minor', 'moderate', 'major', 'severe'],
    riskLevel: ['very_low', 'low', 'medium', 'high', 'very_high', 'critical'],

    // diagrams
    diagramType: ['graphviz', 'mermaid', 'plantuml', 'svg'],

    // assumptions
    validity: ['unconfirmed', 'confirmed', 'rejected'],

    // canonical-only
    targetType: ['component', 'dataFlow'],
    ownerType: ['trustZone', 'component'],

    // The two state vocabularies live in 01-core because the UI needs them before the model loads.
    // They are folded in here so that every vocabulary has exactly one home reachable from the table.
    threatState: TMV.THREAT_STATES,
    controlState: TMV.CONTROL_STATES,
  };

  /** Wire vocabulary → canonical entity key, for the typed references that carry their own type. */
  var FLOW_ENDPOINT_TARGET = {
    actor: 'actors',
    component: 'components',
    data_store: 'dataStores',
  };

  // ---------------------------------------------------------------------------------------------
  // Entity registry (`03-data-model.md` §4)
  //
  // `kind` drives both validation and the generic renderer:
  //   string number boolean uri date datetime enum enumList stringList
  //   ref refList object objectList state int
  //
  // `link: true` marks an entity that records a *relationship* rather than a thing: a threat
  // application, a mitigation plan, a representation element. §4 opens by saying every entity has an
  // `id` and a `name`, but the spec's own example of a threat application (§4.10) has no `name`, and
  // nor do §4.13's or §4.15's tables. These three are therefore the exception: `name` is permitted and
  // preserved if present, but its absence is not a defect and the UI never asks for one.
  // ---------------------------------------------------------------------------------------------

  function f(key, label, kind, extra) {
    var spec = { key: key, label: label, kind: kind };
    if (extra) {
      var keys = Object.keys(extra);
      for (var i = 0; i < keys.length; i++) spec[keys[i]] = extra[keys[i]];
    }
    return spec;
  }

  var TYPES = [
    {
      key: 'trustZones',
      singular: 'trustZone',
      label: 'Trust zone',
      plural: 'Trust zones',
      source: 'O',
      fields: [
        f('type', 'Type', 'string'),
        f('trustRating', 'Trust rating', 'number', { min: 0, max: 100 }),
        f('parentId', 'Parent', 'ref', { ref: ['trustZone', 'component'] }),
      ],
    },
    {
      key: 'trustBoundaries',
      singular: 'trustBoundary',
      label: 'Trust boundary',
      plural: 'Trust boundaries',
      source: 'T',
      fields: [
        f('zoneAId', 'Zone A', 'ref', { ref: ['trustZone'] }),
        f('zoneBId', 'Zone B', 'ref', { ref: ['trustZone'] }),
        f('accessControlMethods', 'Access control', 'enumList', { vocab: 'accessControlMethod' }),
        f('authenticationMethods', 'Authentication', 'enumList', { vocab: 'authenticationMethod' }),
        f('accessTokenExpires', 'Access token expires', 'boolean'),
        f('accessTokenTtl', 'Access token TTL', 'number', { min: 0 }),
        f('hasRefreshToken', 'Has refresh token', 'boolean'),
        f('refreshTokenExpires', 'Refresh token expires', 'boolean'),
        f('refreshTokenTtl', 'Refresh token TTL', 'number', { min: 0 }),
        f('canUserLogout', 'User can log out', 'boolean'),
        f('canSystemLogout', 'System can log out', 'boolean'),
      ],
    },
    {
      key: 'components',
      singular: 'component',
      label: 'Component',
      plural: 'Components',
      source: 'O',
      fields: [
        f('parentId', 'Parent', 'ref', { ref: ['trustZone', 'component'] }),
        f('trustZoneId', 'Trust zone', 'ref', { ref: ['trustZone'] }),
        f('type', 'Type', 'string'),
        f('repoLink', 'Repository', 'uri'),
        f('tags', 'Tags', 'stringList'),
      ],
    },
    {
      key: 'actors',
      singular: 'actor',
      label: 'Actor',
      plural: 'Actors',
      source: 'T',
      fields: [
        f('type', 'Type', 'enum', { vocab: 'actorType' }),
        f('trustZoneId', 'Trust zone', 'ref', { ref: ['trustZone'] }),
        f('permissions', 'Permissions', 'stringList'),
      ],
    },
    {
      key: 'dataStores',
      singular: 'dataStore',
      label: 'Data store',
      plural: 'Data stores',
      source: 'T',
      fields: [
        f('type', 'Type', 'enum', { vocab: 'dataStoreType' }),
        f('trustZoneId', 'Trust zone', 'ref', { ref: ['trustZone'] }),
        f('vendor', 'Vendor', 'string'),
        f('product', 'Product', 'string'),
      ],
    },
    {
      key: 'dataSets',
      singular: 'dataSet',
      label: 'Data set',
      plural: 'Data sets',
      source: 'T',
      fields: [
        f('placements', 'Placements', 'objectList', {
          itemFields: [
            f('dataStoreId', 'Data store', 'ref', { ref: ['dataStore'] }),
            f('encrypted', 'Encrypted', 'boolean'),
          ],
        }),
        f('dataSensitivity', 'Data sensitivity', 'enumList', { vocab: 'dataSensitivity' }),
        f('accessControlMethods', 'Access control', 'enumList', { vocab: 'accessControlMethod' }),
        f('recordCount', 'Record count', 'number', { min: 0 }),
      ],
    },
    {
      key: 'assets',
      singular: 'asset',
      label: 'Asset',
      plural: 'Assets',
      source: 'O',
      fields: [
        f('confidentiality', 'Confidentiality', 'number', { min: 0, max: 100 }),
        f('integrity', 'Integrity', 'number', { min: 0, max: 100 }),
        f('availability', 'Availability', 'number', { min: 0, max: 100 }),
        f('riskComment', 'Risk comment', 'string'),
        f('processedByIds', 'Processed by', 'refList', { ref: ['component'] }),
        f('storedByIds', 'Stored by', 'refList', { ref: ['component'] }),
      ],
    },
    {
      key: 'dataFlows',
      singular: 'dataFlow',
      label: 'Data flow',
      plural: 'Data flows',
      source: 'B',
      fields: [
        f('sourceId', 'Source', 'ref', { ref: ['component', 'actor', 'dataStore'], typeField: 'sourceType', typeMap: FLOW_ENDPOINT_TARGET }),
        f('destinationId', 'Destination', 'ref', { ref: ['component', 'actor', 'dataStore'], typeField: 'destinationType', typeMap: FLOW_ENDPOINT_TARGET }),
        f('sourceType', 'Source type', 'enum', { vocab: 'flowEndpointType' }),
        f('destinationType', 'Destination type', 'enum', { vocab: 'flowEndpointType' }),
        f('bidirectional', 'Bidirectional', 'boolean'),
        f('hasSensitiveData', 'Sensitive data', 'boolean'),
        f('encrypted', 'Encrypted', 'boolean'),
        f('assetIds', 'Assets', 'refList', { ref: ['asset'] }),
        f('tags', 'Tags', 'stringList'),
      ],
    },
    {
      key: 'threats',
      singular: 'threat',
      label: 'Threat',
      plural: 'Threats',
      source: 'B',
      fields: [
        f('personaId', 'Threat persona', 'ref', { ref: ['threatPersona'] }),
        f('event', 'Event', 'string'),
        f('sources', 'Sources', 'enumList', { vocab: 'threatSource' }),
        f('categories', 'Categories', 'stringList'),
        f('cwes', 'CWEs', 'stringList'),
        f('weaknesses', 'Weaknesses', 'objectList', {
          itemFields: [f('cweId', 'CWE id', 'int'), f('cweTitle', 'CWE title', 'string')],
        }),
        f('attackMechanisms', 'Attack mechanisms', 'objectList', {
          itemFields: [f('capecId', 'CAPEC id', 'int'), f('capecTitle', 'CAPEC title', 'string')],
        }),
        f('likelihood', 'Likelihood', 'number', { min: 0, max: 100 }),
        f('impact', 'Impact', 'number', { min: 0, max: 100 }),
        f('likelihoodComment', 'Likelihood comment', 'string'),
        f('impactComment', 'Impact comment', 'string'),
      ],
    },
    {
      key: 'threatPersonas',
      singular: 'threatPersona',
      label: 'Threat persona',
      plural: 'Threat personas',
      source: 'T',
      fields: [
        f('isPerson', 'Is a person', 'boolean'),
        f('skillLevel', 'Skill level', 'enum', { vocab: 'skillLevel' }),
        f('accessLevel', 'Access level', 'enum', { vocab: 'accessLevel' }),
        f('maliciousIntent', 'Malicious intent', 'boolean'),
        f('applicabilityToOrg', 'Applicability', 'enum', { vocab: 'degree' }),
      ],
    },
    {
      key: 'threatApplications',
      singular: 'threatApplication',
      link: true,
      dependsOn: ['threatId', 'targetId'],
      label: 'Threat application',
      plural: 'Threat applications',
      source: 'B',
      fields: [
        f('threatId', 'Threat', 'ref', { ref: ['threat'] }),
        f('targetType', 'Target type', 'enum', { vocab: 'targetType' }),
        f('targetId', 'Target', 'ref', {
          ref: ['component', 'dataFlow'],
          typeField: 'targetType',
          typeMap: { component: 'components', dataFlow: 'dataFlows' },
        }),
        f('state', 'State', 'state', { vocab: 'threatState' }),
        f('controlStates', 'Control states', 'objectList', {
          itemFields: [
            f('controlId', 'Control', 'ref', { ref: ['control'] }),
            f('state', 'State', 'state', { vocab: 'controlState' }),
          ],
        }),
      ],
    },
    {
      key: 'controls',
      singular: 'control',
      label: 'Control',
      plural: 'Controls',
      source: 'B',
      fields: [
        f('threatIds', 'Threats', 'refList', { ref: ['threat'] }),
        f('status', 'Status', 'enum', { vocab: 'controlStatus' }),
        f('priority', 'Priority', 'enum', { vocab: 'priority' }),
        f('trustBoundary', 'Trust boundary', 'object', {
          itemFields: [
            f('zoneAId', 'Zone A', 'ref', { ref: ['trustZone'] }),
            f('zoneBId', 'Zone B', 'ref', { ref: ['trustZone'] }),
          ],
        }),
        f('riskReduction', 'Risk reduction', 'number', { min: 0, max: 100 }),
      ],
    },
    {
      key: 'risks',
      singular: 'risk',
      label: 'Risk',
      plural: 'Risks',
      source: 'T',
      fields: [
        f('threatIds', 'Threats', 'refList', { ref: ['threat'] }),
        f('likelihood', 'Likelihood', 'enum', { vocab: 'likelihood' }),
        f('impact', 'Impact', 'enum', { vocab: 'impact' }),
        f('impactDescription', 'Impact description', 'string'),
        f('score', 'Score', 'int', { min: 0, max: 25, derived: 'riskScore' }),
        f('level', 'Level', 'enum', { vocab: 'riskLevel', derived: 'riskLevel' }),
      ],
    },
    {
      key: 'mitigationPlans',
      singular: 'mitigationPlan',
      link: true,
      dependsOn: ['riskId'],
      label: 'Mitigation plan',
      plural: 'Mitigation plans',
      source: 'T',
      fields: [
        f('riskId', 'Risk', 'ref', { ref: ['risk'] }),
        f('controlIds', 'Controls', 'refList', { ref: ['control'] }),
      ],
    },
    {
      key: 'assumptions',
      singular: 'assumption',
      label: 'Assumption',
      plural: 'Assumptions',
      source: 'T',
      fields: [
        f('validity', 'Validity', 'enum', { vocab: 'validity' }),
        f('topics', 'Topics', 'stringList'),
      ],
    },
    {
      key: 'diagrams',
      singular: 'diagram',
      label: 'Diagram',
      plural: 'Diagrams',
      source: 'T',
      fields: [
        f('type', 'Type', 'enum', { vocab: 'diagramType' }),
        f('source', 'Source', 'string', { maxBytes: TMV.LIMITS.diagramSourceRefuseBytes }),
        f('link', 'Link', 'uri'),
      ],
    },
    {
      key: 'representations',
      singular: 'representation',
      label: 'Representation',
      plural: 'Representations',
      source: 'O',
      fields: [
        f('type', 'Type', 'string'),
        f('width', 'Width', 'number', { min: 0 }),
        f('height', 'Height', 'number', { min: 0 }),
        f('repositoryUrl', 'Repository', 'uri'),
      ],
    },
    {
      key: 'representationElements',
      singular: 'representationElement',
      link: true,
      dependsOn: ['representationId', 'ownerId'],
      label: 'Representation element',
      plural: 'Representation elements',
      source: 'O',
      fields: [
        f('representationId', 'Representation', 'ref', { ref: ['representation'] }),
        f('ownerId', 'Owner', 'ref', { ref: ['trustZone', 'component'] }),
        f('ownerType', 'Owner type', 'enum', { vocab: 'ownerType' }),
        // Geometry is nested rather than the flat `x`/`y`/`width`/`height` of `03-data-model.md`
        // §4.15, and the reason is a collision the spec does not acknowledge: the passthrough bag
        // (`03-data-model.md` §4) lives at the property `x` on *every* entity, without exception,
        // and §10 promises an OTM round trip is lossless. A numeric `x` here would make the two
        // mutually exclusive — an OTM element carrying `attributes` or any unrecognised key would
        // lose its x coordinate, or the key would be dropped. Nesting also matches OTM's own wire
        // shape, so unknown keys *inside* `position` and `size` survive verbatim through the mapping
        // with no extra machinery. Recorded as a deviation in IMPLEMENTATION-STATUS.md.
        f('position', 'Position', 'object', { itemFields: [f('x', 'X', 'number'), f('y', 'Y', 'number')] }),
        f('size', 'Size', 'object', {
          itemFields: [f('width', 'Width', 'number', { min: 0 }), f('height', 'Height', 'number', { min: 0 })],
        }),
        f('file', 'File', 'string'),
        f('line', 'Line', 'int', { min: 0 }),
        f('codeSnippet', 'Code snippet', 'string'),
      ],
    },
  ];

  var TYPE_BY_KEY = Object.create(null);
  var TYPE_BY_SINGULAR = Object.create(null);
  for (var ti = 0; ti < TYPES.length; ti++) {
    TYPE_BY_KEY[TYPES[ti].key] = TYPES[ti];
    TYPE_BY_SINGULAR[TYPES[ti].singular] = TYPES[ti];
  }

  /** Entity array names, in the order the model declares them. */
  var ENTITY_KEYS = TYPES.map(function (t) {
    return t.key;
  });

  // ---------------------------------------------------------------------------------------------
  // Risk matrix (`03-data-model.md` §4.12)
  // ---------------------------------------------------------------------------------------------

  /**
   * The 5×5 banding, as score → band. The score is the product of the 1-based positions of
   * likelihood and impact, so it runs 1–25.
   *
   * The banding itself is an interpretation: the TML specification points at the OWASP page for its
   * derivation and does not state it machine-readably. It is isolated in this one function so that
   * changing it is a one-line change, and the editor treats `score`/`level` as *stored* values that it
   * compares against, never overwrites (§4.12).
   */
  var RISK_BANDS = [
    { max: 3, level: 'very_low' },
    { max: 6, level: 'low' },
    { max: 12, level: 'medium' },
    { max: 16, level: 'high' },
    { max: 20, level: 'very_high' },
    { max: 25, level: 'critical' },
  ];

  function riskScore(likelihood, impact) {
    var li = VOCAB.likelihood.indexOf(likelihood);
    var ii = VOCAB.impact.indexOf(impact);
    if (li === -1 || ii === -1) return null;
    return (li + 1) * (ii + 1);
  }

  function riskLevel(score) {
    if (!core.isNumber(score)) return null;
    for (var i = 0; i < RISK_BANDS.length; i++) {
      if (score <= RISK_BANDS[i].max) return RISK_BANDS[i].level;
    }
    return 'critical';
  }

  // ---------------------------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------------------------

  /** A model with every entity array present. Arrays are always present; that is the whole point (§2). */
  function createEmpty(name, modelId) {
    var model = Object.create(null);
    model.tmvFormat = TMV.MODEL_FORMAT;
    model.modelId = modelId || core.uuid();
    model.name = core.isString(name) ? name : 'Untitled Threat Model';
    model.description = '';
    model.scope = Object.create(null);
    model.metadata = Object.create(null);
    for (var i = 0; i < ENTITY_KEYS.length; i++) model[ENTITY_KEYS[i]] = [];
    return model;
  }

  // ---------------------------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------------------------

  function typeFor(keyOrSingular) {
    return TYPE_BY_KEY[keyOrSingular] || TYPE_BY_SINGULAR[keyOrSingular] || null;
  }

  function collection(model, keyOrSingular) {
    var t = typeFor(keyOrSingular);
    if (!t || !model) return [];
    var list = model[t.key];
    return core.isArray(list) ? list : [];
  }

  /** Index every entity in the model by type, then by id. Used constantly; hence the flat shape. */
  function index(model) {
    var out = Object.create(null);
    for (var i = 0; i < ENTITY_KEYS.length; i++) {
      var key = ENTITY_KEYS[i];
      out[key] = core.indexById(collection(model, key));
    }
    return out;
  }

  function get(model, keyOrSingular, id) {
    var t = typeFor(keyOrSingular);
    if (!t || !core.isString(id)) return null;
    var list = collection(model, t.key);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * Find an entity by id without knowing its type. Used to render a reference without a type hint.
   * Returns `{type, entity}` or null. Ambiguity is not possible: ids are unique within a type.
   */
  function findAnywhere(model, id) {
    if (!core.isString(id)) return null;
    for (var i = 0; i < ENTITY_KEYS.length; i++) {
      var e = get(model, ENTITY_KEYS[i], id);
      if (e) return { type: ENTITY_KEYS[i], typeSpec: TYPE_BY_KEY[ENTITY_KEYS[i]], entity: e };
    }
    return null;
  }

  /** A display name for any entity or for the model itself. */
  function labelOf(entity) {
    if (!entity) return 'Untitled';
    if (core.isString(entity.name) && entity.name.trim() !== '') return entity.name;
    if (core.isString(entity.id)) return core.shortId(entity.id);
    return 'Untitled';
  }

  // ---------------------------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------------------------

  /** True when the id is unused, or used only by the entity being edited. */
  function idAvailable(model, keyOrSingular, id, exceptId) {
    var t = typeFor(keyOrSingular);
    if (!t) return false;
    var list = collection(model, t.key);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e && e.id === id && e.id !== exceptId) return false;
    }
    return true;
  }

  /**
   * The one place a value is put into an entity. Both `insert` and `update` use it, so an entity
   * built by hand and the same entity loaded from a file cannot disagree about what was stored.
   *
   * Which strings are canonicalized (NFC) is decided *per field kind*, and the distinction that
   * matters is not "text versus not text" but "text versus identifier":
   *
   *   `name`, `description`  text. Two spellings of the same character are the same name, and
   *                          canonical form on entry is what lets `deepEqual`, the model hash and
   *                          the differ agree about that (`01-core.js`).
   *   `id`, `ref`, `refList`  identifiers. Matched byte for byte, never normalized. A reference is
   *                          either to exactly this id or it is dangling, and quietly repairing the
   *                          spelling would turn a dangling reference into a resolving one — which is
   *                          a wrong answer, not a kindness.
   *   everything else         coerced to its declared kind, or kept verbatim and copied when there is
   *                          no declaration (the passthrough keys of P2).
   *
   * Every branch copies, so a caller cannot mutate the model by holding on to the object it passed in
   * — the aliasing bug that once made stored history deltas track the working copy (`06-vcs.js`).
   */
  function assignValue(type, key, value) {
    if (key === 'id') return core.isString(value) ? value : core.deepCopy(value);
    if (key === 'name' || key === 'description') {
      return core.isString(value) ? core.nfc(value) : core.deepCopy(value);
    }
    var spec = fieldSpec(type, key);
    if (!spec) return core.deepCopy(value); // passthrough: verbatim, as `normalizeEntity` keeps it
    var coerced = coerceField(spec, value);
    // A value its declared kind cannot hold is kept rather than dropped: `insert` is a programmatic
    // API and silently discarding an argument is worse than storing one `validate` will flag.
    return coerced === undefined ? core.nfcValue(value) : coerced;
  }

  /** Insert a new entity. The caller supplies the field values; the id is minted here when absent. */
  function insert(model, keyOrSingular, values) {
    var t = typeFor(keyOrSingular);
    if (!t) throw TmvError('MODEL_TYPE', 'Unknown entity type: ' + keyOrSingular);
    var entity = Object.create(null);
    var src = values || {};
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) entity[keys[i]] = assignValue(t, keys[i], src[keys[i]]);
    if (!core.isString(entity.id) || entity.id === '') entity.id = core.uuid();
    if (!core.isString(entity.name) && !t.link) entity.name = '';
    if (!idAvailable(model, t.key, entity.id, null)) {
      throw TmvError('MODEL_ID_TAKEN', 'A ' + t.label.toLowerCase() + ' with id ' + entity.id + ' already exists.', {
        type: t.key,
        id: entity.id,
      });
    }
    model[t.key].push(entity);
    return entity;
  }

  /**
   * Apply a patch of field values to an existing entity. A key set to `undefined` removes the field;
   * an empty string is a value, not an absence.
   */
  function update(model, keyOrSingular, id, patch) {
    var t = typeFor(keyOrSingular);
    var entity = get(model, keyOrSingular, id);
    if (!entity) throw TmvError('MODEL_NOT_FOUND', 'No entity with id ' + id + '.', { id: id });
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (patch[k] === undefined) delete entity[k];
      else if (k === 'id') {
        if (patch[k] !== id && !idAvailable(model, keyOrSingular, patch[k], id)) {
          throw TmvError('MODEL_ID_TAKEN', 'Id ' + patch[k] + ' is already in use.', { id: patch[k] });
        }
        entity.id = core.isString(patch[k]) ? patch[k] : ''; // an id is an identifier, never normalized
      } else entity[k] = assignValue(t, k, patch[k]);
    }
    return entity;
  }

  /**
   * Delete the entities that cannot outlive this one.
   *
   * A link entity exists only to relate two things (`threatApplications`, `mitigationPlans`,
   * `representationElements`, and the `dependsOn` lists that mark them). Deleting the threat a threat
   * application is *about* does not leave "a threat application with a missing threat" — it leaves
   * nothing, because there is no fact left to record. Contrast a component's optional `trustZoneId`:
   * the component is still a component, so only the reference goes.
   *
   * Removal cascades, and the queue makes it transitive: deleting a representation deletes its
   * elements, and anything that depended on those goes too.
   */
  function cascadeDeletes(model, rootId) {
    var queue = [rootId];
    var removed = [];
    while (queue.length) {
      var id = queue.shift();
      for (var i = 0; i < TYPES.length; i++) {
        var t = TYPES[i];
        if (!t.dependsOn) continue;
        var list = collection(model, t.key);
        for (var j = list.length - 1; j >= 0; j--) {
          var entity = list[j];
          if (!core.isObject(entity)) continue;
          for (var k = 0; k < t.dependsOn.length; k++) {
            if (entity[t.dependsOn[k]] !== id) continue;
            list.splice(j, 1);
            removed.push({ type: t.key, id: entity.id });
            if (core.isString(entity.id)) queue.push(entity.id);
            break;
          }
        }
      }
    }
    return removed;
  }

  /**
   * Remove an entity, cascade to the links that depended on it, and drop the references that pointed
   * at it.
   *
   * Dropping dangling references rather than leaving them is the honest behaviour: leaving them makes
   * the model fail its own structural validation the moment the user deletes anything, and the delete
   * is an explicit act. The old value survives in the commit that says it happened.
   *
   * Returns `{entity, cascaded}` — the cascade list is what the commit message and the undo prompt
   * need, and discovering it after the fact is not possible.
   */
  function remove(model, keyOrSingular, id) {
    var t = typeFor(keyOrSingular);
    if (!t) return { entity: null, cascaded: [] };
    var list = collection(model, t.key);
    var removed = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) {
        removed = list.splice(i, 1)[0];
        break;
      }
    }
    if (!removed) return { entity: null, cascaded: [] };
    var cascaded = cascadeDeletes(model, id);
    dropReferencesTo(model, id);
    for (var c = 0; c < cascaded.length; c++) dropReferencesTo(model, cascaded[c].id);
    return { entity: removed, cascaded: cascaded };
  }

  /** Every reference field, flattened, for referential work in both directions. */
  function referenceFields() {
    var out = [];
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      for (var j = 0; j < t.fields.length; j++) {
        var spec = t.fields[j];
        if (spec.kind === 'ref' || spec.kind === 'refList') {
          out.push({ type: t.key, typeSpec: t, field: spec });
        } else if ((spec.kind === 'object' || spec.kind === 'objectList') && spec.itemFields) {
          for (var k = 0; k < spec.itemFields.length; k++) {
            var inner = spec.itemFields[k];
            if (inner.kind === 'ref' || inner.kind === 'refList') {
              out.push({ type: t.key, typeSpec: t, field: inner, container: spec.key });
            }
          }
        }
      }
    }
    return out;
  }

  var REFERENCE_FIELDS = referenceFields();

  /**
   * The objects that actually hold a reference field's value.
   *
   * A reference lives either directly on the entity (`components[0].trustZoneId`) or inside a
   * container field's items — which is a *list* (`threatApplications[0].controlStates[1].controlId`)
   * or a *single object* (`controls[0].trustBoundary.zoneAId`). Flattening that difference here keeps
   * every reference operation — resolution, deletion, referrers — a loop over one shape.
   *
   * The single-object case is easy to omit, and omitting it is silent: a dangling
   * `control.trustBoundary.zoneAId` then validates cleanly, and deleting a zone leaves a reference
   * behind. Both are the incompleteness REQ-IMP-004's "every reference type" claim rules out.
   */
  function referenceHolders(entity, rf) {
    if (!core.isObject(entity)) return [];
    if (!rf.container) return [entity];
    var holder = entity[rf.container];
    if (core.isObject(holder)) return [holder];
    if (!core.isArray(holder)) return [];
    var out = [];
    for (var i = 0; i < holder.length; i++) if (core.isObject(holder[i])) out.push(holder[i]);
    return out;
  }

  /** A copy of an array with one value removed. */
  function without(list, value) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] !== value) out.push(list[i]);
    return out;
  }

  /** True when a link entry still names anything at all, in any of its reference fields. */
  function stillLinked(item, spec) {
    if (!spec || !spec.itemFields) return true;
    for (var i = 0; i < spec.itemFields.length; i++) {
      var inner = spec.itemFields[i];
      if (inner.kind === 'ref') {
        if (core.isString(item[inner.key]) && item[inner.key] !== '') return true;
      } else if (inner.kind === 'refList') {
        if (core.isArray(item[inner.key]) && item[inner.key].length > 0) return true;
      }
    }
    return false;
  }

  /**
   * Remove every reference to an id, and prune the link entries left inert by it. Returns the paths
   * changed, for the commit message.
   *
   * The pruning matters more than it looks. A `controlStates` entry is `{controlId, state}`; deleting
   * the control and leaving `{state: "implemented"}` behind would put a row in the threat detail view
   * that names nothing, and those rows accumulate silently across a long editing session. A placement
   * whose data store is gone is not a placement.
   */
  function dropReferencesTo(model, id) {
    var changed = [];
    for (var i = 0; i < REFERENCE_FIELDS.length; i++) {
      var rf = REFERENCE_FIELDS[i];
      var list = collection(model, rf.type);
      for (var j = 0; j < list.length; j++) {
        var entity = list[j];
        if (!core.isObject(entity)) continue;
        var path = '/' + rf.type + '/' + j;
        if (!rf.container) {
          if (rf.field.kind === 'ref') {
            if (entity[rf.field.key] === id) {
              delete entity[rf.field.key];
              changed.push(path + '/' + rf.field.key);
            }
          } else if (core.isArray(entity[rf.field.key])) {
            var rest = without(entity[rf.field.key], id);
            if (rest.length !== entity[rf.field.key].length) {
              entity[rf.field.key] = rest;
              changed.push(path + '/' + rf.field.key);
            }
          }
          continue;
        }
        var items = entity[rf.container];
        var spec = fieldSpec(rf.typeSpec, rf.container);
        // A container is a list (`controlStates`) or a single object (`trustBoundary`). The single
        // object is pruned like a list item that has become inert: its reference is cleared, and the
        // whole object goes when it holds nothing else.
        if (core.isObject(items)) {
          var held;
          if (rf.field.kind === 'ref') {
            held = items[rf.field.key] === id;
            if (held) delete items[rf.field.key];
          } else {
            held = core.isArray(items[rf.field.key]) && items[rf.field.key].indexOf(id) !== -1;
            if (held) items[rf.field.key] = without(items[rf.field.key], id);
          }
          if (held) {
            changed.push(path + '/' + rf.container + '/' + rf.field.key);
            if (!stillLinked(items, spec)) delete entity[rf.container];
          }
          continue;
        }
        if (!core.isArray(items)) continue;
        var kept = [];
        for (var k = 0; k < items.length; k++) {
          var item = items[k];
          if (!core.isObject(item)) {
            kept.push(item);
            continue;
          }
          var hit;
          if (rf.field.kind === 'ref') {
            hit = item[rf.field.key] === id;
            if (hit) delete item[rf.field.key];
          } else {
            hit = core.isArray(item[rf.field.key]) && item[rf.field.key].indexOf(id) !== -1;
            if (hit) item[rf.field.key] = without(item[rf.field.key], id);
          }
          if (!hit) {
            kept.push(item);
            continue;
          }
          changed.push(path + '/' + rf.container + '/' + k + '/' + rf.field.key);
          if (stillLinked(item, spec)) kept.push(item);
        }
        if (kept.length !== items.length) entity[rf.container] = kept;
      }
    }
    return changed;
  }

  /** The field spec for a key on a type, or null. */
  function fieldSpec(typeSpec, key) {
    if (!typeSpec) return null;
    for (var i = 0; i < typeSpec.fields.length; i++) {
      if (typeSpec.fields[i].key === key) return typeSpec.fields[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Passthrough bags (`03-data-model.md` §1)
  // ---------------------------------------------------------------------------------------------

  /** The bag for one format on an entity or on the model, or null. */
  function bag(entity, format) {
    if (!core.isObject(entity) || !core.isObject(entity.x)) return null;
    var b = entity.x[format];
    return core.isObject(b) && Object.keys(b).length > 0 ? b : null;
  }

  /** Set a bag. An empty bag is omitted rather than written as `{}` (§1). */
  function setBag(entity, format, value) {
    if (!entity) return entity;
    var empty = !core.isObject(value) || Object.keys(value).length === 0;
    if (empty) {
      if (core.isObject(entity.x)) {
        delete entity.x[format];
        if (Object.keys(entity.x).length === 0) delete entity.x;
      }
      return entity;
    }
    if (!core.isObject(entity.x)) entity.x = Object.create(null);
    entity.x[format] = value;
    return entity;
  }

  /** Drop empty bags everywhere, so a model that has been edited does not serialize `"x":{}`. */
  function pruneBags(model) {
    pruneOne(model);
    for (var i = 0; i < ENTITY_KEYS.length; i++) {
      var list = collection(model, ENTITY_KEYS[i]);
      for (var j = 0; j < list.length; j++) pruneOne(list[j]);
    }
    return model;
  }

  function pruneOne(node) {
    if (!core.isObject(node) || !core.isObject(node.x)) return;
    var keys = Object.keys(node.x);
    for (var i = 0; i < keys.length; i++) {
      var v = node.x[keys[i]];
      if (v === null || v === undefined || (core.isObject(v) && Object.keys(v).length === 0)) delete node.x[keys[i]];
    }
    if (Object.keys(node.x).length === 0) delete node.x;
  }

  // ---------------------------------------------------------------------------------------------
  // Validation (`03-data-model.md` §6, layer 1)
  // ---------------------------------------------------------------------------------------------

  var SEVERITY_ERROR = 'error';
  var SEVERITY_WARNING = 'warning';

  function problem(list, path, code, message, severity) {
    list.push({ path: path, code: code, message: message, severity: severity || SEVERITY_ERROR });
  }

  function typeName(v) {
    if (v === null) return 'null';
    if (core.isArray(v)) return 'array';
    return typeof v;
  }

  /**
   * Coerce an untrusted tree into a canonical model (`08-security.md` §5, REQ-SEC-003).
   *
   * Every object is rebuilt into `Object.create(null)` with fields copied one at a time. There is no
   * deep merge anywhere in this function, and `__proto__` / `constructor` / `prototype` are dropped
   * outright: a model is a document from someone else, and the classic attack is a key called
   * `__proto__` that a naive merge turns into a change to `Object.prototype`.
   *
   * Known fields are coerced to their declared type. Unknown fields are **kept verbatim** and reported
   * by `validate`, because P2 says nothing is dropped on import and because dropping a field a future
   * version added would be silent data loss.
   */
  function normalizeModel(raw) {
    var src = core.isObject(raw) ? raw : {};
    var model = Object.create(null);

    model.tmvFormat = core.isString(src.tmvFormat) ? src.tmvFormat : TMV.MODEL_FORMAT;
    model.modelId = core.isString(src.modelId) && src.modelId !== '' ? src.modelId : core.uuid();
    model.name = core.isString(src.name) ? core.nfc(src.name) : '';
    if (src.description !== undefined) model.description = core.isString(src.description) ? core.nfc(src.description) : '';
    model.scope = normalizeScope(src.scope);
    model.metadata = normalizeMetadata(src.metadata);

    for (var i = 0; i < ENTITY_KEYS.length; i++) {
      var t = TYPE_BY_KEY[ENTITY_KEYS[i]];
      var list = core.isArray(src[t.key]) ? src[t.key] : [];
      var out = [];
      for (var j = 0; j < list.length; j++) {
        var entity = normalizeEntity(t, list[j], j);
        if (entity) out.push(entity);
      }
      model[t.key] = out;
    }

    var extraKeys = Object.keys(src);
    for (var k = 0; k < extraKeys.length; k++) {
      var key = extraKeys[k];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (key === 'x' || MODEL_KEYS[key]) continue;
      model[key] = core.deepCopy(src[key]);
    }
    if (core.isObject(src.x)) {
      var x = normalizeBag(src.x);
      if (x) model.x = x;
    }
    return model;
  }

  var MODEL_KEYS = (function () {
    var m = Object.create(null);
    var fixed = ['tmvFormat', 'modelId', 'name', 'description', 'scope', 'metadata'];
    for (var i = 0; i < fixed.length; i++) m[fixed[i]] = true;
    for (var j = 0; j < ENTITY_KEYS.length; j++) m[ENTITY_KEYS[j]] = true;
    return m;
  })();

  function normalizeScope(raw) {
    var scope = Object.create(null);
    if (!core.isObject(raw)) return scope;
    if (core.isString(raw.title)) scope.title = core.nfc(raw.title);
    if (core.isString(raw.description)) scope.description = core.nfc(raw.description);
    if (core.isString(raw.businessCriticality)) scope.businessCriticality = raw.businessCriticality;
    if (core.isArray(raw.dataSensitivity)) scope.dataSensitivity = stringArray(raw.dataSensitivity);
    if (core.isString(raw.exposure)) scope.exposure = raw.exposure;
    if (core.isString(raw.tier)) scope.tier = raw.tier;
    return scope;
  }

  function normalizeMetadata(raw) {
    var meta = Object.create(null);
    if (!core.isObject(raw)) return meta;
    var strings = ['owner', 'ownerContact', 'repoLink', 'releaseDocsLink', 'releasedAt', 'productReleaseDate', 'reviewedAt', 'version'];
    for (var i = 0; i < strings.length; i++) {
      if (core.isString(raw[strings[i]])) meta[strings[i]] = core.nfc(raw[strings[i]]);
    }
    if (core.isArray(raw.tags)) meta.tags = stringArray(raw.tags);
    if (core.isBoolean(raw.frozen)) meta.frozen = raw.frozen;
    if (core.isArray(raw.contributors)) {
      var people = [];
      for (var j = 0; j < raw.contributors.length; j++) {
        var p = raw.contributors[j];
        if (!core.isObject(p)) continue;
        var person = Object.create(null);
        if (core.isString(p.name)) person.name = core.nfc(p.name);
        if (core.isString(p.email)) person.email = core.nfc(p.email);
        if (core.isString(p.role)) person.role = core.nfc(p.role);
        people.push(person);
      }
      if (people.length) meta.contributors = people;
    }
    return meta;
  }

  /** A list of strings, non-strings dropped. Normalized unless the values are identifiers. */
  function stringArray(value, keepExact) {
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (!core.isString(value[i])) continue;
      out.push(keepExact ? value[i] : core.nfc(value[i]));
    }
    return out;
  }

  function normalizeBag(raw) {
    var bag = Object.create(null);
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      bag[key] = core.deepCopy(raw[key]);
    }
    return Object.keys(bag).length ? bag : null;
  }

  function normalizeEntity(type, raw, position) {
    if (!core.isObject(raw)) return null;
    var entity = Object.create(null);
    if (core.isString(raw.id) && raw.id !== '') entity.id = raw.id;
    else entity.id = core.uuid();
    if (core.isString(raw.name)) entity.name = core.nfc(raw.name);
    else if (!type.link) entity.name = '';
    if (raw.description !== undefined) entity.description = core.isString(raw.description) ? core.nfc(raw.description) : '';
    if (core.isString(raw.slug)) entity.slug = raw.slug;

    var known = Object.create(null);
    known.id = true;
    known.name = true;
    known.description = true;
    known.slug = true;
    known.x = true;

    for (var i = 0; i < type.fields.length; i++) {
      var spec = type.fields[i];
      known[spec.key] = true;
      var v = raw[spec.key];
      if (v === undefined || v === null) continue;
      var coerced = coerceField(spec, v);
      if (coerced !== undefined) entity[spec.key] = coerced;
    }

    // Unknown keys are preserved verbatim rather than dropped (P2).
    var keys = Object.keys(raw);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (known[key]) continue;
      entity[key] = core.deepCopy(raw[key]);
    }
    if (core.isObject(raw.x)) {
      var bag = normalizeBag(raw.x);
      if (bag) entity.x = bag;
    }
    return entity;
  }

  /** Coerce a scalar field to its declared kind; return `undefined` when the value is unusable. */
  function coerceField(spec, v) {
    switch (spec.kind) {
      case 'string':
      case 'uri':
      case 'date':
      case 'datetime':
      case 'state':
        return core.isString(v) ? core.nfc(v) : undefined;
      case 'enum':
        return core.isString(v) ? v : undefined;
      case 'number':
        return core.isNumber(v) ? v : undefined;
      case 'int':
        return core.isNumber(v) ? Math.round(v) : undefined;
      case 'boolean':
        return core.isBoolean(v) ? v : undefined;
      case 'stringList':
        return core.isArray(v) ? stringArray(v) : undefined;
      case 'enumList':
        return core.isArray(v) ? stringArray(v) : undefined;
      case 'ref':
        return core.isString(v) ? v : undefined;
      case 'refList':
        // Identifiers are opaque. They are matched byte for byte, so they are not normalized.
        return core.isArray(v) ? stringArray(v, true) : undefined;
      case 'object':
        return core.isObject(v) ? coerceObject(spec, v) : undefined;
      case 'objectList':
        if (!core.isArray(v)) return undefined;
        var out = [];
        for (var i = 0; i < v.length; i++) {
          if (core.isObject(v[i])) out.push(coerceObject(spec, v[i]));
        }
        return out;
      default:
        return core.deepCopy(v);
    }
  }

  /**
   * Coerce the contents of a declared object field (the `{zoneAId, zoneBId}` of a control's
   * `trustBoundary`, say).
   *
   * Keys the descriptor does not name are preserved verbatim rather than dropped. A nested object is
   * not a closed shape — a document may carry more inside it than this build interprets — and P2 says
   * uninterpreted data survives a load. Dropping it here would be a silent lossiness at exactly the
   * depth where the lossiness ledger (`06-interchange.md` §7) is least able to see it.
   */
  function coerceObject(spec, raw) {
    var out = Object.create(null);
    var fields = spec.itemFields || [];
    var known = Object.create(null);
    for (var i = 0; i < fields.length; i++) {
      var inner = fields[i];
      known[inner.key] = true;
      var v = raw[inner.key];
      if (v === undefined || v === null) continue;
      var coerced = coerceField(inner, v);
      if (coerced !== undefined) out[inner.key] = coerced;
    }
    var keys = Object.keys(raw);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (known[key]) continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = core.deepCopy(raw[key]);
    }
    return out;
  }

  /**
   * Layer 1 structural validation.
   *
   * `referential` decides whether a dangling reference is an error or a warning: the editor treats it
   * as an error (the model is broken), and import treats it as a warning so a document with a dangling
   * reference can still be brought in and repaired (REQ-IMP-004).
   */
  function validate(model, options) {
    var opts = options || {};
    var refSeverity = opts.referential === 'warning' ? SEVERITY_WARNING : SEVERITY_ERROR;
    var problems = [];
    var unresolved = [];

    if (!core.isObject(model)) {
      problem(problems, '/', 'MODEL_SHAPE', 'The model is not an object.');
      return { valid: false, problems: problems, unresolved: unresolved };
    }

    if (model.tmvFormat !== TMV.MODEL_FORMAT) {
      problem(
        problems,
        '/tmvFormat',
        'MODEL_FORMAT',
        'Model format is ' + typeName(model.tmvFormat) + ' "' + model.tmvFormat + '", expected ' + TMV.MODEL_FORMAT + '.',
        SEVERITY_WARNING,
      );
    }
    if (!core.isString(model.modelId) || model.modelId === '') {
      problem(problems, '/modelId', 'MODEL_ID', 'The model has no id.');
    }
    if (!core.isString(model.name) || model.name.trim() === '') {
      problem(problems, '/name', 'MODEL_NAME', 'The model has no name. Export to either format is blocked without one.');
    }
    checkScope(model.scope, problems);

    // Entity arrays, then the entities themselves.
    var idx = Object.create(null);
    for (var i = 0; i < ENTITY_KEYS.length; i++) {
      var key = ENTITY_KEYS[i];
      var t = TYPE_BY_KEY[key];
      var list = model[key];
      idx[key] = Object.create(null);
      if (!core.isArray(list)) {
        problem(problems, '/' + key, 'MODEL_ARRAY', t.plural + ' must be an array, found ' + typeName(list) + '.');
        continue;
      }
      var seen = Object.create(null);
      for (var j = 0; j < list.length; j++) {
        var at = '/' + key + '/' + j;
        var entity = list[j];
        if (!core.isObject(entity)) {
          problem(problems, at, 'ENTITY_SHAPE', 'Not an object.');
          continue;
        }
        if (!core.isString(entity.id) || entity.id === '') {
          problem(problems, at + '/id', 'ENTITY_ID', 'A ' + t.label.toLowerCase() + ' has no id.');
        } else if (seen[entity.id]) {
          problem(problems, at + '/id', 'ENTITY_ID_DUPLICATE', 'Duplicate id "' + entity.id + '" within ' + t.plural + '.');
        } else {
          seen[entity.id] = true;
          idx[key][entity.id] = entity;
        }
        if (!t.link && (!core.isString(entity.name) || entity.name.trim() === '')) {
          problem(problems, at + '/name', 'ENTITY_NAME', 'A ' + t.label.toLowerCase() + ' has no name.', SEVERITY_WARNING);
        }
        checkEntity(t, entity, at, problems);
      }
    }

    // References, second pass: targets may be declared after their referrers.
    for (var r = 0; r < REFERENCE_FIELDS.length; r++) {
      var rf = REFERENCE_FIELDS[r];
      var entities = collection(model, rf.type);
      for (var e = 0; e < entities.length; e++) {
        var ent = entities[e];
        if (!core.isObject(ent)) continue;
        var holders = referenceHolders(ent, rf);
        // A container that is one object (`trustBoundary`) has no index to name, so its path is
        // `/controls/1/trustBoundary/zoneAId` and not the `/trustBoundary/0/...` an array would give.
        var singleObject = rf.container && core.isObject(ent[rf.container]);
        for (var h = 0; h < holders.length; h++) {
          var holder = holders[h];
          if (!core.isObject(holder)) continue;
          var base =
            '/' + rf.type + '/' + e +
            (rf.container ? '/' + rf.container + (singleObject ? '' : '/' + h) : '') +
            '/' + rf.field.key;
          var expected = expectedTargets(rf.field, ent);
          var value = holder[rf.field.key];
          if (rf.field.kind === 'ref') {
            if (core.isString(value) && !resolves(idx, expected, value)) {
              unresolved.push({ path: base, type: rf.type, field: rf.field.key, id: value, expected: expected });
              problem(problems, base, 'REF_DANGLING', 'Reference to "' + value + '", which is not a ' + describeTargets(expected) + '.', refSeverity);
            }
          } else if (core.isArray(value)) {
            for (var v = 0; v < value.length; v++) {
              if (core.isString(value[v]) && !resolves(idx, expected, value[v])) {
                unresolved.push({ path: base + '/' + v, type: rf.type, field: rf.field.key, id: value[v], expected: expected });
                problem(problems, base + '/' + v, 'REF_DANGLING', 'Reference to "' + value[v] + '", which is not a ' + describeTargets(expected) + '.', refSeverity);
              }
            }
          }
        }
      }
    }

    var errors = 0;
    for (var p = 0; p < problems.length; p++) if (problems[p].severity === SEVERITY_ERROR) errors++;
    return { valid: errors === 0, problems: problems, unresolved: unresolved, errorCount: errors };
  }

  /**
   * The entity types a reference field may point at.
   *
   * When a field names a `typeField`, the answer depends on that field's value on the same entity —
   * this is what makes a `dataFlow`'s endpoint a *typed* reference rather than a loose one, and it is
   * why a flow whose `sourceId` names a component but whose `sourceType` says `actor` is a real
   * inconsistency rather than a style choice.
   */
  function expectedTargets(field, entity) {
    if (!field.typeField || !field.typeMap) return field.ref;
    var t = entity && entity[field.typeField];
    var mapped = t && field.typeMap[t];
    return mapped ? [mapped] : field.ref;
  }

  /**
   * Reference fields name their targets by singular (`trustZone`) because that is how they read in the
   * field table; the model indexes and stores by plural array name (`trustZones`). One translation
   * function, used by every consumer of a `ref` list, so the two spellings cannot drift apart.
   */
  function entityKey(name) {
    var t = TYPE_BY_SINGULAR[name] || TYPE_BY_KEY[name];
    return t ? t.key : name;
  }

  function resolves(idx, types, id) {
    for (var i = 0; i < types.length; i++) {
      var bucket = idx[entityKey(types[i])];
      if (bucket && bucket[id]) return true;
    }
    return false;
  }

  function describeTargets(types) {
    var names = [];
    for (var i = 0; i < types.length; i++) {
      var t = TYPE_BY_KEY[entityKey(types[i])];
      names.push(t ? t.label.toLowerCase() : types[i]);
    }
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
  }

  function checkScope(scope, problems) {
    if (scope === undefined || scope === null) return;
    if (!core.isObject(scope)) {
      problem(problems, '/scope', 'SCOPE_SHAPE', 'Scope must be an object.');
      return;
    }
    var singles = [
      ['businessCriticality', 'businessCriticality'],
      ['exposure', 'exposure'],
      ['tier', 'tier'],
    ];
    for (var i = 0; i < singles.length; i++) {
      var key = singles[i][0];
      var v = scope[key];
      if (v === undefined) continue;
      if (!core.isString(v)) problem(problems, '/scope/' + key, 'SCOPE_TYPE', 'Scope ' + key + ' must be a string.');
      else if (VOCAB[singles[i][1]].indexOf(v) === -1) {
        problem(problems, '/scope/' + key, 'VOCAB_OUTSIDE', 'Scope ' + key + ' is "' + v + '", which is outside the canonical vocabulary. It is preserved as written.', SEVERITY_WARNING);
      }
    }
    var ds = scope.dataSensitivity;
    if (ds !== undefined) {
      if (!core.isArray(ds)) problem(problems, '/scope/dataSensitivity', 'SCOPE_TYPE', 'Scope dataSensitivity must be an array.');
      else checkVocabList('/scope/dataSensitivity', ds, 'dataSensitivity', problems);
    }
  }

  function checkEntity(type, entity, at, problems) {
    for (var i = 0; i < type.fields.length; i++) {
      var spec = type.fields[i];
      var v = entity[spec.key];
      if (v === undefined) continue;
      var path = at + '/' + spec.key;
      switch (spec.kind) {
        case 'string':
        case 'uri':
        case 'date':
        case 'datetime':
        case 'state':
          if (!core.isString(v)) problem(problems, path, 'FIELD_TYPE', spec.label + ' must be a string, found ' + typeName(v) + '.');
          else if (spec.kind === 'state' && spec.vocab && VOCAB[spec.vocab] && VOCAB[spec.vocab].indexOf(v) === -1) {
            problem(problems, path, 'VOCAB_OUTSIDE', spec.label + ' is "' + v + '", which is outside the default vocabulary. It is preserved and round-tripped as written.', SEVERITY_WARNING);
          }
          break;
        case 'enum':
          if (!core.isString(v)) problem(problems, path, 'FIELD_TYPE', spec.label + ' must be a string, found ' + typeName(v) + '.');
          else if (spec.vocab && VOCAB[spec.vocab] && VOCAB[spec.vocab].indexOf(v) === -1) {
            problem(problems, path, 'VOCAB_OUTSIDE', spec.label + ' is "' + v + '", which is outside the expected vocabulary for this field. It is preserved as written.', SEVERITY_WARNING);
          }
          break;
        case 'number':
        case 'int':
          if (!core.isNumber(v)) problem(problems, path, 'FIELD_TYPE', spec.label + ' must be a number, found ' + typeName(v) + '.');
          else if (spec.kind === 'int' && Math.floor(v) !== v) {
            problem(problems, path, 'FIELD_TYPE', spec.label + ' must be a whole number.', SEVERITY_WARNING);
          } else if (spec.min !== undefined && v < spec.min) {
            problem(problems, path, 'FIELD_RANGE', spec.label + ' is ' + v + ', below the minimum of ' + spec.min + '.');
          } else if (spec.max !== undefined && v > spec.max) {
            problem(problems, path, 'FIELD_RANGE', spec.label + ' is ' + v + ', above the maximum of ' + spec.max + '.');
          }
          break;
        case 'boolean':
          if (!core.isBoolean(v)) problem(problems, path, 'FIELD_TYPE', spec.label + ' must be true or false, found ' + typeName(v) + '.');
          break;
        case 'stringList':
        case 'refList':
          if (!checkStringList(path, v, spec.label, problems)) break;
          break;
        case 'enumList':
          if (!checkStringList(path, v, spec.label, problems)) break;
          if (spec.vocab && VOCAB[spec.vocab]) checkVocabList(path, v, spec.vocab, problems);
          break;
        case 'object':
          if (!core.isObject(v)) {
            problem(problems, path, 'FIELD_TYPE', spec.label + ' must be an object, found ' + typeName(v) + '.');
            break;
          }
          checkInner(path, spec, v, problems);
          break;
        case 'objectList':
          if (!core.isArray(v)) {
            problem(problems, path, 'FIELD_TYPE', spec.label + ' must be an array, found ' + typeName(v) + '.');
            break;
          }
          for (var j = 0; j < v.length; j++) {
            if (!core.isObject(v[j])) {
              problem(problems, path + '/' + j, 'FIELD_TYPE', spec.label + ' entries must be objects.');
              continue;
            }
            checkInner(path + '/' + j, spec, v[j], problems);
          }
          break;
        default:
          break;
      }

      // Byte guards for text that is fed to a renderer.
      if (spec.maxBytes && core.isString(v) && core.utf8Length(v) > spec.maxBytes) {
        problem(
          problems,
          path,
          'FIELD_TOO_LARGE',
          spec.label + ' is ' + core.bytes(core.utf8Length(v)) + ', above the ' + core.bytes(spec.maxBytes) + ' limit this application will render.',
        );
      }
    }
  }

  function checkInner(path, spec, value, problems) {
    var fields = spec.itemFields || [];
    for (var i = 0; i < fields.length; i++) {
      var inner = fields[i];
      var v = value[inner.key];
      if (v === undefined) continue;
      var at = path + '/' + inner.key;
      if (inner.kind === 'boolean') {
        if (!core.isBoolean(v)) problem(problems, at, 'FIELD_TYPE', inner.label + ' must be true or false.');
      } else if (inner.kind === 'number' || inner.kind === 'int') {
        if (!core.isNumber(v)) problem(problems, at, 'FIELD_TYPE', inner.label + ' must be a number.');
        else if (inner.min !== undefined && v < inner.min) problem(problems, at, 'FIELD_RANGE', inner.label + ' is below the minimum of ' + inner.min + '.');
      } else if (inner.kind === 'string' || inner.kind === 'ref') {
        if (!core.isString(v)) problem(problems, at, 'FIELD_TYPE', inner.label + ' must be a string.');
      } else if (inner.kind === 'state' && inner.vocab && VOCAB[inner.vocab] && VOCAB[inner.vocab].indexOf(v) === -1) {
        problem(problems, at, 'VOCAB_OUTSIDE', inner.label + ' is "' + v + '", outside the default vocabulary. It is preserved as written.', SEVERITY_WARNING);
      }
    }
  }

  function checkStringList(path, v, label, problems) {
    if (!core.isArray(v)) {
      problem(problems, path, 'FIELD_TYPE', label + ' must be an array, found ' + typeName(v) + '.');
      return false;
    }
    for (var i = 0; i < v.length; i++) {
      if (!core.isString(v[i])) {
        problem(problems, path + '/' + i, 'FIELD_TYPE', label + ' entries must be strings.');
        return false;
      }
    }
    return true;
  }

  function checkVocabList(path, list, vocabName, problems) {
    var vocab = VOCAB[vocabName];
    if (!vocab) return;
    for (var i = 0; i < list.length; i++) {
      if (vocab.indexOf(list[i]) === -1) {
        problem(problems, path + '/' + i, 'VOCAB_OUTSIDE', '"' + list[i] + '" is outside the canonical vocabulary. It is preserved as written.', SEVERITY_WARNING);
      }
    }
  }

  /** A one-line summary of what a model contains, for the Overview tab and the model switcher. */
  function counts(model) {
    var out = Object.create(null);
    var total = 0;
    for (var i = 0; i < ENTITY_KEYS.length; i++) {
      var n = collection(model, ENTITY_KEYS[i]).length;
      out[ENTITY_KEYS[i]] = n;
      total += n;
    }
    out.total = total;
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Derived views used by more than one tab
  // ---------------------------------------------------------------------------------------------

  /** Threats applied to a given target, via the join entity (§4.10). */
  function threatsForTarget(model, targetType, targetId) {
    var out = [];
    var apps = collection(model, 'threatApplications');
    for (var i = 0; i < apps.length; i++) {
      var a = apps[i];
      if (!a || a.targetType !== targetType || a.targetId !== targetId) continue;
      var threat = get(model, 'threat', a.threatId);
      if (threat) out.push({ application: a, threat: threat });
    }
    return out;
  }

  /** Applications of a given threat. */
  function applicationsForThreat(model, threatId) {
    var out = [];
    var apps = collection(model, 'threatApplications');
    for (var i = 0; i < apps.length; i++) {
      if (apps[i] && apps[i].threatId === threatId) out.push(apps[i]);
    }
    return out;
  }

  /** Controls that reference a threat, whether at root (TML) or through an application (OTM). */
  function controlsForThreat(model, threatId) {
    var out = [];
    var seen = Object.create(null);
    var controls = collection(model, 'control');
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i];
      if (!c || seen[c.id]) continue;
      if (core.isArray(c.threatIds) && c.threatIds.indexOf(threatId) !== -1) {
        seen[c.id] = true;
        out.push(c);
      }
    }
    var apps = applicationsForThreat(model, threatId);
    for (var j = 0; j < apps.length; j++) {
      var states = apps[j].controlStates;
      if (!core.isArray(states)) continue;
      for (var k = 0; k < states.length; k++) {
        var id = states[k] && states[k].controlId;
        if (!core.isString(id) || seen[id]) continue;
        var control = get(model, 'control', id);
        if (control) {
          seen[id] = true;
          out.push(control);
        }
      }
    }
    return out;
  }

  /** Everything that points at an entity, for the "used by" panel and for safe deletion. */
  function referrersOf(model, id) {
    var out = [];
    for (var i = 0; i < REFERENCE_FIELDS.length; i++) {
      var rf = REFERENCE_FIELDS[i];
      var entities = collection(model, rf.type);
      for (var j = 0; j < entities.length; j++) {
        var ent = entities[j];
        if (!core.isObject(ent) || ent.id === id) continue;
        var holders = referenceHolders(ent, rf);
        for (var h = 0; h < holders.length; h++) {
          var v = holders[h] && holders[h][rf.field.key];
          var hit = rf.field.kind === 'ref' ? v === id : core.isArray(v) && v.indexOf(id) !== -1;
          if (hit) {
            out.push({ type: rf.type, typeSpec: TYPE_BY_KEY[rf.type], entity: ent, field: rf.field });
            break;
          }
        }
      }
    }
    return out;
  }

  TMV.model = {
    VOCAB: VOCAB,
    TYPES: TYPES,
    TYPE_BY_KEY: TYPE_BY_KEY,
    TYPE_BY_SINGULAR: TYPE_BY_SINGULAR,
    ENTITY_KEYS: ENTITY_KEYS,
    REFERENCE_FIELDS: REFERENCE_FIELDS,
    FLOW_ENDPOINT_TARGET: FLOW_ENDPOINT_TARGET,
    RISK_BANDS: RISK_BANDS,
    SEVERITY_ERROR: SEVERITY_ERROR,
    SEVERITY_WARNING: SEVERITY_WARNING,

    createEmpty: createEmpty,
    typeFor: typeFor,
    collection: collection,
    index: index,
    get: get,
    findAnywhere: findAnywhere,
    labelOf: labelOf,

    insert: insert,
    update: update,
    remove: remove,
    idAvailable: idAvailable,
    cascadeDeletes: cascadeDeletes,
    dropReferencesTo: dropReferencesTo,
    referrersOf: referrersOf,

    bag: bag,
    setBag: setBag,
    pruneBags: pruneBags,

    normalizeModel: normalizeModel,
    validate: validate,
    counts: counts,

    riskScore: riskScore,
    riskLevel: riskLevel,

    threatsForTarget: threatsForTarget,
    applicationsForThreat: applicationsForThreat,
    controlsForThreat: controlsForThreat,
  };
})(globalThis.TMV = globalThis.TMV || {});
