"""
What the 3D view needs to know about an engine.

WHY THIS IS SMALL
-----------------
The renderer already builds the engine from its specification: bore is solved
from displacement and cylinder count, bank length follows the count, the
turbocharger is built only when the engine has one, and the assembly is scaled
to fill the frame. None of that belongs in a visual configuration, and putting
cylinder count in a second file would create two sources of truth for one fact.

What is left is genuinely presentational: what the parts are called, and where
each telemetry channel is measured so a deviation can be pointed at the part it
came from. That is what this file carries.

WHAT IS NOT HERE
----------------
No fault table. The view decides what to highlight from the diagnosis's own
attribution: the channel it names resolves to a component through the mapping
below. A fault therefore reaches a component by way of the channels it affects,
which the fault library already declares, so fault names never enter the
renderer. `fault_components()` composes the two for reporting and testing.

Nor are the renderer's own constants here: proportions, grading thresholds,
persistence windows and shake limits are how the view behaves, not facts about
an engine, and an engine config has no business setting them.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENGINES_DIR = PROJECT_ROOT / "engines"
DEFAULT_VISUAL_DIR = ENGINES_DIR / "_default"

# Renderer capabilities. A configuration may only reference these; anything else
# is a typo or an effect nobody implemented, and either way it should not load.
KNOWN_EFFECTS = {
    "state_colour", "outline", "probe_suspect", "shake",
    "propeller_unsteadiness", "turbo_spin", "stale",
}
KNOWN_TYPES = {"procedural"}


class VisualConfigError(ValueError):
    """The visual configuration is not something the renderer can honour."""


@dataclass
class VisualBinding:
    """One engine's presentational configuration."""
    engine_id: str
    source: str
    shared: bool
    type: str
    components: Dict[str, Dict[str, Any]]
    per_cylinder: Dict[str, Dict[str, str]]
    channel_components: Dict[str, str]
    sensor_fault_component: str
    supported_effects: Tuple[str, ...]

    # ------------------------------------------------------------------
    def component_for_channel(self, channel: str, sensor_fault: bool = False) -> Optional[str]:
        """
        The component a reading is measured on.

        Per-cylinder channels resolve to that cylinder, or to its probe when the
        diagnosis blames the reading on the sensor rather than the engine.
        """
        for prefix in ("egt_cyl_", "cht_cyl_"):
            if channel.startswith(prefix):
                try:
                    index = int(channel[len(prefix):]) - 1
                except ValueError:
                    return None
                if index < 0:
                    return None
                kind = self.sensor_fault_component if (sensor_fault and prefix == "egt_cyl_") else "cylinder"
                template = self.per_cylinder.get(kind, {}).get("id", "")
                return template.replace("{index}", str(index)) or None
        return self.channel_components.get(channel)

    def labels_for(self, cylinders: int, turbocharged: bool) -> Dict[str, Dict[str, str]]:
        """
        Every selectable component this engine actually has, with its names.

        A component whose ``present_when`` is not satisfied is left out, so a
        naturally aspirated engine has no turbocharger to select or annotate.
        """
        out: Dict[str, Dict[str, str]] = {}
        facts = {"turbocharged": turbocharged}
        for component_id, meta in self.components.items():
            condition = meta.get("present_when")
            if condition and not facts.get(condition, False):
                continue
            out[component_id] = {"label": meta.get("label", component_id.upper()),
                                 "title": meta.get("title", component_id)}

        for kind, template in self.per_cylinder.items():
            for index in range(cylinders):
                component_id = template.get("id", "").replace("{index}", str(index))
                if not component_id:
                    continue
                out[component_id] = {
                    "label": template.get("label", "").replace("{number}", str(index + 1)),
                    "title": template.get("title", "").replace("{number}", str(index + 1)),
                }
        return out

    def summary(self, cylinders: int, turbocharged: bool) -> Dict[str, Any]:
        """The shape the API and the renderer consume."""
        return {
            "engine": self.engine_id,
            "source": self.source,
            "shared_configuration": self.shared,
            "type": self.type,
            "components": self.labels_for(cylinders, turbocharged),
            "per_cylinder": self.per_cylinder,
            "channel_components": self.channel_components,
            "sensor_fault_component": self.sensor_fault_component,
            "supported_effects": list(self.supported_effects),
        }


def _config_path(engine_id: Optional[str]) -> Tuple[Path, bool]:
    if engine_id:
        specific = ENGINES_DIR / engine_id / "visual.json"
        if specific.is_file():
            return specific, False
    shared = DEFAULT_VISUAL_DIR / "visual.json"
    if not shared.is_file():
        raise FileNotFoundError(f"no visual configuration found at {shared}")
    return shared, True


_cache: Dict[str, VisualBinding] = {}


def resolve(engine_id: Optional[str] = None) -> VisualBinding:
    """
    The visual binding for one engine, falling back to the shared file.

    :raises VisualConfigError: if the configuration names a renderer type or an
        effect that does not exist. Failing here is better than a view that
        silently ignores half its configuration.
    """
    key = engine_id or "_default"
    if key in _cache:
        return _cache[key]

    path, shared = _config_path(engine_id)
    payload = json.loads(path.read_text(encoding="utf-8"))

    kind = payload.get("type", "procedural")
    if kind not in KNOWN_TYPES:
        raise VisualConfigError(
            f"{path.name}: renderer type {kind!r} is not implemented; known: {sorted(KNOWN_TYPES)}")

    effects = tuple(payload.get("supported_effects", ()))
    unknown = [e for e in effects if e not in KNOWN_EFFECTS]
    if unknown:
        raise VisualConfigError(
            f"{path.name}: effects the renderer does not implement: {unknown}")

    components = payload.get("components") or {}
    per_cylinder = payload.get("per_cylinder") or {}
    if not components or not per_cylinder:
        raise VisualConfigError(f"{path.name}: components and per_cylinder are both required")

    try:
        display = str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        display = str(path)

    binding = VisualBinding(
        engine_id=engine_id or "_default",
        source=display,
        shared=shared,
        type=kind,
        components=components,
        per_cylinder=per_cylinder,
        channel_components={k: v for k, v in (payload.get("channel_components") or {}).items()
                            if not k.endswith("*")},
        sensor_fault_component=payload.get("sensor_fault_component", "probe"),
        supported_effects=effects,
    )
    _cache[key] = binding
    return binding


def fault_components(engine_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Which component each fault reaches, composed rather than tabulated.

    A fault declares the channels it affects; a channel is measured on a
    component. Joining the two gives the fault-to-component mapping without
    either layer naming the other, which is why no fault id appears in the
    renderer.
    """
    from core.fault_library import load_for

    binding = resolve(engine_id)
    library = load_for(engine_id)
    out = []
    for definition in library.definitions.values():
        sensor_fault = definition.subsystem == "instrumentation"
        components = []
        for channel in definition.affected_channels:
            component = binding.component_for_channel(channel, sensor_fault=sensor_fault)
            if component and component not in components:
                components.append(component)
        out.append({
            "fault": definition.id,
            "subsystem": definition.subsystem,
            "affected_channels": list(definition.affected_channels),
            "components": components,
        })
    return out


def clear_cache() -> None:
    """Drops resolved bindings. For tests that write configuration files."""
    _cache.clear()
