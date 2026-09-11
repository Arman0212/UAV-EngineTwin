# OFFICIAL TECHNICAL SUBMISSION DOSSIER

## SMART INDIA HACKATHON 2026 — GRAND FINALE
* **Problem Statement ID:** SIH26054
* **Problem Statement Title:** *AI-Enabled Real-Time Digital Twin System for Health Monitoring, Fault Prediction and Mission Reliability Enhancement of Aero Piston Engines used in MALE UAVs*
* **Sponsoring Agency:** Defence Research and Development Organisation (DRDO)
* **Theme:** Robotics and Drones | **Category:** Software
* **Project Name:** **ENGINE-TWIN**

---

## 1. EXECUTIVE SUMMARY

**ENGINE-TWIN** is a real-time, physics-anchored Digital Twin and explainable AI prognostic platform engineered specifically for aero piston engines powering Medium-Altitude Long-Endurance (MALE) UAVs (such as the DRDO TAPAS / Rustom-II airframes powered by the VRDE 2.2L Turbocharged Aero-Diesel).

The system continuously fuses 20 Hz multi-channel engine telemetry with a non-linear Mean Value Engine Model (MVEM) through a 12-state physics-anchored Kalman estimator. By computing normalized residuals between physical sensors and the thermodynamic expectation at the current altitude, airspeed and throttle setting, ENGINE-TWIN suppresses altitude-induced false alarms (**1.42 %** against **11.74 %** for a black-box model on raw telemetry), detects progressive mechanical degradation in **2.87 s** against **28.3 s** for a fixed-threshold EIS, isolates sensor probe failures to prevent false mission aborts, and forecasts Remaining Useful Life with a bounded trend interval and real-time ranked root-cause attribution. Every sortie is recorded to disk for post-flight analysis and replay.

Two naming points are made explicitly here because precision matters to this audience: the state estimator is a **linear** Kalman filter with a complementary prediction step, not an EKF, and the attribution is **gradient x input**, not Shapley values. Both are the right engineering choices for a 50 ms edge budget, and both are documented at length in their modules and in §7.

```
                    [MALE UAV Aero Piston Engine (VRDE 2.2L)]
                                       │
                                       ▼
                       [Datasheet-Calibrated Sensor Layer]
                  (EGT 1-4, CHT 1-4, Oil P/T, MAP, RPM, Vib, Bus V)
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ENGINE-TWIN CORE PIPELINE                         │
│                                                                             │
│   ┌───────────────────────────┐         ┌───────────────────────────────┐   │
│   │   Physics MVEM Baseline   │◄───────►│   Physics-Anchored Kalman Est.│   │
│   │   (Thermodynamics Core)   │         │   (12-State Sensor Fusion)    │   │
│   └─────────────┬─────────────┘         └───────────────┬───────────────┘   │
│                 │                                       │                   │
│                 └───────────────────┬───────────────────┘                   │
│                                     ▼                                       │
│                        Normalized Physics Residuals                         │
│                   r = (y_sensor - y_mvem) / sigma_channel                   │
│                                     │                                       │
│          ┌──────────────────────────┴──────────────────────────┐            │
│          ▼                                                     ▼            │
│   [Stage 1: Anomaly Trigger]                          [Health Index Engine] │
│   Unsupervised Autoencoder (0.27 ms)                   Subsystem Health     │
│   e_recon > Mean + 3.0*sigma                           0 to 100% Scores     │
│          │                                                     │            │
│          ▼ (Fires if Anomaly)                                  │            │
│   [Sensor vs. Engine Validator]                                │            │
│   Cross-channel thermodynamic redundancy                       │            │
│          │                                                     │            │
│          ▼                                                     │            │
│   [Stage 2: Multi-Task Classifier]                             │            │
│   MLP 15-64-32, 10-class + severity head                       │            │
│          │                                                     │            │
│          ├──────────────────────────┬──────────────────────────┤            │
│          ▼                          ▼                          ▼            │
│   [RUL Prognostics]        [Gradient Attribution]    [5-State Twin Model]   │
│   Degradation Trajectory +   Local Attribution       Physical / Sensor /    │
│   Trend Interval Bounds      Root-Cause Breakdown    Estimated / AI State   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ WebSocket / SSE Stream (20 Hz)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      OPERATOR GROUND STATION DASHBOARD                      │
│   • Interactive 3D Engine Twin View with Cylinder Thermal Heatmap           │
│   • Real-Time Telemetry vs. MVEM Physics Baseline vs. Residual Bounds       │
│   • Subsystem Health Matrix (Overall, Cylinders, Oil, Turbo, Vibration)     │
│   • Attribution Evidence Drawer & Action Directives                         │
│   • 1-Click Live Fault-Injection Control Pad for Stage Demonstration        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. PROBLEM STATEMENT CLAUSE MAPPING

| DRDO Problem Statement Clause | Technical Solution in ENGINE-TWIN | Implementation File | Status |
| :--- | :--- | :--- | :---: |
| **Aero Piston Engines in MALE UAVs** | 2.2L Turbo Aero-Diesel MVEM capturing manifold dynamics, torque balance, and multi-cylinder lumped heat transfer from 0 to 30,000 ft | [`simulation/mvem.py`](../simulation/mvem.py) | **VALIDATED** (see caveat §7) |
| **Real-Time Digital Twin System** | 12-state physics-anchored **linear** Kalman estimator (complementary prediction toward the MVEM, H = I) fusing noisy telemetry at 20 Hz. Not an EKF: no non-linear transition function, no Jacobian - see the module docstring | [`digital_twin/state_estimator.py`](../digital_twin/state_estimator.py) | **VALIDATED (68% noise rejection @ 5x sigma)** |
| **Subsystem Health Monitoring** | Exponential normalized residual scoring ($Health = 100 \cdot e^{-\alpha |r|}$) with safety-critical subsystem weighting | [`digital_twin/health_index.py`](../digital_twin/health_index.py) | **VALIDATED (100% nominal health)** |
| **Early Anomaly Detection** | Unsupervised fully-connected residual autoencoder (15-32-16-6-16-32-15) with calibrated threshold ($\mu + k\sigma$), 0.27 ms | [`models/anomaly_autoencoder.py`](../models/anomaly_autoencoder.py) | **VALIDATED (92.2% anomaly recall)** |
| **Root-Cause Fault Diagnosis** | Multi-task MLP classifier (shared 15-64-32 backbone, 10-class head with learned temperature scaling + severity head) diagnosing 9 failure modes plus healthy | [`models/fault_classifier.py`](../models/fault_classifier.py) | **VALIDATED (97.64% accuracy)** |
| **Sensor vs. Engine Decoupling** | Physical consistency layer preventing broken thermocouple probes from grounding operational sorties | [`models/sensor_validator.py`](../models/sensor_validator.py) | **MEASURED (93.3% isolated; see §7)** |
| **Fault Prediction (RUL)** | Degradation trajectory projection outputting a bounded remaining-life interval from the trend fit (not a distribution-free 95% coverage guarantee) | [`models/rul_estimator.py`](../models/rul_estimator.py) | **IMPLEMENTED (trend interval)** |
| **Explainable AI (XAI)** | Local gradient x input attribution (0.67 ms) formatted into decision-support directives. Not Shapley values - a first-order ranking, documented as such | [`xai/attribution.py`](../xai/attribution.py) | **VALIDATED (ranked attribution)** |
| **Operator Decision UI** | Interactive web dashboard with 3D engine block, dynamic thermal colormaps and live fault injection. All assets vendored - runs with no internet route | [`dashboard/index.html`](../dashboard/index.html) | **OPERATIONAL (20 Hz live)** |
| **Mission Profile Simulation under Varying Conditions** | Per-sortie mission shapes (ceiling, loiter band, throttle, phase fractions) plus a manual sandbox that pins throttle/altitude/OAT and recomputes the ISA atmosphere, so the turbo genuinely sees thinner air | [`simulation/flight_profile.py`](../simulation/flight_profile.py) | **OPERATIONAL (200 HP SL to 110 HP at 30k ft, health stays 100%)** |
| **Post-Flight Analysis & Mission Replay** | Flight data recorder writes every twin frame to append-only JSONL; post-flight report gives band/phase dwell, subsystem minima and the full diagnosis timeline; replay streams a sortie back through the live telemetry path | [`digital_twin/flight_recorder.py`](../digital_twin/flight_recorder.py) | **OPERATIONAL (see §6)** |

---

## 3. EMPIRICAL BENCHMARK & SCIENTIFIC VALIDATION EVIDENCE

The system was evaluated against **48,000 held-out frames drawn from 32 fully independent sorties**, spanning all flight phases (taxi, climb, high-altitude loiter, descent, approach) and a mission-shape envelope deliberately wider than the training set.

### Scientific Benchmark Comparison Table

Reproduce with `python validation/benchmark.py`. The script prints this table; the
figures below are copied from a run of the committed checkpoints against the
committed held-out split, and are not quoted from any earlier run.

| Metric | Method A: Fixed-Threshold EIS (Garmin / EDM-930 style) | Method B: Black-Box ML (Random Forest on raw telemetry) | Proposed ENGINE-TWIN (Physics Residuals + Kalman Estimator + XAI) |
| :--- | :---: | :---: | :---: |
| **Fault Classification Accuracy** | 53.65 % | 86.93 % | **97.64 %** |
| **Macro F1-Score** | 0.2463 | 0.8696 | **0.9770** |
| **Mean Detection Latency** | 28.26 s | 8.00 s | **2.87 s** |
| **False Alarm Rate (Healthy)** | 0.00 % *(thresholds set so wide it misses nearly everything)* | 11.74 % *(fails under altitude shift)* | **1.42 %** |
| **CPU Inference Latency** | 0.035 ms | 0.001 ms | **0.397 ms** *(budget < 150 ms)* |
| **Sensor vs. Engine Decoupling** | False abort | Confounded | **Physics-decoupled** |
| **Root-Cause Explainability** | None | Feature importance only | **Ranked attribution cards** |
| **RUL Bounds** | None | None | **Trend interval** |

Read the EIS column carefully: a 0.00 % false-alarm rate alongside a 0.25 macro F1
is not a strength, it is a threshold set so wide that almost nothing real trips it.

### Architectural Ablation (`python validation/ablation.py`)

Each ablation retrains the *same* network on a different representation and
re-scores on the same held-out sorties, so the only variable is the architecture
choice under test.

| Configuration | Macro F1 | False Alarm | Accuracy |
| :--- | :---: | :---: | :---: |
| **Full ENGINE-TWIN (physics residuals)** | **0.9762** | **0.47 %** | **97.52 %** |
| A: raw telemetry, identical network | 0.9165 | 14.78 % | 89.89 % |
| D: residuals, 50 % of training sorties | 0.7426 | 0.37 % | 86.35 % |
| D: residuals, 25 % of training sorties | 0.7621 | 1.09 % | 84.86 % |

* Physics anchoring is worth **+0.0597 macro F1** and **14.31 percentage points**
  of false-alarm rate.
* Restricted to healthy frames above 20,000 ft, where altitude derating is
  largest, the gap widens to **0.70 % against 18.42 %**. This is the core claim of
  the submission, and it is measured rather than asserted.
* Two-stage gating: the trigger fires on 1.2 % of held-out frames, so gating the
  classifier behind it costs 0.176 ms/frame against 0.373 ms continuous —
  **52 % of inference CPU saved**.

### Per-Class Detection Breakdown (48,000 held-out frames, 32 independent sorties)

| Fault Mode | Precision | Recall | F1-Score | Operational Consequence |
| :--- | :---: | :---: | :---: | :--- |
| **Healthy Baseline** | 0.953 | 0.998 | **0.975** | Low false-alarm cruise tracking |
| **Sensor Probe Defect (EGT3)** | 1.000 | 1.000 | **1.000** | Prevents false mission abort |
| **Electrical Voltage Sag** | 1.000 | 0.976 | **0.988** | Electrical load-shed advisory |
| **Bearing Wear (2X Vib)** | 0.989 | 0.980 | **0.985** | Advance maintenance warning |
| **Oil Pressure Loss** | 0.998 | 0.972 | **0.984** | Immediate RTB emergency alert |
| **Turbo Boost Deficiency** | 0.999 | 0.964 | **0.981** | Catches high-altitude derating loss |
| **Cylinder Misfire / Timing** | 0.996 | 0.956 | **0.976** | Isolates rough running |
| **Rich Mixture Drift (Cyl 1)** | 0.991 | 0.935 | **0.962** | Fuel efficiency degradation |
| **Cooling Degradation (Cyl 2)** | 0.996 | 0.931 | **0.962** | Cylinder thermal protection |
| **Lean Mixture (Cyl 3)** | 0.999 | 0.916 | **0.956** | Detonation risk management |

### Dataset & Split Integrity (`python validation/leakage_audit.py`)

| | Sorties | Frames |
| :--- | ---: | ---: |
| Healthy training | 10 | 18,000 |
| Fault training (9 classes x 4 sorties) | 36 | 64,800 |
| **Held-out evaluation** | **32** | **48,000** |

Every sortie is an independent mission with its own drawn shape — cruise ceiling,
loiter altitude and band, throttle settings, and phase fractions — on top of an
ISA offset and a per-run seed. Held-out shapes are drawn from a separate RNG
stream over **wider** ranges than training (ceilings 22,000–32,000 ft against
24,000–30,000 ft), so the test set measures generalisation rather than replaying
one mission under fresh noise.

The audit confirms zero `run_id` overlap, whole monotonic test sorties, universal
`SIMULATED` provenance tagging, and — by nearest-neighbour search in standardised
telemetry space — that no held-out frame is a near-duplicate of any training
frame (closest approach 0.126 sigma, median 0.340 sigma).

---

## 4. MULTI-ENGINE TRANSFER & SCALABILITY PROOF

| Engine Platform | Displacement | Max Power | Altitude Power Envelope | Architecture Changes |
| :--- | :---: | :---: | :---: | :---: |
| **DRDO/VRDE 2.2L Turbo Aero-Diesel** | 2.20 L | 200.0 HP | 200 HP (SL) $\rightarrow$ 110 HP (30k ft) | Base target configuration |
| **Rotax 914 UL Turbo Flat-Four** | 1.21 L | 115.0 HP | 115 HP (SL) $\rightarrow$ 85 HP (20k ft) | **0 lines of code (JSON only)** |

Porting to a new powerplant is a configuration file plus recalibration, not a
rewrite — a direct consequence of diagnosing on normalised residuals rather than
absolute values. `python tools/test_multi_engine_transfer.py` exercises the path.

**Caveat on the reported 0.00 HP fit RMSE.** The MVEM interpolates the same
`altitude_power_derating` table it is then scored against, so that figure is a
consistency check on the interpolation, not independent validation against a real
engine. It is reported for completeness and should not be read as a claim of
physical accuracy. Manifold pressure, which is *not* fitted to the table, tracks
less exactly (1.05 bar target against 1.157 bar modelled at 20,000 ft on the
Rotax). Independent validation requires bench data — see §8, Stage 1.

---

## 5. EDGE COMPUTE & FLIGHT AVIONICS PROFILING

Measured across 2,000 continuous cycles on a single desktop CPU thread
(`python tools/edge_benchmark_profiler.py`):

* **Resident Memory Footprint:** **199.0 MB**
* **Model Weights & Tensors:** **4.1 MB**
* **End-to-End Latency Breakdown:**
  * MVEM Physics Solver: `0.078 ms`
  * Sensor Dynamics Emulation: `0.055 ms`
  * 12-State Physics-Anchored Kalman Estimator: `0.091 ms`
  * Residual Extraction & Health Scoring: `0.084 ms`
  * PyTorch Autoencoder: `0.269 ms`
  * Multi-Task Classifier: `0.258 ms`
  * Local Gradient Attribution: `0.670 ms`
  * **Total Pipeline Latency:** **1.506 ms**
* **Maximum Throughput:** **664 FPS** (33x real-time headroom against the 20 Hz target)
* **Budget:** 150 ms per tick. The full chain uses about 1 % of it.

The attribution stage is profiled against a *named fault class*, not against
whatever the classifier happens to predict. The profiler flies a healthy engine,
so timing the predicted class would time an early return and report attribution
as effectively free — understating exactly the case that has to fit the budget:
the tick on which a fault has just fired.

**Hardware compatibility is an estimate, not a measurement.** These figures come
from a desktop x86 core. A Jetson Orin Nano or Cortex-A class flight computer has
not been profiled; the headroom makes it very likely to fit, but that port is
Stage 3 of the roadmap and the number will be measured there, not extrapolated here.

---

## 6. POST-FLIGHT ANALYSIS & MISSION REPLAY

Every sortie is written to disk by the flight data recorder
(`digital_twin/flight_recorder.py`) as one directory per sortie: a `meta.json`
header and an append-only `frames.jsonl` carrying each broadcast twin frame in
time order. Append-only JSONL is deliberate — a sortie interrupted by a hard
shutdown still reads back to its last complete line.

The post-flight report answers what an operator asks after landing:

* time spent in each health band (`NOMINAL` through `CRITICAL`) and each mission phase
* per-subsystem health minima across the sortie
* the full diagnosis timeline, each event carrying its confidence, duration, the
  residual channels that drove it, and the directive issued
* the interval between the unsupervised trigger firing and the classifier
  committing to a named fault — measurable from the log without ground truth

Replay streams a recorded sortie back through the same telemetry transport the
live twin uses, so the entire ground station — telemetry strips, health matrix,
3D engine view, evidence drawer — replays without modification. The playhead is
advanced by the simulation clock rather than by consumer reads, so replay runs at
true speed regardless of how many clients are attached.

| | Endpoint | |
| :--- | :--- | :--- |
| `GET` | `/api/sessions` | recorded sorties, newest first |
| `GET` | `/api/sessions/{id}` | post-flight report |
| `GET` | `/api/sessions/{id}/frames` | raw frames, paged |
| `POST` | `/api/replay/start` | begin replay |
| `POST` | `/api/replay/stop` | return to live |

---

## 6b. MODEL MISMATCH, ONLINE ADAPTATION & END-OF-LIFE DEFINITION

Every figure in §3 gives the twin perfect knowledge of the engine it shadows: the
plant MVEM and the baseline MVEM carry identical constants. In service that is
never true. `validation/mismatch_sweep.py` measures the cost by deviating the
simulated engine — turbo and volumetric efficiency, FMEP, oil-pump and combustion
efficiency, plus a fixed per-cylinder flow and cooling imbalance — while leaving
the twin's baseline at datasheet. The twin is never told.

| Engine build spread | 0 % | 2 % | 5 % | 10 % |
|:--|:---:|:---:|:---:|:---:|
| ENGINE-TWIN macro F1 | 0.9771 | 0.9623 | 0.8949 | 0.8160 |
| ENGINE-TWIN false alarms | 0.43 % | 4.03 % | 34.93 % | 54.65 % |
| Black-box ML macro F1 | 0.9155 | 0.9118 | 0.8930 | 0.8247 |
| Black-box ML false alarms | 40.45 % | 40.69 % | 43.79 % | 50.88 % |

**The result does not favour us and is reported as measured.** Across 0 → 10 %
spread the residual representation loses 0.1611 macro F1 against the black-box's
0.0907. Its F1 advantage is gone by 5 % spread; at 10 % the black-box is
marginally ahead. False alarms — the metric where physics anchoring wins by two
orders of magnitude under perfect knowledge — degrade hardest. A third arm
trained with the black-box's own recipe on residuals loses 0.1499, confirming the
representation degrades rather than the training schedule.

The mechanism is that a residual is measurement minus baseline prediction; when
the baseline is wrong about the unit, every residual carries a standing offset a
healthy-trained classifier reads as a fault. The damage concentrates: per-cylinder
build imbalance drives `RICH_MIXTURE_CYL1` from 0.9627 to 0.7749 at 5 % and 0.6140
at 10 %, because a cylinder built with above-average flow *is* a mild rich trim on
that cylinder. On that class the black-box is the more robust of the two at 10 %
(0.7434 against 0.6140). `COOLING_DEGRADATION_CYL2` holds at 0.9101 throughout.

`digital_twin/baseline_adapter.py` estimates the standing offset online — one
additive bias per residual channel, updated only while the anomaly gate is quiet
and no fault is annunciated, clamped to ±1.5 σ, frozen outside steady flight. On
the bench it works: `test_baseline_adapter.py` measures the healthy false-alarm
rate falling from 85.82 % to 11.05 % after convergence, a fault injected after
convergence still caught 0.50 s after onset, and a fault injected *during*
convergence not absorbed (the gate froze adaptation on 99.2 % of post-onset frames
and the learned oil bias stayed at 0.050 σ against the 1.500 σ the same healthy
engine learns). **On the held-out sorties it is a wash**, because adaptation needs
about 90 s of quiet steady flight and no sortie in the set contains that much
loiter — the median is 69 s, the longest 86 s. It never converges there. A second
limit is structural: mismatch large enough to hold the anomaly gate open
continuously stops the adapter learning anything at all.

End-of-life is now defined per subsystem in engine units in `configs/*.json`, and
`HealthIndexEngine.end_of_life_criteria()` maps each to the health value it
corresponds to under the current σ and α — physical limit in, percentage out.
`models/rul_estimator.py` projects the subsystem with the least margin to its own
limit, and the alert card names the criterion ("Oil pressure projected to reach
2.0 bar in 18.0–25.0 flight hours") rather than a bare number. The mapping
exposed that the previous fixed 30 % threshold was far more conservative than any
documented limit: the stated limits map to 0.10 %–12.20 % health.

---

## 7. KNOWN LIMITATIONS

Stated here rather than left to be discovered, because a reviewer who finds an
unstated limitation discounts everything else in the document.

1. **Everything is simulated.** The engine, the instrumentation and the faults are
   models. No hardware-in-the-loop validation has been performed, and nothing here
   is certified for airworthiness.
2. **The estimator is not an EKF.** It is a linear Kalman filter with a
   complementary prediction step toward the MVEM state, with `F = I` and `H = I`.
   Because `F` is identity, the covariance `P` is a tuned noise-rejection
   parameter rather than a calibrated uncertainty; anything requiring meaningful
   state covariance would need a true EKF or a UKF over the MVEM.
3. **The attribution is not SHAP.** It is gradient x input — a first-order local
   ranking without Shapley local-accuracy or consistency guarantees. Chosen for
   the 50 ms edge budget; `shap.DeepExplainer` runs offline against the same
   network where exact values are wanted.
4. **The RUL interval is a trend interval.** It is constructed from the spread of
   the degradation-trajectory fit, not from a distribution-free coverage
   guarantee, and should not be described as a calibrated 95 % interval.
   Conformal prediction is the honest upgrade.
5. **The sensor validator covers two archetypes** — thermocouple open circuit and
   oil transducer dropout. It isolates 93.3 % of held-out probe-defect frames, not
   100 %. The ablation further shows the trained classifier already separates
   probe defects perfectly on its own, so the validator currently buys no
   measurable accuracy; its value is that it is a physics rule rather than a
   learned boundary, and so holds for probe failures absent from the training set.
6. **Per-frame inference degrades under out-of-distribution noise.** At 5x
   instrumentation sigma the classifier names a false mechanical fault on about
   16 % of healthy frames. The ground station votes over a rolling window before
   annunciating, so this does not reach the operator, but it is a real weakness.
7. **Taxonomy scope.** Nine failure modes plus healthy. Real engines fail in
   compound and cascading ways this taxonomy does not name, though the
   unsupervised trigger will still flag them as anomalous.
8. **The residual representation degrades badly under model mismatch, and worse
   than the baseline it beats.** Quantified in §6b: at 5 % build spread false
   alarms rise from 0.43 % to 34.93 %, and across 0 → 10 % spread the twin loses
   0.1611 macro F1 against the black-box's 0.0907. Per-unit parameter
   identification on the ground is a precondition for deployment, not a
   refinement. This is the most serious limitation in this document.
9. **Online adaptation does not yet close that gap.** It is implemented and works
   on a 240 s steady leg (85.82 % → 11.05 % false alarms), but needs ~90 s of
   quiet steady flight to converge and no held-out sortie contains it, so it is a
   wash on the sweep. It also cannot learn at all when mismatch holds the anomaly
   gate permanently open.
10. **Two of the five end-of-life limits are ours with no external source.** The
   2.5 g 2X-vibration figure and the 90 °C EGT-spread margin are reasoned from
   the model's own behaviour, not taken from a manufacturer limit. Oil pressure,
   CHT and bus voltage trace to the engine envelope and MIL-STD-704F. All five
   are stated in engine units in `configs/*.json` so an operator can replace
   them.

---

## 8. DEPLOYMENT ROADMAP

**Stage 1 — Bench validation (now to +3 months).** Replace the simulated sensor
layer with a CAN/RS-485 ingest shim behind the existing `SensorReadings`
interface and run the twin against a test-cell engine on a dynamometer. Nothing
downstream changes: the residual definition, the estimator and both networks
already consume an interface, not a simulator. Deliverable is a measured MVEM fit
error against a real engine — the number §4's caveat says we do not yet have.

**Stage 2 — Recalibration on real data (+3 to +6 months).** Refit the MVEM
constants and per-channel sigma to the bench engine, retrain the autoencoder on
the resulting healthy residuals, re-run the full validation suite. Fault labels
from seeded bench faults where safe, maintenance records otherwise. Expect the
false-alarm rate to move most.

**Stage 3 — Edge port (+6 to +9 months).** Target a Jetson Orin Nano or an ARM
Cortex-A class flight computer. Export both networks to ONNX, profile on target,
and confirm behaviour at airframe operating temperature. Replaces §5's estimate
with a measurement.

**Stage 4 — Flight-representative integration (+9 to +18 months).** Secure
telemetry (signed frames, encrypted downlink), redundant recording, and a
DO-178C-style requirements trace. The deterministic parts — physics baseline,
sensor validator, health index — trace conventionally; the learned components
need a partitioned-assurance argument. Certification effort dominates this stage,
not modelling.

**Deliberately not scheduled:** federated learning across a fleet. The problem
statement lists it as an innovation area, but it requires a fleet, a data-sharing
policy and a model-provenance answer before it becomes an engineering task rather
than a research one.

---

## 9. GRAND FINALE DEMONSTRATION & VERIFICATION INSTRUCTIONS

### Quick Start
```bash
# Double click batch file:
run_demo.bat

# Or run via Python:
python main.py
```
Open **`http://127.0.0.1:8000`** in any web browser. **No internet connection is
required** — Tailwind, Chart.js, Three.js and the webfont are vendored under
`dashboard/vendor/` and served from the twin's own host.

### Full Automated Verification Pass
```bash
python run_all_tests.py
```
Nine suites, one consolidated report, approximately two and a half minutes. Every
suite exits non-zero on failure — including the end-to-end fault propagation QA —
so a green run means all nine genuinely passed.

### Rebuilding data and models from scratch
```bash
python data/generate_dataset.py        # 78 independent sorties
python train_and_export_models.py      # retrain both networks, recalibrate threshold
python validation/benchmark.py         # reproduce the §3 comparison table
```
`data/generate_dataset.py` is the only script that rewrites the committed CSVs;
the test suite generates into a temporary directory, so a verification run can
never leave the shipped checkpoints scored against data they never saw.
