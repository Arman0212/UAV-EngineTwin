"""
MALE UAV Mission Profiles & Atmospheric Dynamics (ISA Model)
Generates realistic altitude, ambient temperature, ambient pressure, airspeed, and throttle profiles.

A profile is parameterised by its mission *shape* (ceiling, loiter band, throttle
settings, and the fraction of the sortie spent in each phase) so that a fleet of
structurally different sorties can be generated rather than one curve replayed
under different ambient offsets. The defaults reproduce the reference MALE
surveillance profile exactly.
"""
from dataclasses import dataclass
import math
import numpy as np

@dataclass
class FlightState:
    time_s: float
    altitude_ft: float
    altitude_m: float
    throttle_pct: float         # 0 to 100%
    airspeed_mps: float         # True Airspeed in m/s
    ambient_temp_c: float       # Outside Air Temp in Celsius
    ambient_pressure_bar: float # Ambient pressure in bar
    air_density_kgpm3: float    # Air density in kg/m^3
    phase: str                  # Mission phase name

class FlightProfile:
    """
    Standard International Atmosphere (ISA) model + MALE UAV Flight Profile Generator.
    Supports structured mission phases (Taxi, Climb, Cruise/Loiter, Descent, Landing)
    as well as continuous customized mission curves.
    """
    # ISA Sea Level Constants
    P0 = 1.01325          # bar (101325 Pa)
    T0 = 288.15           # Kelvin (15 C)
    R_SPEC = 287.058      # J/(kg*K)
    G0 = 9.80665          # m/s^2
    LAPSE_RATE = 0.0065   # K/m up to 11,000 m (Troposphere)
    RHO0 = 1.225          # kg/m^3

    def __init__(
        self,
        delta_t_isa: float = 0.0,
        cruise_ceiling_ft: float = 30000.0,
        loiter_alt_ft: float = 29000.0,
        loiter_band_ft: float = 1000.0,
        climb_throttle_pct: float = 95.0,
        cruise_throttle_pct: float = 68.0,
        taxi_frac: float = 0.05,
        climb_frac: float = 0.20,
        loiter_frac: float = 0.50,
        descent_frac: float = 0.17,
    ):
        """
        :param delta_t_isa: Temperature offset from standard ISA (e.g. +10 for hot day, -10 for cold)
        :param cruise_ceiling_ft: Top of the climb / start of the descent
        :param loiter_alt_ft: Mean loiter altitude
        :param loiter_band_ft: Peak-to-mean altitude undulation while loitering
        :param climb_throttle_pct: Throttle at the start of the climb
        :param cruise_throttle_pct: Mean throttle while loitering
        :param taxi_frac/climb_frac/loiter_frac/descent_frac: fraction of the sortie
            spent in each phase; the remainder is approach & landing.
        """
        self.delta_t_isa = delta_t_isa
        self.cruise_ceiling_ft = cruise_ceiling_ft
        self.loiter_alt_ft = loiter_alt_ft
        self.loiter_band_ft = loiter_band_ft
        self.climb_throttle_pct = climb_throttle_pct
        self.cruise_throttle_pct = cruise_throttle_pct
        self.taxi_frac = taxi_frac
        self.climb_frac = climb_frac
        self.loiter_frac = loiter_frac
        self.descent_frac = descent_frac

    @classmethod
    def get_isa_atmosphere(cls, altitude_m: float, delta_t_isa: float = 0.0):
        """Calculates ambient pressure, temperature and density at given altitude."""
        h = max(0.0, min(altitude_m, 11000.0)) # Troposphere model
        t_kelvin = cls.T0 - cls.LAPSE_RATE * h + delta_t_isa
        p_bar = cls.P0 * ((1.0 - (cls.LAPSE_RATE * h) / cls.T0) ** (cls.G0 / (cls.R_SPEC * cls.LAPSE_RATE)))
        rho = (p_bar * 1e5) / (cls.R_SPEC * t_kelvin)
        t_celsius = t_kelvin - 273.15
        return t_celsius, p_bar, rho

    @staticmethod
    def feet_to_meters(ft: float) -> float:
        return ft * 0.3048

    @staticmethod
    def meters_to_feet(m: float) -> float:
        return m / 0.3048

    def get_standard_mission_state(self, time_s: float, total_mission_s: float = 3600.0) -> FlightState:
        """
        Generates flight parameters for a MALE UAV surveillance sortie scaled to total_mission_s.
        Phase boundaries are cumulative fractions of the sortie:
          taxi -> climb to ceiling -> high-altitude loiter -> descent -> approach & landing
        """
        progress = (time_s % total_mission_s) / total_mission_s

        t_taxi = self.taxi_frac
        t_climb = t_taxi + self.climb_frac
        t_loiter = t_climb + self.loiter_frac
        t_descent = t_loiter + self.descent_frac

        if progress < t_taxi:
            phase = "TAXI_WARMUP"
            alt_ft = 0.0
            throttle = 20.0 + 5.0 * math.sin(time_s * 0.1)
            tas_mps = 5.0
        elif progress < t_climb:
            phase = "CLIMB_TO_ALTITUDE"
            climb_frac = (progress - t_taxi) / max(1e-6, self.climb_frac)
            # Smooth S-curve climb to the cruise ceiling
            alt_ft = self.cruise_ceiling_ft * (0.5 - 0.5 * math.cos(math.pi * climb_frac))
            throttle = self.climb_throttle_pct - 5.0 * climb_frac
            tas_mps = 35.0 + 25.0 * climb_frac
        elif progress < t_loiter:
            phase = "HIGH_ALT_LOITER"
            cruise_frac = (progress - t_climb) / max(1e-6, self.loiter_frac)
            # Loiter with small atmospheric altitude undulations
            alt_ft = self.loiter_alt_ft + self.loiter_band_ft * math.sin(cruise_frac * 8.0 * math.pi)
            throttle = self.cruise_throttle_pct + 4.0 * math.sin(cruise_frac * 4.0 * math.pi)
            tas_mps = 55.0 + 3.0 * math.sin(cruise_frac * 6.0 * math.pi)
        elif progress < t_descent:
            phase = "DESCENT"
            descent_frac = (progress - t_loiter) / max(1e-6, self.descent_frac)
            alt_ft = self.cruise_ceiling_ft * (1.0 - (0.5 - 0.5 * math.cos(math.pi * descent_frac))) + 1000.0
            throttle = 40.0 - 10.0 * descent_frac
            tas_mps = 55.0 - 15.0 * descent_frac
        else:
            phase = "APPROACH_LANDING"
            alt_ft = 0.0
            throttle = 18.0
            tas_mps = 10.0

        alt_m = self.feet_to_meters(alt_ft)
        t_amb_c, p_amb_bar, rho = self.get_isa_atmosphere(alt_m, self.delta_t_isa)

        return FlightState(
            time_s=time_s,
            altitude_ft=round(alt_ft, 1),
            altitude_m=round(alt_m, 1),
            throttle_pct=round(max(0.0, min(100.0, throttle)), 2),
            airspeed_mps=round(max(0.0, tas_mps), 2),
            ambient_temp_c=round(t_amb_c, 2),
            ambient_pressure_bar=round(p_amb_bar, 4),
            air_density_kgpm3=round(rho, 4),
            phase=phase
        )
