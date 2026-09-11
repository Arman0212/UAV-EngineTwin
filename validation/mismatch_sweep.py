"""
Model-Mismatch Degradation Sweep

Every other evaluation in this repository gives the twin perfect knowledge of the
engine it is shadowing: the plant MVEM and the baseline MVEM are the same model
with the same constants. In service that is never true. A real unit leaves the
factory off datasheet — a slightly tighter turbo, a little more friction — and
the twin has no way to know by how much.

This sweep measures what that costs. For each build spread it regenerates the
held-out sortie set with the deviation applied to the *plant* engine only, leaves
the twin's baseline at datasheet, and re-scores. The twin is never told.

Systems compared, both frozen at datasheet knowledge before the sweep begins:
  1. ENGINE-TWIN  -- the shipped checkpoint, on physics residuals
  2. Raw telemetry -- the black-box baseline from validation/ablation.py,
                      identical network, trained with the identical recipe
  3. Residual control -- the same recipe as (2) but on residuals, so the
                      residual-vs-raw comparison cannot be confounded by the
                      shipped checkpoint having had a different training schedule

Nothing here writes to data/datasets/. Each spread level is generated into a
temporary directory and discarded.
"""
import json
import sys
import tempfile
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import accuracy_score, f1_score

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from data.generate_dataset import generate_heldout_split
from digital_twin.health_index import HealthIndexEngine
from models.fault_classifier import FaultDiagnosisEngine, CLASS_TO_IDX
from simulation.mvem import MeanValueEngineModel, VARIANT_KEYS
from train_and_export_models import extract_residuals_from_df
from validation.ablation import RAW_CHANNELS, _train_classifier, _score

DATASETS_DIR = PROJECT_ROOT / "data" / "datasets"
SAVED_MODELS_DIR = PROJECT_ROOT / "models" / "saved_models"
RESULTS_PATH = PROJECT_ROOT / "docs" / "figures" / "mismatch_sweep.json"

# Build spread levels, as percentage standard deviation on each variant
# multiplier. 0.0 is the perfect-knowledge case every other suite measures;
# 10.0 is a deliberately punishing unit that no acceptance test would pass.
SPREAD_LEVELS = [0.0, 2.0, 5.0, 10.0]

# Seconds charged against a fault sortie the system never detects at all. Same
# convention as validation/benchmark.py, so latencies are comparable.
MISS_PENALTY_S = 30.0

# Regression floor. ENGINE-TWIN measures 0.8975 macro F1 at 5% build spread on
# the reference run recorded in README.md (against 0.9771 with perfect knowledge
# -- the mismatch costs it most of its margin over raw telemetry). The bound sits
# a clear margin below the measured value: low enough to survive retraining and
# platform float noise, high enough that a further collapse in mismatch tolerance
# fails the suite loudly rather than silently.
MIN_MACRO_F1_AT_5PCT = 0.85
ASSERTED_SPREAD_PCT = 5.0


def _healthy_sortie_mask(df: pd.DataFrame) -> np.ndarray:
    """
    Frames belonging to sorties that are healthy end to end.

    Deliberately stricter than the healthy-*frame* mask used in ablation.py: a
    pre-onset frame of a fault sortie is labelled HEALTHY but the degradation may
    already be ramping, so counting it as a false-alarm opportunity flatters the
    system. A false alarm here means the system called a fault on a sortie where
    nothing ever went wrong.
    """
    per_run = df.groupby("run_id")["fault_label"].apply(lambda s: (s == "HEALTHY").all())
    healthy_runs = set(per_run[per_run].index)
    return df["run_id"].isin(healthy_runs).to_numpy()


def _mean_detection_latency(df: pd.DataFrame, preds: np.ndarray) -> float:
    """
    Mean seconds from fault onset to the first correct call, over fault sorties.
    Same definition as validation/benchmark.py, including the miss penalty.
    """
    latencies: List[float] = []
    for _, grp in df.groupby("run_id"):
        label = grp["fault_label"].iloc[-1]
        if label == "HEALTHY":
            continue
        active = grp[grp["fault_label"] != "HEALTHY"]
        if len(active) == 0:
            continue
        onset_s = active["time_s"].iloc[0]
        run_preds = preds[grp.index.to_numpy()]
        hit = (run_preds == CLASS_TO_IDX[label])
        if hit.any():
            detect_s = grp["time_s"].iloc[int(np.argmax(hit))]
            latencies.append(max(0.0, float(detect_s) - float(onset_s)))
        else:
            latencies.append(MISS_PENALTY_S)
    return float(np.mean(latencies)) if latencies else 0.0


def _metrics(df: pd.DataFrame, y_true: np.ndarray, preds: np.ndarray,
             healthy_sorties: np.ndarray) -> Dict[str, float]:
    n_healthy = int(healthy_sorties.sum())
    far = float((preds[healthy_sorties] != CLASS_TO_IDX["HEALTHY"]).sum()) / max(1, n_healthy) * 100.0
    return {
        "accuracy": accuracy_score(y_true, preds) * 100.0,
        "macro_f1": float(f1_score(y_true, preds, average="macro")),
        "false_alarm_pct": far,
        "latency_s": _mean_detection_latency(df, preds),
    }


def run_mismatch_sweep(spread_levels: List[float] = None) -> Dict[str, object]:
    spread_levels = list(spread_levels if spread_levels is not None else SPREAD_LEVELS)

    print("=" * 86)
    print("ENGINE-TWIN: Model-Mismatch Degradation Sweep")
    print("=" * 86)
    print("The twin's baseline stays at datasheet. The engine does not. Nothing is quoted;")
    print("every figure below is computed in this run.")

    health_engine = HealthIndexEngine()

    # -----------------------------------------------------------------
    # Train the comparison arms once, on the committed datasheet training
    # split. Both stay frozen for the whole sweep: the deployed system does
    # not get to retrain when it meets an engine it was not built for.
    # -----------------------------------------------------------------
    print("\nTraining comparison arms on the datasheet training split (frozen thereafter)...")
    train_df = (pd.read_csv(DATASETS_DIR / "train_faults.csv")
                .sort_values("run_id", kind="stable").reset_index(drop=True))
    X_train_res, y_train, _ = extract_residuals_from_df(
        train_df, MeanValueEngineModel(), health_engine)
    assert len(X_train_res) == len(train_df), "residual/raw row misalignment on train split"
    X_train_raw = train_df[RAW_CHANNELS].to_numpy(dtype=np.float32)

    shipped = FaultDiagnosisEngine(str(SAVED_MODELS_DIR / "fault_classifier.pt"))
    assert shipped.is_trained, "shipped fault_classifier.pt failed to load"
    net_raw, norm_raw = _train_classifier(X_train_raw, y_train)
    net_res, norm_res = _train_classifier(X_train_res, y_train)
    print(f"  shipped checkpoint loaded; raw and residual control arms trained "
          f"on {len(X_train_res):,} frames")

    rows = []
    for spread in spread_levels:
        print(f"\n[spread {spread:>4.1f}%] regenerating held-out sorties...")
        with tempfile.TemporaryDirectory(prefix="enginetwin_mismatch_") as tmp:
            # Written to a scratch directory purely so the CSV (with its
            # variant_* provenance columns) exists for inspection if a run is
            # being debugged. data/datasets/ is never touched.
            test_df = generate_heldout_split(
                variant_spread_pct=spread, output_dir=Path(tmp))
        test_df = test_df.sort_values("run_id", kind="stable").reset_index(drop=True)

        X_res, y_true, _ = extract_residuals_from_df(
            test_df, MeanValueEngineModel(), health_engine)
        assert len(X_res) == len(test_df), "residual/raw row misalignment on test split"
        X_raw = test_df[RAW_CHANNELS].to_numpy(dtype=np.float32)
        healthy_sorties = _healthy_sortie_mask(test_df)

        # Actual spread realised by the draw, averaged over sorties. Reported so
        # the x-axis is the measured deviation rather than only the requested one.
        per_run_variant = test_df.groupby("run_id")[list(VARIANT_KEYS)].first()
        realised_pct = float(np.abs(per_run_variant.to_numpy() - 1.0).mean() * 100.0)

        with torch.no_grad():
            logits, _ = shipped.model(torch.tensor(X_res, dtype=torch.float32))
            preds_twin = logits.argmax(dim=1).numpy()

        def _preds(net, norm, X):
            Xn = (X - norm["mu"]) / norm["sd"]
            with torch.no_grad():
                lg, _ = net(torch.tensor(Xn, dtype=torch.float32))
            return lg.argmax(dim=1).numpy()

        m_twin = _metrics(test_df, y_true, preds_twin, healthy_sorties)
        m_raw = _metrics(test_df, y_true, _preds(net_raw, norm_raw, X_raw), healthy_sorties)
        m_ctl = _metrics(test_df, y_true, _preds(net_res, norm_res, X_res), healthy_sorties)

        rows.append({
            "spread_pct": spread,
            "realised_mean_abs_dev_pct": realised_pct,
            "n_frames": int(len(test_df)),
            "n_healthy_sortie_frames": int(healthy_sorties.sum()),
            "engine_twin": m_twin,
            "raw_telemetry": m_raw,
            "residual_control": m_ctl,
        })
        print(f"  {len(test_df):,} frames | mean |deviation| {realised_pct:.2f}% | "
              f"twin F1 {m_twin['macro_f1']:.4f}  raw F1 {m_raw['macro_f1']:.4f}")

    _print_table(rows)
    verdict = _print_verdict(rows)

    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"rows": rows, "verdict": verdict,
               "miss_penalty_s": MISS_PENALTY_S,
               "min_macro_f1_at_5pct": MIN_MACRO_F1_AT_5PCT}
    RESULTS_PATH.write_text(json.dumps(payload, indent=2))
    print(f"\nResults written to {RESULTS_PATH.relative_to(PROJECT_ROOT)} "
          f"(consumed by tools/export_evaluation_plots.py)")

    # -----------------------------------------------------------------
    # Regression floor
    # -----------------------------------------------------------------
    at_5 = next((r for r in rows if r["spread_pct"] == ASSERTED_SPREAD_PCT), None)
    if at_5 is not None:
        f1_5 = at_5["engine_twin"]["macro_f1"]
        assert f1_5 >= MIN_MACRO_F1_AT_5PCT, (
            f"ENGINE-TWIN macro F1 at {ASSERTED_SPREAD_PCT}% build spread fell to "
            f"{f1_5:.4f}, below the documented floor of {MIN_MACRO_F1_AT_5PCT:.4f}. "
            "The system has become brittle to model mismatch."
        )
        print(f"[PASS] ENGINE-TWIN macro F1 at {ASSERTED_SPREAD_PCT}% spread is "
              f"{f1_5:.4f} >= floor {MIN_MACRO_F1_AT_5PCT:.4f}")
    print("=" * 86)
    return payload


def _print_table(rows: List[Dict]) -> None:
    print("\n" + "=" * 86)
    print("DEGRADATION AGAINST MODEL MISMATCH (computed this run)")
    print("=" * 86)
    print("False alarms are counted on sorties that are healthy end to end.")
    print(f"Latency is mean seconds to first correct call, {MISS_PENALTY_S:.0f} s charged for a miss.\n")
    for key, title in (("engine_twin", "ENGINE-TWIN (physics residuals, shipped checkpoint)"),
                       ("raw_telemetry", "Raw telemetry (identical network, identical recipe)"),
                       ("residual_control", "Residual control (identical recipe to the raw arm)")):
        print(f"{title}")
        print(f"  {'Spread':>7} | {'Accuracy':>9} | {'Macro F1':>9} | {'False alarm':>12} | {'Latency':>9}")
        print("  " + "-" * 62)
        for r in rows:
            m = r[key]
            print(f"  {r['spread_pct']:>6.1f}% | {m['accuracy']:>8.2f}% | {m['macro_f1']:>9.4f} | "
                  f"{m['false_alarm_pct']:>11.2f}% | {m['latency_s']:>8.2f}s")
        print()


def _print_verdict(rows: List[Dict]) -> Dict[str, object]:
    """
    States the comparison in the direction the measurements actually point,
    rather than the direction the architecture would prefer.
    """
    base, worst = rows[0], rows[-1]
    d_twin = base["engine_twin"]["macro_f1"] - worst["engine_twin"]["macro_f1"]
    d_raw = base["raw_telemetry"]["macro_f1"] - worst["raw_telemetry"]["macro_f1"]
    d_ctl = base["residual_control"]["macro_f1"] - worst["residual_control"]["macro_f1"]
    far_twin = worst["engine_twin"]["false_alarm_pct"] - base["engine_twin"]["false_alarm_pct"]
    far_raw = worst["raw_telemetry"]["false_alarm_pct"] - base["raw_telemetry"]["false_alarm_pct"]

    print("=" * 86)
    print("VERDICT")
    print("=" * 86)
    print(f"From 0% to {worst['spread_pct']:.0f}% build spread:")
    print(f"  ENGINE-TWIN        loses {d_twin:.4f} macro F1 and gains {far_twin:+.2f} pp false alarms")
    print(f"  Raw telemetry      loses {d_raw:.4f} macro F1 and gains {far_raw:+.2f} pp false alarms")
    print(f"  Residual control   loses {d_ctl:.4f} macro F1  (same recipe as the raw arm)")

    graceful = d_ctl < d_raw
    if graceful:
        print("\n  -> Like for like, the residual representation degrades MORE gracefully than")
        print("     raw telemetry under model mismatch. The physics baseline subtracts the part")
        print("     of the signal the variant shifts, so the classifier sees less of the drift.")
    else:
        print("\n  -> Like for like, the residual representation does NOT degrade more gracefully")
        print("     than raw telemetry under model mismatch. The residual is computed against a")
        print("     baseline that is itself wrong about this engine, so the mismatch enters the")
        print("     feature the classifier depends on. This is a real limitation, not noise.")
    return {
        "twin_f1_drop": d_twin,
        "raw_f1_drop": d_raw,
        "residual_control_f1_drop": d_ctl,
        "twin_far_rise_pp": far_twin,
        "raw_far_rise_pp": far_raw,
        "residual_degrades_more_gracefully": bool(graceful),
        "max_spread_pct": worst["spread_pct"],
    }


if __name__ == "__main__":
    run_mismatch_sweep()
