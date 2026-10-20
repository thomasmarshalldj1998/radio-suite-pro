"""Loudness/silence gate.

This is an absolute gate for dead air, not an adaptive noise gate: below
``threshold_db`` the programme fades to ``range_db`` and stays there through a
hold window. A short attack/release ramp avoids clicks when a source starts or
stops. Above threshold the stage is transparent.

Default bypassed; bypass is bit-exact.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["LoudnessGateSilence"]


class LoudnessGateSilence:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        threshold_db: float = -60.0,
        hold_ms: float = 500.0,
        fade_ms: float = 20.0,
        range_db: float = 90.0,
    ) -> None:
        if not -96.0 <= threshold_db <= -20.0:
            raise ValueError("threshold_db must be -96…-20 dBFS")
        if not 0.0 <= hold_ms <= 5_000.0:
            raise ValueError("hold_ms must be 0–5000 ms")
        if not 1.0 <= fade_ms <= 500.0:
            raise ValueError("fade_ms must be 1–500 ms")
        if not 20.0 <= range_db <= 120.0:
            raise ValueError("range_db must be 20–120 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.threshold_db = float(threshold_db)
        self.hold_ms = float(hold_ms)
        self.fade_ms = float(fade_ms)
        self.range_db = float(range_db)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._env = Envelope(fs, 5.0, 40.0)
        self._hold = max(0, int(round(self.hold_ms * fs / 1000.0)))
        self._hold_left = 0
        self._attack = 1.0 - math.exp(-1.0 / (0.005 * fs))
        self._release = 1.0 - math.exp(-1.0 / (self.fade_ms * fs / 1000.0))
        self._gain = 0.0
        self.silent = True
        self.silence_s = 0.0
        self.gain_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        floor_gain = 10.0 ** (-self.range_db / 20.0)
        for i, (xl, xr) in enumerate(zip(l, r)):
            env = self._env.process(max(abs(xl), abs(xr)))
            level = level_db(env)
            if level > self.threshold_db:
                self.silent = False
                self.silence_s = 0.0
                self._hold_left = self._hold
            elif self._hold_left > 0:
                self._hold_left -= 1
            else:
                self.silent = True
                self.silence_s += 1.0 / self.sample_rate
            target = floor_gain if self.silent else 1.0
            coef = self._attack if target > self._gain else self._release
            self._gain += (target - self._gain) * coef
            out_l[i] = xl * self._gain
            out_r[i] = xr * self._gain
        self.gain_db = 20.0 * math.log10(max(self._gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "threshold_db": self.threshold_db,
            "silent": self.silent,
            "silence_s": round(self.silence_s, 3),
            "gain_db": round(self.gain_db, 2),
        }
