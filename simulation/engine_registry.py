"""
Engine registry — the catalogue of powerplants the twin can fly.

The problem statement names one engine. A user whose airframe carries something
else needs to describe it rather than be told the tool does not apply, so this
holds both the engines shipped with the project and any the operator defines.

Shipped configs live in `configs/` and are read-only. User-defined ones live in
`configs/custom/`, one JSON file per engine, created and deleted at run time.
Keeping them in separate directories means a user can never overwrite the
reference engine the shipped models were trained against.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from simulation.engine_spec import EngineSpec, validate_config, config_warnings

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUILTIN_DIR = PROJECT_ROOT / "configs"
CUSTOM_DIR = PROJECT_ROOT / "configs" / "custom"

# The engine the shipped checkpoints were trained on. Diagnosis is calibrated
# for this one; everything else is flagged so the operator knows.
REFERENCE_ID = "engine_config"


def _slug(name: str) -> str:
    """A filesystem-safe id. Never allowed to escape the custom directory."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", str(name).strip().lower()).strip("-")
    return (s or "engine")[:60]


def _read(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _summarise(engine_id: str, cfg: Dict[str, Any], builtin: bool) -> Dict[str, Any]:
    """The row the picker shows, cheap enough to build for every engine."""
    nom = cfg.get("nominal_operating_parameters", {}) or {}
    table = cfg.get("altitude_power_derating") or []
    ceiling = max((float(p.get("altitude_ft", 0)) for p in table), default=0.0)
    return {
        "id": engine_id,
        "name": cfg.get("engine_name", engine_id),
        "builtin": builtin,
        "is_reference": engine_id == REFERENCE_ID,
        "displacement_litres": cfg.get("displacement_litres"),
        "cylinders": cfg.get("cylinders"),
        "rated_power_hp": cfg.get("rated_power_hp_sealevel"),
        "rated_rpm": cfg.get("rated_rpm"),
        "max_boost_bar": cfg.get("max_boost_bar"),
        "turbocharged": cfg.get("turbocharged", True),
        "ceiling_ft": ceiling,
        "egt_nominal_c": nom.get("egt_nominal_celsius"),
        "created_utc": cfg.get("created_utc"),
    }


def list_engines() -> List[Dict[str, Any]]:
    """Every engine available, shipped first, then user-defined by name."""
    out: List[Dict[str, Any]] = []

    for path in sorted(BUILTIN_DIR.glob("*.json")):
        cfg = _read(path)
        if cfg:
            out.append(_summarise(path.stem, cfg, builtin=True))

    if CUSTOM_DIR.exists():
        for path in sorted(CUSTOM_DIR.glob("*.json")):
            cfg = _read(path)
            if cfg:
                out.append(_summarise(path.stem, cfg, builtin=False))

    out.sort(key=lambda e: (not e["is_reference"], not e["builtin"], e["name"].lower()))
    return out


def get_config(engine_id: str) -> Optional[Dict[str, Any]]:
    """Loads one engine config by id, checking shipped then custom."""
    safe = _slug(engine_id)
    for base, stem in ((BUILTIN_DIR, engine_id), (CUSTOM_DIR, safe)):
        path = base / f"{stem}.json"
        try:
            # Refuse anything that resolves outside its own directory.
            path.resolve().relative_to(base.resolve())
        except ValueError:
            continue
        if path.is_file():
            cfg = _read(path)
            if cfg:
                return cfg
    return None


def get_spec(engine_id: str) -> Optional[EngineSpec]:
    cfg = get_config(engine_id)
    return EngineSpec.from_config(cfg) if cfg else None


def save_custom(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validates and stores a user-defined engine.

    Raises ValueError with every problem at once rather than the first, so a
    form can show them all together instead of one per submission.
    """
    errors = validate_config(cfg)
    if errors:
        raise ValueError(" ".join(errors))

    # Valid is not the same as inside the range the correlations were fitted on.
    # These travel back with the summary so the operator is told, not stopped.
    warnings = config_warnings(cfg)

    engine_id = _slug(cfg.get("engine_name", ""))
    if engine_id in {p.stem for p in BUILTIN_DIR.glob("*.json")}:
        raise ValueError(f"'{engine_id}' is the name of a built-in engine. "
                         "Choose a different name.")

    cfg = dict(cfg)
    cfg["origin"] = "custom"
    cfg.setdefault("created_utc", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    # Build the spec before writing: a config that cannot produce a runnable
    # engine should never reach disk.
    EngineSpec.from_config(cfg)

    CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
    (CUSTOM_DIR / f"{engine_id}.json").write_text(
        json.dumps(cfg, indent=2), encoding="utf-8")

    summary = _summarise(engine_id, cfg, builtin=False)
    summary["warnings"] = warnings
    return summary


def delete_custom(engine_id: str) -> bool:
    """Removes a user-defined engine. Shipped engines are never deletable."""
    safe = _slug(engine_id)
    path = CUSTOM_DIR / f"{safe}.json"
    try:
        path.resolve().relative_to(CUSTOM_DIR.resolve())
    except ValueError:
        return False
    if path.is_file():
        path.unlink()
        return True
    return False


def blank_config(name: str = "My Engine") -> Dict[str, Any]:
    """
    A starting point for the builder form, pre-filled with the reference engine
    so a user edits real numbers rather than facing empty boxes.
    """
    ref = get_config(REFERENCE_ID) or {}
    cfg = json.loads(json.dumps(ref))
    cfg["engine_name"] = name
    cfg["origin"] = "custom"
    return cfg
