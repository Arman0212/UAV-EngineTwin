"""
ENGINE-TWIN: Real-Time Digital Twin Streaming Backend Service (SIH26054)
FastAPI + WebSockets service running:
- 20 Hz continuous MVEM physics integration
- Datasheet sensor simulation with noise & dynamics
- Physics-anchored 12-state Kalman estimation
- Normalized physics residual calculation
- AI Anomaly Detection + Multi-Task Fault Classification + RUL Prognostics
- Gradient-based local attribution + Operator Alert Generation
- High-frequency WebSocket broadcast to interactive 3D dashboard
"""
import os
import sys
import asyncio
import json
import time
from pathlib import Path
from typing import Dict, List, Optional, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from pydantic import BaseModel

# Ensure project root is in path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulation.flight_profile import FlightProfile, FlightState
from simulation.mvem import MeanValueEngineModel, EngineState
from simulation.sensors import SensorModel, SensorReadings
from simulation.fault_injector import FaultInjector, FaultType, FaultConfig
from digital_twin.health_index import HealthIndexEngine
from digital_twin.baseline_adapter import BaselineAdapter
from digital_twin.state_estimator import PhysicsAnchoredKalmanEstimator
from digital_twin.twin_state import DigitalTwinState, SubsystemHealth, AIHealthState, StateLevel
from digital_twin.flight_recorder import (
    FlightRecorder, list_sessions, analyse_session, load_frames,
)
from models.sensor_validator import SensorValidator
from models.anomaly_autoencoder import AnomalyDetector
from models.fault_classifier import FaultDiagnosisEngine
from models.rul_estimator import RULEstimator
from xai.attribution import GradientAttributionExplainer
from xai.alert_generator import AlertGenerator

app = FastAPI(title="ENGINE-TWIN Real-Time Digital Twin Server")

# Serve dashboard static assets
DASHBOARD_DIR = PROJECT_ROOT / "dashboard"
DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(DASHBOARD_DIR)), name="static")

# Global Engine Twin Runtime State
class EngineTwinRuntime:
    def __init__(self):
        self.flight_gen = FlightProfile()
        self.mvem_physical = MeanValueEngineModel()      # Physical/Simulated engine (subject to faults)
        self.mvem_baseline = MeanValueEngineModel()      # Healthy Digital Twin baseline
        self.sensors = SensorModel(seed=42)
        self.injector = FaultInjector(self.mvem_physical, self.sensors)
        self.ekf = PhysicsAnchoredKalmanEstimator()
        self.health_engine = HealthIndexEngine()
        self.sensor_validator = SensorValidator()
        self.rul_engine = RULEstimator()

        # Load AI Models
        models_dir = PROJECT_ROOT / "models" / "saved_models"
        ae_path = models_dir / "anomaly_autoencoder.pt"
        clf_path = models_dir / "fault_classifier.pt"

        self.anomaly_detector = AnomalyDetector(str(ae_path) if ae_path.exists() else None)
        self.fault_classifier = FaultDiagnosisEngine(str(clf_path) if clf_path.exists() else None)
        # Learns the standing offset between this engine and the datasheet
        # baseline, so downstream consumers see deviation from THIS unit's
        # normal rather than from the book.
        self.baseline_adapter = BaselineAdapter()
        self.shap_explainer = GradientAttributionExplainer(self.fault_classifier.model if self.fault_classifier.is_trained else None)

        self.sim_time_s = 0.0
        self.time_scale = 1.0
        self.is_running = True
        self.total_mission_duration_s = 3600.0

        # Manual flight sandbox: when enabled the mission profile is overridden
        # by the operator's throttle/altitude/OAT settings, and the ISA
        # atmosphere is recomputed for the commanded altitude so the turbo
        # actually sees the thinner air rather than only the label changing.
        self.manual_override = False
        self.override_throttle = 72.0
        self.override_altitude = 28500.0
        self.override_oat = -42.5

        # Commanded values are targets, not teleports. The sliders are slewed
        # toward them at rates a MALE airframe can actually fly, because an
        # instantaneous altitude step is not a manoeuvre — it is a discontinuity,
        # and the twin correctly reports it as one. Sensors carry first-order lag
        # (EGT tau = 2.0 s) while the MVEM baseline does not, so a step command
        # opens a residual gap that the classifier reads as a real turbo fault.
        # Slewing keeps the sandbox inside the physics the twin was built for.
        self._slew_altitude = 28500.0
        self._slew_throttle = 72.0
        self._slew_oat = -42.5

        # Latest State Snapshot
        self.latest_state: Optional[DigitalTwinState] = None
        self.latest_alert: Optional[Dict[str, Any]] = None
        self.latest_frame: Optional[Dict[str, Any]] = None
        self.active_fault_name: str = "HEALTHY"

        # Flight data recorder (attached by the service on startup)
        self.recorder: Optional[FlightRecorder] = None

    def reset(self):
        self.sim_time_s = 0.0
        self.mvem_physical.reset(idle=False)
        self.mvem_baseline.reset(idle=False)
        self.sensors = SensorModel(seed=int(time.time()))
        self.injector = FaultInjector(self.mvem_physical, self.sensors)
        self.ekf = PhysicsAnchoredKalmanEstimator()
        self.rul_engine.reset()
        # A reset means a different engine; the learned offset does not carry over.
        self.baseline_adapter.reset()
        self.latest_alert = None
        self.active_fault_name = "HEALTHY"

    # Sandbox slew limits, chosen from what the airframe can actually do rather
    # than from what the sliders can express.
    MAX_CLIMB_FPS = 50.0        # 3,000 ft/min, a brisk but real MALE climb rate
    MAX_THROTTLE_PPS = 25.0     # %/s
    MAX_OAT_CPS = 6.0           # deg C/s, roughly what the climb rate implies

    def _slew_toward_commanded(self, dt_s: float):
        """Moves the sandbox state toward the commanded setpoints at flyable rates.

        Rates are per second of *simulation* time, so the 2x/5x/10x controls
        speed the climb up with everything else. At 1x, 3,000 ft/min is what a
        MALE airframe actually does; at 10x the sandbox reaches loiter altitude
        in about a minute of wall clock without ever commanding a step change.
        """
        dt_s = dt_s * max(0.2, self.time_scale)
        def approach(current: float, target: float, rate: float) -> float:
            step = rate * dt_s
            delta = target - current
            if abs(delta) <= step:
                return target
            return current + (step if delta > 0 else -step)

        self._slew_altitude = approach(
            self._slew_altitude, max(0.0, min(35000.0, self.override_altitude)),
            self.MAX_CLIMB_FPS)
        self._slew_throttle = approach(
            self._slew_throttle, max(0.0, min(100.0, self.override_throttle)),
            self.MAX_THROTTLE_PPS)
        self._slew_oat = approach(
            self._slew_oat, max(-60.0, min(50.0, self.override_oat)),
            self.MAX_OAT_CPS)

    def warm_up(self, seconds: float = 15.0, dt_s: float = 0.05):
        """
        Runs the twin forward before any client attaches.

        From a cold start the EKF covariance, the cylinder thermal states and the
        oil circuit need roughly ten seconds to settle; until they do, the
        residuals are large and the health index reads CRITICAL on a perfectly
        healthy engine. Warming up off-screen means the dashboard's first frame
        shows the engine as it actually is.
        """
        steps = int(seconds / dt_s)
        for _ in range(steps):
            self.step(dt_s=dt_s, record=False)
        self.rul_engine.reset()

    def step(self, dt_s: float = 0.05, record: bool = True) -> DigitalTwinState:
        self.sim_time_s += dt_s * self.time_scale
        t = self.sim_time_s

        # 1. Flight State
        flight = self.flight_gen.get_standard_mission_state(t, self.total_mission_duration_s)

        # 1b. Manual flight sandbox override, if the operator has taken control.
        # The ISA atmosphere is recomputed at the commanded altitude so that
        # manifold pressure, turbo derating and power all respond for real.
        if self.manual_override:
            self._slew_toward_commanded(dt_s)
            flight.throttle_pct = self._slew_throttle
            flight.altitude_ft = self._slew_altitude
            flight.altitude_m = FlightProfile.feet_to_meters(flight.altitude_ft)
            _, p_bar, rho = FlightProfile.get_isa_atmosphere(flight.altitude_m)
            flight.ambient_temp_c = self._slew_oat
            flight.ambient_pressure_bar = p_bar
            flight.air_density_kgpm3 = rho
            flight.phase = "MANUAL_SANDBOX"

        # 2. Update Fault Injection Progress
        self.injector.update(t)

        # 3. Simulate Physical Engine & Sensor Measurement
        true_physical = self.mvem_physical.step(flight, dt_s=dt_s)
        sensor_meas = self.sensors.sample(true_physical, flight, dt_s=dt_s)

        # 4. Simulate Healthy Digital Twin Physics Baseline
        mvem_expected = self.mvem_baseline.step(flight, dt_s=dt_s)

        # 5. Physics-anchored Kalman state estimation
        self.ekf.predict(mvem_expected, dt_s=dt_s)
        self.ekf.update(sensor_meas)
        ekf_est = self.ekf.get_estimated_state()

        # 6. Normalized Residual Calculation: (y_sensor - y_mvem) / sigma
        sensor_dict = {
            "rpm": sensor_meas.rpm,
            "manifold_pressure": sensor_meas.manifold_pressure_bar,
            "oil_pressure": sensor_meas.oil_pressure_bar,
            "oil_temp": sensor_meas.oil_temp_c,
            "fuel_flow": sensor_meas.fuel_flow_lph,
            "egt_c": sensor_meas.egt_c,
            "cht_c": sensor_meas.cht_c,
            "vibration_rms": sensor_meas.vibration_rms_g,
            "bus_voltage": sensor_meas.bus_voltage_v,
            "ambient_temp_c": sensor_meas.ambient_temp_c
        }
        mvem_dict = {
            "rpm": mvem_expected.rpm,
            "manifold_pressure": mvem_expected.manifold_pressure_bar,
            "oil_pressure": mvem_expected.oil_pressure_bar,
            "oil_temp": mvem_expected.oil_temp_c,
            "fuel_flow": mvem_expected.fuel_flow_lph,
            "egt_c": mvem_expected.egt_c,
            "cht_c": mvem_expected.cht_c,
            "vibration_rms": mvem_expected.vibration_rms_g,
            "bus_voltage": mvem_expected.bus_voltage_v
        }
        raw_residuals = self.health_engine.compute_residuals(sensor_dict, mvem_dict)

        # 6b. Baseline adaptation. Apply the bias learned so far, then update it
        # at the end of the tick with this tick's gate decisions. Applying first
        # and updating after keeps the loop causal: the estimate never depends
        # on a verdict derived from itself.
        residuals = self.baseline_adapter.apply(raw_residuals)

        sensor_check = self.sensor_validator.validate(sensor_dict, mvem_dict, residuals)

        if sensor_check.is_sensor_fault:
            # Decouple faulty sensor probe from mechanical health evaluation
            mech_residuals = dict(residuals)
            if sensor_check.faulty_channel:
                mech_residuals[sensor_check.faulty_channel] = 0.0
            subsystem_health = self.health_engine.evaluate_health(mech_residuals)
            subsystem_health.status_level = StateLevel.ADVISORY
        else:
            subsystem_health = self.health_engine.evaluate_health(residuals)

        # 9. AI Anomaly Detection & Fault Diagnosis
        is_anom, raw_mse, anom_thresh, anom_index = self.anomaly_detector.detect(residuals)
        
        if sensor_check.is_sensor_fault:
            fault_class = "SENSOR_FAULT_EGT3" if "egt" in (sensor_check.faulty_channel or "") else "SENSOR_FAULT_GENERAL"
            conf = sensor_check.confidence_pct
            sev = 0.25
        elif is_anom or subsystem_health.overall_health < 85.0:
            fault_class, conf, sev, _ = self.fault_classifier.diagnose(residuals)
        else:
            fault_class = "HEALTHY"
            conf = 99.8
            sev = 0.0

        # 9b. Advance the baseline estimate. Gated on this tick's verdict: a
        # developing fault holds the estimate still rather than being learned
        # as this engine's normal.
        self.baseline_adapter.update(
            raw_residuals,
            dt_s=dt_s,
            phase=flight.phase,
            is_anomalous=is_anom,
            fault_annunciated=(fault_class != "HEALTHY"),
        )

        # 10. RUL Prognostics
        rul_pred = self.rul_engine.update(
            t, subsystem_health.overall_health, subsystem_health=subsystem_health
        )

        # 11. XAI local attribution (gradient x input)
        shap_exps = self.shap_explainer.explain(residuals, fault_class)

        # 12. Operator Alert Generation
        alert = AlertGenerator.generate(
            timestamp_s=t,
            fault_class=fault_class,
            confidence_pct=conf,
            severity=sev,
            is_sensor_fault=sensor_check.is_sensor_fault,
            sensor_check_explanation=sensor_check.explanation,
            shap_explanations=shap_exps,
            rul_prediction=rul_pred,
            overall_health=subsystem_health.overall_health
        )
        self.latest_alert = alert.to_dict() if alert else None

        ai_health_state = AIHealthState(
            anomaly_detected=is_anom,
            anomaly_score=anom_index,
            anomaly_raw_mse=raw_mse,
            anomaly_threshold=anom_thresh,
            fault_class=fault_class,
            fault_confidence_pct=conf,
            fault_severity=sev,
            is_sensor_fault=sensor_check.is_sensor_fault,
            rul_hours_mean=rul_pred.rul_hours_mean,
            rul_hours_min=rul_pred.rul_hours_min,
            rul_hours_max=rul_pred.rul_hours_max,
            top_contributing_channels=shap_exps,
            recommended_action=alert.recommended_action if alert else "Continue nominal mission profile."
        )

        state = DigitalTwinState(
            timestamp_s=round(t, 2),
            altitude_ft=round(flight.altitude_ft, 1),
            ambient_temp_c=round(flight.ambient_temp_c, 2),
            throttle_pct=round(flight.throttle_pct, 1),
            airspeed_mps=round(flight.airspeed_mps, 1),
            mission_phase=flight.phase,
            # Sensor
            sensor_rpm=round(sensor_meas.rpm, 1),
            sensor_map_bar=round(sensor_meas.manifold_pressure_bar, 3),
            sensor_oil_p_bar=round(sensor_meas.oil_pressure_bar, 2),
            sensor_oil_t_c=round(sensor_meas.oil_temp_c, 1),
            sensor_coolant_t_c=round(sensor_meas.coolant_temp_c, 1),
            sensor_fuel_flow_lph=round(sensor_meas.fuel_flow_lph, 2),
            sensor_egt_c=[round(x, 1) for x in sensor_meas.egt_c],
            sensor_cht_c=[round(x, 1) for x in sensor_meas.cht_c],
            sensor_vib_rms_g=round(sensor_meas.vibration_rms_g, 3),
            sensor_bus_v=round(sensor_meas.bus_voltage_v, 2),
            # MVEM Expected
            mvem_expected_power_hp=round(mvem_expected.power_hp, 1),
            mvem_expected_rpm=round(mvem_expected.rpm, 1),
            mvem_expected_map_bar=round(mvem_expected.manifold_pressure_bar, 3),
            mvem_expected_oil_p_bar=round(mvem_expected.oil_pressure_bar, 2),
            mvem_expected_oil_t_c=round(mvem_expected.oil_temp_c, 1),
            mvem_expected_egt_c=[round(x, 1) for x in mvem_expected.egt_c],
            mvem_expected_cht_c=[round(x, 1) for x in mvem_expected.cht_c],
            mvem_expected_fuel_lph=round(mvem_expected.fuel_flow_lph, 2),
            mvem_expected_vib_rms_g=round(mvem_expected.vibration_rms_g, 3),
            # Estimated EKF
            estimated_rpm=ekf_est["estimated_rpm"],
            estimated_map_bar=ekf_est["estimated_map_bar"],
            estimated_oil_p_bar=ekf_est["estimated_oil_p_bar"],
            estimated_oil_t_c=ekf_est["estimated_oil_t_c"],
            estimated_egt_c=ekf_est["estimated_egt_c"],
            estimated_cht_c=ekf_est["estimated_cht_c"],
            # Residuals & Health
            residuals=residuals,
            raw_residuals=raw_residuals,
            baseline_bias={ch: round(v, 3) for ch, v in self.baseline_adapter.bias.items()},
            baseline_adapted=self.baseline_adapter.is_converged,
            health=subsystem_health,
            ai_prognostics=ai_health_state,
            provenance="SIMULATED"
        )
        self.latest_state = state

        # Build the broadcast frame once and reuse it for the WebSocket, the SSE
        # stream, /api/state and the recorder, so every consumer sees the same
        # bytes and recording costs one serialisation rather than two.
        frame = state.to_dict()
        frame["active_alert"] = self.latest_alert
        # Full adaptation status: bias vector, converged flag, how far through
        # convergence it is, and why it is frozen when it is.
        frame["baseline_adaptation"] = self.baseline_adapter.to_dict()
        self.latest_frame = frame

        if record and self.recorder is not None:
            self.recorder.record(frame)

        return state


twin_runtime = EngineTwinRuntime()

# -------------------------------------------------------------
# Simulation driver
#
# The twin advances on its own background task rather than inside a client's
# WebSocket handler. That keeps sortie time independent of who is watching:
# /api/state is populated with no browser attached, and opening a second
# dashboard tab observes the same sortie instead of stepping it a second time.
# -------------------------------------------------------------
SIM_DT_S = 0.05          # 20 Hz twin update
BROADCAST_HZ = 20.0

class ReplayController:
    """
    Drives the broadcast from a recorded sortie instead of the live twin.

    Replay is deliberately a property of the *stream*, not of the twin: the live
    simulation keeps running underneath, so leaving replay returns the operator
    to a mission in progress rather than to a cold engine.
    """
    def __init__(self):
        self.frames: List[Dict[str, Any]] = []
        self.session_id: Optional[str] = None
        self.cursor: int = 0
        self.speed: float = 1.0
        self.playing: bool = False

    def load(self, session_id: str, speed: float = 1.0) -> int:
        frames = load_frames(session_id)
        if not frames:
            raise ValueError(f"No frames recorded for sortie '{session_id}'")
        self.frames = frames
        self.session_id = session_id
        self.cursor = 0
        self.speed = max(0.2, min(10.0, speed))
        self.playing = True
        return len(frames)

    def stop(self):
        self.playing = False
        self.frames = []
        self.session_id = None
        self.cursor = 0

    def tick(self):
        """
        Advances the playhead one broadcast period.

        Only the simulation loop calls this. Consumers read the frame at the
        current cursor without moving it, so replay runs at wall-clock speed
        regardless of how many dashboards, SSE clients or pollers are attached.
        """
        if not self.playing or not self.frames:
            return
        self.cursor += max(1, int(round(self.speed)))
        if self.cursor >= len(self.frames):
            self.cursor = len(self.frames) - 1
            self.playing = False       # hold on the last frame at end of sortie

    def current(self) -> Optional[Dict[str, Any]]:
        if not self.frames:
            return None
        idx = max(0, min(self.cursor, len(self.frames) - 1))
        frame = self.frames[idx]
        if not self.playing and idx >= len(self.frames) - 1:
            return frame | {"replay_complete": True}
        return frame

    def status(self) -> Dict[str, Any]:
        return {
            "playing": self.playing,
            "session_id": self.session_id,
            "cursor": self.cursor,
            "total_frames": len(self.frames),
            "speed": self.speed,
        }

replay = ReplayController()


def current_frame() -> Optional[Dict[str, Any]]:
    """The frame every consumer should send right now: replay if active, else live."""
    if replay.frames:
        frame = replay.current()
        if frame is not None:
            return frame | {"source": "REPLAY", "replay": replay.status()}
    if twin_runtime.latest_frame is not None:
        return twin_runtime.latest_frame | {"source": "LIVE"}
    return None


async def simulation_loop():
    """Advances the twin at a fixed 20 Hz for the life of the process."""
    period = 1.0 / BROADCAST_HZ
    next_tick = time.perf_counter()
    while True:
        try:
            twin_runtime.step(dt_s=SIM_DT_S)
            replay.tick()                            # playhead moves on the clock, not per reader
        except Exception as e:                      # a bad frame must not kill the sortie
            print(f"[sim] step error: {e}")
        next_tick += period
        delay = next_tick - time.perf_counter()
        if delay < -period:                          # fell behind; resynchronise
            next_tick = time.perf_counter()
            delay = 0.0
        await asyncio.sleep(max(0.0, delay))


@app.on_event("startup")
async def on_startup():
    twin_runtime.warm_up(seconds=15.0, dt_s=SIM_DT_S)
    twin_runtime.recorder = FlightRecorder()
    print(f"[recorder] sortie {twin_runtime.recorder.session_id} recording to "
          f"{twin_runtime.recorder.session_dir}")
    asyncio.create_task(simulation_loop())


@app.on_event("shutdown")
async def on_shutdown():
    if twin_runtime.recorder is not None:
        summary = twin_runtime.recorder.close()
        print(f"[recorder] sortie {summary.session_id} closed: "
              f"{summary.frame_count} frames, {summary.duration_s:.1f}s")


# -------------------------------------------------------------
# REST API Endpoints
# -------------------------------------------------------------
class FaultInjectRequest(BaseModel):
    fault_type: str
    severity: float = 1.0
    ramp_duration_s: float = 8.0

class FlightOverrideRequest(BaseModel):
    enabled: bool = True
    throttle_pct: Optional[float] = None
    altitude_ft: Optional[float] = None
    ambient_temp_c: Optional[float] = None

class ReplayRequest(BaseModel):
    session_id: str
    speed: float = 1.0

@app.get("/")
async def get_dashboard_root():
    """Serves the primary Digital Twin Operator Dashboard."""
    index_file = DASHBOARD_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return HTMLResponse("<h1>ENGINE-TWIN Backend Running. Dashboard initializing...</h1>")

@app.get("/api/state")
async def get_current_state():
    frame = current_frame()
    if frame is not None:
        return frame
    return {"status": "initializing"}

@app.post("/api/fault/inject")
async def inject_fault_endpoint(req: FaultInjectRequest):
    try:
        f_enum = FaultType(req.fault_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown fault type: {req.fault_type}")

    cfg = FaultConfig(
        fault_type=f_enum,
        start_time_s=twin_runtime.sim_time_s,
        ramp_duration_s=req.ramp_duration_s,
        severity=req.severity
    )
    twin_runtime.injector.inject_fault(cfg)
    twin_runtime.active_fault_name = req.fault_type
    return {
        "status": "SUCCESS",
        "injected_fault": req.fault_type,
        "severity": req.severity,
        "start_time_s": twin_runtime.sim_time_s
    }

@app.post("/api/fault/clear")
async def clear_fault_endpoint():
    twin_runtime.injector.clear_faults()
    twin_runtime.active_fault_name = "HEALTHY"
    return {"status": "SUCCESS", "message": "Engine reset to healthy baseline."}

@app.post("/api/flight/override")
async def flight_override_endpoint(req: FlightOverrideRequest):
    """
    Manual flight sandbox: pin throttle, altitude and OAT instead of following
    the scripted mission. Used to demonstrate that a healthy engine stays at
    r = 0 across the whole envelope, which a fixed-threshold EIS cannot do.
    """
    was_manual = twin_runtime.manual_override
    twin_runtime.manual_override = bool(req.enabled)

    # Taking manual control picks up the aircraft where the mission left it,
    # rather than snapping to whatever the sliders happened to be showing.
    if twin_runtime.manual_override and not was_manual:
        state = twin_runtime.latest_state
        if state is not None:
            twin_runtime._slew_altitude = float(state.altitude_ft)
            twin_runtime._slew_throttle = float(state.throttle_pct)
            twin_runtime._slew_oat = float(state.ambient_temp_c)

    if req.throttle_pct is not None:
        twin_runtime.override_throttle = float(req.throttle_pct)
    if req.altitude_ft is not None:
        twin_runtime.override_altitude = float(req.altitude_ft)
    if req.ambient_temp_c is not None:
        twin_runtime.override_oat = float(req.ambient_temp_c)
    return {
        "status": "SUCCESS",
        "manual_override": twin_runtime.manual_override,
        "throttle_pct": twin_runtime.override_throttle,
        "altitude_ft": twin_runtime.override_altitude,
        "ambient_temp_c": twin_runtime.override_oat,
        "current_altitude_ft": round(twin_runtime._slew_altitude, 1),
        "note": "commanded values are slewed at flyable rates, not applied instantly",
    }

@app.post("/api/sim/reset")
async def reset_simulation_endpoint():
    twin_runtime.reset()
    twin_runtime.warm_up(seconds=15.0, dt_s=SIM_DT_S)
    return {"status": "SUCCESS", "message": "Simulation restarted."}

@app.post("/api/sim/speed")
async def set_simulation_speed(speed: float = 1.0):
    twin_runtime.time_scale = max(0.2, min(10.0, speed))
    return {"status": "SUCCESS", "time_scale": twin_runtime.time_scale}

# -------------------------------------------------------------
# Post-Flight Analysis & Mission Replay
# -------------------------------------------------------------
@app.get("/api/sessions")
async def list_recorded_sessions():
    """Lists recorded sorties, newest first."""
    return {"sessions": list_sessions(), "active": (
        twin_runtime.recorder.session_id if twin_runtime.recorder else None)}

@app.get("/api/sessions/{session_id}")
async def get_session_analysis(session_id: str):
    """Post-flight report for one sortie: banding, phases, and the fault timeline."""
    report = analyse_session(session_id)
    if not report.get("found"):
        raise HTTPException(status_code=404, detail=f"No such sortie: {session_id}")
    return report

@app.get("/api/sessions/{session_id}/frames")
async def get_session_frames(session_id: str, start: int = 0, limit: int = 500):
    """Raw recorded frames, paged, for offline plotting or export."""
    frames = load_frames(session_id)
    if not frames:
        raise HTTPException(status_code=404, detail=f"No such sortie: {session_id}")
    limit = max(1, min(5000, limit))
    start = max(0, start)
    return {
        "session_id": session_id,
        "total_frames": len(frames),
        "start": start,
        "frames": frames[start:start + limit],
    }

@app.post("/api/replay/start")
async def start_replay(req: ReplayRequest):
    try:
        n = replay.load(req.session_id, req.speed)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"status": "SUCCESS", "session_id": req.session_id, "frames": n}

@app.post("/api/replay/stop")
async def stop_replay():
    replay.stop()
    return {"status": "SUCCESS", "message": "Returned to live telemetry."}

@app.get("/api/replay/status")
async def replay_status():
    return replay.status()

# -------------------------------------------------------------
# Telemetry Streams (20 Hz Broadcast)
# -------------------------------------------------------------
@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Dashboard client connected to telemetry stream.")
    try:
        while True:
            frame = current_frame()
            if frame is not None:
                await websocket.send_text(json.dumps(frame))
            await asyncio.sleep(1.0 / BROADCAST_HZ)
    except WebSocketDisconnect:
        print("Dashboard client disconnected.")
    except Exception as e:
        print(f"WebSocket streaming error: {e}")

@app.get("/api/stream")
async def sse_telemetry_stream():
    """
    Server-Sent Events fallback, for browsers or proxies that block WebSockets.
    The dashboard falls back to this automatically, then to HTTP polling.
    """
    async def event_generator():
        while True:
            frame = current_frame()
            if frame is not None:
                yield f"data: {json.dumps(frame)}\n\n"
            await asyncio.sleep(1.0 / BROADCAST_HZ)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

if __name__ == "__main__":
    import uvicorn
    print("Starting ENGINE-TWIN Real-Time Server on http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
