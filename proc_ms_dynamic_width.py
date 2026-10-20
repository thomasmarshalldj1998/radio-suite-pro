"""Mid/side width with level-dependent movement.

``width`` is the static side gain. ``dynamic`` opens the image on quieter
material and tightens it on loud passages (positive values) or the reverse
(negative values), using a 30 ms / 300 ms linked envelope.

    mid = (L+R)/2, side = (L−R)/2
    w   = width + dynamic × (1 − level/threshold)
    L   = mid + side×w, R = mid − side×w

Bypass is exact at width 1 and dynamic 0.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["MsDynamicWidth", "MSDynamicWidth"]


class MsDynamicWidth:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        width: float = 1.0,
        dynamic: float = 0.0,
        threshold_db: float = -24.0,
        attack_ms: float = 30.0,
        release_ms: float = 300.0,
    ) -> None:
        if not 0.0 <= width <= 2.0:
            raise ValueError("width must be 0–2")
        if not -1.0 <= dynamic <= 1.0:
            raise ValueError("dynamic must be -1…1")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.width = float(width)
        self.dynamic = float(dynamic)
        self.threshold_db = float(threshold_db)
        self.attack_ms = max(1.0, float(attack_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.reset()

    def reset(self) -> None:
        self._env = Envelope(self.sample_rate, self.attack_ms, self.release_ms)
        self.applied_width = self.width

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (self.width == 1.0 and self.dynamic == 0.0):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        last = self.width
        for i, (xl, xr) in enumerate(zip(l, r)):
            mid = 0.5 * (xl + xr)
            side = 0.5 * (xl - xr)
            level = level_db(self._env.process(max(abs(xl), abs(xr))))
            motion = self.dynamic * (1.0 - clamp((level - (self.threshold_db - 12.0)) / 24.0, 0.0, 1.0))
            width = clamp(self.width + motion, 0.0, 2.0)
            last = width
            out_l[i] = mid + side * width
            out_r[i] = mid - side * width
        self.applied_width = last
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "width": self.width,
            "dynamic": self.dynamic,
            "applied_width": round(self.applied_width, 3),
        }


MSDynamicWidth = MsDynamicWidth
