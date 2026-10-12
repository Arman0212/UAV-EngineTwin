"""
Fault injection for the aero piston engine digital twin.

The failure modes and their coefficients live in configuration, under
engines/<engine-id>/faults.json with a shared default library. This module
applies them: it reads a definition, works out what severity means for each
effect, and writes the result onto the engine model's own attributes.

The enum below stays. The ids are a stable contract shared by the classifier's
output classes, the REST API, the dashboard controls, the recorded flight logs
and the training set generator, so they are identifiers rather than an
implementation. What used to be the implementation -- nine branches naming an
attribute and a magic number -- is now data.
"""
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Dict, Any
import numpy as np

from core.fault_library import FaultLibrary, load_for
from .mvem import MeanValueEngineModel
from .sensors import SensorModel

class FaultType(str, Enum):
    HEALTHY = "HEALTHY"
    LEAN_MIXTURE_CYL3 = "LEAN_MIXTURE_CYL3"
    RICH_MIXTURE_CYL1 = "RICH_MIXTURE_CYL1"
    COOLING_DEGRADATION_CYL2 = "COOLING_DEGRADATION_CYL2"
    OIL_PRESSURE_LOSS = "OIL_PRESSURE_LOSS"
    TURBO_BOOST_DEFICIENCY = "TURBO_BOOST_DEFICIENCY"
    CYLINDER_MISFIRE_TIMING = "CYLINDER_MISFIRE_TIMING"
    BEARING_WEAR_VIBRATION = "BEARING_WEAR_VIBRATION"
    SENSOR_FAULT_EGT3 = "SENSOR_FAULT_EGT3"
    ELECTRICAL_VOLTAGE_SAG = "ELECTRICAL_VOLTAGE_SAG"

@dataclass
class FaultConfig:
    fault_type: FaultType
    start_time_s: float
    ramp_duration_s: float = 10.0   # Time over which fault evolves (0 for abrupt step)
    severity: float = 1.0           # 0.0 to 1.0 fault severity multiplier
    target_cylinder: int = 2        # 0-indexed cylinder (e.g. 2 = Cyl 3)

class FaultInjector:
    """
    Manages active faults and dynamically modifies MVEM physics parameters
    and sensor properties as a function of simulation time.
    """
    def __init__(self, mvem: MeanValueEngineModel, sensors: SensorModel,
                 library: Optional[FaultLibrary] = None):
        """
        :param library: the fault definitions available to this engine. Defaults
            to the shared library, which is what every caller that predates
            per-engine faults gets.
        """
        self.mvem = mvem
        self.sensors = sensors
        self.library = library or load_for()
        self.active_fault: Optional[FaultConfig] = None
        self.current_severity: float = 0.0

    def inject_fault(self, fault: FaultConfig):
        """Activates a specific fault schedule."""
        self.active_fault = fault
        self.current_severity = 0.0

    def clear_faults(self):
        """
        Returns the engine and its instrumentation to healthy.

        Every target any defined fault can touch is restored, derived from the
        library rather than listed here, so a fault cannot be added without its
        reset. This runs on every healthy tick, which is why the per-cylinder
        arrays are rebuilt at the engine's own cylinder count: a fixed length
        silently resized them and the next physics step indexed past the end.
        """
        self.active_fault = None
        self.current_severity = 0.0

        n_cyl = self.mvem.cylinders
        for target, _cylinder, healthy in self.library.reset_targets():
            current = getattr(self.mvem, target, None)
            if isinstance(current, list):
                setattr(self.mvem, target, [healthy] * n_cyl)
            else:
                setattr(self.mvem, target, healthy)
        self.sensors.clear_sensor_faults()

    def update(self, current_time_s: float):
        """
        Advances the active fault and writes its effects onto the engine.

        Severity ramps linearly from zero to the requested level over the
        configured duration; a definition whose response is binary ignores it,
        which the definition says outright rather than leaving to be discovered.
        """
        if not self.active_fault or self.active_fault.fault_type == FaultType.HEALTHY:
            self.clear_faults()
            return

        cfg = self.active_fault
        if current_time_s < cfg.start_time_s:
            self.current_severity = 0.0
            return

        if cfg.ramp_duration_s <= 0.0:
            sev = cfg.severity
        else:
            elapsed = current_time_s - cfg.start_time_s
            progress = min(1.0, max(0.0, elapsed / cfg.ramp_duration_s))
            sev = cfg.severity * progress

        self.current_severity = sev

        fault_id = getattr(cfg.fault_type, "value", str(cfg.fault_type))
        definition = self.library.get(fault_id)
        if definition is None:
            # Only reachable if the library is missing a fault the API accepted,
            # which is a configuration error and should not pass quietly.
            raise ValueError(
                f"{fault_id!r} is not defined in {self.library.source}; "
                f"available: {sorted(self.library.ids())}")

        for effect in definition.effects:
            if effect.kind == "sensor_override":
                self.sensors.set_sensor_fault(effect.target, effect.mode)
                continue

            value = effect.value_at(sev)
            current = getattr(self.mvem, effect.target)
            if isinstance(current, list):
                index = effect.cylinder_index(cfg.target_cylinder, self.mvem.cylinders)
                current[index] = value
            else:
                setattr(self.mvem, effect.target, value)
