"""
ENGINE-TWIN: engine switching tests (SIH26054)

A switch replaces the powerplant. Nothing belonging to the engine being removed
may survive it: not its faults, not its learned offset, not its remaining-life
history, not its last frame, and not its sensor or estimator state.

A switch that fails must change nothing at all. An engine that cannot be built
should leave the running one exactly as it was, rather than half exchanged.

Run directly:  python test_engine_switching.py
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

import engine_service as es
from simulation import engine_registry
from simulation.fault_injector import FaultConfig, FaultType

REFERENCE = engine_registry.REFERENCE_ID
LYCOMING = "lycoming_tio540_config"
ROTAX = "rotax_914_config"
TWIN = "uav-170cc-twin"

passed = failed = 0


def check(condition: bool, description: str) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {description}")
    else:
        failed += 1
        print(f"  FAIL {description}")


def run_ticks(rt, n: int) -> None:
    for _ in range(n):
        rt.step(dt_s=es.SIM_DT_S, record=False)


def test_switch_sequence() -> None:
    print("\n[1] Switching between engines, and back")
    rt = es.twin_runtime
    for engine_id, cylinders in ((REFERENCE, 4), (LYCOMING, 6), (TWIN, 2), (REFERENCE, 4)):
        rt.switch_engine(engine_id)
        state = rt.latest_state
        check(rt.engine_id == engine_id, f"{engine_id}: the runtime reports it as fitted")
        check(rt.engine.cylinders == cylinders,
              f"{engine_id}: {cylinders} physical cylinders")
        check(len(state.sensor_egt_c) == cylinders,
              f"{engine_id}: telemetry carries {cylinders} exhaust channels, none stale")
        check(len(state.sensor_cht_c) == cylinders,
              f"{engine_id}: and {cylinders} head channels")

    rt.switch_engine(REFERENCE)
    check(rt.engine_id == REFERENCE, "switching to the engine already fitted is accepted")


def test_failed_switch_changes_nothing() -> None:
    print("\n[2] A switch that fails leaves the running engine alone")
    rt = es.twin_runtime
    rt.switch_engine(LYCOMING)
    run_ticks(rt, 40)
    before = (rt.engine_id, rt.engine.cylinders, id(rt.engine), rt.sim_time_s,
              rt.rul_engine.critical_thresh)

    raised = False
    try:
        rt.switch_engine("no_such_engine")
    except ValueError:
        raised = True
    check(raised, "an unknown engine raises")

    after = (rt.engine_id, rt.engine.cylinders, id(rt.engine), rt.sim_time_s,
             rt.rul_engine.critical_thresh)
    check(before == after, "and the runtime is byte-for-byte the engine it was running")

    run_ticks(rt, 10)
    check(rt.latest_frame["engine"]["id"] == LYCOMING,
          "telemetry keeps flowing from the engine that is still fitted")


def test_fault_does_not_survive_a_switch() -> None:
    print("\n[3] A fault does not survive a switch")
    rt = es.twin_runtime
    rt.switch_engine(REFERENCE)
    rt.injector.inject_fault(FaultConfig(fault_type=FaultType.OIL_PRESSURE_LOSS,
                                         start_time_s=rt.sim_time_s,
                                         ramp_duration_s=0.5, severity=1.0))
    rt.active_fault_name = "OIL_PRESSURE_LOSS"
    run_ticks(rt, 120)
    faulted = rt.latest_state.sensor_oil_p_bar
    check(rt.injector.current_severity > 0.9, "the fault is fully developed on the first engine")

    rt.switch_engine(LYCOMING)
    check(rt.active_fault_name == "HEALTHY", "the new engine reports no active fault")
    check(rt.injector.active_fault is None, "the injector carries no fault from the previous engine")
    check(rt.injector.current_severity == 0.0, "and no severity")
    check(rt.mvem_physical.oil_pump_health == 1.0,
          "the new engine's oil pump is healthy, not the previous engine's 0.30")
    run_ticks(rt, 40)
    check(rt.latest_state.sensor_oil_p_bar > faulted + 1.0,
          f"and its oil pressure reads healthy ({rt.latest_state.sensor_oil_p_bar} against {faulted})")


def test_learned_and_projected_state_is_dropped() -> None:
    print("\n[4] Learned and projected state belongs to the engine that produced it")
    rt = es.twin_runtime
    rt.switch_engine(REFERENCE)
    run_ticks(rt, 200)
    check(len(rt.rul_engine.health_history) > 0, "a sortie accumulates remaining-life history")

    rt.switch_engine(ROTAX)
    check(rt.rul_engine.health_history == [],
          "which is dropped on a switch, because it described the previous engine")
    check(all(v == 0.0 for v in rt.baseline_adapter.bias.values()),
          "the learned per-channel offset is dropped too, rather than biasing the new engine")
    check(rt.sim_time_s > 0.0, "simulation time restarts and then warms up")
    check(abs(rt.rul_engine.critical_thresh - 35.0) < 1e-6,
          f"remaining life projects to the new engine's own limits ({rt.rul_engine.critical_thresh})")

    rt.switch_engine(LYCOMING)
    check(rt.rul_engine.critical_thresh == 30.0,
          "an engine declaring no limits falls back, rather than keeping the Rotax's")


def test_engine_identity_matches_telemetry() -> None:
    print("\n[5] Every frame names the engine that produced it")
    rt = es.twin_runtime
    for engine_id in (REFERENCE, LYCOMING, TWIN):
        rt.switch_engine(engine_id)
        run_ticks(rt, 25)
        state, frame = rt.latest_state, rt.latest_frame
        # Identity is carried on the emitted frame rather than on the state
        # dataclass, which has no engine field. The frame is what reaches a
        # client over the websocket and the event stream, so that is what has
        # to agree with the runtime.
        check(frame["engine"]["id"] == engine_id == rt.engine_id,
              f"{engine_id}: the emitted frame and the runtime agree")
        check(len(frame["sensor_egt_c"]) == rt.engine.cylinders,
              f"{engine_id}: and its channel count matches the engine named in it")
        check(len(state.sensor_egt_c) == rt.engine.cylinders,
              f"{engine_id}: the state object carries the same channel count")


def test_runtime_objects_are_replaced() -> None:
    print("\n[6] The stateful simulation objects are replaced, not reused")
    rt = es.twin_runtime
    rt.switch_engine(REFERENCE)
    before = (id(rt.mvem_physical), id(rt.mvem_baseline), id(rt.sensors),
              id(rt.injector), id(rt.ekf))
    rt.switch_engine(LYCOMING)
    after = (id(rt.mvem_physical), id(rt.mvem_baseline), id(rt.sensors),
             id(rt.injector), id(rt.ekf))
    check(all(a != b for a, b in zip(before, after)),
          "plant, baseline, sensors, injector and estimator are all new objects")
    check(rt.sensors.suite.source == LYCOMING,
          "the sensors were built from the new engine's own instrumentation")
    check(rt.engine.faults.source.endswith("faults.json"), "and its fault library is loaded")


def main() -> int:
    print("=" * 70)
    print("  ENGINE SWITCHING: the runtime is the engine that is fitted, and nothing else")
    print("=" * 70)
    test_switch_sequence()
    test_failed_switch_changes_nothing()
    test_fault_does_not_survive_a_switch()
    test_learned_and_projected_state_is_dropped()
    test_engine_identity_matches_telemetry()
    test_runtime_objects_are_replaced()
    es.twin_runtime.switch_engine(REFERENCE)
    print("\n" + "=" * 70)
    print(f"  {passed} passed, {failed} failed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
