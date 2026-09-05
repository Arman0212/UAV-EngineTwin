# EngineTwin

A real-time digital twin for the aero piston engines that power medium-altitude
long-endurance UAVs. It runs a physics model of the engine alongside the engine
itself, compares the two continuously, and hands the difference to a small stack
of neural networks that decide what is wrong, how bad it is, how long you have,
and why it thinks so.

Everything in this repository is simulated — the engine, the probes, and the
failures. There is no flight hardware in the loop. What is real is the pipeline:
the physics model, the estimator, the diagnostic networks, the explanations, and
the validation suites that measure them.

---

## Why threshold alarms fail at 28,000 ft

A conventional engine instrument system watches each channel against a fixed
redline. On a light aircraft that flies at 8,000 ft all day, that works. On a
MALE UAV climbing from sea level to 30,000 ft on a 20-hour sortie, it fails in
both directions at once.

Climb high enough and a *healthy* engine starts looking sick. Manifold pressure
falls as the turbo runs out of air, power derates from 200 HP to 110 HP, EGT
drifts. Nothing is broken; the atmosphere changed. A fixed threshold reads this
as a fault, and the operator learns to ignore it.

Meanwhile a genuinely failing engine can sit comfortably inside every redline.
An injector clogging on cylinder 3 pushes EGT₃ up by 40 °C — well under the
880 °C continuous limit, so nothing trips, right up until it does.

The trap is that a raw sensor reading carries two things at once: the state of
the engine, and the state of the flight. You cannot threshold your way out of
that, and a black-box model trained on raw telemetry inherits the same problem —
it just hides it behind a confidence score.

## The idea

Separate the two. Run a Mean Value Engine Model in lockstep with the engine, fed
the same altitude, ambient conditions and throttle. It predicts what a *healthy*
engine would be doing right now. Then diagnose on the gap, normalized per
channel:

```
r  =  (y_measured − y_physics) / σ_channel
```

Fifteen channels, one vector:

```
rpm  manifold_pressure  fuel_flow  oil_pressure  oil_temp
cht_cyl_1..4     egt_cyl_1..4     vibration_rms     bus_voltage
```

Because the physics baseline already absorbed altitude, throttle and ambient
temperature, a healthy engine sits at `r ≈ 0` everywhere in the envelope — sea
level or 30,000 ft, idle or full power. The learning problem stops being
"recognise this engine" and becomes "recognise a departure from physics," which
is a much smaller problem and a far more transferable one.

Every model downstream sees residuals. None of them ever sees a raw sensor value.

---

## Running it

You need Python 3.10 or 3.11 and a browser with WebGL.

```bash
git clone https://github.com/Arman0212/UAV-EngineTwin.git
cd UAV-EngineTwin

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python main.py
```

The launcher opens <http://127.0.0.1:8000> for you. On Windows, `run_demo.bat`
does the same thing with a double-click.

If FastAPI and Uvicorn are missing, `main.py` quietly falls back to
[`standalone_server.py`](standalone_server.py), which serves the whole twin on
the standard library alone. NumPy and PyTorch are still needed for the physics
and the networks.

To confirm the install is sound:

```bash
python run_all_tests.py
```

Eight suites, one consolidated report — physics, AI layer, leakage audit, stress
testing, baseline comparison, ablation, multi-engine transfer, and edge
profiling.

---

## Five minutes at the console

The dashboard is worth driving rather than reading about. In order:

**1 — Watch it idle.** The aircraft is in high-altitude loiter. Health sits at
100 %, the 3D engine is cool, and every telemetry strip shows the measurement
tracking the physics baseline inside its ±3σ band. Note that the absolute
numbers look nothing like sea-level numbers, and nothing complains.

**2 — Break the oil system.** Hit `Oil Pressure Loss`. Roughly two seconds
later the autoencoder trips, the classifier names `OIL_PRESSURE_LOSS`, oil
health collapses, the sump glows red on the 3D view, and the alert reads
*Return To Base* with a remaining-life interval attached.

**3 — Now break a sensor instead.** Reset, then hit `Probe Defect (EGT3)`.
EGT₃ falls toward ambient. This is the case a redline system aborts a perfectly
good aircraft over. EngineTwin checks EGT₃ against CHT₃ and fuel flow, finds the
neighbours entirely nominal, and reports *sensor probe defect — engine healthy*.
Health barely moves. The mission continues.

**4 — Ask it why.** Hit `Bearing 2X Vib` and open the evidence drawer. The
diagnosis comes with its SHAP attribution: which residual channels drove it, in
what proportion, and an inspection window in flight hours rather than a bare
percentage.

[`tools/auto_demo_showcase.py`](tools/auto_demo_showcase.py) runs this sequence
unattended if you need it hands-free.

---

## What happens in one 50 ms tick

The service loop in [`engine_service.py`](engine_service.py) does this twenty
times a second:

1. **Flight profile** advances — ISA atmosphere gives ambient pressure and
   temperature for the current altitude, and the mission phase sets throttle.
   Phases run `TAXI_WARMUP → CLIMB_TO_ALTITUDE → HIGH_ALT_LOITER → DESCENT →
   APPROACH_LANDING`.
2. **MVEM integrates** — manifold filling dynamics, turbo boost with altitude
   derating, crankshaft torque balance, four independent cylinder thermal
   states, and the oil circuit. This is ground truth.
3. **Faults are applied**, if any are active, as parametric perturbations of
   the physics or the instrumentation.
4. **Sensors sample** the truth through per-channel noise, first-order lag,
   ADC quantization and sample rate. EGT probes are slow and coarse (σ = 3.5 °C,
   τ = 2.0 s, 5 Hz); the RPM pickup is fast and clean (σ = 8 rpm, τ = 0.05 s,
   50 Hz).
5. **EKF predict/update** fuses the measurement into a 12-state estimate. If the
   datalink drops packets, the filter coasts on physics instead of producing a
   spurious residual spike.
6. **Residuals** are computed and handed to everything downstream.
7. **Health indices** map residuals to bounded 0–100 % scores per subsystem.
8. **Anomaly trigger** — the autoencoder reconstructs the residual vector. If
   the error clears `mean + 3σ` of the healthy calibration distribution, the
   rest of the stack wakes up. Otherwise the tick ends here.
9. **Sensor validator** decides, before anything else runs, whether this is a
   bad probe or a bad engine.
10. **Classifier** returns a calibrated fault class and a continuous severity.
11. **SHAP and RUL** attach the evidence and the remaining-life interval.
12. **Broadcast** — the full twin state goes out over the WebSocket.

Budget is 150 ms. The whole chain costs about 1 ms of CPU. No GPU.

---

## The code

**Physics and environment** — [`simulation/`](simulation/)

- [`mvem.py`](simulation/mvem.py) — the Mean Value Engine Model, calibrated to a
  DRDO/VRDE-class 2.2 L four-cylinder turbocharged aero-diesel
- [`sensors.py`](simulation/sensors.py) — datasheet-driven instrumentation model
- [`flight_profile.py`](simulation/flight_profile.py) — ISA atmosphere and MALE
  mission profiles
- [`fault_injector.py`](simulation/fault_injector.py) — parametric failure modes

**Twin state** — [`digital_twin/`](digital_twin/)

- [`ekf_estimator.py`](digital_twin/ekf_estimator.py) — 12-state Extended Kalman
  Filter over `[RPM, MAP, Oil_P, Oil_T, CHT₁₋₄, EGT₁₋₄]`
- [`health_index.py`](digital_twin/health_index.py) — subsystem scoring as
  `100·exp(−α·|r|)`, weighted into an overall index, banded
  `NOMINAL / ADVISORY / CAUTION / WARNING / CRITICAL` at 85 / 70 / 50 / 25
- [`twin_state.py`](digital_twin/twin_state.py) — the engine represented at five
  levels simultaneously: physical truth, raw sensor, EKF estimate, healthy
  baseline, and AI health layer

**Diagnosis** — [`models/`](models/)

- [`anomaly_autoencoder.py`](models/anomaly_autoencoder.py) — symmetric
  bottleneck `15→32→16→6→16→32→15`, trained only on healthy residuals, so it
  flags failure modes that are not in the taxonomy at all
- [`sensor_validator.py`](models/sensor_validator.py) — cross-channel
  thermodynamic consistency; separates instrumentation faults from engine faults
- [`fault_classifier.py`](models/fault_classifier.py) — shared `15→64→32`
  backbone, a 10-class head with learned temperature scaling, and a continuous
  severity head
- [`rul_estimator.py`](models/rul_estimator.py) — classifies degradation as
  `STABLE / DRIFTING / ABRUPT` over a 50-sample window, projects to the 30 %
  critical threshold, and reports a 95 % interval in flight hours

**Explanation** — [`xai/`](xai/)

- [`shap_explainer.py`](xai/shap_explainer.py) — local attribution over the
  15 residual channels, under a millisecond
- [`alert_generator.py`](xai/alert_generator.py) — assembles diagnosis, physics
  evidence, life interval and sensor integrity into one operator card with an
  explicit directive

**Everything else** — [`dashboard/`](dashboard/) is the ground station (3D
engine view, telemetry strips, health matrix, evidence drawer, fault control
pad). [`validation/`](validation/) holds the benchmark, ablation, leakage audit
and stress suites. [`tools/`](tools/) has profiling, plotting and transfer
utilities. [`configs/`](configs/) holds the engine parameter sets.
[`ENGINE_TWIN_MASTER_PIPELINE.ipynb`](ENGINE_TWIN_MASTER_PIPELINE.ipynb) walks
the whole thing end to end in one notebook.

**Temperature scaling deserves a note.** An uncalibrated network will report
99 % confidence on a marginal case, and an operator who learns that the number
is inflated stops using it. The classifier divides its logits by a learned
temperature so the reported confidence means something. This is a human-factors
decision as much as a modelling one.

---

## Fault library

Ten classes, each injectable at any severity and ramp rate:

| Class | Mechanism | What shows up in the residuals |
|:--|:--|:--|
| `HEALTHY` | — | `r ≈ 0` everywhere |
| `LEAN_MIXTURE_CYL3` | Injector partially clogged | EGT₃ climbs, thermal gradient tilts |
| `RICH_MIXTURE_CYL1` | Injector leaking | EGT₁ drops while fuel flow rises |
| `COOLING_DEGRADATION_CYL2` | Baffle or airflow blockage | CHT₂ rises fast |
| `OIL_PRESSURE_LOSS` | Relief valve leak | Oil pressure below 2.0 bar |
| `TURBO_BOOST_DEFICIENCY` | Wastegate stuck / compressor fouling | MAP deficit, worse with altitude |
| `CYLINDER_MISFIRE_TIMING` | Timing jitter, valve seating | RPM instability, 0.5× vibration order |
| `BEARING_WEAR_VIBRATION` | Crank or rod bearing wear | 2× vibration growing over time |
| `SENSOR_FAULT_EGT3` | Thermocouple open circuit | EGT₃ at ambient, engine untouched |
| `ELECTRICAL_VOLTAGE_SAG` | Alternator diode fault | Bus voltage sags under avionics load |

`SENSOR_FAULT_EGT3` is a first-class member of the taxonomy on purpose. The
system is *trained* to tell a dead probe from a dead cylinder rather than
inferring it from a heuristic afterwards, because that particular confusion is
what turns a healthy aircraft into an aborted sortie.

---

## Driving it from your own code

The service listens on `127.0.0.1:8000`.

| | Endpoint | |
|:--|:--|:--|
| `GET` | `/` | the dashboard |
| `GET` | `/api/state` | full twin state, once |
| `POST` | `/api/fault/inject` | inject a fault |
| `POST` | `/api/fault/clear` | back to healthy |
| `POST` | `/api/sim/reset` | restart from t = 0 |
| `POST` | `/api/sim/speed` | time scale, clamped 0.2×–10× |
| `WS` | `/ws/telemetry` | 20 Hz state broadcast |

Injecting a fault takes a class name, a severity in 0.0–1.0, and a ramp time in
seconds (`0` for an abrupt step). An unknown class returns HTTP 400.

```bash
curl -X POST http://127.0.0.1:8000/api/fault/inject \
  -H "Content-Type: application/json" \
  -d '{"fault_type": "TURBO_BOOST_DEFICIENCY", "severity": 0.7, "ramp_duration_s": 12.0}'
```

Reading the stream:

```python
import asyncio, json, websockets

async def listen():
    async with websockets.connect("ws://127.0.0.1:8000/ws/telemetry") as ws:
        while True:
            s = json.loads(await ws.recv())
            ai = s["ai_prognostics"]
            print(f'{s["timestamp_s"]:7.1f}s  {s["altitude_ft"]:6.0f}ft  '
                  f'health {s["health"]["overall_health"]:5.1f}%  '
                  f'{ai["fault_class"]} @ {ai["fault_confidence_pct"]:.0f}%  '
                  f'RUL {ai["rul_hours_min"]:.0f}-{ai["rul_hours_max"]:.0f}h')

asyncio.run(listen())
```

Each frame carries the flight state, the raw sensor channels, the MVEM
expectation for each of them, the EKF estimate, the residual vector, seven
health scores, and the AI block (anomaly score and threshold, fault class,
calibrated confidence, severity, sensor-fault flag, RUL mean and bounds, top
contributing channels, and a recommended action). The full schema is
[`digital_twin/twin_state.py`](digital_twin/twin_state.py).

---

## Data and training

Three CSVs in [`data/datasets/`](data/datasets/), all generated from the
calibrated MVEM by [`generate_dataset.py`](data/generate_dataset.py). Each row
carries 39 columns: flight state, every sensor channel, physics ground truth
(`true_power_hp`, `true_torque_nm`, `true_bsfc_g_kwh`), labels, and provenance.

| File | Rows | Used for |
|:--|--:|:--|
| `train_healthy.csv` | 12,000 | autoencoder training and σ calibration |
| `train_faults.csv` | 43,200 | classifier and severity head |
| `test_scenarios.csv` | 22,000 | held-out evaluation |

Splits are partitioned by `run_id` — whole flights, never individual rows. That
distinction matters: split by row and adjacent 50 ms samples land on both sides
of the boundary, and your test accuracy becomes fiction.
[`validation/leakage_audit.py`](validation/leakage_audit.py) checks for `run_id`
overlap, adjacent-slice contamination, preprocessing-stage future snooping, and
class representation across splits.

Rebuild the data with `python data/generate_dataset.py`. Retrain with
`python train_and_export_models.py`, which trains both networks, calibrates the
anomaly threshold and the classifier temperature, scores precision, recall,
detection latency and false-alarm rate on the held-out scenarios, and writes
checkpoints to `models/saved_models/`.

---

## How well it works

Measured on the 22,000 held-out frames, spanning takeoff through 30,000 ft
loiter and back down. Reproduce with `python validation/benchmark.py` — it
prints this table itself.

| | Fixed-threshold EIS | Black-box ML on raw telemetry | **EngineTwin** |
|:--|:---:|:---:|:---:|
| Accuracy | 59.49 % | 83.68 % | **93.47 %** |
| Macro F1 | 0.2842 | 0.8778 | **0.9414** |
| Detection latency | 25.51 s | 5.96 s | **2.30 s** |
| False alarms on healthy sorties | 0.00 % | 27.65 % | **2.18 %** |
| CPU inference | 0.083 ms | 0.004 ms | **1.023 ms** |
| Sensor vs. engine | false abort | confounded | **decoupled** |
| Root cause | none | feature importance | **SHAP cards** |
| RUL bounds | none | none | **95 % intervals** |

Two columns need reading carefully. The EIS scores a perfect 0.00 % false-alarm
rate, which sounds excellent until you notice its macro F1 is 0.28 — the
thresholds are set so wide that it misses nearly everything real. The black-box
model has the opposite problem: strong in-distribution accuracy, and a 27.65 %
false-alarm rate because high-altitude telemetry looks anomalous to a model with
no physics baseline for derating. That gap between 27.65 % and 2.18 % is the
entire argument for the residual representation, and
[`validation/ablation.py`](validation/ablation.py) isolates it directly.

The 1 ms figure is the full chain — physics, EKF, both networks, SHAP, RUL —
against a 150 ms budget. Profile it on your own hardware with
[`tools/edge_benchmark_profiler.py`](tools/edge_benchmark_profiler.py).

The MVEM itself is checked against published VRDE derating data: 200 HP at sea
level and 10,000 ft, 150 HP at 20,000 ft, 110 HP at 30,000 ft, fitted to
0.00 HP RMSE on power and 0.025 bar on manifold pressure.

---

## Checking the claims yourself

Every number above comes out of a script in this repository.

```bash
python test_simulation.py                  # MVEM, sensor dynamics, flight profiles
python test_ai_layer.py                    # EKF convergence, autoencoder, classifier, RUL, SHAP
python test_fault_pipeline_qa.py           # end-to-end detection, all nine failure modes
python validation/benchmark.py             # the comparison table above
python validation/ablation.py              # which architectural choice is load-bearing
python validation/leakage_audit.py         # train/test separation integrity
python validation/stress_testing.py        # +500 % noise, 10–30 s blackouts, 35,000 ft, −60 °C
python run_all_tests.py                    # all of it, one report
```

The ablation suite is the interesting one if you are sceptical. It strips the
architecture down one piece at a time — physics residuals vs. raw telemetry,
two-stage gating vs. continuous inference, sensor decoupling on and off, and
training on 25 % / 50 % / 100 % of the data — so you can see which claims
survive and which were doing nothing.

---

## Porting to another engine

The twin is not welded to one powerplant. An engine is a JSON file:

| Config | Engine | Displacement | Rated power | Rated RPM | Modelled ceiling |
|:--|:--|:--:|:--:|:--:|:--:|
| [`engine_config.json`](configs/engine_config.json) | DRDO/VRDE 2.2 L turbo aero-diesel | 2.2 L | 200 HP | 4,200 | 30,000 ft |
| [`rotax_914_config.json`](configs/rotax_914_config.json) | Rotax 914 UL turbo flat-four | 1.211 L | 115 HP | 5,800 | 20,000 ft |

Each file carries geometry, the altitude derating curve, nominal operating
parameters and per-channel sensor specifications. Moving to a new engine is
configuration plus recalibration, not a rewrite — which is a direct consequence
of diagnosing on normalized residuals instead of absolute values.
[`tools/test_multi_engine_transfer.py`](tools/test_multi_engine_transfer.py)
exercises that path against the Rotax.

---

## What this is not

Worth being blunt about the boundaries.

This is a research and demonstration prototype. The engine is a model, the
sensors are a model, and the faults are injected. No hardware-in-the-loop
validation has been done, and nothing here is certified for airworthiness or
operational flight.

The fault taxonomy is nine failure modes plus healthy. Real engines fail in
compound and cascading ways that this taxonomy does not cover — though the
unsupervised trigger will still flag them as anomalous, it just will not name
them.

The MVEM is calibrated to a datasheet, not to a specific airframe's worn engine,
and it does not currently adapt online as an engine ages. The RUL interval is
constructed from the degradation trajectory rather than from a distribution-free
coverage guarantee; conformal prediction would be the honest upgrade.

Natural next steps, in order of usefulness: hardware-in-the-loop against a test
cell, profiling on flight-representative edge compute, an expanded fault
taxonomy, online baseline adaptation to per-airframe wear.

---

## Provenance

Built for Smart India Hackathon 2026, problem statement **SIH26054**
(*Robotics and Drones*, software category), proposed by the Defence Research and
Development Organisation.

Engine parameters follow published specifications for DRDO/VRDE-class 2.2 L
turbocharged aero-diesel and Rotax 914 UL powerplants. The submission dossier
and pitch deck are in [`docs/`](docs/), along with the generated figures.
