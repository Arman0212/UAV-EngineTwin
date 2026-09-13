/**
 * ENGINE-TWIN: Glass Cockpit Ground Station Controller
 *
 * 20 Hz telemetry (WebSocket → SSE → polling fallback), multi-channel
 * charting, calibrated anomaly indexing, event logging and the scripted
 * demonstration arc.
 *
 * ANNUNCIATION DOCTRINE — see theme.css. No colour is defined in this file;
 * every value comes from THEME, which reads the CSS custom properties.
 */

/* ------------------------------------------------------------------
 * THEME TOKENS
 * Read straight off :root in theme.css so CSS stays the only place a
 * colour is ever defined. Canvas and WebGL layers consume these.
 * ---------------------------------------------------------------- */
// Apply saved theme early so initial paint matches user preference (defaults to 'light')
const CURRENT_THEME = (() => {
  try {
    return localStorage.getItem('engine_twin_theme') || 'light';
  } catch (e) {
    return 'light';
  }
})();
document.documentElement.setAttribute('data-theme', CURRENT_THEME);

const THEME = (() => {
  const css = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  };
  const t = {
    /* Surfaces — three levels, so a panel separates from the page by tone
       rather than by a drawn border. */
    bgPage:     css('--bg-page', '#151D28'),
    bgPanel:    css('--bg-panel', '#1E2938'),
    bgElevated: css('--bg-elevated', '#2B384C'),
    border:       css('--border', '#36465D'),
    borderStrong: css('--border-strong', '#4D6282'),

    textPrimary:   css('--text-primary', '#F3F6FA'),
    textSecondary: css('--text-secondary', '#A2B4CA'),
    textMuted:     css('--text-muted', '#6F849E'),

    /* Semantic state, on the existing 85/70/50/25 health bands. */
    nominal:  css('--nominal',  '#3DD68C'),
    advisory: css('--advisory', '#6BC4E8'),
    caution:  css('--caution',  '#F0B429'),
    warning:  css('--warning',  '#F2822C'),
    critical: css('--critical', '#E5484D'),

    /* UI accent. Selection and focus only — never state. */
    accent: css('--accent', '#4C8DFF'),

    /* Chart furniture. */
    modelExpected: css('--model-expected', '#8598AD'),
    grid:          css('--grid', '#28374A'),

    /* Per-cylinder identity. Index 0..3 is cylinder 1..4, and this is the
       single source for that mapping: charts, tiles, the 3D model and the
       attribution bars all read it, so cylinder 3 is one colour everywhere. */
    cyl: [
      css('--cyl-1', '#56C6F5'),
      css('--cyl-2', '#7B94FF'),
      css('--cyl-3', '#A78BFA'),
      css('--cyl-4', '#DE7BD0')
    ],
    cylBand: [
      css('--cyl-1-band', 'rgba(86, 198, 245, 0.10)'),
      css('--cyl-2-band', 'rgba(123, 148, 255, 0.10)'),
      css('--cyl-3-band', 'rgba(167, 139, 250, 0.10)'),
      css('--cyl-4-band', 'rgba(222, 123, 208, 0.10)')
    ],
    cautionBand: css('--caution-band', 'rgba(240, 180, 41, 0.13)'),
    warningBand: css('--warning-band', 'rgba(229, 72, 77, 0.13)'),

    fontMono: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
    fontSans: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
    fsTick: 11
  };
  /* Back-compat aliases: older call sites still reference these names. */
  t.ok = t.nominal;
  t.instrument = t.accent;
  t.instrumentDim = t.modelExpected;
  t.textDim = t.textMuted;
  t.bgChrome = t.bgPanel;
  t.trace = t.cyl;
  t.hex = (c) => parseInt(String(c).replace('#', ''), 16);

  t.refresh = () => {
    t.bgPage = css('--bg-page', '#151D28');
    t.bgPanel = css('--bg-panel', '#1E2938');
    t.bgElevated = css('--bg-elevated', '#2B384C');
    t.border = css('--border', '#36465D');
    t.borderStrong = css('--border-strong', '#4D6282');
    t.textPrimary = css('--text-primary', '#F3F6FA');
    t.textSecondary = css('--text-secondary', '#A2B4CA');
    t.textMuted = css('--text-muted', '#6F849E');
    t.nominal = css('--nominal', '#3DD68C');
    t.advisory = css('--advisory', '#6BC4E8');
    t.caution = css('--caution', '#F0B429');
    t.warning = css('--warning', '#F2822C');
    t.critical = css('--critical', '#E5484D');
    t.accent = css('--accent', '#4C8DFF');
    t.modelExpected = css('--model-expected', '#8598AD');
    t.grid = css('--grid', '#28374A');
    t.cyl = [
      css('--cyl-1', '#56C6F5'),
      css('--cyl-2', '#7B94FF'),
      css('--cyl-3', '#A78BFA'),
      css('--cyl-4', '#DE7BD0')
    ];
    t.cylBand = [
      css('--cyl-1-band', 'rgba(86, 198, 245, 0.10)'),
      css('--cyl-2-band', 'rgba(123, 148, 255, 0.10)'),
      css('--cyl-3-band', 'rgba(167, 139, 250, 0.10)'),
      css('--cyl-4-band', 'rgba(222, 123, 208, 0.10)')
    ];
    t.cautionBand = css('--caution-band', 'rgba(240, 180, 41, 0.13)');
    t.warningBand = css('--warning-band', 'rgba(229, 72, 77, 0.13)');
    t.ok = t.nominal;
    t.instrument = t.accent;
    t.instrumentDim = t.modelExpected;
    t.textDim = t.textMuted;
    t.bgChrome = t.bgPanel;
    t.trace = t.cyl;
  };

  /* Health band -> semantic colour. The 85/70/50/25 thresholds are the
     existing ones; only the hues resolve here. */
  t.forHealth = (h) => h >= 85 ? t.nominal
                     : h >= 70 ? t.advisory
                     : h >= 50 ? t.caution
                     : h >= 25 ? t.warning
                     : t.critical;
  return t;
})();

/* ------------------------------------------------------------------
 * TOLERANCE ENVELOPES
 * Caution = out of tolerance (amber). Limit = hard exceedance (red).
 * These drive the chart bands, the trace colouring and the 3D model.
 * ---------------------------------------------------------------- */
const LIMITS = {
  egt:     { caution: 880,  limit: 950,  min: 0,   max: 1000 },
  cht:     { caution: 190,  limit: 215 },
  oilP:    { cautionLow: 3.0, limitLow: 2.0, min: 0, max: 7 },
  vib:     { caution: 2.5,  limit: 4.0,  min: 0,   max: 6 }
};

// Health annunciation thresholds (percent).
const CAUTION_BELOW = 85.0;
const WARNING_BELOW = 50.0;

const MAX_HISTORY = 40;
let ws = null;
let engine3D = null;
let charts = {};

// Audio synthesizer state
let audioCtx = null;
let isAudioMuted = true;
let lastAudioAlertTime = 0;

// Active system & fault state (cached for zero-flicker rendering)
let currentActiveFault = "HEALTHY";
let latestTwinState = null;    // most recent frame, for the component inspector
let lastActiveFaultButton = null;
let lastShapSignature = "";
let lastOverallStatus = "";
let eventLogs = [];
let maxEventLogs = 30;

// RUL revision tracking — the previous range stays on screen as evidence.
let rulCurrent = null;      // { min, max }
let rulSettledFlag = null;  // whether updateRul's window settled this frame
let rulPrevious = null;     // { min, max }

// Auto demo state machine
let autoDemoActive = false;
let autoDemoTimer = null;
let autoDemoStep = 0;
let autoDemoTimeRemaining = 0;

// Chart rendering throttle
let lastChartUpdateTime = 0;
const CHART_UPDATE_INTERVAL_MS = 100; // 10 Hz

// Telemetry history buffers
const historyData = {
  time: [], t_s: [],
  sensor_egt1: [], sensor_egt2: [], sensor_egt3: [], sensor_egt4: [],
  mvem_egt: [],
  mvem_egt1: [], mvem_egt2: [], mvem_egt3: [], mvem_egt4: [],
  sensor_oil_p: [], mvem_oil_p: [],
  sensor_map: [], mvem_map: [],
  sensor_vib: [], mvem_vib: []
};

/* Per-channel measurement sigma, matching digital_twin/health_index.py. The
   +/-3 sigma envelope drawn on the charts is the same tolerance the residual
   normalisation divides by, so "the trace left the band" on screen and "the
   residual exceeded 3 sigma" in the health index are the same statement. */
const SIGMA = { egt: 3.5, cht: 1.8, oilP: 0.06, map: 0.02, vib: 0.08 };
const ENVELOPE_K = 3;

/* Axis autoscaling. Recomputed on a slow cadence rather than every frame: a
   range that chases the data jitters, and a jittering axis is harder to read
   than a slightly stale one. */
const AXIS_RESCALE_MS = 2500;
let lastAxisRescale = 0;

// ------------------------------------------------------------------
// DOM HELPERS
// ------------------------------------------------------------------
function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.innerText !== text) el.innerText = text;
}

// Sets an element's annunciation state attribute. "nominal" clears it.
function setState(el, st) {
  if (!el) return;
  if (!st || st === "nominal") {
    if (el.hasAttribute("data-state")) el.removeAttribute("data-state");
  } else if (el.getAttribute("data-state") !== st) {
    el.setAttribute("data-state", st);
  }
}
function setPanelState(panelId, st) { setState(document.getElementById(panelId), st); }

// Annunciator hysteresis: a state must be cleared by a margin before it
// releases, so a value hovering on a threshold does not strobe the display.
const HYSTERESIS = 2.5;
const lastHealthState = {};

function healthState(pct, key) {
  const prev = key ? lastHealthState[key] : null;
  let st;
  if (pct < WARNING_BELOW) st = "warning";
  else if (pct < CAUTION_BELOW) st = "caution";
  else st = "nominal";

  if (prev && st !== prev) {
    // Releasing to a less severe state requires clearing the threshold by
    // the hysteresis margin; escalating is immediate.
    if (prev === "warning" && pct < WARNING_BELOW + HYSTERESIS) st = "warning";
    else if (prev === "caution" && st === "nominal" && pct < CAUTION_BELOW + HYSTERESIS) st = "caution";
  }
  if (key) lastHealthState[key] = st;
  return st;
}

// Applies an annunciation state to a numeral and, optionally, its tile.
// Length of the gauge arc path, in user units. The semicircle is r=42, so
// pi*r = 131.9; it is stated once here and in the markup's dasharray.
const GAUGE_ARC_LEN = 131.9;

function setMetric(valueId, text, pct, tileId) {
  const st = healthState(pct, valueId);
  const el = document.getElementById(valueId);
  if (el) {
    if (el.innerText !== text) el.innerText = text;
    const cls = st === "warning" ? "is-warning" : (st === "caution" ? "is-caution" : "");
    if (el.className !== cls) el.className = cls;
  }
  if (tileId) setState(document.getElementById(tileId), st);

  // The arc carries the same number the label does. Six identical "100.0 %"
  // readouts had to all be read to know the state; a collapsing arc does not.
  const arc = document.getElementById(valueId.replace('val-health-', 'arc-health-'));
  if (arc) {
    const frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    arc.style.strokeDashoffset = (GAUGE_ARC_LEN * (1 - frac)).toFixed(2);
    arc.style.stroke = THEME.forHealth(Number(pct) || 0);
  }
}

// Envelope check for a rising parameter (EGT, CHT, vibration).
function bandStateHigh(v, caution, limit) {
  if (v >= limit) return "warning";
  if (v >= caution) return "caution";
  return "nominal";
}
// Envelope check for a falling parameter (oil pressure).
function bandStateLow(v, cautionLow, limitLow) {
  if (v <= limitLow) return "warning";
  if (v <= cautionLow) return "caution";
  return "nominal";
}

// ------------------------------------------------------------------
// THEME MANAGEMENT (Daylight / Night)
// ------------------------------------------------------------------
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  setTheme(next);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('engine_twin_theme', theme); } catch (e) {}
  syncThemeButton(theme);
  updateChartsTheme();
}

function syncThemeButton(theme) {
  const current = theme || document.documentElement.getAttribute('data-theme') || 'dark';
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    btn.innerHTML = current === 'light' ? '🌙 Night' : '☀️ Day';
    btn.title = current === 'light' ? 'Switch to Night/Dark theme' : 'Switch to Daylight/Bright theme';
  }
}

function updateChartsTheme() {
  THEME.refresh();
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = THEME.textMuted;
  }
  const gridY = { color: THEME.grid, lineWidth: 1, drawTicks: false, drawOnChartArea: true };

  if (charts.temp) {
    charts.temp.options.scales.x.border = { color: THEME.border };
    charts.temp.options.scales.x.ticks.color = THEME.textMuted;
    charts.temp.options.scales.y.grid = gridY;
    charts.temp.options.scales.y.border = { color: THEME.border };
    charts.temp.options.scales.y.ticks.color = THEME.textMuted;
    charts.temp.options.scales.y.title.color = THEME.textMuted;
    if (charts.temp.options.plugins && charts.temp.options.plugins.legend) {
      charts.temp.options.plugins.legend.labels.color = THEME.textMuted;
    }
    if (charts.temp.data.datasets[0]) charts.temp.data.datasets[0].borderColor = THEME.cyl[0];
    if (charts.temp.data.datasets[1]) charts.temp.data.datasets[1].borderColor = THEME.cyl[1];
    if (charts.temp.data.datasets[2]) charts.temp.data.datasets[2].borderColor = THEME.cyl[2];
    if (charts.temp.data.datasets[3]) charts.temp.data.datasets[3].borderColor = THEME.cyl[3];
    if (charts.temp.data.datasets[4]) charts.temp.data.datasets[4].borderColor = THEME.modelExpected;
    charts.temp.update('none');
  }
  if (charts.pressures) {
    charts.pressures.options.scales.x.border = { color: THEME.border };
    charts.pressures.options.scales.x.ticks.color = THEME.textMuted;
    charts.pressures.options.scales.y.grid = gridY;
    charts.pressures.options.scales.y.border = { color: THEME.border };
    charts.pressures.options.scales.y.ticks.color = THEME.textMuted;
    charts.pressures.options.scales.y.title.color = THEME.textMuted;
    charts.pressures.options.scales.y1.border = { color: THEME.border };
    charts.pressures.options.scales.y1.ticks.color = THEME.textMuted;
    charts.pressures.options.scales.y1.title.color = THEME.textMuted;
    if (charts.pressures.options.plugins && charts.pressures.options.plugins.legend) {
      charts.pressures.options.plugins.legend.labels.color = THEME.textMuted;
    }
    if (charts.pressures.data.datasets[0]) charts.pressures.data.datasets[0].borderColor = THEME.cyl[0];
    if (charts.pressures.data.datasets[1]) charts.pressures.data.datasets[1].borderColor = THEME.modelExpected;
    if (charts.pressures.data.datasets[2]) charts.pressures.data.datasets[2].borderColor = THEME.cyl[2];
    if (charts.pressures.data.datasets[3]) charts.pressures.data.datasets[3].borderColor = THEME.modelExpected;
    charts.pressures.update('none');
  }
  if (charts.vibration) {
    charts.vibration.options.scales.x.border = { color: THEME.border };
    charts.vibration.options.scales.x.ticks.color = THEME.textMuted;
    charts.vibration.options.scales.y.grid = gridY;
    charts.vibration.options.scales.y.border = { color: THEME.border };
    charts.vibration.options.scales.y.ticks.color = THEME.textMuted;
    charts.vibration.options.scales.y.title.color = THEME.textMuted;
    charts.vibration.options.scales.y1.border = { color: THEME.border };
    charts.vibration.options.scales.y1.ticks.color = THEME.textMuted;
    charts.vibration.options.scales.y1.title.color = THEME.textMuted;
    if (charts.vibration.options.plugins && charts.vibration.options.plugins.legend) {
      charts.vibration.options.plugins.legend.labels.color = THEME.textMuted;
    }
    if (charts.vibration.data.datasets[0]) charts.vibration.data.datasets[0].borderColor = THEME.cyl[0];
    if (charts.vibration.data.datasets[1]) charts.vibration.data.datasets[1].borderColor = THEME.modelExpected;
    charts.vibration.update('none');
  }

  if (typeof engine3D !== 'undefined' && engine3D && typeof engine3D.updateTheme === 'function') {
    engine3D.updateTheme();
  }
}

// ------------------------------------------------------------------
// 1. INITIALIZATION
// ------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  console.log("ENGINE-TWIN GCS Controller Initialized.");
  syncThemeButton();

  if (typeof Engine3DView !== "undefined") {
    try {
      engine3D = new Engine3DView("container-3d");
      // The model owns picking; the station owns what a selection means.
      engine3D.onSelect = onComponentSelected;
    } catch (e) { console.warn("3D View Init Warning:", e); }
  }

  try { initCharts(); }
  catch (e) { console.error("Charts Init Error:", e); }

  connectWebSocket();
  addEventLog("SYS", "Ground station connected to telemetry stream at 20 Hz.");

  // Shape the model to the engine that is actually fitted, before anyone opens
  // the engine panel. Otherwise a fitted six-cylinder engine is drawn with the
  // reference engine's four jugs and the display contradicts the telemetry.
  refreshEngines();

  // Boot into mid-degradation. A screen of 100.0% readings demonstrates
  // nothing; the station should open already having something to say.
  setTimeout(bootDegradedScenario, 400);
});

/**
 * Opening condition: a partially degraded turbocharger.
 *
 * Severity and ramp are measured against the models rather than picked for
 * looks. At 0.38 over an 8 s ramp the health index sits near 73-76% overall
 * with the boost subsystem around 45-50%, and the classifier holds the
 * correct diagnosis on 97-100% of frames - stable enough that the diagnosis
 * panel, attribution, recommended action and 3D highlight all agree.
 * Lower severities leave the classifier flapping against HEALTHY; higher
 * ones read as a failed engine rather than a degrading one.
 */
const BOOT_SCENARIO = {
  fault_type: 'TURBO_BOOST_DEFICIENCY',
  severity: 0.38,
  ramp_duration_s: 8.0
};

function bootDegradedScenario() {
  fetch('/api/fault/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(BOOT_SCENARIO)
  }).catch(() => {});
  // Deliberately logs nothing here. The previous version wrote "Opening
  // condition: turbocharger boost deficiency, 38% severity" the instant this
  // POST resolved -- before the twin had ramped the fault, and with nothing to
  // retract it if the fault was later cleared. That produced three panels
  // contradicting each other on screen: an open turbo condition in the log,
  // HEALTHY at severity 0.00 in the diagnosis panel, and all channels within
  // tolerance in attribution. Conditions are now logged by logConditionChange()
  // from what the twin actually reports.
}

// ------------------------------------------------------------------
// 2. AURAL ALERTS
// ------------------------------------------------------------------
function initAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function toggleAudio() {
  initAudioContext();
  isAudioMuted = !isAudioMuted;
  const lbl = document.getElementById("lbl-audio");
  const btn = document.getElementById("btn-audio");
  if (isAudioMuted) {
    if (lbl) lbl.innerText = "Audio: muted";
    if (btn) btn.classList.remove("is-active");
  } else {
    if (lbl) lbl.innerText = "Audio: armed";
    if (btn) btn.classList.add("is-active");
    playTone(880, 0.1, "sine");
  }
}

function playTone(freq, durationSec, type = "sine") {
  if (isAudioMuted || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationSec);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationSec);
  } catch (e) {}
}

function playMasterCautionSound() {
  const now = Date.now();
  if (now - lastAudioAlertTime < 2500) return;
  lastAudioAlertTime = now;
  playTone(650, 0.15, "triangle");
  setTimeout(() => playTone(850, 0.20, "triangle"), 160);
}

function playEmergencyAlarmSound() {
  const now = Date.now();
  if (now - lastAudioAlertTime < 2000) return;
  lastAudioAlertTime = now;
  playTone(950, 0.2, "sawtooth");
  setTimeout(() => playTone(750, 0.2, "sawtooth"), 220);
}

// ------------------------------------------------------------------
// 3. TELEMETRY STREAM (WS → SSE → POLL)
// ------------------------------------------------------------------
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => updateBadge("Telemetry live · 20 Hz WS");
    ws.onmessage = (event) => {
      try { updateDashboard(JSON.parse(event.data)); } catch (err) {}
    };
    ws.onerror = () => startSSEStream();
    ws.onclose = () => startSSEStream();
  } catch (e) {
    startSSEStream();
  }
}

let sseSource = null;
let pollInterval = null;

function startSSEStream() {
  if (sseSource || pollInterval) return;
  if (window.EventSource) {
    try {
      sseSource = new EventSource('/api/stream');
      sseSource.onopen = () => updateBadge("Telemetry live · 20 Hz SSE");
      sseSource.onmessage = (e) => {
        try { updateDashboard(JSON.parse(e.data)); } catch (err) {}
      };
      sseSource.onerror = () => {
        if (sseSource) { sseSource.close(); sseSource = null; }
        startPolling();
      };
      return;
    } catch (err) {}
  }
  startPolling();
}

function startPolling() {
  if (pollInterval) return;
  updateBadge("Telemetry live · 20 Hz HTTP");
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) updateDashboard(await res.json());
    } catch (e) {}
  }, 50);
}

function updateBadge(text) {
  const lbl = document.getElementById("lbl-connection");
  if (lbl && lbl.innerText !== text) lbl.innerText = text;
}

// ------------------------------------------------------------------
// SIGNAL CONDITIONING
//
// Measured over 20 s of a sustained turbocharger fault, the upstream health
// index carries heavy per-frame noise — overall health swings between 62%
// and 93% sample to sample — and everything derived from it inherits that.
// The classifier reported the correct fault on 70% of frames and HEALTHY on
// the other 30%, and the RUL estimator flipped between all three of its
// regimes (450-550 h, 90-160 h and its ~0.1 h abrupt branch).
//
// Rendering those raw gives a display that strobes and contradicts itself:
// the diagnosis panel would flicker against the health matrix beside it.
// Instrument practice is to damp a noisy derived value before displaying
// it, so:
//   - health percentages are shown as a rolling median (2 s)
//   - the diagnosed class is a modal vote over 3 s, and the rest of the
//     inference is taken from the most recent frame carrying that class,
//     so severity, confidence and attribution stay coherent with the class shown
//   - RUL is a rolling median with its regime spread surfaced as uncertainty
//
// Raw continuous readings — anomaly index, reconstruction error, and every
// sensor trace on the charts — are NOT damped. Only derived, classified and
// forecast quantities are.
// ------------------------------------------------------------------
const HEALTH_WINDOW = 40;   // ~2 s at 20 Hz
const AI_VOTE_WINDOW = 60;  // ~3 s at 20 Hz

const damperBuffers = {};

function dampedMedian(key, value, window) {
  let buf = damperBuffers[key];
  if (!buf) buf = damperBuffers[key] = [];
  buf.push(value);
  if (buf.length > window) buf.shift();
  return median(buf);
}

let aiHistory = [];

function votedAiState(ai) {
  const cls = ai.fault_class || "HEALTHY";
  aiHistory.push({ cls, snap: ai });
  if (aiHistory.length > AI_VOTE_WINDOW) aiHistory.shift();

  const counts = {};
  for (const h of aiHistory) counts[h.cls] = (counts[h.cls] || 0) + 1;

  let best = cls, bestN = -1;
  for (const k in counts) {
    if (counts[k] > bestN) { bestN = counts[k]; best = k; }
  }
  for (let i = aiHistory.length - 1; i >= 0; i--) {
    if (aiHistory[i].cls === best) return aiHistory[i].snap;
  }
  return ai;
}

// ------------------------------------------------------------------
// 4. TELEMETRY → UI
// ------------------------------------------------------------------
/* The event log records what the twin reports, not what the operator asked
   for. An injection request is an operator ACTION and is logged as one; the
   resulting CONDITION is logged only once the twin's own diagnosis carries it,
   and a return to HEALTHY is logged too, so the log can never keep asserting a
   fault the rest of the console says is gone. */
let lastLoggedCondition = null;

function logConditionChange(state) {
  const ai = state.ai_prognostics || {};
  const cls = ai.fault_class || state.active_fault || "HEALTHY";
  if (cls === lastLoggedCondition) return;

  // First frame establishes the baseline silently: on connect the twin is
  // simply in whatever state it is in, and that is not an event.
  if (lastLoggedCondition === null) { lastLoggedCondition = cls; return; }

  if (cls === "HEALTHY") {
    addEventLog("FLT", "Condition cleared — all subsystems returned to nominal.");
  } else {
    const sev = ai.fault_severity !== undefined ? ai.fault_severity : 0;
    const conf = ai.fault_confidence_pct !== undefined ? ai.fault_confidence_pct : 0;
    addEventLog("AI", `Condition: ${cls.replace(/_/g, ' ').toLowerCase()} — ` +
                      `severity ${Number(sev).toFixed(2)}, confidence ${Number(conf).toFixed(1)}%.`);
  }
  lastLoggedCondition = cls;
}

function updateDashboard(state) {
  logConditionChange(state);
  if (!state || state.status === "initializing") return;

  latestTwinState = state;

  // Live or replayed frames are otherwise identical, so this is the only
  // place the dashboard cares which it is rendering.
  updateReplayBadge(state);

  // The verdict band and brief mode are two more views of this same frame,
  // so they update here rather than anywhere that could drift from it.
  updateVerdict(state);

  // The inspector reads the same frame everything else does, so its numbers
  // never lag the panel beside them.
  if (selectedComponentId) renderInspector();

  // --- Mission context tape --------------------------------------
  const totalSec = Math.floor(state.timestamp_s || 0);
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  setText("txt-time", `${hrs}:${mins}:${secs}`);
  setText("txt-phase", state.mission_phase || "CRUISE / LOITER");
  setText("txt-alt", `${Math.round(state.altitude_ft || 28500).toLocaleString()} FT`);
  setText("txt-tas", `${(state.airspeed_mps || 55.0).toFixed(1)} M/S`);
  setText("txt-oat", `${(state.ambient_temp_c || -20.0).toFixed(1)} °C`);
  setText("txt-throttle", `${(state.throttle_pct || 72.0).toFixed(1)} %`);
  setText("txt-power-hp", `Power ${(state.mvem_expected_power_hp || 150.0).toFixed(1)} HP`);

  // --- Subsystem health ------------------------------------------
  const h = state.health || {};
  const val = (v, d) => (v !== undefined && v !== null ? v : d);
  const overall = dampedMedian("overall", val(h.overall_health, 100.0), HEALTH_WINDOW);
  const oilH = dampedMedian("oil", val(h.oil_system_health, 100.0), HEALTH_WINDOW);
  const turboH = dampedMedian("turbo", val(h.turbo_boost_health, 100.0), HEALTH_WINDOW);
  const cylsH = dampedMedian("cyls", val(h.combustion_health, 100.0), HEALTH_WINDOW);
  const vibH = dampedMedian("vib", val(h.vibration_health, 100.0), HEALTH_WINDOW);
  const elecH = dampedMedian("elec", val(h.electrical_health, 100.0), HEALTH_WINDOW);

  setMetric("val-health-overall", overall.toFixed(1), overall, "stat-overall");
  setMetric("val-health-oil", oilH.toFixed(1), oilH, "stat-oil");
  setMetric("val-health-turbo", turboH.toFixed(1), turboH, "stat-turbo");
  setMetric("val-health-cyls", cylsH.toFixed(1), cylsH, "stat-cyls");
  setMetric("val-health-vib", vibH.toFixed(1), vibH, "stat-vib");
  setMetric("val-health-elec", elecH.toFixed(1), elecH, "stat-elec");
  setPanelState("panel-health", healthState(overall, "panel-health"));

  // Status badge & aural alert — on state change only
  const currentStatusStr = overall < WARNING_BELOW ? "WARNING"
                          : (overall < CAUTION_BELOW ? "CAUTION" : "NOMINAL");
  if (currentStatusStr !== lastOverallStatus) {
    lastOverallStatus = currentStatusStr;
    const badgeStatus = document.getElementById("badge-status-level");
    if (currentStatusStr === "WARNING") {
      setState(badgeStatus, "warning");
      if (badgeStatus) badgeStatus.innerText = "Warning";
      playEmergencyAlarmSound();
    } else if (currentStatusStr === "CAUTION") {
      setState(badgeStatus, "caution");
      if (badgeStatus) badgeStatus.innerText = "Caution";
      playMasterCautionSound();
    } else {
      setState(badgeStatus, "ok");
      if (badgeStatus) badgeStatus.innerText = "Nominal";
    }
  }

  // --- Per-cylinder thermal deviation ----------------------------
  const egtArr = state.sensor_egt_c || [810, 810, 810, 810];
  const chtArr = state.sensor_cht_c || [175, 175, 175, 175];
  const egtExp = state.mvem_expected_egt_c || [810, 810, 810, 810];
  const chtExp = state.mvem_expected_cht_c || [175, 175, 175, 175];

  for (let i = 0; i < 4; i++) {
    const egt = egtArr[i], cht = chtArr[i];
    const dEgt = egt - (egtExp[i] !== undefined ? egtExp[i] : egt);
    const dCht = cht - (chtExp[i] !== undefined ? chtExp[i] : cht);

    // Worst of the two thermal channels drives the annunciation.
    const st = worstState(
      bandStateHigh(egt, LIMITS.egt.caution, LIMITS.egt.limit),
      bandStateHigh(cht, LIMITS.cht.caution, LIMITS.cht.limit)
    );

    setText(`txt-cyl${i+1}-temp`, egt.toFixed(0));
    setText(`txt-cyl${i+1}-dev`, `${dEgt >= 0 ? '+' : ''}${dEgt.toFixed(0)} / ${dCht >= 0 ? '+' : ''}${dCht.toFixed(0)}`);
    setState(document.getElementById(`cyl-cell-${i}`), st);
  }

  // --- AI diagnosis ----------------------------------------------
  // Live readings come from the raw frame; classification-derived fields
  // come from the latched snapshot so the panel does not flicker.
  const aiRaw = state.ai_prognostics || {};
  const ai = votedAiState(aiRaw);
  const isAnom = aiRaw.anomaly_detected || false;
  const anomIndex = val(aiRaw.anomaly_score, 0.0);
  const rawMse = val(aiRaw.anomaly_raw_mse, isAnom ? 120.5 : 0.62);
  const thresh = val(aiRaw.anomaly_threshold, 26.6);

  const badgeAnom = document.getElementById("badge-anomaly");
  const anomActive = isAnom || anomIndex > 0.60;
  if (badgeAnom) {
    const wantText = anomActive ? "Anomaly detected" : "Nominal";
    if (badgeAnom.innerText !== wantText) badgeAnom.innerText = wantText;
    setState(badgeAnom, anomActive ? "warning" : null);
  }
  const anomEl = document.getElementById("val-anom-idx");
  if (anomEl) {
    const c = anomActive ? "is-warning" : "";
    if (anomEl.className !== c) anomEl.className = c;
  }

  setText("val-anom-idx", anomIndex.toFixed(2));
  setText("val-raw-mse", `MSE ${rawMse.toFixed(1)} · limit ${thresh.toFixed(1)}`);

  // Diagnosed condition
  const faultClassEl = document.getElementById("lbl-fault-class");
  const faultName = ai.fault_class || "HEALTHY";
  if (faultClassEl) {
    const formatted = faultName.replace(/_/g, ' ');
    if (faultClassEl.innerText !== formatted) faultClassEl.innerText = formatted;
    if (faultName === "HEALTHY") setState(faultClassEl, null);
    else if (ai.is_sensor_fault || faultName.startsWith("SENSOR_FAULT")) setState(faultClassEl, "caution");
    else setState(faultClassEl, (ai.fault_severity || 0) >= 0.6 ? "warning" : "caution");
  }
  setPanelState("panel-ai", faultName === "HEALTHY" ? "nominal"
                : ((ai.fault_severity || 0) >= 0.6 ? "warning" : "caution"));

  setText("val-conf", (val(ai.fault_confidence_pct, 99.8)).toFixed(1));
  setText("val-sev", (val(ai.fault_severity, 0.0)).toFixed(2));

  updateRul(ai);
  // After updateRul, so the band and the diagnosis panel report one verdict.
  updateStatusBand(state, ai, rulSettledFlag);
  updateShapDrawer(ai.top_contributing_channels || []);
  updateRecommendedAction(state, ai);

  // --- Engine Core & State Fusion --------------------------------
  const rpm = state.sensor_rpm || state.mvem_expected_rpm || 5200;
  const fuel = state.sensor_fuel_flow_lph || state.mvem_expected_fuel_lph || 26.5;
  const coolant = state.sensor_coolant_t_c || 84;
  const oilT = state.sensor_oil_t_c || state.mvem_expected_oil_t_c || 96;
  const busV = state.sensor_bus_v || 28.2;

  const egtList = state.sensor_egt_c || [810, 810, 810, 810];
  const spread = Math.max(...egtList) - Math.min(...egtList);

  setText("txt-vital-rpm", Math.round(rpm).toLocaleString());
  setText("txt-vital-fuel", Number(fuel).toFixed(1));
  setText("txt-vital-coolant", Math.round(coolant));
  setText("txt-vital-oilt", Math.round(oilT));
  setText("txt-vital-bus", Number(busV).toFixed(1));
  setText("txt-vital-spread", `Δ ${Math.round(spread)}`);

  // State fusion indicators
  const isAdapted = state.baseline_adapted !== false;
  const adaptBadge = document.getElementById("txt-fusion-adapt");
  if (adaptBadge) {
    adaptBadge.innerText = isAdapted ? "Calibrated" : "Adapting...";
    adaptBadge.setAttribute("data-state", isAdapted ? "ok" : "caution");
  }

  const isSensorFault = aiRaw.is_sensor_fault || (state.active_fault && String(state.active_fault).startsWith("SENSOR_FAULT"));
  const discEl = document.getElementById("txt-fusion-disc");
  if (discEl) {
    if (isSensorFault) {
      discEl.innerText = "Sensor Defect";
      discEl.style.color = "var(--caution)";
    } else if (aiRaw.fault_class && aiRaw.fault_class !== "HEALTHY") {
      discEl.innerText = "Physical Fault";
      discEl.style.color = "var(--warning)";
    } else {
      discEl.innerText = "Engine Valid";
      discEl.style.color = "var(--nominal)";
    }
  }

  // --- Fault strip -----------------------------------------------
  updateActiveFaultButton(state.active_fault || currentActiveFault || "HEALTHY");

  // --- 3D model ---------------------------------------------------
  if (engine3D && typeof engine3D.updateFromTwinState === "function") {
    try { engine3D.updateFromTwinState(state); } catch (e) {}
  }

  updateChartData(state);
}

function worstState(a, b) {
  const rank = { nominal: 0, caution: 1, warning: 2 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

// ------------------------------------------------------------------
// 5. RECOMMENDED ACTION
// ------------------------------------------------------------------
function updateRecommendedAction(state, ai) {
  setText("txt-recommended-action", ai.recommended_action || "Continue nominal mission profile.");

  const regimeEl = document.getElementById("badge-action-regime");
  if (regimeEl) {
    const sev = ai.fault_severity || 0;
    const regime = (ai.fault_class || "HEALTHY") === "HEALTHY" ? "Stable"
                 : (sev >= 0.6 ? "Action required" : "Monitor");
    if (regimeEl.innerText !== regime) regimeEl.innerText = regime;
  }

  const alertEl = document.getElementById("txt-active-alert");
  if (alertEl) {
    const alert = state.active_alert;
    const msg = alert && (alert.message || alert.text || (typeof alert === "string" ? alert : null));
    if (msg) {
      if (alertEl.innerText !== msg) alertEl.innerText = msg;
      alertEl.hidden = false;
      setState(alertEl, (ai.fault_severity || 0) >= 0.6 ? "warning" : "caution");
    } else {
      alertEl.hidden = true;
    }
  }

  setPanelState("panel-action",
    (ai.fault_class || "HEALTHY") === "HEALTHY" ? "nominal"
      : ((ai.fault_severity || 0) >= 0.6 ? "warning" : "caution"));
}

// ------------------------------------------------------------------
// 6. RUL — a revision keeps its superseded range on screen
//
// The estimator reports one of three regimes and, on measured telemetry, it
// does not settle on one: under a sustained turbocharger fault at 0.38
// severity the regime split was 54% imminent / 26% stable / 16% graded
// across a 14 s sample. Averaging across regimes produces a number the
// model never actually predicted, so the panel refuses to invent one.
//
// A value is displayed only when a single regime holds a clear majority of
// the window. Otherwise the readout annunciates that the estimate has not
// settled and the last settled range stays visible beneath it — which is
// what an instrument does with a value it cannot compute, rather than
// showing a confident wrong number.
// ------------------------------------------------------------------
const RUL_WINDOW = 240;          // ~12 s at 20 Hz
const RUL_DOMINANCE = 0.85;      // regime share required to display a value
const RUL_MIN_SAMPLES = 40;
const RUL_REVISION_H = 25.0;
const RUL_REVISION_COOLDOWN_MS = 5000;

let rulSamples = [];
let lastRevisionAt = 0;

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function rulRegime(mean) {
  if (mean < 5) return "imminent";
  if (mean < 300) return "graded";
  return "stable";
}

function updateRul(ai) {
  const rMin = ai.rul_hours_min !== undefined ? ai.rul_hours_min : 450.0;
  const rMax = ai.rul_hours_max !== undefined ? ai.rul_hours_max : 550.0;

  rulSamples.push({ min: rMin, max: rMax, regime: rulRegime((rMin + rMax) / 2) });
  if (rulSamples.length > RUL_WINDOW) rulSamples.shift();

  const counts = {};
  rulSamples.forEach(r => { counts[r.regime] = (counts[r.regime] || 0) + 1; });
  let top = null, topN = 0;
  for (const k in counts) if (counts[k] > topN) { topN = counts[k]; top = k; }
  const share = rulSamples.length ? topN / rulSamples.length : 0;
  const settled = rulSamples.length >= RUL_MIN_SAMPLES && share >= RUL_DOMINANCE;

  const intervalEl = document.getElementById("txt-rul-interval");
  const uncEl = document.getElementById("badge-rul-unc");
  const boxEl = document.getElementById("box-rul");
  const prevEl = document.getElementById("txt-rul-previous");

  if (settled) {
    const inRegime = rulSamples.filter(r => r.regime === top);
    const dMin = median(inRegime.map(r => r.min));
    const dMax = median(inRegime.map(r => r.max));
    const dMean = (dMin + dMax) / 2;

    if (!rulCurrent) {
      rulCurrent = { min: dMin, max: dMax };
    } else {
      const moved = Math.abs(dMean - ((rulCurrent.min + rulCurrent.max) / 2));
      const now = Date.now();
      if (moved >= RUL_REVISION_H && (now - lastRevisionAt) > RUL_REVISION_COOLDOWN_MS) {
        lastRevisionAt = now;
        rulPrevious = { min: rulCurrent.min, max: rulCurrent.max };
        rulCurrent = { min: dMin, max: dMax };
        const dir = dMean < ((rulPrevious.min + rulPrevious.max) / 2) ? "reduced" : "extended";
        addEventLog("AI", `RUL ${dir}: ${rulPrevious.min.toFixed(0)}–${rulPrevious.max.toFixed(0)} h → ${dMin.toFixed(0)}–${dMax.toFixed(0)} h.`);
      } else {
        rulCurrent = { min: dMin, max: dMax };
      }
    }

    if (intervalEl) {
      const txt = `${dMin.toFixed(1)} – ${dMax.toFixed(1)}`;
      if (intervalEl.innerText !== txt) intervalEl.innerText = txt;
      intervalEl.className = "";
    }
    const unit = intervalEl && intervalEl.nextElementSibling;
    if (unit) unit.hidden = false;

    setState(boxEl, dMean < 100 ? "warning" : (dMean < 300 ? "caution" : "nominal"));

    if (uncEl) {
      const level = (dMax - dMin) > 110 ? "moderate" : "low";
      const txt = `Uncertainty: ${level}`;
      if (uncEl.innerText !== txt) uncEl.innerText = txt;
      setState(uncEl, null);
    }
  } else {
    // No regime holds the window. Do not invent a value.
    if (intervalEl) {
      if (intervalEl.innerText !== "—") intervalEl.innerText = "—";
      intervalEl.className = "is-caution";
    }
    const unit = intervalEl && intervalEl.nextElementSibling;
    if (unit) unit.hidden = true;

    setState(boxEl, "caution");
    if (uncEl) {
      const txt = "Estimate not settled";
      if (uncEl.innerText !== txt) uncEl.innerText = txt;
      setState(uncEl, "caution");
    }
  }

  // Reported back so the status band can show the same verdict this function
  // settled on, rather than re-deriving it from the raw frame and disagreeing
  // with the panel beside it.
  rulSettledFlag = settled;

  if (prevEl) {
    if (rulPrevious) {
      const txt = `revised from ${rulPrevious.min.toFixed(1)} – ${rulPrevious.max.toFixed(1)} h`;
      if (prevEl.innerText !== txt) prevEl.innerText = txt;
      prevEl.hidden = false;
    } else if (!settled && rulCurrent) {
      const txt = `last settled ${rulCurrent.min.toFixed(1)} – ${rulCurrent.max.toFixed(1)} h`;
      if (prevEl.innerText !== txt) prevEl.innerText = txt;
      prevEl.hidden = false;
    } else {
      prevEl.hidden = true;
    }
  }
}

/**
 * The full-width verdict strip: condition, confidence, severity, remaining
 * life and the recommended action, on one line. Its ground carries the
 * semantic state colour, which is what makes it the first thing read.
 */
function updateStatusBand(state, ai, rulSettled) {
  const band = document.getElementById("status-band");
  if (!band) return;

  const h = state.health || {};
  const overall = h.overall_health !== undefined ? h.overall_health : 100;
  const cls = (ai.fault_class || state.active_fault || "HEALTHY");

  // Same 85/70/50/25 banding the health index uses; nothing new is decided here.
  let st = overall >= 85 ? "nominal"
         : overall >= 70 ? "advisory"
         : overall >= 50 ? "caution"
         : overall >= 25 ? "warning" : "critical";

  // A named condition can coexist with a high composite health score -- a
  // boost deficiency during an altitude sweep sits near 89% overall. Painting
  // that band nominal green while it reads "TURBO BOOST DEFICIENCY" is the
  // same contradiction this band exists to remove, so a named condition
  // floors the band at caution regardless of the composite.
  if (cls !== "HEALTHY" && (st === "nominal" || st === "advisory")) st = "caution";
  if (band.dataset.state !== st) band.dataset.state = st;

  setText("sb-condition", cls.replace(/_/g, ' '));
  setText("sb-confidence", `${Number(ai.fault_confidence_pct ?? 100).toFixed(1)} %`);
  setText("sb-severity", Number(ai.fault_severity ?? 0).toFixed(2));

  // The diagnosis panel damps this interval so it does not flap frame to
  // frame. Read the damped value, not the raw frame, or the band and the
  // panel next to it report different remaining life for the same engine.
  const lo = rulCurrent ? rulCurrent.min : ai.rul_hours_min;
  const hi = rulCurrent ? rulCurrent.max : ai.rul_hours_max;
  setText("sb-rul", (rulSettled === false || lo === undefined || hi === undefined)
    ? "not settled"
    : `${Number(lo).toFixed(lo < 10 ? 1 : 0)} – ${Number(hi).toFixed(hi < 10 ? 1 : 0)} h`);

  setText("sb-action", ai.recommended_action || "Continue nominal mission profile.");
}

// ------------------------------------------------------------------
// 7. LOCAL ATTRIBUTION — ranked horizontal bars, top five
// ------------------------------------------------------------------
/* A channel that names a cylinder gets that cylinder's colour as a chip, so
   the same four hues identify a cylinder in the charts, the tiles, the 3D
   model and here. The bar itself keeps its state colour: identity and state
   are different questions and should not share one channel. */
/* Shown when the twin reports nothing above tolerance, so the panel keeps
   its shape and the reader sees a quiet system rather than an empty box. */
const RESIDUAL_CHANNEL_LABELS = [
  'Cylinder 1 Exhaust Gas Temp (EGT1)',
  'Cylinder 2 Exhaust Gas Temp (EGT2)',
  'Cylinder 3 Exhaust Gas Temp (EGT3)',
  'Cylinder 4 Exhaust Gas Temp (EGT4)',
  'Manifold pressure (MAP)'
];

function cylChip(name) {
  const m = /(?:cylinder|cyl)\s*([1-4])|EGT([1-4])|CHT([1-4])/i.exec(name || '');
  if (!m) return '';
  const n = parseInt(m[1] || m[2] || m[3], 10);
  return `<i class="cyl-chip" style="background:${THEME.cyl[n - 1]}"></i>`;
}

function updateShapDrawer(shapItems) {
  const container = document.getElementById("container-shap");
  if (!container) return;

  const signature = JSON.stringify(shapItems || []);
  if (signature === lastShapSignature) return;
  lastShapSignature = signature;

  // Previously a nominal engine swapped the bars for a placeholder sentence,
  // so the panel was empty most of the time and its height jumped whenever a
  // fault appeared. The bars now stay, showing their true small magnitudes:
  // "every channel is inside tolerance" is more convincing shown than stated.
  if (!shapItems || shapItems.length === 0) {
    container.innerHTML = RESIDUAL_CHANNEL_LABELS.map(ch => `
      <div class="hbar-row">
        <span class="hbar-label">${cylChip(ch)}${ch}</span>
        <span class="hbar-val">0.0% · 0.0σ</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:2%"></span></span>
      </div>`).join('');
    return;
  }

  // Rank descending by attribution and keep the top five.
  const ranked = shapItems
    .slice()
    .sort((a, b) => (b.importance_pct || 0) - (a.importance_pct || 0))
    .slice(0, 5);

  const maxPct = Math.max(1, ...ranked.map(r => r.importance_pct || 0));

  container.innerHTML = ranked.map((item) => {
    const pct = item.importance_pct || 0;
    const sigma = item.residual_sigma || 0;
    const absSigma = Math.abs(sigma);
    // Amber only where the channel is genuinely out of tolerance.
    const st = absSigma >= 3.0 ? "warning" : (absSigma >= 1.5 ? "caution" : "nominal");
    const stAttr = st === "nominal" ? "" : ` data-state="${st}"`;
    const arrow = sigma >= 0 ? "▲" : "▼";
    const width = Math.max(2, (pct / maxPct) * 100);
    return `
      <div class="hbar-row">
        <span class="hbar-label">${cylChip(item.display_name)}${item.display_name}</span>
        <span class="hbar-val">${pct.toFixed(1)}% · ${arrow}${absSigma.toFixed(1)}σ</span>
        <span class="hbar-track"><span class="hbar-fill"${stAttr} style="width:${width}%"></span></span>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------------
// 8. CHARTS
// ------------------------------------------------------------------

/**
 * Paints the +/-k sigma envelope as a filled band that follows the
 * model-expected centreline, behind the sensor traces.
 *
 * Previously the envelope existed only as a dashed centreline and the solid
 * sensor trace drew straight over it, which made the question "is this line
 * above that line?" -- a comparison the eye is bad at. A filled band turns it
 * into "did the line leave the band?", which is read instantly.
 *
 * Bands are per series so a cylinder's band carries that cylinder's colour.
 * The twin's baseline currently models four identical cylinders, so all four
 * expectations coincide; identical bands are therefore drawn once, in neutral
 * --model-expected, rather than four times at stacking alpha. If the baseline
 * ever differentiates cylinders the bands separate and colour themselves
 * without any change here.
 *
 * options.plugins.envelope.series = [{ centre:[], sigma, color }]
 */
const envelopePlugin = {
  id: 'envelope',
  beforeDatasetsDraw(chart, args, opts) {
    const series = (opts && opts.series) || [];
    if (!series.length) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;

    // Group series whose centreline is identical, so coincident bands paint once.
    const groups = new Map();
    series.forEach(sv => {
      const centre = sv.centre || [];
      if (!centre.length) return;
      const key = (sv.axis || 'y') + '|' + sv.sigma + '|' + centre.join(',');
      if (!groups.has(key)) groups.set(key, { ...sv, members: 1 });
      else groups.get(key).members += 1;
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top,
             chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();

    groups.forEach(g => {
      const y = scales[g.axis || 'y'];
      const x = scales.x;
      if (!y || !x) return;
      const centre = g.centre;
      const half = g.sigma * ENVELOPE_K;
      // A shared band belongs to no single cylinder, so it is neutral.
      ctx.fillStyle = g.members > 1 ? THEME.modelExpected + '1A' : g.color;
      ctx.beginPath();
      for (let i = 0; i < centre.length; i++) {
        const px = x.getPixelForValue(i);
        const py = y.getPixelForValue(centre[i] + half);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      for (let i = centre.length - 1; i >= 0; i--) {
        ctx.lineTo(x.getPixelForValue(i), y.getPixelForValue(centre[i] - half));
      }
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();
  }
};

/**
 * Paints translucent tolerance bands across a y-axis region.
 * Regions come from options.plugins.bands.regions = [{from,to,color}].
 */
const bandsPlugin = {
  id: 'bands',
  beforeDatasetsDraw(chart, args, opts) {
    const regions = (opts && opts.regions) || [];
    if (!regions.length) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y;
    if (!y || !chartArea) return;
    ctx.save();
    regions.forEach(r => {
      const yTop = y.getPixelForValue(r.to);
      const yBot = y.getPixelForValue(r.from);
      const top = Math.max(chartArea.top, Math.min(yTop, yBot));
      const bot = Math.min(chartArea.bottom, Math.max(yTop, yBot));
      if (bot <= top) return;
      ctx.fillStyle = r.color;
      ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bot - top);
    });
    ctx.restore();
  }
};

// A trace turns amber only while it is inside a caution band, red inside
// the limit band. Evaluated per segment against the segment's endpoint.
function envelopeSegmentColor(caution, limit, baseColor) {
  return (ctx) => {
    const v = ctx.p1.parsed.y;
    if (v === null || v === undefined) return baseColor;
    if (v >= limit) return THEME.warning;
    if (v >= caution) return THEME.caution;
    return baseColor;
  };
}
function envelopeSegmentColorLow(cautionLow, limitLow, baseColor) {
  return (ctx) => {
    const v = ctx.p1.parsed.y;
    if (v === null || v === undefined) return baseColor;
    if (v <= limitLow) return THEME.warning;
    if (v <= cautionLow) return THEME.caution;
    return baseColor;
  };
}

/**
 * Clips a y-axis to what is actually on it.
 *
 * Every chart previously ran a fixed axis several times taller than its data
 * -- EGT on 0-1000 with the traces sitting near 500 -- so a real divergence
 * was a few pixels and every trace read as a flat line mid-panel.
 *
 * The range is the union of the plotted series, their model-expected
 * centrelines and the +/-3 sigma envelope around them, plus 8% headroom. It
 * is recomputed on AXIS_RESCALE_MS rather than per frame so the axis does not
 * chase the data, and it is floored at a minimum span so a dead-flat healthy
 * trace does not get magnified into noise.
 */
function fitAxis(scale, series, opts) {
  const o = opts || {};
  let lo = Infinity, hi = -Infinity;
  series.forEach(sv => {
    const arr = sv.data || [];
    const pad = (sv.sigma || 0) * ENVELOPE_K;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null || v === undefined || !isFinite(v)) continue;
      if (v - pad < lo) lo = v - pad;
      if (v + pad > hi) hi = v + pad;
    }
  });
  if (!isFinite(lo) || !isFinite(hi)) return false;

  let span = hi - lo;
  const minSpan = o.minSpan || 0;
  if (span < minSpan) {                      // flat trace: open out around it
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2; hi = mid + minSpan / 2; span = minSpan;
  }
  const head = span * 0.08;
  lo -= head; hi += head;
  if (o.floorAtZero && lo < 0) lo = 0;
  if (o.clampMin !== undefined) lo = Math.min(lo, o.clampMin);
  if (o.clampMax !== undefined) hi = Math.max(hi, o.clampMax);

  const changed = scale.min !== lo || scale.max !== hi;
  scale.min = lo; scale.max = hi;
  return changed;
}

/** Recomputes all three charts' y-ranges from the live buffers. */
function rescaleAxes() {
  const H = historyData;
  if (charts.temp) {
    fitAxis(charts.temp.options.scales.y, [
      { data: H.sensor_egt1 }, { data: H.sensor_egt2 },
      { data: H.sensor_egt3 }, { data: H.sensor_egt4 },
      { data: H.mvem_egt, sigma: SIGMA.egt }
    ], { minSpan: 60 });
  }
  if (charts.pressures) {
    fitAxis(charts.pressures.options.scales.y, [
      { data: H.sensor_oil_p }, { data: H.mvem_oil_p, sigma: SIGMA.oilP }
    ], { minSpan: 1.2, floorAtZero: false });
    fitAxis(charts.pressures.options.scales.y1, [
      { data: H.sensor_map }, { data: H.mvem_map, sigma: SIGMA.map }
    ], { minSpan: 0.6 });
  }
  if (charts.vibration) {
    fitAxis(charts.vibration.options.scales.y, [
      { data: H.sensor_vib, sigma: SIGMA.vib }
    ], { minSpan: 0.8, floorAtZero: true });
    fitAxis(charts.vibration.options.scales.y1, [{ data: H.mvem_vib }], { minSpan: 40 });
  }
}

function initCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded yet.");
    return;
  }

  Chart.register(bandsPlugin, envelopePlugin);
  Chart.defaults.font.family = THEME.fontMono;
  Chart.defaults.font.size = THEME.fsTick;
  Chart.defaults.color = THEME.textMuted;

  const axisTicks = {
    color: THEME.textMuted,
    font: { size: THEME.fsTick, family: THEME.fontMono },
    maxTicksLimit: 6,
    padding: 4
  };
  // Horizontal gridlines only. Vertical rules added nothing -- the x axis is
  // uniform time -- and crossed the traces they were meant to support.
  const gridY = { color: THEME.grid, lineWidth: 1, drawTicks: false, drawOnChartArea: true };
  const gridX = { display: false };

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    layout: { padding: { top: 2, right: 2, bottom: 0, left: 0 } },
    elements: { line: { tension: 0.12, borderWidth: 2 }, point: { radius: 0 } },
    scales: {
      // There was no x axis at all, so a trace carried no sense of how much
      // history was on screen or how fast anything moved.
      x: {
        display: true,
        grid: gridX,
        border: { color: THEME.border },
        ticks: { ...axisTicks, maxTicksLimit: 7, maxRotation: 0, autoSkip: true }
      },
      y: { grid: gridY, border: { color: THEME.border }, ticks: axisTicks }
    },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          boxWidth: 14, boxHeight: 2, padding: 10, usePointStyle: false,
          color: THEME.textMuted,
          font: { size: THEME.fsTick, family: THEME.fontMono }
        }
      },
      tooltip: {
        backgroundColor: THEME.bgElevated,
        titleColor: THEME.textPrimary,
        bodyColor: THEME.textMuted,
        borderColor: THEME.border,
        borderWidth: 1,
        titleFont: { family: THEME.fontMono, size: THEME.fsTick },
        bodyFont: { family: THEME.fontMono, size: THEME.fsTick },
        displayColors: false
      }
    }
  };

  // Model-expected baseline: 1.4px dashed, in instrument blue.
  //
  // This is the one place hue carries meaning rather than identity. Sensor
  // traces stay greyscale and are told apart by lightness; the physics
  // expectation is blue everywhere in the project, including the 3D selection
  // outline and the project brief, so a glance at any chart separates "what we
  // measured" from "what physics says" before reading a single label.
  const baselineStyle = {
    borderColor: THEME.instrument,
    borderDash: [5, 4],
    borderWidth: 1.4,
    backgroundColor: 'transparent',
    data: []
  };

  // --- Chart 1: EGT 1–4 vs model expected ------------------------
  const canvasTemp = document.getElementById('chart-temp');
  if (canvasTemp) {
    charts.temp = new Chart(canvasTemp, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'EGT 1', borderColor: THEME.trace[0], backgroundColor: 'transparent', data: [],
            segment: { borderColor: envelopeSegmentColor(LIMITS.egt.caution, LIMITS.egt.limit, THEME.trace[0]) } },
          { label: 'EGT 2', borderColor: THEME.trace[1], backgroundColor: 'transparent', data: [],
            segment: { borderColor: envelopeSegmentColor(LIMITS.egt.caution, LIMITS.egt.limit, THEME.trace[1]) } },
          { label: 'EGT 3', borderColor: THEME.trace[2], backgroundColor: 'transparent', data: [],
            segment: { borderColor: envelopeSegmentColor(LIMITS.egt.caution, LIMITS.egt.limit, THEME.trace[2]) } },
          { label: 'EGT 4', borderColor: THEME.trace[3], backgroundColor: 'transparent', data: [],
            segment: { borderColor: envelopeSegmentColor(LIMITS.egt.caution, LIMITS.egt.limit, THEME.trace[3]) } },
          Object.assign({ label: 'Model expected' }, baselineStyle)
        ]
      },
      options: {
        ...commonOptions,
        scales: {
          x: commonOptions.scales.x,
          y: {
            grid: gridY,
            border: { color: THEME.border },
            // range set by rescaleAxes()
            title: { display: true, text: '°C', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(0) }
          }
        },
        plugins: {
          ...commonOptions.plugins,
          bands: {
            regions: [
              { from: LIMITS.egt.caution, to: LIMITS.egt.limit, color: THEME.cautionBand },
              { from: LIMITS.egt.limit, to: LIMITS.egt.max, color: THEME.warningBand }
            ]
          },
          envelope: { series: [] }   // filled each tick from the live buffers
        }
      }
    });
  }

  // --- Chart 2: oil pressure & manifold boost --------------------
  // Numeric ticks with the unit stated once on the axis, not repeated
  // on every tick.
  const canvasPressures = document.getElementById('chart-pressures');
  if (canvasPressures) {
    charts.pressures = new Chart(canvasPressures, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Oil pressure', borderColor: THEME.trace[0], backgroundColor: 'transparent', data: [],
            segment: { borderColor: envelopeSegmentColorLow(LIMITS.oilP.cautionLow, LIMITS.oilP.limitLow, THEME.trace[0]) } },
          Object.assign({ label: 'Oil P expected' }, baselineStyle),
          { label: 'Manifold MAP', borderColor: THEME.trace[2], yAxisID: 'y1',
            backgroundColor: 'transparent', data: [] },
          Object.assign({ label: 'MAP expected', yAxisID: 'y1' }, baselineStyle)
        ]
      },
      options: {
        ...commonOptions,
        scales: {
          x: commonOptions.scales.x,
          y: {
            grid: gridY,
            border: { color: THEME.border },
            // range set by rescaleAxes()
            title: { display: true, text: 'Oil bar', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, stepSize: 1, callback: (v) => Number(v).toFixed(1) }
          },
          y1: {
            position: 'right',
            grid: { drawOnChartArea: false, color: THEME.grid },
            border: { color: THEME.border },
            // range set by rescaleAxes()
            title: { display: true, text: 'MAP bar', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(1) }
          }
        },
        plugins: { ...commonOptions.plugins, envelope: { series: [] } }
      }
    });
  }

  // --- Chart 3: vibration & power --------------------------------
  const canvasVib = document.getElementById('chart-vibration');
  if (canvasVib) {
    charts.vibration = new Chart(canvasVib, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Vibration 2X RMS', borderColor: THEME.trace[0], yAxisID: 'y',
            backgroundColor: 'transparent', data: [],
            segment: { borderColor: envelopeSegmentColor(LIMITS.vib.caution, LIMITS.vib.limit, THEME.trace[0]) } },
          Object.assign({ label: 'Power', yAxisID: 'y1' }, baselineStyle)
        ]
      },
      options: {
        ...commonOptions,
        scales: {
          x: commonOptions.scales.x,
          y: {
            grid: gridY,
            border: { color: THEME.border },
            // range set by rescaleAxes()
            title: { display: true, text: 'g RMS', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(1) }
          },
          y1: {
            position: 'right',
            grid: { drawOnChartArea: false, color: THEME.grid },
            border: { color: THEME.border },
            // range set by rescaleAxes()
            title: { display: true, text: 'HP', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(0) }
          }
        },
        plugins: { ...commonOptions.plugins, envelope: { series: [] } }
      }
    });
  }
}

function updateChartData(state) {
  if (!state) return;
  historyData.time.push(`${(state.timestamp_s || 0).toFixed(1)}s`);

  historyData.t_s.push(state.timestamp_s || 0);

  const egts = state.sensor_egt_c || [810, 810, 810, 810];
  const mv = state.mvem_expected_egt_c || [];
  const mvemEgt = mv[0] !== undefined ? mv[0] : 810;

  historyData.sensor_egt1.push(egts[0]);
  historyData.sensor_egt2.push(egts[1]);
  historyData.sensor_egt3.push(egts[2]);
  historyData.sensor_egt4.push(egts[3]);
  historyData.mvem_egt.push(mvemEgt);
  // Kept per cylinder so each band tracks its own expectation. They coincide
  // today because the baseline models identical cylinders; the envelope
  // plugin collapses coincident bands rather than stacking their alpha.
  for (let i = 0; i < 4; i++) {
    historyData['mvem_egt' + (i + 1)].push(mv[i] !== undefined ? mv[i] : mvemEgt);
  }

  historyData.sensor_oil_p.push(state.sensor_oil_pressure_bar !== undefined ? state.sensor_oil_pressure_bar : 4.2);
  historyData.mvem_oil_p.push(state.mvem_expected_oil_pressure_bar || 4.2);
  historyData.sensor_map.push(state.sensor_manifold_pressure_bar !== undefined ? state.sensor_manifold_pressure_bar : 2.45);
  historyData.mvem_map.push(state.mvem_expected_manifold_pressure_bar || 2.45);

  historyData.sensor_vib.push(state.sensor_vibration_rms_g !== undefined ? state.sensor_vibration_rms_g : 0.48);
  historyData.mvem_vib.push(state.mvem_expected_power_hp || 150.0);

  while (historyData.time.length > MAX_HISTORY) {
    Object.keys(historyData).forEach(k => historyData[k].shift());
  }

  const now = Date.now();
  if (now - lastChartUpdateTime < CHART_UPDATE_INTERVAL_MS) return;
  lastChartUpdateTime = now;

  const nowMs = Date.now();
  if (nowMs - lastAxisRescale >= AXIS_RESCALE_MS) {
    lastAxisRescale = nowMs;
    rescaleAxes();
  }

  if (charts.temp) {
    charts.temp.options.plugins.envelope.series = [
      { centre: historyData.mvem_egt1, sigma: SIGMA.egt, color: THEME.cylBand[0] },
      { centre: historyData.mvem_egt2, sigma: SIGMA.egt, color: THEME.cylBand[1] },
      { centre: historyData.mvem_egt3, sigma: SIGMA.egt, color: THEME.cylBand[2] },
      { centre: historyData.mvem_egt4, sigma: SIGMA.egt, color: THEME.cylBand[3] }
    ];
  }
  if (charts.pressures) {
    charts.pressures.options.plugins.envelope.series = [
      { centre: historyData.mvem_oil_p, sigma: SIGMA.oilP, color: THEME.cylBand[0], axis: 'y' },
      { centre: historyData.mvem_map,   sigma: SIGMA.map,  color: THEME.cylBand[2], axis: 'y1' }
    ];
  }
  // The vibration chart has no model-expected centreline to band: mvem_vib
  // carries power on the right-hand axis, not an expected vibration level.
  // Its tolerance is the absolute caution/limit region, which bandsPlugin
  // already draws.

  if (charts.temp && charts.temp.data.datasets.length >= 5) {
    charts.temp.data.labels = historyData.time;
    charts.temp.data.datasets[0].data = historyData.sensor_egt1;
    charts.temp.data.datasets[1].data = historyData.sensor_egt2;
    charts.temp.data.datasets[2].data = historyData.sensor_egt3;
    charts.temp.data.datasets[3].data = historyData.sensor_egt4;
    charts.temp.data.datasets[4].data = historyData.mvem_egt;
    charts.temp.update('none');
  }

  if (charts.pressures && charts.pressures.data.datasets.length >= 4) {
    charts.pressures.data.labels = historyData.time;
    charts.pressures.data.datasets[0].data = historyData.sensor_oil_p;
    charts.pressures.data.datasets[1].data = historyData.mvem_oil_p;
    charts.pressures.data.datasets[2].data = historyData.sensor_map;
    charts.pressures.data.datasets[3].data = historyData.mvem_map;
    charts.pressures.update('none');
  }

  if (charts.vibration && charts.vibration.data.datasets.length >= 2) {
    charts.vibration.data.labels = historyData.time;
    charts.vibration.data.datasets[0].data = historyData.sensor_vib;
    charts.vibration.data.datasets[1].data = historyData.mvem_vib;
    charts.vibration.update('none');
  }

  // Chart panels annunciate their own envelope excursions.
  const lastEgt = Math.max(egts[0], egts[1], egts[2], egts[3]);
  setPanelState("panel-chart-temp", bandStateHigh(lastEgt, LIMITS.egt.caution, LIMITS.egt.limit));
  const lastOil = historyData.sensor_oil_p[historyData.sensor_oil_p.length - 1];
  setPanelState("panel-chart-press", bandStateLow(lastOil, LIMITS.oilP.cautionLow, LIMITS.oilP.limitLow));
  const lastVib = historyData.sensor_vib[historyData.sensor_vib.length - 1];
  setPanelState("panel-chart-vib", bandStateHigh(lastVib, LIMITS.vib.caution, LIMITS.vib.limit));
}

// ------------------------------------------------------------------
// 9. FLIGHT SANDBOX (collapsible developer controls)
// ------------------------------------------------------------------
let isManualSandbox = false;

function toggleSandbox() {
  const panel = document.getElementById("panel-sandbox");
  const btn = document.getElementById("btn-sandbox-open");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (btn) {
    btn.innerText = panel.hidden ? "Sandbox ▾" : "Sandbox ▴";
    btn.classList.toggle("is-active", !panel.hidden);
  }
}

function toggleManualSandbox() {
  isManualSandbox = !isManualSandbox;
  const btn = document.getElementById("btn-sandbox-toggle");
  if (btn) {
    btn.innerText = isManualSandbox ? "Mode: manual sandbox" : "Mode: auto mission";
    btn.classList.toggle("is-active", isManualSandbox);
  }
  addEventLog("SYS", isManualSandbox
    ? "Switched to manual flight sandbox."
    : "Restored automatic mission flight profile.");
  onFlightControlChange();
}

function onFlightControlChange() {
  const elThr = document.getElementById("slider-throttle");
  const elAlt = document.getElementById("slider-altitude");
  const elOat = document.getElementById("slider-oat");

  const thr = elThr ? parseFloat(elThr.value) : 72.0;
  const alt = elAlt ? parseFloat(elAlt.value) : 28500.0;
  const oat = elOat ? parseFloat(elOat.value) : -20.0;

  setText("txt-slider-throttle", `${thr.toFixed(0)} %`);
  setText("txt-slider-altitude", `${(alt / 1000).toFixed(1)}k FT`);
  setText("txt-slider-oat", `${oat.toFixed(0)} °C`);

  const body = isManualSandbox
    ? { enabled: true, throttle_pct: thr, altitude_ft: alt, ambient_temp_c: oat }
    : { enabled: false };

  fetch('/api/flight/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(err => console.warn("Flight override error:", err));
}

// ------------------------------------------------------------------
// 10. FAULT INJECTION
// ------------------------------------------------------------------
async function injectFault(faultType, severity = 1.0) {
  playTone(700, 0.08, "sine");
  updateActiveFaultButton(faultType);

  try {
    if (faultType === 'HEALTHY') {
      await fetch('/api/fault/clear', { method: 'POST' });
      addEventLog("SYS", "Operator cleared all injected faults.");
    } else {
      await fetch('/api/fault/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fault_type: faultType, severity: severity, ramp_duration_s: 1.0 })
      });
      // An action, not a condition. The condition appears in the log when
      // the twin's diagnosis actually carries it.
      addEventLog("SYS", `Operator requested ${faultType.replace(/_/g, ' ').toLowerCase()} (ramp 1.0 s).`);
    }
  } catch (e) {
    console.error("Fault injection error:", e);
    addEventLog("ERR", `Fault injection network error: ${e.message}`);
  }
}

// Sensor-probe defects are a caution: the engine is fine, the sensor is not.
const SENSOR_FAULTS = ["SENSOR_FAULT_EGT3", "SENSOR_FAULT_GENERAL"];

function updateActiveFaultButton(activeFaultName) {
  if (activeFaultName === lastActiveFaultButton) return;
  lastActiveFaultButton = activeFaultName;
  currentActiveFault = activeFaultName;

  document.querySelectorAll(".btn-fault").forEach(btn => {
    btn.classList.remove("is-active");
    btn.removeAttribute("data-state");
  });

  const activeBtn = document.getElementById(`btn-flt-${activeFaultName}`);
  const statusTxt = document.getElementById("txt-active-status");

  if (activeFaultName === "HEALTHY") {
    if (activeBtn) { activeBtn.classList.add("is-active"); activeBtn.setAttribute("data-state", "none"); }
    if (statusTxt) { statusTxt.innerText = "Status: healthy baseline"; setState(statusTxt, null); }
  } else if (SENSOR_FAULTS.includes(activeFaultName)) {
    if (activeBtn) { activeBtn.classList.add("is-active"); activeBtn.setAttribute("data-state", "caution"); }
    if (statusTxt) {
      statusTxt.innerText = "Status: sensor probe defect (EGT3)";
      setState(statusTxt, "caution");
    }
  } else {
    if (activeBtn) { activeBtn.classList.add("is-active"); activeBtn.setAttribute("data-state", "warning"); }
    if (statusTxt) {
      statusTxt.innerText = `Status: ${activeFaultName.replace(/_/g, ' ').toLowerCase()}`;
      setState(statusTxt, "warning");
    }
  }
}

// ------------------------------------------------------------------
// 11. EVENT LOG
// ------------------------------------------------------------------
const LOG_TAG_STATE = { SYS: null, FLT: "caution", ERR: "warning", AI: null };

function addEventLog(tag, message) {
  const timestamp = new Date().toTimeString().split(' ')[0];
  eventLogs.unshift({ timestamp, tag, message });
  if (eventLogs.length > maxEventLogs) eventLogs.pop();

  const countEl = document.getElementById("txt-log-count");
  if (countEl) countEl.innerText = `${eventLogs.length} events`;

  const container = document.getElementById("container-logs");
  if (!container) return;
  container.innerHTML = eventLogs.map(log => {
    const st = LOG_TAG_STATE[log.tag];
    const attr = st ? ` data-state="${st}"` : "";
    return `<div class="log-line"><span class="log-time">${log.timestamp}</span> <span class="log-tag"${attr}>${log.tag}</span> ${log.message}</div>`;
  }).join('');
}

// ------------------------------------------------------------------
// 12. AUTO DEMO — the full arc, start to recovery
// ------------------------------------------------------------------
const autoDemoPhases = [
  { fault: "HEALTHY", inject: true, severity: 1.0, duration: 8,
    title: "1/6 Healthy baseline",
    note: "Model tracks every sensor channel inside ±1σ." },

  { fault: "OIL_PRESSURE_LOSS", inject: true, severity: 1.0, duration: 5,
    title: "2/6 Fault injection",
    note: "Lubrication pressure loss injected on a 1.0 s ramp." },

  { fault: "OIL_PRESSURE_LOSS", inject: false, duration: 6,
    title: "3/6 Anomaly detection",
    note: "Autoencoder reconstruction error crosses the calibrated threshold." },

  { fault: "OIL_PRESSURE_LOSS", inject: false, duration: 7,
    title: "4/6 Diagnosis",
    note: "Classifier isolates the root cause; attribution ranks the evidence." },

  { fault: "OIL_PRESSURE_LOSS", inject: false, duration: 7,
    title: "5/6 RUL collapse",
    note: "Prognostic horizon revised down; superseded range retained." },

  { fault: "HEALTHY", inject: true, severity: 1.0, duration: 7,
    title: "6/6 Recovery",
    note: "Fault cleared; health and prognosis return to baseline." }
];

function toggleAutoDemo() {
  if (autoDemoActive) stopAutoDemo();
  else startAutoDemo();
}

function startAutoDemo() {
  autoDemoActive = true;
  autoDemoStep = 0;
  const bar = document.getElementById("box-autodemo-status");
  const btn = document.getElementById("btn-autodemo");
  if (bar) bar.hidden = false;
  if (btn) { btn.classList.add("is-active"); btn.innerText = "■ Auto demo"; }
  addEventLog("SYS", "Automated demonstration arc started (6 phases).");
  runNextDemoPhase();
}

function runNextDemoPhase() {
  if (!autoDemoActive) return;
  if (autoDemoStep >= autoDemoPhases.length) {
    addEventLog("SYS", "Automated demonstration arc completed.");
    stopAutoDemo();
    return;
  }

  const phase = autoDemoPhases[autoDemoStep];
  if (phase.inject) injectFault(phase.fault, phase.severity !== undefined ? phase.severity : 1.0);
  addEventLog("SYS", `${phase.title} — ${phase.note}`);
  autoDemoTimeRemaining = phase.duration;

  const txtPhase = document.getElementById("txt-autodemo-phase");
  const render = () => {
    if (txtPhase) txtPhase.innerText = `${phase.title} · ${autoDemoTimeRemaining}s`;
  };
  render();

  if (autoDemoTimer) clearInterval(autoDemoTimer);
  autoDemoTimer = setInterval(() => {
    autoDemoTimeRemaining--;
    render();
    if (autoDemoTimeRemaining <= 0) {
      clearInterval(autoDemoTimer);
      autoDemoStep++;
      runNextDemoPhase();
    }
  }, 1000);
}

function stopAutoDemo() {
  autoDemoActive = false;
  if (autoDemoTimer) clearInterval(autoDemoTimer);
  const bar = document.getElementById("box-autodemo-status");
  const btn = document.getElementById("btn-autodemo");
  if (bar) bar.hidden = true;
  if (btn) { btn.classList.remove("is-active"); btn.innerText = "▶ Auto demo"; }
  injectFault("HEALTHY");
  addEventLog("SYS", "Automated demonstration stopped.");
}

// ------------------------------------------------------------------
// 13. SIMULATION & CAMERA CONTROLS
// ------------------------------------------------------------------
function setSimSpeed(speed) {
  fetch(`/api/sim/speed?speed=${speed}`, { method: 'POST' }).catch(e => {});
  ['1', '2', '5'].forEach(s => {
    const btn = document.getElementById(`btn-spd-${s}`);
    if (btn) btn.classList.toggle("is-active", parseFloat(s) === speed);
  });
  addEventLog("SYS", `Simulation rate set to ${speed}x.`);
}

function setCameraPreset(preset) {
  if (engine3D && typeof engine3D.setCameraPreset === "function") {
    engine3D.setCameraPreset(preset);
  }
}

// Bridges the cylinder strip's click handlers to the 3D view.
function focusCylinder(index) {
  if (engine3D && typeof engine3D.focusCylinder === "function") {
    engine3D.focusCylinder(index);
  }
}

function resetSimulation() {
  fetch('/api/sim/reset', { method: 'POST' }).catch(e => {});
  injectFault('HEALTHY');
  rulPrevious = null;
  rulCurrent = null;
  rulSamples = [];
  lastRevisionAt = 0;
  aiHistory = [];
  Object.keys(damperBuffers).forEach(k => delete damperBuffers[k]);
  Object.keys(lastHealthState).forEach(k => delete lastHealthState[k]);
  const prevEl = document.getElementById("txt-rul-previous");
  if (prevEl) prevEl.hidden = true;
  addEventLog("SYS", "Simulation reset to initial flight condition.");
}

// ------------------------------------------------------------------
// 14. DEBRIEF — POST-FLIGHT ANALYSIS & MISSION REPLAY
//
// Sorties are recorded server-side by the flight data recorder. Replay is
// driven by the backend and arrives over the same telemetry transport as
// live flight, so nothing else in this file needs to know which it is
// watching — the frames carry a `source` field for the status badge only.
// ------------------------------------------------------------------
let debriefSessions = [];
let selectedSessionId = null;

function toggleDebrief() {
  const panel = document.getElementById("panel-debrief");
  const btn = document.getElementById("btn-debrief-open");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (btn) {
    btn.innerText = panel.hidden ? "Debrief ▾" : "Debrief ▴";
    btn.classList.toggle("is-active", !panel.hidden);
  }
  if (!panel.hidden) refreshSessions();
}

function fmtDuration(s) {
  if (s === null || s === undefined) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

async function refreshSessions() {
  const sel = document.getElementById("sel-session");
  if (!sel) return;
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    debriefSessions = data.sessions || [];

    if (debriefSessions.length === 0) {
      sel.innerHTML = '<option value="">— no sorties recorded yet —</option>';
      setDebriefSummary("The recorder starts with the server. Fly for a few seconds, then refresh.");
      return;
    }

    sel.innerHTML = debriefSessions.map(s => {
      const active = (s.session_id === data.active) ? " · recording" : "";
      const faults = (s.fault_classes && s.fault_classes.length)
        ? ` · ${s.fault_classes.length} fault${s.fault_classes.length > 1 ? "s" : ""}`
        : " · clean";
      return `<option value="${s.session_id}">${s.session_id} — ${fmtDuration(s.duration_s)}${faults}${active}</option>`;
    }).join("");

    // Keep the operator's selection across refreshes where possible.
    if (selectedSessionId && debriefSessions.some(s => s.session_id === selectedSessionId)) {
      sel.value = selectedSessionId;
    } else {
      selectedSessionId = sel.value;
    }
    onSessionSelected();
  } catch (e) {
    sel.innerHTML = '<option value="">— recorder unavailable —</option>';
    setDebriefSummary("Could not reach the flight data recorder.");
  }
}

function setDebriefSummary(html) {
  const box = document.getElementById("box-debrief-summary");
  if (box) box.innerHTML = html;
}

async function onSessionSelected() {
  const sel = document.getElementById("sel-session");
  if (!sel || !sel.value) return;
  selectedSessionId = sel.value;
  setDebriefSummary("Analysing…");

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();

    const bands = Object.entries(r.time_in_band_s || {})
      .map(([k, v]) => `${k} ${fmtDuration(v)}`).join(" · ") || "—";

    const events = (r.fault_events || []).length
      ? r.fault_events.slice(0, 4).map(e =>
          `<span class="text-dim">${e.start_s}s</span> ${e.fault_class}` +
          (e.is_sensor_fault ? " <span class='text-dim'>(probe)</span>" : "") +
          ` <span class="text-dim">${fmtDuration(e.duration_s)}</span>`
        ).join(" &nbsp;|&nbsp; ")
      : "<span class='text-dim'>no faults diagnosed</span>";

    const latency = (r.trigger_to_diagnosis_s !== null && r.trigger_to_diagnosis_s !== undefined)
      ? `${r.trigger_to_diagnosis_s}s trigger→diagnosis`
      : "no anomaly";

    setDebriefSummary(
      `<div><span class="text-dim">Duration</span> ${fmtDuration(r.duration_s)} · ` +
      `<span class="text-dim">Frames</span> ${r.frame_count.toLocaleString()} · ` +
      `<span class="text-dim">Altitude</span> ${Math.round(r.altitude_ft_min).toLocaleString()}–${Math.round(r.altitude_ft_max).toLocaleString()} ft · ` +
      `<span class="text-dim">Health</span> min ${r.health_min_pct}% / mean ${r.health_mean_pct}% · ` +
      `<span class="text-dim">Worst</span> ${r.worst_band} · ${latency}</div>` +
      `<div style="margin-top:2px"><span class="text-dim">Time in band</span> ${bands}</div>` +
      `<div style="margin-top:2px"><span class="text-dim">Events</span> ${events}</div>`
    );
  } catch (e) {
    setDebriefSummary("Could not load the post-flight report for this sortie.");
  }
}

async function startReplay() {
  if (!selectedSessionId) return;
  try {
    const res = await fetch('/api/replay/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: selectedSessionId, speed: 1.0 })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    addEventLog("SYS", `Replaying sortie ${selectedSessionId} (${d.frames} frames).`);
  } catch (e) {
    addEventLog("SYS", "Replay could not be started.");
  }
}

async function stopReplay() {
  try {
    await fetch('/api/replay/stop', { method: 'POST' });
    addEventLog("SYS", "Returned to live telemetry.");
  } catch (e) {}
}

// Called from updateDashboard on every frame; cheap and idempotent.
function updateReplayBadge(state) {
  const el = document.getElementById("txt-replay-status");
  if (!el) return;
  if (state && state.source === "REPLAY" && state.replay) {
    const r = state.replay;
    const pct = r.total_frames ? Math.round((r.cursor / r.total_frames) * 100) : 0;
    el.innerText = state.replay_complete
      ? `Replay complete · ${r.session_id}`
      : `Replay ${pct}% · ${r.session_id}`;
    el.setAttribute("data-state", "caution");
  } else {
    el.innerText = "Live";
    el.removeAttribute("data-state");
  }
}

// ------------------------------------------------------------------
// 15. COMPONENT SELECTION & INSPECTOR
//
// The 3D model, the cylinder strip and the subsystem tiles are three views
// of the same set of components. Selecting in any one of them selects in
// all of them, and the inspector shows the channels behind whatever is
// selected — measured, model-expected, and the residual between them.
// ------------------------------------------------------------------
let selectedComponentId = null;

// Which selectable chrome element corresponds to which component id.
const COMPONENT_CHROME = {
  'cyl-0': 'cyl-cell-0',
  'cyl-1': 'cyl-cell-1',
  'cyl-2': 'cyl-cell-2',
  'cyl-3': 'cyl-cell-3',
  'sump': 'stat-oil',
  'turbo': 'stat-turbo',
  'crankcase': 'stat-vib'
};

function selectComponent(id) {
  // Selecting the same thing twice clears it, so a second click is an undo.
  if (id && id === selectedComponentId) { clearComponentSelection(); return; }
  if (engine3D && typeof engine3D.select === "function") {
    engine3D.select(id);          // fires onSelect, which lands in onComponentSelected
  } else {
    onComponentSelected(id);
  }
}

function clearComponentSelection() {
  if (engine3D && typeof engine3D.select === "function") engine3D.select(null);
  else onComponentSelected(null);
}

function onComponentSelected(id) {
  selectedComponentId = id;

  // Mirror the selection onto the tiles and the cylinder strip.
  Object.entries(COMPONENT_CHROME).forEach(([cid, elId]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (cid === id) el.setAttribute("data-selected", "true");
    else el.removeAttribute("data-selected");
  });

  const panel = document.getElementById("panel-inspector");
  const hint = document.getElementById("txt-model-hint");
  if (panel) panel.hidden = !id;
  if (hint) hint.hidden = !!id;

  if (id) renderInspector();
}

function toggleModelLabels() {
  if (!engine3D || typeof engine3D.setLabelsVisible !== "function") return;
  const next = !engine3D.labelsVisible;
  engine3D.setLabelsVisible(next);
  const btn = document.getElementById("btn-labels");
  if (btn) btn.classList.toggle("is-active", next);
}

// Residual grading uses the same sigma thresholds as the health index, so a
// value the inspector calls CAUTION is the same value the panel border does.
function residualState(sigma) {
  const a = Math.abs(Number(sigma) || 0);
  if (a >= 6.0) return "warning";
  if (a >= 3.0) return "caution";
  return "nominal";
}

function renderInspector() {
  if (!selectedComponentId || !engine3D) return;
  const info = engine3D.describeComponent(selectedComponentId, latestTwinState);
  if (!info) return;

  setText("txt-inspector-title", info.title);

  const healthEl = document.getElementById("txt-inspector-health");
  if (healthEl) {
    if (info.healthPct === null || info.healthPct === undefined) {
      healthEl.hidden = true;
    } else {
      healthEl.hidden = false;
      healthEl.innerText = `${Number(info.healthPct).toFixed(1)} %`;
      setState(healthEl, healthState(info.healthPct, "inspector"));
    }
  }

  const tbody = document.getElementById("tbody-inspector");
  if (tbody) {
    tbody.innerHTML = info.rows.map(r => {
      const hasRes = r.r !== undefined && r.r !== null;
      const st = hasRes ? residualState(r.r) : "nominal";
      const resTxt = hasRes ? `${Number(r.r) >= 0 ? "+" : ""}${Number(r.r).toFixed(1)} σ` : "—";
      return `<tr>
        <td>${r.k}</td>
        <td class="v-meas">${r.v}</td>
        <td class="v-model">${r.exp === undefined ? "—" : r.exp}</td>
        <td class="v-res" data-state="${st}">${resTxt}</td>
      </tr>`;
    }).join("");
  }

  setText("txt-inspector-note", info.note || "");
}

// ------------------------------------------------------------------
// 16. ENGINE BAY — fit a powerplant, or define one
//
// The problem statement names a single engine. Anyone whose airframe carries
// something else can describe it here and fly it immediately: the physics is
// genuinely re-parameterised, not rescaled.
//
// One thing is stated plainly rather than hidden: the anomaly threshold and
// the fault classifier are trained on the reference engine's residuals. Fitting
// another powerplant gives correct physics and an uncalibrated AI layer, and
// the operator is told so on screen rather than left to assume.
// ------------------------------------------------------------------
let engineCatalogue = [];
let fittedEngineId = null;
let derateRows = [];

function toggleEnginePanel() {
  const panel = document.getElementById("panel-engine");
  const btn = document.getElementById("btn-engine-open");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (btn) {
    btn.innerText = panel.hidden ? "Engine ▾" : "Engine ▴";
    btn.classList.toggle("is-active", !panel.hidden);
  }
  if (!panel.hidden) refreshEngines();

  // The panel sits in normal flow, so opening it resizes the workspace under
  // it. The renderer has to be told, twice: once on the next frame and once
  // after the panel's own transition has settled.
  if (engine3D && typeof engine3D.onWindowResize === "function") {
    requestAnimationFrame(() => engine3D.onWindowResize());
    setTimeout(() => engine3D.onWindowResize(), 80);
  }
}

// Full configs, keyed by engine id. Fetched once each: the catalogue can hold
// a dozen engines and the picker is used by clicking through them.
const engineDetailCache = {};

async function loadEngineDetail(id) {
  if (engineDetailCache[id]) return engineDetailCache[id];
  const res = await fetch(`/api/engines/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  engineDetailCache[id] = d;
  return d;
}

const LAYOUT_NAMES = {
  inline: "Inline",
  boxer: "Horizontally opposed",
  vee: "Vee"
};

function setEngineSpec(html) {
  const el = document.getElementById("box-engine-spec");
  if (el) el.innerHTML = html;
}

/** One labelled figure in the spec sheet. Empty values drop out entirely. */
function specCell(label, value, sub) {
  if (value === undefined || value === null || value === "") return "";
  return `<div class="spec-cell"><span class="spec-label">${label}</span>` +
         `<span class="spec-value">${value}</span>` +
         (sub ? `<span class="spec-sub">${sub}</span>` : "") + `</div>`;
}

const engNum = (v, d) =>
  (v === undefined || v === null || isNaN(v)) ? null : Number(v).toFixed(d || 0);

// Config keys, as an engineer would say them. The provenance block lists the
// fields it covers by key; a reader should not have to decode JSON names.
const FIELD_LABELS = {
  engine_name: "name",
  displacement_litres: "displacement",
  cylinders: "cylinder count",
  cylinder_layout: "bank layout",
  rated_power_hp_sealevel: "rated power",
  rated_rpm: "rated RPM",
  max_continuous_rpm: "max continuous RPM",
  idle_rpm: "idle RPM",
  compression_ratio: "compression ratio",
  turbocharged: "induction",
  intercooled: "intercooling",
  max_boost_bar: "max boost",
  nominal_operating_parameters: "operating limits",
  sensor_specifications: "sensor characteristics",
  end_of_life_limits: "end-of-life limits",
  altitude_power_derating: "altitude power curve",
  all: "every figure"
};

const PROVENANCE_TIERS = [
  ["published", "Published", "Transcribed from the manufacturer's specification."],
  ["computed", "Computed", "Derived from a stated relation."],
  ["modelled", "Modelled", "Representative, not read from a data sheet."]
];

/**
 * Renders where this engine's numbers came from.
 *
 * Reviewers ask whether a figure is a published specification or an estimate.
 * The configs carry that answer per field, so the sheet states it rather than
 * leaving the reader to assume.
 */
function renderProvenance(prov) {
  if (!prov) return "";

  const rows = PROVENANCE_TIERS.map(([key, label, blurb]) => {
    const fields = prov[key] || [];
    if (!fields.length) return "";
    const named = fields.map(f => FIELD_LABELS[f] || f).join(", ");
    const why = (prov.notes && prov.notes[key]) || blurb;
    return `<div class="prov-row" data-tier="${key}">` +
           `<span class="prov-tag">${label}</span>` +
           `<span class="prov-fields">${named}</span>` +
           `<span class="prov-why">${why}</span></div>`;
  }).join("");

  return `<div class="spec-prov">` +
         `<span class="spec-label">Where these numbers come from</span>` +
         `<div class="prov-summary">${prov.summary || ""}</div>` +
         rows + `</div>`;
}

/**
 * Renders the full spec of one engine. Every figure comes from that engine's
 * own config file, so no two engines in the catalogue read the same.
 */
function renderEngineSpec(id, detail) {
  const c = (detail && detail.config) || {};
  const nom = c.nominal_operating_parameters || {};
  const table = c.altitude_power_derating || [];
  const fitted = id === fittedEngineId;

  const dispL = c.displacement_litres;
  const cc = dispL ? Math.round(dispL * 1000).toLocaleString() : null;
  // Same relation the 3D model uses to size the engine: a square engine with
  // bore = stroke, so bore = cbrt(4 * swept volume per cylinder / pi).
  const boreMm = (dispL && c.cylinders)
    ? Math.cbrt(4 * (dispL * 1e6 / c.cylinders) / Math.PI) : null;

  const ceiling = table.length
    ? Math.max.apply(null, table.map(r => Number(r.altitude_ft) || 0)) : null;
  const topRow = table.length
    ? table.reduce((a, b) => (Number(b.altitude_ft) > Number(a.altitude_ft) ? b : a))
    : null;

  const cells = [
    specCell("Rated power", `${engNum(c.rated_power_hp_sealevel)} HP`,
             `at ${engNum(c.rated_rpm)} rpm, sea level`),
    specCell("Displacement", cc ? `${cc} cc` : null, dispL ? `${dispL} litres` : ""),
    specCell("Cylinders", c.cylinders,
             c.turbocharged === false ? "naturally aspirated" : "turbocharged"),
    specCell("Bank layout", LAYOUT_NAMES[c.cylinder_layout || "inline"]
                            || LAYOUT_NAMES.inline, "as drawn in the 3D view"),
    specCell("Bore", boreMm ? `${boreMm.toFixed(0)} mm` : null,
             "derived, square engine"),
    specCell("Compression", c.compression_ratio ? `${c.compression_ratio}:1` : null,
             c.intercooled ? "intercooled" : ""),
    specCell("Max boost", engNum(c.max_boost_bar, 2), "bar absolute"),
    specCell("RPM range", `${engNum(c.idle_rpm)} – ${engNum(c.max_continuous_rpm)}`,
             "idle to max continuous"),
    specCell("Nominal EGT", nom.egt_nominal_celsius ? `${engNum(nom.egt_nominal_celsius)} °C` : null,
             nom.egt_alarm_celsius ? `alarm ${engNum(nom.egt_alarm_celsius)} °C` : ""),
    specCell("Nominal CHT", nom.cht_nominal_celsius ? `${engNum(nom.cht_nominal_celsius)} °C` : null,
             nom.cht_alarm_celsius ? `alarm ${engNum(nom.cht_alarm_celsius)} °C` : ""),
    specCell("Oil pressure", nom.oil_pressure_nominal_bar ? `${engNum(nom.oil_pressure_nominal_bar, 1)} bar` : null,
             nom.oil_pressure_min_safe_bar ? `min safe ${engNum(nom.oil_pressure_min_safe_bar, 2)} bar` : ""),
    specCell("Cruise fuel", nom.fuel_flow_cruise_lph ? `${engNum(nom.fuel_flow_cruise_lph, 1)} L/h` : null,
             nom.fuel_flow_max_lph ? `max ${engNum(nom.fuel_flow_max_lph, 1)} L/h` : ""),
    specCell("Tested ceiling", ceiling ? `${ceiling.toLocaleString()} ft` : null,
             topRow ? `${engNum(topRow.power_hp)} HP available there` : ""),
    specCell("Vibration", nom.vibration_nominal_g_rms ? `${engNum(nom.vibration_nominal_g_rms, 1)} g` : null,
             nom.vibration_alarm_g_rms ? `alarm ${engNum(nom.vibration_alarm_g_rms, 1)} g` : "")
  ].join("");

  // The derating curve distinguishes one engine from another at altitude,
  // which is the regime this whole problem is about.
  const curve = table.length ? `<div class="spec-curve">
      <span class="spec-label">Power with altitude</span>
      <div class="spec-curve-row">${table
        .slice().sort((a, b) => a.altitude_ft - b.altitude_ft)
        .map(r => `<span class="spec-pt"><b>${engNum(r.power_hp)}</b> HP` +
                  `<i>${Number(r.altitude_ft).toLocaleString()} ft</i></span>`).join("")}</div>
    </div>` : "";

  const banner = fitted
    ? `<div class="spec-banner is-fitted">Fitted and running · the telemetry on this page is this engine.</div>`
    : `<div class="spec-banner">Previewing <b>${c.engine_name || id}</b>. ` +
      `Press <b>Fit</b> to fly the sortie on it. Live telemetry is still the fitted engine.</div>`;

  const note = c.notes ? `<div class="spec-note">${c.notes}</div>` : "";
  const prov = renderProvenance(c.data_provenance);

  setEngineSpec(banner + `<div class="spec-grid">${cells}</div>` + curve + note + prov);
}

/**
 * Runs when the dropdown selection changes. Nothing was wired to the select
 * before, which is why picking a different engine changed no figure on screen.
 */
async function previewSelectedEngine() {
  const sel = document.getElementById("sel-engine");
  if (!sel || !sel.value) return;
  const id = sel.value;
  const row = engineCatalogue.find(x => x.id === id);

  const kind = row ? (row.builtin ? (row.is_reference ? "reference engine" : "built-in")
                                  : "custom engine") : "";
  const head = id === fittedEngineId ? "Fitted" : "Selected";
  setEngineStatus(
    `<div><span class="text-dim">${head}</span> <b>${row ? row.name : id}</b>` +
    (kind ? ` <span class="text-dim">· ${kind}</span>` : "") + `</div>` +
    (id === fittedEngineId ? "" :
      `<div class="text-dim" style="margin-top:2px">Press Fit to run it.</div>`));

  // Shape the 3D model to whatever is selected, so the viewport answers the
  // click. It reverts as soon as the fitted engine is selected again.
  if (row && engine3D && typeof engine3D.setEngineSpec === "function") {
    try {
      engine3D.setEngineSpec({
        name: row.name,
        cylinders: row.cylinders,
        turbocharged: row.turbocharged,
        displacementLitres: row.displacement_litres,
        ratedPowerHp: row.rated_power_hp,
        ratedRpm: row.rated_rpm,
        layout: row.cylinder_layout
      });
    } catch (err) { /* a geometry failure must not block the spec sheet */ }
  }

  try {
    renderEngineSpec(id, await loadEngineDetail(id));
  } catch (err) {
    setEngineSpec(`<div class="spec-banner">Could not load the full spec. ${err.message}</div>`);
  }
}

function setEngineStatus(html) {
  const el = document.getElementById("box-engine-status");
  if (el) el.innerHTML = html;
}

async function refreshEngines() {
  const sel = document.getElementById("sel-engine");
  if (!sel) return;
  try {
    const res = await fetch('/api/engines');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    engineCatalogue = data.engines || [];
    fittedEngineId = data.fitted;

    sel.innerHTML = engineCatalogue.map(e => {
      const kind = e.builtin ? (e.is_reference ? "reference" : "built-in") : "custom";
      const fit = e.id === fittedEngineId ? " · fitted" : "";
      return `<option value="${e.id}">${e.name} — ${e.rated_power_hp} HP · ${kind}${fit}</option>`;
    }).join("");
    if (fittedEngineId) sel.value = fittedEngineId;

    previewSelectedEngine();
  } catch (e) {
    describeFittedEngine();
    setEngineStatus("Could not reach the engine catalogue.");
  }
}

function describeFittedEngine() {
  const e = engineCatalogue.find(x => x.id === fittedEngineId);
  if (!e) { setEngineStatus("No engine information."); return; }

  const spec = `${e.displacement_litres} L · ${e.cylinders} cyl · ` +
               `${e.rated_power_hp} HP @ ${Math.round(e.rated_rpm)} rpm · ` +
               `${e.max_boost_bar} bar · ceiling ${Math.round(e.ceiling_ft).toLocaleString()} ft`;

  const warn = e.is_reference ? "" :
    `<div class="engine-warn">Diagnosis is calibrated for the reference engine. ` +
    `Physics models <b>${e.name}</b> correctly; fault classification on it is ` +
    `indicative until the models are retrained.</div>`;

  setEngineStatus(
    `<div><span class="text-dim">Fitted</span> <b>${e.name}</b></div>` +
    `<div class="text-dim" style="margin-top:2px">${spec}</div>` + warn);
}

async function fitSelectedEngine() {
  const sel = document.getElementById("sel-engine");
  if (!sel || !sel.value) return;
  setEngineStatus("Fitting engine and restarting the sortie…");
  try {
    const res = await fetch(`/api/engines/${encodeURIComponent(sel.value)}/fit`,
                            { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || `HTTP ${res.status}`);
    addEventLog("SYS", `Fitted ${d.engine.name}. ${d.diagnosis_calibrated ? "" : "Diagnosis uncalibrated for this engine."}`);
    await refreshEngines();
  } catch (e) {
    setEngineStatus(`Could not fit that engine. ${e.message}`);
  }
}

async function deleteSelectedEngine() {
  const sel = document.getElementById("sel-engine");
  if (!sel || !sel.value) return;
  const e = engineCatalogue.find(x => x.id === sel.value);
  if (e && e.builtin) {
    setEngineStatus("Built-in engines cannot be deleted.");
    return;
  }
  try {
    const res = await fetch(`/api/engines/${encodeURIComponent(sel.value)}`,
                            { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || `HTTP ${res.status}`);
    addEventLog("SYS", `Deleted engine ${sel.value}.`);
    await refreshEngines();
  } catch (e) {
    setEngineStatus(e.message);
  }
}

// -- builder form ---------------------------------------------------

function toggleEngineForm() {
  const box = document.getElementById("box-engine-form");
  if (!box) return;
  box.hidden = !box.hidden;
  const btn = document.getElementById("btn-engine-new");
  if (btn) btn.classList.toggle("is-active", !box.hidden);
  if (!box.hidden) prefillEngineForm();
}

async function prefillEngineForm() {
  // Start from the reference engine so every box holds a plausible number and
  // the user edits rather than invents.
  try {
    const res = await fetch('/api/engines/template');
    const t = await res.json();
    const nom = t.nominal_operating_parameters || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

    set("eng-name", "My Engine");
    set("eng-disp", Math.round((t.displacement_litres || 0) * 1000));
    set("eng-cyl", t.cylinders);
    set("eng-power", t.rated_power_hp_sealevel);
    set("eng-rated-rpm", t.rated_rpm);
    set("eng-idle-rpm", t.idle_rpm);
    set("eng-gov-rpm", t.max_continuous_rpm);
    set("eng-cr", t.compression_ratio);
    set("eng-boost", t.max_boost_bar);
    set("eng-egt", nom.egt_nominal_celsius);
    set("eng-cht", nom.cht_nominal_celsius);
    set("eng-oilp", nom.oil_pressure_nominal_bar);

    derateRows = (t.altitude_power_derating || []).map(r => ({ ...r }));
    renderDerateRows();
  } catch (e) {
    setEngineStatus("Could not load the engine template.");
  }
}

function renderDerateRows() {
  const tb = document.getElementById("tbody-derate");
  if (!tb) return;
  tb.innerHTML = derateRows.map((r, i) => `
    <tr>
      <td><input type="number" step="500" value="${r.altitude_ft}"
                 oninput="updateDerate(${i},'altitude_ft',this.value)"></td>
      <td><input type="number" step="1" value="${r.power_hp}"
                 oninput="updateDerate(${i},'power_hp',this.value)"></td>
      <td><input type="number" step="0.01" value="${r.rated_boost_bar}"
                 oninput="updateDerate(${i},'rated_boost_bar',this.value)"></td>
      <td><button class="btn" onclick="removeDerateRow(${i})" title="Remove">✕</button></td>
    </tr>`).join("");
}

function updateDerate(i, key, value) {
  if (derateRows[i]) derateRows[i][key] = parseFloat(value);
}

function addDerateRow() {
  const last = derateRows[derateRows.length - 1] || { altitude_ft: 0, power_hp: 100, rated_boost_bar: 1.5 };
  derateRows.push({
    altitude_ft: Number(last.altitude_ft) + 5000,
    power_hp: Math.max(5, Number(last.power_hp) - 20),
    rated_boost_bar: Math.max(0.5, Number(last.rated_boost_bar) - 0.2)
  });
  renderDerateRows();
}

function removeDerateRow(i) {
  derateRows.splice(i, 1);
  renderDerateRows();
}

function showEngineErrors(list) {
  const box = document.getElementById("box-engine-errors");
  if (!box) return;
  if (!list || !list.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = list.map(e => `<div>${e}</div>`).join("");
}

async function saveCustomEngine(alsoFit) {
  const num = (id) => parseFloat((document.getElementById(id) || {}).value);
  const body = {
    engine_name: (document.getElementById("eng-name") || {}).value || "",
    // The form asks for cc because that is how engines in this class are
    // quoted; the schema stores litres.
    displacement_litres: num("eng-disp") / 1000.0,
    cylinders: Math.round(num("eng-cyl")),
    rated_power_hp_sealevel: num("eng-power"),
    rated_rpm: num("eng-rated-rpm"),
    idle_rpm: num("eng-idle-rpm"),
    max_continuous_rpm: num("eng-gov-rpm"),
    compression_ratio: num("eng-cr"),
    turbocharged: true,
    max_boost_bar: num("eng-boost"),
    intercooled: true,
    altitude_power_derating: derateRows.map(r => ({
      altitude_ft: Number(r.altitude_ft),
      power_hp: Number(r.power_hp),
      rated_boost_bar: Number(r.rated_boost_bar)
    })),
    nominal_operating_parameters: {
      egt_nominal_celsius: num("eng-egt"),
      cht_nominal_celsius: num("eng-cht"),
      oil_pressure_nominal_bar: num("eng-oilp"),
      bus_voltage_nominal_v: 28.0
    }
  };

  showEngineErrors(null);
  try {
    const res = await fetch('/api/engines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await res.json();
    if (!res.ok) {
      // The server returns every problem at once so the form can show them
      // together rather than one per submission.
      showEngineErrors(String(d.detail || `HTTP ${res.status}`).split(". ").filter(Boolean));
      return;
    }
    addEventLog("SYS", `Created engine "${d.engine.name}".`);
    // A config can be valid and still sit outside the range the correlations
    // were fitted on. Say so plainly rather than letting the numbers imply
    // more confidence than they carry.
    ((d.engine && d.engine.warnings) || []).forEach(
      w => addEventLog("SYS", `Note: ${w}`));
    toggleEngineForm();
    await refreshEngines();

    if (alsoFit === true) {
      const sel = document.getElementById("sel-engine");
      if (sel) sel.value = d.engine.id;
      await fitSelectedEngine();
    }
  } catch (e) {
    showEngineErrors([e.message]);
  }
}

/**
 * Shows the litre equivalent while a displacement is typed in cc.
 * Small UAV engines are always quoted in cc and large aero engines in litres,
 * so showing both removes a unit slip that would otherwise scale the whole
 * engine by a thousand.
 */
function updateDispHint() {
  const el = document.getElementById("eng-disp");
  const hint = document.getElementById("hint-disp");
  if (!el || !hint) return;
  const cc = parseFloat(el.value);
  if (!isFinite(cc) || cc <= 0) { hint.innerHTML = "&nbsp;"; return; }
  hint.textContent = `${(cc / 1000).toFixed(3)} L`;
}

// ------------------------------------------------------------------
// 16. VERDICT BAND & BRIEF MODE
//
// Two additional views of the frame the station is already rendering.
// Neither computes anything: they read `state` exactly as the panels do,
// so a value can never disagree between views. Operate mode keeps every
// panel and control it has today — nothing was moved out of it.
// ------------------------------------------------------------------

/** Nominal / caution / warning for a diagnosis, on the station's own scale. */
function verdictState(ai) {
  const cls = (ai && ai.fault_class) || "HEALTHY";
  if (cls === "HEALTHY") return "nominal";
  if (ai.is_sensor_fault || cls.startsWith("SENSOR_FAULT")) return "caution";
  return (ai.fault_severity || 0) >= 0.6 ? "warning" : "caution";
}

/** Human-readable name for the residual channel that drove the decision. */
function topDriver(ai) {
  const top = (ai && ai.top_contributing_channels) || [];
  if (!top.length) return null;
  return {
    name: top[0].display_name || top[0].channel_key || "—",
    pct: top[0].importance_pct,
  };
}

function updateVerdict(state) {
  const ai = state.ai_prognostics || {};
  const health = state.health || {};
  const cls = (ai.fault_class || "HEALTHY").replace(/_/g, " ");
  const st = verdictState(ai);
  const driver = topDriver(ai);

  // --- the band above the workspace --------------------------------
  const band = document.getElementById("verdict-band");
  if (band && band.getAttribute("data-state") !== st) {
    band.setAttribute("data-state", st);
  }
  setText("txt-verdict-class", cls);
  setText("txt-verdict-meta",
    `${(ai.fault_confidence_pct ?? 100).toFixed(0)} % confidence`);
  setText("txt-verdict-action",
    ai.recommended_action || "Continue nominal mission profile.");
  setText("txt-verdict-health",
    `${(health.overall_health ?? 100).toFixed(1)} %`);
  setText("txt-verdict-rul", formatRul(ai));
  setText("txt-verdict-driver",
    driver ? `${driver.name} · ${driver.pct.toFixed(0)} %` : "—");

  // --- brief mode ---------------------------------------------------
  // Written even while operate mode is showing. It is a handful of
  // setText calls against a cached frame, and it means switching modes
  // never shows a stale screen for a frame.
  document.body.setAttribute("data-verdict", st);
  setText("txt-brief-class", cls);
  setText("txt-brief-meta",
    `${(ai.fault_confidence_pct ?? 100).toFixed(0)} % confidence` +
    (ai.is_sensor_fault ? " · instrumentation, not the engine" : ""));
  setText("txt-brief-action",
    ai.recommended_action || "Continue nominal mission profile.");

  setText("txt-brief-health", (health.overall_health ?? 100).toFixed(1));
  setText("txt-brief-rul", formatRul(ai, true));
  setText("txt-brief-alt",
    Math.round(state.altitude_ft || 0).toLocaleString());
  setText("txt-brief-driver", driver ? driver.name : "—");
  setText("txt-brief-driver-sub",
    driver ? `${driver.pct.toFixed(0)} % of the decision` : "no anomaly");

  const engineName = (state.engine && state.engine.name) || "";
  if (engineName) setText("txt-brief-engine", engineName.replace(/[-_]/g, " "));

  setState(document.getElementById("tile-brief-health"),
    healthState(health.overall_health ?? 100, "brief-health"));
  setState(document.getElementById("tile-brief-rul"),
    st === "warning" ? "warning" : (st === "caution" ? "caution" : null));
  setState(document.getElementById("tile-brief-driver"), driver ? "accent" : null);
}

/** Remaining life, formatted for a readout rather than a table. */
function formatRul(ai, bare) {
  const lo = ai.rul_hours_min, hi = ai.rul_hours_max;
  if (lo === undefined || hi === undefined) return bare ? "—" : "—";
  if (bare) return (lo === hi) ? `${lo.toFixed(0)}` : `${lo.toFixed(0)}–${hi.toFixed(0)}`;
  return (lo === hi) ? `${lo.toFixed(1)} h` : `${lo.toFixed(0)}–${hi.toFixed(0)} h`;
}

// ------------------------------------------------------------------
// Mode switching
//
// The 3D viewport is MOVED between the two layouts, never copied. A WebGL
// canvas cannot be cloned, and two of them would be two engines drifting
// apart. Moving the element preserves its context; the renderer only needs
// telling that its box changed size.
// ------------------------------------------------------------------
let briefMode = false;

function toggleBriefMode() {
  setBriefMode(!briefMode);
}

function setBriefMode(on) {
  briefMode = !!on;

  const brief = document.getElementById("brief-view");
  const slot = document.getElementById("brief-3d-slot");
  const home = document.getElementById("panel-3d");
  const viewport = document.getElementById("container-3d");
  const btn = document.getElementById("btn-mode");

  document.body.setAttribute("data-mode", briefMode ? "brief" : "operate");
  if (brief) brief.hidden = !briefMode;

  if (viewport && slot && home) {
    if (briefMode) {
      slot.appendChild(viewport);
    } else {
      // Back to its original position: first child of its panel, above the
      // cylinder strip and the inspector.
      home.insertBefore(viewport, home.children[1] || null);
    }
  }

  if (btn) {
    btn.innerText = briefMode ? "Mode: brief" : "Mode: operate";
    btn.classList.toggle("is-active", briefMode);
  }

  // The viewport has a different box in each mode, so the renderer has to
  // remeasure or the model arrives letterboxed.
  if (engine3D && typeof engine3D.onWindowResize === "function") {
    requestAnimationFrame(() => engine3D.onWindowResize());
    setTimeout(() => engine3D.onWindowResize(), 60);
  }

  if (latestTwinState) updateVerdict(latestTwinState);
  addEventLog("SYS", briefMode
    ? "Switched to brief mode — same telemetry, sized for a room."
    : "Returned to the operator station.");
}

// B toggles modes, but never while something is being typed into.
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "b" && ev.key !== "B") return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" ||
            t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (document.body.getAttribute("data-phase") !== "app") return;
  ev.preventDefault();
  toggleBriefMode();
});
