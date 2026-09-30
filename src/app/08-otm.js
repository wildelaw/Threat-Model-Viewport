/* 08-otm.js — the Open Threat Model mapping, both directions (`06-interchange.md` §5).
 *
 * OTM and the canonical model disagree about *structure*, not just about naming, and the two places
 * they disagree most are the two that look most obvious to write naively:
 *
 *   1. OTM puts asset relationships on the **component** (`components[].assets.processed`); the
 *      canonical model puts them on the asset (`assets[].processedByIds`). The relation is the same
 *      relation, stored from the other end.
 *   2. OTM puts threat instances **inside** the component or data flow (`components[].threats[]`);
 *      the canonical model hoists them into one flat `threatApplications[]` list.
 *
 * Getting either backwards produces a document that validates, renders, and is wrong. Both
 * inversions are therefore done in named functions with the direction in the name, and both are
 * exercised by `interop.otm-roundtrip` over the vendored example.
 *
 * Everything OTM can say but this model does not interpret is kept verbatim in `x.otm`, so an
 * import followed by an export is lossless (§10). That is the whole reason the passthrough bag
 * exists (ADR-0004).
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var model = TMV.model;
  var TmvError = TMV.error;

  /** The OTM version this build targets and writes (`06-interchange.md` §1). */
  var OTM_VERSION = '0.2.0';

  /** Provenance lives in `project.attributes` under these keys (§9). */
  var PROVENANCE_PREFIX = 'tmv:';

  // ---------------------------------------------------------------------------------------------
  // Field classification, for the lossiness ledger (§7)
  // ---------------------------------------------------------------------------------------------
  //
  // `interop.lossiness-complete` walks the vendored schema and fails if any field it finds is not
  // named here. The mapping is therefore *total* over the schema, not just over the fields the code
  // happens to touch — which is the only way "did we forget a field?" becomes a mechanical check
  // instead of a review question.

  var MAPPED = 'mapped';
  var FOLDED = 'folded';
  var DROPPED = 'dropped';
  var UNREACHABLE = 'unreachable';

  /**
   * Every field the OTM schema declares, and what becomes of it.
   *
   * Paths follow the schema's own shape, so the completeness check can walk the schema and look each
   * one up without a translation table: `f` for a root scalar or object, `f.p` for a field of a root
   * object, `a` for a root array, `a[].p` for an item field, `a[].p.q` for a field of a nested object
   * and `a[].p[].q` for a field of an array's items. Containers get an entry of their own — a root
   * array is a field of the document, and leaving it out is exactly the kind of omission the check
   * exists to catch.
   *
   * `unreachable` is for a shape the schema defines but nothing in the document can reach — used
   * once, for TML's `$defs/mitigation-plan`, and included here so the classification stays a total
   * function.
   */
  var OTM_FIELDS = {
    otmVersion: MAPPED,
    project: MAPPED,
    representations: MAPPED,
    assets: MAPPED,
    trustZones: MAPPED,
    components: MAPPED,
    dataflows: MAPPED,
    threats: MAPPED,
    mitigations: MAPPED,
    'project.name': MAPPED,
    'project.id': MAPPED,
    'project.description': MAPPED,
    'project.owner': MAPPED,
    'project.ownerContact': MAPPED,
    'project.tags': MAPPED,
    'project.attributes': MAPPED,

    'trustZones[].id': MAPPED,
    'trustZones[].name': MAPPED,
    'trustZones[].type': MAPPED,
    'trustZones[].description': MAPPED,
    'trustZones[].risk': MAPPED,
    'trustZones[].risk.trustRating': MAPPED,
    'trustZones[].parent': MAPPED,
    'trustZones[].parent.trustZone': MAPPED,
    'trustZones[].parent.component': MAPPED,
    'trustZones[].representations': MAPPED,
    'trustZones[].attributes': MAPPED,

    'representations[].id': MAPPED,
    'representations[].name': MAPPED,
    'representations[].type': MAPPED,
    'representations[].description': MAPPED,
    'representations[].size': MAPPED,
    'representations[].size.width': MAPPED,
    'representations[].size.height': MAPPED,
    'representations[].repository': MAPPED,
    'representations[].repository.url': MAPPED,
    'representations[].attributes': MAPPED,

    'trustZones[].representations[].id': MAPPED,
    'trustZones[].representations[].representation': MAPPED,
    'trustZones[].representations[].name': MAPPED,
    'trustZones[].representations[].position': MAPPED,
    'trustZones[].representations[].position.x': MAPPED,
    'trustZones[].representations[].position.y': MAPPED,
    'trustZones[].representations[].size': MAPPED,
    'trustZones[].representations[].size.width': MAPPED,
    'trustZones[].representations[].size.height': MAPPED,
    'trustZones[].representations[].file': MAPPED,
    'trustZones[].representations[].line': MAPPED,
    'trustZones[].representations[].codeSnippet': MAPPED,
    'trustZones[].representations[].attributes': MAPPED,
    'components[].representations[].id': MAPPED,
    'components[].representations[].representation': MAPPED,
    'components[].representations[].name': MAPPED,
    'components[].representations[].position': MAPPED,
    'components[].representations[].position.x': MAPPED,
    'components[].representations[].position.y': MAPPED,
    'components[].representations[].size': MAPPED,
    'components[].representations[].size.width': MAPPED,
    'components[].representations[].size.height': MAPPED,
    'components[].representations[].file': MAPPED,
    'components[].representations[].line': MAPPED,
    'components[].representations[].codeSnippet': MAPPED,
    'components[].representations[].attributes': MAPPED,
    'assets[].id': MAPPED,
    'assets[].name': MAPPED,
    'assets[].description': MAPPED,
    'assets[].risk': MAPPED,
    'assets[].risk.confidentiality': MAPPED,
    'assets[].risk.integrity': MAPPED,
    'assets[].risk.availability': MAPPED,
    'assets[].risk.comment': MAPPED,
    'assets[].attributes': MAPPED,

    'components[].id': MAPPED,
    'components[].name': MAPPED,
    'components[].type': MAPPED,
    'components[].description': MAPPED,
    'components[].parent': MAPPED,
    'components[].parent.trustZone': MAPPED,
    'components[].parent.component': MAPPED,
    'components[].representations': MAPPED,
    'components[].assets': MAPPED,
    'components[].assets.processed': MAPPED,
    'components[].assets.stored': MAPPED,
    'components[].threats': MAPPED,
    'components[].threats[].threat': MAPPED,
    'components[].threats[].state': MAPPED,
    'components[].threats[].mitigations': MAPPED,
    'components[].threats[].mitigations[].mitigation': MAPPED,
    'components[].threats[].mitigations[].state': MAPPED,
    'components[].tags': MAPPED,
    'components[].attributes': MAPPED,

    'dataflows[].id': MAPPED,
    'dataflows[].name': MAPPED,
    'dataflows[].description': MAPPED,
    'dataflows[].bidirectional': MAPPED,
    'dataflows[].source': MAPPED,
    'dataflows[].destination': MAPPED,
    'dataflows[].assets': MAPPED,
    'dataflows[].threats': MAPPED,
    'dataflows[].threats[].threat': MAPPED,
    'dataflows[].threats[].state': MAPPED,
    'dataflows[].threats[].mitigations': MAPPED,
    'dataflows[].threats[].mitigations[].mitigation': MAPPED,
    'dataflows[].threats[].mitigations[].state': MAPPED,
    'dataflows[].tags': MAPPED,
    'dataflows[].attributes': MAPPED,

    'threats[].id': MAPPED,
    'threats[].name': MAPPED,
    'threats[].description': MAPPED,
    'threats[].categories': MAPPED,
    'threats[].cwes': MAPPED,
    'threats[].risk': MAPPED,
    'threats[].risk.likelihood': MAPPED,
    'threats[].risk.likelihoodComment': MAPPED,
    'threats[].risk.impact': MAPPED,
    'threats[].risk.impactComment': MAPPED,
    'threats[].tags': MAPPED,
    'threats[].attributes': MAPPED,

    'mitigations[].id': MAPPED,
    'mitigations[].name': MAPPED,
    'mitigations[].description': MAPPED,
    'mitigations[].riskReduction': MAPPED,
    'mitigations[].attributes': MAPPED,
  };

  // ---------------------------------------------------------------------------------------------
  // Import — OTM → canonical (§5.1)
  // ---------------------------------------------------------------------------------------------

  function isUuid(value) {
    return core.isString(value) && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
  }

  /** Every known OTM key at a level, so the remainder can be kept verbatim rather than guessed at. */
  function extras(source, known) {
    var out = Object.create(null);
    var ks = Object.keys(source || {});
    for (var i = 0; i < ks.length; i++) {
      if (known[ks[i]]) continue;
      out[ks[i]] = core.deepCopy(source[ks[i]]);
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Import an OTM document.
   *
   * Returns `{model, report}` and never throws for data reasons — a document that is wrong in one
   * place still imports what it gets right, and the report says what was left out. The caller decides
   * whether the report is acceptable (that is §3's warning tier).
   */
  function toCanonical(otm, options) {
    var opts = options || {};
    var report = emptyReport('otm');
    if (!core.isObject(otm)) throw TmvError('OTM_SHAPE', 'An OTM document must be a JSON object.');

    var project = core.isObject(otm.project) ? otm.project : {};
    var projectId = core.isString(project.id) ? project.id : null;
    var m = model.createEmpty(core.isString(project.name) ? project.name : 'Imported model', isUuid(projectId) ? projectId : null);
    m.description = core.isString(project.description) ? project.description : '';

    // Metadata. OTM has three fields here and the canonical model has a `metadata` object; the rest
    // of TML's metadata fields simply stay absent, which is honest for a format that cannot say them.
    if (core.isString(project.owner)) m.metadata.owner = project.owner;
    if (core.isString(project.ownerContact)) m.metadata.ownerContact = project.ownerContact;
    if (core.isArray(project.tags)) m.metadata.tags = cleanStrings(project.tags);

    var bag = Object.create(null);
    bag.otmVersion = core.isString(otm.otmVersion) ? otm.otmVersion : OTM_VERSION;
    if (projectId && !isUuid(projectId)) bag.projectId = projectId;
    var attributes = core.isObject(project.attributes) ? project.attributes : null;
    if (attributes) {
      var provenance = readProvenance(attributes);
      if (provenance) report.provenance = provenance;
      var remainder = stripProvenance(attributes);
      if (remainder) bag.attributes = remainder;
    }
    var projectExtras = extras(project, { name: 1, id: 1, description: 1, owner: 1, ownerContact: 1, tags: 1, attributes: 1 });
    if (projectExtras) bag.projectExtras = projectExtras;
    model.setBag(m, 'otm', bag);

    // --- trust zones, and the representation elements they own
    var zones = asArray(otm.trustZones);
    for (var z = 0; z < zones.length; z++) {
      var raw = zones[z];
      if (!core.isObject(raw)) continue;
      var zone = model.insert(m, 'trustZone', defined({
        id: core.isString(raw.id) ? raw.id : null,
        name: text(raw.name),
        type: core.isString(raw.type) ? raw.type : undefined,
        description: text(raw.description),
      }));
      putNumber(zone, 'trustRating', raw.risk && raw.risk.trustRating);
      // `parent` is `{trustZone}` or `{component}`; only the zone case is a zone's parent, and a
      // component parent is kept in the bag rather than invented into the model.
      if (raw.parent && core.isString(raw.parent.trustZone)) zone.parentId = raw.parent.trustZone;
      else if (raw.parent && core.isString(raw.parent.component)) {
        model.setBag(zone, 'otm', { parentComponentId: raw.parent.component });
      }
      var zoneExtras = extras(raw, { id: 1, name: 1, type: 1, description: 1, risk: 1, parent: 1, representations: 1, attributes: 1 });
      if (raw.attributes && core.isObject(raw.attributes)) {
        zoneExtras = zoneExtras || Object.create(null);
        zoneExtras.attributes = core.deepCopy(raw.attributes);
      }
      if (zoneExtras) model.setBag(zone, 'otm', zoneExtras);
      importElements(m, raw.representations, zone.id, 'trustZone', report);
    }

    // --- representations (canvases) and their sizes
    var reps = asArray(otm.representations);
    for (var r = 0; r < reps.length; r++) {
      var rawRep = reps[r];
      if (!core.isObject(rawRep)) continue;
      var rep = model.insert(m, 'representation', defined({
        id: core.isString(rawRep.id) ? rawRep.id : null,
        name: text(rawRep.name),
        type: text(rawRep.type),
        description: text(rawRep.description),
      }));
      if (rawRep.size) {
        putNumber(rep, 'width', rawRep.size.width);
        putNumber(rep, 'height', rawRep.size.height);
      }
      if (rawRep.repository && core.isString(rawRep.repository.url)) rep.repositoryUrl = rawRep.repository.url;
      var repExtras = extras(rawRep, { id: 1, name: 1, type: 1, description: 1, size: 1, repository: 1, attributes: 1 });
      if (rawRep.attributes && core.isObject(rawRep.attributes)) {
        repExtras = repExtras || Object.create(null);
        repExtras.attributes = core.deepCopy(rawRep.attributes);
      }
      if (repExtras) model.setBag(rep, 'otm', repExtras);
    }

    // --- assets, with the CIA triple OTM requires
    var assets = asArray(otm.assets);
    for (var a = 0; a < assets.length; a++) {
      var rawAsset = assets[a];
      if (!core.isObject(rawAsset)) continue;
      var asset = model.insert(m, 'asset', defined({
        id: core.isString(rawAsset.id) ? rawAsset.id : null,
        name: text(rawAsset.name),
        description: text(rawAsset.description),
      }));
      var risk = core.isObject(rawAsset.risk) ? rawAsset.risk : {};
      putNumber(asset, 'confidentiality', risk.confidentiality);
      putNumber(asset, 'integrity', risk.integrity);
      putNumber(asset, 'availability', risk.availability);
      if (core.isString(risk.comment)) asset.riskComment = risk.comment;
      var assetExtras = extras(rawAsset, { id: 1, name: 1, description: 1, risk: 1, attributes: 1 });
      if (assetExtras) model.setBag(asset, 'otm', assetExtras);
    }

    // --- components
    var components = asArray(otm.components);
    for (var c = 0; c < components.length; c++) {
      var rawComp = components[c];
      if (!core.isObject(rawComp)) continue;
      var comp = model.insert(m, 'component', defined({
        id: core.isString(rawComp.id) ? rawComp.id : null,
        name: text(rawComp.name),
        description: text(rawComp.description),
        type: core.isString(rawComp.type) ? rawComp.type : undefined,
        tags: core.isArray(rawComp.tags) ? cleanStrings(rawComp.tags) : undefined,
      }));
      // `parent` is `{trustZone}` or `{component}`. A component parent is the component hierarchy;
      // a zone parent is the security zone. The canonical model keeps both, on separate fields.
      if (rawComp.parent && core.isString(rawComp.parent.trustZone)) comp.trustZoneId = rawComp.parent.trustZone;
      else if (rawComp.parent && core.isString(rawComp.parent.component)) comp.parentId = rawComp.parent.component;
      var compExtras = extras(rawComp, {
        id: 1, name: 1, type: 1, description: 1, parent: 1, representations: 1,
        assets: 1, threats: 1, tags: 1, attributes: 1,
      });
      if (compExtras) model.setBag(comp, 'otm', compExtras);
      importElements(m, rawComp.representations, comp.id, 'component', report);
      importThreatInstances(m, rawComp.threats, 'component', comp.id, report);
      // OTM holds processed/stored on the component; the canonical model holds them on the asset.
      linkAssets(m, rawComp.assets, comp.id, report, c);
    }

    // --- data flows
    var flows = asArray(otm.dataflows);
    for (var f = 0; f < flows.length; f++) {
      var rawFlow = flows[f];
      if (!core.isObject(rawFlow)) continue;
      var flow = model.insert(m, 'dataFlow', defined({
        id: core.isString(rawFlow.id) ? rawFlow.id : null,
        name: text(rawFlow.name),
        description: text(rawFlow.description),
        bidirectional: core.isBoolean(rawFlow.bidirectional) ? rawFlow.bidirectional : undefined,
        tags: core.isArray(rawFlow.tags) ? cleanStrings(rawFlow.tags) : undefined,
        assetIds: core.isArray(rawFlow.assets) ? cleanStrings(rawFlow.assets) : undefined,
      }));
      // OTM's endpoints are plain strings naming components. The endpoint *type* is therefore known
      // here even though OTM does not state it — components are what OTM has flows between.
      if (core.isString(rawFlow.source)) {
        flow.sourceId = rawFlow.source;
        flow.sourceType = 'component';
      }
      if (core.isString(rawFlow.destination)) {
        flow.destinationId = rawFlow.destination;
        flow.destinationType = 'component';
      }
      var flowExtras = extras(rawFlow, {
        id: 1, name: 1, description: 1, bidirectional: 1, source: 1, destination: 1,
        assets: 1, threats: 1, tags: 1, attributes: 1,
      });
      if (flowExtras) model.setBag(flow, 'otm', flowExtras);
      importThreatInstances(m, rawFlow.threats, 'dataFlow', flow.id, report);
    }

    // --- threats
    var threats = asArray(otm.threats);
    for (var t = 0; t < threats.length; t++) {
      var rawThreat = threats[t];
      if (!core.isObject(rawThreat)) continue;
      var threat = model.insert(m, 'threat', defined({
        id: core.isString(rawThreat.id) ? rawThreat.id : null,
        name: text(rawThreat.name),
        description: text(rawThreat.description),
        categories: core.isArray(rawThreat.categories) ? cleanStrings(rawThreat.categories) : undefined,
        cwes: core.isArray(rawThreat.cwes) ? cleanStrings(rawThreat.cwes) : undefined,
      }));
      var tRisk = core.isObject(rawThreat.risk) ? rawThreat.risk : {};
      if (core.isNumber(tRisk.likelihood)) threat.likelihood = tRisk.likelihood;
      if (core.isNumber(tRisk.impact)) threat.impact = tRisk.impact;
      if (core.isString(tRisk.likelihoodComment)) threat.likelihoodComment = tRisk.likelihoodComment;
      if (core.isString(tRisk.impactComment)) threat.impactComment = tRisk.impactComment;
      var threatExtras = extras(rawThreat, { id: 1, name: 1, description: 1, categories: 1, cwes: 1, risk: 1, tags: 1, attributes: 1 });
      if (threatExtras) model.setBag(threat, 'otm', threatExtras);
      if (core.isArray(rawThreat.tags)) {
        var tt = model.bag(threat, 'otm') || Object.create(null);
        tt.tags = cleanStrings(rawThreat.tags);
        model.setBag(threat, 'otm', tt);
      }
    }

    // --- mitigations become controls. `status` and `priority` are left unset: OTM has no equivalent
    // and a default would be an invented assessment (§5.1).
    var mitigations = asArray(otm.mitigations);
    for (var mi = 0; mi < mitigations.length; mi++) {
      var rawMit = mitigations[mi];
      if (!core.isObject(rawMit)) continue;
      var control = model.insert(m, 'control', defined({
        id: core.isString(rawMit.id) ? rawMit.id : null,
        name: text(rawMit.name),
        description: text(rawMit.description),
      }));
      putNumber(control, 'riskReduction', rawMit.riskReduction);
      var mitExtras = extras(rawMit, { id: 1, name: 1, description: 1, riskReduction: 1, attributes: 1 });
      if (mitExtras) model.setBag(control, 'otm', mitExtras);
    }

    // Links named by ids that were not imported are dropped with a note rather than left dangling,
    // so a report of "3 references unresolved" means something the user can act on.
    var unresolved = dropUnresolvedReferences(m, report, opts.referential || 'warning');
    report.unresolved = unresolved;
    report.counts = model.counts(m);
    return { model: m, report: report };
  }

  /**
   * Hoist OTM's `representations[]` element lists into the model-level `representationElements[]`.
   *
   * OTM nests them under their owner; the canonical model keeps one flat list with an owner. The
   * `representation` field inside each element is the *canvas* it is drawn on, and the containing
   * object is the thing being drawn — two different relations that both have to survive.
   */
  function importElements(m, list, ownerId, ownerType, report) {
    var elements = asArray(list);
    for (var i = 0; i < elements.length; i++) {
      var raw = elements[i];
      if (!core.isObject(raw)) continue;
      var el = model.insert(m, 'representationElement', defined({
        id: core.isString(raw.id) ? raw.id : null,
        name: text(raw.name),
        ownerId: ownerId,
        ownerType: ownerType,
        representationId: core.isString(raw.representation) ? raw.representation : null,
        // Copied whole rather than field by field: OTM's `position`/`size` are the canonical
        // `position`/`size`, so a key inside either that this model does not interpret survives
        // instead of being dropped (§10).
        position: core.isObject(raw.position) ? raw.position : undefined,
        size: core.isObject(raw.size) ? raw.size : undefined,
      }));
      if (core.isString(raw.file)) el.file = raw.file;
      if (core.isNumber(raw.line)) el.line = Math.round(raw.line);
      if (core.isString(raw.codeSnippet)) el.codeSnippet = raw.codeSnippet;
      var elExtras = extras(raw, { id: 1, representation: 1, name: 1, position: 1, size: 1, file: 1, line: 1, codeSnippet: 1, attributes: 1 });
      if (raw.attributes && core.isObject(raw.attributes)) {
        elExtras = elExtras || Object.create(null);
        elExtras.attributes = core.deepCopy(raw.attributes);
      }
      if (elExtras) model.setBag(el, 'otm', elExtras);
    }
  }

  /**
   * Flatten OTM's nested threat instances into `threatApplications[]`.
   *
   * The nested form carries two facts the flat form must not lose: which threat, and — for each
   * mitigation listed on that instance — the state of *that mitigation against that threat*. Both
   * end up on the application: `state`, and `controlStates[]`.
   */
  function importThreatInstances(m, list, targetType, targetId, report) {
    var instances = asArray(list);
    for (var i = 0; i < instances.length; i++) {
      var raw = instances[i];
      if (!core.isObject(raw) || !core.isString(raw.threat)) continue;
      var app = model.insert(m, 'threatApplication', defined({
        threatId: raw.threat,
        targetType: targetType,
        targetId: targetId,
        // OTM's `state` is a free string and is kept verbatim: a value outside the canonical
        // vocabulary is data, not an error (`03-data-model.md` §4.10).
        state: core.isString(raw.state) ? raw.state : undefined,
      }));
      // OTM's nested threat instance carries no id of its own, so the join entity gets a fresh one.
      // Reported rather than hidden: re-importing an exported file therefore produces a canonically
      // *different* model, and a user comparing the two should know why.
      report.generatedIds.push(app.id);
      var mitigations = asArray(raw.mitigations);
      var states = [];
      for (var mi = 0; mi < mitigations.length; mi++) {
        var entry = mitigations[mi];
        if (!core.isObject(entry) || !core.isString(entry.mitigation)) continue;
        var row = Object.create(null);
        row.controlId = entry.mitigation;
        if (core.isString(entry.state)) row.state = entry.state;
        states.push(row);
      }
      if (states.length) app.controlStates = states;
      var appExtras = extras(raw, { threat: 1, state: 1, mitigations: 1 });
      if (appExtras) model.setBag(app, 'otm', appExtras);
    }
  }

  /**
   * Invert OTM's component-side asset links onto the assets themselves.
   *
   * The dangling case needs its own report. Canonical keeps this relation on the *asset*
   * (`asset.processedByIds`), so a component naming an asset the document does not contain leaves no
   * canonical reference behind for `model.validate` to find — there is no asset to hold it. That is
   * exactly the case `06-interchange.md` §3 names ("an `assets.processed` naming an absent asset"),
   * and the requirement is that it be reported rather than dropped, so it is recorded here.
   */
  function linkAssets(m, holder, componentId, report, compIndex) {
    if (!core.isObject(holder)) return;
    var names = { processed: 'processedByIds', stored: 'storedByIds' };
    var kinds = Object.keys(names);
    for (var k = 0; k < kinds.length; k++) {
      var list = asArray(holder[kinds[k]]);
      for (var i = 0; i < list.length; i++) {
        var assetId = list[i];
        if (!core.isString(assetId)) continue;
        var asset = model.get(m, 'asset', assetId);
        if (!asset) {
          report.droppedRefs.push({ from: 'component ' + componentId, kind: kinds[k], to: assetId });
          report.unresolved.push({
            type: 'components',
            field: 'assets.' + kinds[k],
            target: assetId,
            path: '/components/' + compIndex + '/assets/' + kinds[k] + '/' + i,
          });
          continue;
        }
        var field = names[kinds[k]];
        if (!core.isArray(asset[field])) asset[field] = [];
        if (asset[field].indexOf(componentId) === -1) asset[field].push(componentId);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Export — canonical → OTM (§5.2)
  // ---------------------------------------------------------------------------------------------

  /**
   * Build an OTM document.
   *
   * Returns `{document, report, blocked}`. `blocked` is a **to-do list, not an error** (§8): each
   * entry names the entity, the missing field and the fix. A flow without endpoints and a reference
   * to a deleted entity are the two things no default can honestly stand in for, and they are the
   * only two that block.
   */
  function fromCanonical(m, options) {
    var opts = options || {};
    var report = emptyReport('otm');
    var blocked = [];

    if (!core.present(m.name)) {
      blocked.push({
        code: 'OTM_NO_PROJECT_NAME',
        entity: 'model',
        field: 'name',
        message: 'OTM requires a project name. Give this model a name and export again.',
      });
    }

    var bag = model.bag(m, 'otm') || Object.create(null);
    var doc = {
      otmVersion: OTM_VERSION,
      project: {
        name: core.present(m.name) ? m.name : '',
        // OTM's project id is not required to be a UUID, so an imported one that was not a UUID could
        // not become the canonical `modelId` and was preserved in the bag instead (§5.1). Writing the
        // bag's value back is what makes `project.id` survive the round trip §10 promises.
        id: core.isString(bag.projectId) ? bag.projectId : m.modelId,
      },
    };
    if (core.present(m.description)) doc.project.description = m.description;
    if (core.isString(m.metadata.owner)) doc.project.owner = m.metadata.owner;
    if (core.isString(m.metadata.ownerContact)) doc.project.ownerContact = m.metadata.ownerContact;
    if (core.isArray(m.metadata.tags) && m.metadata.tags.length) doc.project.tags = m.metadata.tags.slice();
    if (core.isObject(bag.attributes) || core.isObject(opts.provenance)) {
      var attrs = core.deepCopy(bag.attributes) || Object.create(null);
      if (core.isObject(opts.provenance)) {
        var provKeys = Object.keys(opts.provenance);
        for (var pk = 0; pk < provKeys.length; pk++) {
          attrs[PROVENANCE_PREFIX + provKeys[pk]] = core.deepCopy(opts.provenance[provKeys[pk]]);
        }
      }
      doc.project.attributes = attrs;
    }
    if (core.isObject(bag.projectExtras)) {
      var extraKeys = Object.keys(bag.projectExtras);
      for (var e = 0; e < extraKeys.length; e++) doc.project[extraKeys[e]] = core.deepCopy(bag.projectExtras[extraKeys[e]]);
    }

    // --- trust zones. `risk.trustRating` is required; 100 is synthesized and disclosed, because a
    // rating is a preference and a disclosed default is recoverable (§8).
    doc.trustZones = [];
    // `index` takes the model and returns one map per collection, so the zone lookup is
    // `index(m).trustZones`. Passing a collection name as a second argument is silently ignored and
    // yields a map keyed by collection — under which *every* parent zone looks absent, and a
    // legitimate hierarchy blocks the export as a dangling reference forever.
    var zoneById = model.index(m).trustZones;
    var zones = m.trustZones;
    for (var z = 0; z < zones.length; z++) {
      var zone = zones[z];
      var outZone = { id: zone.id, name: core.present(zone.name) ? zone.name : zone.id };
      if (core.isString(zone.type)) outZone.type = zone.type;
      if (core.present(zone.description)) outZone.description = zone.description;
      var rating = core.isNumber(zone.trustRating) ? zone.trustRating : null;
      if (rating === null) {
        rating = 100;
        disclose(report, 'trustRating', 'trustZone', zone.id, 'no trust rating was set');
      }
      outZone.risk = { trustRating: rating };
      var parentComponentId = (model.bag(zone, 'otm') || {}).parentComponentId;
      if (core.isString(parentComponentId) && model.get(m, 'component', parentComponentId)) {
        outZone.parent = { component: parentComponentId };
      } else if (core.isString(zone.parentId)) {
        if (zoneById[zone.parentId]) {
          outZone.parent = { trustZone: zone.parentId };
        } else {
          blocked.push({
            code: 'OTM_DANGLING_REF', entity: 'trustZone', id: zone.id, field: 'parentId',
            message: 'This trust zone\'s parent names a zone that no longer exists. Remove the parent, or restore it.',
          });
        }
      }
      outZone.representations = exportElements(m, zone.id, report);
      if (!outZone.representations.length) delete outZone.representations;
      reEmitBag(outZone, model.bag(zone, 'otm'), { parentComponentId: 1, attributes: 1 });
      doc.trustZones.push(outZone);
    }

    // --- representations
    doc.representations = [];
    for (var r = 0; r < m.representations.length; r++) {
      var rep = m.representations[r];
      var outRep = { id: rep.id, name: core.present(rep.name) ? rep.name : rep.id, type: core.present(rep.type) ? rep.type : 'generic' };
      if (core.present(rep.description)) outRep.description = rep.description;
      if (core.isNumber(rep.width) || core.isNumber(rep.height)) {
        outRep.size = { width: core.isNumber(rep.width) ? rep.width : 0, height: core.isNumber(rep.height) ? rep.height : 0 };
      }
      if (core.present(rep.repositoryUrl)) outRep.repository = { url: rep.repositoryUrl };
      reEmitBag(outRep, model.bag(rep, 'otm'));
      doc.representations.push(outRep);
    }

    // --- assets, with the CIA triple OTM requires (`0` means "no assessed impact", §8)
    doc.assets = [];
    for (var a = 0; a < m.assets.length; a++) {
      var asset = m.assets[a];
      var outAsset = { id: asset.id, name: core.present(asset.name) ? asset.name : asset.id, risk: {} };
      if (core.present(asset.description)) outAsset.description = asset.description;
      var cia = ['confidentiality', 'integrity', 'availability'];
      for (var ci = 0; ci < cia.length; ci++) {
        if (core.isNumber(asset[cia[ci]])) outAsset.risk[cia[ci]] = asset[cia[ci]];
        else {
          outAsset.risk[cia[ci]] = 0;
          disclose(report, 'risk.' + cia[ci], 'asset', asset.id, 'no ' + cia[ci] + ' score was set');
        }
      }
      if (core.present(asset.riskComment)) outAsset.risk.comment = asset.riskComment;
      reEmitBag(outAsset, model.bag(asset, 'otm'));
      doc.assets.push(outAsset);
    }

    // --- components. OTM requires `parent` on every component, so anything with no zone needs a zone
    // to live in. The placeholder is created *lazily* — only when something actually needs it, so a
    // fully-zoned model gains nothing — and is disclosed, because an undisclosed synthesized zone
    // would read as something the author wrote (§8).
    doc.components = [];
    var placeholderZoneId = null;

    function ensurePlaceholder() {
      if (placeholderZoneId) return placeholderZoneId;
      placeholderZoneId = 'tmv-unassigned';
      doc.trustZones.push({
        id: placeholderZoneId,
        name: 'Unassigned',
        description:
          'Added by Threat-Model-Viewport: OTM requires every component to have a parent, and these have none.',
        risk: { trustRating: 100 },
      });
      disclose(
        report,
        'components[].parent',
        'model',
        m.modelId,
        'a placeholder trust zone "Unassigned" was added for entities with no parent',
      );
      return placeholderZoneId;
    }

    function parentOf(entity) {
      if (core.isString(entity.trustZoneId) && model.get(m, 'trustZone', entity.trustZoneId)) {
        return { trustZone: entity.trustZoneId };
      }
      if (core.isString(entity.parentId) && model.get(m, 'component', entity.parentId)) {
        return { component: entity.parentId };
      }
      return { trustZone: ensurePlaceholder() };
    }

    for (var cc = 0; cc < m.components.length; cc++) {
      var component = m.components[cc];
      var outComp = {
        id: component.id,
        name: core.present(component.name) ? component.name : component.id,
        type: core.present(component.type) ? component.type : 'unknown',
        parent: parentOf(component),
      };
      if (!core.present(component.type)) disclose(report, 'components[].type', 'component', component.id, 'no type was set');
      if (core.present(component.description)) outComp.description = component.description;
      var repElements = exportElements(m, component.id, report);
      if (repElements.length) outComp.representations = repElements;
      var instanceAssets = exportAssetInstances(m, component.id);
      if (instanceAssets) outComp.assets = instanceAssets;
      var nested = exportThreatInstances(m, 'component', component.id);
      if (nested.length) outComp.threats = nested;
      if (core.isArray(component.tags) && component.tags.length) outComp.tags = component.tags.slice();
      var compBag = model.bag(component, 'otm') || Object.create(null);
      reEmitBag(outComp, compBag);
      if (core.isArray(compBag.tags) && !outComp.tags) outComp.tags = compBag.tags;
      doc.components.push(outComp);
    }

    // The fold (§5.3): actors and data stores have no OTM home, but OTM models them as components
    // with a synthesized type, which is a better outcome than dropping them. It is an option rather
    // than an unannounced default because the reading does not reverse — afterwards, a component of
    // type "database" cannot be told from a data store that was folded into one.
    var foldActors = opts.foldActors !== false;
    var foldStores = opts.foldDataStores !== false;

    if (foldActors) {
      for (var ac = 0; ac < m.actors.length; ac++) {
        var actor = m.actors[ac];
        var outActor = {
          id: actor.id,
          name: core.present(actor.name) ? actor.name : actor.id,
          type: 'actor',
          parent: parentOf(actor),
        };
        if (core.present(actor.description)) outActor.description = actor.description;
        // A threat applied to this actor becomes an instance of the component it was folded into.
        // The canonical `targetType` vocabulary has no `actor` member, so an application to one is
        // stored as a component application anyway; nesting it here is what stops the fold from
        // silently taking the assessments with it.
        var actorApps = exportThreatInstances(m, 'component', actor.id);
        if (actorApps.length) outActor.threats = actorApps;
        doc.components.push(outActor);
        report.folded.push({ entity: 'actor', id: actor.id, as: 'component with type "actor"' });
      }
    }
    if (foldStores) {
      for (var ds = 0; ds < m.dataStores.length; ds++) {
        var store = m.dataStores[ds];
        var outStore = {
          id: store.id,
          name: core.present(store.name) ? store.name : store.id,
          type: 'database',
          parent: parentOf(store),
        };
        if (core.present(store.description)) outStore.description = store.description;
        var storeApps = exportThreatInstances(m, 'component', store.id);
        if (storeApps.length) outStore.threats = storeApps;
        doc.components.push(outStore);
        report.folded.push({ entity: 'dataStore', id: store.id, as: 'component with type "database"' });
      }
    }

    // --- data flows. Endpoints cannot be synthesized (§8): a flow with no endpoints asserts
    // nothing, so a missing one blocks with a per-flow instruction. An endpoint that names an entity
    // which is not there blocks too, and for the same sentence in §8: a flow's `source`/`destination`
    // are written into the document as-is, so a deleted entity leaves a name the recipient's tool
    // cannot resolve — a broken document, which is exactly what the "reference to a deleted entity"
    // row rules out. Every other dangling reference here is *dropped* (folded away or reported through
    // `droppedRefs`); this one is the only reference the export copies verbatim, and so the only one
    // it cannot quietly survive.
    doc.dataflows = [];
    for (var ff = 0; ff < m.dataFlows.length; ff++) {
      var flow = m.dataFlows[ff];
      var missing = [];
      if (!core.present(flow.sourceId)) missing.push('source');
      if (!core.present(flow.destinationId)) missing.push('destination');
      if (missing.length) {
        blocked.push({
          code: 'OTM_NO_ENDPOINTS',
          entity: 'dataFlow',
          id: flow.id,
          field: missing.join(', '),
          message:
            '"' + (core.present(flow.name) ? flow.name : flow.id) + '" has no ' + missing.join(' or ') +
            '. A data flow needs both ends to mean anything — set ' + (missing.length > 1 ? 'them' : 'it') + ' and export again.',
        });
        continue;
      }
      // A folded actor or data store keeps its id as the component it became, so it resolves; one
      // that is not folded has no name in the document at all, and an endpoint pointing at it dangles.
      var endpoints = [flow.sourceId, flow.destinationId];
      var endpointFields = ['sourceId', 'destinationId'];
      var broken = null;
      for (var ep = 0; ep < endpoints.length && !broken; ep++) {
        var target = endpoints[ep];
        var resolves =
          !!model.get(m, 'component', target) ||
          (foldActors && !!model.get(m, 'actor', target)) ||
          (foldStores && !!model.get(m, 'dataStore', target));
        if (!resolves) broken = endpointFields[ep];
      }
      if (broken) {
        blocked.push({
          code: 'OTM_DANGLING_REF',
          entity: 'dataFlow',
          id: flow.id,
          field: broken,
          target: flow[broken],
          message:
            '"' + (core.present(flow.name) ? flow.name : flow.id) + '" points at the entity at that end of the flow — "' +
            flow[broken] + '" — that is no longer in this model. Restore it, repoint the reference, or clear it, then export again.',
        });
        continue;
      }
      var outFlow = {
        id: flow.id,
        name: core.present(flow.name) ? flow.name : flow.id,
        source: flow.sourceId,
        destination: flow.destinationId,
      };
      if (core.present(flow.description)) outFlow.description = flow.description;
      if (core.isBoolean(flow.bidirectional)) outFlow.bidirectional = flow.bidirectional;
      if (core.isArray(flow.assetIds) && flow.assetIds.length) {
        outFlow.assets = flow.assetIds.filter(function (id) {
          return !!model.get(m, 'asset', id);
        });
        if (!outFlow.assets.length) delete outFlow.assets;
      }
      var flowNested = exportThreatInstances(m, 'dataFlow', flow.id);
      if (flowNested.length) outFlow.threats = flowNested;
      if (core.isArray(flow.tags) && flow.tags.length) outFlow.tags = flow.tags.slice();
      reEmitBag(outFlow, model.bag(flow, 'otm'));
      doc.dataflows.push(outFlow);
    }

    // --- threats. `risk.likelihood` and `risk.impact` are required; the midpoint is synthesized and
    // disclosed, because a midpoint is visibly a placeholder (§8).
    doc.threats = [];
    for (var tt = 0; tt < m.threats.length; tt++) {
      var threat = m.threats[tt];
      var outThreat = { id: threat.id, name: core.present(threat.name) ? threat.name : threat.id, risk: {} };
      if (core.present(threat.description)) outThreat.description = threat.description;
      if (core.isArray(threat.categories) && threat.categories.length) outThreat.categories = threat.categories.slice();
      if (core.isArray(threat.cwes) && threat.cwes.length) outThreat.cwes = threat.cwes.slice();
      var fields = ['likelihood', 'impact'];
      for (var li = 0; li < fields.length; li++) {
        if (core.isNumber(threat[fields[li]])) outThreat.risk[fields[li]] = threat[fields[li]];
        else {
          outThreat.risk[fields[li]] = 50;
          disclose(report, 'threats[].risk.' + fields[li], 'threat', threat.id, 'no ' + fields[li] + ' was set');
        }
      }
      if (core.present(threat.likelihoodComment)) outThreat.risk.likelihoodComment = threat.likelihoodComment;
      if (core.present(threat.impactComment)) outThreat.risk.impactComment = threat.impactComment;
      var threatBag = model.bag(threat, 'otm') || Object.create(null);
      reEmitBag(outThreat, threatBag);
      if (core.isArray(threatBag.tags) && !outThreat.tags) outThreat.tags = threatBag.tags;
      doc.threats.push(outThreat);
    }

    // --- mitigations. `riskReduction` is required; 0 claims no reduction, which is the safe
    // direction and is disclosed (§8). A control with mitigation-plan membership exports the same
    // way — OTM has no separate plan object.
    doc.mitigations = [];
    for (var mm = 0; mm < m.controls.length; mm++) {
      var control = m.controls[mm];
      var outMit = { id: control.id, name: core.present(control.name) ? control.name : control.id };
      if (core.present(control.description)) outMit.description = control.description;
      if (core.isNumber(control.riskReduction)) outMit.riskReduction = control.riskReduction;
      else {
        outMit.riskReduction = 0;
        disclose(report, 'mitigations[].riskReduction', 'control', control.id, 'no risk reduction was set');
      }
      reEmitBag(outMit, model.bag(control, 'otm'));
      doc.mitigations.push(outMit);
    }

    // --- what OTM cannot carry, reported rather than silently dropped (§5.3, REQ-EXP-003)
    report.dropped = report.dropped.concat(
      droppedList(m, [
        'trustBoundaries',
        'dataSets',
        'assumptions',
        'threatPersonas',
        'risks',
        'mitigationPlans',
        'diagrams',
      ]),
    );
    if (!foldActors) report.dropped = report.dropped.concat(droppedList(m, ['actors']));
    if (!foldStores) report.dropped = report.dropped.concat(droppedList(m, ['dataStores']));
    report.dropped = report.dropped.concat(perEntityDrops(m));
    // OTM's nested threat instance is `{threat, state, mitigations}` — there is nowhere to write the
    // join entity's own id. It is the one canonical field with no OTM home at all, and it is the
    // reason `canonical → OTM → canonical` mints new ids (§5.3, §10).
    if (m.threatApplications.length) {
      report.dropped.push({
        kind: 'threatApplications[].id',
        count: m.threatApplications.length,
        reason: 'OTM nests threat instances and gives them no id, so a re-import mints new ones',
      });
    }

    /**
     * Report every reference this export drops because it names nothing (§8, REQ-EXP-003).
     *
     * OTM **blocks** only the references it copies into the document verbatim — a flow's endpoints,
     * whose absent target becomes a name the recipient's tool cannot resolve. Every other dangling
     * reference is *dropped*: the entity or the link is left out, so there is no broken document to
     * hand anyone, and refusing the whole export would withhold a usable file over a mistake the
     * model already reports on its own. Dropping is only acceptable when it is disclosed, and this is
     * where it is disclosed: one entry per reference, naming the field that held it and the id it
     * named, so the export dialogue can say what will not survive rather than showing nothing.
     *
     * One sweep rather than a report at each of the writers, because the writers are spread over four
     * loops and two of them run once per target entity — a report at the point of the drop would fire
     * once per caller for a fault that occurs once. The cost of the sweep is that it restates what the
     * writers do, so `interop.referential-integrity` dangles every reference field the model declares
     * and fails on any that is neither blocked nor named here: the sweep cannot drift from the writers
     * without that test failing.
     */
    function reportDroppedRefs() {
      function drop(from, kind, to) {
        report.droppedRefs.push({ from: from, kind: kind, to: to });
      }

      // Whether an id names something the document can carry. A folded actor or data store keeps its
      // id as the component it became, so a reference to one is *not* dangling — it resolves to a
      // component in the output even though the canonical model has no component by that id.
      function carriedAsComponent(id) {
        if (!core.isString(id) || id === '') return true;
        if (model.get(m, 'component', id)) return true;
        if (foldActors && model.get(m, 'actor', id)) return true;
        if (foldStores && model.get(m, 'dataStore', id)) return true;
        return false;
      }

      for (var a = 0; a < m.threatApplications.length; a++) {
        var app = m.threatApplications[a];
        if (!model.get(m, 'threat', app.threatId)) {
          drop('threatApplication ' + app.id + '.threatId', 'threat', app.threatId);
        }
        // The target decides where the instance is nested, so an application whose target is not in
        // the document has nowhere to go.
        var reachable = app.targetType === 'dataFlow'
          ? !!model.get(m, 'dataFlow', app.targetId)
          : carriedAsComponent(app.targetId);
        if (!reachable) drop('threatApplication ' + app.id + '.targetId', app.targetType || 'component', app.targetId);
        var states = core.isArray(app.controlStates) ? app.controlStates : [];
        for (var s = 0; s < states.length; s++) {
          if (core.isObject(states[s]) && !model.get(m, 'control', states[s].controlId)) {
            drop('threatApplication ' + app.id + '.controlStates[].controlId', 'control', states[s].controlId);
          }
        }
      }

      for (var f = 0; f < m.dataFlows.length; f++) {
        var ids = core.isArray(m.dataFlows[f].assetIds) ? m.dataFlows[f].assetIds : [];
        for (var i = 0; i < ids.length; i++) {
          if (!model.get(m, 'asset', ids[i])) drop('dataFlow ' + m.dataFlows[f].id + '.assetIds[]', 'asset', ids[i]);
        }
      }

      // The asset relation is inverted on the way out: the asset names the components that process or
      // store it, and OTM nests the pair on the component. An entry naming no component is never
      // matched by the inverse and simply disappears.
      for (var ai = 0; ai < m.assets.length; ai++) {
        var asset = m.assets[ai];
        var keys = ['processedByIds', 'storedByIds'];
        for (var k = 0; k < keys.length; k++) {
          var list = core.isArray(asset[keys[k]]) ? asset[keys[k]] : [];
          for (var li = 0; li < list.length; li++) {
            if (!model.get(m, 'component', list[li])) {
              drop('asset ' + asset.id + '.' + keys[k] + '[]', 'component', list[li]);
            }
          }
        }
      }

      // A representation element is nested inside the component it belongs to, so an element whose
      // owner is gone has no owner to be nested under and is never emitted. (A dangling
      // `representationId` is reported where the element is written — `exportElements`.)
      for (var ei = 0; ei < m.representationElements.length; ei++) {
        var element = m.representationElements[ei];
        if (!model.get(m, 'component', element.ownerId)) {
          drop('representationElement ' + element.id + '.ownerId', 'component', element.ownerId);
        }
      }
    }
    reportDroppedRefs();

    return { document: doc, report: report, blocked: blocked, ok: blocked.length === 0 };
  }

  /** Re-nest flat applications into the OTM instance lists (§5.2). */
  function exportThreatInstances(m, targetType, targetId) {
    var out = [];
    for (var i = 0; i < m.threatApplications.length; i++) {
      var app = m.threatApplications[i];
      if (app.targetType !== targetType || app.targetId !== targetId) continue;
      if (!model.get(m, 'threat', app.threatId)) continue; // a dangling threat reference is reported elsewhere
      var instance = { threat: app.threatId, state: core.isString(app.state) ? app.state : '' };
      var mitigations = [];
      var states = core.isArray(app.controlStates) ? app.controlStates : [];
      for (var s = 0; s < states.length; s++) {
        if (!core.isObject(states[s]) || !core.isString(states[s].controlId)) continue;
        if (!model.get(m, 'control', states[s].controlId)) continue;
        mitigations.push({
          mitigation: states[s].controlId,
          state: core.isString(states[s].state) ? states[s].state : '',
        });
      }
      if (mitigations.length) instance.mitigations = mitigations;
      out.push(instance);
    }
    return out;
  }

  /** Invert the asset relation back onto the component, where OTM keeps it. */
  function exportAssetInstances(m, componentId) {
    var processed = [];
    var stored = [];
    for (var i = 0; i < m.assets.length; i++) {
      var asset = m.assets[i];
      if (core.isArray(asset.processedByIds) && asset.processedByIds.indexOf(componentId) !== -1) processed.push(asset.id);
      if (core.isArray(asset.storedByIds) && asset.storedByIds.indexOf(componentId) !== -1) stored.push(asset.id);
    }
    if (!processed.length && !stored.length) return null;
    var out = {};
    if (processed.length) out.processed = processed;
    if (stored.length) out.stored = stored;
    return out;
  }

  /** Re-nest representation elements under the owner OTM expects to find them in. */
  function exportElements(m, ownerId, report) {
    var out = [];
    for (var i = 0; i < m.representationElements.length; i++) {
      var el = m.representationElements[i];
      if (el.ownerId !== ownerId) continue;
      if (!model.get(m, 'representation', el.representationId)) {
        report.droppedRefs.push({ from: 'representationElement ' + el.id, kind: 'representation', to: el.representationId });
        continue;
      }
      var item = {
        representation: el.representationId,
        id: el.id,
      };
      if (core.present(el.name)) item.name = el.name;
      if (core.isObject(el.position)) item.position = core.deepCopy(el.position);
      if (core.isObject(el.size)) item.size = core.deepCopy(el.size);
      if (core.present(el.file)) item.file = el.file;
      if (core.isNumber(el.line)) item.line = el.line;
      if (core.present(el.codeSnippet)) item.codeSnippet = el.codeSnippet;
      var bag = model.bag(el, 'otm') || Object.create(null);
      reEmitBag(item, bag);
      if (core.isObject(bag.attributes)) item.attributes = core.deepCopy(bag.attributes);
      out.push(item);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------

  /** Re-emit the keys of a passthrough bag onto an outgoing object (REQ-EXP-004). */
  function reEmitBag(target, bag, skip) {
    if (!core.isObject(bag)) return target;
    var ks = Object.keys(bag);
    for (var i = 0; i < ks.length; i++) {
      var key = ks[i];
      if (key === 'attributes' || (skip && skip[key])) continue;
      target[key] = core.deepCopy(bag[key]);
    }
    if (core.isObject(bag.attributes)) target.attributes = core.deepCopy(bag.attributes);
    return target;
  }

  function emptyReport(format) {
    return {
      format: format,
      dropped: [],
      folded: [],
      synthesized: [],
      droppedRefs: [],
      generatedIds: [],
      provenance: null,
      unresolved: [],
    };
  }

  /** Record a synthesized value. An undisclosed synthesis is indistinguishable from data loss (§8). */
  function disclose(report, field, entity, id, why) {
    report.synthesized.push({ field: field, entity: entity, id: id, why: why });
  }

  /**
   * Why each collection in §5.3's drop list has no OTM home.
   *
   * Per concept rather than one sentence for all of them, because REQ-EXP-003's disclosure is only
   * worth showing if a reader learns what specifically will not survive. "OTM has no equivalent for
   * this concept" is true of all seven and tells the reader nothing about any of them — and it reads
   * as boilerplate, which is how a disclosure list stops being read.
   */
  var DROP_REASONS = {
    trustBoundaries: 'OTM has no trust boundary; zone membership is the only thing it can carry',
    dataSets: 'OTM has no data sets, and no place to record what data an element holds',
    assumptions: 'OTM has no place to record an assumption, or the risk of one being wrong',
    threatPersonas: 'OTM has no threat personas; per-threat risk inputs stand in for them',
    // §5.3: "risks (matrix, score, level)". The inputs survive as the threat's own likelihood and
    // impact; it is the computed score and its band, and any risk not attached to a threat, that go.
    risks: 'OTM has no risk matrix: the score and the level band are not written, and a risk that is not attached to a threat has nowhere to go',
    mitigationPlans: 'OTM has no mitigation plans; a plan is neither a control nor a threat',
    diagrams: 'OTM diagrams are coordinate canvases, so a diagram that is only source text is dropped',
  };

  function droppedList(m, keys) {
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var list = m[keys[i]];
      if (!core.isArray(list) || !list.length) continue;
      out.push({
        kind: keys[i],
        count: list.length,
        reason: DROP_REASONS[keys[i]] || 'OTM has no equivalent for this concept',
      });
    }
    return out;
  }

  /** Fields dropped per entity rather than wholesale, counted so the dialog can be specific (§5.3). */
  function perEntityDrops(m) {
    var out = [];
    function count(kind, predicate, reason) {
      var n = 0;
      for (var i = 0; i < m[kind].length; i++) if (predicate(m[kind][i])) n += 1;
      if (n) out.push({ kind: kind, count: n, reason: reason });
    }
    count('components', function (c) { return core.present(c.repoLink); }, 'components[].repoLink has no OTM field');
    count('dataFlows', function (f) {
      return core.isBoolean(f.hasSensitiveData) || core.isBoolean(f.encrypted) || core.present(f.sourceType) || core.present(f.destinationType);
    }, 'flow type, sensitivity and encryption have no OTM field');
    count('threats', function (t) {
      return core.present(t.personaId) || core.present(t.event) || (core.isArray(t.weaknesses) && t.weaknesses.length) ||
        (core.isArray(t.attackMechanisms) && t.attackMechanisms.length) || (core.isArray(t.sources) && t.sources.length);
    }, 'persona, event, weaknesses, attack mechanisms and sources have no OTM field');
    count('controls', function (c) {
      return core.present(c.status) || core.present(c.priority) || core.isObject(c.trustBoundary) || (core.isArray(c.threatIds) && c.threatIds.length);
    }, 'control status, priority, trust boundary and threat links have no OTM field');
    count('metadata', function () { return false; }, 'unused');
    var metaDrops = ['frozen', 'releasedAt', 'reviewedAt', 'productReleaseDate', 'repoLink', 'releaseDocsLink', 'version'];
    var n = 0;
    for (var i = 0; i < metaDrops.length; i++) if (core.present(m.metadata[metaDrops[i]])) n += 1;
    if (n) out.push({ kind: 'metadata', count: n, reason: 'lifecycle metadata has no OTM field' });
    return out.filter(function (entry) {
      return entry.count > 0;
    });
  }

  /**
   * Drop references that name nothing, and report them.
   *
   * Neither format enforces referential integrity, so a document can arrive with a `dataflows[].source`
   * naming an absent component and validate perfectly against its own schema. Importing it faithfully
   * would put a broken model in the editor; dropping the reference loses only a fact that was never
   * there. The second is the honest choice, and it is reported (REQ-IMP-004).
   *
   * Which references dangle is decided by `model.validate`, not by a second resolution rule written
   * here. A typed reference — a flow endpoint whose `sourceType` contradicts its `sourceId` — is only
   * correct if both places agree, and having two implementations of that judgement is how they come
   * to disagree.
   */
  function dropUnresolvedReferences(m, report, severity) {
    var dropped = [];
    // Removing a link entry can empty a container that other references pointed into, so this runs
    // to a fixed point. Two passes suffice in practice; the cap stops a malformed document from
    // spinning.
    for (var pass = 0; pass < 4; pass++) {
      var unresolved = model.validate(m, { referential: 'warning' }).unresolved;
      if (!unresolved.length) break;
      for (var i = 0; i < unresolved.length; i++) {
        var entry = unresolved[i];
        if (dropAtPath(m, entry.path)) {
          dropped.push({ type: entry.type, field: entry.field, target: entry.id, path: entry.path });
        }
      }
      pruneInertLinks(m);
    }
    // References recorded before this ran — the component-side asset links, which have no canonical
    // home to be validated at — join the same list rather than replacing it.
    dropped = (report.unresolved || []).concat(dropped);
    if (severity === 'throw' && dropped.length) {
      throw TmvError('OTM_DANGLING', 'The document has ' + dropped.length + ' reference(s) that name nothing.', {
        unresolved: dropped,
      });
    }
    report.unresolved = dropped;
    return dropped;
  }

  /** Delete the value a validate path names. `…/refList/2` indexes into a list; anything else is a key. */
  function dropAtPath(m, path) {
    var parts = path.split('/').slice(1);
    var parent = m;
    for (var i = 0; i < parts.length - 1; i++) {
      if (parent === null || parent === undefined) return false;
      parent = parent[parts[i]];
    }
    if (!core.isObject(parent)) return false;
    var last = parts[parts.length - 1];
    if (core.isArray(parent) && /^\d+$/.test(last)) {
      var at = Number(last);
      if (at >= parent.length) return false;
      parent.splice(at, 1);
      return true;
    }
    if (!Object.prototype.hasOwnProperty.call(parent, last)) return false;
    delete parent[last];
    return true;
  }

  /**
   * Remove link entries left with nothing to say.
   *
   * A `controlStates` entry is `{controlId, state}`; dropping a dangling `controlId` would leave
   * `{state: "implemented"}` behind — a row in the threat view naming nothing. A `threatApplication`
   * is the same problem one level up: `{targetType, targetId, state}` with no threat is a row about
   * nothing at all, and it is the model's own rule that such an entity is removed rather than emptied
   * (`03-data-model.md` §4.11, and `model.cascadeDeletes` on the edit path).
   */
  function pruneInertLinks(m) {
    for (var t = 0; t < model.TYPES.length; t++) {
      var type = model.TYPES[t];
      var list = m[type.key];
      if (!core.isArray(list)) continue;

      // A `link` entity exists only to join things, and `dependsOn` is the model's own statement of
      // what it depends on to be anything at all (`03-data-model.md` §4.11). Every one of those
      // references must still name something; a `threatApplication` that has lost its threat is not
      // "a threat application with a missing threat", it is nothing (`model.cascadeDeletes` removes
      // it on the edit path for the same reason). Running after the drop pass, "still names
      // something" is exactly "the key is still there".
      if (type.dependsOn) {
        var survivors = [];
        for (var e = 0; e < list.length; e++) {
          var row = list[e];
          if (!core.isObject(row)) continue;
          var whole = true;
          for (var d = 0; d < type.dependsOn.length; d++) if (!core.present(row[type.dependsOn[d]])) whole = false;
          if (whole) survivors.push(row);
        }
        if (survivors.length !== list.length) {
          m[type.key] = survivors;
          list = survivors;
        }
      }

      for (var f = 0; f < type.fields.length; f++) {
        var spec = type.fields[f];
        if ((spec.kind !== 'object' && spec.kind !== 'objectList') || !spec.itemFields) continue;
        var innerRefs = refKeys(spec.itemFields);
        if (!innerRefs.length) continue;
        for (var j = 0; j < list.length; j++) {
          var entity = list[j];
          if (!core.isObject(entity) || !core.isArray(entity[spec.key])) continue;
          var kept = [];
          for (var i = 0; i < entity[spec.key].length; i++) {
            var item = entity[spec.key][i];
            if (core.isObject(item) && linkHasTarget(item, innerRefs)) kept.push(item);
          }
          if (kept.length) entity[spec.key] = kept;
          else delete entity[spec.key];
        }
      }
    }
  }

  function refKeys(fields) {
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].kind === 'ref' || fields[i].kind === 'refList') out.push(fields[i].key);
    }
    return out;
  }

  function linkHasTarget(item, refFields) {
    for (var i = 0; i < refFields.length; i++) {
      var value = item[refFields[i]];
      if (core.isString(value) && value !== '') return true;
      if (core.isArray(value) && value.length > 0) return true;
    }
    return false;
  }

  function readProvenance(attributes) {
    var out = Object.create(null);
    var found = false;
    var ks = Object.keys(attributes);
    for (var i = 0; i < ks.length; i++) {
      if (ks[i].indexOf(PROVENANCE_PREFIX) !== 0) continue;
      out[ks[i].slice(PROVENANCE_PREFIX.length)] = attributes[ks[i]];
      found = true;
    }
    return found ? out : null;
  }

  function stripProvenance(attributes) {
    var out = Object.create(null);
    var ks = Object.keys(attributes);
    for (var i = 0; i < ks.length; i++) {
      if (ks[i].indexOf(PROVENANCE_PREFIX) === 0) continue;
      out[ks[i]] = core.deepCopy(attributes[ks[i]]);
    }
    return Object.keys(out).length ? out : null;
  }

  function asArray(value) {
    return core.isArray(value) ? value : [];
  }

  /**
   * Strip keys whose value is `undefined` before they reach `model.insert`.
   *
   * `insert` stores every key it is handed, so `{type: undefined}` becomes an own property with an
   * undefined value — which is *not* the same entity as one that omits `type`. Entity shape feeds
   * `canonicalSerialize`, and therefore every commit id in the history; an imported model that
   * disagreed with the same model after a save/load round trip would break the content-addressed
   * store in a way that only shows up as a spurious divergence later.
   */
  function defined(source) {
    var out = Object.create(null);
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      if (source[keys[i]] !== undefined) out[keys[i]] = source[keys[i]];
    }
    return out;
  }

  function text(value) {
    return core.isString(value) ? value : '';
  }

  function numberOr(value, fallback) {
    return core.isNumber(value) ? value : fallback;
  }

  function putNumber(target, key, value) {
    if (core.isNumber(value)) target[key] = value;
  }

  function cleanStrings(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (core.isString(list[i])) out.push(list[i]);
    return out;
  }

  TMV.otm = {
    VERSION: OTM_VERSION,
    PROVENANCE_PREFIX: PROVENANCE_PREFIX,
    MAPPED: MAPPED,
    FOLDED: FOLDED,
    DROPPED: DROPPED,
    UNREACHABLE: UNREACHABLE,
    FIELDS: OTM_FIELDS,

    toCanonical: toCanonical,
    fromCanonical: fromCanonical,
    isUuid: isUuid,
  };
})(globalThis.TMV = globalThis.TMV || {});
