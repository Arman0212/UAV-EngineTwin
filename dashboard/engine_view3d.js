/**
 * ENGINE-TWIN: 3D Engine Digital Twin
 * Procedural VRDE 2.2L 4-cylinder turbo aero-diesel powerplant.
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
  return {
    raw: css,
    bgPage: hex(css('--bg-page', '#0E0F11')),
    bgElevated: hex(css('--bg-elevated', '#24272B')),
    border: hex(css('--border', '#2A2D31')),
    textPrimary: hex(css('--text-primary', '#E8E6E1')),
    textMuted: hex(css('--text-muted', '#8A8F96')),
    textDim: hex(css('--text-dim', '#6B7076')),
    caution: hex(css('--caution', '#DFA33A')),
    cautionDim: hex(css('--caution-dim', '#BA7517')),
    warning: hex(css('--warning', '#DD5A4E')),
    ok: hex(css('--ok', '#8CBE68')),
    instrument: hex(css('--instrument', '#63A8D6'))
  };
})();

/**
 * Thermal deviation envelope. Cylinders are graded on how far they sit from
 * the model-expected value, in sigma, rather than on absolute temperature —
 * a cold-day 700 °C and a hot-day 760 °C are both nominal.
 */
const DEV_SIGMA = { egt: 25.0, cht: 8.0 };
const DEV_CAUTION = 2.0;
const DEV_WARNING = 4.0;

// Which component each fault implicates, for the highlight outline.
const FAULT_COMPONENT = {
  OIL_PRESSURE_LOSS: { part: 'sump', state: 'warning' },
  TURBO_BOOST_DEFICIENCY: { part: 'turbo', state: 'caution' },
  BEARING_WEAR_VIBRATION: { part: 'crankcase', state: 'caution' },
  CYLINDER_MISFIRE_TIMING: { part: 'crankcase', state: 'caution' },
  LEAN_MIXTURE_CYL3: { part: 'cylinder', index: 2, state: 'caution' },
  RICH_MIXTURE_CYL1: { part: 'cylinder', index: 0, state: 'caution' },
  COOLING_DEGRADATION_CYL2: { part: 'cylinder', index: 1, state: 'warning' },
  SENSOR_FAULT_EGT3: { part: 'probe', index: 2, state: 'caution' },
  ELECTRICAL_VOLTAGE_SAG: { part: 'crankcase', state: 'caution' }
};

// Selectable components. `id` is the stable handle the rest of the station
// uses to talk about a part — the health matrix selects by the same ids.
const COMPONENT_META = {
  'cyl-0':     { label: 'CYL 1', title: 'Cylinder 1' },
  'cyl-1':     { label: 'CYL 2', title: 'Cylinder 2' },
  'cyl-2':     { label: 'CYL 3', title: 'Cylinder 3' },
  'cyl-3':     { label: 'CYL 4', title: 'Cylinder 4' },
  'probe-0':   { label: 'EGT 1', title: 'EGT probe, cylinder 1' },
  'probe-1':   { label: 'EGT 2', title: 'EGT probe, cylinder 2' },
  'probe-2':   { label: 'EGT 3', title: 'EGT probe, cylinder 3' },
  'probe-3':   { label: 'EGT 4', title: 'EGT probe, cylinder 4' },
  'turbo':     { label: 'TURBO', title: 'Turbocharger' },
  'sump':      { label: 'SUMP',  title: 'Oil sump & lubrication circuit' },
  'crankcase': { label: 'CASE',  title: 'Crankcase & crankshaft' },
  'prop':      { label: 'PROP',  title: 'Propeller & reduction drive' }
};

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
    this.currentRpm = 1400.0;
    this.targetCameraPos = null;
    this.targetLookAt = null;

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 400;
    const height = this.container.clientHeight || 210;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(VIEW_TOKENS.bgPage);

    // The viewport is short and wide, so frame tightly and look slightly
    // down the cylinder bank: the engine has to read at half the previous
    // height without shrinking in the frame.
    this.camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    this.camera.position.set(3.4, 1.9, 4.4);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
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

  buildEngineGeometry() {
    const engineGroup = new THREE.Group();
    this.engineGroup = engineGroup;

    // A. Crankcase
    const crankcaseMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.bgElevated, metalness: 0.80, roughness: 0.40
    });
    this.crankcaseMesh = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.25, 1.4), crankcaseMat);
    engineGroup.add(this.crankcaseMesh);
    this.registerPickable(this.crankcaseMesh, 'crankcase');

    // B. Oil sump
    const sumpMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.border, metalness: 0.85, roughness: 0.45
    });
    this.oilSumpMesh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.45, 1.2), sumpMat);
    this.oilSumpMesh.position.y = -0.80;
    engineGroup.add(this.oilSumpMesh);
    this.registerPickable(this.oilSumpMesh, 'sump');

    // C. Four cylinder jugs, heads and probes
    const cylSpacing = 0.80;
    const startX = -1.20;

    for (let i = 0; i < 4; i++) {
      const cylGroup = new THREE.Group();
      cylGroup.position.x = startX + i * cylSpacing;

      const jugMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textDim, metalness: 0.75, roughness: 0.35
      });
      const jugMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 24), jugMat);
      jugMesh.position.y = 0.80;
      cylGroup.add(jugMesh);
      this.registerPickable(jugMesh, `cyl-${i}`);

      const headMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textMuted, metalness: 0.80, roughness: 0.30
      });
      const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.30, 0.70), headMat);
      headMesh.position.y = 1.50;
      cylGroup.add(headMesh);
      this.registerPickable(headMesh, `cyl-${i}`);

      // The probe is its own component: a dead thermocouple and a dead
      // cylinder are different findings, and the model should let the
      // operator point at each of them separately.
      const probeMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textPrimary, metalness: 0.90, roughness: 0.25
      });
      const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.30, 12), probeMat);
      probe.position.y = 1.75;
      cylGroup.add(probe);
      this.registerPickable(probe, `probe-${i}`);

      engineGroup.add(cylGroup);
      this.cylinders.push({
        group: cylGroup, jugMat, headMat, probeMat, jugMesh, headMesh, probe, index: i
      });
    }

    // D. Turbocharger
    const turboGroup = new THREE.Group();
    const turboMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.textMuted, metalness: 0.88, roughness: 0.28
    });
    this.turboMesh = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.14, 16, 32), turboMat);
    this.turboMesh.rotation.y = Math.PI / 2;
    turboGroup.add(this.turboMesh);
    this.registerPickable(this.turboMesh, 'turbo');

    const pipeMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.textDim, metalness: 0.85, roughness: 0.35
    });
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 2.4, 16), pipeMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(1.1, 0.25, 0.55);
    turboGroup.add(pipe);
    this.registerPickable(pipe, 'turbo');

    turboGroup.position.set(-2.1, 0.40, 0);
    engineGroup.add(turboGroup);
    this.turboGroup = turboGroup;

    // E. Spinner
    const spinnerMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.textMuted, metalness: 0.88, roughness: 0.25
    });
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.65, 24), spinnerMat);
    spinner.rotation.z = -Math.PI / 2;
    spinner.position.set(2.0, 0, 0);
    engineGroup.add(spinner);
    this.registerPickable(spinner, 'prop');

    // F. Propeller
    const propGroup = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.bgElevated, roughness: 0.6, metalness: 0.3
    });
    const bladeGeo = new THREE.BoxGeometry(0.12, 3.2, 0.03);
    const blade1 = new THREE.Mesh(bladeGeo, bladeMat);
    const blade2 = new THREE.Mesh(bladeGeo, bladeMat);
    blade2.rotation.x = Math.PI / 2;
    propGroup.add(blade1, blade2);
    propGroup.position.set(1.9, 0, 0);
    engineGroup.add(propGroup);
    this.propeller = propGroup;

    this.scene.add(engineGroup);
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
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: true
    }));
    const scale = 0.0042;
    sprite.scale.set(w * scale, h * scale, 1);
    return sprite;
  }

  buildLabels() {
    const place = (id, pos) => {
      const meta = COMPONENT_META[id];
      if (!meta) return;
      const s = this.makeLabelSprite(meta.label);
      s.position.copy(pos);
      s.userData.componentId = id;
      this.scene.add(s);
      this.labelSprites.push(s);
    };

    for (let i = 0; i < 4; i++) {
      const x = this.cylinders[i].group.position.x;
      place(`cyl-${i}`, new THREE.Vector3(x, 2.14, 0));
    }
    place('turbo', new THREE.Vector3(-2.1, 1.15, 0));
    place('sump', new THREE.Vector3(0, -1.28, 0));
    place('prop', new THREE.Vector3(2.35, 0.95, 0));
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
    if (!id) return null;
    if (id.startsWith('cyl-')) {
      const i = parseInt(id.slice(4), 10);
      const c = this.cylinders[i];
      if (!c) return null;
      return { centre: new THREE.Vector3(c.group.position.x, 1.02, 0),
               size: new THREE.Vector3(0.86, 2.00, 0.86) };
    }
    if (id.startsWith('probe-')) {
      const i = parseInt(id.slice(6), 10);
      const c = this.cylinders[i];
      if (!c) return null;
      return { centre: new THREE.Vector3(c.group.position.x, 1.75, 0),
               size: new THREE.Vector3(0.30, 0.44, 0.30) };
    }
    if (id === 'turbo') {
      return { centre: this.turboGroup.position.clone(),
               size: new THREE.Vector3(1.10, 1.10, 1.10) };
    }
    if (id === 'sump') {
      return { centre: new THREE.Vector3(0, -0.80, 0),
               size: new THREE.Vector3(3.34, 0.60, 1.34) };
    }
    if (id === 'crankcase') {
      return { centre: new THREE.Vector3(0, 0, 0),
               size: new THREE.Vector3(3.74, 1.39, 1.54) };
    }
    if (id === 'prop') {
      return { centre: new THREE.Vector3(1.95, 0, 0),
               size: new THREE.Vector3(0.9, 3.35, 3.35) };
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
      this.targetCameraPos = new THREE.Vector3(-4.0, 1.6, 2.2);
      this.targetLookAt = new THREE.Vector3(-2.1, 0.4, 0);
    } else if (preset === 'sump') {
      this.targetCameraPos = new THREE.Vector3(2.4, -2.0, 3.2);
      this.targetLookAt = new THREE.Vector3(0, -0.75, 0);
    }
  }

  focusCylinder(index) {
    if (index >= 0 && index < 4 && this.cylinders[index]) {
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

  updateFromTwinState(state) {
    if (!state) return;
    this.latestState = state;
    this.currentRpm = state.sensor_rpm || 1400.0;

    const egt = state.sensor_egt_c || [810, 810, 810, 810];
    const cht = state.sensor_cht_c || [175, 175, 175, 175];
    const egtExp = state.mvem_expected_egt_c || egt;
    const chtExp = state.mvem_expected_cht_c || cht;

    // --- Cylinders: shaded by thermal deviation from expected ---------
    for (let i = 0; i < 4; i++) {
      const cyl = this.cylinders[i];
      if (!cyl) continue;

      const dEgt = (egt[i] - (egtExp[i] !== undefined ? egtExp[i] : egt[i])) / DEV_SIGMA.egt;
      const dCht = (cht[i] - (chtExp[i] !== undefined ? chtExp[i] : cht[i])) / DEV_SIGMA.cht;
      const st = Engine3DView.gradeDeviation(Math.max(Math.abs(dEgt), Math.abs(dCht)));

      cyl.jugMat.color.setHex(this.colourForState(st, VIEW_TOKENS.textDim));
      cyl.headMat.color.setHex(this.colourForState(st, VIEW_TOKENS.textMuted));
      cyl.state = st;
    }

    // --- Oil sump: pressure is a falling parameter ---------------------
    const oilH = (state.health && state.health.oil_system_health !== undefined)
      ? state.health.oil_system_health : 100;
    this.oilSumpMesh.material.color.setHex(
      oilH < 50 ? VIEW_TOKENS.warning : (oilH < 85 ? VIEW_TOKENS.caution : VIEW_TOKENS.border)
    );

    // --- Turbocharger --------------------------------------------------
    const turboH = (state.health && state.health.turbo_boost_health !== undefined)
      ? state.health.turbo_boost_health : 100;
    this.turboMesh.material.color.setHex(
      turboH < 50 ? VIEW_TOKENS.warning : (turboH < 85 ? VIEW_TOKENS.caution : VIEW_TOKENS.textMuted)
    );

    // --- Crankcase: mechanical health ----------------------------------
    const vibH = (state.health && state.health.vibration_health !== undefined)
      ? state.health.vibration_health : 100;
    this.crankcaseMesh.material.color.setHex(
      vibH < 50 ? VIEW_TOKENS.warning : (vibH < 85 ? VIEW_TOKENS.caution : VIEW_TOKENS.bgElevated)
    );

    // Record the annunciation colour so the hover tint can be layered on
    // top of it and then cleanly removed.
    this.captureBaseColours();

    this.updateHighlight(state.active_fault || 'HEALTHY');
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
  updateHighlight(faultName) {
    const spec = FAULT_COMPONENT[faultName];
    const key = spec ? `${faultName}` : 'NONE';
    if (key === this.lastHighlightKey) return;
    this.lastHighlightKey = key;

    if (this.highlight) {
      this.scene.remove(this.highlight);
      if (this.highlight.geometry) this.highlight.geometry.dispose();
      if (this.highlight.material) this.highlight.material.dispose();
      this.highlight = null;
    }
    if (!spec) return;

    let id = null;
    if (spec.part === 'sump') id = 'sump';
    else if (spec.part === 'turbo') id = 'turbo';
    else if (spec.part === 'crankcase') id = 'crankcase';
    else if (spec.part === 'cylinder') id = `cyl-${spec.index}`;
    else if (spec.part === 'probe') id = `probe-${spec.index}`;

    const b = this.componentBounds(id);
    if (!b) return;

    const colour = spec.state === 'warning' ? VIEW_TOKENS.warning : VIEW_TOKENS.caution;
    // Slightly proud of the selection box so the two never z-fight.
    const box = new THREE.BoxGeometry(b.size.x * 1.07, b.size.y * 1.05, b.size.z * 1.07);
    const edges = new THREE.EdgesGeometry(box);
    const marker = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.9 })
    );
    marker.position.copy(b.centre);
    marker.userData.pulse = true;
    box.dispose();
    this.scene.add(marker);
    this.highlight = marker;
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    if (this.propeller) {
      const rotSpeed = (this.currentRpm / 4000.0) * 0.40 + 0.05;
      this.propeller.rotation.x += rotSpeed;
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
