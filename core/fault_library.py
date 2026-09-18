"""
The faults an engine can suffer, as configuration.

WHY THIS EXISTS
---------------
Fault behaviour used to be an if/elif chain in the injector: nine branches, each
naming a model attribute and a coefficient, with the coefficients written inline.
Adding a fault meant editing the simulator, and every engine necessarily had the
same nine faults because there was nowhere else for them to live.

The definitions now live in engines/<engine-id>/faults.json, falling back to the
shared library in engines/_default/faults.json. The coefficients there are the
ones that were in the code, reproduced exactly.

WHAT A DEFINITION DESCRIBES, AND WHAT IT DOES NOT
-------------------------------------------------
An effect names an existing engine-model attribute and how severity moves it.
That is all. There is no generic physics here: the model's own setters remain
the only thing that changes the engine, and a fault that cannot be expressed as
one of these forms needs a handler in code rather than a fabricated descriptor.

THREE SEPARATE KINDS OF SUPPORT
-------------------------------
A fault can be simulated without being diagnosable. The classifier has ten fixed
output classes, and a fault whose label is not among them can still be injected
and still moves the telemetry, but the diagnosis will name something else. The
same holds for the operator advice in the XAI layer. `support()` reports the
three separately rather than implying that simulating a fault means the AI knows
about it.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENGINES_DIR = PROJECT_ROOT / "engines"
DEFAULT_LIBRARY_DIR = ENGINES_DIR / "_default"

# How severity moves the target, and what the target reads when healthy.
EFFECT_KINDS = {
    "scale_down": 1.0,       # target = 1.0 - coefficient * severity
    "scale_up": 1.0,         # target = 1.0 + coefficient * severity
    "absolute": 0.0,         # target = coefficient * severity
    "sensor_override": None, # handled by the sensor model, not a scalar
}


@dataclass(frozen=True)
class Effect:
    """
    One change a fault makes to the running engine.

    :param kind: one of EFFECT_KINDS.
    :param target: an engine-model attribute, or a sensor channel key for a
        sensor override.
    :param coefficient: how far full severity moves it.
    :param cylinder: index into a per-cylinder array, for per-cylinder targets.
    :param cylinder_from_request: take the index from the injection request
        instead, falling back to ``default_cylinder``. Only the lean-mixture
        fault does this, which is the behaviour it has always had.
    :param mode: sensor fault mode, for a sensor override.
    :param healthy: what the target reads with no fault present. Derived from
        ``kind`` unless a definition states otherwise.
    """
    kind: str
    target: str
    coefficient: float = 0.0
    cylinder: Optional[int] = None
    cylinder_from_request: bool = False
    default_cylinder: int = 0
    mode: str = ""
    healthy: Optional[float] = None

    def healthy_value(self) -> Optional[float]:
        return self.healthy if self.healthy is not None else EFFECT_KINDS[self.kind]

    def value_at(self, severity: float) -> float:
        """The value this target takes at the given severity."""
        if self.kind == "scale_down":
            return 1.0 - self.coefficient * severity
        if self.kind == "scale_up":
            return 1.0 + self.coefficient * severity
        if self.kind == "absolute":
            return self.coefficient * severity
        raise ValueError(f"{self.kind} has no scalar value")

    def cylinder_index(self, requested: Optional[int], cylinder_count: int) -> int:
        """
        Which cylinder this effect lands on, clamped to the engine's own count.

        The fault names cylinders of the reference engine. A twin has no
        cylinder 3, so the index is clamped rather than raising, which is the
        behaviour the injector already had.
        """
        index = self.cylinder or 0
        if self.cylinder_from_request:
            index = self.default_cylinder if requested is None else requested
        return max(0, min(index, cylinder_count - 1))


@dataclass(frozen=True)
class FaultDefinition:
    """One fault: what it is, what it touches, and how it is diagnosed."""
    id: str
    name: str
    description: str
    subsystem: str
    effects: Tuple[Effect, ...]
    affected_channels: Tuple[str, ...] = ()
    classifier_label: str = ""
    severity_response: str = "ramped"
    severity_note: str = ""

    def support(self) -> Dict[str, str]:
        """
        What the stack can actually do with this fault.

        Simulation support is a fact about the effects. Classifier and XAI
        support are facts about the shipped model and the advice table, and are
        reported separately so a configured fault never implies a trained one.
        """
        from models.fault_classifier import FAULT_CLASSES
        from xai.alert_generator import RECOMMENDED_ACTIONS

        label = self.classifier_label or self.id
        return {
            "simulation": "supported" if self.effects else "unsupported",
            "classifier": "supported" if label in FAULT_CLASSES else "unsupported",
            "xai": "supported" if label in RECOMMENDED_ACTIONS else "unsupported",
        }

    def to_dict(self) -> Dict[str, Any]:
        """The shape the API reports, support included."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "subsystem": self.subsystem,
            "affected_channels": list(self.affected_channels),
            "classifier_label": self.classifier_label or self.id,
            "severity_response": self.severity_response,
            "severity_note": self.severity_note,
            "support": self.support(),
        }


@dataclass
class FaultLibrary:
    """The faults available to one engine."""
    source: str
    definitions: Dict[str, FaultDefinition] = field(default_factory=dict)

    def get(self, fault_id: str) -> Optional[FaultDefinition]:
        return self.definitions.get(fault_id)

    def ids(self) -> List[str]:
        return list(self.definitions)

    def reset_targets(self) -> List[Tuple[str, Optional[int], Optional[float]]]:
        """
        Every target any fault here touches, with its healthy value.

        Clearing a fault has to restore all of them, and deriving the list from
        the library means a new fault cannot be added without its reset.
        Sensor overrides are excluded: the sensor model clears its own.
        """
        targets: List[Tuple[str, Optional[int], Optional[float]]] = []
        seen = set()
        for definition in self.definitions.values():
            for effect in definition.effects:
                if effect.kind == "sensor_override" or effect.target in seen:
                    continue
                seen.add(effect.target)
                targets.append((effect.target, effect.cylinder, effect.healthy_value()))
        return targets

    def to_list(self) -> List[Dict[str, Any]]:
        return [d.to_dict() for d in self.definitions.values()]


def _parse(payload: Dict[str, Any], source: str) -> FaultLibrary:
    definitions: Dict[str, FaultDefinition] = {}
    for raw in payload.get("faults", []):
        fault_id = raw.get("id")
        if not fault_id:
            raise ValueError(f"{source}: a fault definition has no id")

        effects = []
        for spec in raw.get("effects", []):
            kind = spec.get("kind")
            if kind not in EFFECT_KINDS:
                raise ValueError(f"{source}: {fault_id} has unknown effect kind {kind!r}")
            if not spec.get("target"):
                raise ValueError(f"{source}: {fault_id} has an effect with no target")
            effects.append(Effect(
                kind=kind,
                target=spec["target"],
                coefficient=float(spec.get("coefficient", 0.0)),
                cylinder=spec.get("cylinder"),
                cylinder_from_request=bool(spec.get("cylinder_from_request", False)),
                default_cylinder=int(spec.get("default_cylinder", 0)),
                mode=spec.get("mode", ""),
                healthy=spec.get("healthy"),
            ))

        definitions[fault_id] = FaultDefinition(
            id=fault_id,
            name=raw.get("name", fault_id),
            description=raw.get("description", ""),
            subsystem=raw.get("subsystem", ""),
            effects=tuple(effects),
            affected_channels=tuple(raw.get("affected_channels", ())),
            classifier_label=raw.get("classifier_label", ""),
            severity_response=raw.get("severity_response", "ramped"),
            severity_note=raw.get("severity_note", ""),
        )
    if not definitions:
        raise ValueError(f"{source}: no fault definitions found")
    return FaultLibrary(source=source, definitions=definitions)


_cache: Dict[str, FaultLibrary] = {}


def load_for(engine_id: Optional[str] = None) -> FaultLibrary:
    """
    The fault library for one engine.

    Looks for engines/<engine-id>/faults.json and falls back to the shared
    library. No engine ships its own yet, so every engine currently gets the
    shared definitions; the fallback is reported in ``source`` rather than being
    silent, because "this engine has the default faults" and "this engine has
    faults of its own" should not look the same.
    """
    key = engine_id or "_default"
    if key in _cache:
        return _cache[key]

    candidates = []
    if engine_id:
        candidates.append(ENGINES_DIR / engine_id / "faults.json")
    candidates.append(DEFAULT_LIBRARY_DIR / "faults.json")

    for path in candidates:
        if path.is_file():
            source = str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
            library = _parse(json.loads(path.read_text(encoding="utf-8")), source)
            _cache[key] = library
            return library

    raise FileNotFoundError(
        f"no fault library for {key!r}; expected one of "
        + ", ".join(str(c) for c in candidates))
