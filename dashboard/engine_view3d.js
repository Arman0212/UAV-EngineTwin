/**
 * ENGINE-TWIN: 3D Engine Digital Twin
 *
 * A procedural powerplant built to the specification of whichever engine is
 * fitted: its displacement, cylinder count, induction and bank layout. See the
 * ENGINE GEOMETRY section below for how a specification becomes dimensions.
 *
 * The model is an instrument, not decoration. Each cylinder is shaded by its
 * CHT/EGT deviation from the model-expected value, whichever component a live
 * fault implicates is outlined, and every part is directly selectable: hover to
 * identify it, click to inspect the channels behind it.
 *
 * Every colour resolves from the CSS custom properties in theme.css, so the
 * model, the charts and the project brief all annunciate from one palette.
 */

// Token reader — kept local so this file does not depend on app.js load order.
const VIEW_TOKENS = (() => {
  const css = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  };
  const hex = (c) => parseInt(String(c).replace('#', ''), 16);
  const tokens = {
    raw: css,
    bgPage: hex(css('--bg-page', '#151D28')),
    bgPanel: hex(css('--bg-panel', '#1E2938')),
    bgElevated: hex(css('--bg-elevated', '#2B384C')),
    border: hex(css('--border', '#36465D')),
    textPrimary: hex(css('--text-primary', '#F3F6FA')),
    textMuted: hex(css('--text-muted', '#6F849E')),
    textDim: hex(css('--text-dim', '#6F849E')),
    cyl: [
      hex(css('--cyl-1', '#56C6F5')),
      hex(css('--cyl-2', '#7B94FF')),
      hex(css('--cyl-3', '#A78BFA')),
      hex(css('--cyl-4', '#DE7BD0'))
    ],
    caution: hex(css('--caution', '#F0B429')),
    cautionDim: hex(css('--caution-dim', '#A87C1A')),
    warning: hex(css('--warning', '#F2822C')),
    ok: hex(css('--nominal', '#3DD68C')),
    instrument: hex(css('--accent', '#4C8DFF'))
  };
  tokens.refresh = () => {
    tokens.bgPage = hex(css('--bg-page', '#151D28'));
    tokens.bgPanel = hex(css('--bg-panel', '#1E2938'));
    tokens.bgElevated = hex(css('--bg-elevated', '#2B384C'));
    tokens.border = hex(css('--border', '#36465D'));
    tokens.textPrimary = hex(css('--text-primary', '#F3F6FA'));
    tokens.textMuted = hex(css('--text-muted', '#6F849E'));
    tokens.textDim = hex(css('--text-dim', '#6F849E'));
    tokens.cyl = [
      hex(css('--cyl-1', '#56C6F5')),
      hex(css('--cyl-2', '#7B94FF')),
      hex(css('--cyl-3', '#A78BFA')),
      hex(css('--cyl-4', '#DE7BD0'))
    ];
    tokens.caution = hex(css('--caution', '#F0B429'));
    tokens.cautionDim = hex(css('--caution-dim', '#A87C1A'));
    tokens.warning = hex(css('--warning', '#F2822C'));
    tokens.ok = hex(css('--nominal', '#3DD68C'));
    tokens.instrument = hex(css('--accent', '#4C8DFF'));
  };
  return tokens;
})();

/**
 * Thermal deviation envelope. Cylinders are graded on how far they sit from
 * the model-expected value, in sigma, rather than on absolute temperature —
 * a cold-day 700 °C and a hot-day 760 °C are both nominal.
 */
const DEV_SIGMA = { egt: 25.0, cht: 8.0 };
const DEV_CAUTION = 2.0;
const DEV_WARNING = 4.0;

// Where each telemetry channel is measured.
//
// This is a fact about the engine's instrumentation, not a rule about faults:
// manifold pressure is read at the induction system whatever has gone wrong.
// Per-cylinder channels are resolved by index instead, so the map does not
// have to know how many cylinders an engine has.
const CHANNEL_COMPONENT = {
  oil_pressure: 'sump',
  oil_temp: 'sump',
  manifold_pressure: 'turbo',
  vibration_rms: 'crankcase',
  rpm: 'crankcase',
  fuel_flow: 'crankcase',
  bus_voltage: 'crankcase'
};

// Health percentages are graded on the same three-state scale as residuals so
// the two can be compared and the worse of them shown.
const HEALTH_CAUTION = 85.0;
const HEALTH_WARNING = 50.0;

// How far the engine moves when its vibration health has collapsed entirely.
// Scaled with the model, so a small engine shakes proportionately.
const SHAKE_MAX = 0.040;

// Speed unsteadiness, in residual sigma, at which the propeller is drawn as
// fully unsteady. A misfire reads here rather than as a colour.
const RPM_UNSTEADY_SIGMA = 6.0;

// Turbo rotor speed at full boost, radians per frame.
const TURBO_SPIN_MAX = 0.55;

// A frame older than this is not telemetry any more.
const STALE_AFTER_MS = 2500;

// While the diagnosis says the engine is healthy, a residual grade must hold
// this long, in simulation time, before it colours a part. Sensor noise crosses
// the caution line for a frame or two and a thermocouple lags the model for a
// second or two at a throttle change; a developing fault stays there. Measured
// on a replayed healthy sortie, this removes every false annunciation, and on
// a replayed faulted one it delays nothing beyond the moment the fault is named.
const PERSIST_S = 3.0;

// Selectable components. `id` is the stable handle the rest of the station
// uses to talk about a part — the health matrix selects by the same ids.
const COMPONENT_META = {
  'turbo':     { label: 'TURBO', title: 'Turbocharger' },
  'sump':      { label: 'SUMP',  title: 'Oil sump & lubrication circuit' },
  'crankcase': { label: 'CASE',  title: 'Crankcase & crankshaft' },
  'prop':      { label: 'PROP',  title: 'Propeller & reduction drive' }
};

// Cylinder and probe entries are generated rather than listed: the engine bay
// accepts up to 16 cylinders, and `select()` refuses any id absent from this
// map, so a six-cylinder engine needs all six to be selectable.
const MAX_CYLINDERS = 16;
for (let i = 0; i < MAX_CYLINDERS; i++) {
  COMPONENT_META[`cyl-${i}`]   = { label: `CYL ${i + 1}`, title: `Cylinder ${i + 1}` };
  COMPONENT_META[`probe-${i}`] = { label: `EGT ${i + 1}`, title: `EGT probe, cylinder ${i + 1}` };
}

/* ==========================================================================
   ENGINE GEOMETRY
   --------------------------------------------------------------------------
   The model is dimensioned from the engine that is fitted, not drawn to fixed
   literals. It resolves in three steps.

   1. Bore is solved from swept volume and cylinder count. Aero piston engines
      are close to square, so taking stroke = bore:

          V_cyl = (pi / 4) * B^2 * S,   S = B    ->    B = cbrt(4 * V_cyl / pi)

      For the engines in the library this lands within a few percent of the
      published bore, which is close enough for a display model and far better
      than a constant.

   2. Every part is expressed as a multiple of that bore. The ratios in BORE
      below are the reference engine's own proportions, read off the model that
      shipped, so a 2.2 litre inline four reproduces it exactly.

   3. The finished assembly is scaled to fill a fixed frame. The viewport does
      not change size, so a 350 HP flat-six and a 170 cc twin both have to sit
      in it. Fitting the frame is what makes the differences legible: a twin
      has few large jugs for its case, a six has many small ones.

   The consequence worth stating: this is a proportional model, not a scale
   drawing. It is dimensioned to be read as an instrument.
   ========================================================================== */

// Part dimensions as multiples of bore. Every value here is the reference
// engine's own geometry divided by its bore, so the reference engine is
// reproduced to the last decimal and everything else is a real proportion.
const BORE = {
  // Cylinder assembly
  barrelRadius: 0.5,
  barrelHeight: 1.875,
  barrelY:      1.25,
  headWidth:    1.09375,
  headHeight:   0.46875,
  headDepth:    1.09375,
  headY:        2.34375,
  probeRadius:  0.078125,
  probeHeight:  0.46875,
  probeY:       2.734375,
  pitch:        1.25,      // cylinder centre to centre
  labelY:       3.34375,   // along the cylinder axis, clear of the probe
  turboLabelY:   1.796875,
  sumpLabelY:   -2.0,
  propLabelGap:  0.546875, // ahead of the spinner
  propLabelY:    1.484375,
  outlineMargin: 0.21875,  // how far a selection outline stands off its part

  // Crankcase and sump
  caseOverhang: 1.875,     // case length beyond the cylinder bank
  caseHeight:   1.953125,
  caseDepth:    2.1875,
  sumpInset:    0.625,     // sump is shorter than the case by this much
  sumpHeight:   0.703125,
  sumpDepth:    1.875,
  sumpY:       -1.25,

  // Turbocharger
  turboRadius:  0.5625,
  turboTube:    0.21875,
  turboGap:     0.46875,   // clearance behind the case
  turboY:       0.625,
  pipeRadius:   0.15625,
  pipeLength:   3.75,
  pipeX:        1.71875,   // local to the turbo group
  pipeY:        0.390625,
  pipeZ:        0.859375,

  // Propeller and spinner
  spinnerRadius: 0.4375,
  spinnerHeight: 1.015625,
  spinnerGap:    0.3125,   // clearance ahead of the case
  propGap:       0.15625,
  bladeWidth:    0.1875,
  bladeThick:    0.046875
};

// The engine this model was drawn for. Used to calibrate the frame and the
// propeller relation, so the reference engine renders exactly as it did.
const REFERENCE_ENGINE = {
  displacementLitres: 2.2,
  cylinders: 4,
  ratedPowerHp: 200.0,
  ratedRpm: 4200.0,
  turbocharged: true,
  layout: 'inline',
  propDiameterBores: 5.0,      // prop diameter in bores, as shipped
  boreSceneUnits: 0.64         // and the bore it was drawn at, in scene units
};

// How the cylinders are arranged. The component ids stay cyl-0..n-1 in every
// layout, so telemetry mapping and selection are unaffected by the shape.
const CYLINDER_LAYOUTS = {
  // One bank, cylinders upright.
  inline: { banks: 1, bankAngleDeg: 0 },
  // Two banks horizontally opposed, the flat-four and flat-six arrangement
  // that most of the library actually uses.
  boxer:  { banks: 2, bankAngleDeg: 90 },
  // Two banks in a vee.
  vee:    { banks: 2, bankAngleDeg: 30 }
};

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Solves bore from swept volume, assuming a square engine.
 * @param {number} litres total displacement
 * @param {number} cylinders how many
 * @returns {number} bore in millimetres
 */
function boreFromDisplacement(litres, cylinders) {
  const n = Math.max(1, cylinders || 1);
  const vCylMm3 = Math.max(1.0, (litres || REFERENCE_ENGINE.displacementLitres) * 1e6) / n;
  return Math.cbrt(4.0 * vCylMm3 / Math.PI);
}

/**
 * Propeller diameter, in bores.
 *
 * Propeller size follows the classic power and speed relation D ~ (P / N^2)^(1/5).
 * It is normalised on the reference engine, so that engine keeps the propeller
 * it was drawn with, and clamped so an outlier cannot swamp the frame.
 */
function propDiameterBores(powerHp, ratedRpm, boreMm) {
  const refBoreMm = boreFromDisplacement(REFERENCE_ENGINE.displacementLitres,
                                         REFERENCE_ENGINE.cylinders);
  const refPropMm = REFERENCE_ENGINE.propDiameterBores * refBoreMm;
  const powerRatio = Math.max(0.05, (powerHp || REFERENCE_ENGINE.ratedPowerHp)
                                    / REFERENCE_ENGINE.ratedPowerHp);
  const rpmRatio = Math.max(0.2, (ratedRpm || REFERENCE_ENGINE.ratedRpm)
                                 / REFERENCE_ENGINE.ratedRpm);
  const propMm = refPropMm * Math.pow(powerRatio / (rpmRatio * rpmRatio), 0.2);
  return clampNum(propMm / boreMm, 2.2, 9.0);
}

/**
 * Turns an engine specification into every dimension the builder needs.
 *
 * Works internally in bores, then converts once, so the returned object is in
 * scene units and nothing downstream has to know about the conversion.
 *
 * @param {object} spec cylinders, displacementLitres, turbocharged, layout,
 *                      ratedPowerHp, ratedRpm
 * @returns {object} dimensions in scene units, plus boreMm and scale
 */
function deriveDimensions(spec) {
  const s = spec || {};
  const n = Math.round(clampNum(s.cylinders || REFERENCE_ENGINE.cylinders, 1, MAX_CYLINDERS));
  const layoutName = CYLINDER_LAYOUTS[s.layout] ? s.layout : 'inline';
  const layout = CYLINDER_LAYOUTS[layoutName];
  const turbo = s.turbocharged !== false;

  const boreMm = boreFromDisplacement(s.displacementLitres, n);
  const perBank = Math.ceil(n / layout.banks);
  const bankSpan = BORE.pitch * (perBank - 1);
  const caseLength = bankSpan + BORE.caseOverhang;
  const propDia = propDiameterBores(s.ratedPowerHp, s.ratedRpm, boreMm);

  // Where each cylinder sits and which way it points, in bores. One list
  // covers every layout so the builder has no layout branches in it.
  const halfAngle = (layout.bankAngleDeg * Math.PI) / 180.0;
  const startX = -bankSpan / 2;
  const seats = [];
  for (let i = 0; i < n; i++) {
    const bank = layout.banks === 1 ? 0 : i % 2;
    const slot = layout.banks === 1 ? i : Math.floor(i / 2);
    // Bank 0 leans one way, bank 1 the other; an inline engine has no lean.
    const tilt = layout.banks === 1 ? 0 : (bank === 0 ? halfAngle : -halfAngle);
    seats.push({
      index: i,
      x: startX + slot * BORE.pitch,
      tilt,                                   // rotation about the crank axis
      axis: { y: Math.cos(tilt), z: Math.sin(tilt) }
    });
  }

  // Assembly envelope in bores, so the frame fit can be solved analytically.
  const cylReach = BORE.labelY;
  const maxAxisY = Math.max(...seats.map(p => Math.abs(p.axis.y))) * cylReach;
  const maxAxisZ = Math.max(...seats.map(p => Math.abs(p.axis.z))) * cylReach;

  const xMax = caseLength / 2 + BORE.spinnerGap + BORE.spinnerHeight / 2;
  const xMin = turbo
    ? -(caseLength / 2 + BORE.turboGap + BORE.turboRadius + BORE.turboTube)
    : -caseLength / 2;
  const spanX = xMax - xMin;
  const spanY = Math.max(propDia, maxAxisY + BORE.caseHeight / 2 - BORE.sumpY);
  const spanZ = Math.max(propDia, 2 * maxAxisZ, BORE.caseDepth);

  // Scale so the assembly fills the same frame as the reference engine did.
  // The frame itself is the reference engine's own envelope, so that engine
  // resolves to a scale of exactly its shipped bore.
  const frame = referenceFrame();
  const scale = Math.min(frame.x / spanX, frame.y / spanY, frame.z / spanZ);
  const u = (v) => v * scale;

  return {
    layout: layoutName,
    cylinders: n,
    turbo,
    boreMm,
    scale,
    seats: seats.map(p => ({ ...p, x: u(p.x) })),

    pitch: u(BORE.pitch),
    barrelRadius: u(BORE.barrelRadius),
    barrelHeight: u(BORE.barrelHeight),
    barrelY: u(BORE.barrelY),
    headWidth: u(BORE.headWidth),
    headHeight: u(BORE.headHeight),
    headDepth: u(BORE.headDepth),
    headY: u(BORE.headY),
    probeRadius: u(BORE.probeRadius),
    probeHeight: u(BORE.probeHeight),
    probeY: u(BORE.probeY),
    labelY: u(BORE.labelY),

    caseLength: u(caseLength),
    caseHeight: u(BORE.caseHeight),
    caseDepth: u(BORE.caseDepth),
    sumpLength: u(caseLength - BORE.sumpInset),
    sumpHeight: u(BORE.sumpHeight),
    sumpDepth: u(BORE.sumpDepth),
    sumpY: u(BORE.sumpY),

    turboRadius: u(BORE.turboRadius),
    turboTube: u(BORE.turboTube),
    turboX: u(-(caseLength / 2 + BORE.turboGap)),
    turboY: u(BORE.turboY),
    pipeRadius: u(BORE.pipeRadius),
    pipeLength: u(BORE.pipeLength),
    pipeX: u(BORE.pipeX),
    pipeY: u(BORE.pipeY),
    pipeZ: u(BORE.pipeZ),

    spinnerRadius: u(BORE.spinnerRadius),
    spinnerHeight: u(BORE.spinnerHeight),
    turboLabelY: u(BORE.turboLabelY),
    sumpLabelY: u(BORE.sumpLabelY),
    propLabelX: u(caseLength / 2 + BORE.spinnerGap + BORE.propLabelGap),
    propLabelY: u(BORE.propLabelY),
    outlineMargin: u(BORE.outlineMargin),
    spinnerX: u(caseLength / 2 + BORE.spinnerGap),
    propX: u(caseLength / 2 + BORE.propGap),
    propDiameter: u(propDia),
    bladeWidth: u(BORE.bladeWidth),
    bladeThick: u(BORE.bladeThick)
  };
}

/**
 * The frame every engine is fitted into: the reference engine's own envelope,
 * at the bore it was drawn at. Computed once, so there is no magic constant
 * and the reference engine cannot drift out of calibration.
 */
let _frameCache = null;
function referenceFrame() {
  if (_frameCache) return _frameCache;

  const r = REFERENCE_ENGINE;
  const boreMm = boreFromDisplacement(r.displacementLitres, r.cylinders);
  const bankSpan = BORE.pitch * (r.cylinders - 1);
  const caseLength = bankSpan + BORE.caseOverhang;

  const xMax = caseLength / 2 + BORE.spinnerGap + BORE.spinnerHeight / 2;
  const xMin = -(caseLength / 2 + BORE.turboGap + BORE.turboRadius + BORE.turboTube);
  const spanY = Math.max(r.propDiameterBores,
                         BORE.labelY + BORE.caseHeight / 2 - BORE.sumpY);
  const spanZ = Math.max(r.propDiameterBores, BORE.caseDepth);

  _frameCache = {
    x: (xMax - xMin) * r.boreSceneUnits,
    y: spanY * r.boreSceneUnits,
    z: spanZ * r.boreSceneUnits
  };
  return _frameCache;
}


class Engine3DView {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;

    this.cylinders = [];
    this.propeller = null;
    this.turboMesh = null;

    // Specification of the engine currently drawn. Defaults are the reference
    // engine, so the first paint is correct before any catalogue call returns.
    this.cylCount = REFERENCE_ENGINE.cylinders;
    this.hasTurbo = REFERENCE_ENGINE.turbocharged;
    this.displacementLitres = REFERENCE_ENGINE.displacementLitres;
    this.ratedPowerHp = REFERENCE_ENGINE.ratedPowerHp;
    this.ratedRpm = REFERENCE_ENGINE.ratedRpm;
    this.layout = REFERENCE_ENGINE.layout;
    this.engineLabel = null;
    this.dims = null;              // resolved dimensions of the current build
    this.oilSumpMesh = null;
    this.crankcaseMesh = null;

    this.highlight = null;          // outline marker for the faulted part
    this.lastHighlightKey = null;
    this.selectionBox = null;       // outline marker for the selected part
    this.labelSprites = [];
    this.labelsVisible = true;

    this.pickables = [];            // meshes the raycaster considers
    this.baseColours = new Map();   // mesh -> its annunciation colour this frame
    this.hoveredId = null;
    this.selectedId = null;
    this.onSelect = null;           // set by app.js

    this.latestState = null;
    this.evidence = null;           // last frame, read into per-part meaning
    this.persistSince = {};         // part id -> sim time its grade left nominal
    this.currentRpm = 1400.0;
    this.lastFrameAt = 0;           // for the staleness check
    this.isStale = false;
    this.shakeAmplitude = 0;        // driven by measured vibration excess
    this.rpmUnsteady = 0;           // driven by the speed residual
    this.turboSpin = 0;             // driven by boost actually being made
    this.targetCameraPos = null;
    this.targetLookAt = null;

    this.init();
  }

  init() {
    // The palette is read when this file loads, which is before app.js applies
    // the saved day or night theme. Re-read it now, at construction, or the
    // model starts in the other theme colours until someone toggles it.
    if (typeof VIEW_TOKENS.refresh === "function") VIEW_TOKENS.refresh();

    const width = this.container.clientWidth || 400;
    const height = this.container.clientHeight || 210;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    // The viewport is short and wide, so frame tightly and look slightly
    // down the cylinder bank: the engine has to read at half the previous
    // height without shrinking in the frame.
    this.camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    this.camera.position.set(3.4, 1.9, 4.4);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    if (window.THREE.OrbitControls) {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.maxDistance = 16;
      this.controls.minDistance = 1.6;
      this.controls.target.set(0, 0.55, 0);
    }

    // Neutral studio lighting — no coloured light, so component colour is
    // only ever the annunciation.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.05);
    keyLight.position.set(6, 10, 8);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-6, -2, -6);
    this.scene.add(fillLight);

    const grid = new THREE.GridHelper(8, 16, VIEW_TOKENS.border, VIEW_TOKENS.border);
    grid.position.y = -1.35;
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    this.scene.add(grid);
    this.grid = grid;

    this.buildEngineGeometry();
    this.buildLabels();
    this.initPicking();

    window.addEventListener('resize', () => this.onWindowResize());
    this.animate();
  }

  /** Registers a mesh as selectable under a component id. */
  registerPickable(mesh, id) {
    mesh.userData.componentId = id;
    this.pickables.push(mesh);
  }

  /**
   * Materials shared across parts. Per-cylinder materials are not here: each
   * cylinder is recoloured independently every frame, so each owns its own.
   */
  sharedMaterials() {
    return {
      crankcase: new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.bgElevated, metalness: 0.80, roughness: 0.40 }),
      sump: new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.border, metalness: 0.85, roughness: 0.45 }),
      turbo: new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textMuted, metalness: 0.88, roughness: 0.28 }),
      pipe: new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textDim, metalness: 0.85, roughness: 0.35 }),
      spinner: new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textMuted, metalness: 0.88, roughness: 0.25 }),
      blade: new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.bgElevated, roughness: 0.6, metalness: 0.3 })
    };
  }

  buildEngineGeometry() {
    // Dimensions are resolved once per build and cached, because the labels,
    // the selection outlines and the camera all have to agree with the meshes.
    this.dims = deriveDimensions({
      cylinders: this.cylCount,
      displacementLitres: this.displacementLitres,
      ratedPowerHp: this.ratedPowerHp,
      ratedRpm: this.ratedRpm,
      turbocharged: this.hasTurbo,
      layout: this.layout
    });

    const d = this.dims;
    const mats = this.sharedMaterials();
    this.sharedMats = mats;
    const engineGroup = new THREE.Group();
    this.engineGroup = engineGroup;

    this.buildCrankcase(engineGroup, d, mats);
    this.buildSump(engineGroup, d, mats);
    this.buildCylinderBank(engineGroup, d);
    this.buildTurbocharger(engineGroup, d, mats);
    this.buildPropeller(engineGroup, d, mats);

    this.scene.add(engineGroup);
  }

  buildCrankcase(parent, d, mats) {
    this.crankcaseMesh = new THREE.Mesh(
      new THREE.BoxGeometry(d.caseLength, d.caseHeight, d.caseDepth), mats.crankcase);
    parent.add(this.crankcaseMesh);
    this.registerPickable(this.crankcaseMesh, 'crankcase');
  }

  buildSump(parent, d, mats) {
    this.oilSumpMesh = new THREE.Mesh(
      new THREE.BoxGeometry(d.sumpLength, d.sumpHeight, d.sumpDepth), mats.sump);
    this.oilSumpMesh.position.y = d.sumpY;
    parent.add(this.oilSumpMesh);
    this.registerPickable(this.oilSumpMesh, 'sump');
  }

  /**
   * The cylinders, wherever the layout puts them.
   *
   * Each cylinder is built upright in its own group and the group is then
   * rotated onto its seat, so an inline, boxer and vee engine all share one
   * construction and only the seat differs.
   */
  buildCylinderBank(parent, d) {
    for (const seat of d.seats) {
      const i = seat.index;
      const cylGroup = new THREE.Group();
      cylGroup.position.x = seat.x;
      cylGroup.rotation.x = seat.tilt;

      const jugMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textDim, metalness: 0.75, roughness: 0.35 });
      const jugMesh = new THREE.Mesh(new THREE.CylinderGeometry(
        d.barrelRadius, d.barrelRadius, d.barrelHeight, 24), jugMat);
      jugMesh.position.y = d.barrelY;
      cylGroup.add(jugMesh);
      this.registerPickable(jugMesh, `cyl-${i}`);

      const headMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textMuted, metalness: 0.80, roughness: 0.30 });
      const headMesh = new THREE.Mesh(new THREE.BoxGeometry(
        d.headWidth, d.headHeight, d.headDepth), headMat);
      headMesh.position.y = d.headY;
      cylGroup.add(headMesh);
      this.registerPickable(headMesh, `cyl-${i}`);

      // The probe is its own component: a dead thermocouple and a dead
      // cylinder are different findings, and the model should let the
      // operator point at each of them separately.
      const probeMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textPrimary, metalness: 0.90, roughness: 0.25 });
      const probe = new THREE.Mesh(new THREE.CylinderGeometry(
        d.probeRadius, d.probeRadius, d.probeHeight, 12), probeMat);
      probe.position.y = d.probeY;
      cylGroup.add(probe);
      this.registerPickable(probe, `probe-${i}`);

      parent.add(cylGroup);
      this.cylinders.push({
        group: cylGroup, jugMat, headMat, probeMat, jugMesh, headMesh, probe,
        index: i, seat
      });
    }
  }

  /** Naturally aspirated engines get no turbocharger, because they have none. */
  buildTurbocharger(parent, d, mats) {
    this.turboMesh = null;
    this.turboGroup = null;
    if (!d.turbo) return;

    const turboGroup = new THREE.Group();
    this.turboMesh = new THREE.Mesh(
      new THREE.TorusGeometry(d.turboRadius, d.turboTube, 16, 32), mats.turbo);
    this.turboMesh.rotation.y = Math.PI / 2;
    turboGroup.add(this.turboMesh);
    this.registerPickable(this.turboMesh, 'turbo');

    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(
      d.pipeRadius, d.pipeRadius, d.pipeLength, 16), mats.pipe);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(d.pipeX, d.pipeY, d.pipeZ);
    turboGroup.add(pipe);
    this.registerPickable(pipe, 'turbo');

    turboGroup.position.set(d.turboX, d.turboY, 0);
    parent.add(turboGroup);
    this.turboGroup = turboGroup;
  }

  buildPropeller(parent, d, mats) {
    const spinner = new THREE.Mesh(
      new THREE.ConeGeometry(d.spinnerRadius, d.spinnerHeight, 24), mats.spinner);
    spinner.rotation.z = -Math.PI / 2;
    spinner.position.set(d.spinnerX, 0, 0);
    parent.add(spinner);
    this.registerPickable(spinner, 'prop');

    const propGroup = new THREE.Group();
    const bladeGeo = new THREE.BoxGeometry(d.bladeWidth, d.propDiameter, d.bladeThick);
    const blade1 = new THREE.Mesh(bladeGeo, mats.blade);
    const blade2 = new THREE.Mesh(bladeGeo, mats.blade);
    blade2.rotation.x = Math.PI / 2;
    propGroup.add(blade1, blade2);
    propGroup.position.set(d.propX, 0, 0);
    parent.add(propGroup);
    this.propeller = propGroup;
  }

  // ------------------------------------------------------------------
  // Component labels
  //
  // Sprites rather than HTML overlays: they occlude correctly against the
  // model, scale with the camera, and cost one draw call each.
  // ------------------------------------------------------------------
  makeLabelSprite(text) {
    const pad = 10;
    const fontPx = 34;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `700 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    const h = fontPx + pad * 2;
    canvas.width = w; canvas.height = h;

    const c2 = canvas.getContext('2d');
    c2.font = `700 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
    c2.textBaseline = 'middle';
    c2.fillStyle = VIEW_TOKENS.raw('--bg-chrome', '#141619');
    c2.globalAlpha = 0.82;
    c2.fillRect(0, 0, w, h);
    c2.globalAlpha = 1;
    c2.strokeStyle = VIEW_TOKENS.raw('--border', '#2A2D31');
    c2.lineWidth = 2;
    c2.strokeRect(1, 1, w - 2, h - 2);
    c2.fillStyle = VIEW_TOKENS.raw('--text-muted', '#8A8F96');
    c2.fillText(text, pad, h / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    // sizeAttenuation off: a label is chrome, not geometry. With it on, the
    // nearest cylinder's label rendered visibly larger and higher than its
    // neighbours -- CYL 4 broke the row -- because sprite size and anchor
    // both scaled with depth. Constant screen size puts the four back on one
    // line and keeps every label legible at any orbit distance.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, sizeAttenuation: false
    }));
    sprite.renderOrder = 10;
    const scale = 0.00082;          // screen-relative now, not world-relative
    sprite.scale.set(w * scale, h * scale, 1);
    return sprite;
  }

  buildLabels() {
    const d = this.dims;
    const place = (id, pos) => {
      const meta = COMPONENT_META[id];
      if (!meta) return;
      const sprite = this.makeLabelSprite(meta.label);
      sprite.position.copy(pos);
      sprite.userData.componentId = id;
      this.scene.add(sprite);
      this.labelSprites.push(sprite);
    };

    // Along each cylinder's own axis, so a flat engine labels outboard.
    for (const c of this.cylinders) {
      place(`cyl-${c.index}`, new THREE.Vector3(
        c.seat.x, c.seat.axis.y * d.labelY, c.seat.axis.z * d.labelY));
    }
    if (d.turbo) place('turbo', new THREE.Vector3(d.turboX, d.turboLabelY, 0));
    place('sump', new THREE.Vector3(0, d.sumpLabelY, 0));
    place('prop', new THREE.Vector3(d.propLabelX, d.propLabelY, 0));
  }

  setLabelsVisible(visible) {
    this.labelsVisible = !!visible;
    this.labelSprites.forEach(s => { s.visible = this.labelsVisible; });
  }

  // ------------------------------------------------------------------
  // Picking — hover to identify, click to inspect
  // ------------------------------------------------------------------
  initPicking() {
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    const dom = this.renderer.domElement;

    // Distinguish a click from the end of an orbit drag, so rotating the
    // model never changes the selection.
    let downAt = null;
    let downPos = { x: 0, y: 0 };

    const toNDC = (ev) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };

    dom.addEventListener('pointermove', (ev) => {
      toNDC(ev);
      const hit = this.pickAt();
      const id = hit ? hit.userData.componentId : null;
      if (id !== this.hoveredId) {
        this.hoveredId = id;
        dom.style.cursor = id ? 'pointer' : '';
        if (typeof this.onHover === 'function') this.onHover(id);
      }
    });

    dom.addEventListener('pointerleave', () => {
      this.hoveredId = null;
      dom.style.cursor = '';
      if (typeof this.onHover === 'function') this.onHover(null);
    });

    dom.addEventListener('pointerdown', (ev) => {
      downAt = performance.now();
      downPos = { x: ev.clientX, y: ev.clientY };
    });

    dom.addEventListener('pointerup', (ev) => {
      if (downAt === null) return;
      const dt = performance.now() - downAt;
      const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
      downAt = null;
      if (dt > 400 || moved > 5) return;   // that was an orbit, not a click

      toNDC(ev);
      const hit = this.pickAt();
      this.select(hit ? hit.userData.componentId : null);
    });

    // Escape clears the selection, matching the rest of the station.
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.selectedId) this.select(null);
    });
  }

  pickAt() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    return hits.length ? hits[0].object : null;
  }

  /** Selects a component by id (or null to clear) and frames it. */
  select(id) {
    if (id && !COMPONENT_META[id]) id = null;
    this.selectedId = id;
    this.frameComponent(id);
    this.drawSelectionBox(id);
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }

  /** Bounds of a component in engine-group space, for outlining and framing. */
  componentBounds(id) {
    if (!id || !this.dims) return null;
    const d = this.dims;
    const m = d.outlineMargin;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    // A cylinder's long axis follows its seat, so the outline has to swap its
    // height and depth on a flat engine rather than always standing upright.
    const alongAxis = (seat, reach, longSide, shortSide) => ({
      centre: V(seat.x, seat.axis.y * reach, seat.axis.z * reach),
      size: V(longSide,
              Math.abs(seat.axis.y) * longSide + Math.abs(seat.axis.z) * shortSide,
              Math.abs(seat.axis.z) * longSide + Math.abs(seat.axis.y) * shortSide)
    });

    if (id.startsWith('cyl-')) {
      const c = this.cylinders[parseInt(id.slice(4), 10)];
      if (!c) return null;
      const low = d.barrelY - d.barrelHeight / 2;
      const high = d.headY + d.headHeight / 2;
      const b = alongAxis(c.seat, (low + high) / 2, high - low + m, d.headDepth + m);
      b.size.x = d.headWidth + m;
      return b;
    }
    if (id.startsWith('probe-')) {
      const c = this.cylinders[parseInt(id.slice(6), 10)];
      if (!c) return null;
      const b = alongAxis(c.seat, d.probeY, d.probeHeight + m, d.probeRadius * 2 + m);
      b.size.x = d.probeRadius * 2 + m;
      return b;
    }
    if (id === 'turbo') {
      if (!this.turboGroup) return null;
      const r = (d.turboRadius + d.turboTube) * 2 + m;
      return { centre: this.turboGroup.position.clone(), size: V(r, r, r) };
    }
    if (id === 'sump') {
      return { centre: V(0, d.sumpY, 0),
               size: V(d.sumpLength + m, d.sumpHeight + m, d.sumpDepth + m) };
    }
    if (id === 'crankcase') {
      return { centre: V(0, 0, 0),
               size: V(d.caseLength + m, d.caseHeight + m, d.caseDepth + m) };
    }
    if (id === 'prop') {
      return { centre: V(d.propX, 0, 0),
               size: V(d.spinnerHeight + m, d.propDiameter + m, d.propDiameter + m) };
    }
    return null;
  }

  drawSelectionBox(id) {
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      this.selectionBox.material.dispose();
      this.selectionBox = null;
    }
    const b = this.componentBounds(id);
    if (!b) return;

    const box = new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z);
    const edges = new THREE.EdgesGeometry(box);
    const marker = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: VIEW_TOKENS.instrument, transparent: true, opacity: 0.95
    }));
    marker.position.copy(b.centre);
    box.dispose();
    this.scene.add(marker);
    this.selectionBox = marker;
  }

  /** Moves the camera to a sensible standoff for whatever was selected. */
  frameComponent(id) {
    const b = this.componentBounds(id);
    if (!b) return;
    const reach = Math.max(b.size.x, b.size.y, b.size.z);
    const dist = Math.max(2.2, reach * 1.9);
    this.targetLookAt = b.centre.clone();
    this.targetCameraPos = new THREE.Vector3(
      b.centre.x + dist * 0.55,
      b.centre.y + dist * 0.45,
      b.centre.z + dist * 0.95
    );
  }

  setCameraPreset(preset) {
    if (!this.camera || !this.controls) return;
    if (preset === 'orbit') {
      this.targetCameraPos = new THREE.Vector3(3.4, 1.9, 4.4);
      this.targetLookAt = new THREE.Vector3(0, 0.55, 0);
    } else if (preset === 'cylinders') {
      this.targetCameraPos = new THREE.Vector3(0, 2.6, 2.9);
      this.targetLookAt = new THREE.Vector3(0, 1.15, 0);
    } else if (preset === 'turbo') {
      const tx = (this.dims && this.dims.turboX) || -2.1;
      const ty = (this.dims && this.dims.turboY) || 0.4;
      this.targetCameraPos = new THREE.Vector3(tx - 1.9, ty + 1.2, 2.2);
      this.targetLookAt = new THREE.Vector3(tx, ty, 0);
    } else if (preset === 'sump') {
      this.targetCameraPos = new THREE.Vector3(2.4, -2.0, 3.2);
      this.targetLookAt = new THREE.Vector3(0, -0.75, 0);
    }
  }

  focusCylinder(index) {
    if (index >= 0 && index < this.cylinders.length && this.cylinders[index]) {
      this.select(`cyl-${index}`);
    }
  }

  /** Grades a deviation, in sigma, into an annunciation state. */
  static gradeDeviation(sigma) {
    const a = Math.abs(sigma);
    if (a >= DEV_WARNING) return 'warning';
    if (a >= DEV_CAUTION) return 'caution';
    return 'nominal';
  }

  colourForState(state, nominalColour) {
    if (state === 'warning') return VIEW_TOKENS.warning;
    if (state === 'caution') return VIEW_TOKENS.caution;
    return nominalColour;
  }

  /**
   * Live readout for one component, assembled from the twin frame.
   * The station's inspector renders whatever this returns, so a new
   * component only has to be described here once.
   */
  describeComponent(id, state) {
    const s = state || this.latestState;
    if (!id || !s) return null;
    const meta = COMPONENT_META[id];
    if (!meta) return null;

    const health = s.health || {};
    const res = s.residuals || {};
    const fmt = (v, d = 1) => (v === undefined || v === null) ? '—' : Number(v).toFixed(d);
    const rows = [];
    let healthPct = null;
    let note = '';

    if (id.startsWith('cyl-')) {
      const i = parseInt(id.slice(4), 10);
      const egt = (s.sensor_egt_c || [])[i];
      const cht = (s.sensor_cht_c || [])[i];
      const egtExp = (s.mvem_expected_egt_c || [])[i];
      const chtExp = (s.mvem_expected_cht_c || [])[i];
      rows.push({ k: 'EGT', v: `${fmt(egt)} °C`, exp: `${fmt(egtExp)} °C`,
                  r: res[`egt_cyl_${i + 1}`] });
      rows.push({ k: 'CHT', v: `${fmt(cht)} °C`, exp: `${fmt(chtExp)} °C`,
                  r: res[`cht_cyl_${i + 1}`] });
      healthPct = health.cylinders_health;
      note = 'Graded on deviation from the model, not absolute temperature.';
    } else if (id.startsWith('probe-')) {
      const i = parseInt(id.slice(6), 10);
      const egt = (s.sensor_egt_c || [])[i];
      const cht = (s.sensor_cht_c || [])[i];
      rows.push({ k: 'EGT reading', v: `${fmt(egt)} °C`,
                  exp: `${fmt((s.mvem_expected_egt_c || [])[i])} °C`,
                  r: res[`egt_cyl_${i + 1}`] });
      rows.push({ k: 'Neighbour CHT', v: `${fmt(cht)} °C`, exp: '—',
                  r: res[`cht_cyl_${i + 1}`] });
      const isSensorFault = s.ai_prognostics && s.ai_prognostics.is_sensor_fault;
      note = isSensorFault
        ? 'Cross-channel check says this probe, not this cylinder.'
        : 'Checked against its own cylinder head before any engine fault is named.';
    } else if (id === 'turbo') {
      rows.push({ k: 'Manifold pressure', v: `${fmt(s.sensor_map_bar, 2)} bar`,
                  exp: `${fmt(s.mvem_expected_map_bar, 2)} bar`, r: res.manifold_pressure });
      rows.push({ k: 'Shaft power', v: `${fmt(s.mvem_expected_power_hp, 0)} HP`, exp: '—' });
      healthPct = health.turbo_boost_health;
      note = 'Boost derates with altitude by design; the residual does not.';
    } else if (id === 'sump') {
      rows.push({ k: 'Oil pressure', v: `${fmt(s.sensor_oil_p_bar, 2)} bar`,
                  exp: `${fmt(s.mvem_expected_oil_p_bar, 2)} bar`, r: res.oil_pressure });
      rows.push({ k: 'Oil temperature', v: `${fmt(s.sensor_oil_t_c)} °C`,
                  exp: `${fmt(s.mvem_expected_oil_t_c)} °C`, r: res.oil_temp });
      healthPct = health.oil_system_health;
      note = 'Pressure is a falling parameter — low is the fault direction.';
    } else if (id === 'crankcase') {
      rows.push({ k: 'Vibration RMS', v: `${fmt(s.sensor_vib_rms_g, 2)} g`,
                  exp: `${fmt(s.mvem_expected_vib_rms_g, 2)} g`, r: res.vibration_rms });
      rows.push({ k: 'Crank speed', v: `${fmt(s.sensor_rpm, 0)} rpm`,
                  exp: `${fmt(s.mvem_expected_rpm, 0)} rpm`, r: res.rpm });
      healthPct = health.vibration_health;
      note = 'Bearing wear shows as growth in the 2X order, not in RMS alone.';
    } else if (id === 'prop') {
      rows.push({ k: 'Crank speed', v: `${fmt(s.sensor_rpm, 0)} rpm`,
                  exp: `${fmt(s.mvem_expected_rpm, 0)} rpm`, r: res.rpm });
      rows.push({ k: 'Shaft power', v: `${fmt(s.mvem_expected_power_hp, 0)} HP`, exp: '—' });
      note = 'Driven directly by the crankshaft in this model.';
    }

    return { id, title: meta.title, label: meta.label, rows, healthPct, note };
  }

  // ==================================================================
  // TELEMETRY TO VISUAL STATE
  //
  // The model reads the same frame the diagnostic layer reads, and decides
  // what to show from the values in it. There is deliberately no mapping
  // anywhere from a fault's name to a visual effect: a cylinder turns amber
  // because its own head temperature has left its own expected band, not
  // because someone pressed a button labelled "cooling loss".
  //
  // The one lookup that remains, CHANNEL_COMPONENT, records where a sensor
  // physically sits. That cylinder 2's head thermocouple is on cylinder 2 is
  // a fact about the engine, not a rule about faults.
  // ==================================================================

  /**
   * Grades a health percentage on the same three-state scale as a deviation,
   * so a part's own health score and its residual can be compared.
   */
  static gradeHealth(pct) {
    if (pct === undefined || pct === null) return 'nominal';
    if (pct < HEALTH_WARNING) return 'warning';
    if (pct < HEALTH_CAUTION) return 'caution';
    return 'nominal';
  }

  /** The more serious of two states. */
  static worse(a, b) {
    const rank = { nominal: 0, caution: 1, warning: 2 };
    return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
  }

  /**
   * Reads one frame into a per-component picture. Pure: it touches no meshes,
   * which keeps the decision about what a value means separate from the
   * drawing of it, and makes it testable without a renderer.
   */
  readEvidence(state) {
    const n = this.cylinders.length;
    const t = state.timestamp_s;
    const egt = state.sensor_egt_c || [];
    const cht = state.sensor_cht_c || [];
    const egtExp = state.mvem_expected_egt_c || egt;
    const chtExp = state.mvem_expected_cht_c || cht;
    const health = state.health || {};
    const cylHealth = health.cylinder_health || [];
    const residuals = state.residuals || {};
    const ai = state.ai_prognostics;

    // Whether the diagnosis has named a fault. Until it has, the model shows
    // only deviations that persist; once it has, it shows all the evidence at
    // once. This gates how readily a part annunciates, never which part does:
    // that still comes from each part's own readings.
    const diagnosed = !!(ai && ai.fault_class && ai.fault_class !== 'HEALTHY');

    // A reading the diagnosis blames on its own sensor.
    const suspect = this.readSuspectChannel(ai);

    // --- per cylinder, each on its own readings -----------------------
    const raw = [];
    for (let i = 0; i < n; i++) {
      const hasEgt = egt[i] !== undefined, hasCht = cht[i] !== undefined;
      if (!hasEgt && !hasCht) { raw.push(null); continue; }
      raw.push({
        dEgt: hasEgt ? (egt[i] - (egtExp[i] !== undefined ? egtExp[i] : egt[i])) / DEV_SIGMA.egt : 0,
        dCht: hasCht ? (cht[i] - (chtExp[i] !== undefined ? chtExp[i] : cht[i])) / DEV_SIGMA.cht : 0,
        egtSuspect: !!(suspect && suspect.kind === 'egt' && suspect.index === i),
        chtSuspect: !!(suspect && suspect.kind === 'cht' && suspect.index === i)
      });
    }

    // At a throttle change every thermocouple lags the model together. That
    // common-mode shift is removed by grading each cylinder on its difference
    // from the others; a fault in one cylinder is differential and survives.
    // A suspect reading is left out of the mean, or one dead probe would make
    // every other cylinder look hot.
    const mean = (vals) => vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const reject = n >= 2;
    const egtMean = reject ? mean(raw.filter(r => r && !r.egtSuspect).map(r => r.dEgt)) : 0;
    const chtMean = reject ? mean(raw.filter(r => r && !r.chtSuspect).map(r => r.dCht)) : 0;

    const cylinders = raw.map((r, i) => {
      if (!r) return null;
      const egtDev = r.egtSuspect ? 0 : Math.abs(r.dEgt);
      const chtDev = r.chtSuspect ? 0 : Math.abs(r.dCht);
      // The health score is computed from the same readings, so a cylinder
      // with a suspect channel cannot be escalated by it either.
      const byHealth = (r.egtSuspect || r.chtSuspect)
        ? 'nominal' : Engine3DView.gradeHealth(cylHealth[i]);
      const immediate = Engine3DView.worse(
        Engine3DView.gradeDeviation(Math.max(egtDev, chtDev)), byHealth);
      const held = this.persisted(`cyl-${i}`, Engine3DView.gradeDeviation(Math.max(
        r.egtSuspect ? 0 : Math.abs(r.dEgt - egtMean),
        r.chtSuspect ? 0 : Math.abs(r.dCht - chtMean))), t);
      return {
        index: i,
        egtSigma: r.dEgt,
        chtSigma: r.dCht,
        health: cylHealth[i],
        egtSuspect: r.egtSuspect,
        chtSuspect: r.chtSuspect,
        state: diagnosed ? immediate : held
      };
    });

    // One rule for every subsystem: immediate once diagnosed, persistent
    // residual only before. Persistence is tracked on every frame either way,
    // so the switch between the two is seamless.
    const subsystem = (key, healthPct, residual) => {
      const byResidual = Engine3DView.gradeDeviation(residual || 0);
      const held = this.persisted(key, byResidual, t);
      return diagnosed
        ? Engine3DView.worse(Engine3DView.gradeHealth(healthPct), byResidual)
        : held;
    };

    // --- oil circuit --------------------------------------------------
    const oilP = state.sensor_oil_p_bar;
    const oilExp = state.mvem_expected_oil_p_bar;
    const oil = {
      pressure: oilP,
      expected: oilExp,
      deficit: (oilP !== undefined && oilExp)
        ? Math.max(0, (oilExp - oilP) / Math.max(0.1, oilExp)) : 0,
      state: subsystem('sump', health.oil_system_health, residuals.oil_pressure)
    };

    // --- induction ----------------------------------------------------
    const map = state.sensor_map_bar;
    const mapExp = state.mvem_expected_map_bar;
    const turbo = {
      manifoldPressure: map,
      expected: mapExp,
      deficit: (map !== undefined && mapExp)
        ? Math.max(0, (mapExp - map) / Math.max(0.1, mapExp)) : 0,
      state: subsystem('turbo', health.turbo_boost_health, residuals.manifold_pressure)
    };

    // --- rotating assembly --------------------------------------------
    const vib = state.sensor_vib_rms_g;
    const vibExp = state.mvem_expected_vib_rms_g;
    const crankcase = {
      vibration: vib,
      vibrationExcess: (vib !== undefined && vibExp)
        ? Math.max(0, (vib - vibExp) / Math.max(0.05, vibExp)) : 0,
      vibrationHealth: health.vibration_health,
      rpmResidual: Math.abs(residuals.rpm || 0),
      state: subsystem('crankcase', health.vibration_health, residuals.vibration_rms)
    };

    return {
      cylinders, oil, turbo, crankcase,
      diagnosed,
      suspect,
      rpm: state.sensor_rpm,
      overallHealth: health.overall_health,
      focus: this.readFocus(state)
    };
  }

  /**
   * The reading the diagnosis blames on its own sensor, if any.
   *
   * When the classifier reports a sensor fault, its top contributing channel
   * is the reading it no longer trusts. Dropping that reading from the
   * cylinder's grade is what stops a thermocouple reading ambient from
   * painting a healthy cylinder as damaged.
   */
  readSuspectChannel(ai) {
    if (!ai || !ai.is_sensor_fault) return null;
    const top = (ai.top_contributing_channels || [])[0];
    const m = top && /^(egt|cht)_cyl_(\d+)$/.exec(top.channel_key || '');
    if (!m) return null;
    const index = Number(m[2]) - 1;
    return (index >= 0 && index < this.cylinders.length) ? { kind: m[1], index } : null;
  }

  /**
   * Holds a grade back until it has persisted for PERSIST_S.
   *
   * Simulation time, not wall time, so a paused or replayed feed behaves the
   * same, and a clock that restarts on refit resets the hold instead of
   * producing a negative duration.
   */
  persisted(key, grade, t) {
    if (grade === 'nominal' || t === undefined || t === null) {
      delete this.persistSince[key];
      return 'nominal';
    }
    const since = this.persistSince[key];
    if (since === undefined || t < since) {
      this.persistSince[key] = t;
      return 'nominal';
    }
    return (t - since) >= PERSIST_S ? grade : 'nominal';
  }

  /**
   * What to outline, and why.
   *
   * Taken from the diagnostic layer's own attribution: the channel it says
   * contributed most is mapped to the part that channel is measured on. When
   * the layer reports a sensor fault, the probe is outlined rather than the
   * cylinder, because a dead thermocouple is not a damaged cylinder.
   */
  readFocus(state) {
    const ai = state.ai_prognostics;
    if (!ai || !ai.anomaly_detected) return null;
    // The anomaly gate can flicker at a throttle change while the classifier
    // still says healthy; an outline waits for a named fault.
    if (!ai.fault_class || ai.fault_class === 'HEALTHY') return null;

    const top = (ai.top_contributing_channels || [])[0];
    if (!top || !top.channel_key) return null;

    const id = this.componentForChannel(top.channel_key, ai.is_sensor_fault);
    if (!id) return null;

    return {
      id,
      sensor: !!ai.is_sensor_fault,
      severity: ai.fault_severity || 0,
      channel: top.display_name || top.channel_key
    };
  }

  /**
   * Which part a telemetry channel is measured on.
   *
   * Per-cylinder channels resolve by their own index, so this works for a twin
   * and for a six equally. An EGT channel resolves to its probe when the fault
   * is in the sensor and to the cylinder when it is in the engine.
   */
  componentForChannel(key, isSensorFault) {
    const perCyl = /^(egt|cht)_cyl_(\d+)$/.exec(key);
    if (perCyl) {
      const i = Number(perCyl[2]) - 1;
      if (i < 0 || i >= this.cylinders.length) return null;
      return (isSensorFault && perCyl[1] === 'egt') ? `probe-${i}` : `cyl-${i}`;
    }
    return CHANNEL_COMPONENT[key] || null;
  }

  // ------------------------------------------------------------------
  // Drawing
  //
  // One function per subsystem, each taking the evidence for that subsystem.
  // None of them knows what fault is active.
  // ------------------------------------------------------------------

  /** Shades one cylinder from its own two channels. */
  updateCylinder(cyl, evidence) {
    if (!cyl || !evidence) return;
    cyl.jugMat.color.setHex(this.colourForState(evidence.state, VIEW_TOKENS.textDim));
    cyl.headMat.color.setHex(this.colourForState(evidence.state, this.identityColour(cyl.index)));
    // A reading the diagnosis no longer trusts is marked on its probe, in the
    // instrument colour: the sensor is at fault, not the cylinder.
    if (cyl.probeMat) {
      cyl.probeMat.color.setHex(
        evidence.egtSuspect ? VIEW_TOKENS.instrument : VIEW_TOKENS.textPrimary);
    }
    cyl.state = evidence.state;
    cyl.evidence = evidence;
  }

  /**
   * The identity hue a cylinder wears in every chart, tile and here. The
   * palette carries four; an engine with more cycles through them rather than
   * reading past the end, which would leave a head unshaded.
   */
  identityColour(i) {
    const hues = VIEW_TOKENS.cyl;
    return (hues && hues.length) ? hues[i % hues.length] : VIEW_TOKENS.textMuted;
  }

  /** Oil circuit: the sump darkens toward the annunciation as pressure falls. */
  updateOilSystem(oil) {
    if (!this.oilSumpMesh) return;
    this.oilSumpMesh.material.color.setHex(
      this.colourForState(oil.state, VIEW_TOKENS.border));
  }

  /**
   * Induction: the turbo is coloured by its state and spun by the boost it is
   * actually making, so losing boost visibly slows it rather than only
   * recolouring it.
   */
  updateTurbo(turbo) {
    if (!this.turboMesh) return;
    this.turboMesh.material.color.setHex(
      this.colourForState(turbo.state, VIEW_TOKENS.textMuted));
    const made = turbo.expected ? Math.max(0, 1 - turbo.deficit) : 1;
    this.turboSpin = TURBO_SPIN_MAX * made;
  }

  /**
   * Rotating assembly: colour from vibration health, and a physical shake
   * whose amplitude is the measured excess over what the model expects. At a
   * healthy engine the excess is zero and the engine sits still.
   */
  updateVibrationVisual(crankcase, diagnosed) {
    if (this.crankcaseMesh) {
      this.crankcaseMesh.material.color.setHex(
        this.colourForState(crankcase.state, VIEW_TOKENS.bgElevated));
    }
    // Shake and propeller unsteadiness are annunciations too. Health and speed
    // residuals both swing at a throttle change on a healthy engine, so the
    // engine only moves once the diagnosis has named a fault.
    if (diagnosed === false) {
      this.shakeAmplitude = 0;
      this.rpmUnsteady = 0;
      return;
    }
    // Driven by the health engine's vibration score rather than the raw ratio.
    // The measured level sits either side of the model's expectation by a few
    // tens of percent on a healthy engine, so a ratio would leave the engine
    // permanently trembling; the score is calibrated and reads a clean 100 when
    // nothing is wrong.
    const vibHealth = (crankcase.vibrationHealth === undefined
                       || crankcase.vibrationHealth === null)
      ? 100.0 : crankcase.vibrationHealth;
    const severity = Math.max(0, Math.min(1, (100.0 - vibHealth) / 100.0));
    this.shakeAmplitude = severity * SHAKE_MAX * (this.dims ? this.dims.scale / 0.64 : 1);
    // Torsional unsteadiness of the propeller, from how far speed sits from
    // the model's expectation. A misfire shows here rather than as a colour.
    this.rpmUnsteady = Math.min(1.0, crankcase.rpmResidual / RPM_UNSTEADY_SIGMA);
  }

  /**
   * Outlines whatever the diagnosis is actually leaning on. A sensor fault is
   * drawn in the instrument colour rather than an alarm colour, because the
   * engine is not the thing that is wrong.
   */
  updateFaultVisualization(focus) {
    const key = focus ? `${focus.id}:${focus.sensor ? 's' : 'p'}:${
      focus.severity >= 0.6 ? 'w' : 'c'}` : 'NONE';
    if (key === this.lastHighlightKey) return;
    this.lastHighlightKey = key;

    if (this.highlight) {
      this.scene.remove(this.highlight);
      if (this.highlight.geometry) this.highlight.geometry.dispose();
      if (this.highlight.material) this.highlight.material.dispose();
      this.highlight = null;
    }
    if (!focus) return;

    const b = this.componentBounds(focus.id);
    if (!b) return;

    const colour = focus.sensor ? VIEW_TOKENS.instrument
                 : (focus.severity >= 0.6 ? VIEW_TOKENS.warning : VIEW_TOKENS.caution);

    // Slightly proud of the selection box so the two never z-fight.
    const box = new THREE.BoxGeometry(b.size.x * 1.07, b.size.y * 1.05, b.size.z * 1.07);
    const edges = new THREE.EdgesGeometry(box);
    const marker = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: colour, transparent: true, opacity: 0.9 }));
    marker.position.copy(b.centre);
    marker.userData.pulse = true;
    box.dispose();
    this.scene.add(marker);
    this.highlight = marker;
  }

  /**
   * A frame has arrived: read it, then draw it.
   *
   * Robustness is deliberate. A missing channel leaves its part at the colour
   * it already had rather than shading on undefined, and a frame that stops
   * arriving is handled by the staleness check in animate(), not here.
   */
  updateFromTwinState(state) {
    if (!state) return;
    this.latestState = state;
    this.lastFrameAt = performance.now();
    if (this.isStale) this.setStale(false);
    this.currentRpm = state.sensor_rpm || this.currentRpm || 1400.0;

    const evidence = this.readEvidence(state);
    this.evidence = evidence;

    evidence.cylinders.forEach((e, i) => this.updateCylinder(this.cylinders[i], e));
    this.updateOilSystem(evidence.oil);
    this.updateTurbo(evidence.turbo);
    this.updateVibrationVisual(evidence.crankcase, evidence.diagnosed);
    this.updateFaultVisualization(evidence.focus);

    // Record the annunciation colour so the hover tint can be layered on top
    // of it and then cleanly removed.
    this.captureBaseColours();
  }

  /**
   * No telemetry is not the same as a healthy engine.
   *
   * When frames stop arriving the model drops to a flat, unmistakably inert
   * grey and the fault outline is removed, so nobody reads a frozen green
   * engine as a running one.
   */
  setStale(stale) {
    this.isStale = stale;
    if (stale) {
      // Persistence does not carry across a gap in telemetry.
      this.persistSince = {};
      this.pickables.forEach(m => {
        if (m.material && m.material.color) m.material.color.setHex(VIEW_TOKENS.border);
      });
      this.updateFaultVisualization(null);
      this.captureBaseColours();
    } else if (this.latestState) {
      // Redrawn from the frame that just arrived by the caller.
    }
  }

  // ------------------------------------------------------------------
  // Refitting
  //
  // The model is rebuilt only when the engine's shape changes, because a
  // rebuild drops the current selection and costs a full geometry upload.
  // Two engines of the same size and layout look identical here, so refitting
  // between them is a no-op.
  // ------------------------------------------------------------------
  setEngineSpec(spec) {
    if (!spec) return false;

    const next = {
      cylCount: Math.round(Math.max(1, Math.min(MAX_CYLINDERS,
                  spec.cylinders || REFERENCE_ENGINE.cylinders))),
      hasTurbo: spec.turbocharged !== false,
      displacementLitres: Number(spec.displacementLitres
                                 || REFERENCE_ENGINE.displacementLitres),
      ratedPowerHp: Number(spec.ratedPowerHp || REFERENCE_ENGINE.ratedPowerHp),
      ratedRpm: Number(spec.ratedRpm || REFERENCE_ENGINE.ratedRpm),
      layout: CYLINDER_LAYOUTS[spec.layout] ? spec.layout : 'inline'
    };
    this.engineLabel = spec.name || this.engineLabel;

    const unchanged = Object.keys(next).every(k => next[k] === this[k]);
    if (unchanged && this.engineGroup) return false;

    Object.assign(this, next);
    this.rebuildEngine();
    return true;
  }

  /** Earlier name, kept so any caller passing only a shape still works. */
  setEngineShape(shape) {
    return this.setEngineSpec(shape);
  }

  /** Frees the GPU resources of the current model. Engines can be swapped
   *  repeatedly in a session, and three.js does not collect these itself. */
  disposeEngine() {
    if (this.engineGroup) {
      this.engineGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        }
      });
      this.scene.remove(this.engineGroup);
      this.engineGroup = null;
    }

    this.labelSprites.forEach(sp => {
      this.scene.remove(sp);
      if (sp.material && sp.material.map) sp.material.map.dispose();
      if (sp.material) sp.material.dispose();
    });
    this.labelSprites = [];

    // These outline markers point at meshes that are about to stop existing.
    if (this.selectionBox) { this.scene.remove(this.selectionBox); this.selectionBox = null; }
    if (this.highlight) { this.scene.remove(this.highlight); this.highlight = null; }
    this.lastHighlightKey = null;

    this.pickables = [];
    this.cylinders = [];
    this.baseColours.clear();
    this.persistSince = {};
  }

  rebuildEngine() {
    const wasSelected = this.selectedId;

    this.disposeEngine();
    this.buildEngineGeometry();
    this.buildLabels();
    this.setLabelsVisible(this.labelsVisible);

    // Picking listeners live on the canvas and survive a rebuild; only the
    // mesh list had to be repopulated, which buildEngineGeometry just did.
    this.hoveredId = null;
    this.selectedId = null;

    // Restore the selection when that component still exists on this engine.
    if (wasSelected && COMPONENT_META[wasSelected]) {
      const idx = /^(?:cyl|probe)-(\d+)$/.exec(wasSelected);
      if (!idx || Number(idx[1]) < this.cylCount) {
        if (!(wasSelected === 'turbo' && !this.hasTurbo)) this.select(wasSelected);
      }
    }

    // Redraw from the frame already in hand, so a refit does not blank the
    // annunciation until the next frame arrives.
    if (this.latestState) this.updateFromTwinState(this.latestState);
    else this.captureBaseColours();
  }

  captureBaseColours() {
    this.baseColours.clear();
    this.pickables.forEach(m => {
      if (m.material && m.material.color) {
        this.baseColours.set(m, m.material.color.getHex());
      }
    });
  }

  /** Lifts whichever component is under the cursor, without recolouring it. */
  applyHoverTint() {
    this.pickables.forEach(m => {
      if (!m.material || !m.material.emissive) return;
      const id = m.userData.componentId;
      const isHover = id && id === this.hoveredId;
      const isSel = id && id === this.selectedId;
      const target = isHover ? 0.30 : (isSel ? 0.16 : 0.0);
      if (target > 0) {
        m.material.emissive.setHex(VIEW_TOKENS.instrument);
        m.material.emissiveIntensity = target;
      } else {
        m.material.emissiveIntensity = 0;
      }
    });
  }

  /**
   * Outlines the component a live fault implicates. One marker at a time —
   * the point is to direct the eye, not to decorate the model.
   */
  animate() {
    requestAnimationFrame(() => this.animate());

    // Telemetry that has stopped arriving is not a healthy engine.
    if (this.lastFrameAt && !this.isStale
        && performance.now() - this.lastFrameAt > STALE_AFTER_MS) {
      this.setStale(true);
    }

    if (this.propeller) {
      // Speed comes from the measured shaft speed. Unsteadiness is the speed
      // residual, so a rough-running engine turns visibly unevenly.
      const base = (this.currentRpm / 4000.0) * 0.40 + 0.05;
      const jitter = this.rpmUnsteady
        ? 1.0 + this.rpmUnsteady * 0.55 * Math.sin(performance.now() * 0.045)
        : 1.0;
      this.propeller.rotation.x += base * jitter;
    }

    // The turbo rotor turns at the boost the engine is actually making.
    if (this.turboMesh && this.turboSpin) {
      this.turboMesh.rotation.x += this.turboSpin;
    }

    // Measured vibration excess, as movement. Zero on a healthy engine.
    if (this.engineGroup) {
      if (this.shakeAmplitude > 1e-5) {
        const t = performance.now() * 0.05;
        this.engineGroup.position.y = Math.sin(t) * this.shakeAmplitude;
        this.engineGroup.position.z = Math.cos(t * 1.7) * this.shakeAmplitude * 0.6;
      } else if (this.engineGroup.position.y || this.engineGroup.position.z) {
        this.engineGroup.position.y = 0;
        this.engineGroup.position.z = 0;
      }
    }

    // Fault outline breathes slowly so it reads as an active annunciation
    // rather than a static box, at a rate well below the flicker threshold.
    if (this.highlight && this.highlight.material) {
      const t = performance.now() * 0.0018;
      this.highlight.material.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t));
    }

    this.applyHoverTint();

    if (this.targetCameraPos && this.camera && this.controls) {
      this.camera.position.lerp(this.targetCameraPos, 0.08);
      this.controls.target.lerp(this.targetLookAt, 0.08);
      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.04) {
        this.targetCameraPos = null;
        this.targetLookAt = null;
      }
    }

    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Re-reads the palette after a day/night switch and repaints.
   *
   * Everything that follows telemetry is simply redrawn from the last frame.
   * The few colours that do not (grid, spinner, propeller, turbo pipe, and the
   * label sprites, which bake their colour into a canvas) are repainted here,
   * or they would keep the previous theme until the page reloads.
   */
  updateTheme() {
    VIEW_TOKENS.refresh();
    if (this.grid && this.grid.material) {
      this.grid.material.color.setHex(VIEW_TOKENS.border);
    }
    const m = this.sharedMats;
    if (m) {
      if (m.spinner) m.spinner.color.setHex(VIEW_TOKENS.textMuted);
      if (m.blade) m.blade.color.setHex(VIEW_TOKENS.bgElevated);
      if (m.pipe) m.pipe.color.setHex(VIEW_TOKENS.textDim);
    }

    this.labelSprites.forEach(sp => {
      this.scene.remove(sp);
      if (sp.material && sp.material.map) sp.material.map.dispose();
      if (sp.material) sp.material.dispose();
    });
    this.labelSprites = [];
    if (this.dims) {
      this.buildLabels();
      this.setLabelsVisible(this.labelsVisible);
    }

    // Outline colour is chosen when the outline is drawn, so force a redraw.
    this.lastHighlightKey = null;
    if (this.latestState && !this.isStale) this.updateFromTwinState(this.latestState);
    else this.captureBaseColours();
  }

  onWindowResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = Math.floor(this.container.clientWidth);
    const height = Math.floor(this.container.clientHeight);
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
