"""Mono compatibility analyser / alert.

This stage does not alter audio. It measures the L/R correlation and the
side-to-mid loss that a mono fold-down will cause, and raises ``alert`` when the
programme is likely to collapse or lose level on a mono receiver.

    correlation = Σ(L×R) / sqrt(ΣL² × ΣR²)
    mono_loss   = 20 log10(rms(mid) / max(rms(L), rms(R)))

The output is always a bit-exact copy, which also makes the stage safe to leave
in a chain for telemetry. ``enabled`` controls whether measurements run.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import copy_stereo, level_db, rms

__all__ = ["MonoCompatAlert"]


class MonoCompatAlert:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        correlation_threshold: float = 0.3,
        mono_loss_threshold_db: float = -6.0,
    ) -> None:
        if not -1.0 <= correlation_threshold <= 1.0:
            raise ValueError("correlation_threshold must be -1…1")
        if not -24.0 <= mono_loss_threshold_db <= 0.0:
            raise ValueError("mono_loss_threshold_db must be -24…0 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.correlation_threshold = float(correlation_threshold)
        self.mono_loss_threshold_db = float(mono_loss_threshold_db)
        self.correlation = 1.0
        self.mono_loss_db = 0.0
        self.alert = False
        self.severity = "ok"

    def reset(self) -> None:
        self.correlation = 1.0
        self.mono_loss_db = 0.0
        self.alert = False
        self.severity = "ok"

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or not l:
            return l, r
        sum_lr = sum(a * b for a, b in zip(l, r))
        sum_ll = sum(a * a for a in l)
        sum_rr = sum(b * b for b in r)
        denom = math.sqrt(max(sum_ll * sum_rr, 0.0))
        self.correlation = sum_lr / denom if denom > 1e-12 else 1.0
        mid = [0.5 * (a + b) for a, b in zip(l, r)]
        self.mono_loss_db = level_db(rms(mid)) - level_db(max(rms(l), rms(r)))
        self.alert = (
            self.correlation < self.correlation_threshold
            or self.mono_loss_db < self.mono_loss_threshold_db
        )
        self.severity = (
            "critical"
            if self.correlation < 0.0 or self.mono_loss_db < -12.0
            else "warning"
            if self.alert
            else "ok"
        )
        return l, r

    def state(self) -> dict[str, float | bool | str]:
        return {
            "enabled": self.enabled,
            "correlation": round(self.correlation, 3),
            "mono_loss_db": round(self.mono_loss_db, 2),
            "alert": self.alert,
            "severity": self.severity,
        }
