<div align="center">

# ENGINE-TWIN

### AI-Enabled Real-Time Digital Twin for Aero Piston Engines in MALE UAVs

*Physics-anchored residual learning · Explainable prognostics · Sub-3-second fault detection*

[![Python](https://img.shields.io/badge/Python-3.10%20%7C%203.11-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![PyTorch](https://img.shields.io/badge/PyTorch-2.0%2B-EE4C2C?logo=pytorch&logoColor=white)](https://pytorch.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100%2B-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Status](https://img.shields.io/badge/status-prototype-orange)]()
[![Problem Statement](https://img.shields.io/badge/SIH26054-DRDO-navy)]()

**Smart India Hackathon 2026** · Problem Statement **SIH26054** · Theme: *Robotics and Drones* · Category: *Software*
Proposing Organisation: **DRDO** (Defence Research and Development Organisation)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Key Capabilities](#key-capabilities)
- [System Architecture](#system-architecture)
- [Repository Layout](#repository-layout)
- [Quick Start](#quick-start)
- [Usage](#usage)
  - [Operator Dashboard](#operator-dashboard)
  - [REST & WebSocket API](#rest--websocket-api)
  - [Regenerating Datasets](#regenerating-datasets)
  - [Retraining Models](#retraining-models)
- [Technical Design](#technical-design)
  - [1. Physics Core — Mean Value Engine Model](#1-physics-core--mean-value-engine-model)
  - [2. Sensor Model](#2-sensor-model)
  - [3. State Estimation — 12-State EKF](#3-state-estimation--12-state-ekf)
  - [4. Physics Residuals](#4-physics-residuals)
  - [5. Five-Layer Twin State](#5-five-layer-twin-state)
  - [6. AI Diagnostic Stack](#6-ai-diagnostic-stack)
  - [7. Health Index](#7-health-index)
  - [8. Explainability](#8-explainability)
- [Fault Taxonomy](#fault-taxonomy)
- [Datasets](#datasets)
- [Benchmark Results](#benchmark-results)
- [Validation & Testing](#validation--testing)
- [Multi-Engine Configuration](#multi-engine-configuration)
- [Performance Envelope](#performance-envelope)
- [Live Demonstration Script](#live-demonstration-script)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Acknowledgements](#acknowledgements)

---

## Overview

Medium-Altitude Long-Endurance (MALE) UAVs powered by aero piston engines operate for 20+ hour sorties across a 0–30,000 ft envelope. Conventional engine-instrument systems (EIS) monitor these engines with **fixed redline thresholds**, which fail in two directions at altitude: they raise false alarms when normal derating pushes parameters toward limits, and they miss genuine incipient faults whose absolute values remain inside the redlines.

**ENGINE-TWIN** replaces threshold logic with a physics-anchored digital twin. A calibrated Mean Value Engine Model runs synchronously with the engine and predicts what a *healthy* engine should be doing under the current altitude, throttle, and atmospheric state. Machine learning then operates exclusively on the **normalized deviation** between measurement and physics expectation — making diagnosis invariant to flight condition, and reducing the learning problem from "recognise an engine" to "recognise a departure from physics."

The system detects, classifies, localises, and explains nine aero-piston failure modes, distinguishes **sensor faults from engine faults**, and projects Remaining Useful Life as a calibrated confidence interval rather than a false-precision point estimate.

> **Note on scope.** This is a research and demonstration prototype. The engine, sensors, and faults are simulated by the included physics model — no flight hardware or airworthiness certification is involved. All reported metrics are reproducible from this repository via the validation suites in [`validation/`](validation/).

---

## Key Capabilities

| # | Capability | Implementation |
|:--|:--|:--|
| 1 | **Physics-anchored residual learning** — diagnosis invariant to altitude derating and throttle transients | [`simulation/mvem.py`](simulation/mvem.py) + normalized residual vector |
| 2 | **12-state Extended Kalman Filter** fusing telemetry with non-linear thermodynamics; tolerates packet loss | [`digital_twin/ekf_estimator.py`](digital_twin/ekf_estimator.py) |
| 3 | **Two-stage diagnosis** — unsupervised anomaly trigger gates a supervised multi-task classifier | [`models/anomaly_autoencoder.py`](models/anomaly_autoencoder.py), [`models/fault_classifier.py`](models/fault_classifier.py) |
| 4 | **Sensor-vs-engine decoupling** — prevents probe defects from triggering false mission aborts | [`models/sensor_validator.py`](models/sensor_validator.py) |
| 5 | **Uncertainty-bounded RUL** — 95% prediction intervals, e.g. *18–25 flight hours* | [`models/rul_estimator.py`](models/rul_estimator.py) |
| 6 | **Real-time SHAP attribution** formatted into operator decision cards | [`xai/shap_explainer.py`](xai/shap_explainer.py), [`xai/alert_generator.py`](xai/alert_generator.py) |
| 7 | **Subsystem health indices** — continuous 0–100% scores per subsystem | [`digital_twin/health_index.py`](digital_twin/health_index.py) |
| 8 | **20 Hz ground-station dashboard** with 3D engine view and live fault injection | [`dashboard/`](dashboard/) |

---

## System Architecture

```
                      [MALE UAV Aero Piston Engine]
                                   │
                                   ▼
                    [Datasheet-Grounded Sensor Model]
             (EGT 1-4, CHT 1-4, Oil P/T, MAP, RPM, Vib, Bus V)
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ENGINE-TWIN PIPELINE                              │
│                                                                             │
│   ┌───────────────────────────┐         ┌───────────────────────────────┐   │
│   │   Physics MVEM Baseline   │◄───────►│    Extended Kalman Filter     │   │
│   │   Calibrated to VRDE 2.2L │         │    12-State Physics Fusion    │   │
│   └─────────────┬─────────────┘         └───────────────┬───────────────┘   │
│                 │                                       │                   │
│                 └───────────────────┬───────────────────┘                   │
│                                     ▼                                       │
│                       Normalized Physics Residuals                          │
│                   r = (y_sensor - y_mvem) / sigma_channel                   │
│                                     │                                       │
│          ┌──────────────────────────┴──────────────────────────┐            │
│          ▼                                                     ▼            │
│   [Stage 1: Anomaly Trigger]                          [Health Index Engine] │
│   Unsupervised Autoencoder                             Subsystem Health     │
│   e_recon > mean + 3.0*sigma                           0 to 100% Scores     │
│          │                                                     │            │
│          ▼ (fires only if anomalous)                           │            │
│   [Sensor vs. Engine Validator]                                │            │
│   Cross-channel thermodynamic consistency                      │            │
│          │                                                     │            │
│          ▼                                                     │            │
│   [Stage 2: Multi-Task Classifier]                             │            │
│   10-class fault head + continuous severity head               │            │
│          │                                                     │            │
│          ├──────────────────────────┬──────────────────────────┤            │
│          ▼                          ▼                          ▼            │
│   [RUL Prognostics]          [Fast SHAP XAI]         [5-Layer Twin State]   │
│   Degradation trajectory +   Local attribution       Physical / Sensor /    │
│   95% confidence bounds      root-cause breakdown    Estimated / Virtual /  │
│                                                      AI-Health              │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ WebSocket stream (20 Hz)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      OPERATOR GROUND STATION DASHBOARD                      │
│   • Interactive 3D engine twin with per-cylinder thermal heatmap            │
│   • Live telemetry vs. MVEM baseline vs. residual bounds                    │
│   • Subsystem health matrix (overall, cylinders, oil, turbo, vibration)     │
│   • SHAP root-cause evidence drawer & action directives                     │
│   • One-click fault-injection control pad                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data flow per 50 ms tick:** flight profile → MVEM integration → fault injection → sensor sampling → EKF predict/update → residual computation → health index → autoencoder trigger → (if fired) sensor validator → classifier → SHAP → RUL → alert → WebSocket broadcast.

---

## Repository Layout

```
DRDO-UAV-EngineTwin/
├── main.py                          # Universal launcher (FastAPI, falls back to stdlib server)
├── engine_service.py                # FastAPI + WebSocket runtime, 20 Hz simulation loop
├── standalone_server.py             # Zero-dependency fallback server (stdlib only)
├── train_and_export_models.py       # Full training, calibration & export pipeline
├── run_all_tests.py                 # Master test runner (all suites, consolidated report)
├── requirements.txt
├── run_demo.bat                     # Windows one-click launcher
│
├── configs/
│   ├── engine_config.json           # DRDO/VRDE 2.2L turbocharged aero-diesel (default)
│   └── rotax_914_config.json        # Rotax 914 UL — transfer-learning target
│
├── simulation/
│   ├── mvem.py                      # Mean Value Engine Model — physics ground truth
│   ├── sensors.py                   # Datasheet sensor model (noise, lag, quantization, rate)
│   ├── fault_injector.py            # Parametric fault injection (9 modes)
│   └── flight_profile.py            # MALE mission profiles + ISA atmosphere
│
├── digital_twin/
│   ├── ekf_estimator.py             # 12-state Extended Kalman Filter
│   ├── health_index.py              # Physics-anchored subsystem health scoring
│   └── twin_state.py                # 5-layer twin state representation
│
├── models/
│   ├── anomaly_autoencoder.py       # Stage 1: unsupervised residual autoencoder
│   ├── fault_classifier.py          # Stage 2: multi-task classifier + severity head
│   ├── rul_estimator.py             # Physics-informed RUL with prediction intervals
│   ├── sensor_validator.py          # Sensor-vs-engine fault discriminator
│   └── saved_models/                # Exported PyTorch checkpoints (.pt)
│
├── xai/
│   ├── shap_explainer.py            # Fast local SHAP attribution
│   └── alert_generator.py           # Evidence-carrying operator alert formatting
│
├── validation/
│   ├── benchmark.py                 # Method A / B / C comparative benchmark
│   ├── ablation.py                  # Component ablation studies
│   ├── leakage_audit.py             # Train/test separation & leakage integrity audit
│   └── stress_testing.py            # Adversarial noise, blackout & envelope stress
│
├── data/
│   ├── generate_dataset.py          # Synthetic multi-run dataset generator
│   └── datasets/                    # train_healthy / train_faults / test_scenarios
│
├── dashboard/
│   ├── index.html                   # Operator ground station
│   ├── app.js                       # Telemetry client, charts, control pad
│   └── engine_view3d.js             # 3D engine twin with thermal heatmap
│
├── tools/                           # Profiling, plotting, transfer & demo utilities
├── docs/                            # Submission dossier, pitch deck, figures
└── ENGINE_TWIN_MASTER_PIPELINE.ipynb # End-to-end reproducible notebook
```

---

## Quick Start

### Prerequisites

- Python **3.10** or **3.11**
- ~500 MB disk space (datasets and dependencies)
- A modern browser (WebGL required for the 3D engine view)

### Installation

```bash
git clone https://github.com/Arman0212/DRDO-UAV-EngineTwin-.git
cd DRDO-UAV-EngineTwin-

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

### Launch

```bash
python main.py
```

Then open **http://127.0.0.1:8000** (the launcher opens it automatically).

On Windows you can instead double-click **`run_demo.bat`**.

> **Zero-install fallback.** If FastAPI/Uvicorn are unavailable, `main.py` automatically falls back to [`standalone_server.py`](standalone_server.py), which runs the full twin using only the Python standard library. NumPy and PyTorch are still required for the physics and AI layers.

### Verify the Installation

```bash
python run_all_tests.py
```

This runs the physics tests, AI-layer tests, comparative benchmark, and ablation studies, and prints a consolidated report.

---

## Usage

### Operator Dashboard

The dashboard streams at 20 Hz over WebSocket and provides:

| Panel | Contents |
|:--|:--|
| **3D Engine Twin** | Per-cylinder thermal heatmap; components turn amber/red as subsystem health degrades |
| **Telemetry Strips** | Measured sensor value vs. MVEM physics baseline vs. ±3σ residual envelope |
| **Health Matrix** | Overall, per-cylinder, oil, turbo, vibration, electrical, and cooling health (0–100%) |
| **Diagnosis Card** | Active fault class, calibrated confidence, severity, and RUL interval |
| **SHAP Drawer** | Ranked feature attributions driving the current diagnosis |
| **Control Pad** | One-click injection of any of the nine fault modes; reset; time-scale control |

### REST & WebSocket API

Served by [`engine_service.py`](engine_service.py) on `127.0.0.1:8000`.

| Method | Endpoint | Description |
|:--|:--|:--|
| `GET` | `/` | Serves the operator dashboard |
| `GET` | `/api/state` | Current full twin state snapshot (JSON) |
| `POST` | `/api/fault/inject` | Inject a parametric fault |
| `POST` | `/api/fault/clear` | Clear all faults, return to healthy baseline |
| `POST` | `/api/sim/reset` | Restart the simulation from t=0 |
| `POST` | `/api/sim/speed` | Set time scale (clamped to 0.2×–10×) |
| `WS` | `/ws/telemetry` | 20 Hz broadcast of the full twin state |

**Inject a fault:**

```bash
curl -X POST http://127.0.0.1:8000/api/fault/inject \
  -H "Content-Type: application/json" \
  -d '{
        "fault_type": "OIL_PRESSURE_LOSS",
        "severity": 1.0,
        "ramp_duration_s": 8.0
      }'
```

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `fault_type` | `string` | *required* | One of the [fault classes](#fault-taxonomy). Unknown values return HTTP 400. |
| `severity` | `float` | `1.0` | Fault severity multiplier, 0.0–1.0 |
| `ramp_duration_s` | `float` | `8.0` | Seconds over which the fault evolves; `0` gives an abrupt step |

**Consume the telemetry stream:**

```python
import asyncio, json, websockets

async def listen():
    async with websockets.connect("ws://127.0.0.1:8000/ws/telemetry") as ws:
        while True:
            s = json.loads(await ws.recv())
            ai = s["ai_prognostics"]
            print(f'{s["timestamp_s"]:8.2f}s  '
                  f'alt={s["altitude_ft"]:6.0f}ft  '
                  f'health={s["health"]["overall_health"]:5.1f}%  '
                  f'{ai["fault_class"]} ({ai["fault_confidence_pct"]:.1f}%)  '
                  f'RUL={ai["rul_hours_min"]:.0f}-{ai["rul_hours_max"]:.0f}h')

asyncio.run(listen())
```

**Payload shape** (abridged — see [`digital_twin/twin_state.py`](digital_twin/twin_state.py) for the full schema):

```jsonc
{
  "timestamp_s": 412.35,
  "altitude_ft": 28000.0, "ambient_temp_c": -41.2,
  "throttle_pct": 62.0, "mission_phase": "LOITER",

  "sensor_rpm": 3812.0, "sensor_map_bar": 1.94,
  "sensor_egt_c": [751.2, 748.9, 802.4, 750.1],
  "sensor_cht_c": [176.1, 174.8, 179.2, 175.4],

  "mvem_expected_rpm": 3810.0, "mvem_expected_map_bar": 1.95,
  "mvem_expected_egt_c": [750.0, 750.0, 750.0, 750.0],

  "estimated_rpm": 3811.4, "estimated_egt_c": [750.8, 749.4, 801.1, 750.3],

  "residuals": { "rpm": 0.25, "egt_cyl_3": 14.97, "oil_pressure": -0.11 },

  "health": {
    "overall_health": 72.4, "cylinder_health": [98.1, 97.6, 41.2, 98.0],
    "oil_system_health": 99.2, "turbo_boost_health": 98.8,
    "vibration_health": 97.1, "electrical_health": 100.0,
    "cooling_system_health": 96.3, "status_level": "CAUTION"
  },

  "ai_prognostics": {
    "anomaly_detected": true, "anomaly_score": 0.87, "anomaly_threshold": 1.0,
    "fault_class": "LEAN_MIXTURE_CYL3", "fault_confidence_pct": 94.6,
    "fault_severity": 0.58, "is_sensor_fault": false,
    "rul_hours_mean": 21.5, "rul_hours_min": 18.0, "rul_hours_max": 25.0,
    "top_contributing_channels": [{ "channel": "egt_cyl_3", "attribution": 0.68 }],
    "recommended_action": "Inspect cylinder 3 injector within 18-25 flight hours."
  },

  "active_fault": "LEAN_MIXTURE_CYL3",
  "active_alert": { }
}
```

### Regenerating Datasets

```bash
python data/generate_dataset.py
```

Rebuilds all three CSVs in `data/datasets/` from the calibrated MVEM and sensor model. Runs are partitioned by `run_id` so that train and test sets share no flight.

### Retraining Models

```bash
python train_and_export_models.py
```

This trains the autoencoder on healthy residuals only, calibrates the *k*·σ anomaly threshold, trains the multi-task classifier with temperature scaling, evaluates precision/recall/F1, detection latency, and false-alarm rate on the held-out test scenarios, and exports checkpoints to `models/saved_models/`.

---

## Technical Design

### 1. Physics Core — Mean Value Engine Model

[`simulation/mvem.py`](simulation/mvem.py) integrates a lumped-parameter engine model calibrated to a DRDO/VRDE-class 2.2 L four-cylinder turbocharged aero-diesel:

- **Intake manifold & turbocharger aerodynamics** — manifold filling dynamics `dp_m/dt`, altitude boost derating
- **Crankshaft torque balance** — rotational dynamics `J·dω/dt`
- **Multi-cylinder lumped thermal dynamics** — four independent CHT and EGT states
- **Lubrication circuit** — oil pressure and sump temperature dynamics

The model consumes altitude, ambient temperature, ambient pressure, airspeed, and throttle from the [ISA atmosphere and mission profile generator](simulation/flight_profile.py), and emits the healthy-engine expectation **y**<sub>mvem</sub> at every tick.

### 2. Sensor Model

[`simulation/sensors.py`](simulation/sensors.py) converts physics truth into realistic instrumentation, per-channel, from the datasheet specifications in [`configs/engine_config.json`](configs/engine_config.json):

| Property | Modelled as |
|:--|:--|
| Measurement noise | Gaussian, per-channel σ |
| Thermal/mechanical lag | First-order lag, per-channel τ |
| Quantization | ADC resolution step |
| Sample rate | Per-channel Hz (2–50 Hz), zero-order hold between samples |

For example, EGT probes use σ = 3.5 °C, τ = 2.0 s, 0.5 °C quantization at 5 Hz, while RPM uses σ = 8 rpm, τ = 0.05 s at 50 Hz.

### 3. State Estimation — 12-State EKF

[`digital_twin/ekf_estimator.py`](digital_twin/ekf_estimator.py) maintains the state vector

```
x = [RPM, MAP, Oil_P, Oil_T, CHT₁, CHT₂, CHT₃, CHT₄, EGT₁, EGT₂, EGT₃, EGT₄]   (dim = 12)
```

The **predict** step propagates the state through the non-linear MVEM dynamics; the **update** step fuses the sensor measurement `z` with Kalman gain `K = P·Hᵀ(H·P·Hᵀ + R)⁻¹`. This smooths measurement noise and carries the estimate through intermittent datalink dropouts, so a lost packet degrades confidence rather than producing a spurious residual spike.

### 4. Physics Residuals

The core representation handed to every downstream model:

```
r = (y_sensor − y_mvem) ⊘ σ_channel
```

Fifteen channels form the residual vector:

```
rpm, manifold_pressure, fuel_flow, oil_pressure, oil_temp,
cht_cyl_1..4, egt_cyl_1..4, vibration_rms, bus_voltage
```

Because the MVEM baseline already accounts for altitude, throttle, and ambient conditions, a healthy engine produces `r ≈ 0` **everywhere in the flight envelope**. This is what makes the classifier robust across a 0–30,000 ft envelope where raw-telemetry models fail — see the false-alarm column in the [benchmark](#benchmark-results).

### 5. Five-Layer Twin State

[`digital_twin/twin_state.py`](digital_twin/twin_state.py) represents the engine simultaneously at five levels of abstraction:

| Layer | Meaning |
|:--|:--|
| **Physical** | MVEM ground truth (what the engine is actually doing) |
| **Sensor** | Raw instrumented measurement, with noise and lag |
| **Estimated** | EKF-fused, noise-filtered estimate |
| **Virtual** | Healthy-baseline expectation used for residual computation |
| **AI-Health** | Diagnosis, severity, health indices, RUL, and explanation |

> This five-layer *architecture* is distinct from the twelve-dimensional *EKF state vector*; the two are sometimes conflated in shorthand.

### 6. AI Diagnostic Stack

**Stage 1 — Anomaly trigger** ([`models/anomaly_autoencoder.py`](models/anomaly_autoencoder.py))

A symmetric bottleneck autoencoder (15 → 32 → 16 → **6** → 16 → 32 → 15, BatchNorm + LeakyReLU) trained *exclusively on healthy residual sequences*. It fires when reconstruction error exceeds `mean + 3.0·σ` of the healthy calibration distribution. Because it never sees fault data, it generalises to failure modes absent from the training taxonomy.

**Sensor validator** ([`models/sensor_validator.py`](models/sensor_validator.py))

Runs *before* fault classification whenever the trigger fires. Cross-channel thermodynamic consistency and physical redundancy checks establish whether an anomalous channel is physically plausible given its neighbours. An open EGT3 thermocouple reading ambient while CHT3 and fuel flow remain nominal is reported as a **probe defect with the engine healthy** — not as a cylinder fault, and not as a reason to abort a mission.

**Stage 2 — Multi-task classifier** ([`models/fault_classifier.py`](models/fault_classifier.py))

A shared backbone (15 → 64 → 32, BatchNorm + LeakyReLU + Dropout 0.15) feeding two heads:

- **Classification head** → 10-class fault logits, divided by a learned temperature parameter for calibrated confidence
- **Severity head** → continuous 0.0–1.0 degradation severity (sigmoid)

Temperature scaling matters operationally: an uncalibrated network reporting 99% confidence on a marginal case invites misplaced trust from the operator.

**Prognostics** ([`models/rul_estimator.py`](models/rul_estimator.py))

Classifies the degradation regime as `STABLE`, `DRIFTING`, or `ABRUPT` over a 50-sample history window, then projects the health trajectory to the critical threshold (30%). Output is a **95% prediction interval** in flight hours, e.g. *18–25 h*, rather than a point estimate.

### 7. Health Index

[`digital_twin/health_index.py`](digital_twin/health_index.py) maps residuals to bounded, interpretable scores:

```
Health_subsystem = 100 · exp(−α · |(y_meas − y_mvem) / σ|)
```

Computed for seven subsystems: overall engine, each of the four cylinders, the oil circuit, the turbocharger, the vibration signature, the electrical bus, and the cooling system. The exponential form gives graceful degradation near nominal and sharp response as residuals grow.

### 8. Explainability

[`xai/shap_explainer.py`](xai/shap_explainer.py) computes local SHAP attributions over the 15-channel residual vector, and [`xai/alert_generator.py`](xai/alert_generator.py) formats diagnosis, physics evidence, RUL interval, and sensor integrity into a standardized decision-support alert with an explicit pilot directive (e.g. *Return To Base*, *inspect within 18–25 flight hours*, *no action — probe defect*).

The design intent is that no diagnosis reaches the operator without its evidence attached.

---

## Fault Taxonomy

Nine failure modes, parametrically injectable at any severity and ramp rate via [`simulation/fault_injector.py`](simulation/fault_injector.py):

| Class | Physical Mechanism | Primary Signature |
|:--|:--|:--|
| `HEALTHY` | Nominal operation | `r ≈ 0` across all channels |
| `LEAN_MIXTURE_CYL3` | Injector partial clogging, cylinder 3 | EGT₃ rises; thermal gradient shifts |
| `RICH_MIXTURE_CYL1` | Leaking injector, cylinder 1 | EGT₁ drops; fuel flow rises |
| `COOLING_DEGRADATION_CYL2` | Baffle / cooling airflow blockage, cylinder 2 | CHT₂ rises rapidly |
| `OIL_PRESSURE_LOSS` | Pump pressure-relief valve leak | Oil pressure falls below 2.0 bar |
| `TURBO_BOOST_DEFICIENCY` | Wastegate stuck open / compressor fouling | MAP deficit, worsening with altitude |
| `CYLINDER_MISFIRE_TIMING` | Timing jitter / valve seating defect | RPM instability; 0.5× vibration order |
| `BEARING_WEAR_VIBRATION` | Crankshaft / rod bearing wear | Progressive 2× vibration amplification |
| `SENSOR_FAULT_EGT3` | Thermocouple open circuit | EGT₃ reads ambient while engine is healthy |
| `ELECTRICAL_VOLTAGE_SAG` | Alternator diode fault | Bus voltage sags under avionics load |

`SENSOR_FAULT_EGT3` is deliberately included in the taxonomy so the system is *trained* to distinguish instrumentation failure from engine failure, rather than inferring it heuristically.

---

## Datasets

Generated by [`data/generate_dataset.py`](data/generate_dataset.py) from the calibrated MVEM. 30 columns per row spanning flight state, all sensor channels, and physics ground truth (`true_power_hp`, `true_torque_nm`, `true_bsfc_g_kwh`).

| File | Rows | Purpose |
|:--|--:|:--|
| [`train_healthy.csv`](data/datasets/train_healthy.csv) | 12,000 | Unsupervised autoencoder training + σ calibration |
| [`train_faults.csv`](data/datasets/train_faults.csv) | 43,200 | Supervised classifier & severity training |
| [`test_scenarios.csv`](data/datasets/test_scenarios.csv) | 22,000 | Held-out evaluation, benchmarking, ablation |

**Integrity.** Splits are partitioned at the `run_id` (whole-flight) level, never by row. [`validation/leakage_audit.py`](validation/leakage_audit.py) verifies zero `run_id` overlap, zero adjacent-time-slice contamination, zero preprocessing-stage future snooping, and class-balance representation across splits.

---

## Benchmark Results

Evaluated on **22,000 held-out test frames** spanning takeoff, climb to 30,000 ft, high-altitude loiter, and descent. Reproduce with `python validation/benchmark.py`.

| Metric | A: Fixed-Threshold EIS | B: Black-Box ML (raw telemetry) | **C: ENGINE-TWIN** |
|:--|:---:|:---:|:---:|
| Fault classification accuracy | 59.49 % | 83.68 % | **93.47 %** |
| Macro F1-score | 0.2842 | 0.8778 | **0.9414** |
| Mean detection latency | 25.51 s | 5.96 s | **2.30 s** |
| False-alarm rate on healthy sorties | 0.00 % | 27.65 % | **2.18 %** |
| CPU inference latency | 0.083 ms | 0.004 ms | **1.023 ms** |
| Sensor vs. engine decoupling | ✗ false abort | ✗ confounded | **✓ correctly decoupled** |
| Root-cause explainability | ✗ none | ~ feature importance only | **✓ SHAP operator cards** |
| RUL uncertainty bounds | ✗ none | ✗ none | **✓ 95% intervals** |

**Reading the table.** Method A's 0.00% false-alarm rate is not a strength — its thresholds are set so wide that it also misses most real faults, which is why its macro F1 is 0.28. Method B shows the opposite failure: strong in-distribution accuracy, but a 27.65% false-alarm rate because raw telemetry at 30,000 ft looks anomalous to a model that has no physics baseline for altitude derating. ENGINE-TWIN's residual representation is what collapses that error.

The 1.023 ms inference cost is the price of the physics + EKF + two-stage + SHAP pipeline, against a 150 ms real-time budget — roughly 150× headroom on commodity CPU, with no GPU required.

### MVEM Altitude Derating Fit

Verification against published DRDO/VRDE 2.2 L derating data:

| Altitude (ft) | Published power | Simulated power | Published MAP | Simulated MAP |
|:---:|:---:|:---:|:---:|:---:|
| 0 (sea level) | 200.0 HP | **200.0 HP** | 2.40 bar | 2.45 bar |
| 10,000 | 200.0 HP | **200.0 HP** | 2.45 bar | 2.45 bar |
| 20,000 | 150.0 HP | **150.0 HP** | 2.10 bar | 2.10 bar |
| 30,000 | 110.0 HP | **110.0 HP** | 1.65 bar | 1.65 bar |

Power fit RMSE **0.00 HP** · MAP fit RMSE **0.025 bar**

---

## Validation & Testing

| Suite | Command | Coverage |
|:--|:--|:--|
| Physics & simulation | `python test_simulation.py` | MVEM integration, sensor noise/lag/quantization, flight profiles |
| AI layer | `python test_ai_layer.py` | EKF convergence, autoencoder threshold, classifier, RUL, SHAP |
| Fault pipeline QA | `python test_fault_pipeline_qa.py` | End-to-end detection across all nine fault modes |
| Comparative benchmark | `python validation/benchmark.py` | Method A / B / C evaluation |
| Ablation studies | `python validation/ablation.py` | Contribution of residuals, two-stage gating, decoupling, data volume |
| Leakage audit | `python validation/leakage_audit.py` | Train/test separation and temporal integrity |
| Adversarial stress | `python validation/stress_testing.py` | +500% sensor noise, 10–30 s blackouts, 35,000 ft / −60 °C |
| **All of the above** | `python run_all_tests.py` | Consolidated report |

The ablation suite is the one to run if you want to know *which* architectural claim is load-bearing: it isolates physics-anchored residuals vs. raw telemetry, two-stage gating vs. continuous inference, decoupling on/off, and sample efficiency at 25% / 50% / 100% of training data.

---

## Multi-Engine Configuration

The twin is not hard-coded to one engine. [`configs/`](configs/) holds datasheet-grounded parameter sets:

| Config | Engine | Displacement | Rated Power | Rated RPM | Ceiling Modelled |
|:--|:--|:--:|:--:|:--:|:--:|
| [`engine_config.json`](configs/engine_config.json) | DRDO/VRDE 2.2 L turbo aero-diesel | 2.2 L | 200 HP | 4,200 | 30,000 ft |
| [`rotax_914_config.json`](configs/rotax_914_config.json) | Rotax 914 UL turbo flat-four | 1.211 L | 115 HP | 5,800 | 20,000 ft |

Each config specifies geometry, altitude derating curve, nominal operating parameters, and full per-channel sensor specifications. Transfer to a new engine is a configuration and recalibration task, not a rewrite — [`tools/test_multi_engine_transfer.py`](tools/test_multi_engine_transfer.py) exercises this path.

---

## Performance Envelope

| Property | Value |
|:--|:--|
| Simulation & broadcast rate | 20 Hz (50 ms tick) |
| End-to-end inference latency | ~1.02 ms CPU |
| Real-time budget | 150 ms (≈150× headroom) |
| SHAP attribution | < 1 ms |
| GPU required | No |
| Altitude envelope modelled | 0 – 30,000 ft (stress-tested to 35,000 ft) |
| Residual channels | 15 |
| EKF state dimension | 12 |
| Fault classes | 10 (including `HEALTHY`) |

Profile on your own hardware with [`tools/edge_benchmark_profiler.py`](tools/edge_benchmark_profiler.py).

---

## Live Demonstration Script

A 2–3 minute walkthrough exercising each differentiator:

1. **Nominal state.** Launch `python main.py`. The dashboard shows a healthy 3D engine, 100% subsystem health, and normal telemetry at 28,000 ft loiter.

2. **Inject oil pressure loss.** Click `Oil Pressure Loss`. Within ~2.3 s the anomaly trigger fires, the classifier returns `OIL_PRESSURE_LOSS`, oil health collapses, the 3D sump turns red, and a **Return-To-Base** directive is issued.

3. **Demonstrate sensor decoupling.** Reset to healthy, then click `Probe Defect (EGT3)`. EGT₃ drops toward ambient. The system reports **sensor probe defect — engine healthy**, holds health near nominal, and advises that the mission may safely continue. *This is the case that causes a fixed-threshold EIS to abort a good aircraft.*

4. **Demonstrate explainability.** Click `Bearing 2X Vib`. The SHAP drawer attributes the diagnosis primarily to tri-axial vibration and sump temperature, accompanied by an actionable inspection window in flight hours.

An automated version is available via [`tools/auto_demo_showcase.py`](tools/auto_demo_showcase.py).

---

## Troubleshooting

| Symptom | Cause & Resolution |
|:--|:--|
| `ModuleNotFoundError` on launch | Dependencies not installed — run `pip install -r requirements.txt` |
| Dashboard loads but no telemetry | WebSocket blocked. Check that nothing else occupies port 8000; try `http://127.0.0.1:8000` rather than `localhost` |
| 3D engine view blank | Browser lacks WebGL. Enable hardware acceleration or use a current Chrome/Edge/Firefox |
| "FastAPI/Uvicorn not found" in console | Expected — the stdlib fallback server has taken over. Install FastAPI for the full-rate WebSocket path |
| Port 8000 already in use | Stop the conflicting process, or edit the port in [`main.py`](main.py) and [`engine_service.py`](engine_service.py) |
| Models fail to load from `saved_models/` | Regenerate with `python train_and_export_models.py` |
| `BatchNorm` error on single-sample inference | Ensure the model is in `.eval()` mode — checkpoints are exported in eval mode by the training pipeline |

---

## Roadmap

- Hardware-in-the-loop validation against a physical test-cell aero-diesel
- Onboard deployment and profiling on flight-representative edge compute
- Expansion of the fault taxonomy beyond nine modes, including compound and cascading failures
- Online adaptation of the MVEM baseline to per-airframe engine wear
- Conformal prediction to replace the current RUL interval construction with distribution-free coverage guarantees

---

## Acknowledgements

Developed for **Smart India Hackathon 2026**, problem statement **SIH26054**, proposed by the **Defence Research and Development Organisation (DRDO)**, theme *Robotics and Drones*.

Engine parameters are grounded in published specifications for DRDO/VRDE-class 2.2 L turbocharged aero-diesel and Rotax 914 UL powerplants. Supporting material — the full submission dossier and pitch deck — is in [`docs/`](docs/).

---

<div align="center">
<sub>Research and demonstration prototype. Not certified for airworthiness or operational flight use.</sub>
</div>
