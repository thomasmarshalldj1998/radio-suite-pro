"""Post-chain overshoot correction.

Some processors (saturation, EQ boosts, summed bands) can push a sample above
the previous ceiling. This final safety stage catches those overshoots with an
instant attack and a short release. It is intentionally not a musical limiter;
it should normally remove only rare samples.

Bypass is exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import clamp, copy_stereo, level_db

__all__ = ["OvershootCorrection"]


class OvershootCorrection:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        ceiling_db: float = -0.1,
        release_ms: float = 40.0,
        max_reduction_db: float = 12.0,
    ) -> None:
        if not -12.0 <= ceiling_db <= 0.0:
            raise ValueError("ceiling_db must be -12…0 dB")
        if not 1.0 <= release_ms <= 1_000.0:
            raise ValueError("release_ms must be 1–1000 ms")
        if not 0.0 <= max_reduction_db <= 30.0:
            raise ValueError("max_reduction_db must be 0–30 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.ceiling_db = float(ceiling_db)
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        self.release_ms = float(release_ms)
        self.max_reduction_db = float(max_reduction_db)
        self.reset()

    def reset(self) -> None:
        self._release = 1.0 - math.exp(
            -1.0 / (self.release_ms * self.sample_rate / 1000.0)
        )
        self._gain = 1.0
        self.max_overshoot_db = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            detector = max(abs(xl), abs(xr))
            target = 1.0 if detector <= self.ceiling else self.ceiling / detector
            target = max(target, 10.0 ** (-self.max_reduction_db / 20.0))
            if target < self._gain:
                self._gain = target
            else:
                self._gain += (target - self._gain) * self._release
            out_l[i] = clamp(xl * self._gain, -self.ceiling, self.ceiling)
            out_r[i] = clamp(xr * self._gain, -self.ceiling, self.ceiling)
            worst = max(worst, -20.0 * math.log10(max(self._gain, 1e-9)))
        self.max_overshoot_db = worst
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "ceiling_db": self.ceiling_db,
            "max_overshoot_db": round(self.max_overshoot_db, 2),
        }
