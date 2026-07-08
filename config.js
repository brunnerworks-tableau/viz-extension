/**
 * Semi-Circular Gauge Chart — Configuration Dialog
 *
 * This file runs inside the Tableau popup dialog opened via displayDialogAsync().
 * It uses initializeDialogAsync() (NOT initializeAsync) and closeDialog() to
 * communicate with the parent extension (gauge.js).
 */

(function () {
  'use strict';

  const DEFAULT_CONFIG = {
    worksheet: '',
    measure: '',
    aggregation: 'SUM',
    minValue: 0,
    maxValue: 100,
    title: 'Gauge',
    subtitle: '',
    ranges: [
      { from: 0, to: 33, color: '#dc3545', label: 'Low' },
      { from: 33, to: 66, color: '#ffc107', label: 'Medium' },
      { from: 66, to: 100, color: '#28a745', label: 'High' },
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
    // Gauge type: 'semi' | 'three-quarter' | 'linear'
    gaugeType: 'semi',
    // Smooth gradient transitions between color bands
    useGradient: false,
    // Percentage mode: 'off' | 'auto' | 'pct0to1' | 'pct0to100'
    percentageMode: 'off',
    percentDecimals: 0,
  };

  let config = { ...DEFAULT_CONFIG, ranges: DEFAULT_CONFIG.ranges.map(r => ({ ...r })) };

  // ─── Initialize Dialog ─────────────────────────────────────────────

  console.log('[Config] Dialog script loaded. Initializing...');

  tableau.extensions.initializeDialogAsync().then(function (openPayload) {
    console.log('[Config] Dialog initialized. Payload:', openPayload);

    // Load existing settings
    loadSettings();

    // Populate the form
    populateConfigForm();

    // Wire up UI events
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
        config = { ...DEFAULT_CONFIG, ...parsed, ranges: (parsed.ranges || DEFAULT_CONFIG.ranges).map(r => ({ ...r })) };
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
    // Worksheets
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

    // Measures for currently selected worksheet
    await populateMeasures();

    // Fill all form fields
    document.getElementById('cfg-aggregation').value = config.aggregation;
    document.getElementById('cfg-min').value = config.minValue;
    document.getElementById('cfg-max').value = config.maxValue;
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

    // Gauge type
    document.getElementById('cfg-gauge-type').value = config.gaugeType || 'semi';
    updateGaugeTypeHint();

    // Gradient toggle
    document.getElementById('cfg-use-gradient').checked = config.useGradient || false;

    // Percentage mode fields
    document.getElementById('cfg-percentage-mode').value = config.percentageMode || 'off';
    document.getElementById('cfg-percent-decimals').value = config.percentDecimals || 0;
    updatePctHint();
    updatePctDecimalsVisibility();

    renderRangeList();
  }

  async function populateMeasures() {
    const wsName = document.getElementById('cfg-worksheet').value;
    const measureSelect = document.getElementById('cfg-measure');
    const filterSelect = document.getElementById('cfg-filter-field');
    measureSelect.innerHTML = '<option value="">— Select measure —</option>';
    filterSelect.innerHTML = '<option value="">— Same as measure —</option>';

    if (!wsName) return;

    try {
      const dashboard = tableau.extensions.dashboardContent.dashboard;
      const ws = dashboard.worksheets.find(w => w.name === wsName);
      if (!ws) return;

      const dataTable = await ws.getSummaryDataAsync();
      console.log('[Config] Columns for', wsName + ':', dataTable.columns.map(c => c.fieldName));

      dataTable.columns.forEach(col => {
        const opt1 = document.createElement('option');
        opt1.value = col.fieldName;
        opt1.textContent = col.fieldName;
        if (col.fieldName === config.measure) opt1.selected = true;
        measureSelect.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = col.fieldName;
        opt2.textContent = col.fieldName;
        if (col.fieldName === config.filterField) opt2.selected = true;
        filterSelect.appendChild(opt2);
      });
    } catch (e) {
      console.warn('[Config] Could not fetch columns for', wsName, e);
    }
  }

  // ─── Range List UI ─────────────────────────────────────────────────

  function renderRangeList() {
    const list = document.getElementById('range-list');
    list.innerHTML = '';
    config.ranges.forEach((range, idx) => {
      const item = document.createElement('div');
      item.className = 'range-item';
      item.innerHTML = `
        <input type="color" class="range-color" data-idx="${idx}" value="${range.color}" title="Color" />
        <input type="number" class="range-from" data-idx="${idx}" value="${range.from}" placeholder="From" title="From" />
        <span style="color:#999;">–</span>
        <input type="number" class="range-to" data-idx="${idx}" value="${range.to}" placeholder="To" title="To" />
        <input type="text" class="range-label-input" data-idx="${idx}" value="${range.label || ''}" placeholder="Label" title="Label" />
        <button class="remove-range-btn" data-idx="${idx}" title="Remove">&times;</button>
      `;
      list.appendChild(item);
    });
  }

  function readRangesFromDom() {
    config.ranges = [];
    document.querySelectorAll('.range-item').forEach(item => {
      config.ranges.push({
        from: parseFloat(item.querySelector('.range-from').value) || 0,
        to: parseFloat(item.querySelector('.range-to').value) || 0,
        color: item.querySelector('.range-color').value,
        label: item.querySelector('.range-label-input').value,
      });
    });
  }

  // ─── Read Config from Form ─────────────────────────────────────────

  function readConfigFromForm() {
    config.worksheet = document.getElementById('cfg-worksheet').value;
    config.measure = document.getElementById('cfg-measure').value;
    config.aggregation = document.getElementById('cfg-aggregation').value;
    config.minValue = parseFloat(document.getElementById('cfg-min').value) || 0;
    config.maxValue = parseFloat(document.getElementById('cfg-max').value) || 100;
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

    // Gauge type
    config.gaugeType = document.getElementById('cfg-gauge-type').value || 'semi';

    // Gradient
    config.useGradient = document.getElementById('cfg-use-gradient').checked;

    // Percentage mode
    config.percentageMode = document.getElementById('cfg-percentage-mode').value || 'off';
    config.percentDecimals = parseInt(document.getElementById('cfg-percent-decimals').value, 10) || 0;

    // Ranges
    readRangesFromDom();
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
    renderRangeList();
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

  // ─── Event Wiring ──────────────────────────────────────────────────

  function wireEvents() {
    // Tabs
    document.querySelectorAll('.config-tab').forEach(tab => {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.config-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.config-tab-content').forEach(c => c.classList.remove('active'));
        this.classList.add('active');
        document.getElementById(this.dataset.tab).classList.add('active');
      });
    });

    // Worksheet change → refresh measures
    document.getElementById('cfg-worksheet').addEventListener('change', populateMeasures);

    // Arc thickness slider
    document.getElementById('cfg-arc-thickness').addEventListener('input', function () {
      document.getElementById('arc-thickness-display').textContent = this.value + '%';
    });

    // Background transparency toggle — disable the color picker when transparent
    document.getElementById('cfg-bg-transparent').addEventListener('change', function () {
      document.getElementById('cfg-bg-color').disabled = this.checked;
    });

    // Gauge type change
    document.getElementById('cfg-gauge-type').addEventListener('change', function () {
      updateGaugeTypeHint();
    });

    // Percentage mode change
    document.getElementById('cfg-percentage-mode').addEventListener('change', function () {
      updatePctHint();
      updatePctDecimalsVisibility();
      // Auto-suggest min/max when switching percentage modes
      const mode = this.value;
      if (mode === 'pct0to1') {
        document.getElementById('cfg-min').value = 0;
        document.getElementById('cfg-max').value = 1;
      } else if (mode === 'pct0to100') {
        document.getElementById('cfg-min').value = 0;
        document.getElementById('cfg-max').value = 100;
      }
    });

    // Range preset buttons
    document.getElementById('preset-default').addEventListener('click', function () {
      applyRangePreset([
        { from: 0, to: 33, color: '#dc3545', label: 'Low' },
        { from: 33, to: 66, color: '#ffc107', label: 'Medium' },
        { from: 66, to: 100, color: '#28a745', label: 'High' },
      ], 0, 100, 'off');
    });

    document.getElementById('preset-pct3').addEventListener('click', function () {
      applyRangePreset([
        { from: 0, to: 0.33, color: '#dc3545', label: 'Low' },
        { from: 0.33, to: 0.66, color: '#ffc107', label: 'Medium' },
        { from: 0.66, to: 1, color: '#28a745', label: 'High' },
      ], 0, 1, 'pct0to1');
    });

    document.getElementById('preset-pct4').addEventListener('click', function () {
      applyRangePreset([
        { from: 0, to: 0.25, color: '#dc3545', label: 'Critical' },
        { from: 0.25, to: 0.50, color: '#fd7e14', label: 'Low' },
        { from: 0.50, to: 0.75, color: '#ffc107', label: 'Medium' },
        { from: 0.75, to: 1, color: '#28a745', label: 'High' },
      ], 0, 1, 'pct0to1');
    });

    document.getElementById('preset-pct100-3').addEventListener('click', function () {
      applyRangePreset([
        { from: 0, to: 33, color: '#dc3545', label: 'Low' },
        { from: 33, to: 66, color: '#ffc107', label: 'Medium' },
        { from: 66, to: 100, color: '#28a745', label: 'High' },
      ], 0, 100, 'pct0to100');
    });

    // Add range
    document.getElementById('add-range-btn').addEventListener('click', function () {
      readRangesFromDom();
      const last = config.ranges[config.ranges.length - 1];
      config.ranges.push({
        from: last ? last.to : 0,
        to: last ? last.to + 10 : 10,
        color: '#4a90d9',
        label: '',
      });
      renderRangeList();
    });

    // Remove range (delegated)
    document.getElementById('range-list').addEventListener('click', function (e) {
      if (e.target.classList.contains('remove-range-btn')) {
        const idx = parseInt(e.target.dataset.idx, 10);
        readRangesFromDom();
        config.ranges.splice(idx, 1);
        renderRangeList();
      }
    });

    // ─── SAVE: read form → save settings → close dialog ─────────────
    document.getElementById('config-save-btn').addEventListener('click', async function () {
      console.log('[Config] Save button clicked.');
      readConfigFromForm();
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

    // ─── CANCEL: close dialog without saving ─────────────────────────
    document.getElementById('config-cancel-btn').addEventListener('click', function () {
      console.log('[Config] Cancel clicked. Closing dialog...');
      tableau.extensions.ui.closeDialog('cancelled');
    });
  }

})();
