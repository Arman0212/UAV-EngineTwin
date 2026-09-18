"""
ENGINE-TWIN: AI model binding tests (SIH26054)

These guard two properties.

First, model selection is resolved in one place and reported honestly: a
checkpoint being present must never be read as that checkpoint being validated
for the engine in front of you.

Second, the trained contract is checked rather than adapted. Fifteen channels in
a fixed order, four cylinder slots, ten classes in a fixed order. If the
configuration, the code and the weights ever disagree, loading fails loudly.

Run directly:  python test_ai_binding.py
"""
import json
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from core import ai_binding
from core.ai_binding import (STATUS_MISSING, STATUS_REFERENCE_FALLBACK, STATUS_UNTRAINED,
                             STATUS_VALIDATED, AIBinding, ContractError, ModelContract, resolve)
from models.anomaly_autoencoder import RESIDUAL_CHANNELS
from models.cylinder_map import SLOTS
from models.fault_classifier import FAULT_CLASSES
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


def test_resolution() -> None:
    print("\n[1] Resolution and fallback")
    reference = resolve(REFERENCE)
    check(reference.source.endswith("_default/ai.json"), "the reference engine resolves a configuration")
    check(reference.validated, "the reference engine is validated: it is what the checkpoints were trained on")
    check(not reference.fallback, "and it is not a fallback")

    for engine_id in ("lycoming_tio540_config", "rotax_914_config"):
        binding = resolve(engine_id)
        anomaly = binding.get("anomaly")
        check(anomaly.available, f"{engine_id}: a model file is available")
        check(not anomaly.validated_for_engine,
              f"{engine_id}: but it is not validated for this engine")
        check(anomaly.status == STATUS_REFERENCE_FALLBACK,
              f"{engine_id}: the status says reference fallback")
        check(binding.fallback and not binding.validated,
              f"{engine_id}: the binding as a whole reports the fallback")
        check(anomaly.trained_on == REFERENCE,
              f"{engine_id}: it names the engine it was trained on")


def test_same_checkpoint_everywhere() -> None:
    print("\n[2] Every engine currently resolves the same checkpoints")
    paths = {e: resolve(e).model_path("classifier")
             for e in (REFERENCE, "lycoming_tio540_config", "rotax_912is_config")}
    check(len(set(paths.values())) == 1,
          "one classifier checkpoint serves all of them, which is the honest current state")
    check(all(p is not None for p in paths.values()), "and it is present on disk")


def test_component_kinds() -> None:
    print("\n[3] Components that are not checkpoints are not treated as checkpoints")
    binding = resolve(REFERENCE)
    rul = binding.get("rul")
    xai = binding.get("xai")
    check(rul.kind == "configuration" and rul.path is None,
          "remaining life is configuration, not a checkpoint: it has no trained weights")
    check(xai.kind == "derived" and xai.derived_from == "classifier",
          "the explainer is derived from the classifier and has no model of its own")
    lyc_xai = resolve("lycoming_tio540_config").get("xai")
    check(not lyc_xai.validated_for_engine,
          "and it inherits the classifier's validation status on another engine")


def test_contract_matches_code_and_weights() -> None:
    print("\n[4] The declared contract matches the code and the weights")
    contract = resolve(REFERENCE).contract
    check(contract.input_dim == 15, f"fifteen input channels (got {contract.input_dim})")
    check(tuple(RESIDUAL_CHANNELS) == contract.channels, "in the same order as the code")
    check(contract.cylinder_slots == SLOTS == 4, "four cylinder slots")
    check(contract.num_classes == 10 and tuple(FAULT_CLASSES) == contract.classes,
          "ten classes, in the code's order")

    details = contract.verify_against_checkpoint(
        PROJECT_ROOT / "models" / "saved_models" / "fault_classifier.pt", "classifier")
    check(details["input_dim"] == 15, "the classifier weights take fifteen inputs")
    check(details["num_classes"] == 10, "and emit ten classes")


def test_contract_violations_fail_loudly() -> None:
    print("\n[5] A contract mismatch fails rather than adapting")
    wrong_width = ModelContract(channels=tuple(RESIDUAL_CHANNELS[:14]),
                                cylinder_slots=4, classes=tuple(FAULT_CLASSES))
    try:
        wrong_width.verify_against_code()
        check(False, "a short channel list should have been rejected")
    except ContractError:
        check(True, "a channel list of the wrong width is rejected")

    wrong_slots = ModelContract(channels=tuple(RESIDUAL_CHANNELS), cylinder_slots=6,
                                classes=tuple(FAULT_CLASSES))
    try:
        wrong_slots.verify_against_code()
        check(False, "six cylinder slots should have been rejected")
    except ContractError:
        check(True, "widening the cylinder slots to six is rejected")

    try:
        ModelContract(channels=tuple(RESIDUAL_CHANNELS), cylinder_slots=4,
                      classes=tuple(FAULT_CLASSES)).verify_against_checkpoint(
            PROJECT_ROOT / "models" / "saved_models" / "anomaly_autoencoder.pt", "classifier")
        check(False, "the autoencoder has no classifier head and should have been rejected")
    except ContractError:
        check(True, "asking the autoencoder for a classifier head is rejected")


def test_missing_and_untrained() -> None:
    print("\n[6] Missing and undeclared checkpoints are reported, not hidden")
    with tempfile.TemporaryDirectory() as tmp:
        engine_dir = Path(tmp) / "engines" / "phantom_engine"
        engine_dir.mkdir(parents=True)
        shared = json.loads((PROJECT_ROOT / "engines" / "_default" / "ai.json")
                            .read_text(encoding="utf-8"))
        shared["components"]["anomaly"]["model"] = "models/saved_models/not_here.pt"
        del shared["components"]["classifier"]["model"]
        (engine_dir / "ai.json").write_text(json.dumps(shared), encoding="utf-8")

        original = ai_binding.ENGINES_DIR
        ai_binding.ENGINES_DIR = Path(tmp) / "engines"
        ai_binding.clear_cache()
        try:
            binding = resolve("phantom_engine")
            anomaly, classifier = binding.get("anomaly"), binding.get("classifier")
            check(anomaly.status == STATUS_MISSING and not anomaly.available,
                  "a declared checkpoint that is absent is reported as missing")
            check(anomaly.path is None, "and no path is handed out for it")
            check(classifier.status == STATUS_UNTRAINED,
                  "a component with nothing declared is reported as untrained")
            check(binding.model_path("anomaly") is None,
                  "the registry refuses to resolve a path to a file that is not there")
            check(not binding.shared, "and it used the engine's own configuration, not the shared one")
        finally:
            ai_binding.ENGINES_DIR = original
            ai_binding.clear_cache()


def main() -> int:
    print("=" * 70)
    print("  AI BINDING: model selection is resolved once and reported honestly")
    print("=" * 70)
    test_resolution()
    test_same_checkpoint_everywhere()
    test_component_kinds()
    test_contract_matches_code_and_weights()
    test_contract_violations_fail_loudly()
    test_missing_and_untrained()
    print("\n" + "=" * 70)
    print(f"  {passed} passed, {failed} failed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
