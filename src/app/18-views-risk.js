/*
 * 18-views-risk.js — the Risk tab.
 *
 * Sections (`07-ui.md` §3): Risk Matrix · Risk Register · Threat Risk Inputs · CIA Ratings ·
 * Trust Ratings.
 *
 * The requirement this tab exists for is REQ-VIEW-006, and its acceptance criterion is the one that
 * shapes every section here: **each presentation appears only when the model actually holds that
 * data.** The two formats assess risk in two incompatible ways and neither model has both:
 *
 * - TML carries `risks` — a 5×5 pair of enums (likelihood × impact), scored 1–25 and banded into six
 *   levels. That is what the Risk Matrix and the Risk Register present.
 * - OTM carries per-threat numbers on a 0–100 scale — `threat.likelihood`, `threat.impact`, each with
 *   its own free-text comment — and per-asset CIA ratings, per-zone trust ratings and per-control
 *   risk-reduction percentages. That is what Threat Risk Inputs, CIA Ratings and Trust Ratings present.
 *
 * A 0–100 number and a 1–25 score are **not the same quantity**, and this tab never converts between
 * them. There is no honest conversion: OTM publishes no mapping from its scale onto the OWASP banding,
 * so any number this application invented would be its own opinion wearing the model's clothes. So the
 * two live in different sections, each section says which format it is reading, and whichever one the
 * model does not have shows an empty state naming the format rather than a zero.
 *
 * `V.riskOf` is where the one real subtlety lives: `score` and `level` are stored, not computed, so a
 * model may state values that disagree with its own likelihood and impact. Those are flagged and never
 * corrected (`03-data-model.md` §4.12).
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var widgets = TMV.widgets;
  var V = TMV.views;
  var M = TMV.model;

  var LIKELIHOODS = M.VOCAB.likelihood;
  var IMPACTS = M.VOCAB.impact;

  // ---------------------------------------------------------------------------------------------
  // 1. Risk matrix
  // ---------------------------------------------------------------------------------------------

  var MATRIX_NOTE =
    'Every risk in the model placed by its own likelihood and impact, on the 5×5 grid TML scores ' +
    'against. The number in a cell is how many risks sit there, and the cell’s band is what those ' +
    'input positions score as. A risk that states a score but not the two enums it came from cannot be ' +
    'placed and is reported below the grid rather than dropped.';

  /**
   * Risks that state both enums, which is what it takes to have a position on the grid.
   *
   * Deliberately reads the *inputs* rather than the score: the grid's axes are the inputs, and a risk
   * with only a stored score has no position on it even though its level is known.
   */
  function placedRisks(ctx) {
    var out = [];
    var list = M.collection(ctx.model, 'risk');
    for (var i = 0; i < list.length; i++) {
      var risk = list[i];
      var li = LIKELIHOODS.indexOf(risk.likelihood);
      var ii = IMPACTS.indexOf(risk.impact);
      if (li === -1 || ii === -1) continue;
      out.push({ risk: risk, li: li, ii: ii, level: M.riskLevel((li + 1) * (ii + 1)) });
    }
    return out;
  }

  /** Risks the grid cannot place: they exist and say something about themselves, but not the axes. */
  function unplacedRisks(ctx) {
    var placed = placedRisks(ctx);
    var ids = Object.create(null);
    for (var p = 0; p < placed.length; p++) ids[placed[p].risk.id] = true;
    return M.collection(ctx.model, 'risk').filter(function (risk) { return !ids[risk.id]; });
  }

  function riskMatrixSection(ctx) {
    var risks = M.collection(ctx.model, 'risk');
    var placed = placedRisks(ctx);

    // REQ-VIEW-006 AC1. No risks at all, or none with both axes, means there is no matrix to draw.
    if (!placed.length) {
      var threatsWithNumbers = numericThreats(ctx).length;
      return V.section(ctx, 'Risk Matrix', MATRIX_NOTE, V.emptySection({
        title: risks.length ? 'No risk states both its likelihood and its impact' : 'No risks to plot',
        body: risks.length
          ? core.plural(risks.length, 'risk is', 'risks are') + ' recorded, and a matrix needs each ' +
            'one’s likelihood and impact to place it. Risks that state only a score are listed in the ' +
            'Risk Register.'
          : (threatsWithNumbers
              ? 'The 5×5 matrix is TML’s shape and needs root-level risks. This model assesses its ' +
                'risks per threat instead, on OTM’s 0–100 scale, which is a different quantity — see ' +
                'Threat Risk Inputs. The two are not converted into each other here.'
              : 'This model records no risks and no per-threat risk numbers, so there is nothing to ' +
                'plot. Both formats treat risk as optional.'),
      }));
    }

    var root = core.el('div', { class: 'tmv-matrix-wrap' });
    root.appendChild(matrixTable(ctx, placed));

    var unplaced = unplacedRisks(ctx);
    if (unplaced.length) {
      root.appendChild(core.el('div', { class: 'cds--inline-notification cds--inline-notification--info', role: 'status' }, [
        core.el('div', { class: 'cds--inline-notification__details' }, [
          core.el('h3', {
            class: 'cds--inline-notification__title',
            text: core.plural(unplaced.length, 'risk is not on the grid', 'risks are not on the grid'),
          }),
          core.el('div', { class: 'cds--inline-notification__subtitle' }, [
            core.el('p', {
              text:
                'Each of these states a score or a level without the likelihood and impact it came ' +
                'from, so there is no cell to put it in. They are listed in the Risk Register with ' +
                'what they do say.',
            }),
            core.el('ul', { class: 'tmv-dialog__list' }, unplaced.map(function (risk) {
              return core.el('li', { text: M.labelOf(risk) });
            })),
          ]),
        ]),
      ]));
    }

    root.appendChild(matrixLegend());
    return V.section(ctx, 'Risk Matrix', MATRIX_NOTE, root);
  }

  /**
   * The 5×5 grid, as a real table: likelihood is the row, impact the column.
   *
   * A table rather than a grid of divs because the two axes are *headers*, and a screen reader has to
   * be able to say "likely, major: two risks". Each cell carries its count as text and its band as a
   * class, plus a visually-hidden band name, so the colour is never the only thing carrying it
   * (REQ-UI-007 AC4).
   */
  function matrixTable(ctx, placed) {
    var cells = Object.create(null);
    for (var p = 0; p < placed.length; p++) {
      var key = placed[p].li + ':' + placed[p].ii;
      if (!cells[key]) cells[key] = [];
      cells[key].push(placed[p]);
    }

    var head = core.el('tr', {}, [core.el('th', { class: 'tmv-matrix__corner', scope: 'col' }, [
      core.el('span', { class: 'cds--visually-hidden', text: 'Likelihood, by impact' }),
    ])]);
    for (var c = 0; c < IMPACTS.length; c++) {
      head.appendChild(core.el('th', {
        class: 'tmv-matrix__col',
        scope: 'col',
        text: V.humanise(IMPACTS[c]),
      }));
    }

    var body = core.el('tbody');
    // Impact descends down the page and likelihood runs across it, which is the conventional
    // orientation: the top-right corner is the worst place to be in, and it reads that way.
    for (var r = LIKELIHOODS.length - 1; r >= 0; r--) {
      var row = core.el('tr', {}, [core.el('th', {
        class: 'tmv-matrix__row',
        scope: 'row',
        text: V.humanise(LIKELIHOODS[r]),
      })]);
      for (var i = 0; i < IMPACTS.length; i++) {
        row.appendChild(matrixCell(cells[r + ':' + i] || [], r, i));
      }
      body.appendChild(row);
    }

    return core.el('table', { class: 'cds--data-table tmv-matrix' }, [
      core.el('caption', { class: 'cds--visually-hidden', text: 'Risk matrix of likelihood against impact' }),
      core.el('thead', {}, [head]),
      body,
    ]);
  }

  function matrixCell(entries, li, ii) {
    var score = (li + 1) * (ii + 1);
    var level = M.riskLevel(score);
    var label = entries.length
      ? V.humanise(LIKELIHOODS[li]) + ' and ' + V.humanise(IMPACTS[ii]) + ': ' +
        core.plural(entries.length, 'risk', 'risks') + ', band ' + V.humanise(level) + '.'
      : V.humanise(LIKELIHOODS[li]) + ' and ' + V.humanise(IMPACTS[ii]) + ': no risks.';
    var title = entries.length
      ? entries.map(function (entry) { return M.labelOf(entry.risk); }).join(', ')
      : null;

    return core.el('td', {
      class: 'tmv-matrix__cell tmv-band--' + level + (entries.length ? '' : ' tmv-matrix__cell--empty'),
      title: title,
      'aria-label': label,
    }, [
      core.el('span', { class: 'tmv-matrix__count', text: entries.length ? String(entries.length) : '' }),
      core.el('span', { class: 'cds--visually-hidden', text: label }),
      core.el('span', { class: 'tmv-matrix__score', text: String(score), title: 'Score ' + score + ' of 25' }),
    ]);
  }

  /** What the six band colours mean, said in words, because colour is never the only carrier. */
  function matrixLegend() {
    var items = M.RISK_BANDS.map(function (band, index) {
      var from = index === 0 ? 1 : M.RISK_BANDS[index - 1].max + 1;
      return core.el('li', { class: 'tmv-matrix__legend-item' }, [
        core.el('span', { class: 'tmv-matrix__swatch tmv-band--' + band.level, 'aria-hidden': 'true' }),
        core.el('span', { text: V.humanise(band.level) + ' (' + from + '–' + band.max + ')' }),
      ]);
    });
    return core.el('div', { class: 'tmv-matrix__legend' }, [
      core.el('p', {
        class: 'tmv-matrix__legend-title',
        text: 'Banding: the score is the likelihood position times the impact position, from 1 to 25.',
      }),
      core.el('ul', { class: 'tmv-matrix__legend-list' }, items),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Risk register
  // ---------------------------------------------------------------------------------------------

  var REGISTER_NOTE =
    'The risks themselves, one row each, with what they state and what their inputs compute to. A ' +
    'score or level the model states is shown as the model’s own; one that has to be derived from ' +
    'likelihood and impact is marked as derived. Where the two disagree, both are shown and neither is ' +
    'corrected — an imported assessment that does not agree with itself is still someone’s assessment.';

  function riskRows(ctx) {
    var list = M.collection(ctx.model, 'risk');
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var risk = list[i];
      var ids = core.isArray(risk.threatIds) ? risk.threatIds : [];
      var threats = [];
      for (var t = 0; t < ids.length; t++) {
        var threat = M.get(ctx.model, 'threat', ids[t]);
        if (threat) threats.push(threat);
      }
      var plans = M.collection(ctx.model, 'mitigationPlan').filter(function (plan) {
        return plan.riskId === risk.id;
      });
      rows.push({
        entity: risk,
        scored: V.riskOf(risk),
        threats: threats,
        plans: plans,
        __search: [
          risk.name,
          risk.level,
          risk.impactDescription,
          threats.map(function (threat) { return M.labelOf(threat); }).join(' '),
          risk.id,
        ].join(' '),
      });
    }
    return rows;
  }

  function riskRegisterSection(ctx) {
    var rows = riskRows(ctx);

    if (!rows.length) {
      return V.section(ctx, 'Risk Register', REGISTER_NOTE, V.emptySection({
        title: 'No risks',
        body: numericThreats(ctx).length
          ? 'Root-level risks are TML’s shape. This model assesses risk per threat instead, on OTM’s ' +
            '0–100 scale, and those inputs are listed in Threat Risk Inputs. This register stays empty ' +
            'rather than restating them on a scale they do not use.'
          : 'This model records no risks. Both formats treat risk as optional, and a model can be ' +
            'complete without any.',
      }));
    }

    return V.listSection(ctx, 'Risk Register', REGISTER_NOTE, {
      key: 'risk.register',
      type: 'risk',
      entityRows: rows,
      plural: 'risks',
      singular: 'risk',
      pageSizes: [10, 25, 50],
      addLabel: 'Add risk',
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'level',
          label: 'Level',
          options: V.distinctOptions(rows, function (row) { return row.scored.level; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.scored.level; }); },
        },
        {
          id: 'likelihood',
          label: 'Likelihood',
          options: V.distinctOptions(rows, function (row) { return row.entity.likelihood; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.likelihood; }); },
        },
        {
          id: 'impact',
          label: 'Impact',
          options: V.distinctOptions(rows, function (row) { return row.entity.impact; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.impact; }); },
        },
        {
          id: 'mismatch',
          label: 'Stated score',
          options: [
            { value: 'yes', label: 'Disagrees with its own inputs' },
            { value: 'no', label: 'Agrees, or no score stated' },
          ],
          test: function (row, value) { return value === 'yes' ? row.scored.mismatch : !row.scored.mismatch; },
        },
      ],
      columns: [
        { key: 'name', label: 'Risk', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'risk') });
        } },
        { key: 'likelihood', label: 'Likelihood', sortable: true, render: function (row) {
          return row.entity.likelihood
            ? core.el('span', { text: V.vocabLabel('likelihood', row.entity.likelihood) })
            : core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'impact', label: 'Impact', sortable: true, render: function (row) {
          return row.entity.impact
            ? core.el('span', { text: V.vocabLabel('impact', row.entity.impact) })
            : core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        // Score and level are computed on the row (`row.scored`) rather than stored on the entity —
        // a risk may state neither, either, or both — so each column says where its value comes
        // from. The level sorts by the vocabulary's own order, not alphabetically.
        { key: 'score', label: 'Score', numeric: true, sortable: true,
          sortValue: function (row) { return core.isNumber(row.scored.score) ? row.scored.score : null; },
          render: function (row) {
          return scoreCell(row.scored);
        } },
        { key: 'level', label: 'Level', sortable: true,
          sortValue: function (row) { return V.vocabRank('riskLevel', row.scored.level); },
          render: function (row) {
          var chip = V.riskTag(row.scored.level);
          return chip || core.el('span', { class: 'tmv-muted', text: 'Not rated' });
        } },
        { key: 'threats', label: 'Threats', numeric: true, sortable: true, render: function (row) {
          if (!row.threats.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: String(row.threats.length) });
        } },
        { key: 'plans', label: 'Mitigation', numeric: true, sortable: true, render: function (row) {
          if (!row.plans.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: core.plural(row.plans.length, 'plan', 'plans') });
        } },
      ],
      empty: { title: 'No risks' },
      filteredEmpty: {
        title: 'No risks match these filters',
        body: 'This model has risks; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'risk', entity: row.entity, related: riskRelated(c, row) });
      },
    });
  }

  /**
   * The score cell, which has to say where its number came from.
   *
   * Three states, not two: stated and agreeing, stated and disagreeing (both shown, neither
   * corrected), or not stated at all and therefore derived here.
   */
  function scoreCell(scored) {
    if (!core.isNumber(scored.score)) return core.el('span', { class: 'tmv-muted', text: 'Not scored' });
    if (scored.mismatch) {
      return core.el('span', { class: 'tmv-tags' }, [
        core.el('span', { text: String(scored.score) }),
        V.tag({
          text: 'inputs give ' + String(scored.computedScore),
          type: 'red',
          title: 'The model states a score of ' + scored.score + ' and its own likelihood and impact work out to ' +
            scored.computedScore + '. Both are kept: this application does not correct an imported assessment.',
        }),
      ]);
    }
    if (scored.derived) {
      return core.el('span', { class: 'tmv-tags' }, [
        core.el('span', { text: String(scored.score) }),
        core.el('span', {
          class: 'tmv-cell-note',
          text: 'derived',
          title: 'This model states no score, so it is computed here from the risk’s likelihood and impact.',
        }),
      ]);
    }
    return core.el('span', { text: String(scored.score) });
  }

  function riskRelated(ctx, row) {
    var blocks = [];
    if (row.threats.length) {
      blocks.push(V.relatedBlock(
        core.plural(row.threats.length, 'threat it names', 'threats it names'),
        core.el('ul', { class: 'tmv-dialog__list' }, row.threats.map(function (threat) {
          return core.el('li', { text: M.labelOf(threat) });
        }))
      ));
    } else {
      blocks.push(V.relatedBlock('Threats it names', core.el('p', {
        text: 'None. A risk that names no threat is an assessment of something this model has not described.',
      })));
    }
    if (row.plans.length) {
      blocks.push(V.relatedBlock(
        core.plural(row.plans.length, 'mitigation plan addresses it', 'mitigation plans address it'),
        core.el('ul', { class: 'tmv-dialog__list' }, row.plans.map(function (plan) {
          var controls = core.isArray(plan.controlIds) ? plan.controlIds.length : 0;
          return core.el('li', { text: M.labelOf(plan) + ' — ' + core.plural(controls, 'control', 'controls') });
        }))
      ));
    }
    if (row.scored.mismatch) {
      blocks.push(V.relatedBlock('The score and the inputs disagree', core.el('p', {
        text:
          'The model states a score of ' + row.scored.score + ' and a level of ' +
          (row.scored.level ? V.humanise(row.scored.level) : 'nothing') + ', while its own likelihood and ' +
          'impact work out to ' + row.scored.computedScore + ' (' + V.humanise(row.scored.computedLevel) +
          '). Both are shown as they are. This application recomputes a mismatch for display and never ' +
          'overwrites it, because the stored values are the assessment and a disagreement may be ' +
          'deliberate.',
      })));
    }
    return core.el('div', {}, blocks);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Threat risk inputs (OTM's 0–100 numbers)
  // ---------------------------------------------------------------------------------------------

  var INPUTS_NOTE =
    'OTM assesses a threat on its own, with a likelihood and an impact on a 0–100 scale and a comment ' +
    'under each. Those are “threat risk inputs”: they are the numbers a risk decision is made from, ' +
    'and neither format says how to combine them. They are kept on their own scale here and are never ' +
    'converted into the 5×5 banding above — no published mapping exists, so any number this ' +
    'application produced would be its own invention.';

  /** Threats that state a numeric likelihood or impact, which is what makes them OTM risk inputs. */
  function numericThreats(ctx) {
    return M.collection(ctx.model, 'threat').filter(function (threat) {
      return core.isNumber(threat.likelihood) || core.isNumber(threat.impact);
    });
  }

  function inputRows(ctx) {
    var rows = [];
    var list = numericThreats(ctx);
    for (var i = 0; i < list.length; i++) {
      var threat = list[i];
      var controls = M.controlsForThreat(ctx.model, threat.id);
      // The highest stated reduction, not a sum: two controls each claiming 60% do not add to 120%,
      // and neither format says they compose at all. The count beside it says how many were looked at.
      var best = null;
      for (var c = 0; c < controls.length; c++) {
        if (!core.isNumber(controls[c].riskReduction)) continue;
        if (best === null || controls[c].riskReduction > best) best = controls[c].riskReduction;
      }
      rows.push({
        entity: threat,
        controls: controls,
        best: best,
        applications: M.applicationsForThreat(ctx.model, threat.id),
        persona: V.labelFrom(ctx.model, threat.personaId),
        __search: [
          threat.name,
          threat.likelihoodComment,
          threat.impactComment,
          V.labelFrom(ctx.model, threat.personaId),
          threat.id,
        ].join(' '),
      });
    }
    return rows;
  }

  function threatRiskInputsSection(ctx) {
    var rows = inputRows(ctx);
    var threats = M.collection(ctx.model, 'threat');

    if (!rows.length) {
      return V.section(ctx, 'Threat Risk Inputs', INPUTS_NOTE, V.emptySection({
        title: threats.length ? 'No threat states a risk number' : 'No threats',
        body: threats.length
          ? 'Per-threat likelihood and impact are OTM’s shape. This model records ' +
            core.plural(threats.length, 'threat', 'threats') + ' and no numeric rating on any of them, so ' +
            'there are no inputs to show. That is a complete model with an unassessed threat list, not a ' +
            'defective one.'
          : 'This model records no threats, so there is nothing to assess a risk from.',
      }));
    }

    return V.listSection(ctx, 'Threat Risk Inputs', INPUTS_NOTE, {
      key: 'risk.inputs',
      type: 'threat',
      entityRows: rows,
      plural: 'threats',
      singular: 'threat',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      filters: [
        {
          id: 'persona',
          label: 'Persona',
          options: V.distinctOptions(rows, function (row) { return row.persona; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.persona; }); },
        },
        {
          id: 'both',
          label: 'Numbers',
          options: [
            { value: 'yes', label: 'States both likelihood and impact' },
            { value: 'no', label: 'States only one of the two' },
          ],
          test: function (row, value) {
            var both = core.isNumber(row.entity.likelihood) && core.isNumber(row.entity.impact);
            return value === 'yes' ? both : !both;
          },
        },
        {
          id: 'comment',
          label: 'Comment',
          options: [
            { value: 'yes', label: 'Has a comment on at least one number' },
            { value: 'no', label: 'Has no comments' },
          ],
          test: function (row, value) {
            var has = core.isString(row.entity.likelihoodComment) || core.isString(row.entity.impactComment);
            return value === 'yes' ? has : !has;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Threat', sortable: true, render: function (row) { return V.nameCell(row); } },
        { key: 'persona', label: 'Persona', sortable: true, render: function (row) {
          return row.persona || core.el('span', { class: 'tmv-muted', text: '—' });
        } },
        { key: 'likelihood', label: 'Likelihood', numeric: true, sortable: true, render: function (row) {
          return numberCell(row.entity.likelihood, row.entity.likelihoodComment);
        } },
        { key: 'impact', label: 'Impact', numeric: true, sortable: true, render: function (row) {
          return numberCell(row.entity.impact, row.entity.impactComment);
        } },
        { key: 'applications', label: 'Applied to', numeric: true, sortable: true, render: function (row) {
          if (!row.applications.length) return core.el('span', { class: 'tmv-cell-note', text: 'Nothing' });
          return core.el('span', { text: core.plural(row.applications.length, 'target', 'targets') });
        } },
        { key: 'reduction', label: 'Highest reduction', numeric: true, sortable: true, render: function (row) {
          if (row.best === null) return core.el('span', { class: 'tmv-muted', text: 'Not estimated' });
          return core.el('span', {
            text: String(row.best) + '%',
            title: 'The highest risk reduction stated by any of the ' +
              core.plural(row.controls.length, 'control', 'controls') + ' covering this threat. They are not added together.',
          });
        } },
      ],
      empty: { title: 'No threat risk inputs' },
      filteredEmpty: {
        title: 'No threats match these filters',
        body: 'This model has rated threats; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'threat', entity: row.entity, related: inputsRelated(c, row) });
      },
    });
  }

  /** A 0–100 number, with the comment under it as the cell's title rather than a second row. */
  function numberCell(value, comment) {
    if (!core.isNumber(value)) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
    if (!core.isString(comment) || comment === '') return core.el('span', { text: String(value) });
    return core.el('span', { class: 'tmv-tags' }, [
      core.el('span', { text: String(value) }),
      core.el('span', { class: 'tmv-cell-note', text: 'commented', title: comment }),
    ]);
  }

  function inputsRelated(ctx, row) {
    var blocks = [];
    var comments = [];
    if (core.isString(row.entity.likelihoodComment) && row.entity.likelihoodComment !== '') {
      comments.push(core.el('li', { text: 'Likelihood: ' + row.entity.likelihoodComment }));
    }
    if (core.isString(row.entity.impactComment) && row.entity.impactComment !== '') {
      comments.push(core.el('li', { text: 'Impact: ' + row.entity.impactComment }));
    }
    if (comments.length) {
      blocks.push(V.relatedBlock('Why these numbers', core.el('ul', { class: 'tmv-dialog__list' }, comments)));
    }
    if (row.controls.length) {
      blocks.push(V.relatedBlock(
        core.plural(row.controls.length, 'control covering it', 'controls covering it'),
        core.el('ul', { class: 'tmv-dialog__list' }, row.controls.map(function (control) {
          var reduction = core.isNumber(control.riskReduction) ? String(control.riskReduction) + '%' : 'no reduction stated';
          return core.el('li', { text: M.labelOf(control) + ' — ' + reduction });
        }))
      ));
    }
    return blocks.length ? core.el('div', {}, blocks) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // 4. CIA ratings — the finding
  // ---------------------------------------------------------------------------------------------

  var CIA_NOTE =
    'Every asset and its confidentiality, integrity and availability ratings. These are OTM-only ' +
    'numbers on a 0–100 scale, and they belong to the asset rather than to the data set it holds — ' +
    'which is why a model can describe its data carefully and still leave the asset at the centre of ' +
    'it unrated. The count in the side navigation is the assets missing at least one of the three, ' +
    'because a gap is the thing to act on; an unstated rating is not a low one, and every asset is ' +
    'listed here whether it is complete or not.';

  /** Every asset, with which of the three ratings it is missing. */
  function ciaRows(ctx) {
    var out = [];
    var list = M.collection(ctx.model, 'asset');
    for (var i = 0; i < list.length; i++) {
      var asset = list[i];
      var missing = [];
      if (!core.isNumber(asset.confidentiality)) missing.push('Confidentiality');
      if (!core.isNumber(asset.integrity)) missing.push('Integrity');
      if (!core.isNumber(asset.availability)) missing.push('Availability');
      out.push({
        entity: asset,
        missing: missing,
        rated: 3 - missing.length,
        __search: [asset.name, asset.riskComment, missing.join(' '), asset.id].join(' '),
      });
    }
    return out;
  }

  function ciaSection(ctx) {
    var rows = ciaRows(ctx);
    var gaps = rows.filter(function (row) { return row.missing.length > 0; });

    // REQ-VIEW-006 AC1: the whole presentation is OTM's, so with no assets there is nothing to say.
    // An asset nobody rated is shown, though — that is a rated gap, not absent data, and it is what
    // the side-nav count is counting.
    if (!rows.length) {
      return V.section(ctx, 'CIA Ratings', CIA_NOTE, V.emptySection({
        title: 'No assets',
        body:
          'Assets and their CIA ratings are OTM’s shape. This model has no assets, so it makes no ' +
          'confidentiality, integrity or availability claims at all — which is a complete answer, not ' +
          'a missing one.',
      }));
    }

    return V.listSection(ctx, 'CIA Ratings', CIA_NOTE, {
      key: 'risk.cia',
      type: 'asset',
      entityRows: rows,
      plural: 'assets',
      singular: 'asset',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      summary: core.el('p', {
        class: 'tmv-intro',
        text: gaps.length
          ? core.plural(gaps.length, 'asset is', 'assets are') + ' missing at least one of the three ' +
            'ratings. A zero is a rating and a missing value is not: the table shows “Not rated” for ' +
            'the second, so an asset deliberately scored as unimportant is never confused with one ' +
            'nobody has looked at.'
          : 'All ' + core.plural(rows.length, 'asset', 'assets') + ' in this model state their ' +
            'confidentiality, integrity and availability. That is the fields being filled in, not a ' +
            'statement that the ratings are right.',
      }),
      filters: [
        {
          id: 'field',
          label: 'Missing',
          options: V.listOptions(rows, function (row) { return row.missing; }),
          test: function (row, value) { return V.matchList(row, value, function (r) { return r.missing; }); },
        },
        {
          id: 'rated',
          label: 'Completeness',
          options: [
            { value: 'complete', label: 'All three stated' },
            { value: 'partial', label: 'One or two missing' },
            { value: 'none', label: 'None of the three stated' },
          ],
          test: function (row, value) {
            if (value === 'complete') return row.rated === 3;
            if (value === 'none') return row.rated === 0;
            return row.rated === 1 || row.rated === 2;
          },
        },
      ],
      columns: [
        { key: 'name', label: 'Asset', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'asset') });
        } },
        { key: 'confidentiality', label: 'Confidentiality', numeric: true, sortable: true, render: ratingCell('confidentiality') },
        { key: 'integrity', label: 'Integrity', numeric: true, sortable: true, render: ratingCell('integrity') },
        { key: 'availability', label: 'Availability', numeric: true, sortable: true, render: ratingCell('availability') },
        { key: 'missing', label: 'Missing', sortable: true, render: function (row) {
          if (!row.missing.length) {
            return core.el('span', { class: 'tmv-cell-note', text: 'None', title: 'All three ratings are stated.' });
          }
          return V.tagList(row.missing, 'red');
        } },
      ],
      empty: { title: 'No assets' },
      filteredEmpty: {
        title: 'No assets match these filters',
        body: 'This model has assets; none of them match what is selected.',
      },
      detail: function (c, row) {
        return V.detailView(c, { type: 'asset', entity: row.entity, related: ciaRelated(row) });
      },
    });
  }

  /** A CIA rating, or "Not rated" — never a zero standing in for one. */
  function ratingCell(key) {
    return function (row) {
      var value = row.entity[key];
      if (!core.isNumber(value)) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
      return core.el('span', { text: String(value) });
    };
  }

  function ciaRelated(row) {
    if (!row.missing.length) {
      return V.relatedBlock('All three ratings are stated', core.el('p', {
        text:
          'This asset states its confidentiality, integrity and availability. Nothing is missing here; ' +
          'whether the numbers are the right ones is a judgement this application cannot make.',
      }));
    }
    var states =
      row.rated === 0 ? 'states none of the three ratings'
      : row.rated === 1 ? 'states one of the three'
      : 'states ' + row.rated + ' of the three';
    return V.relatedBlock('What is missing', core.el('p', {
      text:
        'This asset ' + states + '. Missing: ' + row.missing.join(', ') + '. A missing rating is not a ' +
        'low one, and nothing here fills it in — the rating is an assessment only the model’s ' +
        'author can make.',
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Trust ratings — the finding
  // ---------------------------------------------------------------------------------------------

  var TRUST_NOTE =
    'The trust zones and the rating the model gives each one. These are OTM-only numbers on a 0–100 ' +
    'scale, and they are the coarser half of a pair: a zone’s type says what kind of place it is ' +
    '(internet, DMZ, private) and the rating says how much it is trusted. The count in the side ' +
    'navigation is the zones with no rating stated, which is the condition for a boundary between two ' +
    'zones to have nothing to compare.';

  function zoneRows(ctx) {
    var list = M.collection(ctx.model, 'trustZone');
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var zone = list[i];
      var rated = core.isNumber(zone.trustRating);
      rows.push({
        entity: zone,
        rated: rated,
        // The boundaries this zone is one end of, so the row says what the missing rating would have
        // been compared across.
        boundaries: M.collection(ctx.model, 'trustBoundary').filter(function (boundary) {
          return boundary.zoneAId === zone.id || boundary.zoneBId === zone.id;
        }),
        components: M.collection(ctx.model, 'component').filter(function (c) { return c.trustZoneId === zone.id; }),
        __search: [zone.name, zone.type, zone.id].join(' '),
      });
    }
    return rows;
  }

  function trustRatingsSection(ctx) {
    var rows = zoneRows(ctx);
    var unrated = rows.filter(function (row) { return !row.rated; });

    if (!rows.length) {
      return V.section(ctx, 'Trust Ratings', TRUST_NOTE, V.emptySection({
        title: 'No trust zones',
        body:
          'Trust zones and their ratings are part of OTM’s architecture. This model has no zones, so ' +
          'it makes no trust claims to show.',
      }));
    }

    return V.listSection(ctx, 'Trust Ratings', TRUST_NOTE, {
      key: 'risk.trust',
      type: 'trustZone',
      entityRows: rows,
      plural: 'trust zones',
      singular: 'trust zone',
      pageSizes: [10, 25, 50],
      searchText: function (row) { return row.__search; },
      summary: core.el('p', {
        class: 'tmv-intro',
        text: unrated.length
          ? core.plural(unrated.length, 'zone states no rating', 'zones state no rating') + '. A zone ' +
            'without one can still have a type, and a boundary between two zones can still state its ' +
            'controls — what is missing is the number a comparison would use.'
          : 'Every zone in this model states a rating. That is the field being filled in, not a claim ' +
            'that the ratings are right.',
      }),
      filters: [
        {
          id: 'rated',
          label: 'Rating',
          options: [
            { value: 'yes', label: 'Rated' },
            { value: 'no', label: 'Not rated' },
          ],
          test: function (row, value) { return value === 'yes' ? row.rated : !row.rated; },
        },
        {
          id: 'type',
          label: 'Type',
          options: V.distinctOptions(rows, function (row) { return row.entity.type; }),
          test: function (row, value) { return V.matchDistinct(row, value, function (r) { return r.entity.type; }); },
        },
      ],
      columns: [
        { key: 'name', label: 'Trust zone', sortable: true, render: function (row) {
          return V.nameCell(row, { warning: V.warnUnresolved(ctx, 'trustZone') });
        } },
        { key: 'type', label: 'Type', sortable: true, render: function (row) {
          // `type` is a free string upstream (`03-data-model.md` §4.1), so it is shown as the model
          // wrote it rather than mapped onto a vocabulary this application does not have.
          return core.isString(row.entity.type) && row.entity.type !== ''
            ? core.el('span', { text: V.humanise(row.entity.type) })
            : core.el('span', { class: 'tmv-muted', text: 'Not stated' });
        } },
        { key: 'rating', label: 'Trust rating', numeric: true, sortable: true,
          sortValue: function (row) { return row.rated ? row.entity.trustRating : null; },
          render: function (row) {
          if (!row.rated) return core.el('span', { class: 'tmv-muted', text: 'Not rated' });
          return core.el('span', { text: String(row.entity.trustRating) + ' / 100' });
        } },
        { key: 'components', label: 'Components', numeric: true, sortable: true, render: function (row) {
          if (!row.components.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: String(row.components.length) });
        } },
        { key: 'boundaries', label: 'Boundaries', numeric: true, sortable: true, render: function (row) {
          if (!row.boundaries.length) return core.el('span', { class: 'tmv-cell-note', text: 'None' });
          return core.el('span', { text: core.plural(row.boundaries.length, 'boundary', 'boundaries') });
        } },
      ],
      empty: { title: 'No trust zones' },
      filteredEmpty: {
        title: 'No trust zones match these filters',
        body: 'This model has trust zones; none of them match what is selected.',
      },
      detail: function (c, row) {
        var blocks = [];
        if (!row.rated) {
          blocks.push(V.relatedBlock('What the missing rating costs', core.el('p', {
            text:
              'This zone states no trust rating, so a boundary it is one end of has nothing to compare ' +
              'against. A rating of 0 would mean “not trusted at all” and is a different ' +
              'statement, which is why the field is left showing nothing rather than defaulting.',
          })));
        }
        if (row.boundaries.length) {
          blocks.push(V.relatedBlock(
            core.plural(row.boundaries.length, 'boundary it is one end of', 'boundaries it is one end of'),
            core.el('ul', { class: 'tmv-dialog__list' }, row.boundaries.map(function (boundary) {
              var other = boundary.zoneAId === row.entity.id ? boundary.zoneBId : boundary.zoneAId;
              return core.el('li', { text: M.labelOf(boundary) + ' — the other side is ' + V.refText(ctx, other) });
            }))
          ));
        }
        var related = blocks.length ? core.el('div', {}, blocks) : null;
        return V.detailView(c, { type: 'trustZone', entity: row.entity, related: related });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------

  var SECTIONS = {
    'risk-matrix': riskMatrixSection,
    'risk-register': riskRegisterSection,
    'threat-risk-inputs': threatRiskInputsSection,
    'cia-ratings': ciaSection,
    'trust-ratings': trustRatingsSection,
  };

  function render(ctx) {
    var build = SECTIONS[ctx.section] || SECTIONS['risk-matrix'];
    return build(ctx);
  }

  /**
   * Both findings count the rows they report. `cia-ratings` shows every asset and marks the gaps, so
   * its count is the marked rows and the summary above the table says the same number in words — the
   * badge and the screen cannot disagree.
   */
  function counts(ctx) {
    var unrated = 0;
    var rows = ciaRows(ctx);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].missing.length) unrated++;
    }
    var zones = M.collection(ctx.model, 'trustZone');
    var unratedZones = 0;
    for (var z = 0; z < zones.length; z++) {
      if (!core.isNumber(zones[z].trustRating)) unratedZones++;
    }
    return { 'cia-ratings': unrated, 'trust-ratings': unratedZones };
  }

  TMV.shell.register({ id: 'risk', title: 'Risk', render: render, counts: counts });
})(globalThis.TMV = globalThis.TMV || {});
