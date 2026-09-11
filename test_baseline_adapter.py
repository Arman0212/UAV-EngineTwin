"""
Baseline Adaptation Verification

Three properties, in the order they matter:

  1. On an engine the twin is wrong about, adaptation lowers the false-alarm
     rate once the estimate has converged. That is the entire reason the
     component exists.
  2. A fault arriving AFTER convergence is still caught, promptly. Adaptation
     must buy fewer false alarms without costing real detections.
  3. A fault arriving DURING the convergence window is not absorbed into the
     bias. This is the failure mode that would make the component dangerous:
     an adapter that learns a developing fault as normal annunciates nothing
     and reports itself healthy while doing it.

Everything runs against the shipped checkpoints on a deliberately mismatched
engine, built with simulation.mvem.sample_variant.
"""
import sys
from dataclasses import replace
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from digital_twin.baseline_adapter import BaselineAdapter
from digital_twin.health_index import HealthIndexEngine
from models.anomaly_autoencoder import AnomalyDetector
from models.fault_classifier import FaultDiagnosisEngine
from simulation.fault_injector import FaultConfig, FaultInjector, FaultType
from simulation.flight_profile import FlightProfile
from simulation.mvem import MeanValueEngineModel, sample_variant
from simulation.sensors import SensorModel

SAVED_MODELS_DIR = PROJECT_ROOT / "models" / "saved_models"

DT_S = 0.1
BUILD_SPREAD_PCT = 5.0      # the spread at which the sweep shows the twin hurting
# This draw puts a large standing offset on channels the classifier weights, so
# the unadapted twin false-alarms heavily on a perfectly healthy engine. Not
# every draw does: a mismatch small enough to keep the anomaly gate quiet may
# cause no false alarms at all, and one large enough to hold the gate open
# permanently stops the adapter from ever learning. Both are real behaviours of
# the gated design; this seed sits in the band where adaptation is the thing
# that matters.
VARIANT_SEED = 1234

# Detection must still land inside this many seconds of fault onset. The
# benchmark reports a 2.87 s mean detection latency and the mismatch sweep
# charges 30 s for a miss; this sits between the two, loose enough to be a
# per-sortie bound rather than a mean, tight enough that absorbing the fault
# into the bias would blow straight through it.
DOCUMENTED_LATENCY_S = 10.0


def _steady_flight(total_s: float):
    """
    A constant high-altitude loiter condition, which is the phase adaptation is
    permitted to run in. Taken from the real mission profile rather than
    invented, then held fixed so the only thing moving is the engine.
    """
    ref = FlightProfile().get_standard_mission_state(0.6 * total_s, total_mission_s=total_s)
    ref = replace(ref, phase="HIGH_ALT_LOITER")
    return lambda t: replace(ref, time_s=t, phase="HIGH_ALT_LOITER")


class _Stack:
    """The shipped inference stack, plus an adapter that can be switched off."""

    def __init__(self, adapt: bool):
        self.health = HealthIndexEngine()
        self.ae = AnomalyDetector(str(SAVED_MODELS_DIR / "anomaly_autoencoder.pt"))
        self.clf = FaultDiagnosisEngine(str(SAVED_MODELS_DIR / "fault_classifier.pt"))
        self.adapter = BaselineAdapter(enabled=adapt)

    def tick(self, sensor_dict, mvem_dict, phase: str) -> Tuple[str, bool, Dict[str, float]]:
        raw = self.health.compute_residuals(sensor_dict, mvem_dict)
        residuals = self.adapter.apply(raw)
        is_anom, _, _, _ = self.ae.detect(residuals)
        fault_class, _, _, _ = self.clf.diagnose(residuals)
        self.adapter.update(raw, DT_S, phase, is_anom, fault_class != "HEALTHY")
        return fault_class, is_anom, raw


def run_sortie(
    adapt: bool,
    duration_s: float,
    fault_type: Optional[FaultType] = None,
    fault_start_s: Optional[float] = None,
    spread_pct: float = BUILD_SPREAD_PCT,
) -> Dict[str, object]:
    """Simulates one steady loiter leg on a mismatched engine."""
    variant = sample_variant(np.random.default_rng(VARIANT_SEED), spread_pct)
    plant = MeanValueEngineModel(seed=11, variant=variant)
    baseline = MeanValueEngineModel(seed=11)          # datasheet: four identical cylinders
    sensors = SensorModel(seed=11)
    injector = FaultInjector(plant, sensors)
    stack = _Stack(adapt=adapt)
    flight_at = _steady_flight(duration_s)

    if fault_type is not None:
        injector.inject_fault(FaultConfig(
            fault_type=fault_type, start_time_s=fault_start_s,
            ramp_duration_s=12.0, severity=1.0))

    times, calls, converged, bias_trace, frozen = [], [], [], [], []
    n = int(duration_s / DT_S)
    for k in range(n):
        t = round(k * DT_S, 2)
        flight = flight_at(t)
        injector.update(t)
        truth = plant.step(flight, dt_s=DT_S)
        meas = sensors.sample(truth, flight, dt_s=DT_S)
        expected = baseline.step(flight, dt_s=DT_S)

        sensor_dict = {
            "rpm": meas.rpm, "manifold_pressure": meas.manifold_pressure_bar,
            "oil_pressure": meas.oil_pressure_bar, "oil_temp": meas.oil_temp_c,
            "fuel_flow": meas.fuel_flow_lph, "egt_c": meas.egt_c, "cht_c": meas.cht_c,
            "vibration_rms": meas.vibration_rms_g, "bus_voltage": meas.bus_voltage_v,
            "ambient_temp_c": meas.ambient_temp_c,
        }
        mvem_dict = {
            "rpm": expected.rpm, "manifold_pressure": expected.manifold_pressure_bar,
            "oil_pressure": expected.oil_pressure_bar, "oil_temp": expected.oil_temp_c,
            "fuel_flow": expected.fuel_flow_lph, "egt_c": expected.egt_c,
            "cht_c": expected.cht_c, "vibration_rms": expected.vibration_rms_g,
            "bus_voltage": expected.bus_voltage_v,
        }
        fault_class, _, _ = stack.tick(sensor_dict, mvem_dict, flight.phase)

        times.append(t)
        calls.append(fault_class)
        converged.append(stack.adapter.is_converged)
        bias_trace.append(dict(stack.adapter.bias))
        frozen.append(stack.adapter.frozen_reason)

    return {
        "times": np.array(times), "calls": calls,
        "converged": np.array(converged), "bias_trace": bias_trace,
        "frozen": frozen, "adapter": stack.adapter,
    }


def _far(run, mask) -> float:
    calls = np.array(run["calls"])
    sel = calls[mask]
    return float((sel != "HEALTHY").sum()) / max(1, len(sel)) * 100.0


def _first_detection_s(run, onset_s: float) -> Optional[float]:
    for t, call in zip(run["times"], run["calls"]):
        if t >= onset_s and call != "HEALTHY":
            return float(t - onset_s)
    return None


def test_false_alarms_fall_after_convergence():
    print("\n[TEST 1] Mismatched healthy engine: false alarms before vs after adaptation")
    dur = 240.0
    on = run_sortie(adapt=True, duration_s=dur)
    off = run_sortie(adapt=False, duration_s=dur)

    conv_at = float(on["times"][np.argmax(on["converged"])]) if on["converged"].any() else None
    assert conv_at is not None, "adapter never converged in a steady loiter leg"
    post = on["times"] >= conv_at

    far_on_post = _far(on, post)
    far_off_post = _far(off, post)
    far_on_pre = _far(on, on["times"] < conv_at)

    print(f"  converged at t = {conv_at:.1f}s "
          f"(tau={on['adapter'].time_constant_s:.0f}s, envelope=+/-{on['adapter'].max_bias_sigma} sigma)")
    print(f"  false alarms after convergence : adaptation ON  {far_on_post:6.2f}%")
    print(f"                                   adaptation OFF {far_off_post:6.2f}%")
    print(f"  false alarms before convergence: adaptation ON  {far_on_pre:6.2f}%")
    print(f"  learned bias (max |b|)         : {on['adapter'].max_abs_bias:.3f} sigma")

    assert far_on_post < far_off_post, (
        f"adaptation did not reduce false alarms on a mismatched engine "
        f"({far_on_post:.2f}% with, {far_off_post:.2f}% without)")
    print(f"  -> PASSED: adaptation cut the false-alarm rate by "
          f"{far_off_post - far_on_post:.2f} pp after convergence")


def test_fault_after_convergence_still_detected():
    print("\n[TEST 2] Fault injected AFTER convergence is still caught promptly")
    dur, onset = 300.0, 200.0
    run = run_sortie(adapt=True, duration_s=dur,
                     fault_type=FaultType.OIL_PRESSURE_LOSS, fault_start_s=onset)
    assert run["converged"][int(onset / DT_S)], "adapter had not converged before fault onset"

    latency = _first_detection_s(run, onset)
    print(f"  fault onset t = {onset:.0f}s, converged before onset: yes")
    print(f"  first non-healthy call: {latency if latency is None else f'{latency:.2f}s'} "
          f"after onset (bound {DOCUMENTED_LATENCY_S:.0f}s)")
    print(f"  bias at end (max |b|): {run['adapter'].max_abs_bias:.3f} sigma")

    assert latency is not None, "fault after convergence was never detected"
    assert latency <= DOCUMENTED_LATENCY_S, (
        f"detection took {latency:.2f}s, beyond the documented {DOCUMENTED_LATENCY_S:.0f}s bound")
    print(f"  -> PASSED: detected {latency:.2f}s after onset, inside the bound")


def test_fault_during_convergence_not_absorbed():
    print("\n[TEST 3] Fault injected DURING the convergence window is not learned as normal")
    dur, onset = 240.0, 12.0     # onset well inside the convergence window
    run = run_sortie(adapt=True, duration_s=dur,
                     fault_type=FaultType.OIL_PRESSURE_LOSS, fault_start_s=onset)
    healthy = run_sortie(adapt=True, duration_s=dur)

    oil_bias = abs(run["adapter"].bias["oil_pressure"])
    oil_bias_healthy = abs(healthy["adapter"].bias["oil_pressure"])
    envelope = run["adapter"].max_bias_sigma
    # Absorption would show up as the fault run learning a materially larger
    # oil_pressure bias than the same engine learns with no fault present.
    # Comparing the two runs is the robust form of the check: an absolute bound
    # would be confounded by whatever build offset this engine legitimately has.
    absorbed = oil_bias - oil_bias_healthy
    ABSORPTION_TOL_SIGMA = 0.25

    post_onset = run["times"] >= onset
    frozen_after = [f for f, m in zip(run["frozen"], post_onset) if m and f]
    frozen_frac = len(frozen_after) / max(1, int(post_onset.sum())) * 100.0

    latency = _first_detection_s(run, onset)
    print(f"  fault onset t = {onset:.0f}s (adapter converged: "
          f"{'no' if not run['converged'][int(onset / DT_S)] else 'yes'})")
    print(f"  adaptation frozen on {frozen_frac:.1f}% of post-onset frames")
    print(f"  oil_pressure bias: {oil_bias:.3f} sigma (same engine, no fault: "
          f"{oil_bias_healthy:.3f}; envelope +/-{envelope})")
    print(f"  absorbed by the fault: {absorbed:+.3f} sigma "
          f"(tolerance {ABSORPTION_TOL_SIGMA})")
    print(f"  fault still annunciated: {latency is not None} "
          f"({'n/a' if latency is None else f'{latency:.2f}s after onset'})")

    assert latency is not None, "fault during convergence was never annunciated"
    assert absorbed <= ABSORPTION_TOL_SIGMA, (
        f"oil_pressure bias grew {absorbed:+.3f} sigma when the fault was present "
        f"({oil_bias:.3f} vs {oil_bias_healthy:.3f} without) -- the fault is being "
        "absorbed into the baseline estimate")
    assert oil_bias <= envelope, (
        f"oil_pressure bias {oil_bias:.3f} exceeded its own {envelope} sigma envelope")
    assert frozen_frac > 50.0, (
        f"adaptation ran on {100 - frozen_frac:.1f}% of post-onset frames; the gate "
        "is not holding the estimate still through a developing fault")
    print(f"  -> PASSED: gate held the estimate still and the fault was annunciated "
          f"{latency:.2f}s after onset")


if __name__ == "__main__":
    print("=" * 74)
    print("ENGINE-TWIN: Baseline Adaptation Verification")
    print("=" * 74)
    test_false_alarms_fall_after_convergence()
    test_fault_after_convergence_still_detected()
    test_fault_during_convergence_not_absorbed()
    print("\n" + "=" * 74)
    print("ALL BASELINE ADAPTATION TESTS PASSED")
    print("=" * 74)
