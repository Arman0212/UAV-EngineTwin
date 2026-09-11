"""
Physics-Informed Remaining Useful Life (RUL) Estimator (SIH26054)
Projects degradation trajectories to critical maintenance limits and outputs
uncertainty-bounded prediction intervals (e.g., [18, 25] flight hours).

End-of-life is defined per subsystem, in engine units, in configs/*.json --
oil pressure in bar, CHT in Celsius, boost deficit in bar, 2X vibration in g,
bus voltage in volts. HealthIndexEngine.end_of_life_criteria() maps each of
those to the health-index value it corresponds to under the current sigma and
alpha, and this estimator projects the DEGRADING SUBSYSTEM to ITS OWN limit.

The previous fixed critical_health_threshold=30.0 expressed condemnation in
units of our own display tuning: retune an alpha and the fleet's retirement
criterion moves. It was also uniform across subsystems that fail in entirely
different ways. Measured against the physical limits, 30% turned out to be far
more conservative than any of them -- the stated limits map to 0.1%-12.2% health
on the VRDE engine -- so the old threshold condemned engines well before they
reached any limit anyone had written down.
"""
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional, Any
import math
import numpy as np

@dataclass
class RULPrediction:
    regime: str                     # "STABLE", "DRIFTING", "ABRUPT"
    rul_hours_mean: float           # Expected hours remaining
    rul_hours_min: float            # 95% Confidence lower bound
    rul_hours_max: float            # 95% Confidence upper bound
    degradation_rate_pct_per_hr: float # Health loss rate (%/hr)
    uncertainty_level: str          # "LOW", "MEDIUM", "HIGH"
    # Which subsystem is driving the projection, and the engine-unit limit it is
    # being projected to. Empty when no subsystem breakdown was supplied.
    driving_subsystem: str = ""
    criterion_text: str = ""        # "oil pressure projected to reach 2.0 bar"
    limit_value: Optional[float] = None
    limit_units: str = ""
    critical_health_used: float = 0.0

class RULEstimator:
    """
    Combines linear/exponential trend filtering on rolling health scores with
    empirical noise-driven uncertainty interval expansion.
    """
    # Subsystem name in SubsystemHealth -> attribute carrying its health score.
    SUBSYSTEM_FIELDS = {
        "oil_system": "oil_system_health",
        "cylinders": "cylinder_health",      # list; the worst cylinder drives it
        "turbo_boost": "turbo_boost_health",
        "vibration": "vibration_health",
        "electrical": "electrical_health",
    }

    def __init__(self, history_window_len: int = 50,
                 critical_health_threshold: Optional[float] = None,
                 criteria: Optional[Dict[str, Any]] = None,
                 config_path: Optional[Any] = None):
        """
        :param criteria: per-subsystem EndOfLifeCriterion objects, as returned by
            HealthIndexEngine.end_of_life_criteria(). Loaded from the default
            engine config when omitted.
        :param critical_health_threshold: fallback floor used only when no
            subsystem breakdown is supplied to update(). Defaults to the most
            conservative (highest) of the derived per-subsystem limits, so the
            composite path can never be laxer than the strictest real criterion.
        """
        self.window_len = history_window_len
        self.health_history: List[Tuple[float, float]] = []  # (time_s, health_pct)

        if criteria is None:
            # Imported here rather than at module scope: models/ is imported by
            # training scripts that have no reason to pull in the twin package.
            from digital_twin.health_index import HealthIndexEngine
            criteria = HealthIndexEngine().end_of_life_criteria(config_path)
        self.criteria = criteria

        if critical_health_threshold is not None:
            self.critical_thresh = float(critical_health_threshold)
        elif criteria:
            self.critical_thresh = max(c.health_at_limit for c in criteria.values())
        else:
            self.critical_thresh = 30.0

    def reset(self):
        self.health_history.clear()

    # -----------------------------------------------------------------
    def _driving_subsystem(self, subsystem_health: Any) -> Tuple[str, float, float]:
        """
        Picks the subsystem closest to its own limit and returns
        (name, its health, its critical threshold).

        "Closest to its limit" is margin remaining, not raw health: a turbo at
        20% health is further from its 12.2% limit than an oil system at 15% is
        from its 0.1% one, and it is the smallest margin that should drive the
        forecast.
        """
        best = None
        for name, attr in self.SUBSYSTEM_FIELDS.items():
            criterion = self.criteria.get(name)
            if criterion is None or not hasattr(subsystem_health, attr):
                continue
            value = getattr(subsystem_health, attr)
            health = float(min(value)) if isinstance(value, (list, tuple)) else float(value)
            margin = health - criterion.health_at_limit
            if best is None or margin < best[0]:
                best = (margin, name, health, criterion.health_at_limit)
        if best is None:
            return "", float(getattr(subsystem_health, "overall_health", 100.0)), self.critical_thresh
        _, name, health, thresh = best
        return name, health, thresh

    def update(self, time_s: float, current_health_pct: float,
               subsystem_health: Optional[Any] = None) -> RULPrediction:
        """
        Updates rolling degradation trajectory and computes RUL confidence interval.

        :param subsystem_health: a SubsystemHealth. When supplied, the forecast
            tracks the subsystem with the least margin to its own physical limit
            and projects to that limit. Without it the estimator falls back to
            the composite score against the most conservative derived threshold.
        """
        criterion = None
        if subsystem_health is not None:
            name, sub_health, sub_thresh = self._driving_subsystem(subsystem_health)
            if name:
                criterion = self.criteria.get(name)
                current_health_pct = sub_health
                critical_thresh = sub_thresh
            else:
                critical_thresh = self.critical_thresh
        else:
            critical_thresh = self.critical_thresh

        def _tag(pred: RULPrediction) -> RULPrediction:
            pred.critical_health_used = round(critical_thresh, 2)
            if criterion is not None:
                pred.driving_subsystem = criterion.subsystem
                pred.criterion_text = criterion.operator_text.format(limit=criterion.limit_value)
                pred.limit_value = criterion.limit_value
                pred.limit_units = criterion.limit_units
            return pred

        self.health_history.append((time_s, current_health_pct))
        if len(self.health_history) > self.window_len:
            self.health_history.pop(0)

        # 1. Healthy / Stable State
        if current_health_pct >= 85.0 or len(self.health_history) < 10:
            return _tag(RULPrediction(
                regime="STABLE",
                rul_hours_mean=500.0,
                rul_hours_min=450.0,
                rul_hours_max=550.0,
                degradation_rate_pct_per_hr=0.0,
                uncertainty_level="LOW"
            ))

        times = np.array([pt[0] for pt in self.health_history])
        healths = np.array([pt[1] for pt in self.health_history])
        time_span_s = max(1.0, times[-1] - times[0])
        total_drop = healths[0] - healths[-1]

        # 2a. Already past the critical limit.
        #
        # This guard has to come first. Once health has collapsed and settled on
        # the floor, the trend window is flat, so the slope fit below reads
        # "very slow drift" and would report ~120 hours remaining on an engine
        # that is already beyond its condemnation threshold — while the alert
        # banner says RTB immediately. An operator given both numbers believes
        # neither, so the floor is reported as the floor.
        if current_health_pct <= critical_thresh:
            return _tag(RULPrediction(
                regime="EXPIRED",
                rul_hours_mean=0.0,
                rul_hours_min=0.0,
                rul_hours_max=0.0,
                degradation_rate_pct_per_hr=round(float(abs(total_drop) * (3600.0 / time_span_s)), 2),
                uncertainty_level="LOW"
            ))

        # 2b. Abrupt Emergency Step Fault
        if total_drop > 40.0 and time_span_s < 15.0:
            return _tag(RULPrediction(
                regime="ABRUPT",
                rul_hours_mean=0.1,
                rul_hours_min=0.0,
                rul_hours_max=0.5,
                degradation_rate_pct_per_hr=total_drop * (3600.0 / time_span_s),
                uncertainty_level="LOW"
            ))

        # 3. Drifting Degradation Regime (Linear / Exponential rate fit)
        # Fit slope: health(t) = a * t + b
        dt_hrs = (times - times[0]) / 3600.0 * 20.0 # Normalized simulation time to mission hours
        if np.std(dt_hrs) < 1e-4:
            slope = 0.0
            std_err = 1.0
        else:
            poly, residuals, _, _, _ = np.polyfit(dt_hrs, healths, deg=1, full=True)
            slope = poly[0] # % health drop per flight hour
            std_err = math.sqrt(residuals[0] / max(1, len(dt_hrs) - 2)) if len(residuals) > 0 else 2.0

        if slope >= -0.05:
            # Very slow drift
            rul_mean = 120.0
            rul_min = 90.0
            rul_max = 160.0
            unc_level = "LOW"
            deg_rate = abs(float(slope))
        else:
            deg_rate = abs(float(slope))
            health_remaining = max(1.0, current_health_pct - critical_thresh)
            rul_mean = health_remaining / deg_rate

            # Calibrate 95% Confidence Interval (widens with fit residual standard error)
            uncertainty_margin = min(0.45, max(0.12, (std_err / max(1.0, deg_rate)) * 0.35))
            rul_min = max(0.1, rul_mean * (1.0 - uncertainty_margin))
            rul_max = rul_mean * (1.0 + uncertainty_margin)

            unc_level = "HIGH" if uncertainty_margin > 0.30 else "MEDIUM"

        decimals = 2 if rul_mean < 5.0 else 1
        return _tag(RULPrediction(
            regime="DRIFTING",
            rul_hours_mean=round(float(rul_mean), decimals),
            rul_hours_min=round(float(rul_min), decimals),
            rul_hours_max=round(float(rul_max), decimals),
            degradation_rate_pct_per_hr=round(float(deg_rate), 2),
            uncertainty_level=unc_level
        ))
