"""
Multi-Engine Transfer Test (SIH26054)

Fits a second powerplant to the MVEM from its config file alone and measures
how far the resulting physics lands from that engine's published derating data.

WHAT THIS USED TO DO
--------------------
The previous version of this file computed the Rotax target with a hardcoded
formula and then compared that target against itself:

    scaled_power = target_cap * min(1.0, state.power_hp / 110.0)

Whenever the model produced 110 HP or more the multiplier was exactly 1.0, so
`scaled_power` *was* `target_cap` — the number it was then scored against. That
is why it reported 0.00 HP RMSE. The MVEM ran as the reference engine
throughout; the config never reached it, because `MeanValueEngineModel` accepted
a `config` argument and ignored it.

The model is now genuinely parameterised by `EngineSpec`, so this test hands it
the config and reads what comes back. The error is real, and therefore not zero.
"""
import sys
import json
import math
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulation.flight_profile import FlightProfile, FlightState
from simulation.mvem import MeanValueEngineModel
from simulation.engine_spec import EngineSpec

CONFIG_PATH = PROJECT_ROOT / "configs" / "rotax_914_config.json"

# What "transferred successfully" means here, stated precisely so the numbers
# below are not read as more than they are: boost follows the published curve
# because the config states it, and power stays inside the boost-derived
# ceiling built from that same table. Neither is an independent check of the
# physics. The physics is what decides whether the engine can reach its ceiling
# at all — which is the failure these bounds actually catch.
MAP_RMSE_LIMIT_BAR = 0.05
POWER_RMSE_LIMIT_FRACTION = 0.25


def settle(mvem: MeanValueEngineModel, flight: FlightState, seconds: float = 25.0):
    """Runs the engine to steady state at a fixed flight condition."""
    mvem.reset(idle=False)
    state = None
    for _ in range(int(seconds / 0.05)):
        state = mvem.step(flight, dt_s=0.05)
    return state


def flight_at(alt_ft: float) -> FlightState:
    alt_m = FlightProfile.feet_to_meters(alt_ft)
    t_c, p_bar, rho = FlightProfile.get_isa_atmosphere(alt_m)
    return FlightState(
        time_s=10.0, altitude_ft=alt_ft, altitude_m=alt_m,
        throttle_pct=100.0, airspeed_mps=50.0,
        ambient_temp_c=t_c, ambient_pressure_bar=p_bar,
        air_density_kgpm3=rho, phase="CLIMB",
    )


def test_rotax_914_transfer():
    print("=" * 80)
    print("ENGINE-TWIN: Multi-Engine Transfer (Rotax 914 UL Flat-Four)")
    print("=" * 80)

    assert CONFIG_PATH.exists(), f"Configuration file {CONFIG_PATH} not found."
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    spec = EngineSpec.from_config(cfg)

    print(f"  Target engine:  {cfg['engine_name']}")
    print(f"  Displacement:   {cfg['displacement_litres']} L "
          f"(reference is {EngineSpec().displacement_l} L)")
    print(f"  Rated power:    {cfg['rated_power_hp_sealevel']} HP "
          f"@ {cfg['rated_rpm']:.0f} rpm")
    print(f"  Max boost:      {cfg['max_boost_bar']} bar")
    print()
    print("  Derived by EngineSpec from the config, not hand-entered:")
    print(f"    propeller load coefficient  {spec.c_prop:.6f} "
          f"(reference {EngineSpec().c_prop:.6f})")
    print(f"    friction rpm coefficient    {spec.fmep_rpm_coeff:.6f} "
          f"(reference {EngineSpec().fmep_rpm_coeff:.6f})")
    print(f"    fuel                        "
          f"{'diesel' if spec.compression_ratio >= 14 else 'petrol'}, "
          f"LHV {spec.fuel_lhv_j_per_kg/1e6:.1f} MJ/kg")
    print("-" * 80)

    # The engine is built from the config and then simply flown. Nothing below
    # rescales, caps or nudges its output toward the datasheet.
    engine = MeanValueEngineModel(config=cfg)

    print("  Altitude (ft) | Target HP | Model HP | Err HP | Target bar | Model bar | Err bar")
    print("  " + "-" * 78)

    power_err, map_err = [], []
    for pt in cfg["altitude_power_derating"]:
        alt = float(pt["altitude_ft"])
        target_hp = float(pt["power_hp"])
        target_map = float(pt["rated_boost_bar"])

        state = settle(engine, flight_at(alt))

        d_hp = state.power_hp - target_hp
        d_map = state.manifold_pressure_bar - target_map
        power_err.append(d_hp)
        map_err.append(d_map)

        print(f"  {alt:13.0f} | {target_hp:9.1f} | {state.power_hp:8.1f} | "
              f"{d_hp:+6.1f} | {target_map:10.2f} | "
              f"{state.manifold_pressure_bar:9.3f} | {d_map:+7.3f}")

    power_rmse = math.sqrt(float(np.mean([e ** 2 for e in power_err])))
    map_rmse = math.sqrt(float(np.mean([e ** 2 for e in map_err])))
    rated = float(cfg["rated_power_hp_sealevel"])
    power_frac = power_rmse / rated

    print("-" * 80)
    print(f"  Manifold pressure RMSE: {map_rmse:.3f} bar   (limit {MAP_RMSE_LIMIT_BAR:.2f})")
    print(f"  Shaft power RMSE:       {power_rmse:.1f} HP = {power_frac*100:.1f}% of rating"
          f"   (limit {POWER_RMSE_LIMIT_FRACTION*100:.0f}%)")
    print()
    print("  What these two numbers do and do not prove:")
    print("    Manifold pressure follows the configured curve exactly, because the")
    print("    config states that curve directly. This confirms the config reaches")
    print("    the model — it is not independent validation of the model.")
    print("    Shaft power is bounded by the boost-derived ceiling, which is built")
    print("    from the same table, so agreement at the knee points is largely by")
    print("    construction. What the physics decides is whether the engine can")
    print("    actually REACH that ceiling: before thermal efficiency was solved")
    print("    from the rated point, small high-revving engines fell 20-30% short")
    print("    of their own rating. They no longer do.")
    print("    Genuine validation against a dyno needs bench data — roadmap Stage 1.")

    assert map_rmse < MAP_RMSE_LIMIT_BAR, (
        f"Manifold pressure did not follow the configured curve: "
        f"{map_rmse:.3f} bar RMSE")
    assert power_frac < POWER_RMSE_LIMIT_FRACTION, (
        f"Shaft power too far from the published curve: "
        f"{power_frac*100:.1f}% of rating")

    # The transfer is only meaningful if the model actually became a different
    # engine. Compare against the reference on the same flight condition.
    ref = MeanValueEngineModel()
    sl = flight_at(0.0)
    ref_state = settle(ref, sl)
    rot_state = settle(engine, sl)
    print()
    print(f"  Same flight condition, two engines:")
    print(f"    reference: {ref_state.power_hp:6.1f} HP  {ref_state.manifold_pressure_bar:.3f} bar")
    print(f"    Rotax 914: {rot_state.power_hp:6.1f} HP  {rot_state.manifold_pressure_bar:.3f} bar")
    assert abs(ref_state.power_hp - rot_state.power_hp) > 20.0, (
        "The two engines produced nearly identical output — the config is being ignored.")

    print()
    print("  -> PASSED: the config genuinely re-parameterises the physics.")
    print("=" * 80)


if __name__ == "__main__":
    test_rotax_914_transfer()
