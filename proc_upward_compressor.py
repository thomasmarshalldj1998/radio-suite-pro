"""Upward compressor — lifts quiet programme toward a threshold.

Where a downward compressor reduces peaks, this stage raises low-level detail
without touching anything above the threshold:

    under_db = max(0, threshold − level)
    gain_db  = min(range_db, under_db × (1 − 1/ratio))

This is useful for dialogue, ambience and music beds that sit too low between
loud events. Attack/release smoothing prevents pumping. Default bypassed and
bypass is bit-exact.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["UpwardCompressor"]


class UpwardCompressor:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        threshold_db: float = -30.0,
        ratio: float = 2.0,
        range_db: float = 12.0,
        attack_ms: float = 20.0,
        release_ms: float = 300.0,
        mix: float = 1.0,
    ) -> None:
        if not 1.0 <= ratio <= 10.0:
            raise ValueError("ratio must be 1–10")
        if not 0.0 <= range_db <= 30.0:
            raise ValueError("range_db must be 0–30 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.threshold_db = float(threshold_db)
        self.ratio = float(ratio)
        self.range_db = float(range_db)
        self.attack_ms = max(1.0, float(attack_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        # Begin at the threshold so a silent lead-in cannot be lifted by the
        # maximum upward range before the detector has seen programme.
        self._env = Envelope(fs, 5.0, 80.0, initial=10.0 ** (self.threshold_db / 20.0))
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self.gain_db = 0.0
        self.input_db = -120.0

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
            level = level_db(env)
            under = max(0.0, self.threshold_db - level)
            gain_db = min(self.range_db, under * (1.0 - 1.0 / self.ratio))
            target = 10.0 ** (gain_db / 20.0)
            coef = self._attack if target > self._gain else self._release
            self._gain += (target - self._gain) * coef
            wet_l = xl * self._gain
            wet_r = xr * self._gain
            out_l[i] = xl + (wet_l - xl) * self.mix
            out_r[i] = xr + (wet_r - xr) * self.mix
        self.input_db = level_db(env)
        self.gain_db = 20.0 * math.log10(max(self._gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "threshold_db": self.threshold_db,
            "ratio": self.ratio,
            "range_db": self.range_db,
            "input_db": round(self.input_db, 2),
            "gain_db": round(self.gain_db, 2),
        }
