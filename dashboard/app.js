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
const THEME = (() => {
  const css = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  };
  const t = {
    bgPage: css('--bg-page', '#0E0F11'),
    bgChrome: css('--bg-chrome', '#141619'),
    bgPanel: css('--bg-panel', '#17191C'),
    bgElevated: css('--bg-elevated', '#24272B'),
    border: css('--border', '#2A2D31'),
    textPrimary: css('--text-primary', '#E8E6E1'),
    textMuted: css('--text-muted', '#8A8F96'),
    textDim: css('--text-dim', '#6B7076'),
    caution: css('--caution', '#EF9F27'),
    cautionDim: css('--caution-dim', '#BA7517'),
    warning: css('--warning', '#E24B4A'),
    ok: css('--ok', '#97C459'),
    cautionBand: css('--caution-band', 'rgba(239,159,39,0.13)'),
    warningBand: css('--warning-band', 'rgba(226,75,74,0.13)'),
    trace: [
      css('--trace-1', '#E8E6E1'),
      css('--trace-2', '#C2BFB9'),
      css('--trace-3', '#9B9992'),
      css('--trace-4', '#74726D')
    ],
    fontMono: "'JetBrains Mono', ui-monospace, Menlo, monospace",
    fsTick: 11
  };
  t.hex = (c) => parseInt(String(c).replace('#', ''), 16);
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
let lastActiveFaultButton = null;
let lastShapSignature = "";
let lastOverallStatus = "";
let eventLogs = [];
let maxEventLogs = 30;

// RUL revision tracking — the previous range stays on screen as evidence.
let rulCurrent = null;      // { min, max }
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
  time: [],
  sensor_egt1: [], sensor_egt2: [], sensor_egt3: [], sensor_egt4: [],
  mvem_egt: [],
  sensor_oil_p: [], mvem_oil_p: [],
  sensor_map: [], mvem_map: [],
  sensor_vib: [], mvem_vib: []
};

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
function setMetric(valueId, text, pct, tileId) {
  const st = healthState(pct, valueId);
  const el = document.getElementById(valueId);
  if (el) {
    if (el.innerText !== text) el.innerText = text;
    const cls = st === "warning" ? "is-warning" : (st === "caution" ? "is-caution" : "");
    if (el.className !== cls) el.className = cls;
  }
  if (tileId) setState(document.getElementById(tileId), st);
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
// 1. INITIALIZATION
// ------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  console.log("ENGINE-TWIN GCS Controller Initialized.");

  if (typeof Engine3DView !== "undefined") {
    try { engine3D = new Engine3DView("container-3d"); }
    catch (e) { console.warn("3D View Init Warning:", e); }
  }

  try { initCharts(); }
  catch (e) { console.error("Charts Init Error:", e); }

  connectWebSocket();
  addEventLog("SYS", "Ground station connected to telemetry stream at 20 Hz.");

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
 * panel, SHAP attribution, recommended action and 3D highlight all agree.
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
  }).then(() => {
    addEventLog("FLT", `Opening condition: turbocharger boost deficiency, ${(BOOT_SCENARIO.severity * 100).toFixed(0)}% severity.`);
    addEventLog("AI", "Residual excursion on the manifold pressure channel — under diagnosis.");
  }).catch(() => {});
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
//     so severity, confidence and SHAP stay coherent with the class shown
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
function updateDashboard(state) {
  if (!state || state.status === "initializing") return;

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
    setText(`txt-cyl${i+1}-dev`, `Δ ${dEgt >= 0 ? '+' : ''}${dEgt.toFixed(0)} / ${dCht >= 0 ? '+' : ''}${dCht.toFixed(0)}`);
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
  updateShapDrawer(ai.top_contributing_channels || []);
  updateRecommendedAction(state, ai);

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

// ------------------------------------------------------------------
// 7. SHAP ATTRIBUTION — ranked horizontal bars, top five
// ------------------------------------------------------------------
function updateShapDrawer(shapItems) {
  const container = document.getElementById("container-shap");
  if (!container) return;

  const signature = JSON.stringify(shapItems || []);
  if (signature === lastShapSignature) return;
  lastShapSignature = signature;

  if (!shapItems || shapItems.length === 0) {
    container.innerHTML = `<div class="empty-note">All channels within tolerance.</div>`;
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
        <span class="hbar-label">${item.display_name}</span>
        <span class="hbar-val">${pct.toFixed(1)}% · ${arrow}${absSigma.toFixed(1)}σ</span>
        <span class="hbar-track"><span class="hbar-fill"${stAttr} style="width:${width}%"></span></span>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------------
// 8. CHARTS
// ------------------------------------------------------------------

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

function initCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded yet.");
    return;
  }

  Chart.register(bandsPlugin);
  Chart.defaults.font.family = THEME.fontMono;
  Chart.defaults.font.size = THEME.fsTick;
  Chart.defaults.color = THEME.textMuted;

  const axisTicks = {
    color: THEME.textMuted,
    font: { size: THEME.fsTick, family: THEME.fontMono },
    maxTicksLimit: 6,
    padding: 4
  };
  const gridMajor = { color: THEME.border, lineWidth: 1, drawTicks: false };
  const gridMinor = { color: THEME.border, lineWidth: 1, borderDash: [2, 3], drawTicks: false };

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    layout: { padding: { top: 2, right: 2, bottom: 0, left: 0 } },
    elements: { line: { tension: 0.12, borderWidth: 2 }, point: { radius: 0 } },
    scales: {
      x: { display: false, grid: { display: false } },
      y: { grid: gridMinor, border: { color: THEME.border }, ticks: axisTicks }
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

  // Model-expected baseline: 1.4px dashed, always dim.
  const baselineStyle = {
    borderColor: THEME.textDim,
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
            grid: gridMinor,
            border: { color: THEME.border },
            min: LIMITS.egt.min,
            max: LIMITS.egt.max,
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
          }
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
            grid: gridMinor,
            border: { color: THEME.border },
            min: LIMITS.oilP.min,
            max: LIMITS.oilP.max,
            title: { display: true, text: 'Oil bar', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, stepSize: 1, callback: (v) => Number(v).toFixed(1) }
          },
          y1: {
            position: 'right',
            grid: { drawOnChartArea: false, color: THEME.border },
            border: { color: THEME.border },
            min: 0, max: 3.5,
            title: { display: true, text: 'MAP bar', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(1) }
          }
        },
        plugins: commonOptions.plugins
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
            grid: gridMinor,
            border: { color: THEME.border },
            min: LIMITS.vib.min,
            max: LIMITS.vib.max,
            title: { display: true, text: 'g RMS', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(1) }
          },
          y1: {
            position: 'right',
            grid: { drawOnChartArea: false, color: THEME.border },
            border: { color: THEME.border },
            min: 0, max: 220,
            title: { display: true, text: 'HP', color: THEME.textDim,
                     font: { size: THEME.fsTick, family: THEME.fontMono } },
            ticks: { ...axisTicks, callback: (v) => Number(v).toFixed(0) }
          }
        },
        plugins: commonOptions.plugins
      }
    });
  }
}

function updateChartData(state) {
  if (!state) return;
  historyData.time.push(`${(state.timestamp_s || 0).toFixed(1)}s`);

  const egts = state.sensor_egt_c || [810, 810, 810, 810];
  const mvemEgt = (state.mvem_expected_egt_c && state.mvem_expected_egt_c[0]) || 810;

  historyData.sensor_egt1.push(egts[0]);
  historyData.sensor_egt2.push(egts[1]);
  historyData.sensor_egt3.push(egts[2]);
  historyData.sensor_egt4.push(egts[3]);
  historyData.mvem_egt.push(mvemEgt);

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
      addEventLog("FLT", "Engine reset to healthy baseline; all trims normalised.");
    } else {
      await fetch('/api/fault/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fault_type: faultType, severity: severity, ramp_duration_s: 1.0 })
      });
      addEventLog("FLT", `Injected ${faultType.replace(/_/g, ' ').toLowerCase()} (ramp 1.0 s).`);
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
    note: "Classifier isolates the root cause; SHAP ranks the evidence." },

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
