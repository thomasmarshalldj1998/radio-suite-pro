"""Dynamic spectral tilt.

A 1 kHz complementary split lets the low and high halves move in opposite
directions. ``tilt_db`` is the static balance; ``dynamic_db`` adds extra
low-tilt when the programme is above ``threshold_db``, which keeps loud
passages from becoming thin.

    low  = lowpass(x, 1 kHz); high = x − low
    tilt = tilt_db + dynamic_db × clamp((level − threshold) / 12, 0, 1)
    out  = low × 10^(+tilt/40) + high × 10^(−tilt/40)
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, Envelope, clamp, copy_stereo, level_db

__all__ = ["DynamicTilt"]


class DynamicTilt:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        tilt_db: float = 0.0,
        dynamic_db: float = 0.0,
        threshold_db: float = -20.0,
        attack_ms: float = 30.0,
        release_ms: float = 400.0,
    ) -> None:
        if not -12.0 <= tilt_db <= 12.0 or not -12.0 <= dynamic_db <= 12.0:
            raise ValueError("tilt values must be -12…12 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.tilt_db = float(tilt_db)
        self.dynamic_db = float(dynamic_db)
        self.threshold_db = float(threshold_db)
        self.attack_ms = max(1.0, float(attack_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = Biquad.lowpass(fs, 1_000.0)
        self._low_r = Biquad.lowpass(fs, 1_000.0)
        self._env = Envelope(fs, self.attack_ms, self.release_ms)
        self.applied_tilt_db = self.tilt_db

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (self.tilt_db == 0.0 and self.dynamic_db == 0.0):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        last = self.tilt_db
        for i, (xl, xr) in enumerate(zip(l, r)):
            low = self._low_l.process(xl)
            low2 = self._low_r.process(xr)
            env = self._env.process(max(abs(xl), abs(xr)))
            extra = self.dynamic_db * clamp(
                (level_db(env) - self.threshold_db) / 12.0, 0.0, 1.0
            )
            tilt = self.tilt_db + extra
            last = tilt
            gl = 10.0 ** (tilt / 40.0)
            gh = 10.0 ** (-tilt / 40.0)
            out_l[i] = low * gl + (xl - low) * gh
            out_r[i] = low2 * gl + (xr - low2) * gh
        self.applied_tilt_db = last
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "tilt_db": self.tilt_db,
            "dynamic_db": self.dynamic_db,
            "applied_tilt_db": round(self.applied_tilt_db, 2),
        }
