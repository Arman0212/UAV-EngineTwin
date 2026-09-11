"""
Engine specification — the parameters that make the MVEM a particular engine.

WHY THIS EXISTS
---------------
`MeanValueEngineModel.__init__` has always accepted a `config` argument and
never read it. Every constant in the model was the DRDO/VRDE 2.2 L: its
displacement, its 200 HP rating, its 2.45 bar boost ceiling, its derating knees,
its idle and governor speeds. A second engine could not be simulated, only
described in a JSON file that nothing loaded.

This class is that missing layer. The MVEM now reads every engine-specific
number from a spec, and a spec can be built from a config dict, so defining a
new powerplant is genuinely a matter of parameters rather than a code change.

THE DEFAULTS ARE NOT ARBITRARY
------------------------------
Every default below is the exact literal that was previously hardcoded in
`mvem.py`. That is deliberate and load-bearing: the anomaly autoencoder and the
fault classifier are trained on residuals from this engine, so if the reference
spec produced even slightly different physics, every shipped checkpoint would be
scoring against a distribution it never saw. `test_simulation.py` asserts the
reference engine is bit-identical to the pre-refactor model.

DERIVING A SPEC FROM A SPARSE CONFIG
------------------------------------
A user defining their own engine should not have to supply forty constants. The
config schema in `configs/*.json` carries the ones an engineer actually knows —
displacement, rated power and speed, boost ceiling, the derating table, nominal
temperatures and pressures — and everything else is derived from those by
scaling the reference engine. Those derivations are documented at each field.
They are engineering approximations, not measurements, and a custom engine is
therefore a plausible engine rather than a validated one.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple


def _interp(x: float, points: List[Tuple[float, float]]) -> float:
    """Linear interpolation over sorted (x, y) knots, clamped at both ends."""
    if not points:
        return 0.0
    if x <= points[0][0]:
        return points[0][1]
    if x >= points[-1][0]:
        return points[-1][1]
    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        if x0 <= x <= x1:
            if x1 == x0:
                return y1
            return y0 + (y1 - y0) * ((x - x0) / (x1 - x0))
    return points[-1][1]



def _calibrate_eta_th(disp_l, rated_rpm, rated_power_hp, max_boost_bar,
                      afr, lam, lhv, fmep_coeff, eta_vol_base,
                      eta_vol_droop, eta_vol_gain) -> float:
    """
    Solves indicated thermal efficiency from the engine's rated point.

    A datasheet never quotes thermal efficiency, but it always quotes rated
    power — and at the rated point the air path, the fuelling and the friction
    model are all determined by numbers we do have. So rather than carry the
    reference engine's efficiency onto every other engine (which left small
    high-revving engines producing 20-30% under their rating), invert the
    balance and ask what efficiency the quoted rating implies:

        eta_th = (P_rated + P_friction) / (m_fuel * LHV)

    This is parameter identification from a known operating point, not a
    rescaling of the model's output. Everything downstream — part-load
    behaviour, altitude derating, fault response — still emerges from the
    physics rather than being imposed.
    """
    v_d = disp_l * 1e-3
    n_120 = rated_rpm / 120.0

    # Manifold charge density at the rated point, post-intercooler.
    t_manifold_k = 313.15
    rho_manifold = (max_boost_bar * 1e5) / (287.058 * t_manifold_k)

    # Volumetric efficiency at rated speed and full boost.
    eta_vol = eta_vol_base - eta_vol_droop + eta_vol_gain

    air_kgps = eta_vol * v_d * n_120 * rho_manifold
    fuel_kgps = air_kgps / max(1e-9, afr * lam)

    fmep_bar = 0.45 + fmep_coeff * rated_rpm + 0.04 * max_boost_bar
    friction_w = fmep_bar * 1e5 * v_d * n_120
    rated_w = rated_power_hp * 745.7

    eta = (rated_w + friction_w) / max(1e-9, fuel_kgps * lhv)

    # Keep it physically sensible. A four-stroke piston engine that claims
    # better than 55% indicated efficiency is a datasheet error, not a discovery.
    return max(0.18, min(0.55, eta))


@dataclass
class EngineSpec:
    """Everything the MVEM needs to know about which engine it is simulating."""

    name: str = "DRDO-VRDE-2.2L-Turbo-AeroDiesel"

    # --- Geometry & inertia ------------------------------------------------
    displacement_l: float = 2.2
    cylinders: int = 4
    compression_ratio: float = 17.5
    inertia_j: float = 0.45          # kg*m^2, crank + flywheel + propeller
    v_manifold_m3: float = 0.0035

    # --- Fuel --------------------------------------------------------------
    fuel_lhv_j_per_kg: float = 42.8e6
    fuel_density_kg_per_l: float = 0.835
    stoich_afr: float = 14.5
    lambda_base: float = 1.35        # lean-burn lambda at full throttle
    lambda_throttle_span: float = 0.40
    eta_th_base: float = 0.42        # indicated thermal efficiency at full load

    # --- Speeds ------------------------------------------------------------
    rated_rpm: float = 4200.0        # volumetric-efficiency reference speed
    governor_max_rpm: float = 4000.0 # governor ceiling at full throttle
    idle_rpm: float = 1400.0
    min_rpm: float = 1200.0
    max_rpm: float = 4400.0

    # --- Power & boost -----------------------------------------------------
    rated_power_hp: float = 200.0
    max_boost_bar: float = 2.45
    turbo_tau_s: float = 0.35
    intercooler_eff: float = 0.85

    # Altitude (ft) -> maximum achievable manifold pressure (bar). The knots
    # below reproduce the previous hardcoded critical-altitude model exactly.
    boost_curve: List[Tuple[float, float]] = field(default_factory=lambda: [
        (0.0, 2.45), (10000.0, 2.45), (20000.0, 2.10), (30000.0, 1.65)
    ])

    # Manifold pressure knees for the power ceiling. Preserved in the original
    # piecewise form, including the step at `power_full_map_bar` — that
    # discontinuity is in the reference engine's behaviour and the shipped
    # checkpoints were trained through it.
    power_full_map_bar: float = 2.40
    power_mid_map_bar: float = 2.10
    power_low_map_bar: float = 1.65
    power_ref_map_bar: float = 2.45
    power_mid_hp: float = 150.0
    power_low_hp: float = 110.0

    # --- Volumetric efficiency --------------------------------------------
    eta_vol_base: float = 0.88
    eta_vol_speed_droop: float = 0.08
    eta_vol_boost_gain: float = 0.05

    # --- Thermal -----------------------------------------------------------
    egt_idle_c: float = 420.0        # EGT at closed throttle
    egt_span_c: float = 360.0        # additional EGT at full throttle
    cht_base_c: float = 110.0
    cht_power_span_c: float = 85.0
    coolant_base_c: float = 85.0
    coolant_power_span_c: float = 15.0
    oil_temp_base_c: float = 80.0
    oil_temp_power_span_c: float = 35.0

    # --- Oil circuit -------------------------------------------------------
    oil_p_base_bar: float = 2.0
    oil_p_rpm_span_bar: float = 2.8

    # --- Electrical --------------------------------------------------------
    bus_voltage_v: float = 28.2
    bus_voltage_idle_v: float = 24.5
    bus_charge_rpm: float = 1800.0

    # --- Propeller & friction ---------------------------------------------
    # Both were hardcoded and silently tuned to the reference engine. A 5,800 rpm
    # Rotax swinging the VRDE's propeller constant would be asked to absorb ~244 HP
    # of prop load against a 115 HP rating, so it could never reach its own rating.
    c_prop: float = 0.00078          # propeller load: P = c * rho * omega^3
    fmep_rpm_coeff: float = 0.00035  # friction mean effective pressure per rpm

    # --- Vibration ---------------------------------------------------------
    vib_1x_ref_g: float = 0.35
    vib_2x_ref_g: float = 0.85

    # Provenance for the UI: was this shipped with the project or built by a user?
    origin: str = "reference"

    # -- derived ------------------------------------------------------------

    @property
    def displacement_m3(self) -> float:
        return self.displacement_l * 1e-3

    def boost_ceiling_at(self, altitude_ft: float) -> float:
        """Maximum achievable manifold pressure at a given pressure altitude."""
        return _interp(altitude_ft, sorted(self.boost_curve))

    def power_ceiling_at(self, map_bar: float) -> float:
        """
        Power ceiling imposed by available boost.

        Kept in the original piecewise form rather than replaced with clean
        interpolation: the step at power_full_map_bar is a discontinuity in the
        reference engine, and smoothing it would shift every residual the
        shipped models were trained on.
        """
        if map_bar >= self.power_full_map_bar:
            return self.rated_power_hp
        if map_bar >= self.power_mid_map_bar:
            frac = ((map_bar - self.power_mid_map_bar)
                    / max(1e-9, self.power_ref_map_bar - self.power_mid_map_bar))
            return self.power_mid_hp + (self.rated_power_hp - self.power_mid_hp) * frac
        frac = max(0.0, (map_bar - self.power_low_map_bar)
                   / max(1e-9, self.power_mid_map_bar - self.power_low_map_bar))
        return self.power_low_hp + (self.power_mid_hp - self.power_low_hp) * frac

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["boost_curve"] = [list(p) for p in self.boost_curve]
        return d

    # -- construction -------------------------------------------------------

    @classmethod
    def from_config(cls, cfg: Dict[str, Any]) -> "EngineSpec":
        """
        Builds a spec from the `configs/*.json` schema.

        Only the fields an engineer would actually have to hand are required;
        the rest are scaled from the reference engine. Each derivation is noted
        so nobody mistakes an approximation for a datasheet value.
        """
        ref = cls()
        nom = cfg.get("nominal_operating_parameters", {}) or {}

        rated_power = float(cfg.get("rated_power_hp_sealevel", ref.rated_power_hp))
        rated_rpm = float(cfg.get("rated_rpm", ref.rated_rpm))
        idle_rpm = float(cfg.get("idle_rpm", ref.idle_rpm))
        gov_rpm = float(cfg.get("max_continuous_rpm", ref.governor_max_rpm))
        disp_l = float(cfg.get("displacement_litres", ref.displacement_l))
        max_boost = float(cfg.get("max_boost_bar", ref.max_boost_bar))

        # Derating table -> boost curve and power knees.
        table = cfg.get("altitude_power_derating") or []
        if table:
            table = sorted(table, key=lambda p: p.get("altitude_ft", 0.0))
            boost_curve = [(float(p["altitude_ft"]),
                            float(p.get("rated_boost_bar", max_boost))) for p in table]
            powers = [float(p.get("power_hp", rated_power)) for p in table]
            boosts = [b for _, b in boost_curve]
            low_hp, mid_hp = min(powers), powers[len(powers) // 2]
            low_map, mid_map = min(boosts), sorted(boosts)[len(boosts) // 2]
        else:
            boost_curve = list(ref.boost_curve)
            low_hp, mid_hp = ref.power_low_hp, ref.power_mid_hp
            low_map, mid_map = ref.power_low_map_bar, ref.power_mid_map_bar

        # Crank inertia scales roughly with displacement; a smaller engine
        # spins up faster. Approximation, not a measurement.
        inertia = ref.inertia_j * (disp_l / ref.displacement_l)

        # Thermal envelope, scaled so the model settles near the quoted nominal
        # rather than the reference engine's.
        egt_nom = float(nom.get("egt_nominal_celsius", 0.0)) or None
        cht_nom = float(nom.get("cht_nominal_celsius", 0.0)) or None
        oil_p_nom = float(nom.get("oil_pressure_nominal_bar", 0.0)) or None
        bus_v = float(nom.get("bus_voltage_nominal_v", 0.0)) or None

        # The reference engine settles ~780 C at full throttle against a quoted
        # 750 C nominal, so scale both halves of the EGT curve by that ratio.
        if egt_nom:
            ref_egt_nom = 750.0
            k = egt_nom / ref_egt_nom
            egt_idle, egt_span = ref.egt_idle_c * k, ref.egt_span_c * k
        else:
            egt_idle, egt_span = ref.egt_idle_c, ref.egt_span_c

        if cht_nom:
            k = cht_nom / 175.0
            cht_base, cht_span = ref.cht_base_c * k, ref.cht_power_span_c * k
        else:
            cht_base, cht_span = ref.cht_base_c, ref.cht_power_span_c

        if oil_p_nom:
            k = oil_p_nom / 4.5
            oil_base, oil_span = ref.oil_p_base_bar * k, ref.oil_p_rpm_span_bar * k
        else:
            oil_base, oil_span = ref.oil_p_base_bar, ref.oil_p_rpm_span_bar

        # A spark-ignition petrol engine burns a different fuel from the
        # reference aero-diesel; use its constants when compression suggests it.
        cr = float(cfg.get("compression_ratio", ref.compression_ratio))
        is_diesel = cr >= 14.0
        fuel_lhv = ref.fuel_lhv_j_per_kg if is_diesel else 43.4e6
        fuel_rho = ref.fuel_density_kg_per_l if is_diesel else 0.745
        afr = ref.stoich_afr if is_diesel else 14.7
        lam = ref.lambda_base if is_diesel else 1.02
        lam_span = ref.lambda_throttle_span if is_diesel else 0.10
        eta_th = ref.eta_th_base if is_diesel else 0.34

        # A propeller is sized to its engine. Scale the load coefficient so the
        # prop absorbs the same fraction of rated power at rated speed as the
        # reference does: c = c_ref * (P/P_ref) * (w_ref/w)^3.
        w_ratio = (ref.rated_rpm / rated_rpm) if rated_rpm > 0 else 1.0
        c_prop = ref.c_prop * (rated_power / ref.rated_power_hp) * (w_ratio ** 3)

        # Likewise friction: the rpm term is calibrated so FMEP at the engine's
        # own rated speed matches the reference at its rated speed.
        fmep_coeff = ref.fmep_rpm_coeff * (ref.rated_rpm / rated_rpm) if rated_rpm > 0             else ref.fmep_rpm_coeff

        eta_th = _calibrate_eta_th(
            disp_l, rated_rpm, rated_power, max_boost, afr, lam, fuel_lhv,
            fmep_coeff, ref.eta_vol_base, ref.eta_vol_speed_droop,
            ref.eta_vol_boost_gain)

        # The reference engine's default was derived from this same balance, so
        # a round-trip through from_config must land back on it exactly rather
        # than a hair away — the shipped checkpoints depend on that.
        if abs(eta_th - ref.eta_th_base) / ref.eta_th_base < 0.01:
            eta_th = ref.eta_th_base

        return cls(
            name=str(cfg.get("engine_name", "Custom Engine")),
            displacement_l=disp_l,
            cylinders=int(cfg.get("cylinders", ref.cylinders)),
            compression_ratio=cr,
            inertia_j=inertia,
            v_manifold_m3=ref.v_manifold_m3 * (disp_l / ref.displacement_l),
            fuel_lhv_j_per_kg=fuel_lhv,
            fuel_density_kg_per_l=fuel_rho,
            stoich_afr=afr,
            lambda_base=lam,
            lambda_throttle_span=lam_span,
            eta_th_base=eta_th,
            rated_rpm=rated_rpm,
            governor_max_rpm=gov_rpm,
            idle_rpm=idle_rpm,
            min_rpm=idle_rpm * 0.857,      # reference ratio 1200/1400
            max_rpm=gov_rpm * 1.10,        # reference ratio 4400/4000
            rated_power_hp=rated_power,
            max_boost_bar=max_boost,
            boost_curve=boost_curve,
            power_full_map_bar=max_boost * (2.40 / 2.45),
            power_mid_map_bar=mid_map,
            power_low_map_bar=low_map,
            power_ref_map_bar=max_boost,
            power_mid_hp=mid_hp,
            power_low_hp=low_hp,
            egt_idle_c=egt_idle,
            egt_span_c=egt_span,
            cht_base_c=cht_base,
            cht_power_span_c=cht_span,
            oil_p_base_bar=oil_base,
            oil_p_rpm_span_bar=oil_span,
            bus_voltage_v=(bus_v * (28.2 / 28.0)) if bus_v else ref.bus_voltage_v,
            bus_voltage_idle_v=(bus_v * (24.5 / 28.0)) if bus_v else ref.bus_voltage_idle_v,
            c_prop=c_prop,
            fmep_rpm_coeff=fmep_coeff,
            origin=str(cfg.get("origin", "reference")),
        )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

# Bounds chosen to keep a user-defined engine inside the range where the MVEM's
# correlations still mean something. Outside them the model would still produce
# numbers, and they would be fiction.
LIMITS: Dict[str, Tuple[float, float]] = {
    "displacement_litres": (0.05, 20.0),
    "cylinders": (1, 16),
    "rated_power_hp_sealevel": (5.0, 1200.0),
    "rated_rpm": (800.0, 12000.0),
    "idle_rpm": (400.0, 4000.0),
    "max_continuous_rpm": (800.0, 12000.0),
    "compression_ratio": (5.0, 26.0),
    "max_boost_bar": (0.5, 5.0),
}


def validate_config(cfg: Dict[str, Any]) -> List[str]:
    """Returns a list of human-readable problems; empty means usable."""
    errors: List[str] = []

    name = str(cfg.get("engine_name", "")).strip()
    if not name:
        errors.append("Engine name is required.")
    elif len(name) > 80:
        errors.append("Engine name must be 80 characters or fewer.")

    for key, (lo, hi) in LIMITS.items():
        if key not in cfg:
            continue
        try:
            v = float(cfg[key])
        except (TypeError, ValueError):
            errors.append(f"{key} must be a number.")
            continue
        if not (lo <= v <= hi):
            errors.append(f"{key} must be between {lo:g} and {hi:g} (got {v:g}).")

    idle = float(cfg.get("idle_rpm", 0) or 0)
    gov = float(cfg.get("max_continuous_rpm", 0) or 0)
    rated = float(cfg.get("rated_rpm", 0) or 0)
    if idle and gov and idle >= gov:
        errors.append("Idle RPM must be below maximum continuous RPM.")
    if gov and rated and gov > rated * 1.5:
        errors.append("Maximum continuous RPM is implausibly far above rated RPM.")

    table = cfg.get("altitude_power_derating")
    if table is not None:
        if not isinstance(table, list) or len(table) < 2:
            errors.append("The derating table needs at least two altitude points.")
        else:
            alts = []
            for i, pt in enumerate(table):
                if not isinstance(pt, dict) or "altitude_ft" not in pt:
                    errors.append(f"Derating row {i + 1} needs an altitude_ft value.")
                    continue
                alts.append(float(pt["altitude_ft"]))
                hp = float(pt.get("power_hp", 0) or 0)
                if hp <= 0:
                    errors.append(f"Derating row {i + 1} needs a positive power_hp.")
            if alts != sorted(alts):
                errors.append("Derating altitudes must increase down the table.")
            powers = [float(p.get("power_hp", 0) or 0) for p in table
                      if isinstance(p, dict)]
            if powers and powers != sorted(powers, reverse=True):
                errors.append("Power must not increase with altitude — a turbo holds "
                              "it flat to critical altitude, then it falls.")

    return errors


# Ranges where the mean-value correlations were calibrated. Outside them the
# model still runs and still responds to faults, but its absolute numbers carry
# less weight — so these produce warnings, not refusals. Telling an operator
# "no" when the honest answer is "yes, with a caveat" is the worse failure.
CALIBRATED: Dict[str, Tuple[float, float]] = {
    "displacement_litres": (0.8, 9.0),
    "rated_rpm": (2000.0, 6000.0),
    "rated_power_hp_sealevel": (60.0, 400.0),
}


def config_warnings(cfg: Dict[str, Any]) -> List[str]:
    """Non-blocking notes about a config that is valid but unusual."""
    out: List[str] = []

    disp = float(cfg.get("displacement_litres", 0) or 0)
    if 0 < disp < CALIBRATED["displacement_litres"][0]:
        out.append(
            f"{disp * 1000:.0f} cc is below the range these correlations were "
            f"fitted on (from {CALIBRATED['displacement_litres'][0] * 1000:.0f} cc). "
            "Small two-strokes in particular breathe and scavenge differently "
            "from the four-strokes the model was built around.")
    elif disp > CALIBRATED["displacement_litres"][1]:
        out.append(f"{disp:.1f} L is above the fitted range; treat absolute "
                   "figures as indicative.")

    rpm = float(cfg.get("rated_rpm", 0) or 0)
    if rpm and not (CALIBRATED["rated_rpm"][0] <= rpm <= CALIBRATED["rated_rpm"][1]):
        out.append(f"{rpm:.0f} rpm is outside the fitted speed range "
                   f"({CALIBRATED['rated_rpm'][0]:.0f}-{CALIBRATED['rated_rpm'][1]:.0f}).")

    hp = float(cfg.get("rated_power_hp_sealevel", 0) or 0)
    if hp and not (CALIBRATED["rated_power_hp_sealevel"][0] <= hp
                   <= CALIBRATED["rated_power_hp_sealevel"][1]):
        out.append(f"{hp:.0f} HP is outside the fitted power range.")

    if not cfg.get("turbocharged", True) and disp and disp < 0.5:
        out.append("A small naturally aspirated engine will show very little "
                   "manifold-pressure signal, so turbo faults are not meaningful on it.")

    return out
