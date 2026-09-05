/**
 * ENGINE-TWIN: 3D Engine Digital Twin
 * Procedural VRDE 2.2L 4-cylinder turbo aero-diesel powerplant.
 *
 * The model is an instrument, not decoration. Each cylinder is shaded by its
 * CHT/EGT deviation from the model-expected value, and whichever component a
 * live fault implicates is outlined so the operator's eye lands on it.
 *
 * Every colour resolves from the CSS custom properties in theme.css.
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
    bgPage: hex(css('--bg-page', '#0E0F11')),
    bgElevated: hex(css('--bg-elevated', '#24272B')),
    border: hex(css('--border', '#2A2D31')),
    textPrimary: hex(css('--text-primary', '#E8E6E1')),
    textMuted: hex(css('--text-muted', '#8A8F96')),
    textDim: hex(css('--text-dim', '#6B7076')),
    caution: hex(css('--caution', '#EF9F27')),
    cautionDim: hex(css('--caution-dim', '#BA7517')),
    warning: hex(css('--warning', '#E24B4A'))
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

    window.addEventListener('resize', () => this.onWindowResize());
    this.animate();
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

    // B. Oil sump
    const sumpMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.border, metalness: 0.85, roughness: 0.45
    });
    this.oilSumpMesh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.45, 1.2), sumpMat);
    this.oilSumpMesh.position.y = -0.80;
    engineGroup.add(this.oilSumpMesh);

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

      const headMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textMuted, metalness: 0.80, roughness: 0.30
      });
      const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.30, 0.70), headMat);
      headMesh.position.y = 1.50;
      cylGroup.add(headMesh);

      const probeMat = new THREE.MeshStandardMaterial({
        color: VIEW_TOKENS.textPrimary, metalness: 0.90, roughness: 0.25
      });
      const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.30, 12), probeMat);
      probe.position.y = 1.75;
      cylGroup.add(probe);

      engineGroup.add(cylGroup);
      this.cylinders.push({ group: cylGroup, jugMat, headMat, probeMat, jugMesh, index: i });
    }

    // D. Turbocharger
    const turboGroup = new THREE.Group();
    const turboMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.textMuted, metalness: 0.88, roughness: 0.28
    });
    this.turboMesh = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.14, 16, 32), turboMat);
    this.turboMesh.rotation.y = Math.PI / 2;
    turboGroup.add(this.turboMesh);

    const pipeMat = new THREE.MeshStandardMaterial({
      color: VIEW_TOKENS.textDim, metalness: 0.85, roughness: 0.35
    });
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 2.4, 16), pipeMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(1.1, 0.25, 0.55);
    turboGroup.add(pipe);

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
      const cylPos = this.cylinders[index].group.position;
      this.targetCameraPos = new THREE.Vector3(cylPos.x + 1.0, 2.0, 2.2);
      this.targetLookAt = new THREE.Vector3(cylPos.x, 1.1, 0);
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

  updateFromTwinState(state) {
    if (!state) return;
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

    this.updateHighlight(state.active_fault || 'HEALTHY');
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

    let target = null;
    let size = new THREE.Vector3(1, 1, 1);
    let centre = new THREE.Vector3();

    if (spec.part === 'sump') {
      target = this.oilSumpMesh; size.set(3.4, 0.62, 1.4); centre.set(0, -0.80, 0);
    } else if (spec.part === 'turbo') {
      target = this.turboMesh; size.set(1.0, 1.0, 1.0); centre.copy(this.turboGroup.position);
    } else if (spec.part === 'crankcase') {
      target = this.crankcaseMesh; size.set(3.8, 1.45, 1.6); centre.set(0, 0, 0);
    } else if (spec.part === 'cylinder' && this.cylinders[spec.index]) {
      const c = this.cylinders[spec.index];
      size.set(0.86, 2.05, 0.86);
      centre.set(c.group.position.x, 1.05, 0);
      target = c.jugMesh;
    } else if (spec.part === 'probe' && this.cylinders[spec.index]) {
      const c = this.cylinders[spec.index];
      size.set(0.34, 0.5, 0.34);
      centre.set(c.group.position.x, 1.75, 0);
      target = c.jugMesh;
    }
    if (!target) return;

    const colour = spec.state === 'warning' ? VIEW_TOKENS.warning : VIEW_TOKENS.caution;
    const box = new THREE.BoxGeometry(size.x, size.y, size.z);
    const edges = new THREE.EdgesGeometry(box);
    const marker = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.9 })
    );
    marker.position.copy(centre);
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
