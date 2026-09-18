"""
Which AI models an engine uses, and what they are actually validated for.

WHY THIS EXISTS
---------------
The service resolved its checkpoints by building a path inline:

    models_dir = PROJECT_ROOT / "models" / "saved_models"

which meant the fitted engine had no say in which model diagnosed it, and the
only signal an operator got was a boolean computed from whether the engine id
happened to equal the reference one.

Resolution now goes through engines/<engine-id>/ai.json, falling back to the
shared file. No engine ships its own yet, because only one set of checkpoints
exists.

AVAILABLE IS NOT VALIDATED
--------------------------
The distinction this module exists to keep is between a model file being present
and a model being trained for the engine in front of you. The checkpoints were
trained on residuals from the reference engine. Loading them for a Lycoming
gives a diagnosis, and that diagnosis is indicative rather than validated. The
binding says so in ``status`` and ``validated_for_engine``; nothing infers
validation from the file existing.

THE CONTRACT IS CHECKED, NOT ADAPTED
------------------------------------
The configuration declares the fifteen channels, their order, the four cylinder
slots and the ten classes. On load these are checked against the code and
against the checkpoint's own weight shapes. A mismatch raises. The model is
never reshaped to fit a config, and the config never silently overrides the
code: they have to agree.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENGINES_DIR = PROJECT_ROOT / "engines"
DEFAULT_AI_DIR = ENGINES_DIR / "_default"

# What a binding can be. Nothing here is inferred from a file existing.
STATUS_VALIDATED = "validated"                 # trained and validated on this engine
STATUS_REFERENCE_FALLBACK = "reference_fallback"  # the reference model, on another engine
STATUS_MISSING = "missing"                     # declared, but the file is not there
STATUS_UNTRAINED = "untrained"                 # nothing declared for this component
STATUS_CONFIGURED = "engine_configured"        # no training involved; driven by engine config


def _display(path: Path) -> str:
    """
    A path as it should be reported: relative to the project when it lives
    there, absolute when it does not. An engine directory is not required to
    sit under the repository, and making that assumption raised.
    """
    try:
        return str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)


class ContractError(ValueError):
    """The declared contract disagrees with the code or with the checkpoint."""


@dataclass(frozen=True)
class ModelContract:
    """The input and output shape the checkpoints were trained at."""
    channels: Tuple[str, ...]
    cylinder_slots: int
    classes: Tuple[str, ...]

    @property
    def input_dim(self) -> int:
        return len(self.channels)

    @property
    def num_classes(self) -> int:
        return len(self.classes)

    def verify_against_code(self) -> None:
        """
        The declared contract must match what the code actually feeds the model.

        Raises rather than reconciling: if these two disagree, one of them is
        wrong and guessing which would be worse than stopping.
        """
        from models.anomaly_autoencoder import RESIDUAL_CHANNELS
        from models.cylinder_map import SLOTS
        from models.fault_classifier import FAULT_CLASSES

        if tuple(RESIDUAL_CHANNELS) != self.channels:
            raise ContractError(
                "declared channels do not match models.anomaly_autoencoder.RESIDUAL_CHANNELS; "
                f"declared {len(self.channels)}, code {len(RESIDUAL_CHANNELS)}")
        if SLOTS != self.cylinder_slots:
            raise ContractError(
                f"declared cylinder_slots {self.cylinder_slots} but models.cylinder_map.SLOTS is {SLOTS}")
        if tuple(FAULT_CLASSES) != self.classes:
            raise ContractError(
                "declared classes do not match models.fault_classifier.FAULT_CLASSES")

    def verify_against_checkpoint(self, path: Path, component: str) -> Dict[str, Any]:
        """
        Checks the weights on disk have the shape the contract claims.

        This reads the tensors without constructing a model, so a mismatch is
        reported as a contract failure rather than surfacing later as a shape
        error in the middle of a sortie.
        """
        import torch

        blob = torch.load(path, map_location="cpu", weights_only=False)
        state = blob.get("model_state", blob) if isinstance(blob, dict) else blob

        first = next((v for k, v in state.items()
                      if k.endswith(".weight") and getattr(v, "ndim", 0) == 2), None)
        if first is None:
            raise ContractError(f"{component}: no weight matrix found in {path.name}")
        if first.shape[1] != self.input_dim:
            raise ContractError(
                f"{component}: {path.name} takes {first.shape[1]} inputs, "
                f"contract declares {self.input_dim}")

        details = {"input_dim": int(first.shape[1])}
        if component == "classifier":
            head = state.get("classifier_head.weight")
            if head is None:
                raise ContractError(f"classifier: {path.name} has no classifier head")
            if head.shape[0] != self.num_classes:
                raise ContractError(
                    f"classifier: {path.name} emits {head.shape[0]} classes, "
                    f"contract declares {self.num_classes}")
            details["num_classes"] = int(head.shape[0])
        return details


@dataclass
class ComponentBinding:
    """One AI component, as resolved for one engine."""
    component: str
    kind: str                       # checkpoint | derived | configuration
    status: str
    engine_id: str
    trained_on: str = ""
    path: Optional[Path] = None
    available: bool = False
    validated_for_engine: bool = False
    derived_from: str = ""
    description: str = ""
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "component": self.component,
            "kind": self.kind,
            "status": self.status,
            "model": _display(self.path) if self.path else None,
            "available": self.available,
            "trained_on": self.trained_on,
            "validated_for_engine": self.validated_for_engine,
            "derived_from": self.derived_from,
            "description": self.description,
            "note": self.note,
        }


@dataclass
class AIBinding:
    """Everything the AI layer needs to know about one engine."""
    engine_id: str
    source: str
    shared: bool
    contract: ModelContract
    components: Dict[str, ComponentBinding] = field(default_factory=dict)

    def get(self, component: str) -> Optional[ComponentBinding]:
        return self.components.get(component)

    def model_path(self, component: str) -> Optional[str]:
        """The checkpoint to load, or None when there is nothing to load."""
        binding = self.components.get(component)
        if binding is None or binding.path is None or not binding.available:
            return None
        return str(binding.path)

    @property
    def fallback(self) -> bool:
        """True when any component is the reference model on another engine."""
        return any(c.status == STATUS_REFERENCE_FALLBACK for c in self.components.values())

    @property
    def validated(self) -> bool:
        """True only when every checkpoint component is validated for this engine."""
        checkpoints = [c for c in self.components.values() if c.kind == "checkpoint"]
        return bool(checkpoints) and all(c.validated_for_engine for c in checkpoints)

    def summary(self) -> Dict[str, Any]:
        return {
            "engine": self.engine_id,
            "source": self.source,
            "shared_configuration": self.shared,
            "validated_for_engine": self.validated,
            "uses_reference_fallback": self.fallback,
            "input_contract": {
                "channels": list(self.contract.channels),
                "channel_count": self.contract.input_dim,
                "cylinder_slots": self.contract.cylinder_slots,
                "ordering": "fixed",
            },
            "output_contract": {
                "classes": list(self.contract.classes),
                "class_count": self.contract.num_classes,
            },
            "components": {name: c.to_dict() for name, c in self.components.items()},
        }


def _config_path(engine_id: Optional[str]) -> Tuple[Path, bool]:
    if engine_id:
        specific = ENGINES_DIR / engine_id / "ai.json"
        if specific.is_file():
            return specific, False
    shared = DEFAULT_AI_DIR / "ai.json"
    if not shared.is_file():
        raise FileNotFoundError(f"no AI configuration found at {shared}")
    return shared, True


def _build_component(name: str, spec: Dict[str, Any], engine_id: str,
                     trained_on: str) -> ComponentBinding:
    kind = spec.get("kind", "checkpoint")
    description = spec.get("description", "")

    if kind != "checkpoint":
        # Neither has a file of its own. A derived component inherits the status
        # of whatever it is derived from, which resolve() fills in once the
        # checkpoints are known: an explainer reading a fallback classifier is
        # itself a fallback, and reporting it as validated would be the exact
        # implication this module exists to prevent. A configuration component
        # has no training at all, so it gets a status that says so rather than
        # borrowing the vocabulary of one that does.
        configured = kind == "configuration"
        return ComponentBinding(
            component=name, kind=kind,
            status=STATUS_CONFIGURED if configured else STATUS_VALIDATED,
            engine_id=engine_id, trained_on=trained_on, available=True,
            validated_for_engine=True if configured else (engine_id == trained_on),
            derived_from=spec.get("derived_from", ""), description=description,
            note=spec.get("note", ""))

    declared = spec.get("model")
    if not declared:
        return ComponentBinding(component=name, kind=kind, status=STATUS_UNTRAINED,
                                engine_id=engine_id, trained_on=trained_on,
                                description=description,
                                note="no checkpoint declared for this engine")

    path = (PROJECT_ROOT / declared).resolve()
    available = path.is_file()
    validated = available and engine_id == trained_on

    if not available:
        status, note = STATUS_MISSING, f"declared at {declared} but the file is not there"
    elif validated:
        status, note = STATUS_VALIDATED, ""
    else:
        status = STATUS_REFERENCE_FALLBACK
        note = (f"trained on {trained_on}; used here because no model exists for "
                f"{engine_id}. Physics is this engine's, the diagnosis is indicative.")

    return ComponentBinding(
        component=name, kind=kind, status=status, engine_id=engine_id,
        trained_on=trained_on, path=path if available else None, available=available,
        validated_for_engine=validated, description=description, note=note)


_cache: Dict[str, AIBinding] = {}


def resolve(engine_id: Optional[str] = None, verify: bool = True) -> AIBinding:
    """
    The AI binding for one engine.

    :param verify: check the declared contract against the code and against the
        checkpoints on disk. On by default; the checkpoint check reads the
        weight shapes, so it costs a file read per component the first time.
    :raises ContractError: if the declared contract disagrees with either.
    """
    key = engine_id or "_default"
    if key in _cache:
        return _cache[key]

    path, shared = _config_path(engine_id)
    payload = json.loads(path.read_text(encoding="utf-8"))

    contract = ModelContract(
        channels=tuple(payload.get("input_contract", {}).get("channels", ())),
        cylinder_slots=int(payload.get("input_contract", {}).get("cylinder_slots", 0)),
        classes=tuple(payload.get("output_contract", {}).get("classes", ())),
    )
    if verify:
        contract.verify_against_code()

    trained_on = payload.get("trained_on", "")
    components = {
        name: _build_component(name, spec, engine_id or trained_on, trained_on)
        for name, spec in payload.get("components", {}).items()
    }

    # A derived component is exactly as validated as its source.
    for component in components.values():
        source = components.get(component.derived_from) if component.kind == "derived" else None
        if source is not None:
            component.status = source.status
            component.available = source.available
            component.validated_for_engine = source.validated_for_engine

    if verify:
        for name, binding in components.items():
            if binding.kind == "checkpoint" and binding.available and binding.path:
                contract.verify_against_checkpoint(binding.path, name)

    binding = AIBinding(
        engine_id=engine_id or trained_on,
        source=_display(path),
        shared=shared, contract=contract, components=components)
    _cache[key] = binding
    return binding


def clear_cache() -> None:
    """Drops resolved bindings. For tests that write configuration files."""
    _cache.clear()
