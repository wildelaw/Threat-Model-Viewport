/*
 * 18-views-threats.js — the Threats tab.
 *
 * Sections (`07-ui.md` §3): All Threats · By Target · By Persona · Personas · Assumptions ·
 * Unresolved References.
 *
 * The structural fact this tab is built around: **the two formats relate threats to the model in two
 * different ways, and both are present at once.** TML puts a threat at the root and lists the threats
 * in the model; OTM applies a threat to a target through a join entity, `threatApplication`, which
 * also carries the state of that application and the state of every control against it. A threat that
 * exists and is applied nowhere is therefore a completely normal, legal, and *important* thing — it is
 * the TML-side threat, and *All Threats* must show it rather than hiding it behind the join.
 *
 * That is why All Threats is a list of threats with a count of applications, and By Target is a list
 * of applications with the threat attached. Listing applications alone would make a TML-only model
 * look empty; listing threats alone would lose the state, which is where the answer to "is this
 * actually handled" lives.
 *
 * The other decision: **Unresolved References sweeps the whole model, not this tab.** `07-ui.md` §3
 * puts it here because this is where a user looks when something is wrong, and `07-ui.md` §3's Flows
 * tab repeats the same check for flow endpoints specifically — because a flow that ends nowhere is a
 * broken relationship rather than a missing name. This section is the complete list; the Flows one is
 * the pointed version.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  // ---------------------------------------------------------------------------------------------
  // 1. All threats
  // ---------------------------------------------------------------------------------------------

  var ALL_NOTE =
    'Every threat the model records, whether or not it is applied to anything. A threat with no ' +
    'applications is not an error: TML keeps threats at the root, and a model may record one before ' +
    'deciding where it lands.';

  function threatRows(ctx) {
    var list = M.collection(ctx.model, 'threat');
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var threat = list[i];
      var applications = M.applicationsForThreat(ctx.model, threat.id);
      var controls = M.controlsForThreat(ctx.model, threat.id);
      var states = controlStatesOf(applications);
      rows.push({
        entity: threat,
        applications: applications,
        controls: controls,
        controlStates: states,
        persona: V.labelFrom(ctx.model, threat.personaId),
        sources: core.isArray(threat.sources) ? threat.sources : [],
        __search: [
          threat.name,
          threat.event,
          (threat.categories || []).join(' '),
          (threat.cwes || []).join(' '),
          V.labelFrom(ctx.model, threat.personaId),
          threat.id,
        ].join(' '),
      });
    }
    return rows;
  }

  /** Every control state recorded across a threat's applications, in application order. */
  function controlStatesOf(applications) {
    var out = [];
    for (var i = 0; i < applications.length; i++) {
      var states = applications[i].controlStates;
      if (!core.isArray(states)) continue;
      for (var s = 0; s < states.length; s++) out.push(states[s]);
    }
    return out;
  }

  function allThreatsSection(ctx) {
    var rows = threatRows(ctx);

    return V.listSection(ctx, 'All Threats', ALL_NOTE, {
      key: 'threats.all',
      type: 'threat',
      entityRows: rows,
      plural: 'threats',
      singular: 'threat',
      addLabel: 'Add threat',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'persona',
          label: 'Persona',
          options: V.distinctOptions(rows, function (row) { return row.persona; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.persona; }); },
        },
        {
          id: 'source',
          label: 'Source',
          // From the model's own values rather than `VOCAB.threatSource`: a source outside the
          // canonical list would be invisible to a fixed filter, and a filter that hides a row is
          // indistinguishable from data that is not there.
          options: V.listOptions(rows, function (row) { return row.sources; }),
          test: function (row, value) { return V.matchList(row, value, function (r) { return r.sources; }); },
        },
        {
          id: 'applied',
          label: 'Applied',
          options: [
            { value: 'yes', label: 'Applied to at least one target' },
            { value: 'no', label: 'Applied to nothing' },
          ],
          test: function (row, value) { return value === 'yes' ? row.applications.length > 0 : row.applications.length === 0; },
        },
        {
          id: 'controls',
          label: 'Controls',
          options: [
            { value: 'yes', label: 'Has at least one control' },
            { value: 'no', label: 'Has no controls' },
          ],
          test: function (row, value) { return value === 'yes' ? row.controls.length > 0 : row.controls.length === 0; },
        },
      ],
      columns: [
        { key: 'name', label: 'Threat', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'threat') });
        } },
        { key: 'persona', label: 'Persona', sortable: true, render: function (row) {
          return row.persona || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'sources', label: 'Sources', render: function (row) {
          return row.sources.length ? V.tagList(row.sources, 'gray') : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'likelihood', label: 'Likelihood', numeric: true, sortable: true, render: scoreCell('likelihood') },
        { key: 'impact', label: 'Impact', numeric: true, sortable: true, render: scoreCell('impact') },
        { key: 'applied', label: 'Applied to', numeric: true, sortable: true, render: function (row) {
          if (!row.applications.length) return core.el('span', { class: 'tmv-cell-note', text: 'Nothing' });
          return core.el('span', { text: core.plural(row.applications.length, 'target', 'targets') });
        } },
        { key: 'controls', label: 'Controls', numeric: true, sortable: true, render: function (row) {
          if (!row.controls.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: String(row.controls.length) });
        } },
      ],
      empty: {
        title: 'No threats',
        body:
          'This model records no threats at all. Threats carry the likelihood and impact numbers that ' +
          'the Risk tab’s registers are built from, so a model without them has nothing to assess — ' +
          'which is a statement about the model, not a defect in the application.',
      },
      filteredEmpty: {
        title: 'No threats match these filters',
        body: 'This model has threats; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'threat', entity: row.entity, related: attacksBlock(row.entity) });
      },
    });
  }

  /**
   * A likelihood or impact score.
   *
   * Not rated rather than zero, for the same reason the Data tab's CIA ratings say "Not rated": a
   * threat nobody has scored and a threat scored as harmless are different facts, and both formats
   * leave these optional.
   */
  function scoreCell(key) {
    return function (row) {
      var value = row.entity[key];
      if (!core.isNumber(value)) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
      return core.el('span', { text: String(value) });
    };
  }

  /**
   * Weaknesses and attack mechanisms, as a read-only block in the detail.
   *
   * These are lists of nested objects rather than references, so they are shown here as plain lists
   * instead of through `relatedGroup`, which answers "what points at this".
   */
  function attacksBlock(threat) {
    var blocks = [];
    var weaknesses = core.isArray(threat.weaknesses) ? threat.weaknesses : [];
    var mechanisms = core.isArray(threat.attackMechanisms) ? threat.attackMechanisms : [];
    if (weaknesses.length) {
      blocks.push(core.el('div', { class: 'tmv-related__group' }, [
        core.el('p', { class: 'tmv-related__label', text: core.plural(weaknesses.length, 'weakness', 'weaknesses') }),
        core.el('ul', { class: 'tmv-dialog__list' }, weaknesses.map(function (w) {
          return core.el('li', { text: (w.cweId ? 'CWE-' + w.cweId + ': ' : '') + (w.cweTitle || 'Untitled') });
        })),
      ]));
    }
    if (mechanisms.length) {
      blocks.push(core.el('div', { class: 'tmv-related__group' }, [
        core.el('p', { class: 'tmv-related__label', text: core.plural(mechanisms.length, 'attack mechanism', 'attack mechanisms') }),
        core.el('ul', { class: 'tmv-dialog__list' }, mechanisms.map(function (m) {
          return core.el('li', { text: (m.capecId ? 'CAPEC-' + m.capecId + ': ' : '') + (m.capecTitle || 'Untitled') });
        })),
      ]));
    }
    if (!blocks.length) return null;
    return V.relatedBlock('How it is described', core.el('div', { class: 'tmv-related' }, blocks));
  }

  // ---------------------------------------------------------------------------------------------
  // 2. By target
  // ---------------------------------------------------------------------------------------------

  var BY_TARGET_NOTE =
    'One row per threat applied to one thing. This is OTM’s shape: the application is the join ' +
    'entity, and it is where the state of the threat against that target lives — so a threat applied ' +
    'to two components has two states, and this is the only screen where both are visible.';

  function applicationRows(ctx) {
    var list = M.collection(ctx.model, 'threatApplication');
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var app = list[i];
      var threat = M.get(ctx.model, 'threat', app.threatId);
      var target = resolveTarget(ctx, app);
      var states = core.isArray(app.controlStates) ? app.controlStates : [];
      rows.push({
        // The threat is the entity the detail opens, because it is the entity with fields to show;
        // the row is the application, so the key is the application's own id.
        entity: threat,
        __key: 'application:' + app.id,
        application: app,
        target: target,
        states: states,
        __search: [
          threat ? M.labelOf(threat) : String(app.threatId),
          target.label,
          app.targetType,
          app.state,
          app.id,
        ].join(' '),
      });
    }
    return rows;
  }

  /**
   * A threat application's target, resolved.
   *
   * `targetType` names a vocabulary value — `component` or `dataFlow` — not a collection, so it goes
   * through `M.typeFor` rather than being used as a key directly. `found` records *how* it resolved,
   * because the three outcomes are three different facts about the model:
   *
   * - `declared` — the application said what kind of thing this is and the model agrees.
   * - `search`   — it resolved somewhere else. Either the application does not say what the target is
   *                (OTM allows that) or it says one thing and the model holds another, and those need
   *                saying apart because only the second is a contradiction.
   * - `missing`  — nothing in the model has this id.
   */
  function resolveTarget(ctx, app) {
    var out = { typeKey: null, entity: null, label: '', declared: app.targetType || null, found: 'missing' };
    var declaredType = M.typeFor(app.targetType);
    if (declaredType) {
      out.typeKey = declaredType.key;
      var found = M.get(ctx.model, declaredType.key, app.targetId);
      if (found) {
        out.entity = found;
        out.label = M.labelOf(found);
        out.found = 'declared';
        return out;
      }
    }
    var anywhere = M.findAnywhere(ctx.model, app.targetId);
    if (anywhere) {
      out.typeKey = anywhere.type;
      out.entity = anywhere.entity;
      out.label = M.labelOf(anywhere.entity);
      out.found = 'search';
      return out;
    }
    out.label = String(app.targetId);
    return out;
  }

  function targetCell(ctx, row) {
    if (!row.target.entity) {
      return core.el('span', { class: 'tmv-unresolved' }, [
        core.el('span', { class: 'tmv-unresolved__mark', 'aria-hidden': 'true', text: '!' }),
        core.el('span', { class: 'tmv-unresolved__id', text: row.target.label }),
      ]);
    }
    var typeSpec = M.typeFor(row.target.typeKey);
    var children = [
      core.el('span', { text: row.target.label }),
      core.el('span', { class: 'tmv-muted', text: ' (' + (typeSpec ? typeSpec.label : 'entity') + ')' }),
    ];
    if (row.target.found === 'search') {
      children.push(core.el('span', {
        class: 'tmv-cell-note',
        text: row.target.declared ? ' — a different kind of thing' : ' — kind not stated',
        title: row.target.declared
          ? 'This application says its target is a ' + row.target.declared + ', and the model holds it as a ' + row.target.typeKey + '.'
          : 'This application does not say what kind of thing its target is, so the id was looked up across the model.',
      }));
    }
    return core.el('span', {}, children);
  }

  function byTargetSection(ctx) {
    var rows = applicationRows(ctx);

    if (!rows.length) {
      var threats = M.collection(ctx.model, 'threat');
      return V.section(ctx, 'By Target', BY_TARGET_NOTE, V.emptySection({
        title: threats.length ? 'No threats are applied to anything' : 'Nothing applied',
        body: threats.length
          ? core.plural(threats.length, 'threat is', 'threats are') + ' recorded in this model and none ' +
            'is applied to a target. Application is OTM’s join entity; a TML model keeps its threats ' +
            'at the root and may legitimately have none, in which case this screen stays empty while ' +
            'All Threats is full.'
          : 'This model records no threats, so nothing is applied to anything.',
      }));
    }

    return V.listSection(ctx, 'By Target', BY_TARGET_NOTE, {
      key: 'threats.by-target',
      type: 'threatApplication',
      entityRows: rows,
      plural: 'applications',
      singular: 'application',
      addLabel: 'Apply a threat',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'targetType',
          label: 'Target type',
          options: [
            { value: 'component', label: 'Component' },
            { value: 'dataFlow', label: 'Data flow' },
            { value: '@none', label: 'Not stated, or unresolved' },
          ],
          test: function (row, value) {
            if (value === '@none') return !row.target.entity;
            return row.target.typeKey === M.typeFor(value).key;
          },
        },
        {
          id: 'state',
          label: 'State',
          options: V.distinctOptions(rows, function (row) { return row.application.state; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.application.state; }); },
        },
        {
          id: 'controls',
          label: 'Controls',
          options: [
            { value: 'yes', label: 'Has control states recorded' },
            { value: 'no', label: 'Has none' },
          ],
          test: function (row, value) { return value === 'yes' ? row.states.length > 0 : row.states.length === 0; },
        },
      ],
      columns: [
        { key: 'threat', label: 'Threat', sortable: true, render: function (row) {
          if (!row.entity) return core.el('span', { class: 'tmv-unresolved__id', text: String(row.application.threatId) });
          return V.nameCell(row);
        } },
        { key: 'target', label: 'Target', sortable: true, render: function (row) { return targetCell(ctx, row); } },
        { key: 'state', label: 'State', sortable: true, render: function (row) {
          var chip = V.stateTag(row.application.state);
          return chip || core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'controls', label: 'Controls', render: function (row) {
          return controlSummary(ctx, row.states);
        } },
      ],
      empty: { title: 'Nothing applied' },
      filteredEmpty: {
        title: 'No applications match these filters',
        body: 'This model has applications; none of them match what is selected.',
      },
      detail: function (c, row) {
        if (!row.entity) {
          return core.el('div', { class: 'tmv-detail' }, [
            core.el('p', {
              text:
                'This application names a threat, ' + String(row.application.threatId) + ', that is not in ' +
                'this model. There is nothing to show for it until the reference is repaired.',
            }),
          ]);
        }
        var blocks = [applicationBlock(c, row)];
        var related = core.el('div', {}, blocks.filter(function (node) { return node !== null; }));
        return V.detailView(c, { type: 'threat', entity: row.entity, related: related });
      },
    });
  }

  /**
   * The control states an application records, as chips.
   *
   * Each chip names its control as well as its state, because the state is only meaningful against
   * the control it is the state of. `V.stateTag` keeps the colour and takes the label, so the colour
   * map is not duplicated here.
   */
  function controlSummary(ctx, states) {
    if (!states.length) return core.el('span', { class: 'tmv-muted', text: 'None' });
    var wrap = core.el('span', { class: 'tmv-tags' });
    var shown = 0;
    for (var i = 0; i < states.length && shown < 4; i++) {
      var control = M.get(ctx.model, 'control', states[i].controlId);
      var name = control ? M.labelOf(control) : String(states[i].controlId);
      var chip = V.stateTag(states[i].state, name + ': ' + V.humanise(states[i].state || 'not stated'));
      if (!chip) continue;
      wrap.appendChild(chip);
      shown++;
    }
    if (states.length > shown) {
      wrap.appendChild(core.el('span', { class: 'tmv-muted', text: ' +' + (states.length - shown) + ' more' }));
    }
    return wrap;
  }

  /** The application's own fields, which are its state and its control states. */
  function applicationBlock(ctx, row) {
    var items = [];
    var stateTag = V.stateTag(row.application.state);
    items.push(core.el('p', { class: 'tmv-nested__row' }, [
      core.el('span', { class: 'tmv-nested__key', text: 'State: ' }),
      stateTag || core.el('span', { class: 'tmv-muted', text: 'Not stated' }),
    ]));
    if (row.states.length) {
      items.push(core.el('p', { class: 'tmv-nested__row' }, [
        core.el('span', { class: 'tmv-nested__key', text: 'Control states: ' }),
        core.el('span', { text: core.plural(row.states.length, 'control', 'controls') }),
      ]));
      items.push(core.el('ul', { class: 'tmv-dialog__list' }, row.states.map(function (state) {
        var control = M.get(ctx.model, 'control', state.controlId);
        var chip = V.stateTag(state.state);
        return core.el('li', {}, [
          core.el('span', { text: control ? M.labelOf(control) : String(state.controlId) }),
          core.el('span', { class: 'tmv-muted', text: ' — ' }),
          chip || core.el('span', { text: 'not stated' }),
        ]);
      })));
    }
    return V.relatedBlock('This application', core.el('div', {}, items));
  }

  // ---------------------------------------------------------------------------------------------
  // 3. By persona
  // ---------------------------------------------------------------------------------------------

  var BY_PERSONA_NOTE =
    'One row per threat persona, with what that persona brings to this model. The Personas section ' +
    'below is the same records as data; this is the same records as an answer to "who is coming".';

  function byPersonaSection(ctx) {
    var personas = M.collection(ctx.model, 'threatPersona');
    var threats = M.collection(ctx.model, 'threat');
    var rows = [];

    for (var i = 0; i < personas.length; i++) {
      var persona = personas[i];
      var theirs = threats.filter(function (threat) { return threat.personaId === persona.id; });
      var applied = 0;
      var likelihood = null;
      var impact = null;
      for (var t = 0; t < theirs.length; t++) {
        applied += M.applicationsForThreat(ctx.model, theirs[t].id).length;
        if (core.isNumber(theirs[t].likelihood) && (likelihood === null || theirs[t].likelihood > likelihood)) {
          likelihood = theirs[t].likelihood;
        }
        if (core.isNumber(theirs[t].impact) && (impact === null || theirs[t].impact > impact)) {
          impact = theirs[t].impact;
        }
      }
      rows.push({
        entity: persona,
        __key: 'by-persona:' + persona.id,
        threats: theirs,
        applied: applied,
        likelihood: likelihood,
        impact: impact,
        __search: [persona.name, persona.skillLevel, persona.accessLevel, persona.id].join(' '),
      });
    }

    var unassigned = threats.filter(function (threat) {
      var persona = core.isString(threat.personaId) ? M.get(ctx.model, 'threatPersona', threat.personaId) : null;
      return !persona;
    });

    if (!rows.length) {
      return V.section(ctx, 'By Persona', BY_PERSONA_NOTE, V.emptySection({
        title: 'No threat personas',
        body: threats.length
          ? core.plural(threats.length, 'threat is', 'threats are') + ' recorded with no persona, or with ' +
            'one this model does not hold. Personas are TML-only, so an OTM model is expected to be empty ' +
            'here — its threats are grouped by target instead.'
          : 'This model records no threats, so there is no persona to group them by.',
      }));
    }

    var summary = unassigned.length
      ? core.el('div', { class: 'cds--inline-notification cds--inline-notification--info', role: 'status' }, [
          core.el('div', { class: 'cds--inline-notification__details' }, [
            core.el('h3', { class: 'cds--inline-notification__title', text: core.plural(unassigned.length, 'threat has', 'threats have') + ' no persona' }),
            core.el('div', { class: 'cds--inline-notification__subtitle' }, [
              core.el('p', {
                text:
                  'They are listed in All Threats, and they are counted in the risk sections, but they ' +
                  'belong to no group on this screen. That is usually a TML model that has not filled ' +
                  'the field in yet.',
              }),
            ]),
          ]),
        ])
      : null;

    return V.listSection(ctx, 'By Persona', BY_PERSONA_NOTE, {
      key: 'threats.by-persona',
      type: 'threatPersona',
      entityRows: rows,
      plural: 'personas',
      singular: 'persona',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      summary: summary,
      filters: [
        {
          id: 'intent',
          label: 'Intent',
          options: [
            { value: 'malicious', label: 'Malicious intent' },
            { value: 'benign', label: 'Not marked malicious' },
          ],
          test: function (row, value) {
            var malicious = row.entity.maliciousIntent === true;
            return value === 'malicious' ? malicious : !malicious;
          },
        },
        {
          id: 'threats',
          label: 'Threats',
          options: [
            { value: 'any', label: 'Has at least one threat' },
            { value: 'none', label: 'Has none' },
          ],
          test: function (row, value) { return value === 'any' ? row.threats.length > 0 : row.threats.length === 0; },
        },
      ],
      columns: [
        { key: 'name', label: 'Persona', sortable: true, render: function (row) {
          return V.nameCell(row);
        } },
        { key: 'threats', label: 'Threats', numeric: true, sortable: true, render: function (row) {
          if (!row.threats.length) return core.el('span', { class: 'tmv-muted', text: 'None' });
          return core.el('span', { text: String(row.threats.length) });
        } },
        { key: 'applied', label: 'Applied', numeric: true, sortable: true, render: function (row) {
          return core.el('span', { text: String(row.applied) });
        } },
        { key: 'skill', label: 'Skill', sortable: true, render: function (row) {
          return row.entity.skillLevel
            ? core.el('span', { text: V.vocabLabel('skillLevel', row.entity.skillLevel) })
            : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'access', label: 'Access', sortable: true, render: function (row) {
          return row.entity.accessLevel
            ? core.el('span', { text: V.vocabLabel('accessLevel', row.entity.accessLevel) })
            : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'likelihood', label: 'Highest likelihood', numeric: true, sortable: true, render: function (row) {
          return row.likelihood === null ? core.el('span', { class: 'tmv-muted', text: 'Not rated' }) : core.el('span', { text: String(row.likelihood) });
        } },
        { key: 'impact', label: 'Highest impact', numeric: true, sortable: true, render: function (row) {
          return row.impact === null ? core.el('span', { class: 'tmv-muted', text: 'Not rated' }) : core.el('span', { text: String(row.impact) });
        } },
      ],
      empty: { title: 'No threat personas' },
      filteredEmpty: {
        title: 'No personas match these filters',
        body: 'This model has personas; none of them match what is selected.',
      },
      detail: function (c, row) {
        var list = row.threats.length
          ? core.el('ul', { class: 'tmv-dialog__list' }, row.threats.map(function (threat) {
              var applications = M.applicationsForThreat(c.model, threat.id);
              var suffix = applications.length ? ' — applied to ' + core.plural(applications.length, 'target', 'targets') : ' — applied to nothing';
              return core.el('li', { text: M.labelOf(threat) + suffix });
            }))
          : core.el('p', { class: 'tmv-muted', text: 'No threat in this model names this persona.' });
        var related = V.relatedBlock(
          core.plural(row.threats.length, 'threat attributed to this persona', 'threats attributed to this persona'),
          list
        );
        return V.detailView(c, { type: 'threatPersona', entity: row.entity, related: related });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Personas
  // ---------------------------------------------------------------------------------------------

  var PERSONAS_NOTE =
    'The persona records themselves: who they are, what they can do, and whether the model says they ' +
    'mean harm. This is the only screen where these fields are editable, which is why it exists ' +
    'separately from By Persona.';

  // `isPerson` is optional, so "a person", "a system or group" and "not stated" are three answers.
  // The filter and the column both read from this, so they cannot drift apart.
  var KIND = { person: 'person', system: 'system', unset: 'unset' };
  var KIND_LABEL = { person: 'A person', system: 'A system or group', unset: 'Not stated' };

  function kindOf(persona) {
    if (persona.isPerson === true) return KIND.person;
    if (persona.isPerson === false) return KIND.system;
    return KIND.unset;
  }

  function personasSection(ctx) {
    var rows = [];
    var list = M.collection(ctx.model, 'threatPersona');
    for (var i = 0; i < list.length; i++) {
      var persona = list[i];
      rows.push({
        entity: persona,
        __search: [persona.name, persona.skillLevel, persona.accessLevel, persona.applicabilityToOrg, persona.id].join(' '),
      });
    }

    return V.listSection(ctx, 'Personas', PERSONAS_NOTE, {
      key: 'threats.personas',
      type: 'threatPersona',
      entityRows: rows,
      plural: 'personas',
      singular: 'persona',
      pageSizes: [10, 25, 50],
      addLabel: 'Add persona',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'isPerson',
          label: 'Kind',
          // Three options, not two: `isPerson` is optional, and a persona whose kind is unstated is
          // reachable only through an option that admits it. Folding it into "not a person" would
          // assert something the model does not say.
          options: [
            { value: KIND.person, label: KIND_LABEL[KIND.person] },
            { value: KIND.system, label: KIND_LABEL[KIND.system] },
            { value: KIND.unset, label: KIND_LABEL[KIND.unset] },
          ],
          test: function (row, value) { return kindOf(row.entity) === value; },
        },
        {
          id: 'applicability',
          label: 'Applicability',
          options: V.distinctOptions(rows, function (row) { return row.entity.applicabilityToOrg; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.applicabilityToOrg; }); },
        },
      ],
      columns: [
        { key: 'name', label: 'Persona', sortable: true, render: function (row) { return V.nameCell(row); } },
        { key: 'kind', label: 'Kind', sortable: true, render: function (row) {
          var kind = kindOf(row.entity);
          if (kind === KIND.unset) return core.el('span', { class: 'tmv-muted', text: KIND_LABEL[kind] });
          return core.el('span', { text: KIND_LABEL[kind] });
        } },
        { key: 'intent', label: 'Intent', sortable: true, render: function (row) {
          if (row.entity.maliciousIntent === true) return V.tag({ text: 'Malicious', type: 'red' });
          if (row.entity.maliciousIntent === false) return V.tag({ text: 'Not malicious', type: 'green' });
          return core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'skill', label: 'Skill', sortable: true, render: function (row) {
          return row.entity.skillLevel ? core.el('span', { text: V.vocabLabel('skillLevel', row.entity.skillLevel) }) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'access', label: 'Access', sortable: true, render: function (row) {
          return row.entity.accessLevel ? core.el('span', { text: V.vocabLabel('accessLevel', row.entity.accessLevel) }) : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'applicability', label: 'Applicability', sortable: true, render: function (row) {
          return row.entity.applicabilityToOrg
            ? core.el('span', { text: V.vocabLabel('degree', row.entity.applicabilityToOrg) })
            : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
      ],
      empty: {
        title: 'No personas',
        body:
          'Threat personas are TML-only. An OTM model attributes each threat directly, so there is ' +
          'nothing to list here and nothing missing from it.',
      },
      filteredEmpty: {
        title: 'No personas match these filters',
        body: 'This model has personas; none of them match what is selected.',
      },
      detail: function (c, row) { return V.detailView(c, { type: 'threatPersona', entity: row.entity }); },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Assumptions
  // ---------------------------------------------------------------------------------------------

  var ASSUMPTIONS_NOTE =
    'An assumption is something the model takes as true without proving it. The validity field is the ' +
    'model saying how much weight it puts on it, and an unconfirmed assumption is not a defect — it ' +
    'is a stated risk that has not been checked.';

  function assumptionsSection(ctx) {
    var rows = [];
    var list = M.collection(ctx.model, 'assumption');
    for (var i = 0; i < list.length; i++) {
      var assumption = list[i];
      rows.push({
        entity: assumption,
        validity: assumption.validity || '',
        topics: core.isArray(assumption.topics) ? assumption.topics : [],
        __search: [assumption.name, assumption.validity, (assumption.topics || []).join(' '), assumption.id].join(' '),
      });
    }

    return V.listSection(ctx, 'Assumptions', ASSUMPTIONS_NOTE, {
      key: 'threats.assumptions',
      type: 'assumption',
      entityRows: rows,
      plural: 'assumptions',
      singular: 'assumption',
      pageSizes: [10, 25, 50],
      addLabel: 'Add assumption',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'validity',
          label: 'Validity',
          options: V.distinctOptions(rows, function (row) { return row.validity; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.validity; }); },
        },
        {
          id: 'topic',
          label: 'Topic',
          options: V.listOptions(rows, function (row) { return row.topics; }),
          test: function (row, value) { return V.matchList(row, value, function (r) { return r.topics; }); },
        },
      ],
      columns: [
        { key: 'name', label: 'Assumption', sortable: true, render: function (row) { return V.nameCell(row); } },
        { key: 'validity', label: 'Validity', sortable: true, render: function (row) {
          if (!row.validity) return core.el('span', { class: 'tmv-muted', text: 'Not stated' });
          var type = row.validity === 'confirmed' ? 'green' : row.validity === 'rejected' ? 'red' : 'gray';
          return V.tag({ text: V.vocabLabel('validity', row.validity), type: type });
        } },
        { key: 'topics', label: 'Topics', render: function (row) {
          return row.topics.length ? V.tagList(row.topics, 'gray') : core.el('span', { class: 'tmv-muted', text: '—' });
        } },
      ],
      empty: {
        title: 'No assumptions',
        body:
          'Assumptions are TML-only, and optional. An empty section means the model states none — not ' +
          'that it makes none, which is the thing to remember when reading the rest of it.',
      },
      filteredEmpty: {
        title: 'No assumptions match these filters',
        body: 'This model has assumptions; none of them match what is selected.',
      },
      detail: function (c, row) { return V.detailView(c, { type: 'assumption', entity: row.entity }); },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Unresolved references — the finding
  // ---------------------------------------------------------------------------------------------

  var UNRESOLVED_NOTE =
    'Every reference in this model that points at something the model does not hold. This is a ' +
    'referential check, not a validity check: a model can be internally consistent and still be built ' +
    'on a reference that goes nowhere, and this is where that is counted. Nothing here is repaired ' +
    'automatically — a dangling id is a statement somebody made, and guessing what they meant would ' +
    'replace it with the application’s guess.';

  /** Every entity in the model, with the references of its own that do not resolve. */
  function unresolvedRows(ctx) {
    var rows = [];
    for (var t = 0; t < M.ENTITY_KEYS.length; t++) {
      var typeKey = M.ENTITY_KEYS[t];
      var list = M.collection(ctx.model, typeKey);
      for (var i = 0; i < list.length; i++) {
        var missing = V.unresolvedOf(ctx, typeKey, list[i]);
        if (!missing.length) continue;
        var typeSpec = M.typeFor(typeKey);
        rows.push({
          entity: list[i],
          __key: typeKey + ':' + list[i].id,
          typeKey: typeKey,
          typeLabel: typeSpec ? typeSpec.label : typeKey,
          missing: missing,
          __search: [M.labelOf(list[i]), typeSpec ? typeSpec.plural : typeKey, missing.map(function (m) { return m.label + ' ' + m.id; }).join(' ')].join(' '),
        });
      }
    }
    return rows;
  }

  function unresolvedSection(ctx) {
    var rows = unresolvedRows(ctx);
    var total = 0;
    for (var i = 0; i < rows.length; i++) total += rows[i].missing.length;

    if (!rows.length) {
      var anyEntities = M.counts(ctx.model).total > 0;
      return V.section(ctx, 'Unresolved References', UNRESOLVED_NOTE, V.emptySection({
        title: 'Every reference resolves',
        body: anyEntities
          ? 'Each of the ' + core.plural(M.counts(ctx.model).total, 'entity', 'entities') + ' in this model ' +
            'names only things the model holds. That is the check passing on what is here; it says nothing ' +
            'about whether the model is complete.'
          : 'This model has no entities, so there is nothing for this check to look at.',
      }));
    }

    return V.listSection(ctx, 'Unresolved References', UNRESOLVED_NOTE, {
      key: 'threats.unresolved',
      type: null,
      entityRows: rows,
      plural: 'entities',
      singular: 'entity',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      summary: core.el('p', {
        class: 'tmv-intro',
        // Phrased so the two counts each carry their own agreement: "across 3 entities, 5 references
        // do not resolve" rather than a sentence whose verb has to agree with two nouns at once.
        text:
          'Across ' + core.plural(rows.length, 'entity', 'entities') + ', ' + total + ' ' +
          (total === 1 ? 'reference does' : 'references do') + ' not resolve. Exporting is not blocked by ' +
          'these — they travel with the model, and the receiving tool will see the same dangling ids.',
      }),
      filters: [
        {
          id: 'kind',
          label: 'Entity kind',
          options: V.distinctOptions(rows, function (row) { return row.typeLabel; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.typeLabel; }); },
        },
        {
          id: 'field',
          label: 'Field',
          // One row can have several dangling references in several fields, so this is a list-valued
          // field and needs `listOptions`, which owns the "None" sentinel for exactly that case.
          options: V.listOptions(rows, function (row) {
            return row.missing.map(function (m) { return m.label; });
          }),
          test: function (row, value) {
            return V.matchList(row, value, function (r) {
              return r.missing.map(function (m) { return m.label; });
            });
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Entity', sortable: true, render: function (row) {
          // The row key here is `type:id`, because two entities of different kinds can share an id.
          // Nothing is passed for it: `V.nameCell` reads the key off the row, which is the same key
          // the detail host looks the row up by.
          return V.nameCell(row);
        } },
        { key: 'kind', label: 'Kind', sortable: true, render: function (row) {
          return core.el('span', { text: row.typeLabel });
        } },
        { key: 'missing', label: 'Does not resolve', render: function (row) {
          var wrap = core.el('span', { class: 'tmv-tags' });
          for (var i = 0; i < row.missing.length; i++) {
            wrap.appendChild(V.tag({
              text: row.missing[i].label + ' → ' + row.missing[i].id,
              type: 'red',
              title: row.missing[i].text,
            }));
          }
          return wrap;
        } },
      ],
      empty: { title: 'Every reference resolves' },
      filteredEmpty: {
        title: 'No unresolved references match these filters',
        body: 'This model has unresolved references; none of them match what is selected.',
      },
      detail: function (c, row) {
        var related = V.relatedBlock('What does not resolve', core.el('ul', { class: 'tmv-dialog__list' },
          row.missing.map(function (m) { return core.el('li', { text: m.text }); })));
        return V.detailView(c, { type: row.typeKey, entity: row.entity, related: related });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------

  var SECTIONS = {
    'all-threats': allThreatsSection,
    'by-target': byTargetSection,
    'by-persona': byPersonaSection,
    personas: personasSection,
    assumptions: assumptionsSection,
    'unresolved-references': unresolvedSection,
  };

  function render(ctx) {
    var build = SECTIONS[ctx.section] || SECTIONS['all-threats'];
    return build(ctx);
  }

  /**
   * Only Unresolved References is a finding, and its count is dangling *references*, not entities:
   * one entity with three dangling references is three repairs to make, and `07-ui.md` §3 asks the
   * side-nav badge to answer "how much is wrong", not "how many rows are involved".
   */
  function danglingCount(ctx) {
    var rows = unresolvedRows(ctx);
    var total = 0;
    for (var i = 0; i < rows.length; i++) total += rows[i].missing.length;
    return total;
  }

  function counts(ctx) {
    return { 'unresolved-references': danglingCount(ctx) };
  }

  TMV.shell.register({ id: 'threats', title: 'Threats', render: render, counts: counts });
})(globalThis.TMV = globalThis.TMV || {});
