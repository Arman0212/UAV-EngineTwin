"""
The fitted powerplant, as one object.

WHY THIS EXISTS
---------------
Everything that belongs to a particular engine used to be assembled inline in
the service runtime, and again in the fallback server, and again in every test
and tool: two engine models, a sensor model, a fault injector and a state
estimator, each constructed in the right order with the right arguments. Fitting
a different engine meant repeating that sequence correctly, and "correctly"
included details that are easy to miss, such as rebuilding the healthy baseline
alongside the faulted plant so residuals keep reporting a fault rather than the
difference between two engines.

EngineContext holds that group. It owns only what is specific to one engine.

WHAT IS DELIBERATELY NOT HERE
-----------------------------
The AI layer, the health index, remaining-life estimation and the baseline
adapter stay outside. They are currently bound to the reference engine rather
than to the fitted one, and moving them in would imply a per-engine binding that
does not exist yet. That binding is a later step, and doing it here would change
behaviour under cover of a structural change.

THE TWO WAYS AN ENGINE ARRIVES
------------------------------
`boot()` and `fitted()` are separate on purpose, and they are not equivalent.

The service starts with the engine model's own built-in defaults. Fitting the
reference engine from the picker instead reads configs/engine_config.json. Those
two are *not* the same engine: min_rpm is 1200.0 against 1199.8, the sea-level
boost point is 2.45 bar against 2.40, and power_mid_map_bar is 2.1 against 2.4.
Over 1200 ticks the two diverge by about 8 rpm, from the first tick onward.

The defaults are the authoritative ones: the training set was generated from a
model built with no config, so the shipped checkpoints describe that engine, and
the 10,800-tick regression is pinned to it. The config file is the copy that has
drifted. Reconciling them is a real fix, but it is a change in behaviour and
belongs in its own step with its own verification, so `boot()` preserves the
defaults exactly as the runtime has always used them.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from digital_twin.state_estimator import PhysicsAnchoredKalmanEstimator
from simulation import engine_registry
from simulation.engine_spec import EngineSpec
from simulation.fault_injector import FaultInjector
from simulation.mvem import MeanValueEngineModel
from simulation.sensors import SensorModel, SensorSuite

# The seed the service has always started its sensor model with. Fitting or
# resetting reseeds from the clock instead, so a fresh sortie is not a replay of
# the same noise.
BOOT_SENSOR_SEED = 42


@dataclass
class EngineContext:
    """
    One fitted powerplant and the per-engine objects that simulate it.

    :param engine_id: registry id, or the reference id for the boot engine.
    :param name: display name, as the operator sees it.
    :param config: the registry config this engine came from, or None when the
        engine model's built-in defaults were used. Kept for display and for
        downstream consumers that need the engine's declared limits.
    :param spec: the parameterisation the physics actually runs on.
    :param plant: the engine faults are injected into.
    :param baseline: the healthy twin of the same engine, which is what makes a
        residual mean "this engine is off its own normal".
    :param sensors: instrumentation, including its lag, noise and quantisation.
    :param sensor_suite: the instrumentation specification the sensors were
        built from, kept so a reset rebuilds the same installation and so the
        service can report where those values came from.
    :param injector: applies an active fault to the plant and its sensors.
    :param estimator: fuses measurement with the physics prediction.
    """

    engine_id: str
    name: str
    config: Optional[Dict[str, Any]]
    spec: EngineSpec
    plant: MeanValueEngineModel
    baseline: MeanValueEngineModel
    sensors: SensorModel
    sensor_suite: SensorSuite
    injector: FaultInjector
    estimator: PhysicsAnchoredKalmanEstimator

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    @classmethod
    def boot(cls, sensor_seed: int = BOOT_SENSOR_SEED) -> "EngineContext":
        """
        The powerplant the service starts on.

        Built from the engine model's own defaults rather than from the
        reference config file. See the module docstring: the two differ, and the
        defaults are the ones the shipped checkpoints were trained on.
        """
        return cls._assemble(
            engine_id=engine_registry.REFERENCE_ID,
            name="DRDO-VRDE-2.2L-Turbo-AeroDiesel",
            config=None,
            spec=EngineSpec(),
            # No config, so the instrumentation defaults, which are the values
            # the sensor model has always used.
            sensor_suite=SensorSuite(),
            sensor_seed=sensor_seed,
        )

    @classmethod
    def fitted(cls, engine_id: str, sensor_seed: Optional[int] = None) -> "EngineContext":
        """
        Builds the engine registered under ``engine_id``.

        :raises ValueError: if no engine is registered under that id. The service
            turns this into a 404, so the message is part of the API surface.
        """
        config = engine_registry.get_config(engine_id)
        if config is None:
            raise ValueError(f"No such engine: {engine_id}")

        return cls._assemble(
            engine_id=engine_id,
            name=config.get("engine_name", engine_id),
            config=config,
            spec=EngineSpec.from_config(config),
            # This engine's own instrumentation. Fields the config omits keep
            # the default, and the three the configs disagree with the code on
            # are held at the code value; the suite reports both.
            sensor_suite=SensorSuite.from_config(config, source=engine_id),
            sensor_seed=int(time.time()) if sensor_seed is None else sensor_seed,
        )

    @classmethod
    def _assemble(cls, engine_id, name, config, spec, sensor_suite,
                  sensor_seed) -> "EngineContext":
        """
        Builds the object graph in the one order that is correct.

        The plant and the healthy baseline are built from the same spec, and the
        injector is attached to the plant rather than the baseline: the baseline
        has to stay healthy or every residual becomes meaningless.
        """
        # The engine model takes the raw config, not the spec, because that is
        # the interface it has always had; passing None selects its defaults.
        plant = MeanValueEngineModel(config=config)
        baseline = MeanValueEngineModel(config=config)
        sensors = SensorModel(seed=sensor_seed, suite=sensor_suite)
        return cls(
            engine_id=engine_id,
            name=name,
            config=config,
            spec=spec,
            plant=plant,
            baseline=baseline,
            sensors=sensors,
            sensor_suite=sensor_suite,
            injector=FaultInjector(plant, sensors),
            estimator=PhysicsAnchoredKalmanEstimator(),
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def reset(self, sensor_seed: Optional[int] = None) -> None:
        """
        Restarts the sortie on the same engine.

        The engine models are reset in place, keeping their build variant, which
        is a property of the unit rather than of the run. Instrumentation, the
        injector and the estimator are rebuilt, so no fault, lag register or
        covariance carries across.
        """
        self.plant.reset(idle=False)
        self.baseline.reset(idle=False)
        self.sensors = SensorModel(
            seed=int(time.time()) if sensor_seed is None else sensor_seed,
            suite=self.sensor_suite)
        self.injector = FaultInjector(self.plant, self.sensors)
        self.estimator = PhysicsAnchoredKalmanEstimator()

    # ------------------------------------------------------------------
    # Facts about this engine
    # ------------------------------------------------------------------
    @property
    def cylinders(self) -> int:
        return self.spec.cylinders

    @property
    def is_reference(self) -> bool:
        return self.engine_id == engine_registry.REFERENCE_ID

    @property
    def diagnosis_calibrated(self) -> bool:
        """
        Whether the shipped AI checkpoints describe this engine.

        They were trained on the reference engine's residuals, so on any other
        powerplant the physics is right and the diagnosis is indicative. The
        service reports this to the operator rather than leaving them to assume.
        """
        return self.is_reference

    def summary(self) -> Dict[str, Any]:
        """The identity the service returns when an engine is fitted."""
        return {"id": self.engine_id, "name": self.name, "is_reference": self.is_reference}
