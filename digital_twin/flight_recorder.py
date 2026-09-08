"""
Flight Data Recorder & Post-Flight Analysis (SIH26054)

Persists every twin frame of a sortie to disk so a mission can be replayed and
analysed after landing, which is the post-flight half of the problem statement:
the operator needs to answer "what did the engine do, and when did we first know"
once the aircraft is on the ground.

Storage layout (one directory per sortie):

    data/flight_logs/<session_id>/
        meta.json      # sortie header: start time, engine config, frame count
        frames.jsonl   # one serialised DigitalTwinState per line, in time order

JSONL is deliberate: frames are appended during flight with no rewrite, a partial
file from an interrupted sortie is still readable to its last complete line, and
the log can be inspected with standard tools without loading it all into memory.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG_DIR = PROJECT_ROOT / "data" / "flight_logs"

# Health banding, mirrored from HealthIndexEngine so the post-flight report and
# the live dashboard describe the same sortie in the same words.
_BANDS = [
    ("NOMINAL", 85.0),
    ("ADVISORY", 70.0),
    ("CAUTION", 50.0),
    ("WARNING", 25.0),
    ("CRITICAL", 0.0),
]


def _band_for(health_pct: float) -> str:
    for name, floor in _BANDS:
        if health_pct >= floor:
            return name
    return "CRITICAL"


@dataclass
class SessionSummary:
    """Header returned when listing sorties, cheap enough to build for all of them."""
    session_id: str
    started_utc: str
    duration_s: float
    frame_count: int
    fault_classes: List[str] = field(default_factory=list)
    min_health_pct: float = 100.0
    worst_band: str = "NOMINAL"
    is_active: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class FlightRecorder:
    """
    Append-only recorder for a single sortie.

    The recorder is intentionally cheap: it serialises the frame dict that is
    already being built for the WebSocket broadcast, so recording costs one
    json.dumps and one buffered write per frame and adds no work to the
    physics or inference path.
    """

    def __init__(
        self,
        log_dir: Optional[Path] = None,
        session_id: Optional[str] = None,
        decimate: int = 1,
    ):
        """
        :param decimate: record 1 frame in N. The twin runs at 20 Hz; a full
            20-hour MALE sortie at that rate is far more than a demonstrator
            needs, so this allows thinning the log without touching the live rate.
        """
        self.log_dir = Path(log_dir) if log_dir is not None else DEFAULT_LOG_DIR
        self.session_id = session_id or datetime.now(timezone.utc).strftime("sortie_%Y%m%dT%H%M%SZ")
        self.decimate = max(1, int(decimate))

        self.session_dir = self.log_dir / self.session_id
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.frames_path = self.session_dir / "frames.jsonl"
        self.meta_path = self.session_dir / "meta.json"

        self._fh = self.frames_path.open("a", encoding="utf-8")
        self._frame_count = 0
        self._seen = 0
        self._first_t: Optional[float] = None
        self._last_t: float = 0.0
        self._min_health = 100.0
        self._fault_classes: List[str] = []
        self._started_utc = datetime.now(timezone.utc).isoformat()
        self._closed = False

        self._write_meta(active=True)

    # -- recording ---------------------------------------------------

    def record(self, frame: Dict[str, Any]) -> None:
        """Appends one twin frame. Safe to call every tick; honours `decimate`."""
        if self._closed:
            return

        self._seen += 1
        if (self._seen - 1) % self.decimate != 0:
            return

        t = float(frame.get("timestamp_s", 0.0))
        if self._first_t is None:
            self._first_t = t
        self._last_t = t

        health = float(frame.get("health", {}).get("overall_health", 100.0))
        self._min_health = min(self._min_health, health)

        cls = frame.get("ai_prognostics", {}).get("fault_class")
        if cls and cls != "HEALTHY" and cls not in self._fault_classes:
            self._fault_classes.append(cls)

        self._fh.write(json.dumps(frame, separators=(",", ":")) + "\n")
        self._frame_count += 1

        # Refresh the header periodically so an interrupted sortie still lists
        # with a usable duration and frame count rather than zeros.
        if self._frame_count % 200 == 0:
            self._fh.flush()
            self._write_meta(active=True)

    def close(self) -> SessionSummary:
        """Flushes and finalises the sortie header. Idempotent."""
        if self._closed:
            return self.summary()
        self._fh.flush()
        self._fh.close()
        self._closed = True
        self._write_meta(active=False)
        return self.summary()

    # -- introspection -----------------------------------------------

    def summary(self) -> SessionSummary:
        duration = max(0.0, self._last_t - (self._first_t or 0.0))
        return SessionSummary(
            session_id=self.session_id,
            started_utc=self._started_utc,
            duration_s=round(duration, 2),
            frame_count=self._frame_count,
            fault_classes=list(self._fault_classes),
            min_health_pct=round(self._min_health, 1),
            worst_band=_band_for(self._min_health),
            is_active=not self._closed,
        )

    def _write_meta(self, active: bool) -> None:
        meta = self.summary().to_dict()
        meta["is_active"] = active
        meta["decimate"] = self.decimate
        meta["schema"] = "engine-twin/frames.jsonl@1"
        self.meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")


# --------------------------------------------------------------------
# Reading back
# --------------------------------------------------------------------

def list_sessions(log_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Returns sortie headers, newest first. Sorties with no readable meta are skipped."""
    root = Path(log_dir) if log_dir is not None else DEFAULT_LOG_DIR
    if not root.exists():
        return []

    out: List[Dict[str, Any]] = []
    for d in root.iterdir():
        if not d.is_dir():
            continue
        meta_path = d / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        meta.setdefault("session_id", d.name)
        out.append(meta)

    out.sort(key=lambda m: m.get("started_utc", ""), reverse=True)
    return out


def iter_frames(session_id: str, log_dir: Optional[Path] = None) -> Iterator[Dict[str, Any]]:
    """
    Streams frames for a sortie in time order.

    A truncated final line (sortie killed mid-write) is skipped rather than
    raising, so a log from a hard shutdown still replays up to its last good frame.
    """
    root = Path(log_dir) if log_dir is not None else DEFAULT_LOG_DIR
    path = root / session_id / "frames.jsonl"
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_frames(session_id: str, log_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    return list(iter_frames(session_id, log_dir))


# --------------------------------------------------------------------
# Post-flight analysis
# --------------------------------------------------------------------

def analyse_session(session_id: str, log_dir: Optional[Path] = None) -> Dict[str, Any]:
    """
    Builds the post-flight report for one sortie.

    The report answers the questions an operator actually asks after landing:
    how long was the engine outside NOMINAL, which faults were diagnosed and how
    early, what did each subsystem's health bottom out at, and what were the
    residual channels driving the diagnosis when it first fired.
    """
    frames = load_frames(session_id, log_dir)
    if not frames:
        return {"session_id": session_id, "found": False}

    t0 = float(frames[0].get("timestamp_s", 0.0))
    t1 = float(frames[-1].get("timestamp_s", 0.0))
    dt = (t1 - t0) / max(1, len(frames) - 1)

    band_time: Dict[str, float] = {name: 0.0 for name, _ in _BANDS}
    phase_time: Dict[str, float] = {}
    subsystem_min: Dict[str, float] = {}
    altitudes: List[float] = []
    healths: List[float] = []

    events: List[Dict[str, Any]] = []
    current_cls: Optional[str] = None
    anomaly_first_t: Optional[float] = None

    for fr in frames:
        t = float(fr.get("timestamp_s", 0.0))
        health_blk = fr.get("health", {}) or {}
        ai = fr.get("ai_prognostics", {}) or {}

        overall = float(health_blk.get("overall_health", 100.0))
        healths.append(overall)
        band_time[_band_for(overall)] += dt

        phase = fr.get("mission_phase", "UNKNOWN")
        phase_time[phase] = phase_time.get(phase, 0.0) + dt

        alt = fr.get("altitude_ft")
        if alt is not None:
            altitudes.append(float(alt))

        for key, val in health_blk.items():
            if key == "status_level" or not isinstance(val, (int, float)):
                continue
            prev = subsystem_min.get(key)
            subsystem_min[key] = val if prev is None else min(prev, float(val))

        if ai.get("anomaly_detected") and anomaly_first_t is None:
            anomaly_first_t = t

        cls = ai.get("fault_class", "HEALTHY")
        if cls != current_cls:
            # Transition: close the previous event and open a new one.
            if events:
                events[-1]["end_s"] = round(t, 2)
                events[-1]["duration_s"] = round(t - events[-1]["start_s"], 2)
            events.append({
                "fault_class": cls,
                "start_s": round(t, 2),
                "end_s": round(t1, 2),
                "duration_s": round(t1 - t, 2),
                "confidence_pct": ai.get("fault_confidence_pct"),
                "is_sensor_fault": bool(ai.get("is_sensor_fault", False)),
                "health_at_onset_pct": round(overall, 1),
                "top_channels": [
                    c.get("channel_key") for c in (ai.get("top_contributing_channels") or [])
                ][:3],
                "recommended_action": ai.get("recommended_action"),
            })
            current_cls = cls

    fault_events = [e for e in events if e["fault_class"] != "HEALTHY"]

    # Detection latency: gap between the unsupervised trigger firing and the
    # classifier committing to a named fault. This is the number that matters
    # operationally, and it is measurable from the log without ground truth.
    first_named = fault_events[0]["start_s"] if fault_events else None
    trigger_to_name_s = None
    if first_named is not None and anomaly_first_t is not None:
        trigger_to_name_s = round(max(0.0, first_named - anomaly_first_t), 2)

    return {
        "session_id": session_id,
        "found": True,
        "frame_count": len(frames),
        "duration_s": round(t1 - t0, 2),
        "sample_interval_s": round(dt, 4),
        "altitude_ft_min": round(min(altitudes), 1) if altitudes else None,
        "altitude_ft_max": round(max(altitudes), 1) if altitudes else None,
        "health_min_pct": round(min(healths), 1) if healths else None,
        "health_mean_pct": round(sum(healths) / len(healths), 1) if healths else None,
        "worst_band": _band_for(min(healths)) if healths else "NOMINAL",
        "time_in_band_s": {k: round(v, 2) for k, v in band_time.items() if v > 0.0},
        "time_in_phase_s": {k: round(v, 2) for k, v in phase_time.items()},
        "subsystem_min_health_pct": {k: round(v, 1) for k, v in subsystem_min.items()},
        "first_anomaly_s": round(anomaly_first_t, 2) if anomaly_first_t is not None else None,
        "first_named_fault_s": first_named,
        "trigger_to_diagnosis_s": trigger_to_name_s,
        "fault_events": fault_events,
        "timeline": events,
        "provenance": "SIMULATED",
    }
