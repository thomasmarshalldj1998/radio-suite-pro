"""System health report (SignalPath v3.1, module D4).

One call renders the plain-text block an operator pastes into a ticket, and
`save_report` writes the same block as `.txt`. Every field the specification
lists is present, and an unavailable field prints as an em dash rather than
disappearing, so a report is always the same shape.

System figures come from `/proc` and `os` without third-party dependencies;
pass a `HealthState` to override any of them (the console supplies the live
values it already measures).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

VERSION = "SignalPath v3.1 Reference"
BUILD = "3.1.0"


def _dash(value: object, suffix: str = "") -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:g}{suffix}"
    return f"{value}{suffix}"


def _clock(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    total = max(0, int(seconds))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def collect_system() -> dict[str, Any]:
    """CPU / memory / disk, best effort on the host we are running on."""
    cpu_pct = None
    try:
        load = os.getloadavg()[0]
        cores = os.cpu_count() or 1
        cpu_pct = round(min(100.0, load / cores * 100.0), 1)
    except (OSError, AttributeError):
        cpu_pct = None
    memory_mb = None
    memory_total_mb = None
    try:
        info = {}
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                info[key] = float(rest.strip().split()[0]) / 1024.0
        memory_total_mb = round(info.get("MemTotal", 0.0), 0) or None
        memory_mb = round(info.get("MemTotal", 0.0) - info.get("MemAvailable", 0.0), 0)
    except (OSError, ValueError):
        pass
    try:
        usage = shutil.disk_usage(os.getcwd())
        disk_free_gb = round(usage.free / 1e9, 1)
    except OSError:
        disk_free_gb = None
    return {
        "cpu_pct": cpu_pct,
        "cores": os.cpu_count(),
        "memory_mb": memory_mb,
        "memory_total_mb": memory_total_mb,
        "disk_free_gb": disk_free_gb,
    }


@dataclass
class HealthState:
    version: str = VERSION
    build: str = BUILD
    cpu_pct: float | None = None
    cores: int | None = None
    memory_mb: float | None = None
    memory_total_mb: float | None = None
    disk_free_gb: float | None = None
    dsp_peak_pct: float | None = None
    thread_status: str = ""
    stream_uptime_s: float | None = None
    reconnects: int = 0
    gap_total_ms: int = 0
    clock_drift_ppm: float | None = None
    src_corrections: int = 0
    reservoir_fill: float | None = None
    reservoir_underflows: int = 0
    crc_errors: int = 0
    artefact_score: float | None = None
    preset: str = ""
    preset_modified: bool = False
    generated_at: datetime | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, values: dict[str, Any]) -> "HealthState":
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        return cls(
            **{k: v for k, v in values.items() if k in known},
            extra={k: v for k, v in values.items() if k not in known},
        )

    @classmethod
    def live(cls, **values: Any) -> "HealthState":
        merged = collect_system()
        merged.update(values)
        return cls.from_dict(merged)


def build_report(state: HealthState | dict[str, Any] | None = None) -> str:
    if state is None:
        state = HealthState.live()
    elif isinstance(state, dict):
        state = HealthState.from_dict(state)
    now = state.generated_at or datetime.now(timezone.utc)
    if isinstance(now, str):
        try:
            now = datetime.fromisoformat(now.replace("Z", "+00:00"))
        except ValueError:
            now = datetime.now(timezone.utc)
    stamp = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    memory = "—"
    if state.memory_mb is not None:
        memory = f"{state.memory_mb:.0f} MB"
        if state.memory_total_mb:
            memory += f" / {state.memory_total_mb:.0f} MB"
    cpu = "—"
    if state.cpu_pct is not None:
        cpu = f"{state.cpu_pct:.1f} %"
        if state.cores:
            cpu += f" ({state.cores} cores)"
    score = "—"
    if state.artefact_score is not None:
        grade = (
            "good"
            if state.artefact_score > 90
            else "fair"
            if state.artefact_score >= 75
            else "poor"
        )
        score = f"{state.artefact_score:.1f} ({grade})"
    reservoir = "—"
    if state.reservoir_fill is not None:
        reservoir = f"{state.reservoir_fill * 100:.0f} %"

    lines = [
        f"{state.version} — system health report",
        f"Generated: {stamp}",
        f"Version & build: {state.version} · {state.build}",
        "",
        "— System ————————————————————————————",
        f"CPU load: {cpu}",
        f"Memory: {memory}",
        f"Disk free: {_dash(state.disk_free_gb, ' GB')}",
        "",
        "— DSP ———————————————————————————————",
        f"DSP peak: {_dash(state.dsp_peak_pct, ' %')}",
        f"Thread status: {_dash(state.thread_status)}",
        "",
        "— Stream ————————————————————————————",
        f"Uptime: {_clock(state.stream_uptime_s)}",
        f"Reconnects: {state.reconnects}",
        f"Gap total: {state.gap_total_ms} ms",
        "",
        "— Clock & SRC ———————————————————————",
        f"Clock drift: {_dash(state.clock_drift_ppm, ' ppm')}",
        f"SRC corrections: {state.src_corrections}",
        "",
        "— Encoder ———————————————————————————",
        f"Reservoir: {reservoir} · underflows {state.reservoir_underflows} · CRC errors {state.crc_errors}",
        f"Artefact score: {score}",
        "",
        "— Preset ————————————————————————————",
        f"Active: {_dash(state.preset)} · modified: {_dash(state.preset_modified)}",
    ]
    for key, value in state.extra.items():
        lines.append(f"{key}: {_dash(value)}")
    return "\n".join(lines) + "\n"


def save_report(
    text: str | None = None,
    path: str | None = None,
    now: datetime | None = None,
) -> str:
    body = text if text is not None else build_report()
    now = now or datetime.now(timezone.utc)
    target = path or f"signalpath_health_{now:%Y%m%d_%H%M}.txt"
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(body if body.endswith("\n") else body + "\n")
    return os.path.abspath(target)


__all__ = ["HealthState", "build_report", "save_report", "collect_system", "VERSION", "BUILD"]
