/**
 * Gauge Chart — Tableau Dashboard Extension (Main Page)
 *
 * Supports three gauge types:
 *   - semi:          Semi-Circular (180°) — classic half-circle gauge
 *   - three-quarter: Three-Quarter Circle (270°) — gap at bottom
 *   - linear:        Linear Horizontal — bar with vertical marker
 *
 * Uses D3.js for rendering and Tableau Extensions API for data integration.
 * Configuration is handled via a SEPARATE popup dialog (config.html) opened
 * through tableau.extensions.ui.displayDialogAsync().
 *
 * ANGLE CONVENTION (D3 arc):
 *   0 = 12 o'clock (top), angles increase clockwise.
 *   Internally D3 uses x = sin(a), y = -cos(a) to place arc points.
 *   Needle SVG rotate() also treats 0° as up and positive as CW.
 *   Tick/label positions must use: x = r*sin(a), y = -r*cos(a)
 */

(function () {
  'use strict';

  // ─── Default Settings ──────────────────────────────────────────────
  const DEFAULT_CONFIG = {
    worksheet: '',
    measure: '',
    aggregation: 'SUM',
    minValue: 0,
    maxValue: 100,
    // Max value source: 'fixed' uses maxValue, 'field' computes from maxField + maxAggregation,
    // 'relativeGoal' computes Goal × maxMultiplier.
    maxMode: 'fixed',
    maxField: '',
    maxAggregation: 'MAX',
    maxMultiplier: 1.5,
    // Shared Goal reference (optional). goalMode: 'none' | 'fixed' | 'field'
    //   'fixed' uses goalValue; 'field' is resolved like the Value Field.
    goalMode: 'field',
    goalValue: 0,
    goalField: '',
    goalAggregation: 'SUM',
    title: 'Gauge',
    subtitle: '',
    // ── Title / Subtitle text formatting (ALL OPTIONAL) ──
    //   Every field defaults to '' meaning "inherit the original CSS default"
    //   (title 18px / weight 600 / #333333 / centered; subtitle 12px / normal /
    //   #777777 / centered). Existing dashboards have none of these keys, so
    //   they render byte-for-byte identical to the pre-enhancement version.
    titleFontFamily: '',
    titleFontSize: '',      // px (number); '' = CSS default (18)
    titleFontColor: '',
    titleFontWeight: '',    // '300'|'400'|'500'|'600'|'700'|'800'|'normal'|'bold'
    titleAlign: '',         // 'left' | 'center' | 'right'
    subtitleFontFamily: '',
    subtitleFontSize: '',   // px (number); '' = CSS default (12)
    subtitleFontColor: '',
    subtitleFontWeight: '',
    subtitleAlign: '',
    // Ranges use the v2 model: { label, color, startMode, startValue }
    //   startMode: 'fixed' | 'pctMax' | 'pctGoal' | 'goal'
    ranges: [
      { label: 'Low',    color: '#dc3545', startMode: 'fixed', startValue: 0 },
      { label: 'Medium', color: '#ffc107', startMode: 'fixed', startValue: 33 },
      { label: 'High',   color: '#28a745', startMode: 'fixed', startValue: 66 },
    ],
    needleColor: '#a3a3a3',
    backgroundColor: 'transparent',
    valueFontSize: 28,
    valueColor: '#333333',
    arcThickness: 30,
    // Manual gauge size multiplier (50–100). 100 = full proportional auto-fit
    // (fills the tile like the original). Lower values shrink the arc so users
    // can fine-tune. Legacy configs without this key default to 100 (no change).
    gaugeScale: 100,
    valueFormat: 'number',
    currencySymbol: '$',
    showLabels: true,
    showTicks: true,
    showRangeLabels: false,
    enableFilter: true,
    filterField: '',
    enableTooltip: true,
    animate: true,
    // Gauge type: 'semi' | 'three-quarter' | 'linear'
    gaugeType: 'semi',
    // Smooth gradient transitions between color bands
    useGradient: false,
    // Percentage mode: 'off' | 'auto' | 'pct0to1' | 'pct0to100'
    percentageMode: 'off',
    percentDecimals: 0,
    // Display mode: 'needle' | 'fill' | 'needle+fill'
    //   'needle'      — classic needle/marker (legacy default)
    //   'fill'        — progress fill Min→Current, inheriting band colors
    //   'needle+fill' — both (recommended for new configs)
    displayMode: 'needle+fill',
    // Neutral background track shown behind the progress fill.
    trackColor: '#e9ecef',
  };

  const R = window.GaugeResolve; // shared resolution/validation helpers

  let config = cloneConfig(DEFAULT_CONFIG);
  let currentValue = 0;
  let worksheetObj = null;
  let eventUnregisterHandlers = [];
  let resizeObserver = null;
  let lastContainerSize = { width: 0, height: 0 };

  // Resolved (render-ready) state, recomputed on every data refresh.
  //   goalValue       — the resolved shared Goal value (number|null)
  //   resolvedRanges  — concrete [{from,to,color,label}] ranges in user order
  let goalValue = null;
  let resolvedRanges = [];

  /**
   * Resolve the Goal value and the concrete render-ready ranges from the
   * current config and a Tableau summary data table. Uses the SAME aggregation
   * pattern as the Value Field (see aggregateColumn). Falls back gracefully
   * (goal = null, ranges resolved against Max) when data is unavailable.
   */
  function resolveDerivedState(dataTable) {
    // Goal
    if (R && dataTable) {
      const g = R.resolveGoal(config, dataTable);
      goalValue = g.ok ? g.value : null;
      if (!g.ok && g.reason) console.warn('[Gauge] ' + g.reason);
    } else {
      goalValue = null;
    }
    // Ranges (each ends where the next starts; last ends at Max)
    if (R) {
      resolvedRanges = R.resolveRanges(config.ranges, config.minValue, config.maxValue, goalValue)
        // Drop ranges whose start could not be resolved (e.g. goal-based with no goal).
        .filter(r => isFinite(r.from));
      // Guard: ensure `to` never NaN.
      resolvedRanges.forEach(r => { if (!isFinite(r.to)) r.to = config.maxValue; });
    } else {
      resolvedRanges = (config.ranges || []).map(r => ({ ...r }));
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  function cloneConfig(c) {
    return { ...c, ranges: (c.ranges || []).map(r => ({ ...r })) };
  }

  /**
   * Aggregate a single column of a Tableau summary data table.
   * Supports SUM, AVG, MIN, MAX, FIRST and COUNT. Returns null when there is
   * no usable data (so callers can fall back to a default).
   *
   * COUNT counts non-empty rows in the column (works for dimensions too);
   * all other aggregations operate on the numeric values only.
   */
  function aggregateColumn(dataTable, colIdx, agg) {
    if (colIdx < 0) return null;

    if (agg === 'COUNT') {
      return dataTable.data.filter(row => {
        const cell = row[colIdx];
        if (!cell) return false;
        const v = cell.value;
        return v !== null && v !== undefined && v !== '' && v !== '%null%';
      }).length;
    }

    const values = dataTable.data
      .map(row => parseFloat(row[colIdx].value))
      .filter(v => !isNaN(v));
    if (values.length === 0) return null;

    switch (agg) {
      case 'SUM':   return d3.sum(values);
      case 'AVG':   return d3.mean(values);
      case 'MIN':   return d3.min(values);
      case 'MAX':   return d3.max(values);
      case 'FIRST': return values[0];
      default:      return d3.sum(values);
    }
  }

  function getEffectivePercentMode() {
    const mode = config.percentageMode || 'off';
    if (mode !== 'auto') return mode;
    if (config.maxValue <= 1 && config.minValue >= 0) return 'pct0to1';
    if (config.maxValue <= 100 && config.minValue >= 0 && config.maxValue > 1) return 'pct0to100';
    return 'off';
  }

  function getDisplayValue(rawVal) {
    const mode = getEffectivePercentMode();
    if (mode === 'pct0to1') return rawVal * 100;
    return rawVal;
  }

  function formatValue(val) {
    const v = Number(val);
    if (isNaN(v)) return '—';

    const pctMode = getEffectivePercentMode();
    const isPctActive = pctMode === 'pct0to1' || pctMode === 'pct0to100';

    if (isPctActive) {
      const displayVal = (pctMode === 'pct0to1') ? v * 100 : v;
      const decimals = config.percentDecimals || 0;
      return d3.format(`,.${decimals}f`)(displayVal) + '%';
    }

    switch (config.valueFormat) {
      case 'decimal1': return d3.format(',.1f')(v);
      case 'decimal2': return d3.format(',.2f')(v);
      case 'percent':  return d3.format(',.0f')(v) + '%';
      case 'currency': return config.currencySymbol + d3.format(',.0f')(v);
      case 'compact':  return d3.format('.3~s')(v);
      default:         return d3.format(',.0f')(v);
    }
  }

  /**
   * Auto-scale the center value font so the number stays proportionate to the
   * arc on small tiles. The user's configured Value Font Size acts as the UPPER
   * bound (manual override): on normal/large gauges the font stays exactly at
   * the configured size; only when the arc gets small does the font shrink with
   * it. Floored at 10px for legibility. Non-breaking for existing dashboards.
   */
  function computeValueFontSize(radius) {
    const configured = config.valueFontSize || 28;
    const auto = radius * 0.32;
    return Math.max(10, Math.min(configured, auto));
  }

  /** Compute value ratio clamped to [0, 1] */
  function valueRatio(val) {
    return Math.max(0, Math.min(1, (val - config.minValue) / (config.maxValue - config.minValue || 1)));
  }

  // ─── Angle Helpers ─────────────────────────────────────────────────

  function semiAngle(val) {
    return -Math.PI / 2 + valueRatio(val) * Math.PI;
  }

  function threeQuarterAngle(val) {
    const startA = -(3 / 4) * Math.PI;
    const sweep  = (3 / 2) * Math.PI;
    return startA + valueRatio(val) * sweep;
  }

  function valueToAngle(val) {
    const type = config.gaugeType || 'semi';
    switch (type) {
      case 'three-quarter': return threeQuarterAngle(val);
      default:              return semiAngle(val);
    }
  }

  function getAngleRange() {
    const type = config.gaugeType || 'semi';
    switch (type) {
      case 'three-quarter': return { start: threeQuarterAngle(config.minValue), end: threeQuarterAngle(config.maxValue) };
      default:              return { start: semiAngle(config.minValue), end: semiAngle(config.maxValue) };
    }
  }

  function angleToXY(angle, r) {
    return {
      x: r * Math.sin(angle),
      y: -r * Math.cos(angle),
    };
  }

  // ─── Gradient Helpers ──────────────────────────────────────────────

  /**
   * Build a sorted array of { position (0-1), color } stops for gradient rendering.
   * Creates smooth transition zones (~5% width) at each boundary between adjacent ranges.
   *
   * Example with 3 ranges (0-33 red, 33-66 yellow, 66-100 green):
   *   0% → red, 30.5% → red, 35.5% → yellow, 63.5% → yellow, 68.5% → green, 100% → green
   */
  function buildGradientStops() {
    const ranges = resolvedRanges;
    if (!ranges || ranges.length === 0) return [];

    const stops = [];
    const span = config.maxValue - config.minValue || 1;
    const blendHalf = 0.025;  // 2.5% each side = 5% total transition width

    // Start with the first range's beginning
    const firstFrom = Math.max(0, (Math.max(ranges[0].from, config.minValue) - config.minValue) / span);
    stops.push({ pos: firstFrom, color: ranges[0].color });

    // For each boundary between adjacent ranges, add a transition zone
    for (let i = 1; i < ranges.length; i++) {
      const prevColor = ranges[i - 1].color;
      const nextColor = ranges[i].color;
      const boundaryPos = Math.max(0, Math.min(1, (Math.max(ranges[i].from, config.minValue) - config.minValue) / span));

      const blendStart = Math.max(0, boundaryPos - blendHalf);
      const blendEnd   = Math.min(1, boundaryPos + blendHalf);

      stops.push({ pos: blendStart, color: prevColor });
      stops.push({ pos: blendEnd, color: nextColor });
    }

    // End with the last range's end
    const lastTo = Math.min(1, (Math.min(ranges[ranges.length - 1].to, config.maxValue) - config.minValue) / span);
    stops.push({ pos: lastTo, color: ranges[ranges.length - 1].color });

    return stops;
  }

  /**
   * Given gradient stops and a position (0-1), interpolate the color.
   */
  function interpolateGradientColor(stops, pos) {
    if (stops.length === 0) return '#999';
    if (pos <= stops[0].pos) return stops[0].color;
    if (pos >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;

    for (let i = 0; i < stops.length - 1; i++) {
      if (pos >= stops[i].pos && pos <= stops[i + 1].pos) {
        const t = (pos - stops[i].pos) / (stops[i + 1].pos - stops[i].pos || 1);
        return d3.interpolateRgb(stops[i].color, stops[i + 1].color)(t);
      }
    }
    return stops[stops.length - 1].color;
  }

  // ─── Render Dispatcher ─────────────────────────────────────────────

  function renderGauge(animateNeedle) {
    // ── STEP 1: Set text content and formatting FIRST ──
    // This ensures the title/subtitle DOM elements exist with actual text
    // BEFORE we measure the container, so the measurement accounts for
    // the space they occupy.
    document.getElementById('gauge-title').textContent = config.title || '';
    document.getElementById('gauge-subtitle').textContent = config.subtitle || '';

    applyTextFormatting(document.getElementById('gauge-title'), {
      family: config.titleFontFamily, size: config.titleFontSize,
      color: config.titleFontColor, weight: config.titleFontWeight,
      align: config.titleAlign,
    });
    applyTextFormatting(document.getElementById('gauge-subtitle'), {
      family: config.subtitleFontFamily, size: config.subtitleFontSize,
      color: config.subtitleFontColor, weight: config.subtitleFontWeight,
      align: config.subtitleAlign,
    });

    // ── STEP 2: Set background color ──
    const bg = config.backgroundColor || 'transparent';
    document.documentElement.style.background = bg;
    document.body.style.background = bg;
    const gaugeContainer = document.getElementById('gauge-container');
    if (gaugeContainer) gaugeContainer.style.background = bg;

    // ── STEP 3: Render the gauge (circular or linear) ──
    // Now that text is in the DOM, container measurements will be accurate.
    const type = config.gaugeType || 'semi';
    if (type === 'linear') {
      renderLinearGauge(animateNeedle);
    } else {
      renderCircularGauge(animateNeedle);
    }

    // ── STEP 4: Setup ResizeObserver for re-render tracking ──
    // Monitor the SVG wrapper for size changes. If Tableau filters/parameters
    // change and cause a container resize, re-render automatically to prevent
    // the "shrinking arc" bug. Only re-render if dimensions actually changed.
    setupResizeObserver();
  }

  function setupResizeObserver() {
    const container = document.getElementById('gauge-svg-wrapper');
    if (!container) return;

    // Clean up previous observer if it exists
    if (resizeObserver) {
      resizeObserver.disconnect();
    }

    resizeObserver = new ResizeObserver(() => {
      const currentW = container.clientWidth || 300;
      const currentH = container.clientHeight || 200;

      // Only re-render if dimensions actually changed (not on every observer fire)
      if (currentW !== lastContainerSize.width || currentH !== lastContainerSize.height) {
        lastContainerSize.width = currentW;
        lastContainerSize.height = currentH;
        const type = config.gaugeType || 'semi';
        if (type === 'linear') {
          renderLinearGauge(false);
        } else {
          renderCircularGauge(false);
        }
      }
    });

    resizeObserver.observe(container);
  }

  // ── Apply optional inline text-formatting overrides to a title/subtitle
  //    element. Any option left empty/null is cleared so the element falls
  //    back to its original CSS styling (guaranteeing legacy dashboards, which
  //    carry none of these keys, render exactly as before). ──
  function applyTextFormatting(el, opts) {
    if (!el) return;
    opts = opts || {};
    // Clear previously-applied overrides first so re-renders stay clean.
    el.style.fontFamily = '';
    el.style.fontSize = '';
    el.style.color = '';
    el.style.fontWeight = '';
    el.style.textAlign = '';
    if (opts.family) el.style.fontFamily = opts.family;
    if (opts.size !== '' && opts.size !== null && opts.size !== undefined) {
      const n = parseFloat(opts.size);
      if (!isNaN(n) && n > 0) el.style.fontSize = n + 'px';
    }
    if (opts.color) el.style.color = opts.color;
    if (opts.weight) el.style.fontWeight = String(opts.weight);
    if (opts.align) el.style.textAlign = opts.align;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CIRCULAR GAUGE RENDERER (semi, three-quarter)
  // ═══════════════════════════════════════════════════════════════════

  function renderCircularGauge(animateNeedle) {
    const container = document.getElementById('gauge-svg-wrapper');
    const fullW = container.clientWidth || 300;
    const fullH = container.clientHeight || 200;
    const type = config.gaugeType || 'semi';

    let gaugeW = fullW;
    let gaugeH = fullH;
    let radius, cx, cy;
    const innerRatio = 1 - config.arcThickness / 100;

    // ── Proportional Auto-Fit Radius (restores original footprint) ──
    // The arc scales to fill the tile like the original gauge. Tick marks and
    // min/max labels are painted BEYOND the arc radius and are allowed to
    // overflow the SVG (see #gauge-svg { overflow: visible } in styles.css),
    // so we only reserve a small guard band instead of a large fixed margin.
    // A short, wide tile therefore keeps a big arc instead of shrinking ~40%.
    //
    // outerExtra  — small horizontal guard so the arc's left/right edges (and
    //               side ticks/labels) don't clip against the tile border.
    // topPad      — minimum gap below the title text above the SVG.
    // bottomPad   — room below the baseline for the value text + min/max labels.
    const showLabelsOrTicks = config.showLabels || config.showTicks;
    const outerExtra = showLabelsOrTicks ? 10 : 6;
    const topPad = 6;

    // ── User-controlled size multiplier (Gauge Scale) ──
    // Clamped to [0.5, 1.0]. 1.0 = full proportional auto-fit.
    const scale = Math.max(0.5, Math.min(1, (config.gaugeScale != null ? config.gaugeScale : 100) / 100));

    if (type === 'semi') {
      // Semi-circle fills the top half: it rises `radius` above the baseline
      // and needs a little space below for the needle hub, value text and the
      // min/max labels. Subtracting only topPad + bottomPad yields an effective
      // ~0.80–0.82 height factor — matching the original proportional look.
      const bottomPad = config.showLabels ? 22 : 12;
      const radiusByW = (gaugeW / 2) - outerExtra;
      const radiusByH = gaugeH - topPad - bottomPad;
      radius = Math.max(20, Math.min(radiusByW, radiusByH) * scale);
      cx = gaugeW / 2;
      // Vertically centre the composition while guaranteeing the top padding.
      const usedH = radius + bottomPad;
      const freeTop = Math.max(topPad, (gaugeH - usedH) / 2);
      cy = freeTop + radius;
    } else if (type === 'three-quarter') {
      // 270° arc opening at the bottom: it spans `radius` above the centre and
      // ~0.707·radius below it. Only a small guard is reserved on each side;
      // ticks/labels overflow beyond the arc.
      const radiusByW = (gaugeW / 2) - outerExtra;
      const radiusByH = (gaugeH - topPad - 2 * outerExtra) / 1.707;
      radius = Math.max(20, Math.min(radiusByW, radiusByH) * scale);
      cx = gaugeW / 2;
      const usedH = 1.707 * radius + 2 * outerExtra;
      const freeTop = Math.max(topPad, (gaugeH - usedH) / 2);
      cy = freeTop + outerExtra + radius;
    }

    const innerRadius = radius * innerRatio;
    const angles = getAngleRange();

    const svg = d3.select('#gauge-svg')
      .attr('width', gaugeW)
      .attr('height', gaugeH);
    svg.selectAll('*').remove();

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

    // Display mode governs how the current value is depicted.
    const dispMode = config.displayMode || 'needle';
    const showFill = (dispMode === 'fill' || dispMode === 'needle+fill');
    const showNeedle = (dispMode === 'needle' || dispMode === 'needle+fill');

    // ── Colored range arcs / progress fill ──
    if (showFill) {
      // PROGRESS FILL MODE: a neutral background track spanning the whole scale,
      // overlaid with a colored fill from Min → Current Value that inherits the
      // colors of the threshold bands it passes through.
      renderCircularTrack(g, innerRadius, radius);
      renderCircularFillSegments(g, innerRadius, radius);
    } else if (config.useGradient) {
      // GRADIENT MODE: render many thin arc slices with interpolated colors
      renderCircularGradientArcs(g, innerRadius, radius, angles);
    } else {
      // HARD STOP MODE: render discrete range arcs
      renderCircularHardArcs(g, innerRadius, radius);
    }

    // ── Tick marks ──
    if (config.showTicks) {
      const numTicks = (type === 'three-quarter') ? 9 : 10;
      for (let i = 0; i <= numTicks; i++) {
        const val = config.minValue + (config.maxValue - config.minValue) * (i / numTicks);
        const angle = valueToAngle(val);
        const isMajor = (type === 'three-quarter') ? (i % 3 === 0) : (i % 5 === 0);
        const len = isMajor ? 10 : 5;
        const p1 = angleToXY(angle, radius + 2);
        const p2 = angleToXY(angle, radius + 2 + len);
        g.append('line')
          .attr('x1', p1.x).attr('y1', p1.y)
          .attr('x2', p2.x).attr('y2', p2.y)
          .attr('stroke', '#999')
          .attr('stroke-width', isMajor ? 1.5 : 0.8);
      }
    }

    // ── Min / Max labels ──
    if (config.showLabels) {
      if (type === 'semi') {
        const minPos = angleToXY(semiAngle(config.minValue), radius + 6);
        const maxPos = angleToXY(semiAngle(config.maxValue), radius + 6);
        g.append('text').attr('class', 'gauge-min-label')
          .attr('x', minPos.x - 4).attr('y', minPos.y + 14)
          .attr('text-anchor', 'end')
          .text(formatValue(config.minValue));
        g.append('text').attr('class', 'gauge-max-label')
          .attr('x', maxPos.x + 4).attr('y', maxPos.y + 14)
          .attr('text-anchor', 'start')
          .text(formatValue(config.maxValue));
      } else if (type === 'three-quarter') {
        const labelR = radius + 18;
        const sA = threeQuarterAngle(config.minValue);
        const eA = threeQuarterAngle(config.maxValue);
        const minPos = angleToXY(sA, labelR);
        const maxPos = angleToXY(eA, labelR);
        g.append('text').attr('class', 'gauge-min-label')
          .attr('x', minPos.x).attr('y', minPos.y)
          .attr('text-anchor', 'end')
          .attr('dominant-baseline', 'hanging')
          .text(formatValue(config.minValue));
        g.append('text').attr('class', 'gauge-max-label')
          .attr('x', maxPos.x).attr('y', maxPos.y)
          .attr('text-anchor', 'start')
          .attr('dominant-baseline', 'hanging')
          .text(formatValue(config.maxValue));
      }
    }

    // ── Range labels on arc ──
    if (config.showRangeLabels) {
      resolvedRanges.forEach(range => {
        const midVal = (Math.max(range.from, config.minValue) + Math.min(range.to, config.maxValue)) / 2;
        const angle = valueToAngle(midVal);
        const labelR = (innerRadius + radius) / 2;
        const pos = angleToXY(angle, labelR);
        g.append('text')
          .attr('x', pos.x)
          .attr('y', pos.y)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('font-size', '10px')
          .attr('fill', '#fff')
          .attr('font-weight', '600')
          .attr('pointer-events', 'none')
          .text(range.label || '');
      });
    }

    // ── Needle / Pointer ──
    if (showNeedle) {
      const needleLen = radius * 0.92;
      const needleAngle = valueToAngle(currentValue);
      const needleGroup = g.append('g').attr('class', 'gauge-needle');

      if (config.enableTooltip) {
        needleGroup
          .on('mouseenter', function (event) {
            const rangeInfo = findRangeForValue(currentValue);
            showTooltip(event, config.title || 'Value', formatValue(currentValue),
              rangeInfo ? rangeInfo.label : '');
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }

      const nw = 4;
      needleGroup.append('polygon')
        .attr('points', `0,${-needleLen} ${-nw},0 ${nw},0`)
        .attr('fill', config.needleColor);
      needleGroup.append('circle')
        .attr('r', 7)
        .attr('fill', config.needleColor);

      if (animateNeedle && config.animate) {
        const startAngleDeg = (valueToAngle(config.minValue) * 180) / Math.PI;
        const endAngleDeg   = (needleAngle * 180) / Math.PI;
        needleGroup
          .attr('transform', `rotate(${startAngleDeg})`)
          .transition()
          .duration(1200)
          .ease(d3.easeElasticOut.amplitude(1).period(0.6))
          .attr('transform', `rotate(${endAngleDeg})`);
      } else {
        needleGroup.attr('transform', `rotate(${(needleAngle * 180) / Math.PI})`);
      }
    }

    // ── Center value text ──
    // Use .style('fill') instead of .attr('fill') to ensure CSS doesn't override
    const valueText = g.append('text')
      .attr('class', 'gauge-value-text')
      .attr('text-anchor', 'middle')
      .attr('font-size', `${computeValueFontSize(radius)}px`)
      .style('fill', config.valueColor)
      .text(formatValue(currentValue));

    if (type === 'semi') {
      valueText.attr('y', -12);
    } else if (type === 'three-quarter') {
      valueText.attr('y', 8);
    }
  }

  // ── Circular Hard-Stop Arcs (default) ──

  function renderCircularHardArcs(g, innerRadius, radius) {
    const arcGen = d3.arc()
      .innerRadius(innerRadius)
      .outerRadius(radius)
      .cornerRadius(2);

    resolvedRanges.forEach((range, idx) => {
      const startAngle = valueToAngle(Math.max(range.from, config.minValue));
      const endAngle = valueToAngle(Math.min(range.to, config.maxValue));
      if (endAngle <= startAngle) return;

      const segment = g.append('path')
        .attr('class', 'gauge-arc-segment')
        .attr('d', arcGen({ startAngle, endAngle }))
        .attr('fill', range.color)
        .attr('data-index', idx);

      if (config.enableTooltip) {
        segment
          .on('mouseenter', function (event) {
            showTooltip(event, range.label || `Range ${idx + 1}`,
              `${formatValue(range.from)} – ${formatValue(range.to)}`, '');
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }
      if (config.enableFilter) {
        segment.on('click', function () { filterByRange(range); });
      }
    });
  }

  // ── Circular Progress Track (neutral background behind the fill) ──

  function renderCircularTrack(g, innerRadius, radius) {
    const arcGen = d3.arc()
      .innerRadius(innerRadius)
      .outerRadius(radius)
      .cornerRadius(2);
    const startAngle = valueToAngle(config.minValue);
    const endAngle = valueToAngle(config.maxValue);
    if (endAngle <= startAngle) return;
    g.append('path')
      .attr('class', 'gauge-track')
      .attr('d', arcGen({ startAngle, endAngle }))
      .attr('fill', config.trackColor || '#e9ecef');
  }

  // ── Circular Progress Fill (Min → Current, inheriting band colors) ──

  function renderCircularFillSegments(g, innerRadius, radius) {
    if (!R) return;
    const segments = R.computeFillSegments(resolvedRanges, config.minValue, currentValue, config.maxValue);
    const arcGen = d3.arc()
      .innerRadius(innerRadius)
      .outerRadius(radius)
      .cornerRadius(2);

    segments.forEach((seg, idx) => {
      const startAngle = valueToAngle(Math.max(seg.from, config.minValue));
      const endAngle = valueToAngle(Math.min(seg.to, config.maxValue));
      if (endAngle <= startAngle) return;

      const path = g.append('path')
        .attr('class', 'gauge-fill-segment')
        .attr('d', arcGen({ startAngle, endAngle }))
        .attr('fill', seg.color)
        .attr('data-index', idx);

      if (config.enableTooltip) {
        path
          .on('mouseenter', function (event) {
            const rangeInfo = findRangeForValue(currentValue);
            showTooltip(event, config.title || 'Value', formatValue(currentValue),
              rangeInfo ? rangeInfo.label : (seg.label || ''));
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }
      if (config.enableFilter) {
        const rangeInfo = findRangeForValue(currentValue);
        if (rangeInfo) path.on('click', function () { filterByRange(rangeInfo); });
      }
    });
  }

  // ── Circular Gradient Arcs ──

  function renderCircularGradientArcs(g, innerRadius, radius, angles) {
    const stops = buildGradientStops();
    if (stops.length === 0) return;

    const numSlices = 120;  // number of thin arc slices for smooth gradient
    const totalAngle = angles.end - angles.start;
    const arcGen = d3.arc()
      .innerRadius(innerRadius)
      .outerRadius(radius);

    for (let i = 0; i < numSlices; i++) {
      const t0 = i / numSlices;
      const t1 = (i + 1) / numSlices;
      const color = interpolateGradientColor(stops, (t0 + t1) / 2);
      const startAngle = angles.start + t0 * totalAngle;
      const endAngle   = angles.start + t1 * totalAngle;

      const slice = g.append('path')
        .attr('d', arcGen({ startAngle, endAngle }))
        .attr('fill', color)
        .attr('stroke', color)       // tiny stroke to prevent hairline gaps
        .attr('stroke-width', 0.5);

      // Attach tooltip/filter based on which range this slice falls into
      const sliceVal = config.minValue + ((t0 + t1) / 2) * (config.maxValue - config.minValue);
      const rangeInfo = findRangeForValue(sliceVal);

      if (config.enableTooltip && rangeInfo) {
        slice
          .attr('class', 'gauge-arc-segment')
          .on('mouseenter', function (event) {
            showTooltip(event, rangeInfo.label || 'Range',
              `${formatValue(rangeInfo.from)} – ${formatValue(rangeInfo.to)}`, '');
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }
      if (config.enableFilter && rangeInfo) {
        slice.on('click', function () { filterByRange(rangeInfo); });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LINEAR HORIZONTAL GAUGE RENDERER
  // ═══════════════════════════════════════════════════════════════════

  function renderLinearGauge(animateNeedle) {
    const container = document.getElementById('gauge-svg-wrapper');
    const fullW = container.clientWidth || 300;
    const fullH = container.clientHeight || 200;

    const svg = d3.select('#gauge-svg')
      .attr('width', fullW)
      .attr('height', fullH);
    svg.selectAll('*').remove();

    const marginLeft = 20;
    const marginRight = 20;
    const barW = fullW - marginLeft - marginRight;
    const barH = Math.min(Math.max(fullH * 0.18, 16), 50);
    const barRadius = barH / 2;

    // Vertically centre the bar within its container, accounting for the value
    // text drawn above it and the ticks/labels drawn below it. A minimum top
    // padding guarantees the value text never overlaps the title above.
    const topExtent = 18 + config.valueFontSize;            // space above barY
    const bottomExtent = barH + (config.showLabels ? 30 : 14); // space below barY
    let barY = (fullH - topExtent - bottomExtent) / 2 + topExtent;
    barY = Math.max(barY, topExtent + 6);

    const g = svg.append('g');

    // Display mode governs how the current value is depicted.
    const dispMode = config.displayMode || 'needle';
    const showFill = (dispMode === 'fill' || dispMode === 'needle+fill');
    const showNeedle = (dispMode === 'needle' || dispMode === 'needle+fill');

    // ── Colored range segments / progress fill ──
    if (showFill) {
      // PROGRESS FILL MODE: neutral track spanning the whole scale, overlaid
      // with a colored fill from Min → Current that inherits band colors.
      renderLinearTrack(g, marginLeft, barY, barW, barH, barRadius);
      renderLinearFillSegments(g, marginLeft, barY, barW, barH, barRadius);
    } else if (config.useGradient) {
      renderLinearGradientBar(svg, g, marginLeft, barY, barW, barH, barRadius);
    } else {
      renderLinearHardSegments(g, marginLeft, barY, barW, barH, barRadius);
    }

    // ── Range labels below bar ──
    if (config.showRangeLabels) {
      resolvedRanges.forEach(range => {
        const rFrom = Math.max(range.from, config.minValue);
        const rTo   = Math.min(range.to, config.maxValue);
        if (rTo <= rFrom || !range.label) return;
        const midX = marginLeft + ((valueRatio(rFrom) + valueRatio(rTo)) / 2) * barW;
        g.append('text')
          .attr('x', midX).attr('y', barY + barH + 16)
          .attr('text-anchor', 'middle')
          .attr('font-size', '10px')
          .attr('fill', '#666')
          .attr('pointer-events', 'none')
          .text(range.label);
      });
    }

    // ── Tick marks below bar ──
    if (config.showTicks) {
      const numTicks = 10;
      for (let i = 0; i <= numTicks; i++) {
        const val = config.minValue + (config.maxValue - config.minValue) * (i / numTicks);
        const x = marginLeft + valueRatio(val) * barW;
        const isMajor = i % 5 === 0;
        const len = isMajor ? 8 : 4;
        g.append('line')
          .attr('x1', x).attr('y1', barY + barH + 2)
          .attr('x2', x).attr('y2', barY + barH + 2 + len)
          .attr('stroke', '#999')
          .attr('stroke-width', isMajor ? 1.5 : 0.8);
      }
    }

    // ── Min / Max labels ──
    if (config.showLabels) {
      g.append('text').attr('class', 'gauge-min-label')
        .attr('x', marginLeft).attr('y', barY + barH + 26)
        .attr('text-anchor', 'start').text(formatValue(config.minValue));
      g.append('text').attr('class', 'gauge-max-label')
        .attr('x', marginLeft + barW).attr('y', barY + barH + 26)
        .attr('text-anchor', 'end').text(formatValue(config.maxValue));
    }

    // ── Vertical marker / pointer ──
    const markerX = marginLeft + valueRatio(currentValue) * barW;
    const triSize = 6;

    if (showNeedle) {
      const markerGroup = g.append('g').attr('class', 'gauge-needle linear-marker');

      markerGroup.append('line')
        .attr('x1', markerX).attr('y1', barY - 6)
        .attr('x2', markerX).attr('y2', barY + barH + 6)
        .attr('stroke', config.needleColor)
        .attr('stroke-width', 3)
        .attr('stroke-linecap', 'round');

      markerGroup.append('polygon')
        .attr('points', `${markerX},${barY - 2} ${markerX - triSize},${barY - triSize - 4} ${markerX + triSize},${barY - triSize - 4}`)
        .attr('fill', config.needleColor);

      if (config.enableTooltip) {
        markerGroup
          .on('mouseenter', function (event) {
            const rangeInfo = findRangeForValue(currentValue);
            showTooltip(event, config.title || 'Value', formatValue(currentValue),
              rangeInfo ? rangeInfo.label : '');
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }

      if (animateNeedle && config.animate) {
        const startX = marginLeft;
        markerGroup
          .attr('transform', `translate(${startX - markerX}, 0)`)
          .transition()
          .duration(1200)
          .ease(d3.easeElasticOut.amplitude(1).period(0.6))
          .attr('transform', 'translate(0, 0)');
      }
    }

    // ── Value text above marker ──
    // Use .style('fill') to override any CSS class rules
    g.append('text')
      .attr('class', 'gauge-value-text')
      .attr('x', markerX)
      .attr('y', barY - triSize - 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', `${config.valueFontSize}px`)
      .style('fill', config.valueColor)
      .text(formatValue(currentValue));
  }

  // ── Linear Progress Track (neutral background behind the fill) ──

  function renderLinearTrack(g, marginLeft, barY, barW, barH, barRadius) {
    g.append('rect')
      .attr('class', 'gauge-track')
      .attr('x', marginLeft).attr('y', barY)
      .attr('width', barW).attr('height', barH)
      .attr('rx', barRadius).attr('ry', barRadius)
      .attr('fill', config.trackColor || '#e9ecef');
  }

  // ── Linear Progress Fill (Min → Current, inheriting band colors) ──

  function renderLinearFillSegments(g, marginLeft, barY, barW, barH, barRadius) {
    if (!R) return;
    const segments = R.computeFillSegments(resolvedRanges, config.minValue, currentValue, config.maxValue);
    if (!segments.length) return;

    // Clip the colored segments to a rounded-rect that spans Min → Current so
    // the leading (and, at 100%, trailing) end of the fill stays nicely rounded.
    const fillFrom = marginLeft + valueRatio(Math.max(config.minValue, segments[0].from)) * barW;
    const fillTo = marginLeft + valueRatio(Math.min(config.maxValue, currentValue)) * barW;
    const fillW = Math.max(0, fillTo - fillFrom);
    if (fillW <= 0) return;

    const clipId = 'linear-fill-clip-' + Math.random().toString(36).slice(2);
    const defs = g.append('defs');
    defs.append('clipPath').attr('id', clipId)
      .append('rect')
      .attr('x', fillFrom).attr('y', barY)
      .attr('width', fillW).attr('height', barH)
      .attr('rx', barRadius).attr('ry', barRadius);

    const fillG = g.append('g').attr('clip-path', `url(#${clipId})`);

    segments.forEach((seg, idx) => {
      const x1 = marginLeft + valueRatio(Math.max(seg.from, config.minValue)) * barW;
      const x2 = marginLeft + valueRatio(Math.min(seg.to, config.maxValue)) * barW;
      const segW = x2 - x1;
      if (segW <= 0) return;

      const rect = fillG.append('rect')
        .attr('class', 'gauge-fill-segment linear-fill-segment')
        .attr('x', x1).attr('y', barY)
        .attr('width', segW).attr('height', barH)
        .attr('fill', seg.color)
        .attr('data-index', idx);

      if (config.enableTooltip) {
        rect
          .on('mouseenter', function (event) {
            const rangeInfo = findRangeForValue(currentValue);
            showTooltip(event, config.title || 'Value', formatValue(currentValue),
              rangeInfo ? rangeInfo.label : (seg.label || ''));
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }
      if (config.enableFilter) {
        const rangeInfo = findRangeForValue(currentValue);
        if (rangeInfo) rect.on('click', function () { filterByRange(rangeInfo); });
      }
    });
  }

  // ── Linear Hard-Stop Segments (default) ──

  function renderLinearHardSegments(g, marginLeft, barY, barW, barH, barRadius) {
    resolvedRanges.forEach((range, idx) => {
      const rFrom = Math.max(range.from, config.minValue);
      const rTo   = Math.min(range.to, config.maxValue);
      if (rTo <= rFrom) return;

      const x1 = marginLeft + valueRatio(rFrom) * barW;
      const x2 = marginLeft + valueRatio(rTo) * barW;
      const segW = x2 - x1;

      const segment = g.append('rect')
        .attr('class', 'gauge-arc-segment linear-segment')
        .attr('x', x1).attr('y', barY)
        .attr('width', segW).attr('height', barH)
        .attr('fill', range.color)
        .attr('data-index', idx);

      if (rFrom <= config.minValue) {
        segment.attr('rx', barRadius).attr('ry', barRadius);
        if (segW > barRadius * 2) {
          g.append('rect')
            .attr('x', x1 + barRadius).attr('y', barY)
            .attr('width', segW - barRadius).attr('height', barH)
            .attr('fill', range.color).attr('pointer-events', 'none');
        }
      }
      if (rTo >= config.maxValue) {
        segment.attr('rx', barRadius).attr('ry', barRadius);
        if (segW > barRadius * 2) {
          g.append('rect')
            .attr('x', x1).attr('y', barY)
            .attr('width', segW - barRadius).attr('height', barH)
            .attr('fill', range.color).attr('pointer-events', 'none');
        }
      }

      if (config.enableTooltip) {
        segment
          .on('mouseenter', function (event) {
            showTooltip(event, range.label || `Range ${idx + 1}`,
              `${formatValue(range.from)} – ${formatValue(range.to)}`, '');
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }
      if (config.enableFilter) {
        segment.on('click', function () { filterByRange(range); });
      }
    });
  }

  // ── Linear Gradient Bar ──

  function renderLinearGradientBar(svg, g, marginLeft, barY, barW, barH, barRadius) {
    const stops = buildGradientStops();
    if (stops.length === 0) return;

    // Create SVG <defs> with a <linearGradient>
    const defs = svg.append('defs');
    const gradientId = 'linear-gauge-gradient-' + Date.now();
    const linearGrad = defs.append('linearGradient')
      .attr('id', gradientId)
      .attr('x1', '0%').attr('y1', '0%')
      .attr('x2', '100%').attr('y2', '0%');

    stops.forEach(stop => {
      linearGrad.append('stop')
        .attr('offset', (stop.pos * 100) + '%')
        .attr('stop-color', stop.color);
    });

    // Render a single rect with the gradient fill, clipped to rounded corners
    const clipId = 'linear-gauge-clip-' + Date.now();
    defs.append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', marginLeft).attr('y', barY)
      .attr('width', barW).attr('height', barH)
      .attr('rx', barRadius).attr('ry', barRadius);

    g.append('rect')
      .attr('x', marginLeft).attr('y', barY)
      .attr('width', barW).attr('height', barH)
      .attr('fill', `url(#${gradientId})`)
      .attr('clip-path', `url(#${clipId})`);

    // Invisible overlay rects for tooltip/click interaction per range
    resolvedRanges.forEach((range, idx) => {
      const rFrom = Math.max(range.from, config.minValue);
      const rTo   = Math.min(range.to, config.maxValue);
      if (rTo <= rFrom) return;

      const x1 = marginLeft + valueRatio(rFrom) * barW;
      const x2 = marginLeft + valueRatio(rTo) * barW;

      const overlay = g.append('rect')
        .attr('x', x1).attr('y', barY)
        .attr('width', x2 - x1).attr('height', barH)
        .attr('fill', 'transparent')
        .attr('class', 'gauge-arc-segment')
        .attr('data-index', idx);

      if (config.enableTooltip) {
        overlay
          .on('mouseenter', function (event) {
            showTooltip(event, range.label || `Range ${idx + 1}`,
              `${formatValue(range.from)} – ${formatValue(range.to)}`, '');
          })
          .on('mousemove', function (event) { moveTooltip(event); })
          .on('mouseleave', hideTooltip);
      }
      if (config.enableFilter) {
        overlay.on('click', function () { filterByRange(range); });
      }
    });
  }

  // ─── Shared Helpers ────────────────────────────────────────────────

  function findRangeForValue(val) {
    return resolvedRanges.find(r => val >= r.from && val < r.to) || resolvedRanges[resolvedRanges.length - 1];
  }

  // ─── Tooltip ───────────────────────────────────────────────────────

  function showTooltip(event, label, value, extra) {
    const tt = document.getElementById('gauge-tooltip');
    document.getElementById('tt-label').textContent = label;
    document.getElementById('tt-value').textContent = value;
    document.getElementById('tt-range').textContent = extra;
    tt.classList.add('visible');
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const tt = document.getElementById('gauge-tooltip');
    tt.style.left = (event.clientX + 14) + 'px';
    tt.style.top = (event.clientY - 10) + 'px';
  }

  function hideTooltip() {
    document.getElementById('gauge-tooltip').classList.remove('visible');
  }

  // ─── Filtering ─────────────────────────────────────────────────────

  async function filterByRange(range) {
    if (!worksheetObj) return;
    try {
      const fieldName = config.filterField || config.measure;
      if (!fieldName) return;
      const dashboard = tableau.extensions.dashboardContent.dashboard;
      const promises = dashboard.worksheets
        .filter(ws => ws.name !== config.worksheet)
        .map(ws =>
          ws.applyRangeFilterAsync(fieldName, { min: range.from, max: range.to })
            .catch(() => {})
        );
      await Promise.all(promises);
    } catch (err) {
      console.warn('[Gauge] Filter error:', err);
    }
  }

  // ─── Data Fetch ────────────────────────────────────────────────────

  async function fetchDataAndRender(animate) {
    if (!config.worksheet || !config.measure) {
      showError('No worksheet or measure selected. Right-click the extension → Configure.');
      return;
    }

    try {
      const dashboard = tableau.extensions.dashboardContent.dashboard;
      worksheetObj = dashboard.worksheets.find(ws => ws.name === config.worksheet);
      if (!worksheetObj) {
        showError(`Worksheet "${config.worksheet}" not found in the dashboard.`);
        return;
      }

      const dataTable = await worksheetObj.getSummaryDataAsync();
      const columns = dataTable.columns;
      const colIdx = columns.findIndex(c => c.fieldName === config.measure);

      if (colIdx === -1) {
        showError(`Measure "${config.measure}" not found in worksheet.`);
        return;
      }

      const values = dataTable.data.map(row => parseFloat(row[colIdx].value)).filter(v => !isNaN(v));
      const aggregatedValue = aggregateColumn(dataTable, colIdx, config.aggregation);
      currentValue = (aggregatedValue === null) ? 0 : aggregatedValue;

      // ── Dynamic Max ──
      // When the max is sourced from a worksheet field OR is set relative to the
      // Goal, recompute the gauge's maximum scale value on every data refresh so
      // it stays in sync with filters, parameters and mark selections. Falls back
      // to the configured fixed maxValue if it cannot be resolved.
      //   • 'field'        → aggregation of a worksheet field.
      //   • 'relativeGoal' → Goal value × multiplier (resolveMax computes the
      //                      Goal internally using the SAME aggregation pattern).
      // Uses the shared resolution logic in resolve.js.
      if ((config.maxMode === 'field' || config.maxMode === 'relativeGoal') && R) {
        const maxR = R.resolveMax(config, dataTable);
        if (maxR.ok) {
          config.maxValue = maxR.value;
        } else if (maxR.reason) {
          console.warn('[Gauge] ' + maxR.reason + ' Using fixed Max Value.');
        }
      }

      // ── Resolve Goal + concrete Ranges ──
      // Computes the shared Goal value and turns each range's start-boundary
      // mode (fixed / % of Max / % of Goal / Goal Field Value) into concrete
      // {from,to} values that drive the rendering below.
      resolveDerivedState(dataTable);

      hideError();
      hideLoading();
      renderGauge(animate);

    } catch (err) {
      console.error('[Gauge] Data fetch error:', err);
      showError('Error fetching data: ' + err.message);
    }
  }

  // ─── UI Helpers ────────────────────────────────────────────────────

  function showLoading() {
    document.getElementById('loading-overlay').style.display = 'flex';
  }
  function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
  }
  function showError(msg) {
    hideLoading();
    const el = document.getElementById('error-message');
    document.getElementById('error-text').textContent = msg;
    el.style.display = 'flex';
  }
  function hideError() {
    document.getElementById('error-message').style.display = 'none';
  }

  // ─── Load Settings from Tableau ────────────────────────────────────

  function loadSettings() {
    const raw = tableau.extensions.settings.get('gaugeConfig');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.gaugeType === 'full') parsed.gaugeType = 'semi';
        config = {
          ...DEFAULT_CONFIG,
          ...parsed,
          // Migrate legacy {from,to} ranges to the v2 {startMode,startValue} model.
          ranges: R
            ? R.migrateRanges(parsed.ranges && parsed.ranges.length ? parsed.ranges : DEFAULT_CONFIG.ranges)
            : (parsed.ranges || DEFAULT_CONFIG.ranges).map(r => ({ ...r })),
        };
        // Backward compatibility: dashboards saved before Display Mode existed
        // must keep the classic needle look (only new configs get needle+fill).
        if (!Object.prototype.hasOwnProperty.call(parsed, 'displayMode')) {
          config.displayMode = 'needle';
        }
        // Legacy configs used a Goal *field* only. Derive goalMode if absent.
        if (!Object.prototype.hasOwnProperty.call(parsed, 'goalMode')) {
          config.goalMode = parsed.goalField ? 'field' : 'none';
        }
      } catch (e) {
        console.warn('[Gauge] Failed to parse saved settings:', e);
      }
    }
  }

  // ─── Configuration Dialog ─────────────────────────────────────────

  function openConfigureDialog() {
    const baseUrl = window.location.href.replace(/\/[^/]*$/, '/');
    const popupUrl = baseUrl + 'config.html';

    tableau.extensions.ui.displayDialogAsync(
      popupUrl, '', { height: 600, width: 580 }
    ).then(function (closePayload) {
      loadSettings();
      showLoading();
      fetchDataAndRender(true).then(function () {
        listenForDataChanges();
      });
    }).catch(function (error) {
      // DialogClosedByUser is expected (user hit X) — ignore it; log the rest.
      if (error.errorCode !== tableau.ErrorCodes.DialogClosedByUser) {
        console.error('[Gauge] Error displaying config dialog:', error);
      }
    });
  }

  // ─── Data Change Listener ─────────────────────────────────────────

  function listenForDataChanges() {
    // Tear down any previously registered handlers (e.g. after re-configure).
    eventUnregisterHandlers.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    eventUnregisterHandlers = [];

    let dashboard;
    try {
      dashboard = tableau.extensions.dashboardContent.dashboard;
    } catch (e) {
      console.warn('[Gauge] Could not access dashboard for event listeners:', e);
      return;
    }
    if (!dashboard) return;

    // ── 1) Filter changes ──
    // A filter applied via a filter card or another worksheet only fires
    // FilterChanged on the worksheets it actually affects. To update reliably
    // no matter where the filter lives, listen on EVERY worksheet in the
    // dashboard and re-fetch the source worksheet's data on any change.
    (dashboard.worksheets || []).forEach(ws => {
      try {
        const unreg = ws.addEventListener(
          tableau.TableauEventType.FilterChanged,
          () => { fetchDataAndRender(false); }
        );
        eventUnregisterHandlers.push(unreg);
      } catch (e) {
        console.warn('[Gauge] Could not attach FilterChanged on worksheet "' + ws.name + '":', e);
      }
    });

    // ── 2) Mark selection on the source worksheet ──
    if (worksheetObj) {
      try {
        const unreg = worksheetObj.addEventListener(
          tableau.TableauEventType.MarkSelectionChanged,
          () => { fetchDataAndRender(false); }
        );
        eventUnregisterHandlers.push(unreg);
      } catch (e) {
        console.warn('[Gauge] Could not attach MarkSelectionChanged:', e);
      }
    }

    // ── 3) Parameter changes ──
    // Parameters frequently drive calculated measures, so refresh on change.
    if (typeof dashboard.getParametersAsync === 'function') {
      dashboard.getParametersAsync().then(parameters => {
        (parameters || []).forEach(param => {
          try {
            const unreg = param.addEventListener(
              tableau.TableauEventType.ParameterChanged,
              () => { fetchDataAndRender(false); }
            );
            eventUnregisterHandlers.push(unreg);
          } catch (e) { /* ignore individual param failures */ }
        });
      }).catch(() => { /* parameters unavailable — non-fatal */ });
    }

  }

  // ─── Initialization ───────────────────────────────────────────────

  async function initExtension() {
    showLoading();

    try {
      await tableau.extensions.initializeAsync({ configure: openConfigureDialog });
      loadSettings();

      if (config.worksheet && config.measure) {
        await fetchDataAndRender(true);
        listenForDataChanges();
      } else {
        hideLoading();
        showError('Extension not configured yet. Right-click the extension zone → Configure to get started.');
      }
    } catch (err) {
      console.error('[Gauge] Initialization error:', err);
      if (!err || !err.message || err.message === '' ||
          err.message.includes('not running inside') ||
          err.message.includes('not a Tableau extension') ||
          err.message.includes('Initialization failed')) {
        fallbackToDemo();
      } else {
        hideLoading();
        showError('Initialization failed: ' + err.message);
      }
    }
  }

  // ─── Window Resize ─────────────────────────────────────────────────

  let resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderGauge(false), 150);
  });

  // ─── Boot ──────────────────────────────────────────────────────────

  function checkApiAndBoot() {
    if (typeof tableau === 'undefined') {
      console.error('[Gauge] ❌ "tableau" object is undefined. API did not load.');
      fallbackToDemo();
      return;
    }
    if (!tableau.extensions) {
      console.error('[Gauge] ❌ "tableau.extensions" is undefined. Wrong API library?');
      fallbackToDemo();
      return;
    }
    initExtension();
  }

  function fallbackToDemo() {
    hideLoading();
    currentValue = 0.72;
    config.title = 'Demo Gauge';
    config.subtitle = 'Percentage Mode • Not connected to Tableau';
    config.percentageMode = 'pct0to1';
    config.percentDecimals = 1;
    config.minValue = 0;
    config.maxValue = 1;
    config.goalField = '';
    config.ranges = [
      { label: 'Low',    color: '#dc3545', startMode: 'fixed', startValue: 0 },
      { label: 'Medium', color: '#ffc107', startMode: 'fixed', startValue: 0.33 },
      { label: 'High',   color: '#28a745', startMode: 'fixed', startValue: 0.66 },
    ];
    // Allow overriding the gauge type via ?type= for local preview/testing,
    // e.g. gauge.html?type=three-quarter or gauge.html?type=linear.
    try {
      const demoType = new URLSearchParams(window.location.search).get('type');
      if (demoType && ['semi', 'three-quarter', 'linear'].includes(demoType)) {
        config.gaugeType = demoType;
      }
    } catch (e) { /* ignore */ }
    // Resolve ranges (no data table → goal null) before rendering.
    resolveDerivedState(null);
    renderGauge(true);
  }

  checkApiAndBoot();

})();