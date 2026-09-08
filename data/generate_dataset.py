"""
Synthetic Dataset Generator for ENGINE-TWIN (SIH26054)
Generates multi-run flight datasets using the calibrated Mean Value Engine Model (MVEM)
and datasheet-grounded sensor model.

Outputs:
1. data/datasets/train_healthy.csv   (Unsupervised baseline training for Autoencoder & Sigma calibration)
2. data/datasets/train_faults.csv    (Supervised training for Fault Classifier & Severity head)
3. data/datasets/test_scenarios.csv  (Held-out runs for baseline comparison & ablation benchmarking)

Every sortie is an independent mission: the mission *shape* (cruise ceiling, loiter
band and altitude, throttle settings, and the fraction of the sortie spent in each
phase) is drawn per run, on top of an ISA temperature offset and a per-run
simulation seed. Training and held-out shapes come from separate RNG streams, and
the held-out ranges are deliberately wider than the training ranges, so the test
set probes generalisation rather than replaying the training mission under new noise.
"""
import os
import sys
from pathlib import Path
import math
import numpy as np
import pandas as pd
from typing import List, Dict, Any, Optional

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simulation.flight_profile import FlightProfile, FlightState
from simulation.mvem import MeanValueEngineModel, EngineState
from simulation.sensors import SensorModel, SensorReadings
from simulation.fault_injector import FaultInjector, FaultType, FaultConfig

OUTPUT_DIR = Path(__file__).resolve().parent / "datasets"


def sample_mission_shape(rng: np.random.Generator, wide: bool = False) -> Dict[str, float]:
    """
    Draws an independent MALE sortie shape.

    :param wide: use the broadened held-out ranges. Test sorties fly ceilings,
        loiter bands and phase splits outside anything in the training set.
    """
    if wide:
        ceiling = float(rng.uniform(22000.0, 32000.0))
        band = float(rng.uniform(400.0, 2200.0))
        cruise_thr = float(rng.uniform(58.0, 80.0))
        climb_thr = float(rng.uniform(86.0, 100.0))
        climb_f = float(rng.uniform(0.14, 0.30))
        loiter_f = float(rng.uniform(0.34, 0.58))
    else:
        ceiling = float(rng.uniform(24000.0, 30000.0))
        band = float(rng.uniform(600.0, 1600.0))
        cruise_thr = float(rng.uniform(62.0, 75.0))
        climb_thr = float(rng.uniform(90.0, 98.0))
        climb_f = float(rng.uniform(0.16, 0.26))
        loiter_f = float(rng.uniform(0.40, 0.56))

    return {
        "cruise_ceiling_ft": round(ceiling, 1),
        "loiter_alt_ft": round(ceiling - rng.uniform(500.0, 2000.0), 1),
        "loiter_band_ft": round(band, 1),
        "climb_throttle_pct": round(climb_thr, 2),
        "cruise_throttle_pct": round(cruise_thr, 2),
        "taxi_frac": 0.05,
        "climb_frac": round(climb_f, 4),
        "loiter_frac": round(loiter_f, 4),
        "descent_frac": round(float(rng.uniform(0.13, 0.20)), 4),
    }


def simulate_run(
    run_id: int,
    duration_s: float = 300.0,
    dt_s: float = 0.1,
    delta_t_isa: float = 0.0,
    fault_type: FaultType = FaultType.HEALTHY,
    fault_start_pct: float = 0.35,
    fault_ramp_s: float = 20.0,
    fault_severity: float = 1.0,
    seed: int = 42,
    profile_kwargs: Optional[Dict[str, float]] = None,
) -> pd.DataFrame:
    """
    Executes a single simulation sortie and returns a DataFrame of sensor readings + physics ground truth.
    """
    flight_gen = FlightProfile(delta_t_isa=delta_t_isa, **(profile_kwargs or {}))
    mvem = MeanValueEngineModel(seed=seed)
    sensors = SensorModel(seed=seed)
    injector = FaultInjector(mvem, sensors)

    fault_start_s = duration_s * fault_start_pct
    if fault_type != FaultType.HEALTHY:
        cfg = FaultConfig(
            fault_type=fault_type,
            start_time_s=fault_start_s,
            ramp_duration_s=fault_ramp_s,
            severity=fault_severity
        )
        injector.inject_fault(cfg)

    records = []
    num_steps = int(duration_s / dt_s)

    for step in range(num_steps):
        t = round(step * dt_s, 2)
        flight = flight_gen.get_standard_mission_state(t, total_mission_s=duration_s)
        injector.update(t)
        true_engine = mvem.step(flight, dt_s=dt_s)
        meas = sensors.sample(true_engine, flight, dt_s=dt_s)

        # Ground truth label and RUL calculation
        is_fault_active = (fault_type != FaultType.HEALTHY and t >= fault_start_s)
        label = fault_type.value if is_fault_active else "HEALTHY"

        # Synthetic remaining-life label: hours until the injected degradation would
        # reach its critical limit. Retained as provenance for the fault schedule.
        # The deployed RUL estimator is trajectory-based and does not train on it.
        if is_fault_active:
            time_since_onset = t - fault_start_s
            max_tolerable_time = fault_ramp_s * 1.5
            rul_seconds = max(0.0, max_tolerable_time - time_since_onset)
            rul_hours = rul_seconds / 3600.0 * 20.0 # Scale to realistic flight hours
        else:
            rul_hours = 500.0 # Healthy nominal time before overhaul

        row = {
            "run_id": run_id,
            "time_s": meas.time_s,
            "phase": flight.phase,
            "altitude_ft": meas.altitude_ft,
            "ambient_temp_c": meas.ambient_temp_c,
            "ambient_pressure_bar": meas.ambient_pressure_bar,
            "airspeed_mps": meas.airspeed_mps,
            "throttle_pct": meas.throttle_pct,
            # Measured Telemetry
            "rpm": meas.rpm,
            "manifold_pressure_bar": meas.manifold_pressure_bar,
            "fuel_flow_lph": meas.fuel_flow_lph,
            "oil_pressure_bar": meas.oil_pressure_bar,
            "oil_temp_c": meas.oil_temp_c,
            "coolant_temp_c": meas.coolant_temp_c,
            "egt_1_c": meas.egt_c[0],
            "egt_2_c": meas.egt_c[1],
            "egt_3_c": meas.egt_c[2],
            "egt_4_c": meas.egt_c[3],
            "cht_1_c": meas.cht_c[0],
            "cht_2_c": meas.cht_c[1],
            "cht_3_c": meas.cht_c[2],
            "cht_4_c": meas.cht_c[3],
            "vibration_rms_g": meas.vibration_rms_g,
            "vibration_x_g": meas.vibration_x_g,
            "vibration_y_g": meas.vibration_y_g,
            "vibration_z_g": meas.vibration_z_g,
            "bus_voltage_v": meas.bus_voltage_v,
            # True Physics States (for residual calculation and ground-truth validation)
            "true_power_hp": true_engine.power_hp,
            "true_torque_nm": true_engine.torque_nm,
            "true_bsfc_g_kwh": true_engine.bsfc_g_kwh,
            "true_oil_p_bar": true_engine.oil_pressure_bar,
            "true_oil_t_c": true_engine.oil_temp_c,
            "true_map_bar": true_engine.manifold_pressure_bar,
            "true_egt_3_c": true_engine.egt_c[2],
            "true_cht_2_c": true_engine.cht_c[1],
            # Supervision Labels
            "fault_label": label,
            "fault_severity": round(injector.current_severity, 3),
            "rul_hours": round(rul_hours, 2),
            "provenance": "SIMULATED"
        }
        records.append(row)

    return pd.DataFrame(records)


ALL_FAULTS = [
    FaultType.LEAN_MIXTURE_CYL3,
    FaultType.RICH_MIXTURE_CYL1,
    FaultType.COOLING_DEGRADATION_CYL2,
    FaultType.OIL_PRESSURE_LOSS,
    FaultType.TURBO_BOOST_DEFICIENCY,
    FaultType.CYLINDER_MISFIRE_TIMING,
    FaultType.BEARING_WEAR_VIBRATION,
    FaultType.SENSOR_FAULT_EGT3,
    FaultType.ELECTRICAL_VOLTAGE_SAG,
]

# Fixed seeds for the scenario draws (mission shapes, ISA offsets, fault onset,
# ramp and severity). These select *which* sorties get generated, so they are
# pinned separately from the per-run simulation seeds, and the training and
# held-out streams are seeded independently of each other.
TRAIN_SCENARIO_SEED = 20260906
TEST_SCENARIO_SEED = 20260907

# Sortie counts. Each entry is one fully independent mission.
N_HEALTHY_TRAIN_RUNS = 10
N_SORTIES_PER_FAULT_TRAIN = 4
N_SORTIES_PER_FAULT_TEST = 3
N_HEALTHY_TEST_RUNS = 5

TRAIN_DURATION_S = 180.0
TEST_DURATION_S = 150.0


def generate_all_datasets(output_dir: Optional[Path] = None, verbose: bool = True):
    """
    Builds all three splits. Training and held-out sorties are disjoint by run_id
    and are drawn from independent scenario RNG streams.

    :param output_dir: where to write the CSVs. Defaults to data/datasets/.
        Tests pass a temporary directory so that running the suite never
        overwrites the committed datasets the checkpoints were trained on.
    """
    out_dir = Path(output_dir) if output_dir is not None else OUTPUT_DIR
    train_rng = np.random.default_rng(TRAIN_SCENARIO_SEED)
    test_rng = np.random.default_rng(TEST_SCENARIO_SEED)
    out_dir.mkdir(parents=True, exist_ok=True)

    def log(msg: str):
        if verbose:
            print(msg)

    log("=" * 60)
    log("ENGINE-TWIN: Generating Calibrated Synthetic Datasets")
    log("=" * 60)

    # ---------------------------------------------------------------
    # 1. Healthy training sorties (autoencoder + sigma calibration)
    # ---------------------------------------------------------------
    log("[1/3] Generating Healthy Training Sorties...")
    healthy_dfs = []
    run_idx = 100
    for _ in range(N_HEALTHY_TRAIN_RUNS):
        df = simulate_run(
            run_id=run_idx,
            duration_s=TRAIN_DURATION_S,
            dt_s=0.1,
            delta_t_isa=float(train_rng.uniform(-18.0, 18.0)),
            fault_type=FaultType.HEALTHY,
            seed=run_idx,
            profile_kwargs=sample_mission_shape(train_rng),
        )
        healthy_dfs.append(df)
        run_idx += 1

    train_healthy_df = pd.concat(healthy_dfs, ignore_index=True)
    train_healthy_path = out_dir / "train_healthy.csv"
    train_healthy_df.to_csv(train_healthy_path, index=False)
    log(f"  -> {N_HEALTHY_TRAIN_RUNS} sorties / {len(train_healthy_df):,} samples -> {train_healthy_path.name}")

    # ---------------------------------------------------------------
    # 2. Labelled fault training sorties
    # ---------------------------------------------------------------
    log("[2/3] Generating Labelled Fault Training Sorties...")
    fault_dfs = []
    run_idx = 200
    for f_type in ALL_FAULTS:
        for _ in range(N_SORTIES_PER_FAULT_TRAIN):
            df = simulate_run(
                run_id=run_idx,
                duration_s=TRAIN_DURATION_S,
                dt_s=0.1,
                delta_t_isa=float(train_rng.uniform(-15.0, 15.0)),
                fault_type=f_type,
                fault_start_pct=float(train_rng.uniform(0.26, 0.40)),
                fault_ramp_s=float(train_rng.uniform(10.0, 22.0)),
                fault_severity=float(train_rng.uniform(0.70, 1.0)),
                seed=run_idx,
                profile_kwargs=sample_mission_shape(train_rng),
            )
            fault_dfs.append(df)
            run_idx += 1

    train_faults_df = pd.concat(fault_dfs, ignore_index=True)
    train_faults_path = out_dir / "train_faults.csv"
    train_faults_df.to_csv(train_faults_path, index=False)
    n_fault_runs = len(ALL_FAULTS) * N_SORTIES_PER_FAULT_TRAIN
    log(f"  -> {n_fault_runs} sorties / {len(train_faults_df):,} samples -> {train_faults_path.name}")

    # ---------------------------------------------------------------
    # 3. Held-out test sorties (wider mission-shape envelope)
    # ---------------------------------------------------------------
    log("[3/3] Generating Held-Out Test Sorties...")
    test_dfs = []
    run_idx = 500
    test_plan = ([FaultType.HEALTHY] * N_HEALTHY_TEST_RUNS
                 + [f for f in ALL_FAULTS for _ in range(N_SORTIES_PER_FAULT_TEST)])
    for f_type in test_plan:
        df = simulate_run(
            run_id=run_idx,
            duration_s=TEST_DURATION_S,
            dt_s=0.1,
            delta_t_isa=float(test_rng.uniform(-20.0, 20.0)),
            fault_type=f_type,
            fault_start_pct=float(test_rng.uniform(0.22, 0.45)),
            fault_ramp_s=float(test_rng.uniform(8.0, 26.0)),
            fault_severity=float(test_rng.uniform(0.65, 1.0)),
            seed=run_idx * 7 + 13,
            profile_kwargs=sample_mission_shape(test_rng, wide=True),
        )
        test_dfs.append(df)
        run_idx += 1

    test_df = pd.concat(test_dfs, ignore_index=True)
    test_path = out_dir / "test_scenarios.csv"
    test_df.to_csv(test_path, index=False)
    log(f"  -> {len(test_plan)} sorties / {len(test_df):,} samples -> {test_path.name}")

    log("=" * 60)
    log(f"Independent missions: {N_HEALTHY_TRAIN_RUNS + n_fault_runs} training / {len(test_plan)} held-out")
    log("All provenance labels set to 'SIMULATED'.")
    log("=" * 60)

    return train_healthy_df, train_faults_df, test_df


if __name__ == "__main__":
    generate_all_datasets()
