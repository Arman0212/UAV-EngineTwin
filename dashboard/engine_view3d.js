/**
 * ENGINE-TWIN: Precision Aerospace 3D Engine Digital Twin Model
 * Procedural VRDE 2.2L 4-Cylinder Turbo Aero-Diesel Powerplant
 */

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

    this.currentRpm = 1400.0;
    this.targetCameraPos = null;
    this.targetLookAt = null;

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 400;
    const height = this.container.clientHeight || 300;

    // 1. Scene & Camera
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090d16);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    this.camera.position.set(4.8, 3.2, 5.8);

    // 2. WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // 3. Orbit Controls
    if (window.THREE.OrbitControls) {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.maxDistance = 16;
      this.controls.minDistance = 2.0;
      this.controls.target.set(0, 0.35, 0);
    }

    // 4. Industrial Studio Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.70);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xe2e8f0, 1.2);
    keyLight.position.set(6, 10, 8);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x64748b, 0.6);
    fillLight.position.set(-6, -2, -6);
    this.scene.add(fillLight);

    // 5. Ground Engineering Grid
    const grid = new THREE.GridHelper(10, 20, 0x334155, 0x1e293b);
    grid.position.y = -1.1;
    this.scene.add(grid);

    // 6. Build Engine Geometry
    this.buildEngineGeometry();

    // 7. Event Listeners
    window.addEventListener('resize', () => this.onWindowResize());
    this.animate();
  }

  buildEngineGeometry() {
    const engineGroup = new THREE.Group();

    // A. Main Anodized Aluminum Crankcase Block
    const crankcaseGeo = new THREE.BoxGeometry(3.6, 1.25, 1.4);
    const crankcaseMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.85,
      roughness: 0.35
    });
    const crankcase = new THREE.Mesh(crankcaseGeo, crankcaseMat);
    crankcase.castShadow = true;
    crankcase.receiveShadow = true;
    engineGroup.add(crankcase);

    // B. Oil Sump / Lower Pan
    const sumpGeo = new THREE.BoxGeometry(3.2, 0.45, 1.2);
    const sumpMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      metalness: 0.90,
      roughness: 0.40
    });
    this.oilSumpMesh = new THREE.Mesh(sumpGeo, sumpMat);
    this.oilSumpMesh.position.y = -0.80;
    engineGroup.add(this.oilSumpMesh);

    // C. 4 Individual Cylinder Jugs & Heads
    const cylSpacing = 0.80;
    const startX = -1.20;

    for (let i = 0; i < 4; i++) {
      const cylGroup = new THREE.Group();
      const xPos = startX + i * cylSpacing;

      // Finned Cylinder Barrel
      const jugGeo = new THREE.CylinderGeometry(0.32, 0.32, 1.2, 24);
      const jugMat = new THREE.MeshStandardMaterial({
        color: 0x475569,
        emissive: 0x0369a1,
        emissiveIntensity: 0.12,
        metalness: 0.80,
        roughness: 0.30
      });
      const jugMesh = new THREE.Mesh(jugGeo, jugMat);
      jugMesh.position.y = 0.80;
      cylGroup.add(jugMesh);

      // Cylinder Head Block
      const headGeo = new THREE.BoxGeometry(0.70, 0.30, 0.70);
      const headMat = new THREE.MeshStandardMaterial({
        color: 0x64748b,
        emissive: 0x0369a1,
        emissiveIntensity: 0.15,
        metalness: 0.85,
        roughness: 0.25
      });
      const headMesh = new THREE.Mesh(headGeo, headMat);
      headMesh.position.y = 1.50;
      cylGroup.add(headMesh);

      // Top Injector / Sensor Probe
      const probeGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.30, 12);
      const probeMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.95 });
      const probe = new THREE.Mesh(probeGeo, probeMat);
      probe.position.y = 1.75;
      cylGroup.add(probe);

      cylGroup.position.x = xPos;
      engineGroup.add(cylGroup);

      this.cylinders.push({
        group: cylGroup,
        jugMat: jugMat,
        headMat: headMat,
        index: i
      });
    }

    // D. Turbocharger & Compressor Assembly
    const turboGroup = new THREE.Group();
    const turbineGeo = new THREE.TorusGeometry(0.36, 0.14, 16, 32);
    const turboMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.15,
      metalness: 0.90
    });
    this.turboMesh = new THREE.Mesh(turbineGeo, turboMat);
    this.turboMesh.rotation.y = Math.PI / 2;
    turboGroup.add(this.turboMesh);

    const pipeGeo = new THREE.CylinderGeometry(0.10, 0.10, 2.4, 16);
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.85 });
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(1.1, 0.25, 0.55);
    turboGroup.add(pipe);

    turboGroup.position.set(-2.1, 0.40, 0);
    engineGroup.add(turboGroup);

    // E. Front Propeller Hub & Spinner
    const spinnerGeo = new THREE.ConeGeometry(0.28, 0.65, 24);
    const spinnerMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.90, roughness: 0.25 });
    const spinner = new THREE.Mesh(spinnerGeo, spinnerMat);
    spinner.rotation.z = -Math.PI / 2;
    spinner.position.set(2.0, 0, 0);
    engineGroup.add(spinner);

    // F. Rotating Dual-Blade Carbon Propeller
    const propGroup = new THREE.Group();
    const bladeGeo = new THREE.BoxGeometry(0.12, 3.2, 0.03);
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.6, metalness: 0.3 });
    const blade1 = new THREE.Mesh(bladeGeo, bladeMat);
    const blade2 = new THREE.Mesh(bladeGeo, bladeMat);
    blade2.rotation.x = Math.PI / 2;
    propGroup.add(blade1);
    propGroup.add(blade2);
    propGroup.position.set(1.9, 0, 0);
    engineGroup.add(propGroup);
    this.propeller = propGroup;

    this.scene.add(engineGroup);
  }

  setCameraPreset(preset) {
    if (!this.camera || !this.controls) return;
    if (preset === 'orbit') {
      this.targetCameraPos = new THREE.Vector3(4.8, 3.2, 5.8);
      this.targetLookAt = new THREE.Vector3(0, 0.35, 0);
    } else if (preset === 'cylinders') {
      this.targetCameraPos = new THREE.Vector3(0, 3.2, 3.0);
      this.targetLookAt = new THREE.Vector3(0, 1.2, 0);
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

  updateFromTwinState(state) {
    if (!state) return;
    this.currentRpm = state.sensor_rpm || 1400.0;

    const cylHealths = (state.health && state.health.cylinder_health) || [100, 100, 100, 100];
    const chtTemps = state.sensor_cht_c || [175, 175, 175, 175];

    for (let i = 0; i < 4; i++) {
      if (!this.cylinders[i]) continue;
      const h = cylHealths[i];
      const t = chtTemps[i];

      let glowColor, intensity;
      if (h < 50.0 || t > 215.0) {
        glowColor = 0xdc2626; // Overheat Crimson Red
        intensity = 0.70;
      } else if (h < 80.0 || t > 190.0) {
        glowColor = 0xd97706; // Caution Amber
        intensity = 0.45;
      } else {
        glowColor = 0x0284c7; // Nominal Steel Blue
        intensity = 0.12;
      }

      this.cylinders[i].jugMat.emissive.setHex(glowColor);
      this.cylinders[i].jugMat.emissiveIntensity = intensity;
      this.cylinders[i].headMat.emissive.setHex(glowColor);
      this.cylinders[i].headMat.emissiveIntensity = intensity * 1.1;
    }

    // Oil Sump Glow
    if (state.health && state.health.oil_system_health < 50.0) {
      this.oilSumpMesh.material.emissive = new THREE.Color(0xb91c1c);
      this.oilSumpMesh.material.emissiveIntensity = 0.75;
    } else {
      this.oilSumpMesh.material.emissive = new THREE.Color(0x000000);
      this.oilSumpMesh.material.emissiveIntensity = 0.0;
    }

    // Turbo Boost Glow
    if (state.health && state.health.turbo_boost_health < 60.0) {
      this.turboMesh.material.emissive.setHex(0xd97706);
      this.turboMesh.material.emissiveIntensity = 0.65;
    } else {
      this.turboMesh.material.emissive.setHex(0x0284c7);
      this.turboMesh.material.emissiveIntensity = 0.15;
    }
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

    if (this.controls) {
      this.controls.update();
    }

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
