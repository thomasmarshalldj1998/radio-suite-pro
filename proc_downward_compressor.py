"""Downward compressor with a soft knee and linked stereo detector.

Above the threshold the gain is reduced by ``over × (1 − 1/ratio)``. A soft
knee spreads that transition over ``knee_db``; attack and release smooth the
gain itself. Makeup gain and a dry/wet mix are provided for chain building.

Bypass is bit-exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["DownwardCompressor"]


class DownwardCompressor:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        threshold_db: float = -18.0,
        ratio: float = 3.0,
        attack_ms: float = 10.0,
        release_ms: float = 150.0,
        knee_db: float = 6.0,
        makeup_db: float = 0.0,
        mix: float = 1.0,
    ) -> None:
        if not 1.0 <= ratio <= 20.0:
            raise ValueError("ratio must be 1–20")
        if knee_db < 0.0:
            raise ValueError("knee_db must be >= 0")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.threshold_db = float(threshold_db)
        self.ratio = float(ratio)
        self.attack_ms = max(0.1, float(attack_ms))
        self.release_ms = max(1.0, float(release_ms))
        self.knee_db = float(knee_db)
        self.makeup_db = float(makeup_db)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._env = Envelope(fs, 1.0, 50.0)
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self._makeup = 10.0 ** (self.makeup_db / 20.0)
        self.gain_reduction_db = 0.0
        self.input_db = -120.0

    def _target_gain(self, level: float) -> float:
        over = level - self.threshold_db
        slope = 1.0 - 1.0 / self.ratio
        if over <= -self.knee_db / 2.0:
            reduction = 0.0
        elif over >= self.knee_db / 2.0:
            reduction = over * slope
        else:
            x = over + self.knee_db / 2.0
            reduction = slope * x * x / (2.0 * max(self.knee_db, 1e-9))
        return 10.0 ** (-max(0.0, reduction) / 20.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        env = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            env = self._env.process(max(abs(xl), abs(xr)))
            target = self._target_gain(level_db(env))
            coef = self._attack if target < self._gain else self._release
            self._gain += (target - self._gain) * coef
            wet_l = xl * self._gain * self._makeup
            wet_r = xr * self._gain * self._makeup
            out_l[i] = xl + (wet_l - xl) * self.mix
            out_r[i] = xr + (wet_r - xr) * self.mix
        self.input_db = level_db(env)
        self.gain_reduction_db = -20.0 * math.log10(max(self._gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "threshold_db": self.threshold_db,
            "ratio": self.ratio,
            "knee_db": self.knee_db,
            "input_db": round(self.input_db, 2),
            "gain_reduction_db": round(self.gain_reduction_db, 2),
            "makeup_db": self.makeup_db,
        }
