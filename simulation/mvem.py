"""
Mean Value Engine Model (MVEM) — Physics-Based Ground-Truth Simulation
Calibrated for DRDO/VRDE-Class 2.2L 4-Cylinder Turbocharged Aero-Diesel Engine.

Sub-models:
1. Intake Manifold & Turbocharger Aerodynamics (dp_m/dt, Boost derating)
2. Crankshaft Torque Balance & Rotational Dynamics (J*d_omega/dt)
3. Multi-Cylinder Lumped Thermal Dynamics (4x CHT, 4x EGT)
4. Oil Lubrication & Thermal Hydraulics (P_oil, T_oil)
5. Order-Tracked Engine Vibration Generation (1X, 2X, 4X harmonics)
"""
from dataclasses import dataclass, field
import math
from typing import List, Dict, Any, Optional
import numpy as np

from .flight_profile import FlightState
from .engine_spec import EngineSpec

# Multiplicative deviations of one physical unit from its datasheet. A real
# engine leaves the factory slightly off nominal — a marginally tighter turbo,
# a little more friction — and stays that way for its life. Each key scales the
# named constant where that constant is used; 1.0 is exactly datasheet.
VARIANT_KEYS = (
    "turbo_efficiency_mult",
    "volumetric_efficiency_mult",
    "fmep_mult",
    "oil_pump_efficiency_mult",
    "combustion_efficiency_mult",
)

# Per-cylinder build imbalance, four entries each. Port geometry, injector trim
# and baffle placement differ slightly between cylinders from the day the engine
# is assembled, so no real four-cylinder runs perfectly even. These are the
# hardest deviation for the twin to absorb: the baseline models four identical
# cylinders, so a standing imbalance looks exactly like the per-cylinder faults
# the classifier exists to name.
CYLINDER_VARIANT_KEYS = (
    "cyl_flow_mult",      # fuelling per cylinder -> drives EGT spread
    "cyl_cooling_mult",   # heat rejection per cylinder -> drives CHT spread
)

# Cylinder imbalance is a machining and assembly tolerance, held to a tighter
# band than the engine-level constants and largely independent of how far the
# unit as a whole sits from datasheet. Capped rather than scaled so that a
# punishing global spread does not imply an absurd cylinder spread, while a
# spread of 0.0 still returns an exactly even engine.
CYLINDER_SIGMA_PCT = 1.5


def sample_variant(rng: np.random.Generator, spread_pct: float) -> Dict[str, Any]:
    """
    Draws one engine's build deviations: each engine-level multiplier normal
    about 1.0 with ``spread_pct`` percent as its standard deviation, truncated
    at +/- 3 sigma.

    The per-cylinder multipliers are drawn at ``min(spread_pct, 1.5)`` percent
    and then divided by their own mean, so the four always average exactly 1.0.
    Cylinder imbalance is therefore pure redistribution between cylinders: it
    changes which cylinder runs hot, never the engine's total fuelling or heat
    rejection.

    :param spread_pct: standard deviation as a percentage. 0.0 returns exact
        datasheet values, which is what keeps the committed datasets valid.
    """
    sigma = spread_pct / 100.0
    if sigma <= 0.0:
        variant: Dict[str, Any] = {k: 1.0 for k in VARIANT_KEYS}
        variant.update({k: [1.0] * 4 for k in CYLINDER_VARIANT_KEYS})
        return variant

    lo, hi = 1.0 - 3.0 * sigma, 1.0 + 3.0 * sigma
    variant = {k: float(np.clip(rng.normal(1.0, sigma), lo, hi)) for k in VARIANT_KEYS}

    cyl_sigma = min(spread_pct, CYLINDER_SIGMA_PCT) / 100.0
    c_lo, c_hi = 1.0 - 3.0 * cyl_sigma, 1.0 + 3.0 * cyl_sigma
    for key in CYLINDER_VARIANT_KEYS:
        draw = np.clip(rng.normal(1.0, cyl_sigma, size=4), c_lo, c_hi)
        variant[key] = [float(x) for x in draw / draw.mean()]
    return variant


@dataclass
class EngineState:
    time_s: float
    rpm: float
    power_hp: float
    torque_nm: float
    manifold_pressure_bar: float # MAP / Boost
    manifold_temp_c: float
    fuel_flow_lph: float
    bsfc_g_kwh: float            # Brake Specific Fuel Consumption
    oil_pressure_bar: float
    oil_temp_c: float
    coolant_temp_c: float
    egt_c: List[float]           # EGT for Cylinders 1, 2, 3, 4 [Celsius]
    cht_c: List[float]           # CHT for Cylinders 1, 2, 3, 4 [Celsius]
    air_fuel_ratio: List[float]  # Lambda for Cylinders 1, 2, 3, 4
    vibration_x_g: float         # 1X/2X Order-tracked vibration
    vibration_y_g: float
    vibration_z_g: float
    vibration_rms_g: float
    turbo_speed_krpm: float
    bus_voltage_v: float
    provenance: str = "SIMULATED"

class MeanValueEngineModel:
    """
    Control-oriented Physics Engine Simulator.
    Integrates intake ODEs, inertia torque balance, and lumped-parameter thermal heat transfer.
    """
    def __init__(self, config: Optional[Dict[str, Any]] = None, seed: Optional[int] = None,
                 variant: Optional[Dict[str, float]] = None):
        # Owned RNG so stochastic terms are reproducible. Previously the
        # vibration z-axis drew from NumPy's global RNG, which meant a seeded
        # dataset run still produced different data on every regeneration.
        self.rng = np.random.default_rng(seed)

        # Which engine this is. Previously every constant below was a VRDE 2.2L
        # literal and the `config` argument was accepted and ignored, so a second
        # powerplant could be described in JSON but never actually simulated.
        # The spec's defaults are those same literals, so the reference engine is
        # bit-identical to the pre-refactor model — which matters, because the
        # shipped checkpoints are trained on its residuals.
        if isinstance(config, EngineSpec):
            self.spec = config
        elif config:
            self.spec = EngineSpec.from_config(config)
        else:
            self.spec = EngineSpec()

        self.displacement_v_d = self.spec.displacement_m3
        self.cylinders = self.spec.cylinders
        self.compression_ratio = self.spec.compression_ratio
        self.inertia_j = self.spec.inertia_j
        self.v_manifold = self.spec.v_manifold_m3
        self.r_air = 287.058             # J/(kg*K) — air, not engine-specific
        self.lhv_fuel = self.spec.fuel_lhv_j_per_kg
        self.diesel_density = self.spec.fuel_density_kg_per_l

        # Thermal Capacities & Conductances
        self.c_head = 450.0              # J/(kg*K) for Aluminum alloy
        self.m_head_per_cyl = 3.2        # kg per cylinder head zone
        self.c_oil_sump = 2100.0         # J/(kg*K)
        self.m_oil_kg = 5.5              # kg oil in system

        # Internal State Variables (Initial Conditions for Cruise)
        n = self.cylinders
        self.rpm = 2800.0
        self.p_manifold = self.spec.max_boost_bar
        self.t_manifold_c = 35.0
        self.t_cht = [175.0] * n
        self.t_egt = [810.0] * n
        self.t_oil = 88.0
        self.t_coolant = 86.0
        self.turbo_speed_krpm = 65.0

        # Degradation & Fault Modulation Multipliers (1.0 = perfectly healthy)
        self.cylinder_fuel_trim = [1.0] * n      # Multiplier on fueling per cylinder
        self.cylinder_cooling_trim = [1.0] * n   # Multiplier on cooling airflow per cyl
        self.oil_pump_health = 1.0       # 0 to 1.0 (drops on relief valve / leak)
        self.turbo_efficiency = 1.0      # Multiplier on compressor efficiency
        self.bearing_wear_factor = 1.0   # > 1.0 raises 2X order vibration and friction
        self.timing_jitter_deg = 0.0     # Degrees of timing jitter (misfire proxy)
        self.alternator_health = 1.0     # Multiplier on electrical output

        # Build Variant (unit-to-unit deviation from datasheet, fixed for the
        # engine's life). Deliberately set outside reset(): a variant is a
        # property of the unit, not of the run.
        unknown = set(variant or {}) - set(VARIANT_KEYS) - set(CYLINDER_VARIANT_KEYS)
        if unknown:
            raise ValueError(f"Unknown engine variant keys: {sorted(unknown)}")
        self.variant: Dict[str, Any] = {k: 1.0 for k in VARIANT_KEYS}
        self.variant.update({k: [1.0] * self.cylinders for k in CYLINDER_VARIANT_KEYS})
        for key, value in (variant or {}).items():
            if key in CYLINDER_VARIANT_KEYS:
                per_cyl = [float(x) for x in value]
                if len(per_cyl) != self.cylinders:
                    raise ValueError(
                        f"Engine variant {key!r} needs {self.cylinders} entries, "
                        f"got {len(per_cyl)}")
                self.variant[key] = per_cyl
            else:
                self.variant[key] = float(value)
        self.turbo_efficiency_mult = self.variant["turbo_efficiency_mult"]
        self.volumetric_efficiency_mult = self.variant["volumetric_efficiency_mult"]
        self.fmep_mult = self.variant["fmep_mult"]
        self.oil_pump_efficiency_mult = self.variant["oil_pump_efficiency_mult"]
        self.combustion_efficiency_mult = self.variant["combustion_efficiency_mult"]
        self.cyl_flow_mult = self.variant["cyl_flow_mult"]
        self.cyl_cooling_mult = self.variant["cyl_cooling_mult"]

    def reset(self, idle: bool = False):
        """
        Resets engine to nominal state. The build variant is preserved.

        Initial conditions come from the spec, so resetting a Rotax does not
        drop it at the reference engine's idle speed or boost.
        """
        n = self.cylinders
        self.rpm = self.spec.idle_rpm if idle else 2800.0
        self.p_manifold = 1.02 if idle else self.spec.max_boost_bar
        self.t_cht = [85.0] * n if idle else [175.0] * n
        self.t_egt = [450.0] * n if idle else [810.0] * n
        self.t_oil = 70.0 if idle else 88.0
        self.t_coolant = 75.0 if idle else 86.0
        self.t_coolant = 75.0 if idle else 88.0
        self.turbo_speed_krpm = 25.0 if idle else 115.0
        self.cylinder_fuel_trim = [1.0] * n
        self.cylinder_cooling_trim = [1.0] * n
        self.oil_pump_health = 1.0
        self.turbo_efficiency = 1.0
        self.bearing_wear_factor = 1.0
        self.timing_jitter_deg = 0.0
        self.alternator_health = 1.0

    def step(self, flight: FlightState, dt_s: float = 0.05) -> EngineState:
        """
        Integrates physics state forward by dt_s given current flight condition.
        """
        throttle = max(0.0, min(100.0, flight.throttle_pct)) / 100.0
        p_amb = flight.ambient_pressure_bar
        t_amb_c = flight.ambient_temp_c
        t_amb_k = t_amb_c + 273.15
        rho_amb = flight.air_density_kgpm3
        airspeed = max(5.0, flight.airspeed_mps)

        # -------------------------------------------------------------
        # 1. Turbocharger & Intake Manifold Dynamics
        # -------------------------------------------------------------
        # VRDE 2.2L Turbo Aero-Diesel Critical Altitude Model:
        # Critical altitude is ~10,000 ft (P_amb ~ 0.697 bar).
        # Below 10k ft, wastegate modulates to hold 2.45 bar max boost.
        # Above 10k ft, compressor speed limit & turbine backpressure cause boost to derate:
        # At 20k ft: MAP ~ 2.10 bar -> Power ~ 150 HP
        # At 30k ft: MAP ~ 1.65 bar -> Power ~ 110 HP
        alt_ft = flight.altitude_ft
        max_boost_cap = self.spec.boost_ceiling_at(alt_ft)

        max_achievable_map = max_boost_cap * self.turbo_efficiency * self.turbo_efficiency_mult
        target_map = p_amb + (max_achievable_map - p_amb) * (throttle ** 1.3)
        target_map = max(p_amb * 0.95, target_map) # MAP cannot be below idle intake vacuum

        # Turbo inertia lag (time constant ~ 0.35 s)
        self.p_manifold += (target_map - self.p_manifold) * (dt_s / self.spec.turbo_tau_s)
        self.turbo_speed_krpm = 20.0 + (self.p_manifold / self.spec.max_boost_bar) * 95.0

        # Intercooler thermal effectiveness
        t_compressor_out = t_amb_k * ((self.p_manifold / max(0.2, p_amb)) ** 0.286) - 273.15
        intercooler_eff = self.spec.intercooler_eff
        self.t_manifold_c = t_compressor_out - intercooler_eff * (t_compressor_out - t_amb_c)

        # Volumetric Efficiency (Speed-density equation)
        # Shape from the spec (which engine), scale from the variant (how far
        # this particular unit has drifted from that engine's paper spec).
        speed_ratio = self.rpm / self.spec.rated_rpm
        eta_vol = (self.spec.eta_vol_base
                   - self.spec.eta_vol_speed_droop * (speed_ratio ** 2)
                   + self.spec.eta_vol_boost_gain * (self.p_manifold / self.spec.max_boost_bar)
                   ) * self.volumetric_efficiency_mult
        t_man_k = self.t_manifold_c + 273.15
        rho_manifold = (self.p_manifold * 1e5) / (self.r_air * t_man_k)
        air_mass_flow_kgps = eta_vol * (self.displacement_v_d * (self.rpm / 120.0)) * rho_manifold

        # -------------------------------------------------------------
        # 2. Fuel Injection & Indicated Torque Balance
        # -------------------------------------------------------------
        # Diesel stoichiometric AFR ~ 14.5. Nominal lean burn lambda ~ 1.25 to 1.6
        nominal_lambda = self.spec.lambda_base + self.spec.lambda_throttle_span * (1.0 - throttle)
        base_fuel_kgps = (air_mass_flow_kgps / (self.spec.stoich_afr * nominal_lambda))

        # Individual cylinder fueling with trims and timing jitter
        cyl_fuel_kgps = []
        cyl_lambdas = []
        for i in range(self.cylinders):
            f_i = (base_fuel_kgps / self.cylinders) * self.cylinder_fuel_trim[i] * self.cyl_flow_mult[i]
            # Timing jitter drops combustion efficiency
            jitter_loss = max(0.0, 1.0 - 0.015 * abs(self.timing_jitter_deg))
            cyl_fuel_kgps.append(f_i * jitter_loss)
            # Local AFR lambda
            lam_i = (air_mass_flow_kgps / self.cylinders) / max(1e-6, f_i * self.spec.stoich_afr)
            cyl_lambdas.append(round(float(lam_i), 3))

        total_fuel_kgps = sum(cyl_fuel_kgps)
        fuel_flow_lph = (total_fuel_kgps * 3600.0) / self.diesel_density

        # Indicated Thermal Efficiency (function of compression ratio and load)
        eta_th_ind = (self.spec.eta_th_base * (1.0 - 0.08 * (1.0 - throttle))
                      * self.combustion_efficiency_mult)
        indicated_power_watts = total_fuel_kgps * self.lhv_fuel * eta_th_ind

        # Chen-Flynn Mechanical Friction Model + Bearing Wear
        # P_fric ~ (FMEP * V_d * N) / 120
        fmep_bar = ((0.45 + self.spec.fmep_rpm_coeff * self.rpm
                     + 0.04 * (self.p_manifold / 1.0))
                    * self.bearing_wear_factor * self.fmep_mult)
        friction_power_watts = (fmep_bar * 1e5 * self.displacement_v_d * (self.rpm / 120.0))

        # Propeller Load Torque Absorption: Tau_prop = c_prop * rho * omega^2
        omega = max(10.0, (self.rpm * 2.0 * math.pi) / 60.0)
        c_prop = self.spec.c_prop
        propeller_power_watts = c_prop * rho_amb * (omega ** 3.0)

        # Net Crankshaft Power & Torque
        net_power_watts = max(0.0, indicated_power_watts - friction_power_watts)
        net_power_hp = net_power_watts / 745.7
        torque_nm = (net_power_watts / omega) if omega > 0 else 0.0

        # Crankshaft Acceleration: J * d_omega/dt = Tau_net - Tau_prop
        tau_net = torque_nm
        tau_prop = (propeller_power_watts / omega)
        d_omega_dt = (tau_net - tau_prop) / self.inertia_j

        # RPM integration with governor speed stabilization
        target_governor_rpm = (self.spec.idle_rpm
                               + throttle * (self.spec.governor_max_rpm - self.spec.idle_rpm))
        # Power ceiling imposed by the boost actually available at this altitude.
        power_limit_hp = self.spec.power_ceiling_at(self.p_manifold)

        if net_power_hp > power_limit_hp:
            net_power_hp = power_limit_hp

        self.rpm += d_omega_dt * (60.0 / (2.0 * math.pi)) * dt_s
        # Governor feedback stabilization
        self.rpm += (target_governor_rpm - self.rpm) * (dt_s / 0.8)
        self.rpm = max(self.spec.min_rpm, min(self.spec.max_rpm, self.rpm))

        # Brake Specific Fuel Consumption (g/kWh)
        bsfc = ((total_fuel_kgps * 3600.0 * 1000.0) / max(1.0, (net_power_watts / 1000.0)))

        # -------------------------------------------------------------
        # 3. Multi-Cylinder Lumped Thermal Dynamics
        # -------------------------------------------------------------
        # Coolant & Oil Heat Absorption
        self.t_coolant += (self.spec.coolant_base_c
                           + self.spec.coolant_power_span_c * (net_power_hp / self.spec.rated_power_hp)
                           - 0.15 * (airspeed - 30.0) - self.t_coolant) * (dt_s / 12.0)
        # Oil Temp: Driven by friction + combustion heat, dissipated by oil cooler
        target_oil_t = (self.spec.oil_temp_base_c
                        + self.spec.oil_temp_power_span_c * (net_power_hp / self.spec.rated_power_hp)
                          * self.bearing_wear_factor
                        - 0.20 * (airspeed - 30.0) + (t_amb_c - 15.0) * 0.3)
        self.t_oil += (target_oil_t - self.t_oil) * (dt_s / 18.0)

        # Oil Pressure Hydraulics: P_oil = P_base(RPM) * viscosity(T_oil) * pump_health
        oil_viscosity_factor = math.exp(-0.015 * (self.t_oil - 90.0))
        base_oil_p = (self.spec.oil_p_base_bar
                      + self.spec.oil_p_rpm_span_bar * (self.rpm / self.spec.governor_max_rpm))
        oil_pressure_bar = (base_oil_p * oil_viscosity_factor
                            * self.oil_pump_health * self.oil_pump_efficiency_mult)

        # Per-Cylinder CHT & EGT Equations
        for i in range(self.cylinders):
            fuel_ratio_i = self.cylinder_fuel_trim[i] * self.cyl_flow_mult[i]
            cooling_ratio_i = self.cylinder_cooling_trim[i] * self.cyl_cooling_mult[i]

            # EGT: function of air-fuel ratio, fuel trim, throttle, and ignition timing
            fuel_delta_egt = 0.0
            if fuel_ratio_i < 1.0:
                # Lean mixture: delayed late-burning flame raises EGT by up to +260 C under load.
                # Thermal delta scales with throttle and manifold boost (loss of charge cooling under heavy air mass).
                load_mult = 0.75 + 0.65 * (throttle ** 1.1) * max(0.6, min(2.5, self.p_manifold / 1.0))
                fuel_delta_egt = (1.0 - fuel_ratio_i) * 260.0 * load_mult
            elif fuel_ratio_i > 1.0:
                # Rich mixture: evaporative cooling from excess fuel drops EGT by up to -140 C
                fuel_delta_egt = (1.0 - fuel_ratio_i) * 180.0

            target_egt = (self.spec.egt_idle_c + self.spec.egt_span_c * (throttle ** 0.8)
                          + fuel_delta_egt + (abs(self.timing_jitter_deg) * 6.0))
            self.t_egt[i] += (target_egt - self.t_egt[i]) * (dt_s / 0.8)

            # CHT: Cylinder Head Temp (lumped balance with coolant and airspeed)
            target_cht = (self.spec.cht_base_c
                          + self.spec.cht_power_span_c * (net_power_hp / self.spec.rated_power_hp) * min(1.0, fuel_ratio_i) + 
                          (self.t_coolant - 80.0) * 0.65 - 
                          (airspeed - 30.0) * 0.35 * cooling_ratio_i + 
                          (t_amb_c - 15.0) * 0.25)
            # If cooling degradation is active (cooling_ratio_i < 1.0), CHT rises significantly
            if cooling_ratio_i < 1.0:
                target_cht += (1.0 - cooling_ratio_i) * 115.0

            # Lean combustion thermal surge under high throttle (micro-detonation and severe heat transfer to head)
            if fuel_ratio_i < 1.0:
                lean_cht_surge = (1.0 - fuel_ratio_i) * 120.0 * (throttle ** 1.3) * max(0.5, min(2.5, self.p_manifold / 1.0))
                target_cht += lean_cht_surge

            self.t_cht[i] += (target_cht - self.t_cht[i]) * (dt_s / 1.5)

        # -------------------------------------------------------------
        # 4. Vibration Spectrum Generation (Order Tracking)
        # -------------------------------------------------------------
        f_1x = self.rpm / 60.0
        f_2x = 2.0 * f_1x
        
        vib_1x_amp = self.spec.vib_1x_ref_g * (self.rpm / self.spec.governor_max_rpm)
        vib_2x_amp = ((self.spec.vib_2x_ref_g + 2.8 * (self.bearing_wear_factor - 1.0))
                      * (net_power_hp / self.spec.rated_power_hp))
        # Timing jitter / misfire injects 0.5X sub-harmonic rumble
        vib_misfire_amp = 0.32 * abs(self.timing_jitter_deg)

        time_t = flight.time_s
        vib_x = vib_1x_amp * math.sin(2.0 * math.pi * f_1x * time_t) + vib_2x_amp * math.sin(2.0 * math.pi * f_2x * time_t)
        vib_y = vib_1x_amp * math.cos(2.0 * math.pi * f_1x * time_t) + 0.8 * vib_2x_amp * math.cos(2.0 * math.pi * f_2x * time_t) + vib_misfire_amp * math.sin(math.pi * f_1x * time_t)
        vib_z = 0.5 * vib_1x_amp + vib_2x_amp * 1.1 + vib_misfire_amp * 0.8 + self.rng.normal(0, 0.05)
        vib_rms = math.sqrt((vib_x**2 + vib_y**2 + vib_z**2) / 3.0) + (self.bearing_wear_factor - 1.0) * 1.5 + vib_misfire_amp * 0.5

        # -------------------------------------------------------------
        # 5. Electrical Bus Voltage
        # -------------------------------------------------------------
        # Nominal 28.0 V avionics bus, charges above idle, sags if alternator degraded
        target_v = (self.spec.bus_voltage_v * self.alternator_health
                    if self.rpm > self.spec.bus_charge_rpm
                    else self.spec.bus_voltage_idle_v
                         + (self.spec.bus_voltage_v - self.spec.bus_voltage_idle_v)
                           * (self.rpm / self.spec.bus_charge_rpm))
        bus_voltage_v = target_v - 0.02 * (throttle * 10.0) # minor load drop

        return EngineState(
            time_s=round(flight.time_s, 2),
            rpm=round(self.rpm, 1),
            power_hp=round(net_power_hp, 1),
            torque_nm=round(torque_nm, 1),
            manifold_pressure_bar=round(self.p_manifold, 3),
            manifold_temp_c=round(self.t_manifold_c, 1),
            fuel_flow_lph=round(fuel_flow_lph, 2),
            bsfc_g_kwh=round(bsfc, 1),
            oil_pressure_bar=round(oil_pressure_bar, 2),
            oil_temp_c=round(self.t_oil, 1),
            coolant_temp_c=round(self.t_coolant, 1),
            egt_c=[round(t, 1) for t in self.t_egt],
            cht_c=[round(t, 1) for t in self.t_cht],
            air_fuel_ratio=[round(a, 2) for a in cyl_lambdas],
            vibration_x_g=round(vib_x, 3),
            vibration_y_g=round(vib_y, 3),
            vibration_z_g=round(vib_z, 3),
            vibration_rms_g=round(vib_rms, 3),
            turbo_speed_krpm=round(self.turbo_speed_krpm, 1),
            bus_voltage_v=round(bus_voltage_v, 2),
            provenance="SIMULATED"
        )
