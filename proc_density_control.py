"""Density control — full-band, low-ratio dynamic thickening.

Density is the amount of sustained energy between peaks. This stage applies a
gentle downward curve above a low threshold, then restores some of the removed
level with makeup. Low ratios keep the result open instead of pumping.

    ratio = 1 + amount × 0.035        # 0…100 % → 1.0…4.5:1
    knee  = 10 dB

The band-anchor module (``proc_density_anchors``) is a different tool: it
compresses only bass and midrange anchors. Bypass is bit-exact.
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import clamp, copy_stereo
from proc_downward_compressor import DownwardCompressor

__all__ = ["DensityControl"]


class DensityControl:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        amount: float = 40.0,
        threshold_db: float = -26.0,
        attack_ms: float = 15.0,
        release_ms: float = 250.0,
        makeup_db: float = 1.5,
    ) -> None:
        if not 0.0 <= amount <= 100.0:
            raise ValueError("amount must be 0–100 %")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.amount = float(amount)
        self.threshold_db = float(threshold_db)
        self.attack_ms = max(1.0, float(attack_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.makeup_db = float(clamp(makeup_db, -12.0, 12.0))
        self.reset()

    def reset(self) -> None:
        self._comp = DownwardCompressor(
            self.sample_rate,
            enabled=True,
            threshold_db=self.threshold_db,
            ratio=1.0 + self.amount * 0.035,
            attack_ms=self.attack_ms,
            release_ms=self.release_ms,
            knee_db=10.0,
            makeup_db=self.makeup_db,
            mix=self.amount / 100.0,
        )

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.amount <= 0.0:
            return l, r
        return self._comp.process_stereo(l, r)

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "amount": self.amount,
            "ratio": round(1.0 + self.amount * 0.035, 2),
            "gain_reduction_db": round(self._comp.gain_reduction_db, 2),
        }
