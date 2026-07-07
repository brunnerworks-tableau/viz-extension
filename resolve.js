/**
 * Gauge Chart — Shared Resolution & Validation Logic
 *
 * This file is loaded by BOTH the main gauge page (gauge.js / gauge.html) and the
 * configuration dialog (config.js / config.html). It centralises the logic that
 * turns the user's configuration (which may reference worksheet fields and
 * relative boundaries) into concrete numeric values:
 *
 *   • aggregateColumn()  — aggregate one column of a Tableau summary data table.
 *                          This is the SAME pattern already used for the Value
 *                          Field in gauge.js, reused here for Max and Goal fields.
 *   • resolveMax()       — resolve the gauge scale maximum (fixed or field).
 *   • resolveGoal()      — resolve the shared Goal reference value (field).
 *   • resolveRangeStart()— resolve a single range's start boundary for the
 *                          selected mode (fixed / % of Max / % of Goal / Goal).
 *   • resolveRanges()    — produce concrete {from,to,color,label} ranges where
 *                          each range ends where the next begins and the last
 *                          ends at Max.
 *   • validateResolved() — run pre-apply checks and return warnings.
 *   • migrateRange()     — upgrade a legacy {from,to} range to the new model.
 *
 * Exposed on the global object as `window.GaugeResolve`.
 */
(function (global) {
  'use strict';

  // ─── Column Aggregation ────────────────────────────────────────────
  // Mirrors the Value Field aggregation logic in gauge.js. Supports
  // SUM, AVG, MIN, MAX, FIRST and COUNT. Returns null when there is no
  // usable data so callers can fall back to a default / raise a warning.
  function aggregateColumn(dataTable, colIdx, agg) {
    if (!dataTable || colIdx == null || colIdx < 0) return null;

    if (agg === 'COUNT') {
      return dataTable.data.filter(function (row) {
        var cell = row[colIdx];
        if (!cell) return false;
        var v = cell.value;
        return v !== null && v !== undefined && v !== '' && v !== '%null%';
      }).length;
    }

    var values = dataTable.data
      .map(function (row) { return parseFloat(row[colIdx].value); })
      .filter(function (v) { return !isNaN(v); });
    if (values.length === 0) return null;

    switch (agg) {
      case 'SUM':   return d3sum(values);
      case 'AVG':   return d3mean(values);
      case 'MIN':   return Math.min.apply(null, values);
      case 'MAX':   return Math.max.apply(null, values);
      case 'FIRST': return values[0];
      case 'COUNT': return values.length;
      default:      return d3sum(values);
    }
  }

  // Lightweight sum/mean so this file works even if d3 isn't loaded
  // (e.g. inside the config dialog, which does not include d3).
  function d3sum(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s;
  }
  function d3mean(arr) {
    return arr.length ? d3sum(arr) / arr.length : null;
  }

  function colIndex(dataTable, fieldName) {
    if (!dataTable || !fieldName) return -1;
    return dataTable.columns.findIndex(function (c) { return c.fieldName === fieldName; });
  }

  // Parse a multiplier that may be entered as a plain number ("1.5") or a
  // percentage string ("150%"). Returns a numeric multiplier (1.5) or NaN.
  //   "1.5"  → 1.5
  //   "150%" → 1.5
  //   150 (number, > a threshold is NOT assumed) → 150  (caller decides)
  // To keep things intuitive we treat a trailing "%" as "divide by 100".
  function parseMultiplier(raw) {
    if (raw === null || raw === undefined) return NaN;
    if (typeof raw === 'number') return raw;
    var s = String(raw).trim();
    if (s === '') return NaN;
    if (s.indexOf('%') !== -1) {
      var pct = parseFloat(s.replace('%', '').trim());
      return isFinite(pct) ? pct / 100 : NaN;
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  // ─── Max Resolution ────────────────────────────────────────────────
  // Returns { value, ok, source, ... }. Supported maxMode values:
  //   'fixed'        → uses the fixed maxValue number
  //   'field'        → aggregation of the chosen worksheet field
  //   'relativeGoal' → Goal value × multiplier (scale grows with the Goal)
  function resolveMax(config, dataTable) {
    if (config.maxMode === 'relativeGoal') {
      var mult = parseMultiplier(config.maxMultiplier);
      if (!isFinite(mult)) mult = 1;
      var goalR = resolveGoal(config, dataTable);
      if (!goalR.configured) {
        return { value: parseFloat(config.maxValue) || 100, ok: false, source: 'relativeGoal',
                 multiplier: mult,
                 reason: 'Max is set to "Relative to Goal", but no Goal field is configured. Set a Goal field first.' };
      }
      if (goalR.value === null || !isFinite(goalR.value)) {
        return { value: parseFloat(config.maxValue) || 100, ok: false, source: 'relativeGoal',
                 multiplier: mult,
                 reason: 'Max is "Relative to Goal", but the Goal value could not be resolved.' };
      }
      return { value: goalR.value * mult, ok: true, source: 'relativeGoal',
               multiplier: mult, goal: goalR.value };
    }

    if (config.maxMode === 'field' && config.maxField) {
      var idx = colIndex(dataTable, config.maxField);
      if (idx === -1) {
        return { value: config.maxValue, ok: false, source: 'field',
                 reason: 'Max field "' + config.maxField + '" not found in worksheet.' };
      }
      var v = aggregateColumn(dataTable, idx, config.maxAggregation || 'MAX');
      if (v === null || !isFinite(v)) {
        return { value: config.maxValue, ok: false, source: 'field',
                 reason: 'Max field aggregation produced no usable value.' };
      }
      return { value: v, ok: true, source: 'field' };
    }
    var fixed = parseFloat(config.maxValue);
    return { value: isFinite(fixed) ? fixed : 100, ok: isFinite(fixed), source: 'fixed' };
  }

  // ─── Goal Resolution ───────────────────────────────────────────────
  // Returns { value (number|null), ok, configured }. The Goal is optional.
  // Supported goalMode values:
  //   'none'  → no goal (value null, configured false)
  //   'fixed' → manually entered goalValue number
  //   'field' → aggregation of goalField (default; back-compat when goalMode
  //             is absent but a goalField is present)
  function resolveGoal(config, dataTable) {
    // Back-compat: derive the mode when goalMode is not set.
    var mode = config.goalMode || (config.goalField ? 'field' : 'none');

    if (mode === 'fixed') {
      var fv = parseFloat(config.goalValue);
      if (!isFinite(fv)) {
        return { value: null, ok: false, configured: true,
                 reason: 'Goal is set to a fixed value, but the number entered is not valid.' };
      }
      return { value: fv, ok: true, configured: true };
    }

    if (mode === 'none' || !config.goalField) {
      return { value: null, ok: true, configured: false };
    }

    // Field mode
    var idx = colIndex(dataTable, config.goalField);
    if (idx === -1) {
      return { value: null, ok: false, configured: true,
               reason: 'Goal field "' + config.goalField + '" not found in worksheet.' };
    }
    var v = aggregateColumn(dataTable, idx, config.goalAggregation || 'SUM');
    if (v === null || !isFinite(v)) {
      return { value: null, ok: false, configured: true,
               reason: 'Goal field aggregation produced no usable value.' };
    }
    return { value: v, ok: true, configured: true };
  }

  // ─── Range Start Resolution ────────────────────────────────────────
  // startMode: 'fixed' | 'pctMax' | 'pctGoal' | 'goal'
  //   fixed   → startValue is an absolute number
  //   pctMax  → startValue is a percentage (0–100) of Max
  //   pctGoal → startValue is a percentage (0–100) of Goal
  //   goal    → start equals the Goal value (no startValue used)
  function resolveRangeStart(range, maxValue, goalValue) {
    var mode = range.startMode || 'fixed';
    var sv = parseFloat(range.startValue);
    switch (mode) {
      case 'pctMax':
        return (isFinite(sv) ? sv : 0) / 100 * maxValue;
      case 'pctGoal':
        if (goalValue === null || goalValue === undefined || !isFinite(goalValue)) return NaN;
        return (isFinite(sv) ? sv : 0) / 100 * goalValue;
      case 'goal':
        if (goalValue === null || goalValue === undefined || !isFinite(goalValue)) return NaN;
        return goalValue;
      case 'fixed':
      default:
        return isFinite(sv) ? sv : 0;
    }
  }

  // ─── Full Range Resolution ─────────────────────────────────────────
  // Produces concrete render-ready ranges in the SAME array order the user
  // defined them. Each range's `to` is the next range's `from`; the last
  // range's `to` is Max. `from` of the first range is whatever the user set.
  function resolveRanges(ranges, minValue, maxValue, goalValue) {
    var defs = (ranges || []).map(function (r) {
      return {
        label: r.label || '',
        color: r.color || '#4a90d9',
        startMode: r.startMode || 'fixed',
        startValue: r.startValue,
        from: resolveRangeStart(r, maxValue, goalValue),
      };
    });
    for (var i = 0; i < defs.length; i++) {
      defs[i].to = (i < defs.length - 1) ? defs[i + 1].from : maxValue;
    }
    return defs;
  }

  // ─── Progress Fill Segments ────────────────────────────────────────
  // Given the resolved ranges (each {from,to,color}) and the current value,
  // produce the colored segments that make up a progress fill running from
  // `minValue` up to `currentValue`. Each segment inherits the color of the
  // threshold band it falls within, so a fill that crosses Red→Yellow→Green
  // is emitted as three colored pieces clipped at the current value.
  //
  // Returns an array of { from, to, color, label } in ascending order. When
  // the value is at/below min, an empty array is returned.
  function computeFillSegments(ranges, minValue, currentValue, maxValue) {
    var min = isFinite(minValue) ? minValue : 0;
    var max = isFinite(maxValue) ? maxValue : (min + 1);
    var val = isFinite(currentValue) ? currentValue : min;
    // Clamp the fill end into [min, max].
    var fillEnd = Math.max(min, Math.min(val, max));
    if (fillEnd <= min) return [];

    var segs = [];
    (ranges || []).forEach(function (r) {
      if (!isFinite(r.from) || !isFinite(r.to)) return;
      var segFrom = Math.max(r.from, min);
      var segTo = Math.min(r.to, fillEnd);
      if (segTo > segFrom) {
        segs.push({ from: segFrom, to: segTo, color: r.color || '#4a90d9', label: r.label || '' });
      }
    });

    // Fallback: if no ranges cover the fill (e.g. ranges start above min),
    // emit a single neutral-blue segment so the fill is still visible.
    if (segs.length === 0 && fillEnd > min) {
      segs.push({ from: min, to: fillEnd, color: '#4a90d9', label: '' });
    }
    return segs;
  }

  // ─── Resolved Summary Sentence ─────────────────────────────────────
  // Produces a human-readable one-line summary of the resolved configuration,
  // e.g. "Current Goal is 100. Max is 150% of Goal (150). Ranges: 0–80 (Low),
  // 80–100 (Medium), 100–150 (High)."  Uses the resolved values so it reflects
  // the current worksheet data.
  function buildSummarySentence(config, dataTable) {
    var v = validateResolved(config, dataTable);
    var res = v.resolved;
    var parts = [];

    // Goal
    if (res.goalConfigured) {
      if (res.goal === null || !isFinite(res.goal)) {
        parts.push('Goal is not resolvable yet.');
      } else {
        parts.push('Current Goal is ' + fmt(res.goal) + '.');
      }
    }

    // Max
    var maxDesc = describeMax(config);
    if (maxDesc === 'fixed') {
      parts.push('Max is ' + fmt(res.max) + '.');
    } else {
      parts.push('Max is ' + maxDesc + ' (' + fmt(res.max) + ').');
    }

    // Ranges
    if (res.ranges && res.ranges.length) {
      var rangeTxt = res.ranges.map(function (r, i) {
        var name = r.label || ('R' + (i + 1));
        var from = isFinite(r.from) ? fmt(r.from) : '?';
        var to = isFinite(r.to) ? fmt(r.to) : '?';
        return from + '\u2013' + to + ' (' + name + ')';
      }).join(', ');
      parts.push('Ranges: ' + rangeTxt + '.');
    }

    return parts.join(' ');
  }

  // ─── Validation ────────────────────────────────────────────────────
  // Returns { warnings: [string], resolved: {min,max,goal,goalConfigured,ranges} }
  function validateResolved(config, dataTable) {
    var warnings = [];
    var minValue = parseFloat(config.minValue);
    if (!isFinite(minValue)) minValue = 0;

    var maxR = resolveMax(config, dataTable);
    var goalR = resolveGoal(config, dataTable);

    if (!maxR.ok && maxR.reason) warnings.push(maxR.reason);
    if (!goalR.ok && goalR.reason) warnings.push(goalR.reason);

    var maxValue = maxR.value;
    var goalValue = goalR.value;

    if (!isFinite(maxValue)) {
      warnings.push('Max value is not a valid number.');
    }
    if (isFinite(maxValue) && isFinite(minValue) && maxValue <= minValue) {
      warnings.push('Max value (' + fmt(maxValue) + ') must be greater than Min value (' + fmt(minValue) + ').');
    }

    // Goal vs Max
    if (goalR.configured && goalValue !== null && isFinite(goalValue) && isFinite(maxValue) && goalValue > maxValue) {
      warnings.push('Goal value (' + fmt(goalValue) + ') exceeds Max value (' + fmt(maxValue) + ').');
    }

    var resolved = resolveRanges(config.ranges, minValue, maxValue, goalValue);

    // Per-range checks
    resolved.forEach(function (r, i) {
      var name = r.label || ('Range ' + (i + 1));
      if (!isFinite(r.from)) {
        if ((r.startMode === 'pctGoal' || r.startMode === 'goal') && (goalValue === null || !isFinite(goalValue))) {
          warnings.push('"' + name + '" uses a Goal-based start, but no valid Goal value is available.');
        } else {
          warnings.push('"' + name + '" has an invalid start value.');
        }
      } else if (isFinite(maxValue) && r.from > maxValue) {
        warnings.push('"' + name + '" start (' + fmt(r.from) + ') exceeds Max value (' + fmt(maxValue) + ').');
      } else if (isFinite(minValue) && r.from < minValue) {
        warnings.push('"' + name + '" start (' + fmt(r.from) + ') is below Min value (' + fmt(minValue) + ').');
      }
    });

    // Order / overlap check — starts must be strictly increasing.
    for (var i = 1; i < resolved.length; i++) {
      var prev = resolved[i - 1].from;
      var cur = resolved[i].from;
      if (isFinite(prev) && isFinite(cur)) {
        if (cur < prev) {
          warnings.push('Ranges are out of order: "' +
            (resolved[i].label || ('Range ' + (i + 1))) + '" starts before the previous range.');
        } else if (cur === prev) {
          warnings.push('Ranges overlap: "' +
            (resolved[i].label || ('Range ' + (i + 1))) + '" starts at the same value as the previous range (zero-width band).');
        }
      }
    }

    if (resolved.length === 0) {
      warnings.push('No ranges defined — add at least one range.');
    }

    return {
      warnings: warnings,
      resolved: {
        min: minValue,
        max: maxValue,
        maxSource: maxR.source,
        maxMultiplier: maxR.multiplier,
        goal: goalValue,
        goalConfigured: goalR.configured,
        ranges: resolved,
      },
    };
  }

  function fmt(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    // Compact, readable formatting without depending on d3.
    var n = Number(v);
    if (Math.abs(n) >= 1000 || Number.isInteger(n)) {
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  // ─── Legacy Migration ──────────────────────────────────────────────
  // Old ranges were {from, to, color, label}. Convert to the new model
  // {label, color, startMode:'fixed', startValue:from}. New-model ranges
  // pass through unchanged.
  function migrateRange(r) {
    if (!r) return { label: '', color: '#4a90d9', startMode: 'fixed', startValue: 0 };
    if (r.startMode) {
      return {
        label: r.label || '',
        color: r.color || '#4a90d9',
        startMode: r.startMode,
        startValue: (r.startValue === undefined || r.startValue === null) ? 0 : r.startValue,
      };
    }
    return {
      label: r.label || '',
      color: r.color || '#4a90d9',
      startMode: 'fixed',
      startValue: (r.from === undefined || r.from === null) ? 0 : r.from,
    };
  }

  function migrateRanges(ranges) {
    return (ranges || []).map(migrateRange);
  }

  // ─── Human-readable boundary descriptions (for the Validation Preview) ──
  // Returns a short phrase explaining how a range start resolves, e.g.
  //   "100% of Goal"  /  "50% of Max"  /  "Goal value"  /  "fixed".
  function describeRangeStart(range) {
    var mode = (range && range.startMode) || 'fixed';
    var sv = (range && range.startValue !== undefined && range.startValue !== null) ? range.startValue : '';
    switch (mode) {
      case 'pctMax':  return sv + '% of Max';
      case 'pctGoal': return sv + '% of Goal';
      case 'goal':    return 'Goal value';
      case 'fixed':
      default:        return 'fixed';
    }
  }

  // Returns a short phrase explaining how the Max resolves, e.g.
  //   "150% of Goal"  /  "MAX of [Field]"  /  "fixed".
  function describeMax(config) {
    if (config.maxMode === 'relativeGoal') {
      var mult = parseMultiplier(config.maxMultiplier);
      if (!isFinite(mult)) mult = 1;
      return Math.round(mult * 100) + '% of Goal';
    }
    if (config.maxMode === 'field' && config.maxField) {
      return (config.maxAggregation || 'MAX') + ' of ' + config.maxField;
    }
    return 'fixed';
  }

  global.GaugeResolve = {
    aggregateColumn: aggregateColumn,
    colIndex: colIndex,
    parseMultiplier: parseMultiplier,
    resolveMax: resolveMax,
    resolveGoal: resolveGoal,
    resolveRangeStart: resolveRangeStart,
    resolveRanges: resolveRanges,
    computeFillSegments: computeFillSegments,
    buildSummarySentence: buildSummarySentence,
    validateResolved: validateResolved,
    describeRangeStart: describeRangeStart,
    describeMax: describeMax,
    migrateRange: migrateRange,
    migrateRanges: migrateRanges,
    fmt: fmt,
  };

})(typeof window !== 'undefined' ? window : this);
