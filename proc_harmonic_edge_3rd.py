"""Third-order (odd-harmonic) edge.

An x³ term adds third harmonic and its multiples, which reads as edge and
forwardness without the DC/even warmth of the second-order stage. The cubic is
bounded by a soft clip and blended with the dry signal.

    driven = x × 10^(drive/20)
    edge   = driven³ − driven          # zero fundamental change at small drive
    out    = driven + edge × amount
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import clamp, copy_stereo, soft_clip

__all__ = ["ThirdHarmonicEdge", "HarmonicEdge3rd"]


class ThirdHarmonicEdge:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        drive_db: float = 6.0,
        amount: float = 0.2,
        mix: float = 1.0,
        output_db: float = 0.0,
    ) -> None:
        if not 0.0 <= drive_db <= 24.0:
            raise ValueError("drive_db must be 0–24 dB")
        if not 0.0 <= amount <= 1.0:
            raise ValueError("amount must be 0–1")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.drive_db = float(drive_db)
        self.amount = float(amount)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.output_db = float(clamp(output_db, -12.0, 12.0))
        self._drive = 10.0 ** (self.drive_db / 20.0)
        self._trim = 10.0 ** (self.output_db / 20.0)
        self.harmonic_level = 0.0

    def reset(self) -> None:
        self.harmonic_level = 0.0

    def _shape(self, x: float) -> float:
        driven = x * self._drive
        edge = driven * driven * driven - driven
        return (driven + edge * self.amount) * self._trim

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0 or self.drive_db == 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            wet_l = soft_clip(self._shape(xl), 1.0, 4.0)
            wet_r = soft_clip(self._shape(xr), 1.0, 4.0)
            out_l[i] = xl + (wet_l - xl) * self.mix
            out_r[i] = xr + (wet_r - xr) * self.mix
            worst = max(worst, abs(wet_l - xl), abs(wet_r - xr))
        self.harmonic_level = worst
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "drive_db": self.drive_db,
            "amount": self.amount,
            "harmonic_level": round(self.harmonic_level, 5),
        }


HarmonicEdge3rd = ThirdHarmonicEdge
