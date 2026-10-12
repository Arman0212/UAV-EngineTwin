"""
ENGINE-TWIN: Health and remaining-life binding tests (SIH26054)

These guard one property: health and remaining-life limits must come from the
engine that is fitted, not from the reference config file.

The health index used to reach for configs/engine_config.json whenever nobody
told it otherwise, and the remaining-life estimator inherited that. A Rotax was
therefore projected toward the reference engine's oil pressure limit. The tests
below fail if that binding comes back.

Run directly:  python test_engine_binding.py
"""
import copy
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from core.engine_context import EngineContext
from digital_twin import health_index
from digital_twin.health_index import HealthIndexEngine
from models.rul_estimator import RULEstimator
from simulation import engine_registry

REFERENCE = engine_registry.REFERENCE_ID
passed = failed = 0


def check(condition: bool, description: str) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {description}")
    else:
        failed += 1
        print(f"  FAIL {description}")


def test_no_reference_config_leakage() -> None:
    """
    A supplied config must be used without touching the default file.

    Proven by pointing DEFAULT_CONFIG_PATH at a file that does not exist: if the
    method still falls back to it, this raises instead of returning criteria.
    """
    print("\n[1] The health index does not reach for the reference config")
    engine = HealthIndexEngine()
    lycoming = engine_registry.get_config("lycoming_tio540_config")
    original = health_index.DEFAULT_CONFIG_PATH
    health_index.DEFAULT_CONFIG_PATH = PROJECT_ROOT / "configs" / "__does_not_exist__.json"
    try:
        criteria = engine.end_of_life_criteria(config=lycoming)
        check(True, "a supplied config is used with the default path unreadable")
        check(criteria == {}, "the Lycoming declares no end-of-life limits, so none are invented")
        raised = False
        try:
            engine.end_of_life_criteria()
        except (FileNotFoundError, OSError):
            raised = True
        check(raised, "omitting both arguments still falls back to the default path")
    finally:
        health_index.DEFAULT_CONFIG_PATH = original


def test_limits_follow_the_config() -> None:
    """A different limit in the config must produce a different health-at-limit."""
    print("\n[2] Limits follow the config they came from")
    engine = HealthIndexEngine()
    reference = engine.end_of_life_criteria(config=engine_registry.get_config(REFERENCE))
    check(len(reference) == 5, f"the reference engine declares five criteria (got {len(reference)})")
    check(abs(reference["oil_system"].health_at_limit - 0.1) < 1e-6,
          "reference oil system condemns at 0.1 % health, unchanged")

    relaxed = copy.deepcopy(engine_registry.get_config(REFERENCE))
    relaxed["end_of_life_limits"]["oil_system"]["limit_value"] = 3.5
    moved = engine.end_of_life_criteria(config=relaxed)
    check(moved["oil_system"].limit_value == 3.5, "a changed limit reaches the criterion")
    check(moved["oil_system"].health_at_limit > reference["oil_system"].health_at_limit,
          "a limit closer to nominal condemns at a higher health value")


def test_context_binds_its_own_engine() -> None:
    """Each engine's context must carry its own limits."""
    print("\n[3] Every engine context carries its own limits")
    reference = EngineContext.fitted(REFERENCE, sensor_seed=1)
    lycoming = EngineContext.fitted("lycoming_tio540_config", sensor_seed=1)
    rotax_912 = EngineContext.fitted("rotax_912is_config", sensor_seed=1)
    rotax_914 = EngineContext.fitted("rotax_914_config", sensor_seed=1)
    boot = EngineContext.boot()

    check(len(reference.end_of_life_criteria) == 5, "reference: five criteria")
    check(len(rotax_914.end_of_life_criteria) == 5, "Rotax 914: five criteria of its own")
    check(lycoming.end_of_life_criteria == {}, "Lycoming: none declared, and none borrowed")
    check(rotax_912.end_of_life_criteria == {}, "Rotax 912: none declared, and none borrowed")
    check(len(boot.end_of_life_criteria) == 5,
          "boot engine still takes the reference limits, as it always has")
    check(lycoming.end_of_life_source == "none declared; composite fallback",
          "an engine without limits says so")
    check(boot.end_of_life_source == "reference config (boot engine)",
          "the boot engine reports where its limits came from")


def test_rul_rebinds() -> None:
    """Rebinding must move the threshold and drop the previous engine's history."""
    print("\n[4] Remaining life rebinds with the engine")
    reference = EngineContext.fitted(REFERENCE, sensor_seed=1)
    lycoming = EngineContext.fitted("lycoming_tio540_config", sensor_seed=1)

    estimator = RULEstimator(criteria=reference.end_of_life_criteria)
    on_reference = estimator.critical_thresh
    check(abs(on_reference - 12.2) < 1e-6,
          f"reference threshold is the most conservative criterion, 12.2 (got {on_reference})")

    estimator.health_history.append((0.0, 99.0))
    estimator.bind_criteria(lycoming.end_of_life_criteria)
    check(estimator.critical_thresh == 30.0,
          "an engine with no criteria falls back to the generic 30 % threshold")
    check(estimator.health_history == [],
          "the previous engine's health history is dropped")

    estimator.bind_criteria(reference.end_of_life_criteria)
    check(abs(estimator.critical_thresh - on_reference) < 1e-6,
          "rebinding back restores the reference threshold")


def test_cylinder_slot_contract() -> None:
    """The residual vector stays four wide, whatever the engine has."""
    print("\n[5] The four-slot contract is preserved, not widened")
    engine = HealthIndexEngine()
    six = [700.0, 705.0, 710.0, 715.0, 720.0, 725.0]
    sensor = {"egt_c": six, "cht_c": [180.0] * 6, "oil_pressure": 4.5, "oil_temp": 88.0,
              "manifold_pressure": 2.4, "rpm": 2800.0, "fuel_flow": 30.0,
              "vibration_rms": 1.2, "bus_voltage": 28.0}
    expected = dict(sensor, egt_c=[700.0] * 6, cht_c=[180.0] * 6)
    residuals = engine.compute_residuals(sensor, expected)

    egt_channels = [k for k in residuals if k.startswith("egt_cyl_")]
    check(len(egt_channels) == 4,
          f"a six-cylinder engine still produces four EGT residual channels (got {len(egt_channels)})")
    health = engine.evaluate_health(residuals)
    check(len(health.cylinder_health) == 4,
          f"and four cylinder health scores (got {len(health.cylinder_health)})")


def main() -> int:
    print("=" * 70)
    print("  ENGINE BINDING: health and remaining life follow the fitted engine")
    print("=" * 70)
    test_no_reference_config_leakage()
    test_limits_follow_the_config()
    test_context_binds_its_own_engine()
    test_rul_rebinds()
    test_cylinder_slot_contract()
    print("\n" + "=" * 70)
    print(f"  {passed} passed, {failed} failed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
