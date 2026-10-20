"""LRA-aware loudness preservation.

Instead of compressing peaks, this stage rides the overall level slowly toward
a target and only ever reduces gain. Quiet passages are never lifted, so the
short-term-to-loud range is preserved; loud passages are trimmed by a bounded
amount with a long attack and a very long release.

    gain_db = clamp(target − loudness, −max_reduction, 0)
    output  = input × smoothed gain

The measured range between the quietest and loudest short-term estimate is
reported for telemetry. Bypass is bit-exact.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["LraDynamicRangePreserve", "LRADynamicRangePreserve"]


class LraDynamicRangePreserve:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        target_db: float = -18.0,
        max_reduction_db: float = 6.0,
        attack_ms: float = 250.0,
        release_ms: float = 3_000.0,
        window_ms: float = 1_000.0,
    ) -> None:
        if not -40.0 <= target_db <= 0.0:
            raise ValueError("target_db must be -40…0 dB")
        if not 0.0 <= max_reduction_db <= 18.0:
            raise ValueError("max_reduction_db must be 0–18 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.target_db = float(target_db)
        self.max_reduction_db = float(max_reduction_db)
        self.attack_ms = max(10.0, float(attack_ms))
        self.release_ms = max(100.0, float(release_ms))
        self.window_ms = max(100.0, float(window_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._env = Envelope(fs, self.window_ms, self.window_ms)
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self.loudness_db = -120.0
        self.range_db = 0.0
        self._min_db = 120.0
        self._max_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.max_reduction_db <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            env = self._env.process(max(abs(xl), abs(xr)))
            self.loudness_db = level_db(env)
            self._min_db = min(self._min_db, self.loudness_db)
            self._max_db = max(self._max_db, self.loudness_db)
            self.range_db = max(0.0, self._max_db - self._min_db)
            gain_db = clamp(
                self.target_db - self.loudness_db,
                -self.max_reduction_db,
                0.0,
            )
            target = 10.0 ** (gain_db / 20.0)
            coef = self._attack if target < self._gain else self._release
            self._gain += (target - self._gain) * coef
            out_l[i] = xl * self._gain
            out_r[i] = xr * self._gain
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "target_db": self.target_db,
            "loudness_db": round(self.loudness_db, 2),
            "range_db": round(self.range_db, 2),
            "gain_reduction_db": round(-20.0 * math.log10(max(self._gain, 1e-9)), 2),
        }


LRADynamicRangePreserve = LraDynamicRangePreserve
