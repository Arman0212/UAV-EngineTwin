"""
Datasheet-Grounded Sensor Model for Aero Piston Engine Instrumentation.
Models physical sensor behavior:
- First-order lag (thermal time constants for thermocouples & RTDs)
- Realistic Gaussian measurement noise
- Finite ADC bit-depth & quantization step sizes
- Multi-rate asynchronous sampling
- Real-world failure modes (dropout, freezing, drift, rail clipping)
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
import math
import numpy as np

from .mvem import EngineState
from .flight_profile import FlightState

@dataclass
class SensorReadings:
    time_s: float
    # Flight Environment
    altitude_ft: float
    ambient_temp_c: float
    ambient_pressure_bar: float
    airspeed_mps: float
    throttle_pct: float
    # Primary Engine Channels
    rpm: float
    manifold_pressure_bar: float
    manifold_temp_c: float
    fuel_flow_lph: float
    oil_pressure_bar: float
    oil_temp_c: float
    coolant_temp_c: float
    # Multi-cylinder Exhaust & Cylinder Head Temperatures
    egt_c: List[float] # Cylinders 1, 2, 3, 4
    cht_c: List[float] # Cylinders 1, 2, 3, 4
    # Vibration & Electrical
    vibration_rms_g: float
    vibration_x_g: float
    vibration_y_g: float
    vibration_z_g: float
    bus_voltage_v: float
    # Channel Integrity Flags (for sensor-fault identification)
    channel_status: Dict[str, str] = field(default_factory=dict)
    provenance: str = "SIMULATED"


# ---------------------------------------------------------------------------
# Instrumentation, as configuration
# ---------------------------------------------------------------------------
# Which sensors an engine carries, and how they behave, is a property of the
# installation rather than of the simulator. These constants used to live in
# SensorModel.__init__, which meant every engine was instrumented identically
# no matter what its config said.
#
# The defaults below are exactly the values that were hardcoded, so an engine
# supplying no configuration is instrumented as it always has been.
#
# THREE FIELDS ARE HELD AT THE CODE VALUE ON PURPOSE
# --------------------------------------------------
# The shipped configs disagree with the code on three fields:
#
#     tau_oil_p   code 0.3    config oil_pressure.tau_lag_seconds      0.4
#     tau_map     code 0.08   config manifold_pressure.tau_lag_seconds 0.1
#     sigma_rpm   code 6.0    config rpm.noise_sigma_rpm               8.0
#
# The code values are the ones the shipped checkpoints were trained through,
# and the residual normaliser in digital_twin/health_index.py independently
# uses 6.0 for rpm with a comment tying it to this model. Honouring the config
# would change the reference engine and desynchronise the residuals from the
# trained pipeline.
#
# So they are listed in UNRECONCILED, the configured value is ignored, and the
# suite records that it happened rather than doing it quietly. Deciding which
# side is correct is a real change needing its own verification, and it is not
# this step's to make.
UNRECONCILED = ("tau_oil_p", "tau_map", "sigma_rpm")

# suite field -> (config group, config key)
CONFIG_MAP = {
    "tau_egt":     ("egt", "tau_lag_seconds"),
    "sigma_egt":   ("egt", "noise_sigma_celsius"),
    "quant_egt":   ("egt", "quantization"),
    "tau_cht":     ("cht", "tau_lag_seconds"),
    "sigma_cht":   ("cht", "noise_sigma_celsius"),
    "quant_cht":   ("cht", "quantization"),
    "tau_oil_p":   ("oil_pressure", "tau_lag_seconds"),
    "sigma_oil_p": ("oil_pressure", "noise_sigma_bar"),
    "quant_oil_p": ("oil_pressure", "quantization"),
    "tau_oil_t":   ("oil_temp", "tau_lag_seconds"),
    "sigma_oil_t": ("oil_temp", "noise_sigma_celsius"),
    "quant_oil_t": ("oil_temp", "quantization"),
    "tau_map":     ("manifold_pressure", "tau_lag_seconds"),
    "sigma_map":   ("manifold_pressure", "noise_sigma_bar"),
    "quant_map":   ("manifold_pressure", "quantization"),
    "tau_rpm":     ("rpm", "tau_lag_seconds"),
    "sigma_rpm":   ("rpm", "noise_sigma_rpm"),
    "quant_rpm":   ("rpm", "quantization"),
    "tau_fuel":    ("fuel_flow", "tau_lag_seconds"),
    "sigma_fuel":  ("fuel_flow", "noise_sigma_lph"),
    "quant_fuel":  ("fuel_flow", "quantization"),
    "sigma_vib":   ("vibration", "noise_sigma_g"),
    "quant_vib":   ("vibration", "quantization"),
    "tau_bus_v":   ("bus_voltage", "tau_lag_seconds"),
    "sigma_bus_v": ("bus_voltage", "noise_sigma_v"),
    "quant_bus_v": ("bus_voltage", "quantization"),
}

# Carried by the suite but absent from every shipped config, so it keeps the
# code value: the coolant probe's lag, which sample() used as a bare literal.
UNCONFIGURED = ("tau_coolant_t",)


@dataclass
class SensorSuite:
    """
    One engine's instrumentation: lag, noise and quantisation per channel.

    Field names match the attributes SensorModel has always exposed, because
    the simulation test and the stress harness reach for them by name.
    """
    # Type-K thermocouple (EGT)
    tau_egt: float = 2.0
    sigma_egt: float = 3.5
    quant_egt: float = 0.5
    # Type-J/ring thermocouple (CHT)
    tau_cht: float = 3.5
    sigma_cht: float = 1.8
    quant_cht: float = 0.2
    # Piezoresistive pressure (oil)
    tau_oil_p: float = 0.3
    sigma_oil_p: float = 0.06
    quant_oil_p: float = 0.02
    # Sump RTD (oil temperature)
    tau_oil_t: float = 4.0
    sigma_oil_t: float = 0.9
    quant_oil_t: float = 0.1
    # Coolant RTD: no configured counterpart in any shipped engine
    tau_coolant_t: float = 3.0
    # Manifold absolute pressure
    tau_map: float = 0.08
    sigma_map: float = 0.02
    quant_map: float = 0.01
    # Optical/Hall tachometer
    tau_rpm: float = 0.05
    sigma_rpm: float = 6.0
    quant_rpm: float = 1.0
    # Turbine fuel flow meter
    tau_fuel: float = 0.8
    sigma_fuel: float = 0.35
    quant_fuel: float = 0.05
    # IEPE triaxial accelerometer: not lagged, so it carries no tau
    sigma_vib: float = 0.08
    quant_vib: float = 0.01
    # Bus voltage ADC
    tau_bus_v: float = 0.1
    sigma_bus_v: float = 0.12
    quant_bus_v: float = 0.05

    # Where these values came from, and what was not taken from there.
    source: str = "built-in defaults"
    overridden: tuple = ()
    missing: tuple = ()

    @classmethod
    def from_config(cls, config, source: str = "engine config",
                    honour_unreconciled: bool = False) -> "SensorSuite":
        """
        Builds a suite from an engine config's ``sensor_specifications``.

        A field absent from the config keeps its default and is reported in
        ``missing`` rather than guessed at. The fields in UNRECONCILED keep the
        code value and are reported in ``overridden``.

        :param honour_unreconciled: take the configured value for those fields
            too. Off by default, because turning it on changes the reference
            engine and the residual scaling it was trained with.
        """
        spec = (config or {}).get("sensor_specifications") or {}
        values, overridden, missing = {}, [], []
        for field_name, (group, key) in CONFIG_MAP.items():
            configured = (spec.get(group) or {}).get(key)
            if configured is None:
                missing.append(f"{group}.{key}")
                continue
            if field_name in UNRECONCILED and not honour_unreconciled:
                overridden.append(f"{field_name} (config {group}.{key}={configured})")
                continue
            values[field_name] = float(configured)
        return cls(source=source, overridden=tuple(overridden),
                   missing=tuple(missing), **values)


# The attributes SensorModel copies out of a suite onto itself.
SUITE_FIELDS = tuple(CONFIG_MAP) + UNCONFIGURED


class SensorModel:
    """
    Simulates physical instrumentation with true sensor characteristics.
    """
    def __init__(self, seed: Optional[int] = None,
                 suite: Optional[SensorSuite] = None):
        self.rng = np.random.default_rng(seed)

        # Lag States (Internal filter registers for steady-state cruise)
        # Sized on first sample from the engine actually being measured. A
        # fixed four broke the moment a twin or a six was fitted: the MVEM
        # produced two EGT channels and this iterated over four.
        self._lag_egt: List[float] = []
        self._lag_cht: List[float] = []
        self._lag_oil_p = 4.2
        self._lag_oil_t = 88.0
        self._lag_coolant_t = 86.0
        self._lag_map = 1.013
        self._lag_rpm = 1400.0
        self._lag_fuel_flow = 10.0
        self._lag_bus_v = 28.0

        # Physical sensor parameters, from this engine's instrumentation.
        # Copied onto the model under the names they have always had,
        # because the simulation test and the stress harness mutate them
        # directly.
        self.suite = suite or SensorSuite()
        for _field in SUITE_FIELDS:
            setattr(self, _field, getattr(self.suite, _field))

        # Active Sensor Fault Overrides (for testing & sensor-vs-engine fault discrimination)
        self.fault_overrides: Dict[str, Dict[str, Any]] = {}

    def set_sensor_fault(self, channel: str, fault_type: str, value: Optional[float] = None):
        """
        Injects a physical sensor defect (e.g. 'FROZEN', 'BIAS', 'DROPOUT', 'OPEN_CIRCUIT', 'NOISY').
        """
        self.fault_overrides[channel] = {"type": fault_type, "value": value}

    def clear_sensor_faults(self):
        self.fault_overrides.clear()

    def _quantize(self, val: float, step: float) -> float:
        return round(round(val / step) * step, 4)

    def sample(self, true_engine: EngineState, flight: FlightState, dt_s: float = 0.05) -> SensorReadings:
        """
        Samples the continuous ground-truth physical engine state through the realistic sensor pipeline.
        """
        status_flags = {}

        # 1. Update First-Order Lags
        # x_lag += (x_true - x_lag) * (1 - exp(-dt / tau))
        def update_lag(curr_lag, target, tau):
            alpha = 1.0 - math.exp(-dt_s / max(1e-4, tau))
            return curr_lag + (target - curr_lag) * alpha

        self._lag_rpm = update_lag(self._lag_rpm, true_engine.rpm, self.tau_rpm)
        self._lag_map = update_lag(self._lag_map, true_engine.manifold_pressure_bar, self.tau_map)
        self._lag_oil_p = update_lag(self._lag_oil_p, true_engine.oil_pressure_bar, self.tau_oil_p)
        self._lag_oil_t = update_lag(self._lag_oil_t, true_engine.oil_temp_c, self.tau_oil_t)
        self._lag_coolant_t = update_lag(
            self._lag_coolant_t, true_engine.coolant_temp_c, self.tau_coolant_t)
        self._lag_fuel_flow = update_lag(self._lag_fuel_flow, true_engine.fuel_flow_lph, self.tau_fuel)
        self._lag_bus_v = update_lag(self._lag_bus_v, true_engine.bus_voltage_v, self.tau_bus_v)

        n_cyl = len(true_engine.egt_c)
        if len(self._lag_egt) != n_cyl:
            # Seed from the engine's own state so a newly fitted engine does not
            # spend its first seconds lagging toward the previous one's numbers.
            self._lag_egt = list(true_engine.egt_c)
            self._lag_cht = list(true_engine.cht_c)

        for i in range(n_cyl):
            self._lag_egt[i] = update_lag(self._lag_egt[i], true_engine.egt_c[i], self.tau_egt)
            self._lag_cht[i] = update_lag(self._lag_cht[i], true_engine.cht_c[i], self.tau_cht)

        # 2. Add Measurement Noise & Quantization
        rpm_meas = self._quantize(self._lag_rpm + self.rng.normal(0, self.sigma_rpm), self.quant_rpm)
        map_meas = self._quantize(max(0.0, self._lag_map + self.rng.normal(0, self.sigma_map)), self.quant_map)
        oil_p_meas = self._quantize(max(0.0, self._lag_oil_p + self.rng.normal(0, self.sigma_oil_p)), self.quant_oil_p)
        oil_t_meas = self._quantize(self._lag_oil_t + self.rng.normal(0, self.sigma_oil_t), self.quant_oil_t)
        coolant_t_meas = self._quantize(self._lag_coolant_t + self.rng.normal(0, 0.8), 0.1)
        fuel_meas = self._quantize(max(0.0, self._lag_fuel_flow + self.rng.normal(0, self.sigma_fuel)), self.quant_fuel)
        bus_v_meas = self._quantize(max(0.0, self._lag_bus_v + self.rng.normal(0, self.sigma_bus_v)), self.quant_bus_v)

        egt_meas = []
        cht_meas = []
        for i in range(n_cyl):
            e_val = self._quantize(self._lag_egt[i] + self.rng.normal(0, self.sigma_egt), self.quant_egt)
            c_val = self._quantize(self._lag_cht[i] + self.rng.normal(0, self.sigma_cht), self.quant_cht)
            egt_meas.append(e_val)
            cht_meas.append(c_val)

        vib_rms_meas = self._quantize(max(0.0, true_engine.vibration_rms_g + self.rng.normal(0, self.sigma_vib)), self.quant_vib)
        vib_x_meas = self._quantize(true_engine.vibration_x_g + self.rng.normal(0, self.sigma_vib), self.quant_vib)
        vib_y_meas = self._quantize(true_engine.vibration_y_g + self.rng.normal(0, self.sigma_vib), self.quant_vib)
        vib_z_meas = self._quantize(true_engine.vibration_z_g + self.rng.normal(0, self.sigma_vib), self.quant_vib)

        # 3. Apply Active Sensor Faults / Defects if Triggered
        for ch, fault in self.fault_overrides.items():
            f_type = fault["type"]
            if ch == "egt_3":
                # The channel is named for the reference engine's third
                # cylinder. A twin has no third cylinder, and writing index 2
                # raised IndexError; the probe is placed on the last cylinder
                # the engine actually has instead. No change at three or more.
                idx = min(2, len(egt_meas) - 1)
                if f_type == "OPEN_CIRCUIT":
                    egt_meas[idx] = round(flight.ambient_temp_c + self.rng.normal(0, 1.0), 1) # Reads ambient
                    status_flags["egt_3"] = "SENSOR_OPEN_CIRCUIT"
                elif f_type == "FROZEN":
                    egt_meas[idx] = 520.0
                    status_flags["egt_3"] = "SENSOR_FROZEN"
                elif f_type == "BIAS":
                    egt_meas[idx] += fault.get("value", 120.0)
                    status_flags["egt_3"] = "SENSOR_BIAS"
            elif ch == "oil_pressure":
                if f_type == "DROPOUT":
                    oil_p_meas = 0.0
                    status_flags["oil_pressure"] = "SENSOR_DROPOUT"
                elif f_type == "NOISY":
                    oil_p_meas += self.rng.normal(0, 1.2)
                    status_flags["oil_pressure"] = "SENSOR_EXCESSIVE_NOISE"
            elif ch == "rpm":
                if f_type == "GLITCH":
                    rpm_meas = 0.0 if self.rng.random() < 0.25 else rpm_meas
                    status_flags["rpm"] = "SENSOR_INTERMITTENT_GLITCH"

        return SensorReadings(
            time_s=round(flight.time_s, 2),
            altitude_ft=round(flight.altitude_ft, 1),
            ambient_temp_c=round(flight.ambient_temp_c, 2),
            ambient_pressure_bar=round(flight.ambient_pressure_bar, 4),
            airspeed_mps=round(flight.airspeed_mps, 2),
            throttle_pct=round(flight.throttle_pct, 2),
            rpm=round(rpm_meas, 1),
            manifold_pressure_bar=round(map_meas, 3),
            manifold_temp_c=round(self._lag_map, 1),
            fuel_flow_lph=round(fuel_meas, 2),
            oil_pressure_bar=round(oil_p_meas, 2),
            oil_temp_c=round(oil_t_meas, 1),
            coolant_temp_c=round(coolant_t_meas, 1),
            egt_c=[round(t, 1) for t in egt_meas],
            cht_c=[round(t, 1) for t in cht_meas],
            vibration_rms_g=round(vib_rms_meas, 3),
            vibration_x_g=round(vib_x_meas, 3),
            vibration_y_g=round(vib_y_meas, 3),
            vibration_z_g=round(vib_z_meas, 3),
            bus_voltage_v=round(bus_v_meas, 2),
            channel_status=status_flags,
            provenance="SIMULATED"
        )
