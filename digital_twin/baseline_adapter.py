"""
Online Baseline Adaptation

The twin's baseline MVEM runs at datasheet values. The engine it is shadowing
does not: port geometry, injector trim, turbo clearances and assembly tolerances
put every real unit somewhere off nominal, and there it stays. That standing
offset lands directly in the residuals, where a classifier trained on healthy
residuals sitting near zero reads it as a fault.
(validation/mismatch_sweep.py measures exactly how much damage this does.)

This module estimates that offset and subtracts it, so the residual the AI stack
consumes carries deviation from *this* engine's own normal rather than deviation
from the datasheet. It is deliberately the most conservative thing that can work:

  * One additive bias per residual channel, nothing multiplicative, no state
    coupling. It cannot reshape a residual, only shift it.
  * A long time constant, so the estimate tracks a build offset (fixed for the
    engine's life) and not a developing fault (minutes to hours).
  * Updates only while the anomaly gate is quiet AND no fault is annunciated.
    Adapting through a developing fault would learn the fault as normal, which
    is the one failure mode that would make this component worse than useless.
  * A hard clamp in sigma units, so however long it runs, adaptation can never
    absorb a large genuine residual.
  * Frozen outside steady flight, because during a climb the baseline and the
    engine are both moving and the difference between them is transient lag,
    not build offset.

The clamp is the load-bearing safeguard. The gate can in principle be fooled by
a fault that ramps in slowly enough to stay under the anomaly threshold; the
clamp bounds what that can ever cost.
"""
from typing import Dict, Iterable, List, Optional

from models.anomaly_autoencoder import RESIDUAL_CHANNELS

# Phases steady enough for the difference between engine and baseline to be a
# build offset rather than transient lag. An allowlist rather than a denylist:
# an unrecognised phase freezes adaptation instead of silently permitting it.
STEADY_PHASES = frozenset({"HIGH_ALT_LOITER", "CRUISE"})

# Defaults. Settling is roughly 3 time constants, so 30 s gives ~90 s of steady
# flight to converge -- minutes of flight time, and short enough to complete
# inside a single loiter leg.
DEFAULT_TIME_CONSTANT_S = 30.0
DEFAULT_MAX_BIAS_SIGMA = 1.5
DEFAULT_CONVERGENCE_FACTOR = 3.0


class BaselineAdapter:
    """
    Slow per-channel additive bias estimate over the residual vector.

    Usage per tick, after residuals are computed and before the health index and
    AI stack consume them::

        adapter.update(residuals, dt_s, phase, is_anomalous, fault_annunciated)
        residuals = adapter.apply(residuals)
    """

    def __init__(
        self,
        channels: Optional[Iterable[str]] = None,
        time_constant_s: float = DEFAULT_TIME_CONSTANT_S,
        max_bias_sigma: float = DEFAULT_MAX_BIAS_SIGMA,
        steady_phases: Optional[Iterable[str]] = None,
        convergence_factor: float = DEFAULT_CONVERGENCE_FACTOR,
        enabled: bool = True,
    ):
        """
        :param time_constant_s: exponential filter time constant in seconds of
            flight time. Settling is about 3x this.
        :param max_bias_sigma: hard envelope on every channel's bias, in sigma
            units (residuals are already sigma-normalised). A genuine residual
            larger than this can never be fully absorbed.
        :param steady_phases: mission phases during which adaptation may run.
        :param convergence_factor: multiples of the time constant of accumulated
            adapting time before the estimate is reported as converged.
        """
        if time_constant_s <= 0.0:
            raise ValueError("time_constant_s must be positive")
        if max_bias_sigma < 0.0:
            raise ValueError("max_bias_sigma must be non-negative")

        self.channels: List[str] = list(channels if channels is not None else RESIDUAL_CHANNELS)
        self.time_constant_s = float(time_constant_s)
        self.max_bias_sigma = float(max_bias_sigma)
        self.steady_phases = frozenset(steady_phases if steady_phases is not None else STEADY_PHASES)
        self.convergence_factor = float(convergence_factor)
        self.enabled = bool(enabled)

        self.bias: Dict[str, float] = {ch: 0.0 for ch in self.channels}
        self.adapting_time_s: float = 0.0
        self.frozen_reason: str = "not yet started"
        self.last_update_applied: bool = False

    # -----------------------------------------------------------------
    # Gating
    # -----------------------------------------------------------------
    def _freeze_reason(self, phase: str, is_anomalous: bool, fault_annunciated: bool) -> Optional[str]:
        """Returns why adaptation must not run this tick, or None if it may."""
        if not self.enabled:
            return "disabled"
        if is_anomalous:
            return "anomaly gate open"
        if fault_annunciated:
            return "fault annunciated"
        if phase not in self.steady_phases:
            return f"transient phase ({phase})"
        return None

    # -----------------------------------------------------------------
    # Update
    # -----------------------------------------------------------------
    def update(
        self,
        residuals: Dict[str, float],
        dt_s: float,
        phase: str,
        is_anomalous: bool,
        fault_annunciated: bool,
    ) -> bool:
        """
        Advances the bias estimate by one tick. Returns True if the estimate was
        actually moved, False if adaptation was frozen for any reason.

        ``residuals`` must be the *raw* residual vector for this tick, not one
        that has already had the current bias applied.
        """
        reason = self._freeze_reason(phase, is_anomalous, fault_annunciated)
        self.frozen_reason = reason or ""
        self.last_update_applied = reason is None
        if reason is not None:
            return False

        alpha = min(1.0, max(0.0, dt_s / self.time_constant_s))
        lo, hi = -self.max_bias_sigma, self.max_bias_sigma
        for ch in self.channels:
            observed = float(residuals.get(ch, 0.0))
            moved = self.bias[ch] + (observed - self.bias[ch]) * alpha
            # Clamp every tick, not only at read time, so the estimate can never
            # accumulate beyond the envelope and then decay back through it.
            self.bias[ch] = min(hi, max(lo, moved))

        self.adapting_time_s += dt_s
        return True

    # -----------------------------------------------------------------
    # Apply
    # -----------------------------------------------------------------
    def apply(self, residuals: Dict[str, float]) -> Dict[str, float]:
        """
        Returns the residual vector with the learned bias removed. Channels the
        adapter does not track pass through untouched.
        """
        if not self.enabled:
            return dict(residuals)
        adapted = dict(residuals)
        for ch in self.channels:
            if ch in adapted:
                adapted[ch] = round(float(adapted[ch]) - self.bias[ch], 3)
        return adapted

    # -----------------------------------------------------------------
    # Introspection
    # -----------------------------------------------------------------
    @property
    def is_converged(self) -> bool:
        """True once enough steady, quiet flight time has accumulated."""
        return self.adapting_time_s >= self.convergence_factor * self.time_constant_s

    @property
    def convergence_pct(self) -> float:
        """Progress towards convergence, 0-100."""
        target = self.convergence_factor * self.time_constant_s
        return round(min(100.0, self.adapting_time_s / target * 100.0), 1) if target > 0 else 100.0

    @property
    def max_abs_bias(self) -> float:
        return max((abs(v) for v in self.bias.values()), default=0.0)

    def bias_vector(self) -> List[float]:
        """Bias in channel order, for callers that want an array."""
        return [self.bias[ch] for ch in self.channels]

    def reset(self):
        """Clears the estimate. A different engine means a different offset."""
        self.bias = {ch: 0.0 for ch in self.channels}
        self.adapting_time_s = 0.0
        self.frozen_reason = "not yet started"
        self.last_update_applied = False

    def to_dict(self) -> Dict[str, object]:
        """Serialisable summary for the telemetry frame."""
        return {
            "enabled": self.enabled,
            "converged": self.is_converged,
            "convergence_pct": self.convergence_pct,
            "adapting_time_s": round(self.adapting_time_s, 1),
            "max_abs_bias_sigma": round(self.max_abs_bias, 3),
            "max_bias_envelope_sigma": self.max_bias_sigma,
            "time_constant_s": self.time_constant_s,
            "frozen_reason": self.frozen_reason,
            "bias": {ch: round(v, 3) for ch, v in self.bias.items()},
        }
