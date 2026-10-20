"""Soft-knee clipper.

A tanh transfer rounds the approach to the ceiling instead of slicing it. The
knee is smooth by construction; ``drive_db`` sets how hard the signal enters it,
and ``mix`` allows parallel clipping.

The output is bounded by ``ceiling_db`` whenever the stage is fully wet. Bypass
is exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import clamp, copy_stereo, soft_clip

__all__ = ["SoftKneeClipper"]


class SoftKneeClipper:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        ceiling_db: float = -1.0,
        knee_db: float = 6.0,
        drive_db: float = 0.0,
        mix: float = 1.0,
    ) -> None:
        if not -12.0 <= ceiling_db <= 0.0:
            raise ValueError("ceiling_db must be -12…0 dB")
        if not 0.0 <= knee_db <= 24.0:
            raise ValueError("knee_db must be 0–24 dB")
        if not 0.0 <= drive_db <= 24.0:
            raise ValueError("drive_db must be 0–24 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.ceiling_db = float(ceiling_db)
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        self.knee_db = float(knee_db)
        self.drive_db = float(drive_db)
        self.drive = 10.0 ** (drive_db / 20.0)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.clipped_pct = 0.0

    def reset(self) -> None:
        self.clipped_pct = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        clipped = 0
        total = max(1, 2 * len(l))
        for i, (xl, xr) in enumerate(zip(l, r)):
            sl = soft_clip(xl, self.drive, self.ceiling)
            sr = soft_clip(xr, self.drive, self.ceiling)
            out_l[i] = xl + (sl - xl) * self.mix
            out_r[i] = xr + (sr - xr) * self.mix
            if abs(xl) > self.ceiling:
                clipped += 1
            if abs(xr) > self.ceiling:
                clipped += 1
        self.clipped_pct = 100.0 * clipped / total
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "ceiling_db": self.ceiling_db,
            "knee_db": self.knee_db,
            "drive_db": self.drive_db,
            "clipped_pct": round(self.clipped_pct, 3),
        }
