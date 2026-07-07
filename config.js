/**
 * Semi-Circular Gauge Chart — Configuration Dialog
 *
 * This file runs inside the Tableau popup dialog opened via displayDialogAsync().
 * It uses initializeDialogAsync() (NOT initializeAsync) and closeDialog() to
 * communicate with the parent extension (gauge.js).
 *
 * v2 adds:
 *   • Dynamic Max value (fixed number OR worksheet field + aggregation)
 *   • Shared Goal field (worksheet field + aggregation) used across ranges
 *   • Fully dynamic Ranges & Colors where each range's START boundary can be
 *     Fixed value / % of Max / % of Goal / Goal Field Value
 *   • Live validation preview + pre-apply warnings (shared logic in resolve.js)
 */

(function () {
  'use strict';

  const R = window.GaugeResolve; // shared resolution/validation helpers

  const DEFAULT_CONFIG = {
    worksheet: '',
    measure: '',
    aggregation: 'SUM',
    minValue: 0,
    maxValue: 100,
    // Max value source: 'fixed' uses maxValue, 'field' computes from maxField + maxAggregation
    maxMode: 'fixed',
    maxField: '',
    maxAggregation: 'MAX',
    // Multiplier used when maxMode === 'relativeGoal' (Max = Goal × multiplier).
    // Stored as a number; the input also accepts "150%" which parses to 1.5.
    maxMultiplier: 1.5,
    // Shared Goal reference (optional). goalMode: 'none' | 'fixed' | 'field'
    //   'fixed' uses goalValue; 'field' computes from goalField + goalAggregation.
    goalMode: 'field',
    goalValue: 0,
    goalField: '',
    goalAggregation: 'SUM',
    title: 'Gauge',
    subtitle: '',
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
    valueFormat: 'number',
    currencySymbol: '$',
    showLabels: true,
    showTicks: true,
    showRangeLabels: false,
    enableFilter: true,
    filterField: '',
    enableTooltip: true,
    animate: true,
    gaugeType: 'semi',
    useGradient: false,
    percentageMode: 'off',
    percentDecimals: 0,
    // Display mode for how the current value is shown:
    //   'needle'      — classic needle/marker (legacy default)
    //   'fill'        — progress fill from Min → Current Value (inherits band colors)
    //   'needle+fill' — both (recommended for new configs)
    displayMode: 'needle+fill',
    // Neutral background track color shown behind the progress fill.
    trackColor: '#e9ecef',
  };

  let config = cloneConfig(DEFAULT_CONFIG);

  // Cached summary data table for the currently selected worksheet — used to
  // resolve field-based Max/Goal aggregations in the live validation preview.
  let currentDataTable = null;

  // True while populateConfigForm is writing config values INTO the form.
  // Guards readConfigFromForm so the live preview (triggered mid-populate by
  // populateMeasures) can't read half-populated form controls and clobber
  // config values that haven't been written to the DOM yet (e.g. displayMode).
  let isPopulating = false;

  function cloneConfig(c) {
    return { ...c, ranges: (c.ranges || []).map(r => ({ ...r })) };
  }

  // ─── Initialize Dialog ─────────────────────────────────────────────

  console.log('[Config] Dialog script loaded. Initializing...');

  tableau.extensions.initializeDialogAsync().then(function (openPayload) {
    console.log('[Config] Dialog initialized. Payload:', openPayload);
    loadSettings();
    populateConfigForm();
    wireEvents();
  }).catch(function (err) {
    console.error('[Config] Dialog initialization failed:', err);
  });

  // ─── Load / Save Settings ─────────────────────────────────────────

  function loadSettings() {
    const raw = tableau.extensions.settings.get('gaugeConfig');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        config = {
          ...DEFAULT_CONFIG,
          ...parsed,
          // Migrate any legacy {from,to} ranges to the v2 model.
          ranges: R.migrateRanges(parsed.ranges && parsed.ranges.length ? parsed.ranges : DEFAULT_CONFIG.ranges),
        };
        // Backward compatibility: existing dashboards saved before Display Mode
        // existed must keep the classic needle look. Only brand-new configs get
        // the 'needle+fill' default.
        if (!Object.prototype.hasOwnProperty.call(parsed, 'displayMode')) {
          config.displayMode = 'needle';
        }
        // Legacy configs used a Goal *field* only. If goalMode wasn't saved,
        // derive it: field if a goalField exists, otherwise none.
        if (!Object.prototype.hasOwnProperty.call(parsed, 'goalMode')) {
          config.goalMode = parsed.goalField ? 'field' : 'none';
        }
        console.log('[Config] Loaded settings:', config.worksheet, config.measure);
      } catch (e) {
        console.warn('[Config] Could not parse saved settings:', e);
      }
    } else {
      console.log('[Config] No existing settings — using defaults.');
    }
  }

  function saveSettings() {
    tableau.extensions.settings.set('gaugeConfig', JSON.stringify(config));
    return tableau.extensions.settings.saveAsync();
  }

  // ─── Populate Form ─────────────────────────────────────────────────

  async function populateConfigForm() {
    isPopulating = true;
    const wsSelect = document.getElementById('cfg-worksheet');
    wsSelect.innerHTML = '<option value="">— Select worksheet —</option>';

    const dashboard = tableau.extensions.dashboardContent.dashboard;
    console.log('[Config] Dashboard worksheets:', dashboard.worksheets.map(w => w.name));

    dashboard.worksheets.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.name;
      opt.textContent = ws.name;
      if (ws.name === config.worksheet) opt.selected = true;
      wsSelect.appendChild(opt);
    });

    await populateMeasures();

    document.getElementById('cfg-aggregation').value = config.aggregation;
    document.getElementById('cfg-min').value = config.minValue;
    document.getElementById('cfg-max').value = config.maxValue;

    document.getElementById('cfg-max-mode').value = config.maxMode || 'fixed';
    document.getElementById('cfg-max-aggregation').value = config.maxAggregation || 'MAX';
    document.getElementById('cfg-max-multiplier').value =
      (config.maxMultiplier === undefined || config.maxMultiplier === null) ? 1.5 : config.maxMultiplier;
    updateMaxModeVisibility();

    // Goal reference
    document.getElementById('cfg-goal-mode').value = config.goalMode || 'none';
    document.getElementById('cfg-goal-value').value =
      (config.goalValue === undefined || config.goalValue === null) ? 0 : config.goalValue;
    document.getElementById('cfg-goal-aggregation').value = config.goalAggregation || 'SUM';
    updateGoalModeVisibility();

    document.getElementById('cfg-title').value = config.title;
    document.getElementById('cfg-subtitle').value = config.subtitle;
    document.getElementById('cfg-needle-color').value = config.needleColor;
    const bgIsTransparent = !config.backgroundColor ||
      config.backgroundColor === 'transparent' ||
      config.backgroundColor === 'rgba(0,0,0,0)';
    document.getElementById('cfg-bg-transparent').checked = bgIsTransparent;
    document.getElementById('cfg-bg-color').value = bgIsTransparent ? '#ffffff' : config.backgroundColor;
    document.getElementById('cfg-bg-color').disabled = bgIsTransparent;
    document.getElementById('cfg-value-fontsize').value = config.valueFontSize;
    document.getElementById('cfg-value-color').value = config.valueColor;
    document.getElementById('cfg-arc-thickness').value = config.arcThickness;
    document.getElementById('arc-thickness-display').textContent = config.arcThickness + '%';
    document.getElementById('cfg-value-format').value = config.valueFormat;
    document.getElementById('cfg-currency-symbol').value = config.currencySymbol;
    document.getElementById('cfg-show-labels').checked = config.showLabels;
    document.getElementById('cfg-show-ticks').checked = config.showTicks;
    document.getElementById('cfg-show-range-labels').checked = config.showRangeLabels;
    document.getElementById('cfg-enable-filter').checked = config.enableFilter;
    document.getElementById('cfg-enable-tooltip').checked = config.enableTooltip;
    document.getElementById('cfg-animate').checked = config.animate;

    document.getElementById('cfg-gauge-type').value = config.gaugeType || 'semi';
    updateGaugeTypeHint();

    document.getElementById('cfg-display-mode').value = config.displayMode || 'needle';
    document.getElementById('cfg-track-color').value = config.trackColor || '#e9ecef';
    updateDisplayModeVisibility();

    document.getElementById('cfg-use-gradient').checked = config.useGradient || false;

    document.getElementById('cfg-percentage-mode').value = config.percentageMode || 'off';
    document.getElementById('cfg-percent-decimals').value = config.percentDecimals || 0;
    updatePctHint();
    updatePctDecimalsVisibility();

    renderRangeList();
    isPopulating = false;
    updateValidationPreview();
  }

  async function populateMeasures() {
    const wsName = document.getElementById('cfg-worksheet').value;
    const measureSelect = document.getElementById('cfg-measure');
    const filterSelect = document.getElementById('cfg-filter-field');
    const maxFieldSelect = document.getElementById('cfg-max-field');
    const goalFieldSelect = document.getElementById('cfg-goal-field');
    measureSelect.innerHTML = '<option value="">— Select measure —</option>';
    filterSelect.innerHTML = '<option value="">— Same as measure —</option>';
    maxFieldSelect.innerHTML = '<option value="">— Select field —</option>';
    goalFieldSelect.innerHTML = '<option value="">— None —</option>';

    currentDataTable = null;

    if (!wsName) { updateValidationPreview(); return; }

    try {
      const dashboard = tableau.extensions.dashboardContent.dashboard;
      const ws = dashboard.worksheets.find(w => w.name === wsName);
      if (!ws) return;

      const dataTable = await ws.getSummaryDataAsync();
      currentDataTable = dataTable; // cache for live validation/preview
      console.log('[Config] Columns for', wsName + ':', dataTable.columns.map(c => c.fieldName));

      dataTable.columns.forEach(col => {
        measureSelect.appendChild(makeOption(col.fieldName, config.measure));
        filterSelect.appendChild(makeOption(col.fieldName, config.filterField));
        maxFieldSelect.appendChild(makeOption(col.fieldName, config.maxField));
        goalFieldSelect.appendChild(makeOption(col.fieldName, config.goalField));
      });
    } catch (e) {
      console.warn('[Config] Could not fetch columns for', wsName, e);
    }
    updateValidationPreview();
  }

  function makeOption(fieldName, selectedVal) {
    const opt = document.createElement('option');
    opt.value = fieldName;
    opt.textContent = fieldName;
    if (fieldName === selectedVal) opt.selected = true;
    return opt;
  }

  // ─── Dynamic Range List UI (v2) ────────────────────────────────────

  const START_MODE_LABELS = {
    fixed:   'Fixed value',
    pctMax:  '% of Max',
    pctGoal: '% of Goal',
    goal:    'Goal Field Value',
  };

  function renderRangeList() {
    const list = document.getElementById('range-list');
    list.innerHTML = '';
    config.ranges.forEach((range, idx) => {
      const item = document.createElement('div');
      item.className = 'range-item range-item-v2';

      const mode = range.startMode || 'fixed';
      const valueHidden = (mode === 'goal') ? 'startvalue-hidden' : '';
      const sv = (range.startValue === undefined || range.startValue === null) ? 0 : range.startValue;

      item.innerHTML = `
        <input type="color" class="range-color" data-idx="${idx}" value="${range.color}" title="Color" />
        <input type="text" class="range-label-input" data-idx="${idx}" value="${escapeHtml(range.label || '')}" placeholder="Label" title="Label" />
        <select class="range-startmode" data-idx="${idx}" title="Start boundary mode">
          <option value="fixed"${mode === 'fixed' ? ' selected' : ''}>Fixed value</option>
          <option value="pctMax"${mode === 'pctMax' ? ' selected' : ''}>% of Max</option>
          <option value="pctGoal"${mode === 'pctGoal' ? ' selected' : ''}>% of Goal</option>
          <option value="goal"${mode === 'goal' ? ' selected' : ''}>Goal Field Value</option>
        </select>
        <input type="number" step="any" class="range-startvalue ${valueHidden}" data-idx="${idx}" value="${sv}" placeholder="${startValuePlaceholder(mode)}" title="Start value" />
        <button class="remove-range-btn" data-idx="${idx}" title="Remove">&times;</button>
        <div class="range-resolved" data-idx="${idx}"></div>
      `;
      list.appendChild(item);
    });
  }

  function startValuePlaceholder(mode) {
    if (mode === 'pctMax' || mode === 'pctGoal') return '%';
    if (mode === 'goal') return '—';
    return 'value';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function readRangesFromDom() {
    config.ranges = [];
    document.querySelectorAll('#range-list .range-item').forEach(item => {
      const mode = item.querySelector('.range-startmode').value || 'fixed';
      const rawVal = item.querySelector('.range-startvalue').value;
      config.ranges.push({
        label: item.querySelector('.range-label-input').value,
        color: item.querySelector('.range-color').value,
        startMode: mode,
        startValue: (mode === 'goal') ? 0 : (parseFloat(rawVal) || 0),
      });
    });
  }

  // ─── Read Config from Form ─────────────────────────────────────────

  function readConfigFromForm(includeRanges) {
    // While the form is being populated FROM config, do not read back the
    // (possibly still-default) DOM controls — that would clobber config.
    if (isPopulating) return;
    if (includeRanges === undefined) includeRanges = true;
    config.worksheet = document.getElementById('cfg-worksheet').value;
    config.measure = document.getElementById('cfg-measure').value;
    config.aggregation = document.getElementById('cfg-aggregation').value;
    config.minValue = parseFloat(document.getElementById('cfg-min').value) || 0;
    config.maxValue = parseFloat(document.getElementById('cfg-max').value) || 100;
    config.maxMode = document.getElementById('cfg-max-mode').value || 'fixed';
    config.maxField = document.getElementById('cfg-max-field').value;
    config.maxAggregation = document.getElementById('cfg-max-aggregation').value || 'MAX';
    // Multiplier accepts "1.5" or "150%"; store the parsed numeric multiplier so
    // gauge.js (which may not re-parse) gets a clean number. Falls back to 1.5.
    {
      const parsedMult = R.parseMultiplier(document.getElementById('cfg-max-multiplier').value);
      config.maxMultiplier = isFinite(parsedMult) ? parsedMult : 1.5;
    }
    config.goalMode = document.getElementById('cfg-goal-mode').value || 'none';
    config.goalValue = parseFloat(document.getElementById('cfg-goal-value').value) || 0;
    config.goalField = document.getElementById('cfg-goal-field').value;
    config.goalAggregation = document.getElementById('cfg-goal-aggregation').value || 'SUM';
    config.title = document.getElementById('cfg-title').value;
    config.subtitle = document.getElementById('cfg-subtitle').value;
    config.needleColor = document.getElementById('cfg-needle-color').value;
    config.backgroundColor = document.getElementById('cfg-bg-transparent').checked
      ? 'transparent'
      : document.getElementById('cfg-bg-color').value;
    config.valueFontSize = parseInt(document.getElementById('cfg-value-fontsize').value, 10) || 28;
    config.valueColor = document.getElementById('cfg-value-color').value;
    config.arcThickness = parseInt(document.getElementById('cfg-arc-thickness').value, 10) || 30;
    config.valueFormat = document.getElementById('cfg-value-format').value;
    config.currencySymbol = document.getElementById('cfg-currency-symbol').value || '$';
    config.showLabels = document.getElementById('cfg-show-labels').checked;
    config.showTicks = document.getElementById('cfg-show-ticks').checked;
    config.showRangeLabels = document.getElementById('cfg-show-range-labels').checked;
    config.enableFilter = document.getElementById('cfg-enable-filter').checked;
    config.filterField = document.getElementById('cfg-filter-field').value;
    config.enableTooltip = document.getElementById('cfg-enable-tooltip').checked;
    config.animate = document.getElementById('cfg-animate').checked;
    config.gaugeType = document.getElementById('cfg-gauge-type').value || 'semi';
    config.displayMode = document.getElementById('cfg-display-mode').value || 'needle';
    config.trackColor = document.getElementById('cfg-track-color').value || '#e9ecef';
    config.useGradient = document.getElementById('cfg-use-gradient').checked;
    config.percentageMode = document.getElementById('cfg-percentage-mode').value || 'off';
    config.percentDecimals = parseInt(document.getElementById('cfg-percent-decimals').value, 10) || 0;

    if (includeRanges) readRangesFromDom();
  }

  // Read scalar form values into `config` WITHOUT touching config.ranges.
  // The range editor is the source of truth for ranges and is read explicitly
  // by its own input/change handlers, so the live preview must not re-read an
  // (possibly not-yet-rendered) range DOM here.
  function syncConfigFromForm() {
    readConfigFromForm(false);
  }

  // ─── Percentage Mode Helpers ──────────────────────────────────────

  function updatePctHint() {
    const mode = document.getElementById('cfg-percentage-mode').value;
    const hint = document.getElementById('pct-mode-hint');
    const hints = {
      off:       'Percentage formatting is disabled. Use Value Format for manual % display.',
      auto:      '<strong>Auto-Detect:</strong> If min=0 and max≤1, treats data as 0–1 ratios and converts to percentages.',
      pct0to1:   '<strong>0–1 Mode:</strong> Raw values like 0.72 will display as 72%. Set min=0, max=1.',
      pct0to100: '<strong>0–100 Mode:</strong> Values like 72 will display as 72%. Set min=0, max=100.',
    };
    hint.innerHTML = hints[mode] || '';
  }

  function updatePctDecimalsVisibility() {
    const mode = document.getElementById('cfg-percentage-mode').value;
    const group = document.getElementById('pct-decimals-group');
    group.style.display = (mode === 'off') ? 'none' : 'block';
  }

  function applyRangePreset(ranges, minVal, maxVal, pctMode) {
    config.ranges = ranges.map(r => ({ ...r }));
    config.minValue = minVal;
    config.maxValue = maxVal;
    if (pctMode !== undefined) {
      config.percentageMode = pctMode;
      document.getElementById('cfg-percentage-mode').value = pctMode;
      updatePctHint();
      updatePctDecimalsVisibility();
    }
    document.getElementById('cfg-min').value = minVal;
    document.getElementById('cfg-max').value = maxVal;
    document.getElementById('cfg-max-mode').value = 'fixed';
    config.maxMode = 'fixed';
    updateMaxModeVisibility();
    renderRangeList();
    updateValidationPreview();
  }

  // ─── Max Field Source Helper ────────────────────────────────────────

  function updateMaxModeVisibility() {
    const mode = document.getElementById('cfg-max-mode').value || 'fixed';
    const isField = mode === 'field';
    const isRelative = mode === 'relativeGoal';
    const isFixed = !isField && !isRelative;
    document.getElementById('max-fixed-group').style.display = isFixed ? 'block' : 'none';
    document.getElementById('max-field-group').style.display = isField ? 'block' : 'none';
    document.getElementById('max-field-agg-group').style.display = isField ? 'block' : 'none';
    document.getElementById('max-relative-group').style.display = isRelative ? 'block' : 'none';
  }

  // ─── Gauge Type Hint Helper ─────────────────────────────────────────

  function updateGaugeTypeHint() {
    const type = document.getElementById('cfg-gauge-type').value;
    const hint = document.getElementById('gauge-type-hint');
    const hints = {
      semi:            '<strong>Semi-Circular:</strong> Classic 180° half-circle gauge with needle pointer.',
      'three-quarter': '<strong>Three-Quarter:</strong> 270° arc with gap at the bottom. Great for dashboards.',
      linear:          '<strong>Linear:</strong> Horizontal progress bar with vertical marker and color segments.',
    };
    hint.innerHTML = hints[type] || '';
  }

  // ─── Display Mode Helper ────────────────────────────────────────────

  function updateDisplayModeVisibility() {
    const mode = document.getElementById('cfg-display-mode').value || 'needle';
    const showsFill = (mode === 'fill' || mode === 'needle+fill');
    // The neutral background track only matters when a progress fill is drawn.
    document.getElementById('track-color-group').style.display = showsFill ? 'block' : 'none';
    const hint = document.getElementById('display-mode-hint');
    if (hint) {
      const hints = {
        'needle':      '<strong>Needle:</strong> Classic pointer (or marker on Linear). The original look.',
        'fill':        '<strong>Progress Fill:</strong> Fills from Min to the current value, inheriting the colors of the threshold bands it passes through.',
        'needle+fill': '<strong>Needle + Fill (Recommended):</strong> Shows the colored progress fill and a needle/marker at the current value.',
      };
      hint.innerHTML = hints[mode] || '';
    }
  }

  // ─── Goal Reference Helper ──────────────────────────────────────────

  function updateGoalModeVisibility() {
    const mode = document.getElementById('cfg-goal-mode').value || 'none';
    document.getElementById('goal-fixed-group').style.display = (mode === 'fixed') ? 'block' : 'none';
    document.getElementById('goal-field-group').style.display = (mode === 'field') ? 'block' : 'none';
  }

  // ─── Live Validation Preview ───────────────────────────────────────

  function updateValidationPreview() {
    // Pull current form values into config (without re-rendering range rows).
    try { syncConfigFromForm(); } catch (e) { /* ignore during early init */ }

    const result = R.validateResolved(config, currentDataTable);
    const res = result.resolved;

    // Resolved Max / Goal
    let maxDetail;
    if (res.maxSource === 'relativeGoal') {
      // e.g. "150% of Goal"
      maxDetail = R.describeMax(config);
    } else if (res.maxSource === 'field') {
      maxDetail = 'field: ' + (config.maxAggregation || 'MAX') + ' of ' + config.maxField;
    } else {
      maxDetail = 'fixed';
    }
    document.getElementById('vp-max').textContent = R.fmt(res.max) + '  (' + maxDetail + ')';

    if (!res.goalConfigured) {
      document.getElementById('vp-goal').textContent = 'Not set';
    } else if (res.goal === null || !isFinite(res.goal)) {
      document.getElementById('vp-goal').textContent = '⚠ unresolved';
    } else {
      const goalDetail = (config.goalMode === 'fixed')
        ? 'fixed'
        : ((config.goalAggregation || 'SUM') + ' of ' + config.goalField);
      document.getElementById('vp-goal').textContent =
        R.fmt(res.goal) + '  (' + goalDetail + ')';
    }

    // Range starts as colored chips
    const rangesEl = document.getElementById('vp-ranges');
    rangesEl.innerHTML = '';
    if (!res.ranges.length) {
      rangesEl.textContent = '—';
    } else {
      res.ranges.forEach((r, i) => {
        const chip = document.createElement('span');
        chip.className = 'vp-chip';
        const startTxt = isFinite(r.from) ? R.fmt(r.from) : '⚠';
        const endTxt = isFinite(r.to) ? R.fmt(r.to) : '⚠';
        chip.innerHTML = `<span class="vp-swatch" style="background:${r.color}"></span>` +
          `${escapeHtml(r.label || ('R' + (i + 1)))}: ${startTxt} → ${endTxt}`;
        rangesEl.appendChild(chip);
      });
    }

    // Per-row resolved readout inside each range item
    document.querySelectorAll('#range-list .range-resolved').forEach((el) => {
      const idx = parseInt(el.dataset.idx, 10);
      const rr = res.ranges[idx];
      if (rr) {
        const startTxt = isFinite(rr.from) ? R.fmt(rr.from) : '⚠ invalid';
        const endTxt = isFinite(rr.to) ? R.fmt(rr.to) : '⚠';
        const mode = rr.startMode || 'fixed';
        // Show the boundary formula for relative modes, e.g. "100% of Goal".
        const detail = (mode === 'fixed') ? '' : ' <span class="rr-detail">(' + escapeHtml(R.describeRangeStart(rr)) + ')</span>';
        el.innerHTML = `Resolved: <strong>${startTxt}</strong>${detail} → <strong>${endTxt}</strong>`;
      }
    });

    // Warnings
    const warnBox = document.getElementById('validation-warnings');
    const saveBtn = document.getElementById('config-save-btn');
    if (result.warnings.length) {
      warnBox.style.display = 'block';
      warnBox.innerHTML = '<div class="vw-title">⚠ ' + result.warnings.length +
        ' issue' + (result.warnings.length > 1 ? 's' : '') + ' found</div><ul>' +
        result.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>';
      if (saveBtn) {
        saveBtn.classList.add('btn-has-warnings');
        saveBtn.textContent = 'Save Anyway';
      }
    } else {
      warnBox.style.display = 'none';
      warnBox.innerHTML = '';
      if (saveBtn) {
        saveBtn.classList.remove('btn-has-warnings');
        saveBtn.textContent = 'Save & Apply';
      }
    }

    // Plain-language summary sentence, e.g.
    // "Current Goal is $100. Max is 150% of Goal ($150). Ranges: 0–80 (Red), …"
    const summaryEl = document.getElementById('vp-summary');
    if (summaryEl) {
      try {
        summaryEl.textContent = R.buildSummarySentence(config, currentDataTable);
      } catch (e) {
        summaryEl.textContent = '';
      }
    }

    return result;
  }

  // ─── Event Wiring ──────────────────────────────────────────────────

  function wireEvents() {
    // Tabs
    document.querySelectorAll('.config-tab').forEach(tab => {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.config-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.config-tab-content').forEach(c => c.classList.remove('active'));
        this.classList.add('active');
        document.getElementById(this.dataset.tab).classList.add('active');
        updateValidationPreview();
      });
    });

    // Worksheet change → refresh measures + fields + preview
    document.getElementById('cfg-worksheet').addEventListener('change', populateMeasures);

    // Arc thickness slider
    document.getElementById('cfg-arc-thickness').addEventListener('input', function () {
      document.getElementById('arc-thickness-display').textContent = this.value + '%';
    });

    // Background transparency toggle
    document.getElementById('cfg-bg-transparent').addEventListener('change', function () {
      document.getElementById('cfg-bg-color').disabled = this.checked;
    });

    // Gauge type change
    document.getElementById('cfg-gauge-type').addEventListener('change', updateGaugeTypeHint);

    // Display mode change → toggle track color + refresh hint/preview
    document.getElementById('cfg-display-mode').addEventListener('change', function () {
      updateDisplayModeVisibility();
      updateValidationPreview();
    });

    // Goal source change → toggle fixed/field inputs + refresh preview
    document.getElementById('cfg-goal-mode').addEventListener('change', function () {
      updateGoalModeVisibility();
      updateValidationPreview();
    });

    // Max value source change → toggle inputs + refresh preview
    document.getElementById('cfg-max-mode').addEventListener('change', function () {
      updateMaxModeVisibility();
      updateValidationPreview();
    });

    // Inputs that affect resolved Max / Goal / ranges → live preview
    ['cfg-min', 'cfg-max', 'cfg-max-field', 'cfg-max-aggregation', 'cfg-max-multiplier',
     'cfg-goal-value', 'cfg-goal-field', 'cfg-goal-aggregation', 'cfg-track-color'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', updateValidationPreview);
        el.addEventListener('input', updateValidationPreview);
      }
    });

    // Percentage mode change
    document.getElementById('cfg-percentage-mode').addEventListener('change', function () {
      updatePctHint();
      updatePctDecimalsVisibility();
      const mode = this.value;
      if (mode === 'pct0to1') {
        document.getElementById('cfg-min').value = 0;
        document.getElementById('cfg-max').value = 1;
      } else if (mode === 'pct0to100') {
        document.getElementById('cfg-min').value = 0;
        document.getElementById('cfg-max').value = 100;
      }
      updateValidationPreview();
    });

    // Range presets (v2 model)
    document.getElementById('preset-default').addEventListener('click', function () {
      applyRangePreset([
        { label: 'Low',    color: '#dc3545', startMode: 'fixed', startValue: 0 },
        { label: 'Medium', color: '#ffc107', startMode: 'fixed', startValue: 33 },
        { label: 'High',   color: '#28a745', startMode: 'fixed', startValue: 66 },
      ], 0, 100, 'off');
    });
    document.getElementById('preset-pct3').addEventListener('click', function () {
      applyRangePreset([
        { label: 'Low',    color: '#dc3545', startMode: 'fixed', startValue: 0 },
        { label: 'Medium', color: '#ffc107', startMode: 'fixed', startValue: 0.33 },
        { label: 'High',   color: '#28a745', startMode: 'fixed', startValue: 0.66 },
      ], 0, 1, 'pct0to1');
    });
    document.getElementById('preset-pct4').addEventListener('click', function () {
      applyRangePreset([
        { label: 'Critical', color: '#dc3545', startMode: 'fixed', startValue: 0 },
        { label: 'Low',      color: '#fd7e14', startMode: 'fixed', startValue: 0.25 },
        { label: 'Medium',   color: '#ffc107', startMode: 'fixed', startValue: 0.50 },
        { label: 'High',     color: '#28a745', startMode: 'fixed', startValue: 0.75 },
      ], 0, 1, 'pct0to1');
    });
    document.getElementById('preset-pct100-3').addEventListener('click', function () {
      applyRangePreset([
        { label: 'Low',    color: '#dc3545', startMode: 'fixed', startValue: 0 },
        { label: 'Medium', color: '#ffc107', startMode: 'fixed', startValue: 33 },
        { label: 'High',   color: '#28a745', startMode: 'fixed', startValue: 66 },
      ], 0, 100, 'pct0to100');
    });

    // Add range
    document.getElementById('add-range-btn').addEventListener('click', function () {
      readRangesFromDom();
      const last = config.ranges[config.ranges.length - 1];
      let nextStart = 0;
      if (last && (last.startMode === 'fixed' || last.startMode === 'pctMax' || last.startMode === 'pctGoal')) {
        nextStart = (parseFloat(last.startValue) || 0) + (last.startMode === 'fixed' ? 10 : 10);
      }
      config.ranges.push({
        label: '',
        color: '#4a90d9',
        startMode: last ? last.startMode : 'fixed',
        startValue: nextStart,
      });
      renderRangeList();
      updateValidationPreview();
    });

    // Range list interactions (delegated): remove, start-mode change, live edits
    const rangeList = document.getElementById('range-list');

    rangeList.addEventListener('click', function (e) {
      if (e.target.classList.contains('remove-range-btn')) {
        const idx = parseInt(e.target.dataset.idx, 10);
        readRangesFromDom();
        config.ranges.splice(idx, 1);
        renderRangeList();
        updateValidationPreview();
      }
    });

    rangeList.addEventListener('change', function (e) {
      if (e.target.classList.contains('range-startmode')) {
        // Re-render so the value input shows/hides for "Goal Field Value".
        readRangesFromDom();
        const idx = parseInt(e.target.dataset.idx, 10);
        if (config.ranges[idx]) config.ranges[idx].startMode = e.target.value;
        renderRangeList();
        updateValidationPreview();
      } else {
        updateValidationPreview();
      }
    });

    rangeList.addEventListener('input', function () {
      // Live preview while typing in label / value / color.
      readRangesFromDom();
      updateValidationPreview();
    });

    // ─── SAVE ─────────────────────────────────────────────────────
    document.getElementById('config-save-btn').addEventListener('click', async function () {
      console.log('[Config] Save button clicked.');
      readConfigFromForm();

      // Final pre-apply validation. Warnings do not hard-block saving (the user
      // may intentionally save a work-in-progress), but we surface them clearly
      // and ask for confirmation when present.
      const result = updateValidationPreview();
      if (result.warnings.length) {
        const proceed = window.confirm(
          'There ' + (result.warnings.length > 1 ? 'are ' + result.warnings.length + ' validation issues' : 'is 1 validation issue') +
          ' with the current configuration:\n\n• ' +
          result.warnings.join('\n• ') +
          '\n\nSave anyway?'
        );
        if (!proceed) return;
      }

      console.log('[Config] Config to save:', JSON.stringify(config));
      try {
        await saveSettings();
        console.log('[Config] Settings saved. Closing dialog...');
        tableau.extensions.ui.closeDialog('saved');
      } catch (err) {
        console.error('[Config] Error saving settings:', err);
        alert('Error saving settings: ' + err.message);
      }
    });

    // ─── CANCEL ───────────────────────────────────────────────────
    document.getElementById('config-cancel-btn').addEventListener('click', function () {
      console.log('[Config] Cancel clicked. Closing dialog...');
      tableau.extensions.ui.closeDialog('cancelled');
    });
  }

})();
