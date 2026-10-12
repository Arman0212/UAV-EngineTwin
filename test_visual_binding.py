"""
ENGINE-TWIN: visual binding tests (SIH26054)

These guard three properties of the 3D view's configuration.

Geometry stays out of it. The renderer derives bore, bank length and layout from
the engine specification, so a visual configuration that restated cylinder count
would create a second source of truth for one fact.

Channels resolve to parts. A deviation is pointed at the component the reading
is measured on, and an EGT reading blamed on its own sensor points at the probe
rather than the cylinder.

Faults reach components by composition, not by a table. A fault declares the
channels it affects and a channel is measured on a part; joining the two is why
no fault id appears in the renderer.

Run directly:  python test_visual_binding.py
"""
import json
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from core import visual_binding
from core.visual_binding import VisualConfigError, fault_components, resolve
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


def test_loading() -> None:
    print("\n[1] Loading and fallback")
    binding = resolve(REFERENCE)
    check(binding.source.endswith("_default/visual.json"), "the reference engine resolves a configuration")
    check(binding.shared, "and it is the shared one, which is reported rather than assumed")
    check(binding.type == "procedural", "the renderer type is procedural")
    check("state_colour" in binding.supported_effects and "outline" in binding.supported_effects,
          "it declares only effects the renderer implements")
    for engine_id in ("lycoming_tio540_config", "rotax_914_config"):
        check(resolve(engine_id).shared, f"{engine_id} falls back to the shared configuration")


def test_no_geometry_duplication() -> None:
    print("\n[2] Geometry is not restated in the visual configuration")
    raw = json.loads((PROJECT_ROOT / "engines" / "_default" / "visual.json")
                     .read_text(encoding="utf-8"))
    forbidden = [k for k in ("cylinders", "cylinder_count", "displacement_litres",
                             "cylinder_layout", "rated_power_hp", "bore") if k in raw]
    check(not forbidden, f"no engine geometry restated{': ' + str(forbidden) if forbidden else ''}")
    check("channel_components" in raw and "components" in raw,
          "what it does carry is naming and instrumentation placement")


def test_channel_to_component() -> None:
    print("\n[3] Channels resolve to the part they are measured on")
    b = resolve(REFERENCE)
    cases = [
        ("oil_pressure", False, "sump"),
        ("oil_temp", False, "sump"),
        ("manifold_pressure", False, "turbo"),
        ("vibration_rms", False, "crankcase"),
        ("rpm", False, "crankcase"),
        ("egt_cyl_3", False, "cyl-2"),
        ("cht_cyl_2", False, "cyl-1"),
        ("egt_cyl_1", False, "cyl-0"),
    ]
    for channel, sensor, expected in cases:
        check(b.component_for_channel(channel, sensor) == expected,
              f"{channel} resolves to {expected}")
    check(b.component_for_channel("egt_cyl_3", sensor_fault=True) == "probe-2",
          "an EGT reading blamed on its sensor resolves to the probe, not the cylinder")
    check(b.component_for_channel("not_a_channel") is None,
          "an unknown channel resolves to nothing rather than a guess")


def test_components_follow_the_engine() -> None:
    print("\n[4] The parts listed are the parts the engine has")
    b = resolve(REFERENCE)

    six = b.labels_for(cylinders=6, turbocharged=True)
    check(sum(1 for k in six if k.startswith("cyl-")) == 6,
          "a six-cylinder engine lists six cylinders, though the AI still has four slots")
    check(sum(1 for k in six if k.startswith("probe-")) == 6, "and six probes")
    check(six.get("cyl-5", {}).get("label") == "CYL 6", "the sixth is labelled CYL 6")
    check("turbo" in six, "a turbocharged engine lists a turbocharger")

    twin = b.labels_for(cylinders=2, turbocharged=False)
    check(sum(1 for k in twin if k.startswith("cyl-")) == 2, "a twin lists two cylinders")
    check("turbo" not in twin,
          "a naturally aspirated engine lists no turbocharger, because it has none")
    check("crankcase" in twin and "sump" in twin and "prop" in twin,
          "and still lists the parts every engine has")


def test_fault_to_component_composition() -> None:
    print("\n[5] Faults reach components through the channels they affect")
    mapping = {row["fault"]: row["components"] for row in fault_components(REFERENCE)}
    check(mapping["OIL_PRESSURE_LOSS"] == ["sump"], "oil pressure loss reaches the sump")
    check(mapping["TURBO_BOOST_DEFICIENCY"] == ["turbo"], "boost deficiency reaches the turbocharger")
    check(mapping["BEARING_WEAR_VIBRATION"] == ["crankcase"], "bearing wear reaches the crankcase")
    check(mapping["COOLING_DEGRADATION_CYL2"] == ["cyl-1"], "cooling loss reaches cylinder 2")
    check(mapping["LEAN_MIXTURE_CYL3"] == ["cyl-2"], "a lean mixture reaches cylinder 3")
    check(mapping["SENSOR_FAULT_EGT3"] == ["probe-2"],
          "a probe failure reaches the probe, leaving the cylinder alone")
    check(len(mapping) == 9, f"every fault in the library is mapped (got {len(mapping)})")


def test_invalid_configuration_fails() -> None:
    print("\n[6] A configuration the renderer cannot honour fails to load")
    shared = json.loads((PROJECT_ROOT / "engines" / "_default" / "visual.json")
                        .read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "engines"
        original = visual_binding.ENGINES_DIR
        visual_binding.ENGINES_DIR = root
        try:
            for name, mutate, label in [
                ("bad_type", lambda c: c.update({"type": "gltf"}), "an unimplemented renderer type"),
                ("bad_effect", lambda c: c.update({"supported_effects": ["explode"]}),
                 "an effect the renderer does not implement"),
                ("no_parts", lambda c: c.update({"components": {}}), "a configuration with no components"),
            ]:
                engine_dir = root / name
                engine_dir.mkdir(parents=True)
                payload = json.loads(json.dumps(shared))
                mutate(payload)
                (engine_dir / "visual.json").write_text(json.dumps(payload), encoding="utf-8")
                visual_binding.clear_cache()
                try:
                    resolve(name)
                    check(False, f"{label} should have been rejected")
                except VisualConfigError:
                    check(True, f"{label} is rejected")

            # An engine with its own configuration must not report as shared.
            own = root / "own_config"
            own.mkdir(parents=True)
            (own / "visual.json").write_text(json.dumps(shared), encoding="utf-8")
            visual_binding.clear_cache()
            binding = resolve("own_config")
            check(not binding.shared, "an engine with its own configuration is not reported as shared")
        finally:
            visual_binding.ENGINES_DIR = original
            visual_binding.clear_cache()


def main() -> int:
    print("=" * 70)
    print("  VISUAL BINDING: the view is configured by the engine, not by the renderer")
    print("=" * 70)
    test_loading()
    test_no_geometry_duplication()
    test_channel_to_component()
    test_components_follow_the_engine()
    test_fault_to_component_composition()
    test_invalid_configuration_fails()
    print("\n" + "=" * 70)
    print(f"  {passed} passed, {failed} failed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
