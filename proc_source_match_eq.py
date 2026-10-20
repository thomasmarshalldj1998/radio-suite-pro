"""Source-match EQ — align a source's broad balance to a target curve.

The material is split into low (<250 Hz), mid and high (>4 kHz) bands. On each
block the low/high levels relative to mid are compared with a target profile
and a bounded correction is applied. Corrections move over ~150 ms so the stage
follows a source change without chasing syllables.

Targets are relative dB (low, high) against mid:
    broadcast  (0.0, -1.0)
    speech     (-1.5, -2.5)
    music      (0.5, 0.5)
    flat       (0.0, 0.0)
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo, level_db, rms

__all__ = ["SourceMatchEq", "TARGETS"]

TARGETS = {
    "broadcast": (0.0, -1.0),
    "speech": (-1.5, -2.5),
    "music": (0.5, 0.5),
    "flat": (0.0, 0.0),
}


class SourceMatchEq:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        profile: str = "broadcast",
        amount: float = 60.0,
        max_gain_db: float = 6.0,
        low_hz: float = 250.0,
        high_hz: float = 4_000.0,
    ) -> None:
        if profile not in TARGETS:
            raise ValueError(f"profile must be one of {tuple(TARGETS)}")
        if not 0.0 <= amount <= 100.0:
            raise ValueError("amount must be 0–100 %")
        if not 0.0 <= max_gain_db <= 12.0:
            raise ValueError("max_gain_db must be 0–12 dB")
        if not 50.0 < low_hz < high_hz < sample_rate * 0.45:
            raise ValueError("band edges must be ordered and below Nyquist")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.profile = profile
        self.amount = float(amount)
        self.max_gain_db = float(max_gain_db)
        self.low_hz = float(low_hz)
        self.high_hz = float(high_hz)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = Biquad.lowpass(fs, self.low_hz)
        self._low_r = Biquad.lowpass(fs, self.low_hz)
        self._high_l = Biquad.highpass(fs, self.high_hz)
        self._high_r = Biquad.highpass(fs, self.high_hz)
        self._smooth = 1.0 - math.exp(-1.0 / (0.15 * fs))
        self.low_gain_db = 0.0
        self.high_gain_db = 0.0
        self.low_db = -120.0
        self.high_db = -120.0
        self.mid_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.amount <= 0.0:
            return l, r
        n = len(l)
        low_l, low_r = [0.0] * n, [0.0] * n
        high_l, high_r = [0.0] * n, [0.0] * n
        mid_l, mid_r = [0.0] * n, [0.0] * n
        for i, (xl, xr) in enumerate(zip(l, r)):
            ll = self._low_l.process(xl)
            lr = self._low_r.process(xr)
            hl = self._high_l.process(xl)
            hr = self._high_r.process(xr)
            low_l[i], low_r[i] = ll, lr
            high_l[i], high_r[i] = hl, hr
            mid_l[i], mid_r[i] = xl - ll - hl, xr - lr - hr
        self.low_db = level_db(max(rms(low_l), rms(low_r)))
        self.high_db = level_db(max(rms(high_l), rms(high_r)))
        self.mid_db = level_db(max(rms(mid_l), rms(mid_r)))
        target_low, target_high = TARGETS[self.profile]
        desired_low = clamp(target_low - (self.low_db - self.mid_db), -self.max_gain_db, self.max_gain_db)
        desired_high = clamp(target_high - (self.high_db - self.mid_db), -self.max_gain_db, self.max_gain_db)
        desired_low *= self.amount / 100.0
        desired_high *= self.amount / 100.0
        out_l = [0.0] * n
        out_r = [0.0] * n
        for i in range(n):
            self.low_gain_db += (desired_low - self.low_gain_db) * self._smooth
            self.high_gain_db += (desired_high - self.high_gain_db) * self._smooth
            gl = 10.0 ** (self.low_gain_db / 20.0)
            gh = 10.0 ** (self.high_gain_db / 20.0)
            out_l[i] = low_l[i] * gl + mid_l[i] + high_l[i] * gh
            out_r[i] = low_r[i] * gl + mid_r[i] + high_r[i] * gh
        return out_l, out_r

    def state(self) -> dict[str, float | bool | str]:
        return {
            "enabled": self.enabled,
            "profile": self.profile,
            "amount": self.amount,
            "low_db": round(self.low_db, 2),
            "mid_db": round(self.mid_db, 2),
            "high_db": round(self.high_db, 2),
            "low_gain_db": round(self.low_gain_db, 2),
            "high_gain_db": round(self.high_gain_db, 2),
        }
