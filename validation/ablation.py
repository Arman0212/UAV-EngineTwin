"""
Architectural Ablation Study (SIH26054)

Measures what each architectural choice is actually worth by removing it and
re-scoring on the held-out sorties. Every number this file prints is computed
here, from the committed checkpoints and the held-out split, on the machine it
runs on. Nothing is quoted from a previous run.

Ablations:
  A. Physics-residual anchoring   -> retrain the same classifier on raw telemetry
  B. Two-stage autoencoder gating -> cost of running the classifier every tick
  C. Sensor-vs-engine decoupling  -> probe defects with the validator removed
  D. Training data volume         -> 25% / 50% / 100% of the fault sorties

The comparison is like-for-like: ablation A trains an identical network with an
identical schedule on raw channels instead of residuals, so the only thing that
differs is the representation.
"""
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import accuracy_score, f1_score

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulation.mvem import MeanValueEngineModel
from digital_twin.health_index import HealthIndexEngine
from models.anomaly_autoencoder import AnomalyDetector, RESIDUAL_CHANNELS
from models.fault_classifier import (
    FaultClassifierNet, FaultDiagnosisEngine, FAULT_CLASSES, CLASS_TO_IDX,
)
from models.sensor_validator import SensorValidator
from train_and_export_models import extract_residuals_from_df

DATASETS_DIR = PROJECT_ROOT / "data" / "datasets"
SAVED_MODELS_DIR = PROJECT_ROOT / "models" / "saved_models"

# Raw telemetry channels, in the same order and count as RESIDUAL_CHANNELS, so
# the ablated network has identical capacity and only the inputs change.
RAW_CHANNELS = [
    "rpm", "manifold_pressure_bar", "fuel_flow_lph", "oil_pressure_bar", "oil_temp_c",
    "cht_1_c", "cht_2_c", "cht_3_c", "cht_4_c",
    "egt_1_c", "egt_2_c", "egt_3_c", "egt_4_c",
    "vibration_rms_g", "bus_voltage_v",
]

TRAIN_EPOCHS = 30
BATCH_SIZE = 256
SEED = 20260908


def _train_classifier(
    X: np.ndarray,
    y: np.ndarray,
    epochs: int = TRAIN_EPOCHS,
    seed: int = SEED,
) -> Tuple[FaultClassifierNet, Dict[str, float]]:
    """
    Trains the production classifier architecture on whatever representation it
    is handed. Inputs are standardised using training-split statistics only,
    which are returned so the same transform can be applied at evaluation.
    """
    torch.manual_seed(seed)
    np.random.seed(seed)

    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd < 1e-6] = 1.0
    Xn = (X - mu) / sd

    net = FaultClassifierNet(input_dim=X.shape[1], num_classes=len(FAULT_CLASSES))
    opt = torch.optim.Adam(net.parameters(), lr=1.5e-3)
    loss_fn = nn.CrossEntropyLoss()

    Xt = torch.tensor(Xn, dtype=torch.float32)
    yt = torch.tensor(y, dtype=torch.long)
    n = len(Xt)

    net.train()
    for _ in range(epochs):
        perm = torch.randperm(n)
        for i in range(0, n, BATCH_SIZE):
            idx = perm[i:i + BATCH_SIZE]
            if len(idx) < 2:            # BatchNorm needs at least 2 samples
                continue
            opt.zero_grad()
            logits, _ = net(Xt[idx])
            loss = loss_fn(logits, yt[idx])
            loss.backward()
            opt.step()

    net.eval()
    return net, {"mu": mu, "sd": sd}


def _score(net: FaultClassifierNet, norm: Dict[str, np.ndarray], X: np.ndarray, y: np.ndarray,
           healthy_mask: np.ndarray) -> Dict[str, float]:
    Xn = (X - norm["mu"]) / norm["sd"]
    with torch.no_grad():
        logits, _ = net(torch.tensor(Xn, dtype=torch.float32))
        preds = logits.argmax(dim=1).numpy()
    far = (preds[healthy_mask] != 0).sum() / max(1, healthy_mask.sum()) * 100.0
    return {
        "accuracy": accuracy_score(y, preds) * 100.0,
        "macro_f1": f1_score(y, preds, average="macro"),
        "false_alarm_pct": far,
    }


def run_ablation_study():
    print("=" * 78)
    print("ENGINE-TWIN: Architectural Ablation Study")
    print("=" * 78)
    print("All figures below are computed in this run. Nothing is quoted.")

    # The residual extractor walks df.groupby("run_id"), so the rows come back in
    # run_id order. Sorting the frames the same way first means row i of the raw
    # matrix and row i of the residual matrix are the same instant of the same
    # sortie, which is what makes this a like-for-like comparison rather than two
    # models scored on differently ordered data.
    train_df = (pd.read_csv(DATASETS_DIR / "train_faults.csv")
                .sort_values("run_id", kind="stable").reset_index(drop=True))
    test_df = (pd.read_csv(DATASETS_DIR / "test_scenarios.csv")
               .sort_values("run_id", kind="stable").reset_index(drop=True))
    mvem = MeanValueEngineModel()
    health_engine = HealthIndexEngine()

    print("\nBuilding physics residuals for both splits...")
    X_train_res, y_train, _ = extract_residuals_from_df(train_df, mvem, health_engine)
    X_test_res, y_test, _ = extract_residuals_from_df(test_df, mvem, health_engine)

    assert len(X_train_res) == len(train_df), "residual/raw row misalignment on train split"
    assert len(X_test_res) == len(test_df), "residual/raw row misalignment on test split"

    X_train_raw = train_df[RAW_CHANNELS].values.astype(np.float32)
    X_test_raw = test_df[RAW_CHANNELS].values.astype(np.float32)
    healthy_mask = (y_test == 0)

    print(f"  train: {len(X_train_res):,} frames / {train_df['run_id'].nunique()} sorties")
    print(f"  test:  {len(X_test_res):,} frames / {test_df['run_id'].nunique()} sorties")

    # -----------------------------------------------------------------
    # Ablation A: physics residuals vs raw telemetry
    # -----------------------------------------------------------------
    print("\n[A] Physics-residual anchoring vs raw telemetry (identical network)...")
    net_res, norm_res = _train_classifier(X_train_res, y_train)
    res_scores = _score(net_res, norm_res, X_test_res, y_test, healthy_mask)
    print(f"    residual inputs : acc {res_scores['accuracy']:.2f}%  "
          f"F1 {res_scores['macro_f1']:.4f}  FAR {res_scores['false_alarm_pct']:.2f}%")

    net_raw, norm_raw = _train_classifier(X_train_raw, y_train)
    raw_scores = _score(net_raw, norm_raw, X_test_raw, y_test, healthy_mask)
    print(f"    raw telemetry   : acc {raw_scores['accuracy']:.2f}%  "
          f"F1 {raw_scores['macro_f1']:.4f}  FAR {raw_scores['false_alarm_pct']:.2f}%")

    # High-altitude slice: where the two representations should diverge most,
    # because raw channels carry the derating and residuals do not.
    alt_col = test_df["altitude_ft"].values
    high_alt = alt_col > 20000.0
    ha_healthy = healthy_mask & high_alt
    if ha_healthy.sum() > 0:
        ha_res = _score(net_res, norm_res, X_test_res[high_alt], y_test[high_alt],
                        healthy_mask[high_alt])
        ha_raw = _score(net_raw, norm_raw, X_test_raw[high_alt], y_test[high_alt],
                        healthy_mask[high_alt])
        print(f"    above 20,000 ft ({ha_healthy.sum():,} healthy frames):")
        print(f"      residual FAR {ha_res['false_alarm_pct']:.2f}%   "
              f"raw FAR {ha_raw['false_alarm_pct']:.2f}%")

    # -----------------------------------------------------------------
    # Ablation B: two-stage gating vs continuous inference
    # -----------------------------------------------------------------
    print("\n[B] Two-stage autoencoder gating vs classifying every tick...")
    ae = AnomalyDetector(str(SAVED_MODELS_DIR / "anomaly_autoencoder.pt"))
    clf = FaultDiagnosisEngine(str(SAVED_MODELS_DIR / "fault_classifier.pt"))

    sample_n = min(4000, len(X_test_res))
    sample = X_test_res[:sample_n]
    dicts = [{RESIDUAL_CHANNELS[k]: float(v[k]) for k in range(len(RESIDUAL_CHANNELS))}
             for v in sample]

    t0 = time.perf_counter()
    gate_hits = 0
    for d in dicts:
        is_anom, _, _, _ = ae.detect(d)
        if is_anom:
            gate_hits += 1
    t_ae = (time.perf_counter() - t0) / sample_n * 1000.0

    t0 = time.perf_counter()
    for d in dicts:
        clf.diagnose(d)
    t_clf = (time.perf_counter() - t0) / sample_n * 1000.0

    gate_rate = gate_hits / sample_n
    cost_gated = t_ae + gate_rate * t_clf
    cost_always = t_ae + t_clf
    saving = (1.0 - cost_gated / cost_always) * 100.0
    print(f"    autoencoder trigger : {t_ae:.3f} ms/frame")
    print(f"    full classifier     : {t_clf:.3f} ms/frame")
    print(f"    gate fires on {gate_rate*100:.1f}% of held-out frames")
    print(f"    gated {cost_gated:.3f} ms vs continuous {cost_always:.3f} ms "
          f"-> {saving:.1f}% CPU saved")

    # -----------------------------------------------------------------
    # Ablation C: sensor-vs-engine decoupling
    # -----------------------------------------------------------------
    print("\n[C] Sensor-vs-engine decoupling layer...")
    validator = SensorValidator()
    probe_rows = test_df[test_df["fault_label"] == "SENSOR_FAULT_EGT3"]
    caught = 0
    for _, row in probe_rows.iterrows():
        sensor_dict = {
            "egt_c": [row["egt_1_c"], row["egt_2_c"], row["egt_3_c"], row["egt_4_c"]],
            "cht_c": [row["cht_1_c"], row["cht_2_c"], row["cht_3_c"], row["cht_4_c"]],
            "oil_pressure_bar": row["oil_pressure_bar"],
            "oil_temp_c": row["oil_temp_c"],
            "vibration_rms_g": row["vibration_rms_g"],
            "ambient_temp_c": row["ambient_temp_c"],
        }
        result = validator.validate(sensor_dict, {}, {})
        if result.is_sensor_fault:
            caught += 1
    decoupled_pct = caught / max(1, len(probe_rows)) * 100.0

    # Without the validator, a probe defect reaches the classifier as an engine
    # fault; count how often the network alone would call it a mechanical failure.
    probe_mask = (y_test == CLASS_TO_IDX["SENSOR_FAULT_EGT3"])
    if probe_mask.sum() > 0:
        Xn = (X_test_res[probe_mask] - norm_res["mu"]) / norm_res["sd"]
        with torch.no_grad():
            logits, _ = net_res(torch.tensor(Xn, dtype=torch.float32))
            preds = logits.argmax(dim=1).numpy()
        misread = (preds != CLASS_TO_IDX["SENSOR_FAULT_EGT3"]).sum() / probe_mask.sum() * 100.0
    else:
        misread = float("nan")
    print(f"    probe-defect frames in held-out set : {len(probe_rows):,}")
    print(f"    with validator, isolated as sensor  : {decoupled_pct:.1f}%")
    print(f"    without validator, misread by net   : {misread:.1f}%")

    # -----------------------------------------------------------------
    # Ablation D: training data volume
    # -----------------------------------------------------------------
    print("\n[D] Sample efficiency (fraction of training sorties)...")
    rng = np.random.default_rng(SEED)
    run_ids = train_df["run_id"].unique()
    # Subsample by sortie, not by row: dropping rows would leave every sortie
    # partially represented and overstate how little data is needed.
    row_runs = train_df["run_id"].values
    volume_rows = []
    for frac in (0.25, 0.50, 1.00):
        keep_n = max(2, int(round(len(run_ids) * frac)))
        keep = set(rng.choice(run_ids, size=keep_n, replace=False)) if frac < 1.0 else set(run_ids)
        mask = np.isin(row_runs, list(keep))
        net_f, norm_f = _train_classifier(X_train_res[mask], y_train[mask])
        s = _score(net_f, norm_f, X_test_res, y_test, healthy_mask)
        volume_rows.append((frac, keep_n, mask.sum(), s))
        print(f"    {int(frac*100):3d}% of sorties ({keep_n} sorties / {mask.sum():,} frames): "
              f"acc {s['accuracy']:.2f}%  F1 {s['macro_f1']:.4f}")

    # -----------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------
    print("\n" + "=" * 78)
    print("ABLATION SUMMARY (computed this run)")
    print("=" * 78)
    print(f"{'Configuration':<42} | {'Macro F1':>9} | {'False Alarm':>12} | {'Accuracy':>9}")
    print("-" * 78)
    print(f"{'Full ENGINE-TWIN (physics residuals)':<42} | {res_scores['macro_f1']:>9.4f} | "
          f"{res_scores['false_alarm_pct']:>11.2f}% | {res_scores['accuracy']:>8.2f}%")
    print(f"{'A: raw telemetry, no physics baseline':<42} | {raw_scores['macro_f1']:>9.4f} | "
          f"{raw_scores['false_alarm_pct']:>11.2f}% | {raw_scores['accuracy']:>8.2f}%")
    for frac, n_runs, n_rows, s in volume_rows[:-1]:
        label = f"D: residuals, {int(frac*100)}% of training sorties"
        print(f"{label:<42} | {s['macro_f1']:>9.4f} | "
              f"{s['false_alarm_pct']:>11.2f}% | {s['accuracy']:>8.2f}%")
    print("-" * 78)
    delta_f1 = res_scores["macro_f1"] - raw_scores["macro_f1"]
    delta_far = raw_scores["false_alarm_pct"] - res_scores["false_alarm_pct"]
    print(f"Physics anchoring is worth {delta_f1:+.4f} macro F1 and "
          f"{delta_far:+.2f} pp of false-alarm rate.")
    print(f"Two-stage gating saves {saving:.1f}% of inference CPU.")
    print(f"Sensor validator isolates {decoupled_pct:.1f}% of probe defects; the trained "
          f"classifier alone misreads {misread:.1f}% of them.")
    if misread < 1.0:
        print("  -> On this taxonomy the classifier already separates probe defects, so the")
        print("     validator buys no accuracy here. Its value is that it is a physics rule")
        print("     rather than a learned boundary: it holds for probe failures the network")
        print("     was never trained on, and it fires before inference rather than after.")
    print("=" * 78)


if __name__ == "__main__":
    run_ablation_study()
