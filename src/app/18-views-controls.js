/*
 * 18-views-controls.js — the Controls tab.
 *
 * Sections (`07-ui.md` §3): All Controls · By Threat · Mitigation Plans · Coverage Gaps · Unapplied.
 *
 * Two of those are findings, and §3 says an entry that is a filter rather than an entity type is
 * marked with a count "so it reads as a finding, not a section" — with `0` shown rather than nothing,
 * because an empty filter showing nothing looks broken. So both of these register counts, and both
 * are built from the same predicate their rows come from.
 *
 * The thing this tab has to get right is the *word* it uses. "Unapplied" is not the complement of
 * "active": the status vocabulary has eight values and four of them do not say whether the control is
 * in force. A section that quietly assumed "not active ⇒ not applied" would report a false finding
 * against a control that is running, and a false finding is the worst thing this application can
 * print — it is worse than printing nothing. So `UNAPPLIED_STATUS` names the four statuses that
 * actually state the control is not in effect, the rule is printed on screen, and the note names the
 * statuses the section deliberately leaves out and why.
 *
 * Both formats record controls, and both mechanisms are present in one model: TML puts them at the
 * root with `threatIds`, OTM attaches a state to a control through a threat application's
 * `controlStates`. `M.controlsForThreat` merges the two, and this tab uses it rather than reading
 * `threatIds` directly, so a control that only ever appears in an application's control states is
 * still counted as covering that threat. That is also why a row's count of threats is a *count*: the
 * two mechanisms produce one set, not two columns.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  // ---------------------------------------------------------------------------------------------
  // The rules, in one place each
  // ---------------------------------------------------------------------------------------------

  /**
   * Statuses that state a control is not in effect.
   *
   * The four left out are left out on purpose, and the section says so:
   * `active` is in effect; `assumed` is present but unverified, which is still present; and
   * `approved` and `under_review` do not say whether the control is deployed, so this section does
   * not claim it is not. A control with no status is not here either — the model does not say.
   */
  var UNAPPLIED_STATUS = ['suggested', 'scheduled', 'retired', 'wont_do'];

  var UNAPPLIED_LABELS = 'suggested, scheduled, retired or wont do';

  function isUnapplied(control) {
    return UNAPPLIED_STATUS.indexOf(control.status) !== -1;
  }

  /**
   * A coverage gap: a threat that is applied to at least one target and has no control.
   *
   * Both halves are load-bearing. A threat applied nowhere is not covered but is also not exposed, so
   * calling it a gap would inflate the finding with threats the model has not placed anywhere — the
   * `By Target` section in Threats is where those live, and a threat with no application is normal.
   *
   * "No control" means `M.controlsForThreat` returns nothing, which spans both formats: TML's
   * `threatIds` and OTM's per-application `controlStates`. It does not consider a control's *status*:
   * a threat whose only control is `suggested` is covered by a plan, and saying otherwise here would
   * duplicate the Unapplied section's finding under a second name. The two are separate on purpose and
   * both notes say which question they answer.
   */
  function hasCoverageGap(model, threatId) {
    if (!M.applicationsForThreat(model, threatId).length) return false;
    return M.controlsForThreat(model, threatId).length === 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------------------------

  function controlRows(ctx) {
    var list = M.collection(ctx.model, 'control');
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var control = list[i];
      var threatIds = core.isArray(control.threatIds) ? control.threatIds : [];
      var threats = [];
      for (var t = 0; t < threatIds.length; t++) {
        var threat = M.get(ctx.model, 'threat', threatIds[t]);
        if (threat) threats.push(threat);
      }
      rows.push({
        entity: control,
        threats: threats,
        unapplied: isUnapplied(control),
        rated: core.isNumber(control.riskReduction),
        zoneA: control.trustBoundary ? V.refText(ctx, control.trustBoundary.zoneAId) : '',
        zoneB: control.trustBoundary ? V.refText(ctx, control.trustBoundary.zoneBId) : '',
        __search: [
          control.name,
          control.status,
          control.priority,
          threats.map(function (threat) { return M.labelOf(threat); }).join(' '),
          control.id,
        ].join(' '),
      });
    }
    return rows;
  }

  /** The "between A and B" text for a control's trust boundary, or nothing when it has none. */
  function boundaryText(row) {
    if (!row.zoneA && !row.zoneB) return core.el('span', { class: 'tmv-muted', text: '—' });
    if (row.zoneA && row.zoneB) return core.el('span', { text: 'Between ' + row.zoneA + ' and ' + row.zoneB });
    return core.el('span', { text: row.zoneA || row.zoneB });
  }

  function riskReductionCell(row) {
    if (!row.rated) return core.el('span', { class: 'tmv-muted', text: 'Not estimated' });
    // The percentage is the model's own claim and is printed as one. It is not a computed score, and
    // it is not multiplied by anything — `03-data-model.md` §4.11 keeps it a stated field.
    return core.el('span', { text: String(row.entity.riskReduction) + '%', title: 'The model’s own estimate of how much this control reduces risk' });
  }

  // ---------------------------------------------------------------------------------------------
  // 1. All controls
  // ---------------------------------------------------------------------------------------------

  var ALL_NOTE =
    'Every countermeasure the model records, in both formats’ shape at once: a control names the ' +
    'threats it covers (TML), and a threat application names the controls protecting it and what ' +
    'state they are in (OTM). The threat count below merges the two, so a control that is only ever ' +
    'named through an application still shows up here.';

  function allControlsSection(ctx) {
    var rows = controlRows(ctx);

    return V.listSection(ctx, 'All Controls', ALL_NOTE, {
      key: 'controls.all',
      type: 'control',
      entityRows: rows,
      plural: 'controls',
      singular: 'control',
      addLabel: 'Add control',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'status',
          label: 'Status',
          options: V.distinctOptions(rows, function (row) { return row.entity.status; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.status; }); },
        },
        {
          id: 'priority',
          label: 'Priority',
          options: V.distinctOptions(rows, function (row) { return row.entity.priority; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.priority; }); },
        },
        {
          id: 'threats',
          label: 'Threats',
          options: [
            { value: 'yes', label: 'Covers at least one threat' },
            { value: 'no', label: 'Covers nothing' },
          ],
          test: function (row, value) { return value === 'yes' ? row.threats.length > 0 : row.threats.length === 0; },
        },
        {
          id: 'reduction',
          label: 'Risk reduction',
          options: [
            { value: 'yes', label: 'Estimated' },
            { value: 'no', label: 'Not estimated' },
          ],
          test: function (row, value) { return value === 'yes' ? row.rated : !row.rated; },
        },
      ],
      columns: [
        { key: 'name', label: 'Control', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'control') });
        } },
        { key: 'status', label: 'Status', sortable: true, render: function (row) {
          var chip = V.statusTag(row.entity.status);
          return chip || core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'priority', label: 'Priority', sortable: true, render: function (row) {
          var chip = V.priorityTag(row.entity.priority);
          return chip || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'threats', label: 'Threats', numeric: true, sortable: true, render: function (row) {
          if (!row.threats.length) return core.el('span', { class: 'tmv-cell-note', text: 'Nothing' });
          return core.el('span', { text: String(row.threats.length) });
        } },
        { key: 'reduction', label: 'Risk reduction', numeric: true, sortable: true, render: riskReductionCell },
        { key: 'boundary', label: 'Trust boundary', render: boundaryText },
      ],
      empty: {
        title: 'No controls',
        body:
          'This model records no countermeasures. That is legal in both formats and it is not an error ' +
          '— but it does mean the Coverage Gaps section has nothing that could close a gap, so read ' +
          'the two together.',
      },
      filteredEmpty: {
        title: 'No controls match these filters',
        body: 'This model has controls; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'control', entity: row.entity, related: controlRelated(c, row) });
      },
    });
  }

  /** What a control covers, and where it sits. Both are read-only lists of names, not links. */
  function controlRelated(ctx, row) {
    var blocks = [];
    var threats = row.threats.length
      ? core.el('ul', { class: 'tmv-dialog__list' }, row.threats.map(function (threat) {
          return core.el('li', { text: M.labelOf(threat) });
        }))
      : core.el('p', { class: 'tmv-muted', text: 'This control covers no threat in this model.' });
    blocks.push(V.relatedBlock(core.plural(row.threats.length, 'threat it covers', 'threats it covers'), threats));

    if (row.entity.trustBoundary) {
      var zones = [V.refText(ctx, row.entity.trustBoundary.zoneAId), V.refText(ctx, row.entity.trustBoundary.zoneBId)];
      blocks.push(V.relatedBlock(
        'Zone it sits between',
        core.el('p', { text: zones[0] + (zones[1] ? ' and ' + zones[1] : '') })
      ));
    }

    var plans = M.collection(ctx.model, 'mitigationPlan').filter(function (plan) {
      return core.isArray(plan.controlIds) && plan.controlIds.indexOf(row.entity.id) !== -1;
    });
    if (plans.length) {
      blocks.push(V.relatedBlock(
        core.plural(plans.length, 'mitigation plan uses it', 'mitigation plans use it'),
        core.el('ul', { class: 'tmv-dialog__list' }, plans.map(function (plan) {
          return core.el('li', { text: M.labelOf(plan) });
        }))
      ));
    }

    var present = blocks.filter(function (node) { return node !== null; });
    return present.length ? core.el('div', {}, present) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // 2. By threat
  // ---------------------------------------------------------------------------------------------

  var BY_THREAT_NOTE =
    'The same pairs read the other way round: one row per threat, with the controls that cover it. ' +
    'Every threat is listed, including the ones with no controls at all — a row saying "None" is how ' +
    'you find out, and hiding those rows would make this screen agree with All Controls by omission ' +
    'rather than by anything the model says.';

  function byThreatSection(ctx) {
    var threats = M.collection(ctx.model, 'threat');
    var rows = [];
    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i];
      var controls = M.controlsForThreat(ctx.model, threat.id);
      var applications = M.applicationsForThreat(ctx.model, threat.id);
      var states = [];
      for (var a = 0; a < applications.length; a++) {
        if (core.isArray(applications[a].controlStates)) {
          states = states.concat(applications[a].controlStates);
        }
      }
      rows.push({
        entity: threat,
        controls: controls,
        applications: applications,
        gap: hasCoverageGap(ctx.model, threat.id),
        persona: V.labelFrom(ctx.model, threat.personaId),
        __search: [
          threat.name,
          controls.map(function (c) { return M.labelOf(c); }).join(' '),
          V.labelFrom(ctx.model, threat.personaId),
          threat.id,
        ].join(' '),
      });
    }

    if (!rows.length) {
      return V.section(ctx, 'By Threat', BY_THREAT_NOTE, V.emptySection({
        title: 'No threats',
        body:
          'Controls cover threats, so with no threats in the model there is nothing for a control to ' +
          'cover and this screen has no rows. Threats come from either format; this model has none.',
      }));
    }

    return V.listSection(ctx, 'By Threat', BY_THREAT_NOTE, {
      key: 'controls.by-threat',
      type: 'threat',
      entityRows: rows,
      plural: 'threats',
      singular: 'threat',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'persona',
          label: 'Persona',
          options: V.distinctOptions(rows, function (row) { return row.persona; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.persona; }); },
        },
        {
          id: 'controls',
          label: 'Controls',
          options: [
            { value: 'yes', label: 'Has at least one control' },
            { value: 'no', label: 'Has none' },
          ],
          test: function (row, value) { return value === 'yes' ? row.controls.length > 0 : row.controls.length === 0; },
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
      ],
      columns: [
        { key: 'name', label: 'Threat', sortable: true, render: function (row) { return V.nameCell(row); } },
        { key: 'controls', label: 'Controls', numeric: true, sortable: true, render: function (row) {
          if (!row.controls.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: String(row.controls.length) });
        } },
        { key: 'states', label: 'Control status', render: function (row) {
          if (!row.controls.length) return core.el('span', { class: 'tmv-muted', text: '—' });
          var wrap = core.el('span', { class: 'tmv-tags' });
          for (var i = 0; i < row.controls.length && i < 3; i++) {
            var control = row.controls[i];
            // The name is in the tag's text, not only in its tooltip: three controls all in `planned`
            // would otherwise render three identical chips and say nothing about which is which.
            var chip = V.statusTag(control.status, M.labelOf(control) + ': ' + V.humanise(control.status || 'not stated'));
            if (!chip) continue;
            wrap.appendChild(chip);
          }
          if (row.controls.length > 3) {
            wrap.appendChild(core.el('span', { class: 'tmv-muted', text: ' +' + (row.controls.length - 3) + ' more' }));
          }
          return wrap;
        } },
        { key: 'applied', label: 'Applied to', numeric: true, sortable: true, render: function (row) {
          if (!row.applications.length) return core.el('span', { class: 'tmv-cell-note', text: 'Nothing' });
          return core.el('span', { text: core.plural(row.applications.length, 'target', 'targets') });
        } },
        { key: 'gap', label: 'Coverage', render: function (row) {
          if (!row.gap) return core.el('span', { class: 'tmv-muted', text: '—' });
          return V.tag({
            text: 'No control',
            type: 'red',
            title: 'This threat is applied to a target and no control covers it.',
          });
        } },
      ],
      empty: { title: 'No threats' },
      filteredEmpty: {
        title: 'No threats match these filters',
        body: 'This model has threats; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'threat', entity: row.entity, related: threatControlBlock(c, row) });
      },
    });
  }

  function threatControlBlock(ctx, row) {
    if (!row.controls.length) {
      return V.relatedBlock('Controls that cover it', core.el('p', {
        text: row.gap
          ? 'None. This threat is applied to a target, so no control covering it is the Coverage Gaps finding for this row.'
          : 'None. This threat is not applied to a target, so nothing is exposed by it either.',
      }));
    }
    return V.relatedBlock(
      core.plural(row.controls.length, 'control that covers it', 'controls that cover it'),
      core.el('ul', { class: 'tmv-dialog__list' }, row.controls.map(function (control) {
        var status = control.status ? V.humanise(control.status) : 'status not stated';
        return core.el('li', { text: M.labelOf(control) + ' — ' + status });
      }))
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Mitigation plans
  // ---------------------------------------------------------------------------------------------

  var PLANS_NOTE =
    'A mitigation plan is TML’s link between a risk and the controls proposed to reduce it. It carries ' +
    'little of its own — a risk and a list of controls — so most of what is worth reading here is the ' +
    'risk it names, which is shown alongside rather than in place of the plan.';

  function planRows(ctx) {
    var list = M.collection(ctx.model, 'mitigationPlan');
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var plan = list[i];
      var risk = core.isString(plan.riskId) ? M.get(ctx.model, 'risk', plan.riskId) : null;
      var ids = core.isArray(plan.controlIds) ? plan.controlIds : [];
      var controls = [];
      for (var c = 0; c < ids.length; c++) {
        var control = M.get(ctx.model, 'control', ids[c]);
        if (control) controls.push(control);
      }
      rows.push({
        entity: plan,
        risk: risk,
        controls: controls,
        // `V.riskOf` reads the stored score and level first and derives them from likelihood and
        // impact only when the model did not state them, so a model that carries both is shown the
        // model's own numbers and a TML risk with only the two enums still has a level.
        scored: V.riskOf(risk),
        __search: [
          plan.name,
          risk ? M.labelOf(risk) : String(plan.riskId || ''),
          controls.map(function (control) { return M.labelOf(control); }).join(' '),
          plan.id,
        ].join(' '),
      });
    }
    return rows;
  }

  function mitigationPlansSection(ctx) {
    var rows = planRows(ctx);
    var risks = M.collection(ctx.model, 'risk');

    if (!rows.length) {
      return V.section(ctx, 'Mitigation Plans', PLANS_NOTE, V.emptySection({
        title: 'No mitigation plans',
        body: risks.length
          ? core.plural(risks.length, 'risk is', 'risks are') + ' recorded and none has a mitigation plan. ' +
            'Plans are TML-only, so an OTM model is expected to be empty here — it records controls ' +
            'against threats directly, and those are in All Controls.'
          : 'Mitigation plans join a risk to the controls that reduce it, and this model records no ' +
            'risks, so there is nothing to join.',
      }));
    }

    return V.listSection(ctx, 'Mitigation Plans', PLANS_NOTE, {
      key: 'controls.plans',
      type: 'mitigationPlan',
      entityRows: rows,
      plural: 'mitigation plans',
      singular: 'mitigation plan',
      pageSizes: [10, 25, 50],
      addLabel: 'Add mitigation plan',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'level',
          label: 'Risk level',
          options: V.distinctOptions(rows, function (row) { return row.scored.level; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.scored.level; }); },
        },
        {
          id: 'controls',
          label: 'Controls',
          options: [
            { value: 'yes', label: 'Names at least one control' },
            { value: 'no', label: 'Names none' },
          ],
          test: function (row, value) { return value === 'yes' ? row.controls.length > 0 : row.controls.length === 0; },
        },
      ],
      columns: [
        { key: 'name', label: 'Mitigation plan', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'mitigationPlan') });
        } },
        { key: 'risk', label: 'Risk', sortable: true, render: function (row) {
          if (!row.risk) {
            return core.el('span', { class: 'tmv-unresolved' }, [
              core.el('span', { class: 'tmv-unresolved__mark', 'aria-hidden': 'true', text: '!' }),
              core.el('span', { class: 'tmv-unresolved__id', text: String(row.entity.riskId || 'none') }),
            ]);
          }
          return core.el('span', { text: M.labelOf(row.risk) });
        } },
        { key: 'level', label: 'Risk level', sortable: true,
          // A mitigation plan carries no level of its own; the column shows the level of the risk it
          // mitigates, computed on the row. The column declares that, and sorts by the vocabulary's
          // order rather than alphabetically.
          sortValue: function (row) { return V.vocabRank('riskLevel', row.scored.level); },
          render: function (row) {
          var chip = V.riskTag(row.scored.level);
          if (!chip) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
          // The level is shown as derived when it is, because a derived level is this application's
          // reading of the banding and a stored one is the model's own statement. `riskTag` carries
          // its own tooltip, so the derivation is added beside it rather than replacing it.
          if (!row.scored.derived) return chip;
          return core.el('span', { class: 'tmv-tags' }, [
            chip,
            core.el('span', {
              class: 'tmv-cell-note',
              text: 'derived',
              title: 'This level is computed here from the risk’s likelihood and impact; the model does not state one.',
            }),
          ]);
        } },
        { key: 'controls', label: 'Controls', numeric: true, sortable: true, render: function (row) {
          if (!row.controls.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: String(row.controls.length) });
        } },
        { key: 'status', label: 'Control status', render: function (row) {
          if (!row.controls.length) return core.el('span', { class: 'tmv-muted', text: '—' });
          var wrap = core.el('span', { class: 'tmv-tags' });
          for (var i = 0; i < row.controls.length && i < 3; i++) {
            var chip = V.statusTag(row.controls[i].status);
            if (chip) wrap.appendChild(chip);
          }
          if (row.controls.length > 3) {
            wrap.appendChild(core.el('span', { class: 'tmv-muted', text: ' +' + (row.controls.length - 3) + ' more' }));
          }
          return wrap;
        } },
      ],
      empty: { title: 'No mitigation plans' },
      filteredEmpty: {
        title: 'No mitigation plans match these filters',
        body: 'This model has mitigation plans; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'mitigationPlan', entity: row.entity, related: planRelated(c, row) });
      },
    });
  }

  function planRelated(ctx, row) {
    var blocks = [];
    if (row.controls.length) {
      blocks.push(V.relatedBlock(
        core.plural(row.controls.length, 'control it proposes', 'controls it proposes'),
        core.el('ul', { class: 'tmv-dialog__list' }, row.controls.map(function (control) {
          var status = control.status ? V.humanise(control.status) : 'status not stated';
          return core.el('li', { text: M.labelOf(control) + ' — ' + status });
        }))
      ));
    } else {
      blocks.push(V.relatedBlock('Controls it proposes', core.el('p', {
        text: 'None. A plan that names no control is a stated intention with nothing behind it yet.',
      })));
    }
    if (row.risk) {
      var scored = row.scored;
      blocks.push(V.relatedBlock('The risk it mitigates', core.el('p', {
        text: M.labelOf(row.risk)
          + ' — score ' + (core.isNumber(scored.score) ? String(scored.score) : 'not scored')
          + ', level ' + (scored.level ? V.humanise(scored.level) : 'not rated')
          + (scored.derived ? ' (derived here from its likelihood and impact)' : ' (as the model states it)')
          + '.',
      })));
    }
    return core.el('div', {}, blocks);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Coverage gaps — the finding
  // ---------------------------------------------------------------------------------------------

  var GAPS_NOTE =
    'Threats that are applied to at least one target and have no control covering them. Both halves ' +
    'of that rule matter: a threat applied nowhere is not covered and is not exposed either, so it is ' +
    'not counted here, and a threat whose only control is still a plan is counted as covered — the ' +
    'Unapplied section below is where controls that are not in effect are listed. This section ' +
    'deliberately looks at whether a control exists, not at what state it is in.';

  function gapRows(ctx) {
    var threats = M.collection(ctx.model, 'threat');
    var rows = [];
    for (var i = 0; i < threats.length; i++) {
      var threat = threats[i];
      if (!hasCoverageGap(ctx.model, threat.id)) continue;
      rows.push({
        entity: threat,
        applications: M.applicationsForThreat(ctx.model, threat.id),
        persona: V.labelFrom(ctx.model, threat.personaId),
        __search: [
          threat.name,
          V.labelFrom(ctx.model, threat.personaId),
          threat.id,
        ].join(' '),
      });
    }
    return rows;
  }

  function coverageGapsSection(ctx) {
    var rows = gapRows(ctx);
    var threats = M.collection(ctx.model, 'threat');

    if (!rows.length) {
      var applied = 0;
      for (var i = 0; i < threats.length; i++) {
        if (M.applicationsForThreat(ctx.model, threats[i].id).length) applied++;
      }
      return V.section(ctx, 'Coverage Gaps', GAPS_NOTE, V.emptySection({
        title: applied ? 'No uncovered threats' : 'Nothing is applied',
        body: applied
          ? 'Each of the ' + core.plural(applied, 'threat that is applied to a target has', 'threats that are applied to targets have') +
            ' at least one control. This is a statement about controls existing, not about whether ' +
            'they work or are in effect — nothing in either format records that, so nothing here ' +
            'claims it.'
          : 'No threat in this model is applied to a target, so no threat is exposed by one and there ' +
            'is nothing for a control to cover. That is a normal state for a TML model, which keeps ' +
            'its threats at the root.',
      }));
    }

    return V.listSection(ctx, 'Coverage Gaps', GAPS_NOTE, {
      key: 'controls.gaps',
      type: 'threat',
      entityRows: rows,
      plural: 'threats',
      singular: 'threat',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      summary: core.el('p', {
        class: 'tmv-intro',
        // One sentence chosen whole rather than assembled from clauses: the verb and the pronoun each
        // have to agree with the count, and a sentence built from two independently pluralised halves
        // reads "1 threat ... them".
        text:
          (rows.length === 1
            ? 'One threat is applied to a target and no control covers it.'
            : rows.length + ' threats are applied to targets and no control covers them.')
          + ' Adding a control clears a row from this list; nothing here is repaired automatically, ' +
          'because choosing a countermeasure is a decision the model has to make.',
      }),
      filters: [
        {
          id: 'persona',
          label: 'Persona',
          options: V.distinctOptions(rows, function (row) { return row.persona; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.persona; }); },
        },
        {
          id: 'targets',
          label: 'Applied to',
          options: [
            { value: 'one', label: 'One target' },
            { value: 'many', label: 'More than one target' },
          ],
          test: function (row, value) { return value === 'one' ? row.applications.length === 1 : row.applications.length > 1; },
        },
      ],
      columns: [
        { key: 'name', label: 'Threat', sortable: true, render: function (row) { return V.nameCell(row); } },
        { key: 'persona', label: 'Persona', sortable: true, render: function (row) {
          return row.persona || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'targets', label: 'Applied to', numeric: true, sortable: true, render: function (row) {
          return core.el('span', { text: core.plural(row.applications.length, 'target', 'targets') });
        } },
        { key: 'likelihood', label: 'Likelihood', numeric: true, sortable: true, render: scoreCell('likelihood') },
        { key: 'impact', label: 'Impact', numeric: true, sortable: true, render: scoreCell('impact') },
      ],
      empty: { title: 'No uncovered threats' },
      filteredEmpty: {
        title: 'No coverage gaps match these filters',
        body: 'This model has uncovered threats; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, {
          type: 'threat',
          entity: row.entity,
          related: V.relatedBlock('What it is applied to', core.el('ul', { class: 'tmv-dialog__list' },
            row.applications.map(function (application) {
              var target = M.findAnywhere(c.model, application.targetId);
              var state = application.state ? V.humanise(application.state) : 'state not stated';
              return core.el('li', {
                text: (target ? M.labelOf(target.entity) : String(application.targetId)) + ' — ' + state,
              });
            }))),
        });
      },
    });
  }

  /** A likelihood or impact score, unrated rather than zero. Shared shape with the Threats tab. */
  function scoreCell(key) {
    return function (row) {
      var value = row.entity[key];
      if (!core.isNumber(value)) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
      return core.el('span', { text: String(value) });
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Unapplied — the finding
  // ---------------------------------------------------------------------------------------------

  var UNAPPLIED_NOTE =
    'Controls whose status says they are not in effect: ' + UNAPPLIED_LABELS + '. Four other statuses ' +
    'are deliberately not here. A control marked active is in effect. One marked assumed is present but ' +
    'unverified, which is still present. One marked approved or under review does not say whether it is ' +
    'deployed, so this section does not claim that it is not. A control with no status is not listed ' +
    'either — the model does not say, and a finding has to be something the model states.';

  function unappliedRows(ctx) {
    var rows = [];
    var list = M.collection(ctx.model, 'control');
    for (var i = 0; i < list.length; i++) {
      var control = list[i];
      if (!isUnapplied(control)) continue;
      var threatIds = core.isArray(control.threatIds) ? control.threatIds : [];
      var threats = [];
      for (var t = 0; t < threatIds.length; t++) {
        var threat = M.get(ctx.model, 'threat', threatIds[t]);
        if (threat) threats.push(threat);
      }
      rows.push({
        entity: control,
        threats: threats,
        __search: [control.name, control.status, V.humanise(control.status), control.id].join(' '),
      });
    }
    return rows;
  }

  function unappliedSection(ctx) {
    var rows = unappliedRows(ctx);
    var controls = M.collection(ctx.model, 'control');

    if (!rows.length) {
      return V.section(ctx, 'Unapplied', UNAPPLIED_NOTE, V.emptySection({
        title: controls.length ? 'No control says it is not in effect' : 'No controls',
        body: controls.length
          ? 'None of the ' + core.plural(controls.length, 'control', 'controls') + ' in this model has a ' +
            'status of ' + UNAPPLIED_LABELS + '. This does not mean every control is working — a ' +
            'control can be `approved` and deployed, or `under_review` and in production, and neither ' +
            'of those is a statement this check can read.'
          : 'This model records no controls, so there is nothing whose status could say it is not in effect.',
      }));
    }

    return V.listSection(ctx, 'Unapplied', UNAPPLIED_NOTE, {
      key: 'controls.unapplied',
      type: 'control',
      entityRows: rows,
      plural: 'controls',
      singular: 'control',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      summary: core.el('p', {
        class: 'tmv-intro',
        text:
          (rows.length === 1
            ? 'One control says it is not in effect.'
            : rows.length + ' controls say they are not in effect.')
          + ' Each row carries the status it gave, so the remedy is visible: these are either work still ' +
          'to do or decisions already taken against, and this section does not distinguish the two. The ' +
          'status does.',
      }),
      filters: [
        {
          id: 'status',
          label: 'Status',
          options: V.distinctOptions(rows, function (row) { return row.entity.status; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.status; }); },
        },
        {
          id: 'priority',
          label: 'Priority',
          options: V.distinctOptions(rows, function (row) { return row.entity.priority; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.priority; }); },
        },
      ],
      columns: [
        { key: 'name', label: 'Control', sortable: true, render: function (row) { return V.nameCell(row); } },
        { key: 'status', label: 'Status', sortable: true, render: function (row) {
          var chip = V.statusTag(row.entity.status);
          return chip || core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'priority', label: 'Priority', sortable: true, render: function (row) {
          var chip = V.priorityTag(row.entity.priority);
          return chip || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'threats', label: 'Threats', numeric: true, sortable: true, render: function (row) {
          if (!row.threats.length) return core.el('span', { class: 'tmv-cell-note', text: 'Nothing' });
          return core.el('span', { text: String(row.threats.length) });
        } },
      ],
      empty: { title: 'No unapplied controls' },
      filteredEmpty: {
        title: 'No unapplied controls match these filters',
        body: 'This model has controls that are not in effect; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'control', entity: row.entity, related: controlRelated(c, row) });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------

  var SECTIONS = {
    'all-controls': allControlsSection,
    'by-threat': byThreatSection,
    'mitigation-plans': mitigationPlansSection,
    'coverage-gaps': coverageGapsSection,
    unapplied: unappliedSection,
  };

  function render(ctx) {
    var build = SECTIONS[ctx.section] || SECTIONS['all-controls'];
    return build(ctx);
  }

  /** Both findings, each counting the rows its own section renders. */
  function counts(ctx) {
    return {
      'coverage-gaps': gapRows(ctx).length,
      unapplied: unappliedRows(ctx).length,
    };
  }

  TMV.shell.register({ id: 'controls', title: 'Controls', render: render, counts: counts });
})(globalThis.TMV = globalThis.TMV || {});
