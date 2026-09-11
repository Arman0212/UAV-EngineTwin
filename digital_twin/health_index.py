"""
Physics-Anchored Health Index Engine (SIH26054)
Calculates continuous 0–100% health scores across engine subsystems based on
normalized residuals against the MVEM expectation:
    Health_sub = 100 * exp(-alpha * |(y_meas - y_mvem) / sigma|)
"""
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
import json
import math
import numpy as np

from .twin_state import SubsystemHealth, StateLevel

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "configs" / "engine_config.json"


@dataclass
class EndOfLifeCriterion:
    """
    One subsystem's end-of-life condition, stated in engine units and carrying
    the health-index value that condition corresponds to.

    The direction of the derivation matters: the physical limit is the input and
    the health percentage is the output. Health index is a presentation layer
    over residuals, and its alphas are hand-tuned; expressing condemnation in
    those units would mean the fleet's retirement criterion moves whenever
    somebody retunes a display constant.
    """
    subsystem: str
    criterion: str
    channel: str
    limit_value: float
    limit_units: str
    nominal_value: float
    at_condition: str
    deviation_physical: float     # |nominal - limit| in the channel's own units
    deviation_sigma: float        # the same deviation in sensor sigmas
    health_at_limit: float        # what the health index reads there
    operator_text: str
    source: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def projected_text(self, hours_min: float, hours_max: float) -> str:
        """e.g. 'oil pressure projected to reach 2.0 bar in 18.0-25.0 flight hours'."""
        what = self.operator_text.format(limit=self.limit_value)
        return f"{what} in {hours_min:.1f}-{hours_max:.1f} flight hours"

class HealthIndexEngine:
    """
    Subsystem Health Calculation Engine.
    Employs calibrated exponential decay on normalized residuals with safety-critical weighting.
    """
    def __init__(self):
        # Baseline Sensor Sigmas (Calibrated from datasheet model)
        self.sigma = {
            "egt": 3.5,            # Celsius
            "cht": 1.8,            # Celsius
            "oil_pressure": 0.06,  # bar
            "oil_temp": 0.9,       # Celsius
            "manifold_pressure": 0.02, # bar
            "rpm": 6.0,            # RPM (matches SensorModel.sigma_rpm)
            "fuel_flow": 0.35,     # LPH
            "vibration_rms": 0.08, # g
            "bus_voltage": 0.12    # V
        }

        # Sensitivity Factors (alpha) tuned so fault-onset thresholds map to 50-70% (Caution band)
        self.alpha = {
            "egt": 0.10,
            "cht": 0.15,
            "oil_pressure": 0.18,
            "oil_temp": 0.12,
            "manifold_pressure": 0.14,
            "rpm": 0.10,
            "fuel_flow": 0.10,
            "vibration_rms": 0.20,
            "bus_voltage": 0.12
        }

        # Subsystem Weights for Composite Health Score
        self.weights = {
            "oil_system": 0.25,
            "cylinders": 0.30,
            "turbo_boost": 0.15,
            "vibration": 0.15,
            "electrical": 0.08,
            "cooling": 0.07
        }

    # -----------------------------------------------------------------
    # Physical limits -> health index
    # -----------------------------------------------------------------
    def health_at_physical_deviation(self, channel_key: str, deviation_physical: float) -> float:
        """
        The health index value a deviation of the given physical size produces on
        this channel, under the current sigma and alpha.

        This is the bridge between an engine limit ("oil pressure 2.0 bar") and
        the units the index happens to be expressed in. It applies the same
        sigma normalisation, deadband and exponential the live path applies, so
        the number it returns is the number the running system would report.
        """
        sigma = self.sigma.get(channel_key)
        if sigma is None:
            raise KeyError(f"no sigma calibrated for channel {channel_key!r}")
        residual_norm = abs(deviation_physical) / sigma
        return self._calc_subscore(residual_norm, channel_key)

    def end_of_life_criteria(
        self, config_path: Optional[Any] = None
    ) -> Dict[str, EndOfLifeCriterion]:
        """
        Loads the per-subsystem end-of-life limits from an engine config and maps
        each to its health-index equivalent.

        The limits are physical and come from the config; the percentages are
        derived here. Swapping in another engine's config swaps the limits
        without touching any code.
        """
        path = Path(config_path) if config_path is not None else DEFAULT_CONFIG_PATH
        config = json.loads(Path(path).read_text())
        limits = config.get("end_of_life_limits", {})

        criteria: Dict[str, EndOfLifeCriterion] = {}
        for subsystem, spec in limits.items():
            if subsystem.startswith("_"):
                continue
            channel = spec["channel"]
            deviation = abs(float(spec["nominal_value"]) - float(spec["limit_value"]))
            # Turbo is already stated as a deficit rather than an absolute, so
            # the figure in the config IS the deviation.
            if "deficit" in spec.get("limit_units", ""):
                deviation = abs(float(spec["limit_value"]))
            health_at_limit = self.health_at_physical_deviation(channel, deviation)
            # A limit that maps to near-full health is a config error, not a very
            # healthy engine: it means nominal and limit were set to the same
            # value, and projecting to it would condemn the engine immediately.
            if health_at_limit > 60.0:
                raise ValueError(
                    f"end-of-life limit for {subsystem!r} maps to {health_at_limit:.1f}% health "
                    f"({deviation:g} {spec.get('limit_units','')} = "
                    f"{deviation / self.sigma[channel]:.1f} sigma). Check nominal_value against "
                    f"limit_value in the engine config.")
            criteria[subsystem] = EndOfLifeCriterion(
                subsystem=subsystem,
                criterion=spec["criterion"],
                channel=channel,
                limit_value=float(spec["limit_value"]),
                limit_units=spec["limit_units"],
                nominal_value=float(spec["nominal_value"]),
                at_condition=spec.get("at_condition", ""),
                deviation_physical=round(deviation, 4),
                deviation_sigma=round(deviation / self.sigma[channel], 2),
                health_at_limit=health_at_limit,
                operator_text=spec.get("operator_text", f"{channel} projected to reach {{limit}}"),
                source=spec.get("source", ""),
            )
        return criteria

    def compute_residuals(
        self,
        sensor_data: Dict[str, Any],
        mvem_expected: Dict[str, Any]
    ) -> Dict[str, float]:
        """
        Calculates normalized residuals: r_norm = (y_sensor - y_mvem) / sigma
        """
        residuals = {}
        # Scalar channels
        for ch in ["oil_pressure", "oil_temp", "manifold_pressure", "rpm", "fuel_flow", "vibration_rms", "bus_voltage"]:
            if ch in sensor_data and ch in mvem_expected:
                diff = sensor_data[ch] - mvem_expected[ch]
                sig = self.sigma.get(ch, 1.0)
                residuals[ch] = round(diff / sig, 3)

        # Multi-cylinder channels
        for i in range(4):
            # EGT
            s_egt = sensor_data["egt_c"][i]
            m_egt = mvem_expected["egt_c"][i]
            residuals[f"egt_cyl_{i+1}"] = round((s_egt - m_egt) / self.sigma["egt"], 3)
            # CHT
            s_cht = sensor_data["cht_c"][i]
            m_cht = mvem_expected["cht_c"][i]
            residuals[f"cht_cyl_{i+1}"] = round((s_cht - m_cht) / self.sigma["cht"], 3)

        return residuals

    def _calc_subscore(self, residual_norm: float, channel_key: str) -> float:
        """
        Computes exponential health sub-score 0-100%.
        Applies a 2.5-sigma noise deadband so normal Gaussian measurement noise
        does not degrade healthy nominal baseline.
        """
        eff_norm = max(0.0, abs(residual_norm) - 2.5)
        a = self.alpha.get(channel_key, 0.15)
        score = 100.0 * math.exp(-a * eff_norm)
        return max(0.0, min(100.0, round(score, 1)))

    def evaluate_health(self, residuals: Dict[str, float]) -> SubsystemHealth:
        """
        Evaluates subsystem and composite engine health from normalized residuals.
        """
        # 1. Oil System Health (fused pressure & temperature)
        oil_p_score = self._calc_subscore(residuals.get("oil_pressure", 0.0), "oil_pressure")
        oil_t_score = self._calc_subscore(residuals.get("oil_temp", 0.0), "oil_temp")
        oil_health = min(oil_p_score, oil_t_score * 1.05)

        # 2. Per-Cylinder Health (Cyl 1 to 4)
        cyl_scores = []
        for i in range(4):
            egt_score = self._calc_subscore(residuals.get(f"egt_cyl_{i+1}", 0.0), "egt")
            cht_score = self._calc_subscore(residuals.get(f"cht_cyl_{i+1}", 0.0), "cht")
            cyl_scores.append(min(egt_score, cht_score))

        # 3. Turbocharger / Manifold Boost Health
        turbo_health = self._calc_subscore(residuals.get("manifold_pressure", 0.0), "manifold_pressure")

        # 4. Mechanical Vibration Health
        vib_health = self._calc_subscore(residuals.get("vibration_rms", 0.0), "vibration_rms")

        # 5. Electrical Bus Health
        elec_health = self._calc_subscore(residuals.get("bus_voltage", 0.0), "bus_voltage")

        # 6. Cooling System Health (driven by CHT average)
        cooling_health = float(np.mean([self._calc_subscore(residuals.get(f"cht_cyl_{i+1}", 0.0), "cht") for i in range(4)]))

        # Composite Engine Health Score (Weighted sum with conservative safety bottleneck)
        avg_cyl_health = float(np.mean(cyl_scores))
        min_cyl_health = float(np.min(cyl_scores))

        weighted_health = (
            oil_health * self.weights["oil_system"] +
            avg_cyl_health * self.weights["cylinders"] +
            turbo_health * self.weights["turbo_boost"] +
            vib_health * self.weights["vibration"] +
            elec_health * self.weights["electrical"] +
            cooling_health * self.weights["cooling"]
        )

        # Safety-Critical Bottleneck Rule: If a single safety subsystem fails critically (e.g. oil loss),
        # overall health cannot pretend to be 90% healthy.
        overall_health = min(weighted_health, min(oil_health, min_cyl_health) * 1.15)
        overall_health = max(0.0, min(100.0, round(overall_health, 1)))

        # Determine Operational Status Level
        if overall_health >= 85.0:
            status = StateLevel.NOMINAL
        elif overall_health >= 70.0:
            status = StateLevel.ADVISORY
        elif overall_health >= 50.0:
            status = StateLevel.CAUTION
        elif overall_health >= 25.0:
            status = StateLevel.WARNING
        else:
            status = StateLevel.CRITICAL

        return SubsystemHealth(
            overall_health=overall_health,
            cylinder_health=[round(c, 1) for c in cyl_scores],
            oil_system_health=round(oil_health, 1),
            turbo_boost_health=round(turbo_health, 1),
            vibration_health=round(vib_health, 1),
            electrical_health=round(elec_health, 1),
            cooling_system_health=round(cooling_health, 1),
            status_level=status
        )
